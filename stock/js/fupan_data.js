/**
 * 每日复盘数据模块（FupanData）
 *
 * 职责：
 * 1. 拉取后端采集落盘的复盘JSON（GitHub Pages静态部署，同源fetch，无需代理）
 *    - data/fupan/summary.json       多日汇总（趋势图数据源）
 *    - data/fupan/days/YYYYMMDD.json 单日完整数据（四子tab数据源）
 * 2. 缓存策略：
 *    - 历史交易日数据（< 今天）：localStorage永久缓存（历史数据不变）
 *    - 当日数据：当日缓存（复用StockAPI.getDailyCache，当日CI更新后次日自动失效）
 *    - summary：当日缓存
 * 3. 数据加工：可用交易日列表、趋势序列提取、数值格式化
 *
 * 数据结构（后端fupan模块落盘）：
 * - summary: {generatedAt, days:[{date, ztCount, dtCount, zbCount, sealRate, lbCount,
 *            maxLB, maxLBStock, upCount, downCount, totalAmount, avgChange, medianChange,
 *            promotionRate, yesterdayAvgChange, phase}]}
 * - day:    {date, generatedAt, market:{indices, activity, allA}, sectors:{industry, concept},
 *            ztpool, dtpool, zbpool, ladder, promotion, sentiment, scores, stats}
 */
const FupanData = (function () {

    // 数据文件基础路径（本地开发与GitHub Pages部署同为 stock/ 下相对路径）
    const DATA_BASE = 'data/fupan/';
    const SUMMARY_URL = DATA_BASE + 'summary.json';

    // 缓存key
    const SUMMARY_CACHE_KEY = 'fupan_summary';
    const DAY_CACHE_PREFIX = 'fupan_day_'; // + YYYYMMDD

    // 内存缓存（会话内避免重复解析大JSON）
    let summaryCache = null;          // summary对象
    let dayCache = new Map();         // dateStr -> day对象（内存）
    let inFlight = new Map();         // dateStr -> Promise（去重并发请求）

    // ===== 内部工具 =====

    /**
     * 日期格式转换：YYYY-MM-DD -> YYYYMMDD
     * @param {string} dateStr 日期字符串（YYYY-MM-DD）
     * @returns {string} 紧凑日期（YYYYMMDD）
     */
    function toCompact(dateStr) {
        return String(dateStr).replace(/-/g, '');
    }

    /**
     * 判断日期字符串是否早于今天（历史交易日）
     * @param {string} dateStr YYYY-MM-DD
     * @returns {boolean} true=历史日期
     */
    function isHistoryDate(dateStr) {
        return dateStr < StockAPI.todayStr();
    }

    /**
     * fetch JSON（带超时）
     * @param {string} url 请求地址
     * @param {number} timeout 超时ms
     * @returns {Promise<Object>} 解析后的JSON
     */
    async function fetchJson(url, timeout = 15000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const resp = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + url);
            return await resp.json();
        } finally {
            clearTimeout(timer);
        }
    }

    // ===== 数据获取 =====

    /**
     * 获取多日汇总数据（当日缓存，趋势图数据源）
     * @param {boolean} force 是否跳过缓存强制刷新
     * @returns {Promise<Object>} summary对象 {generatedAt, days[]}
     */
    async function getSummary(force = false) {
        if (!force && summaryCache) return summaryCache;
        if (!force) {
            const cached = StockAPI.getDailyCache(SUMMARY_CACHE_KEY);
            if (cached && cached.days && cached.days.length > 0) {
                summaryCache = cached;
                return cached;
            }
        }
        const data = await fetchJson(SUMMARY_URL);
        if (!data || !Array.isArray(data.days)) throw new Error('summary数据格式异常');
        summaryCache = data;
        StockAPI.setDailyCache(SUMMARY_CACHE_KEY, data);
        return data;
    }

    /**
     * 获取指定交易日完整数据（历史永久缓存 / 当日当日缓存）
     * @param {string} dateStr 日期 YYYY-MM-DD
     * @param {boolean} force 是否跳过缓存强制刷新
     * @returns {Promise<Object>} 单日复盘数据
     */
    async function getDay(dateStr, force = false) {
        if (!force && dayCache.has(dateStr)) return dayCache.get(dateStr);

        // 内存无缓存时，先查localStorage
        if (!force) {
            const compact = toCompact(dateStr);
            let cached = null;
            if (isHistoryDate(dateStr)) {
                // 历史数据不变，永久缓存
                try {
                    const raw = localStorage.getItem(DAY_CACHE_PREFIX + compact);
                    cached = raw ? JSON.parse(raw) : null;
                } catch (e) { cached = null; }
            } else {
                cached = StockAPI.getDailyCache(DAY_CACHE_PREFIX + compact);
            }
            if (cached) {
                dayCache.set(dateStr, cached);
                return cached;
            }
        }

        // 去重并发：同一天数据正在请求中时复用同一Promise
        if (inFlight.has(dateStr)) return inFlight.get(dateStr);

        const task = (async () => {
            try {
                const data = await fetchJson(DATA_BASE + 'days/' + toCompact(dateStr) + '.json');
                if (!data || !data.date) throw new Error('复盘数据格式异常: ' + dateStr);
                dayCache.set(dateStr, data);
                // 落盘缓存
                const compact = toCompact(dateStr);
                if (isHistoryDate(dateStr)) {
                    try {
                        localStorage.setItem(DAY_CACHE_PREFIX + compact, JSON.stringify(data));
                    } catch (e) {
                        // 存储满时清理全部复盘日缓存后重试一次
                        cleanAllDayCache();
                        try { localStorage.setItem(DAY_CACHE_PREFIX + compact, JSON.stringify(data)); } catch (e2) { /* 放弃落盘，仅内存缓存 */ }
                    }
                } else {
                    StockAPI.setDailyCache(DAY_CACHE_PREFIX + compact, data);
                }
                return data;
            } finally {
                inFlight.delete(dateStr);
            }
        })();
        inFlight.set(dateStr, task);
        return task;
    }

    /**
     * 清理全部复盘日数据缓存（localStorage满时兜底）
     */
    function cleanAllDayCache() {
        try {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(DAY_CACHE_PREFIX)) keys.push(key);
            }
            keys.forEach(key => localStorage.removeItem(key));
            console.warn('已清理' + keys.length + '条复盘日缓存（存储空间不足）');
        } catch (e) { /* 忽略 */ }
    }

    // ===== 数据加工 =====

    /**
     * 获取可用交易日列表（升序）
     * @returns {Promise<string[]>} 日期数组 YYYY-MM-DD
     */
    async function getAvailableDates() {
        const summary = await getSummary();
        return summary.days.map(d => d.date).sort();
    }

    /**
     * 获取最新交易日
     * @returns {Promise<string>} YYYY-MM-DD
     */
    async function getLatestDate() {
        const dates = await getAvailableDates();
        if (!dates.length) throw new Error('暂无复盘数据（可能首次采集未完成）');
        return dates[dates.length - 1];
    }

    /**
     * 获取最近N日交易日列表（升序，含dateStr）
     * @param {string} dateStr 截止日期 YYYY-MM-DD
     * @param {number} n 天数
     * @returns {Promise<string[]>} 日期数组
     */
    async function getRecentDates(dateStr, n) {
        const dates = await getAvailableDates();
        const idx = dates.indexOf(dateStr);
        if (idx === -1) return dates.slice(-n);
        return dates.slice(Math.max(0, idx + 1 - n), idx + 1);
    }

    /**
     * 从summary提取趋势序列（截止dateStr的近n日）
     * @param {string} dateStr 截止日期
     * @param {number} n 天数
     * @param {string} field summary.days字段名（ztCount/dtCount/totalAmount/...）
     * @returns {Promise<{labels: string[], values: number[]}>}
     */
    async function getTrend(dateStr, n, field) {
        const summary = await getSummary();
        const days = summary.days.slice().sort((a, b) => a.date < b.date ? -1 : 1);
        const idx = days.findIndex(d => d.date === dateStr);
        const end = idx === -1 ? days.length : idx + 1;
        const slice = days.slice(Math.max(0, end - n), end);
        return {
            labels: slice.map(d => d.date.slice(5)),  // MM-DD
            values: slice.map(d => {
                const v = d[field];
                return (v === null || v === undefined) ? null : v;
            })
        };
    }

    // ===== 格式化工具（渲染层复用） =====

    /**
     * 格式化成交额（元 -> 亿/万亿）
     * @param {number} amount 金额（元）
     * @returns {string} 格式化文本
     */
    function formatAmount(amount) {
        if (amount === null || amount === undefined || isNaN(amount)) return '--';
        if (amount >= 1e12) return (amount / 1e12).toFixed(2) + '万亿';
        if (amount >= 1e8) return (amount / 1e8).toFixed(1) + '亿';
        if (amount >= 1e4) return (amount / 1e4).toFixed(1) + '万';
        return String(Math.round(amount));
    }

    /**
     * 格式化为亿元数值（不带单位，最多2位小数）
     * @param {number} amount 金额（元）
     * @returns {string} 如 7.85 / -12.30
     */
    function formatYi(amount) {
        if (amount === null || amount === undefined || isNaN(amount)) return '--';
        return (amount / 1e8).toFixed(2);
    }

    // ===== 用户设置持久化（TODO5.6.2：所有勾选/下拉状态记住） =====

    /**
     * 读取持久化设置（带默认值）
     * @param {string} key 存储key
     * @param {*} def 默认值
     * @returns {*} 存储值（JSON反序列化）或默认值
     */
    function getSetting(key, def) {
        try {
            const raw = localStorage.getItem(key);
            if (raw === null) return def;
            return JSON.parse(raw);
        } catch (e) {
            return def;
        }
    }

    /**
     * 写入持久化设置（JSON序列化）
     * @param {string} key 存储key
     * @param {*} value 值
     */
    function setSetting(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) { /* 存储满等异常时忽略 */ }
    }

    // ===== 关注板块（与板块资金tab共享localStorage，同源） =====

    /**
     * 读取关注板块名称集合
     * 来源：板块资金tab的板块配置（selectedSectors_industry/selectedSectors_concept）
     * @param {string} [board] industry/concept（不传=行业+概念合集）
     * @returns {Set<string>} 关注板块名集合（无配置时返回空集合）
     */
    function getWatchedSectors(board) {
        const keys = board ? ['selectedSectors_' + board] : ['selectedSectors_industry', 'selectedSectors_concept'];
        const set = new Set();
        keys.forEach(k => {
            try {
                const raw = localStorage.getItem(k);
                if (raw) JSON.parse(raw).forEach(n => set.add(n));
            } catch (e) { /* 忽略脏数据 */ }
        });
        return set;
    }

    /**
     * 是否存在关注板块配置（用于"仅显示关注板块"勾选时的空态提示）
     * @returns {boolean}
     */
    function hasWatchedSectors() {
        return getWatchedSectors().size > 0;
    }

    /**
     * 格式化百分比（0-1小数 -> xx.x%）
     * @param {number} rate 比率（0-1）
     * @returns {string} 格式化文本
     */
    function formatRate(rate) {
        if (rate === null || rate === undefined || isNaN(rate)) return '--';
        return (rate * 100).toFixed(1) + '%';
    }

    /**
     * 涨跌幅显示值：null -> '--'（停牌/无数据），否则保留1位小数
     * @param {number} v 涨跌幅
     * @returns {string} 格式化文本
     */
    function formatChange(v) {
        if (v === null || v === undefined || isNaN(v)) return '--';
        return (v > 0 ? '+' : '') + v.toFixed(2);
    }

    /**
     * 涨跌幅颜色class（红涨绿跌）
     * @param {number} v 涨跌幅
     * @returns {string} change-up/change-down/change-zero
     */
    function changeClass(v) {
        if (v === null || v === undefined || isNaN(v) || v === 0) return 'change-zero';
        return v > 0 ? 'change-up' : 'change-down';
    }

    return {
        getSummary,
        getDay,
        getAvailableDates,
        getLatestDate,
        getRecentDates,
        getTrend,
        // 格式化工具
        formatAmount,
        formatYi,
        formatRate,
        formatChange,
        changeClass,
        // 设置持久化
        getSetting,
        setSetting,
        // 关注板块
        getWatchedSectors,
        hasWatchedSectors,
        // 缓存管理
        cleanAllDayCache
    };
})();
