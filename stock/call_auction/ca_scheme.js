/**
 * 竞价评分方案引擎（CAScheme）—— TODO39.2 预测回溯
 *
 * 纯函数模块，不依赖 DOM / 网络，可在 Node 中单测（复用 CARating）。
 *
 * 背景：竞价评分（CARating.computeRow 的 score/tier）口径固定时，无法判断
 * 「这套阈值在历史上准不准」。本模块仿每日复盘 FupanScoring 的方案回溯机制，
 * 用历史「竞价 + 次日收盘」数据回测，自动爬山调优出更准的方案。
 *
 * 命中口径（TODO39.2 与用户确认）：
 *   - 单票收益 ret = (T+1收盘价 - T日9:25竞价价) / T日9:25竞价价 × 100%
 *     （当日竞价首次买入，持有到次日收盘）
 *   - 一字板买不到：T日竞价封在涨停价(atLimitUp)且封单充裕
 *     （封单额/竞价额 ≥ sealRatio，或未匹配买量缺失视为封死）→ ret 记 null，
 *     不参与统计（实盘排不到队，既不奖励也不惩罚）
 *   - 方案准确度 = 该方案评分排序 TopN 中「可成交」股票 ret 的平均值，越高越准
 *
 * 方案调优为确定性算法（固定维度顺序 + 固定步长序列 + 固定比较规则），
 * 同一数据集结果可复现。调优仅调整 权重/封顶/档位，硬性淘汰规则保持不变。
 */
const CAScheme = (function () {
    'use strict';

    // 依赖 CARating（浏览器全局 or Node require）
    let CARating;
    if (typeof window !== 'undefined') {
        CARating = window.CARating;
    } else if (typeof require !== 'undefined') {
        CARating = require('./ca_rating.js');
    }
    if (!CARating) throw new Error('CAScheme 依赖 CARating，请先加载 ca_rating.js');

    // 方案准确度的 TopN（评分排序前 N 只参与收益统计）
    const DEFAULT_TOPN = 10;
    // 爬山步长序列（多尺度：先粗后细）
    const STEPS = [12, 8, 4, 2, 1];

    function num(v) {
        return typeof v === 'number' && isFinite(v) ? v : null;
    }

    // ===== 配置 =====

    /** 默认方案配置（= CARating 现行口径） */
    function defaultConfig() {
        return CARating.cloneCfg(CARating.DEFAULT_SCORE_CFG);
    }

    /** 方案参数是否一致（忽略结构外字段） */
    function configsEqual(a, b) {
        if (!a || !b) return a === b;
        const keys = Object.keys(CARating.DIM_DEFAULT_MAX);
        const capKeys = ['premiumGapMax', 'capValue', 'divergenceRAmt'];
        const eq = (x, y) => (x == null ? y == null : Math.abs(Number(x) - Number(y)) < 1e-9);
        return keys.every(k => eq(a.weights && a.weights[k], b.weights && b.weights[k]))
            && capKeys.every(k => eq(a.cap && a.cap[k], b.cap && b.cap[k]))
            && eq(a.tier && a.tier.buy, b.tier && b.tier.buy)
            && eq(a.tier && a.tier.watch, b.tier && b.tier.watch);
    }

    // ===== 一字板买不到判定 =====

    /**
     * 判定 T 日竞价是否「基本买不到」（一字板且封单充裕）
     * 规则：撮合封在涨停价(atLimitUp)，且
     *   - 未匹配买量缺失（视为封死），或
     *   - 封单额 / 竞价额 ≥ sealRatio（默认 5，封单是成交额的 5 倍以上排队无望）
     * @param {Object} r - CARating.computeRow 后的行（含 atLimitUp/unmatchedVol/aucAmt/match）
     * @param {number} [sealRatio] 封单充裕度阈值
     * @returns {boolean}
     */
    function isUnbuyable(r, sealRatio) {
        const k = (sealRatio == null ? 5 : sealRatio);
        if (!r || !r.atLimitUp) return false;
        const um = num(r.unmatchedVol);
        const aucAmt = num(r.aucAmt);
        const price = num(r.match);
        // 封在涨停但无竞价额/价格信息：保守视为封死买不到
        if (aucAmt == null || price == null || aucAmt <= 0) return true;
        // 未匹配买量缺失：腾讯快照无买一量，按封死处理
        if (um == null || um <= 0) return true;
        const sealAmt = Math.abs(um) * 100 * price;   // 封单额（元）
        return (sealAmt / aucAmt) >= k;
    }

    // ===== 单票收益 =====

    /**
     * 竞价买入 → 次日收盘收益（%）
     * @param {Object} r - computeRow 后的行（match=9:25 竞价价）
     * @param {number} nextClose - T+1 收盘价
     * @param {number} [sealRatio] 一字板封单充裕度阈值
     * @returns {number|null} 收益%；买不到或数据缺失返回 null
     */
    function cycleReturn(r, nextClose, sealRatio) {
        const buy = num(r && r.match);
        const nc = num(nextClose);
        if (buy == null || buy <= 0 || nc == null) return null;
        if (isUnbuyable(r, sealRatio)) return null;   // 实盘买不到，不参与
        return (nc - buy) / buy * 100;
    }

    // ===== 方案准确度 =====

    /**
     * 计算某方案在回测周期上的准确度（TODO39.2）
     * 周期定义：{rows, closeMap}，rows=预测日原始行，closeMap={code:T+1收盘价}
     * 流程：按 config 重算每行评分 → 过滤「可成交」(非买不到且有次日收盘) →
     *       按 score 降序取 TopN → 这些可成交票的 ret 平均值即周期得分；
     *       方案准确度 = 各周期得分的平均（无有效周期返回 null）。
     * @param {Array<{rows:Array, closeMap:Object}>} cycles 回测周期
     * @param {Object} config 方案配置
     * @param {number} [topN] 评分排序前 N 参与统计（默认 10）
     * @param {number} [sealRatio] 一字板封单充裕度阈值
     * @returns {{rate:number|null, cycles:Array<{n:number, avg:number|null}>}}
     */
    function evalSchemeAccuracy(cycles, config, topN, sealRatio) {
        const N = (topN == null ? DEFAULT_TOPN : topN);
        const per = [];
        (cycles || []).forEach(c => {
            if (!c || !c.rows || !c.closeMap) return;
            // 按方案重算评分
            const scored = c.rows.map(r => CARating.computeRow(r, config));
            // 可成交：非一字板买不到，且能算出 ret（有次日收盘）
            const tradable = scored
                .map(r => ({ r: r, ret: cycleReturn(r, c.closeMap[r.code], sealRatio) }))
                .filter(x => x.ret != null)
                .sort((a, b) => (b.r.score - a.r.score));
            const top = tradable.slice(0, N);
            const avg = top.length
                ? top.reduce((s, x) => s + x.ret, 0) / top.length
                : null;
            per.push({ n: top.length, avg: avg });
        });
        const valid = per.filter(p => p.avg != null);
        const rate = valid.length
            ? valid.reduce((s, p) => s + p.avg, 0) / valid.length
            : null;
        return { rate: rate, cycles: per };
    }

    /**
     * 逐周期回测明细（TODO39.2 近5日回测）
     * 与 evalSchemeAccuracy 同口径，但额外返回每周期 TopN 个股（代码/名称/评分/收益）。
     * @param {Array<{date?:string, rows:Array, closeMap:Object}>} cycles
     * @param {Object} config 方案配置
     * @param {number} [topN]
     * @param {number} [sealRatio]
     * @returns {Array<{date:string, n:number, avg:number|null, top:Array}>}
     */
    function evalSchemeDetail(cycles, config, topN, sealRatio) {
        const N = (topN == null ? DEFAULT_TOPN : topN);
        return (cycles || []).map(c => {
            if (!c || !c.rows || !c.closeMap) return { date: (c && c.date) || '', n: 0, avg: null, top: [] };
            const scored = c.rows.map(r => CARating.computeRow(r, config));
            const tradable = scored
                .map(r => ({ r: r, ret: cycleReturn(r, c.closeMap[r.code], sealRatio) }))
                .filter(x => x.ret != null)
                .sort((a, b) => (b.r.score - a.r.score));
            const top = tradable.slice(0, N);
            const avg = top.length ? top.reduce((s, x) => s + x.ret, 0) / top.length : null;
            return {
                date: c.date || '',
                n: top.length,
                avg: avg,
                top: top.map(x => ({ code: x.r.code, name: x.r.name, score: x.r.score, ret: x.ret }))
            };
        });
    }

    // ===== 爬山调优 =====

    /**
     * 方案参数爬山调优（TODO39.2；确定性可复现）
     * 主流程：以 base 为起点 → 逐参数按 STEPS 多尺度步长爬山 → 每轮取第一个改进 →
     *       最多 8 轮直至无改进。目标：最大化 evalSchemeAccuracy.rate（TopN 平均收益）。
     * 调优参数：7 维权重 + capValue + tier.buy + tier.watch（权重∈[0,50]，其余≥0）。
     * @param {Array} cycles 回测周期（至少 1 个有有效收益）
     * @param {Object} baseConfig 起始配置（通常为当前方案）
     * @param {number} [topN]
     * @param {number} [sealRatio]
     * @returns {{config:Object, accuracy:Object}}
     */
    function optimizeScheme(cycles, baseConfig, topN, sealRatio) {
        const base = CARating.cloneCfg(baseConfig);
        const baseAcc = evalSchemeAccuracy(cycles, base, topN, sealRatio);
        // 无可评估周期：原样返回，避免无意义调优
        if (!cycles || !cycles.length || baseAcc.rate == null) {
            return { config: base, accuracy: baseAcc };
        }

        // 可调参数清单（读取/写回配置的路径 + 取值域）
        const dims = Object.keys(CARating.DIM_DEFAULT_MAX);
        const params = [];
        dims.forEach(k => params.push({
            get: c => c.weights[k], set: (c, v) => { c.weights[k] = v; }, min: 0, max: 50
        }));
        params.push({ get: c => c.cap.capValue, set: (c, v) => { c.cap.capValue = v; }, min: 0, max: 100 });
        params.push({ get: c => c.tier.buy, set: (c, v) => { c.tier.buy = v; }, min: 0, max: 100 });
        params.push({ get: c => c.tier.watch, set: (c, v) => { c.tier.watch = v; }, min: 0, max: 100 });

        let best = baseAcc.rate;
        let bestCfg = CARating.cloneCfg(base);

        for (let round = 0; round < 8; round++) {
            let improved = false;
            for (const p of params) {
                for (const step of STEPS) {
                    for (const sign of [1, -1]) {
                        const cur = p.get(bestCfg);
                        const v = Math.round(cur + sign * step);
                        if (v < p.min || v > p.max || v === cur) continue;
                        const trial = CARating.cloneCfg(bestCfg);
                        p.set(trial, v);
                        const acc = evalSchemeAccuracy(cycles, trial, topN, sealRatio);
                        if (acc.rate != null && acc.rate > best + 1e-9) {
                            best = acc.rate;
                            bestCfg = trial;
                            improved = true;
                        }
                    }
                }
            }
            if (!improved) break;
        }

        return {
            config: bestCfg,
            accuracy: evalSchemeAccuracy(cycles, bestCfg, topN, sealRatio)
        };
    }

    /**
     * 构建五方案（当前/昨日最准/3日最准/5日最准/初始）+ 各自在多窗口的准确度
     * @param {Object} opts
     *   - base: 当前方案配置
     *   - cycles: {d1:Array, d3:Array, d5:Array} 三个回测窗口的周期
     *   - topN, sealRatio
     * @returns {{current, initial, ybest, d3best, d5best, accAll}}
     *   ybest/d3best/d5best 在对应窗口无有效周期时为 null
     */
    function buildSchemes(opts) {
        const o = opts || {};
        const base = o.base || defaultConfig();
        const topN = o.topN, sealRatio = o.sealRatio;
        const cycles = o.cycles || { d1: [], d3: [], d5: [] };
        const accIn = (cyc, cfg) => evalSchemeAccuracy(cyc, cfg, topN, sealRatio).rate;
        const accAll = cfg => ({
            d1: accIn(cycles.d1, cfg),
            d3: accIn(cycles.d3, cfg),
            d5: accIn(cycles.d5, cfg)
        });
        const wrapOpt = opt => ({
            config: opt.config,
            acc: { d1: accIn(cycles.d1, opt.config), d3: accIn(cycles.d3, opt.config), d5: accIn(cycles.d5, opt.config) }
        });
        const schemes = {
            current: { config: CARating.cloneCfg(base), acc: accAll(base) },
            initial: { config: defaultConfig(), acc: accAll(defaultConfig()) },
            ybest: cycles.d1.length ? wrapOpt(optimizeScheme(cycles.d1, base, topN, sealRatio)) : null,
            d3best: cycles.d3.length ? wrapOpt(optimizeScheme(cycles.d3, base, topN, sealRatio)) : null,
            d5best: cycles.d5.length ? wrapOpt(optimizeScheme(cycles.d5, base, topN, sealRatio)) : null
        };
        return schemes;
    }

    return {
        defaultConfig,
        configsEqual,
        isUnbuyable,
        cycleReturn,
        evalSchemeAccuracy,
        evalSchemeDetail,
        optimizeScheme,
        buildSchemes,
        DEFAULT_TOPN,
        // 纯函数导出（Node 测试）
        _internals: { num }
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CAScheme;
}
