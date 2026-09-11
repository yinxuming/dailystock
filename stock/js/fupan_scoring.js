/**
 * 复盘评分模型前端移植（FupanScoring）
 *
 * 职责：
 * 1. 后端 fupan/scoring.py 评分模型的JS移植（9维评分 + 一票否决 + 晋级概率 + 操作建议）
 *    - 默认参数与后端完全一致：默认配置下 rescoreDay 重算结果与采集端落盘评分一致
 * 2. 阈值自定义（TODO5.5）：维度权重 / 一票否决阈值 / 建议分级阈值可通过页面设置调整
 * 3. 生效日期机制：仅对生效日及之后的交易日前端重算评分；
 *    生效日之前的历史评分保持采集端落盘结果（历史评分不受影响）
 * 4. 配置持久化：localStorage 保存，跨会话生效（复用 FupanData 设置工具）
 * 5. 预测回溯方案调优（TODO13.2）：evalSchemeAccuracy 回测Top5命中率、
 *    optimizeScheme 权重爬山调优（昨日/3日/5日最准方案）、configsEqual 方案一致性判定
 *
 * 设计说明：
 * - 维度权重调整时，各维原始分按 默认满分→新满分 等比折算（权重=默认时原样返回，
 *   保证默认配置与后端逐分一致）
 * - 晋级概率的30日历史基线仅采集端可得：前端从落盘的（概率-评分）反推该股基线，
 *   仅评分变化项随之调整，默认配置下概率与后端一致
 * - 模型版本：v2=9维（TODO13.1新增龙虎榜lhb维度，各维满分重新分配，总分仍100）；
 *   v1历史落盘数据（8维）展示采集端原始评分不受影响
 * - 方案调优为确定性算法（固定维度顺序+固定步长），同一数据集结果可复现
 */
const FupanScoring = (function () {

    // ===== 默认配置（与后端 scoring.py / fetch.py 对齐） =====

    // 9维权重（默认满分，合计100；v2新增lhb龙虎榜维度）
    const DEFAULT_WEIGHTS = {
        priceLevel: 5,
        floatMV: 10,
        ztActivity: 12,
        sectorEffect: 12,
        sealQuality: 18,
        boardType: 12,
        position: 8,
        sentiment: 8,
        lhb: 15
    };

    // 一票否决阈值（数值0或时刻留空 = 关闭该项）
    const DEFAULT_VETO = {
        lateSealTime: '14:40',  // 尾盘偷袭板：最后封板晚于该时刻
        openCount: 4,           // 超级烂板：炸板次数 >=
        iceLbCount: 5,          // 冰点高位板：冰点期连板 >=
        floatMvYi: 500          // 巨无霸：流通市值 > 该值（亿）
    };

    // 操作建议分级阈值
    const DEFAULT_ADVICE = {
        active: 85,   // 积极关注：总分 >=
        probPct: 50,  // 积极关注：晋级概率 >= （百分比）
        watch: 75,    // 关注：总分 >=
        wait: 60      // 观望：总分 >=
    };

    // 配置持久化key
    const STORE_KEY = 'fupan_score_config';

    // 板类型强度分（默认板型权重12分制，与后端一致）
    const BOARD_TYPE_SCORE = { '一字板': 12, 'T字板': 10, '换手板': 8, '回封板': 5, '厂字板': 5 };

    // 情绪阶段环境分（默认情绪权重8分制，与后端一致）
    const SENTIMENT_SCORE = { '高潮': 8, '发酵': 6.5, '回暖': 5, '退潮': 2.5, '冰点': 1 };

    // ===== 内部工具 =====

    /**
     * 时刻字符串转秒数
     * @param {string} t "HH:MM" 或 "HH:MM:SS"
     * @returns {number|null} 秒数（非法/空返回null）
     */
    function toSecs(t) {
        if (!t) return null;
        const p = String(t).split(':').map(Number);
        if (p.length < 2 || p.some(isNaN)) return null;
        return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
    }

    /**
     * 概率评分调整量钳制（±15%，与后端一致）
     * @param {number} x 调整量
     * @returns {number}
     */
    function clampAdjust(x) {
        return Math.max(-0.15, Math.min(0.15, x));
    }

    // ===== 9维原始分（默认分制，与后端scoring.py逐条对齐） =====

    /**
     * 股价水平原始分（满分5）：低价股更易资金合力
     * @param {number} price 现价
     * @returns {number}
     */
    function rawPriceLevel(price) {
        if (price === null || price === undefined) return 3;
        if (price < 10) return 5;
        if (price < 20) return 4;
        if (price < 50) return 3;
        return 1;
    }

    /**
     * 流通市值原始分（满分10）：20-100亿合力最佳
     * @param {number} floatMV 流通市值（元）
     * @returns {number}
     */
    function rawFloatMV(floatMV) {
        if (!floatMV) return 6;
        const yi = floatMV / 1e8;
        if (yi >= 20 && yi <= 100) return 10;
        if (yi < 20) return 8;
        if (yi <= 300) return 6;
        if (yi <= 500) return 3;
        return 1;
    }

    /**
     * 近期涨停活跃原始分（满分12）：妖股基因（无历史数据给中性基准分）
     * @param {number|null} recentZt 近期涨停次数（null=无历史数据）
     * @returns {number}
     */
    function rawZtActivity(recentZt) {
        if (recentZt === null || recentZt === undefined) return 5.5;
        if (recentZt >= 5) return 12;
        if (recentZt >= 3) return 10;
        if (recentZt === 2) return 7;
        if (recentZt === 1) return 5;
        return 2;
    }

    /**
     * 板块效应原始分（满分12）：同板块涨停家数（含自身）
     * @param {number} sectorZtCount 同行业今日涨停家数
     * @returns {number}
     */
    function rawSectorEffect(sectorZtCount) {
        if (!sectorZtCount) return 3;
        if (sectorZtCount >= 5) return 12;
        if (sectorZtCount >= 3) return 10;
        if (sectorZtCount === 2) return 6.5;
        return 3;
    }

    /**
     * 封板质量原始分（满分18）：封板时间(11) + 封成比(4) + 炸板(3)
     * @param {number|null} sealR 封成比
     * @param {string} firstSeal 首次封板时刻
     * @param {number|null} openCount 炸板次数
     * @returns {number}
     */
    function rawSealQuality(sealR, firstSeal, openCount) {
        // 首次封板时间分（越早越强）
        const s = toSecs(firstSeal);
        let timeScore;
        if (s === null) timeScore = 4.5;
        else if (s <= 9 * 3600 + 25 * 60) timeScore = 11;        // 09:25 集合竞价封板
        else if (s <= 10 * 3600) timeScore = 9;                  // 10:00 前
        else if (s <= 11 * 3600 + 30 * 60) timeScore = 6.5;      // 上午
        else if (s <= 14 * 3600) timeScore = 4.5;                // 午后
        else timeScore = 1.5;                                    // 尾盘

        // 封成比分（封板资金/成交额）
        let ratioScore;
        if (sealR === null || sealR === undefined) ratioScore = 2;
        else if (sealR >= 1) ratioScore = 4;
        else if (sealR >= 0.5) ratioScore = 3.5;
        else if (sealR >= 0.2) ratioScore = 2.5;
        else ratioScore = 1;

        // 炸板次数分
        let openScore;
        if (openCount === null || openCount === undefined || openCount === 0) openScore = 3;
        else if (openCount <= 2) openScore = 2;
        else openScore = 0;

        return Math.round((timeScore + ratioScore + openScore) * 10) / 10;
    }

    /**
     * 板类型原始分（满分12）
     * @param {string} limitType 涨停板类型
     * @returns {number}
     */
    function rawBoardType(limitType) {
        return BOARD_TYPE_SCORE[limitType] !== undefined ? BOARD_TYPE_SCORE[limitType] : 6.5;
    }

    /**
     * 板块身位原始分（满分8）：板块内最高板满分，首板看板块热度
     * @param {number} lbCount 连板数
     * @param {number} sectorMaxLb 同行业今日最高连板
     * @param {number} sectorZtCount 同行业涨停家数
     * @returns {number}
     */
    function rawPosition(lbCount, sectorMaxLb, sectorZtCount) {
        if (sectorMaxLb && lbCount && lbCount >= sectorMaxLb) return 8;
        if (lbCount && sectorMaxLb && lbCount === sectorMaxLb - 1) return 6.5;
        if (lbCount && lbCount >= 2) return 5;
        if (sectorZtCount && sectorZtCount >= 3) return 4;  // 热板块首板
        return 2.5;
    }

    /**
     * 情绪环境原始分（满分8）
     * @param {string} phase 情绪阶段
     * @returns {number}
     */
    function rawSentiment(phase) {
        return SENTIMENT_SCORE[phase] !== undefined ? SENTIMENT_SCORE[phase] : 4;
    }

    /**
     * 龙虎榜资金质量原始分（满分15，TODO13.1，与后端 _score_lhb 逐条对齐）
     * 未上榜=9中性；上榜=基础7+净买强度+席位画像加减
     * @param {Object|null} lhb 涨停股lhb字段（含onList/netBuyRatio/style）
     * @returns {number}
     */
    function rawLhb(lhb) {
        if (!lhb || !lhb.onList) return 9;
        let score = 7;
        const ratio = lhb.netBuyRatio;
        if (ratio === null || ratio === undefined) score += 1;
        else if (ratio >= 10) score += 4;
        else if (ratio >= 5) score += 3;
        else if (ratio > 0) score += 2;
        else if (ratio > -5) score -= 2;
        else score -= 4;
        const style = lhb.style || {};
        const instNet = style.instNet || 0;
        if (instNet > 0) score += 2;
        else if (instNet < 0) score -= 2;
        if ((style.patternNet || 0) > 0) score += 2;
        if ((style.retailBuyRatio || 0) >= 0.4) score -= 2;
        return Math.round(Math.max(0, Math.min(15, score)) * 10) / 10;
    }

    // ===== 评分核心 =====

    /**
     * 维度分按权重折算：原始分按默认满分计算，等比缩放到用户权重
     * 权重=默认时原样返回（与后端一致）；权重=0时该维不计分
     * @param {string} key 维度key
     * @param {number} raw 原始分（默认分制）
     * @param {Object} weights 当前权重配置
     * @returns {number} 折算后维度分
     */
    function scaleDim(key, raw, weights) {
        const w = Number(weights[key]);
        const dw = DEFAULT_WEIGHTS[key];
        if (w === dw) return raw;
        if (!w) return 0;
        return Math.round(raw * w / dw * 10) / 10;
    }

    /**
     * 一票否决检查（阈值可配置；数值0/时刻空 = 关闭该项）
     * @param {Object} stock 涨停股（lastSealTime/openCount/lbCount/floatMV）
     * @param {string} phase 当日情绪阶段
     * @param {Object} veto 否决阈值配置
     * @returns {null|string} 否决原因
     */
    function checkVeto(stock, phase, veto) {
        const lateSecs = toSecs(veto.lateSealTime);
        if (lateSecs !== null) {
            const lastS = toSecs(stock.lastSealTime);
            if (lastS !== null && lastS >= lateSecs) return '尾盘偷袭板';
        }
        if (Number(veto.openCount) > 0 && (stock.openCount || 0) >= Number(veto.openCount)) {
            return '超级烂板(炸板>=' + Number(veto.openCount) + ')';
        }
        if (Number(veto.iceLbCount) > 0 && phase === '冰点'
            && (stock.lbCount || 0) >= Number(veto.iceLbCount)) {
            return '冰点期高位板';
        }
        if (Number(veto.floatMvYi) > 0 && stock.floatMV
            && stock.floatMV > Number(veto.floatMvYi) * 1e8) {
            return '流通市值超' + Number(veto.floatMvYi) + '亿';
        }
        return null;
    }

    /**
     * 单只涨停股9维评分（前端重算版，v2含龙虎榜维度）
     * @param {Object} stock 涨停股（ztpool元素，含lhb字段）
     * @param {number} sectorZtCount 同行业今日涨停家数（含自身）
     * @param {number} sectorMaxLb 同行业今日最高连板数
     * @param {string} phase 当日情绪阶段
     * @param {number|null} recentZt 近期涨停次数
     * @param {Object} config 阈值配置
     * @returns {{total:number, dimensions:Object, veto:null|string}}
     */
    function scoreStock(stock, sectorZtCount, sectorMaxLb, phase, recentZt, config) {
        const w = config.weights;
        const dims = {
            priceLevel: scaleDim('priceLevel', rawPriceLevel(stock.price), w),
            floatMV: scaleDim('floatMV', rawFloatMV(stock.floatMV), w),
            ztActivity: scaleDim('ztActivity', rawZtActivity(recentZt), w),
            sectorEffect: scaleDim('sectorEffect', rawSectorEffect(sectorZtCount), w),
            sealQuality: scaleDim('sealQuality',
                rawSealQuality(stock.sealRatio, stock.firstSealTime, stock.openCount), w),
            boardType: scaleDim('boardType', rawBoardType(stock.limitType), w),
            position: scaleDim('position', rawPosition(stock.lbCount, sectorMaxLb, sectorZtCount), w),
            sentiment: scaleDim('sentiment', rawSentiment(phase), w),
            lhb: scaleDim('lhb', rawLhb(stock.lhb), w)
        };
        let total = 0;
        Object.keys(dims).forEach(k => { total += dims[k]; });
        total = Math.round(total * 10) / 10;
        return { total, dimensions: dims, veto: checkVeto(stock, phase, config.veto) };
    }

    /**
     * 生成操作建议（分级阈值可配置）
     * @param {number} score 总分
     * @param {number|null} probability 晋级概率（0-1）
     * @param {null|string} veto 否决原因
     * @param {Object} advice 建议分级配置
     * @returns {string} 建议文本
     */
    function buildAdvice(score, probability, veto, advice) {
        if (veto) return '回避（一票否决：' + veto + '）';
        if (score >= Number(advice.active) && probability !== null && probability !== undefined
            && probability >= Number(advice.probPct) / 100) {
            return '积极关注（高评分+高晋级概率，竞价承接强可考虑低吸）';
        }
        if (score >= Number(advice.watch)) return '关注（评分良好，观察竞价与板块配合）';
        if (score >= Number(advice.wait)) return '观望（中性，需竞价确认）';
        return '回避（评分偏低）';
    }

    /**
     * 评分排名取Top5（一票否决股排除，同时保留否决清单；与后端rank_scores一致）
     * @param {Array} scored 评分结果数组
     * @param {number} topN 取前N名
     * @returns {{top5:Array, vetoed:Array}}
     */
    function rankScores(scored, topN) {
        const normal = scored.filter(s => !s.score.veto)
            .sort((a, b) => b.score.total - a.score.total);
        const vetoed = scored.filter(s => s.score.veto)
            .sort((a, b) => b.score.total - a.score.total);
        return { top5: normal.slice(0, topN), vetoed };
    }

    /**
     * 单日评分前端重算：基于ztpool原始数据 + 自定义阈值
     * 主流程：板块统计 → 逐股8维评分 → 概率（落盘值反推基线）→ 建议 → 排名
     * @param {Object} day 单日复盘数据（ztpool/sentiment.phase/scores.all）
     * @param {Object} config 阈值配置
     * @returns {Object} 与后端scores同构 {model, weights, top5, vetoed, all}
     */
    function rescoreDay(day, config) {
        const ztpool = day.ztpool || [];
        const phase = (day.sentiment || {}).phase;
        const storedByCode = new Map(
            (((day.scores || {}).all) || []).map(x => [x.code, x]));

        // 板块统计（与后端fetch.py一致：按行业聚合涨停家数与最高连板）
        const sectorStats = {};
        ztpool.forEach(s => {
            const ind = s.industry || '其他';
            const st = sectorStats[ind] = sectorStats[ind] || { count: 0, maxLB: 0 };
            st.count += 1;
            st.maxLB = Math.max(st.maxLB, s.lbCount || 0);
        });

        const scored = ztpool.map(s => {
            const st = sectorStats[s.industry || '其他'] || { count: 1, maxLB: 1 };
            const sc = scoreStock(s, st.count, st.maxLB, phase,
                s.recentZt === undefined ? null : s.recentZt, config);
            // 晋级概率：从落盘（概率-评分）反推该股历史基线，仅评分调整项随新评分变化
            const stored = storedByCode.get(s.code) || {};
            let probability = null;
            if (stored.probability !== null && stored.probability !== undefined
                && stored.score !== null && stored.score !== undefined) {
                const storedAdjust = clampAdjust((stored.score - 70) / 100 * 0.3);
                const base = stored.probability - storedAdjust;
                probability = Math.round(Math.max(0.05, Math.min(0.85,
                    base + clampAdjust((sc.total - 70) / 100 * 0.3))) * 1000) / 1000;
            }
            return {
                code: s.code, name: s.name, lbCount: s.lbCount || 1,
                industry: s.industry || '', limitType: s.limitType !== undefined ? s.limitType : null,
                score: sc, probability,
                advice: buildAdvice(sc.total, probability, sc.veto, config.advice)
            };
        });

        const ranked = rankScores(scored, 5);
        return {
            model: 'v2-custom',
            weights: Object.assign({}, config.weights),
            top5: ranked.top5,
            vetoed: ranked.vetoed,
            all: scored.map(x => ({
                code: x.code, name: x.name, score: x.score.total,
                probability: x.probability, veto: x.score.veto
            }))
        };
    }

    // ===== 配置管理 =====

    /**
     * 读取已保存的阈值配置
     * 兼容迁移：v1模型8维配置缺少lhb权重时，按默认值补齐（升级后旧配置自动生效新维度）
     * @returns {Object|null} 配置（未保存或结构不完整返回null）
     */
    function getSavedConfig() {
        let c = FupanData.getSetting(STORE_KEY, null);
        if (!c || !c.weights || !c.veto || !c.advice || !c.effectiveDate) return null;
        // 迁移：补齐缺失维度（v1→v2新增lhb）
        Object.keys(DEFAULT_WEIGHTS).forEach(k => {
            if (c.weights[k] === undefined) c.weights[k] = DEFAULT_WEIGHTS[k];
        });
        return c;
    }

    /**
     * 保存阈值配置（含生效日期）
     * @param {Object} config {effectiveDate, weights, veto, advice}
     */
    function saveConfig(config) {
        FupanData.setSetting(STORE_KEY, config);
    }

    /** 清除阈值配置（恢复默认） */
    function clearConfig() {
        try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 忽略 */ }
    }

    /**
     * 配置是否对指定交易日生效（交易日 >= 生效日）
     * @param {Object} config 配置
     * @param {string} dateStr 交易日 YYYY-MM-DD
     * @returns {boolean}
     */
    function isActiveFor(config, dateStr) {
        return !!(config && config.effectiveDate && dateStr && dateStr >= config.effectiveDate);
    }

    /**
     * 配置阈值是否全为默认值（全默认时无需前端重算，直接用采集端落盘评分）
     * @param {Object} config 配置
     * @returns {boolean}
     */
    function isDefaultConfig(config) {
        if (!config) return true;
        const w = config.weights || {}, v = config.veto || {}, a = config.advice || {};
        return Object.keys(DEFAULT_WEIGHTS).every(k => Number(w[k]) === DEFAULT_WEIGHTS[k])
            && Object.keys(DEFAULT_VETO).every(k => v[k] === DEFAULT_VETO[k])
            && Object.keys(DEFAULT_ADVICE).every(k => Number(a[k]) === DEFAULT_ADVICE[k]);
    }

    /**
     * 校验并钳制数值输入（非法值回落默认）
     * @param {*} val 输入值
     * @param {number} def 默认值
     * @param {number} min 最小值
     * @param {number} max 最大值
     * @param {boolean} [isInt] 是否取整
     * @returns {number}
     */
    function clampNum(val, def, min, max, isInt) {
        let n = Number(val);
        if (isNaN(n)) n = def;
        n = Math.max(min, Math.min(max, n));
        return isInt ? Math.round(n) : Math.round(n * 10) / 10;
    }

    /**
     * 规范化配置（数值钳制 + key顺序固定，用于保存前清洗）
     * @param {Object} raw 原始配置
     * @returns {Object} 规范化配置
     */
    function normalizeConfig(raw) {
        const weights = {}, veto = {}, advice = {};
        Object.keys(DEFAULT_WEIGHTS).forEach(k => {
            weights[k] = clampNum((raw.weights || {})[k], DEFAULT_WEIGHTS[k], 0, 50, true);
        });
        const v = raw.veto || {};
        veto.lateSealTime = /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(v.lateSealTime || ''))
            ? v.lateSealTime : DEFAULT_VETO.lateSealTime;
        veto.openCount = clampNum(v.openCount, DEFAULT_VETO.openCount, 0, 20, true);
        veto.iceLbCount = clampNum(v.iceLbCount, DEFAULT_VETO.iceLbCount, 0, 20, true);
        veto.floatMvYi = clampNum(v.floatMvYi, DEFAULT_VETO.floatMvYi, 0, 100000, true);
        const a = raw.advice || {};
        advice.active = clampNum(a.active, DEFAULT_ADVICE.active, 0, 100, true);
        advice.probPct = clampNum(a.probPct, DEFAULT_ADVICE.probPct, 0, 100, true);
        advice.watch = clampNum(a.watch, DEFAULT_ADVICE.watch, 0, 100, true);
        advice.wait = clampNum(a.wait, DEFAULT_ADVICE.wait, 0, 100, true);
        return { effectiveDate: raw.effectiveDate, weights, veto, advice };
    }

    /**
     * 生成默认配置对象（方案计算统一用；effectiveDate空=不启用前端重算）
     * @returns {{effectiveDate:null, weights:Object, veto:Object, advice:Object}}
     */
    function defaultConfig() {
        return {
            effectiveDate: null,
            weights: Object.assign({}, DEFAULT_WEIGHTS),
            veto: Object.assign({}, DEFAULT_VETO),
            advice: Object.assign({}, DEFAULT_ADVICE)
        };
    }

    /**
     * 两配置的模型参数是否一致（权重/否决/建议分级逐项相等；忽略生效日期）
     * 用途：当前方案与"昨日最准"等自动方案的一致性判定（TODO13.2.4）
     * @param {Object} a 配置A
     * @param {Object} b 配置B
     * @returns {boolean}
     */
    function configsEqual(a, b) {
        if (!a || !b) return false;
        const cmp = (x, y) => String(x) === String(y);
        return Object.keys(DEFAULT_WEIGHTS).every(k => cmp((a.weights || {})[k], (b.weights || {})[k]))
            && Object.keys(DEFAULT_VETO).every(k => cmp((a.veto || {})[k], (b.veto || {})[k]))
            && Object.keys(DEFAULT_ADVICE).every(k => cmp((a.advice || {})[k], (b.advice || {})[k]));
    }

    /**
     * 评估配置在回测周期上的Top5命中情况（TODO13.2预测回溯）
     * 命中判定：预测日Top5标的在次日涨停池中且连板数更高（晋级成功）
     * @param {Array<{day:Object, next:Object}>} cycles 回测周期（day=预测日数据，next=次日结果数据）
     * @param {Object} config 评分配置
     * @returns {{hits:number, total:number, rate:number|null}} 命中数/预测总数/命中率（total=0时rate=null）
     */
    function evalSchemeAccuracy(cycles, config) {
        let hits = 0, total = 0;
        (cycles || []).forEach(c => {
            if (!c || !c.day || !c.next) return;
            const ranked = rescoreDay(c.day, config);
            (ranked.top5 || []).forEach(s => {
                const ns = (c.next.ztpool || []).find(x => x.code === s.code);
                total += 1;
                if (ns && (ns.lbCount || 1) > (s.lbCount || 1)) hits += 1;
            });
        });
        return { hits, total, rate: total ? hits / total : null };
    }

    /**
     * 模型参数爬山调优（TODO13.2：根据T+1实际结果微调权重，确定性算法）
     * 主流程：以base配置为起点 → 逐维尝试±2/±4权重微调 → 保留命中率提升最大的调整
     *         → 最多3轮直至无改进；平手时取与base总偏差更小的配置（防过拟合大幅偏移）
     * @param {Array<{day:Object, next:Object}>} cycles 回测周期（至少1个周期）
     * @param {Object} baseConfig 起始配置（当前方案；veto/advice保持不变，仅调权重）
     * @returns {{config:Object, accuracy:{hits:number,total:number,rate:number|null}}} 调优后配置与命中率
     */
    function optimizeScheme(cycles, baseConfig) {
        const dims = Object.keys(DEFAULT_WEIGHTS);
        const baseW = {};
        dims.forEach(k => { baseW[k] = Number(baseConfig.weights[k]); });
        const baseAcc = evalSchemeAccuracy(cycles, baseConfig);
        // 无可评估数据（无周期/Top5全空）时原样返回，避免无意义调优
        if (!cycles || !cycles.length || baseAcc.total === 0) {
            return { config: cloneConfig(baseConfig), accuracy: baseAcc };
        }
        /**
         * 权重与base的总偏差（平手时的次序偏好）
         */
        const devOf = w => dims.reduce((a, k) => a + Math.abs(w[k] - baseW[k]), 0);
        let bestW = Object.assign({}, baseW);
        let bestAcc = baseAcc;
        let bestDev = 0;
        const DELTAS = [-4, -2, 2, 4];
        for (let round = 0; round < 3; round++) {
            let improved = false;
            dims.forEach(k => {
                DELTAS.forEach(d => {
                    const w = Object.assign({}, bestW);
                    const v = Math.round(w[k] + d);
                    if (v < 0 || v > 50 || v === w[k]) return;
                    w[k] = v;
                    const acc = evalSchemeAccuracy(cycles, Object.assign({}, baseConfig, { weights: w }));
                    if (acc.total === 0) return;
                    const dev = devOf(w);
                    if (acc.rate > bestAcc.rate + 1e-9
                        || (Math.abs(acc.rate - bestAcc.rate) <= 1e-9 && dev < bestDev)) {
                        bestW = w; bestAcc = acc; bestDev = dev; improved = true;
                    }
                });
            });
            if (!improved) break;
        }
        return {
            config: Object.assign({}, baseConfig, { weights: bestW }),
            accuracy: bestAcc
        };
    }

    /**
     * 深拷贝配置（方案对象在会话内多处引用，避免相互污染）
     * @param {Object} config 配置
     * @returns {Object} 副本
     */
    function cloneConfig(config) {
        return {
            effectiveDate: config.effectiveDate || null,
            weights: Object.assign({}, config.weights),
            veto: Object.assign({}, config.veto),
            advice: Object.assign({}, config.advice)
        };
    }

    return {
        // 默认配置（设置面板预填用）
        DEFAULT_WEIGHTS,
        DEFAULT_VETO,
        DEFAULT_ADVICE,
        // 评分重算
        rescoreDay,
        // 方案调优（TODO13.2预测回溯）
        defaultConfig,
        configsEqual,
        evalSchemeAccuracy,
        optimizeScheme,
        cloneConfig,
        // 配置管理
        getSavedConfig,
        saveConfig,
        clearConfig,
        isActiveFor,
        isDefaultConfig,
        normalizeConfig
    };
})();
