/**
 * 集合竞价评级引擎（CARating）
 *
 * 纯函数模块，不依赖 DOM / 网络，可直接在 Node 中单测。
 *
 * 输入：CAData 采集的原始行（含 auction / live / 昨日指标）
 * 输出：补齐衍生指标、竞价评级、异动类型、异动说明、0-100 综合评分与档位的行
 *
 * 评级口径参考同花顺「竞价评级」四档语义：
 *   看多 / 看空 / 混战 / 观望
 * 异动类型参考同花顺「早盘竞价监控」的异动词汇（分时级异动无法完全复刻，
 * 这里依据竞价撮合的量价特征做规则归类，说明列给出触发该判断的具体数值）
 */
const CARating = (function () {
    'use strict';

    // 竞价评级（展示顺序即筛选条顺序）
    const RATINGS = ['看多', '混战', '观望', '看空'];

    // 异动类型（按"关注度"排序，筛选条按此顺序展示）
    const ANOMALY_TYPES = [
        '大单封涨停', '涨停试盘', '高开抢筹', '竞价抢筹', '大笔买入',
        '高开砸盘', '急速下跌', '竞价砸盘', '大笔卖出',
        '缩量高开', '小幅高开', '平开观望', '小幅低开', '无数据'
    ];

    // 大单门槛（竞价成交额，元）
    const BIG_ORDER = 3000 * 1e4;

    // ===== 评分配置（TODO39.2 方案化） =====
    // weights: 各评分维度满分（归一化基准，合成时各维原始分按 默认满分→新满分 等比折算）
    // cap:     封顶规则（溢价不足/巨量分歧时封顶分）
    // tier:    档位阈值（可参与/观察确认/淘汰）
    // 默认值=现行硬编码，computeRow 不传 config 时行为完全不变
    const DIM_DEFAULT_MAX = { gap: 25, amt: 25, fbt: 12, zbc: 8, lbc: 15, fund: 8, hs: 7 };
    const DEFAULT_SCORE_CFG = {
        weights: Object.assign({}, DIM_DEFAULT_MAX),
        cap: { premiumGapMax: 2, capValue: 66, divergenceRAmt: 28 },
        tier: { buy: 70, watch: 60 }
    };

    /** 深拷贝配置（方案对象多处引用，避免相互污染） */
    function cloneCfg(c) {
        return {
            weights: Object.assign({}, c.weights),
            cap: Object.assign({}, c.cap),
            tier: Object.assign({}, c.tier)
        };
    }

    /** 合并用户配置与默认配置（外部可传部分字段，其余取默认；默认=现行口径） */
    function normalizeCfg(config) {
        const base = cloneCfg(DEFAULT_SCORE_CFG);
        if (!config) return base;
        if (config.weights) Object.keys(DIM_DEFAULT_MAX).forEach(k => {
            if (config.weights[k] != null) base.weights[k] = Number(config.weights[k]);
        });
        if (config.cap) {
            ['premiumGapMax', 'capValue', 'divergenceRAmt'].forEach(k => {
                if (config.cap[k] != null) base.cap[k] = Number(config.cap[k]);
            });
        }
        if (config.tier) {
            if (config.tier.buy != null) base.tier.buy = Number(config.tier.buy);
            if (config.tier.watch != null) base.tier.watch = Number(config.tier.watch);
        }
        return base;
    }

    function n(v) {
        return typeof v === 'number' && isFinite(v) ? v : null;
    }

    /** 涨停/跌停价（由昨收与涨跌停幅度推导） */
    function limitPrices(preClose, pct) {
        if (preClose == null) return { up: null, down: null };
        const up = Math.round(preClose * (1 + pct) * 100) / 100;
        const down = Math.round(preClose * (1 - pct) * 100) / 100;
        return { up: up, down: down };
    }

    /** 封板时间 HHMMSS → 距 9:30 的分钟数 */
    function fbtMinutes(fbt) {
        if (fbt == null) return null;
        const v = Math.floor(Number(fbt));
        if (!isFinite(v)) return null;
        const h = Math.floor(v / 10000);
        const m = Math.floor(v / 100) % 100;
        return Math.max(0, h * 60 + m - (9 * 60 + 30));
    }

    /** 封板时间数值 → HH:MM:SS */
    function fbtText(fbt) {
        if (fbt == null) return '--';
        const v = Math.floor(Number(fbt));
        if (!isFinite(v)) return '--';
        const p = (x) => String(x).padStart(2, '0');
        return p(Math.floor(v / 10000)) + ':' + p(Math.floor(v / 100) % 100) + ':' + p(v % 100);
    }

    // ===== 评分维度（满分合计 100，与参考实现一致） =====

    function sGap(g) {
        if (g == null) return { v: 0, max: 25 };
        if (g < 0) return { v: 0, max: 25 };
        if (g < 2) return { v: 8, max: 25 };
        if (g < 4) return { v: 16, max: 25 };
        if (g < 7) return { v: 25, max: 25 };      // 黄金接力区
        if (g < 9.5) return { v: 18, max: 25 };
        return { v: 12, max: 25 };                 // 涨停/一字开，安全边际差
    }

    function sAmt(r) {
        if (r == null) return { v: 0, max: 25 };
        if (r < 1) return { v: 2, max: 25 };
        if (r < 2) return { v: 8, max: 25 };
        if (r < 4) return { v: 15, max: 25 };
        if (r < 9) return { v: 25, max: 25 };      // 量能充沛且不过热
        if (r < 16) return { v: 20, max: 25 };
        if (r < 28) return { v: 12, max: 25 };
        return { v: 6, max: 25 };                  // 巨量分歧
    }

    function sFbt(mins) {
        if (mins == null) return { v: 0, max: 0 };  // 无数据不参与归一
        if (mins <= 5) return { v: 12, max: 12 };
        if (mins <= 60) return { v: 10, max: 12 };
        if (mins <= 120) return { v: 7, max: 12 };
        if (mins <= 180) return { v: 4, max: 12 };
        return { v: 2, max: 12 };
    }

    function sZbc(z) {
        if (z == null) return { v: 0, max: 0 };
        if (z === 0) return { v: 8, max: 8 };
        if (z === 1) return { v: 4, max: 8 };
        return { v: 0, max: 8 };
    }

    function sLbc(l) {
        if (l == null) return { v: 0, max: 0 };
        const map = { 1: 11, 2: 15, 3: 15, 4: 12, 5: 8 };
        return { v: map[l] != null ? map[l] : 4, max: 15 };
    }

    function sFund(r) {
        if (r == null) return { v: 0, max: 0 };
        if (r >= 30) return { v: 8, max: 8 };
        if (r >= 15) return { v: 6, max: 8 };
        if (r >= 5) return { v: 4, max: 8 };
        return { v: 2, max: 8 };
    }

    function sHs(h) {
        if (h == null) return { v: 0, max: 0 };
        if (h < 3) return { v: 5, max: 7 };        // 一字锁筹
        if (h < 25) return { v: 7, max: 7 };
        if (h < 40) return { v: 5, max: 7 };
        return { v: 3, max: 7 };
    }

    // ===== 异动识别 =====

    /**
     * 依据竞价撮合量价特征归类异动类型
     * @returns {{type:string, desc:string}}
     */
    function detectAnomaly(m) {
        const { gap, rAmt, aucAmt, unmatchedVol, atLimitUp, atLimitDown, preClose, match } = m;

        if (match == null) return { type: '无数据', desc: '未获取到集合竞价撮合数据' };

        const wan = (v) => v == null ? '--' : (v / 1e4).toFixed(0) + '万';
        const pct = (v) => v == null ? '--' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
        const amtTxt = '竞价额 ' + wan(aucAmt) + (rAmt != null ? '（占昨日成交 ' + rAmt.toFixed(2) + '%）' : '');
        const dir = gap == null ? '' : (gap > 0.005 ? '高开 ' : (gap < -0.005 ? '低开 ' : '平开 '));
        const gapTxt = dir + pct(gap);

        // 1. 涨停价开盘：9:25 撮合在涨停价即为封板
        if (atLimitUp) {
            const um = (unmatchedVol != null && unmatchedVol > 0)
                ? '，未匹配买量 ' + (unmatchedVol / 1e4).toFixed(2) + '万手' : '';
            return {
                type: '大单封涨停',
                desc: '竞价直接封于涨停价 ' + match.toFixed(2) + um + '，' + amtTxt
            };
        }

        // 2. 跌停价开盘
        if (atLimitDown) {
            return {
                type: '急速下跌',
                desc: '竞价直接压于跌停价 ' + match.toFixed(2) + '，' + amtTxt
            };
        }

        // 3. 接近涨停（差 0.3% 以内）→ 涨停试盘
        const nearLimit = m.limitUp != null && match >= m.limitUp * 0.997;
        if (nearLimit && gap != null && gap > 0) {
            return { type: '涨停试盘', desc: '竞价价 ' + match.toFixed(2) + ' 逼近涨停价 ' +
                m.limitUp.toFixed(2) + '，' + amtTxt };
        }

        // 4. 低开方向
        if (gap != null && gap <= -3) {
            return { type: '急速下跌', desc: gapTxt + '，' + amtTxt };
        }
        if (gap != null && gap <= -2) {
            return { type: '竞价砸盘', desc: gapTxt + '，' + amtTxt };
        }
        if (gap != null && gap <= -0.5) {
            if (aucAmt != null && aucAmt >= BIG_ORDER) {
                return { type: '大笔卖出', desc: gapTxt + '，' + amtTxt + '（大单压盘）' };
            }
            return { type: '小幅低开', desc: gapTxt + '，' + amtTxt };
        }

        // 5. 高开方向
        if (gap != null && gap >= 3) {
            // 巨量高开 = 分歧派发，量能远超常态
            if (rAmt != null && rAmt >= 15) {
                return { type: '高开砸盘', desc: gapTxt + ' 但 ' + amtTxt + '，量能异常放大，提防高开低走' };
            }
            if (rAmt != null && rAmt >= 8) {
                return { type: '高开抢筹', desc: gapTxt + '，' + amtTxt + '，抢筹量能真实' };
            }
            if (rAmt != null && rAmt < 1) {
                return { type: '缩量高开', desc: gapTxt + ' 但 ' + amtTxt + '，承接资金不足' };
            }
            if (aucAmt != null && aucAmt >= BIG_ORDER) {
                return { type: '大笔买入', desc: gapTxt + '，' + amtTxt };
            }
            return { type: '高开抢筹', desc: gapTxt + '，' + amtTxt };
        }

        if (gap != null && gap >= 2) {
            if (rAmt != null && rAmt >= 4) {
                return { type: '竞价抢筹', desc: gapTxt + '，' + amtTxt };
            }
            return { type: '小幅高开', desc: gapTxt + '，' + amtTxt };
        }
        if (gap != null && gap >= 0.5) {
            return { type: '小幅高开', desc: gapTxt + '，' + amtTxt };
        }

        // 6. 平开
        return { type: '平开观望', desc: '竞价 ' + match.toFixed(2) + '（' + pct(gap) + '），' + amtTxt };
    }

    /**
     * 基于竞价期间采样序列（backend 定时采集的 9:15-9:25 多时间点快照，含 price/vol）的异动增强。
     * 当存在序列时，可更贴近同花顺「竞价监控」的分时级异动（试盘/急跌/大单），
     * 否则（实时/缺缓存）原 detectAnomaly 的结论保持不变。
     * 增强优先级：涨停试盘（触板未封）> 急速下跌（相邻点跌>3%）> 大单试盘（单点量突增）。
     * @param {Object} r - CAData 原始行（携带 r._series）
     * @param {Object} m - detectAnomaly 的输入指标
     * @param {{type:string, desc:string}} base - detectAnomaly 的默认结论
     * @returns {{type:string, desc:string}}
     */
    function enhanceFromSeries(r, m, base) {
        const s = r._series;
        if (!Array.isArray(s) || s.length < 2) return base;
        const prices = s.map(p => n(p.price)).filter(v => v != null);
        const vols = s.map(p => n(p.vol)).filter(v => v != null);
        if (!prices.length) return base;

        const maxP = Math.max.apply(null, prices);
        const preClose = m.preClose;

        // 1. 涨停试盘：竞价期间触达涨停价，但最终未封住（撮合价低于涨停）
        if (m.limitUp != null && maxP >= m.limitUp && m.match != null && m.match < m.limitUp - 0.005) {
            const desc = '竞价期间最高 ' + maxP.toFixed(2) + ' 触及涨停价 ' + m.limitUp.toFixed(2) +
                '，但 9:25 撮合回落至 ' + m.match.toFixed(2) +
                (m.aucAmt != null ? '（竞价额 ' + (m.aucAmt / 1e4).toFixed(0) + '万）' : '');
            return { type: '涨停试盘', desc: desc };
        }

        // 2. 急速下跌：相邻采样点跌幅 > 3%（竞价内急挫）
        for (let i = 1; i < prices.length; i++) {
            if (prices[i - 1] > 0 && (prices[i] - prices[i - 1]) / prices[i - 1] <= -0.03) {
                const dropPct = (prices[i] - prices[i - 1]) / prices[i - 1] * 100;
                const desc = '竞价期间自 ' + prices[i - 1].toFixed(2) + ' 急挫至 ' + prices[i].toFixed(2) +
                    '（' + dropPct.toFixed(1) + '%）' +
                    (m.aucAmt != null ? '，竞价额 ' + (m.aucAmt / 1e4).toFixed(0) + '万' : '');
                return { type: '急速下跌', desc: desc };
            }
        }

        // 3. 大单试盘：相邻样本累计成交量增量对应金额突增（单笔大单），按相对昨收方向判买卖
        if (vols.length >= 2) {
            for (let i = 1; i < vols.length; i++) {
                const dvol = vols[i] - vols[i - 1];
                if (dvol > 0 && prices[i] != null && dvol * 100 * prices[i] >= BIG_ORDER) {
                    const dir = (preClose != null && prices[i] >= preClose) ? '大笔买入' : '大笔卖出';
                    const amtWan = dvol * 100 * prices[i] / 1e4;
                    const t = (s[i] && s[i].t) ? s[i].t : ('第' + i + '点');
                    const desc = '竞价 ' + t + ' 出现单笔大单 ' + (dvol / 1e4).toFixed(2) +
                        '万手（约 ' + amtWan.toFixed(0) + '万元），疑似' +
                        (dir === '大笔买入' ? '主动吃单试盘' : '主动压单试盘');
                    return { type: dir, desc: desc };
                }
            }
        }
        return base;
    }

    /**
     * 竞价评级
     * 看多：承接型异动（抢筹/大单买入/封涨停）
     * 看空：抛压型异动（砸盘/急速下跌/大笔卖出）
     * 混战：方向与量能矛盾（巨量高开、涨停试盘、强势股低开）
     * 观望：其余
     */
    function detectRating(m, anomalyType) {
        const { gap, rAmt, lbc } = m;
        if (m.match == null) return '观望';

        const bullish = ['大单封涨停', '高开抢筹', '竞价抢筹', '大笔买入'];
        const bearish = ['急速下跌', '竞价砸盘', '大笔卖出'];

        if (bearish.includes(anomalyType)) return '看空';
        if (bullish.includes(anomalyType)) {
            // 高开但量能过度放大 → 分歧加大，降级为混战
            if (rAmt != null && rAmt >= 20) return '混战';
            return '看多';
        }
        if (anomalyType === '涨停试盘' || anomalyType === '高开砸盘' || anomalyType === '缩量高开') {
            return '混战';
        }
        // 高位连板股低开 = 分歧
        if (gap != null && gap < 0 && lbc != null && lbc >= 3) return '混战';
        return '观望';
    }

    // ===== 单行计算 =====

    /**
     * 计算单只股票的全部指标
     * @param {Object} r - CAData 原始行
     * @returns {Object} 装饰后的行
     */
    function computeRow(r, config) {
        const cfg = normalizeCfg(config);   // TODO39.2：方案配置（缺省字段取默认，保证默认=现行口径）
        const auc = r.auction || {};
        const live = r.live || {};
        const preClose = n(r.preClose) != null ? r.preClose : n(live.preClose);
        const match = n(auc.price) != null ? auc.price : n(live.open);
        const limitPct = r.limitPct != null ? r.limitPct : 0.10;
        const lp = limitPrices(preClose, limitPct);
        const limitUp = n(live.limitUp) != null ? live.limitUp : lp.up;
        const limitDown = n(live.limitDown) != null ? live.limitDown : lp.down;

        const gap = (match != null && preClose) ? (match - preClose) / preClose * 100 : null;
        const aucAmt = n(auc.amt);
        const aucVol = n(auc.vol);
        const yAmt = n(r.yAmt);
        const rAmt = (aucAmt != null && yAmt) ? aucAmt / yAmt * 100 : null;
        const rMkt = (aucAmt != null && n(r.floatMV)) ? aucAmt / r.floatMV * 100 : null;
        // 竞价量比 = 竞价量 / 昨日每分钟均量 = rAmt × 240 / 100
        const volRatioAuc = rAmt != null ? rAmt * 2.4 : null;

        const atLimitUp = (match != null && limitUp != null) ? match >= limitUp - 0.005 : false;
        const atLimitDown = (match != null && limitDown != null) ? match <= limitDown + 0.005 : false;

        const mins = fbtMinutes(r.fbt);
        const rFund = (n(r.fund) && yAmt) ? r.fund / yAmt * 100 : null;

        const metrics = {
            gap: gap, rAmt: rAmt, aucAmt: aucAmt, match: match,
            unmatchedVol: n(auc.unmatchedVol), atLimitUp: atLimitUp, atLimitDown: atLimitDown,
            preClose: preClose, limitUp: limitUp, lbc: n(r.lbc)
        };

        let title = detectAnomaly(metrics);
        // TODO38.4：有竞价期间采样序列时，用分时级异动（试盘/急跌/大单）增强结论
        title = enhanceFromSeries(r, metrics, title);
        const rating = detectRating(metrics, title.type);

        // ---- 评分：可用维度按配置权重归一化到 100 分（TODO39.2 方案化，默认权重=现行满分） ----
        const rawDims = {
            gap: sGap(gap),
            amt: sAmt(rAmt),
            fbt: sFbt(mins),
            zbc: sZbc(n(r.zbc)),
            lbc: sLbc(n(r.lbc)),
            fund: sFund(rFund),
            hs: sHs(n(r.yTurnover))
        };
        const dims = {};
        let got = 0;
        let max = 0;
        Object.keys(rawDims).forEach(k => {
            const raw = rawDims[k];
            if (raw.max <= 0) { dims[k] = { v: 0, max: 0 }; return; }   // 无数据维度不参与归一
            const w = (cfg.weights && cfg.weights[k] != null) ? cfg.weights[k] : DIM_DEFAULT_MAX[k];
            dims[k] = { v: raw.v / raw.max * w, max: w };              // 原始分按 默认满分→新权重 折算
            got += dims[k].v;
            max += w;
        });
        let score = max > 0 ? Math.round(got / max * 100) : 0;

        // ---- 硬性淘汰 / 封顶 ----
        const outs = [];
        if (gap != null && gap < 0) outs.push('竞价低开');
        if (rAmt != null && rAmt < 1) outs.push('竞价无量');
        if (n(r.zbc) != null && r.zbc >= 2) outs.push('昨日多次炸板');
        if (n(r.lbc) != null && r.lbc >= 5) outs.push('高位连板');
        if (atLimitUp) outs.push('涨停价开盘');

        // 溢价不足：接力资金不认，按方案封顶（默认 gap∈[0,2) 封 66）
        const cap = cfg.cap || DEFAULT_SCORE_CFG.cap;
        if (gap != null && gap >= 0 && gap < cap.premiumGapMax) score = Math.min(score, cap.capValue);
        // 竞价巨量分歧：超昨日成交阈值，多为派发，按方案封顶（默认 >28% 封 66）
        if (rAmt != null && rAmt > cap.divergenceRAmt) score = Math.min(score, cap.capValue);

        let tier;
        if (atLimitUp) {
            tier = '一字涨停开';
        } else if (outs.filter(x => x !== '涨停价开盘').length) {
            tier = '淘汰';
        } else if (score >= cfg.tier.buy) {
            tier = '可参与';
        } else if (score >= cfg.tier.watch) {
            tier = '观察确认';
        } else {
            tier = '淘汰';
        }

        return {
            code: r.code,
            name: r.name,
            market: r.market,
            hybk: r.hybk || '',
            from: r.from,
            // 时间
            time: auc.time || '',
            // 竞价
            match: match,
            gap: gap,
            aucVol: aucVol,
            aucAmt: aucAmt,
            unmatchedVol: n(auc.unmatchedVol),
            unmatchedAmt: n(auc.unmatchedAmt),
            volRatioAuc: volRatioAuc,
            rAmt: rAmt,
            rMkt: rMkt,
            // 昨日
            yAmt: yAmt,
            yVol: n(r.yVol),
            yTurnover: n(r.yTurnover),
            floatMV: n(r.floatMV),
            totalMV: n(r.totalMV),
            lbc: n(r.lbc),
            zbc: n(r.zbc),
            fbt: fbtText(r.fbt),
            fbtMins: mins,
            fund: n(r.fund),
            rFund: rFund,
            // 实时
            price: n(live.price) != null ? live.price : match,
            chgPct: (live.price != null && preClose) ? (live.price - preClose) / preClose * 100 : gap,
            amount: n(live.amount),
            turnover: n(live.turnover),
            volRatio: n(live.volRatio),
            volLots: n(live.vol),
            snapTime: live.snapshotTime || '',
            // 结论
            preClose: preClose,
            limitUp: limitUp,
            limitDown: limitDown,
            atLimitUp: atLimitUp,
            anomalyType: title.type,
            anomalyDesc: title.desc,
            rating: rating,
            score: score,
            tier: tier,
            outs: outs,
            dims: dims,
            stale: !!r.stale
        };
    }

    /**
     * 板块竞价强度聚合（按细分行业 hybk）
     * @param {Array} rows - computeRow 后的行
     * @returns {Array} [{name,n,avgGap,avgR,codes}] 按 n 降序、avgGap 降序
     */
    function sectorTop(rows) {
        const map = new Map();
        (rows || []).forEach(r => {
            const k = r.hybk || '其他';
            if (!map.has(k)) map.set(k, { name: k, n: 0, gaps: [], rAmts: [], codes: [] });
            const e = map.get(k);
            e.n++;
            e.codes.push(r.name);
            if (r.gap != null) e.gaps.push(r.gap);
            if (r.rAmt != null) e.rAmts.push(r.rAmt);
        });
        const list = [];
        map.forEach(e => {
            const avgGap = e.gaps.length ? e.gaps.reduce((a, b) => a + b, 0) / e.gaps.length : null;
            const avgR = e.rAmts.length ? e.rAmts.reduce((a, b) => a + b, 0) / e.rAmts.length : null;
            list.push({ name: e.name, n: e.n, avgGap: avgGap, avgR: avgR, codes: e.codes });
        });
        list.sort((a, b) => (b.n - a.n) || ((b.avgGap || 0) - (a.avgGap || 0)));
        return list;
    }

    /**
     * 生成同花顺式「AI 竞价评级分析」文字结论（规则驱动，非大模型）
     * 依据 tier / gap / 封板强度给出可参与性判断与操作建议。
     * @param {Object} r - computeRow 后的行
     * @returns {string}
     */
    function adviceFor(r) {
        const g = r.gap, lbc = r.lbc;
        if (r.tier === '一字涨停开') {
            if (r.fbtMins != null && r.fbtMins <= 0) {
                return '昨日一字板，今日竞价再度封在涨停价。9:20 后不可撤单，排板等于被动接货；' +
                    '除非开盘后 3 分钟内被巨量砸开且能在 -3% 内控住，否则一律不参与，只做观察标。';
            }
            return '竞价封在涨停价（' + (g == null ? '' : g.toFixed(2) + '%') +
                '）。可排板前提：封单额持续放大且所属题材为当日主线，否则开盘被砸开即高开低走，放弃排板。';
        }
        if (r.tier === '淘汰') {
            return '综合评分 ' + r.score + ' 不足' +
                (r.outs.length ? '（' + r.outs.join('、') + '）' : '') + '，不参与。';
        }
        if (g >= 7) {
            return '高开 ' + g.toFixed(1) + '%，安全边际偏薄。仅做「开盘 3 分钟不破开盘价 + 分时站上均价线」' +
                '确认后的轻仓试错（≤5%），破开盘价立即走。';
        }
        if (g >= 4) {
            return '高开 ' + g.toFixed(1) + '% 位于接力黄金区，竞价量比真实。开盘后观察 3–5 分钟，' +
                '不破开盘价即在开盘价上方 0~2% 分批建仓（首笔 5–8%）。';
        }
        if (g >= 2) {
            return '高开 ' + g.toFixed(1) + '% 偏中性，属「有溢价但不亢奋」。需盘中二次确认：' +
                '站稳开盘价并放量突破早盘新高后才跟进，仓位减半（≤4%）。';
        }
        return '竞价溢价不足 2%，接力资金不认。只在开盘后快速翻红、放量突破开盘价的情况下考虑，否则放弃。';
    }

    /**
     * 批量计算 + 汇总情绪指标
     * @param {Array} rows - CAData 原始行
     * @param {{ztCount?:number, zbCount?:number}} [baseline] - 涨停/炸板计数（用于炸板率）
     * @returns {{rows:Array, summary:Object}}
     */
    function analyze(rows, baseline) {
        const list = (rows || []).map(computeRow);

        const gaps = list.map(r => r.gap).filter(v => v != null);
        const aucTotal = list.reduce((s, r) => s + (r.aucAmt || 0), 0);
        const ratingDist = {};
        RATINGS.forEach(k => { ratingDist[k] = 0; });
        list.forEach(r => { ratingDist[r.rating] = (ratingDist[r.rating] || 0) + 1; });

        const anomalyDist = {};
        list.forEach(r => { anomalyDist[r.anomalyType] = (anomalyDist[r.anomalyType] || 0) + 1; });

        const lbcDist = {};
        list.forEach(r => {
            if (r.lbc != null) lbcDist[r.lbc] = (lbcDist[r.lbc] || 0) + 1;
        });

        const summary = {
            total: list.length,
            valid: gaps.length,
            avgGap: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
            upOpen: gaps.filter(g => g > 0).length,
            flatOpen: gaps.filter(g => g === 0).length,
            downOpen: gaps.filter(g => g < 0).length,
            limitOpen: list.filter(r => r.atLimitUp).length,
            aucTotal: aucTotal,
            ratingDist: ratingDist,
            anomalyDist: anomalyDist,
            lbcDist: lbcDist,
            maxLbc: Object.keys(lbcDist).length ? Math.max.apply(null, Object.keys(lbcDist).map(Number)) : null,
            buyCount: list.filter(r => r.tier === '可参与').length,
            watchCount: list.filter(r => r.tier === '观察确认').length,
            dropCount: list.filter(r => r.tier === '淘汰').length,
            // 炸板率（来自涨停池/炸板池计数）
            ztCount: (baseline && baseline.ztCount != null) ? baseline.ztCount : null,
            zbCount: (baseline && baseline.zbCount != null) ? baseline.zbCount : null,
            zbRate: (baseline && baseline.ztCount != null && baseline.zbCount != null)
                ? (baseline.zbCount / (baseline.ztCount + baseline.zbCount) * 100) : null
        };

        return { rows: list, summary: summary };
    }

    return {
        RATINGS,
        ANOMALY_TYPES,
        analyze,
        computeRow,
        DEFAULT_SCORE_CFG,
        DIM_DEFAULT_MAX,
        cloneCfg,
        normalizeCfg,
        sectorTop,
        adviceFor,
        // 纯函数导出（Node测试）
        _internals: {
            detectAnomaly,
            detectRating,
            enhanceFromSeries,
            limitPrices,
            fbtMinutes,
            fbtText,
            sectorTop,
            adviceFor,
            sGap, sAmt, sFbt, sZbc, sLbc, sFund, sHs
        }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CARating;
}
