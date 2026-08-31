/**
 * A股交易日历工具模块
 *
 * 基于 chinese-days 节假日数据，判断某日期是否为交易日
 * 交易日 = 周一至周五 且 不在法定节假日
 * 调休补班日（周末变工作日）A股仍休市，故不视为交易日
 *
 * 缓存策略：
 * - localStorage: 节假日数据本地持久化，避免每次刷新重新请求CDN
 * - yearCache: 内存缓存，避免重复解析JSON
 *
 * 交易时间判断：
 * - A股交易时间：9:30-11:30, 13:00-15:00（北京时间）
 * - 收盘后（15:00之后）：视为非交易时段，T+0=下一交易日
 * - 盘前（9:30之前）：视为非交易时段，T+0=当日
 */
const TradingCalendar = (function () {

    const CDN_BASE = 'https://cdn.jsdelivr.net/npm/chinese-days@1/dist/years';
    const LOCAL_STORAGE_KEY = 'unusual_holidays_cache';
    const MAX_RETRY = 3;
    const RETRY_DELAYS = [1000, 2000, 4000];

    // A股交易时间（北京时间）
    const MARKET_OPEN_HOUR = 9;
    const MARKET_OPEN_MIN = 30;
    const MARKET_CLOSE_HOUR = 15;
    const MARKET_CLOSE_MIN = 0;

    // 内存缓存
    const yearCache = new Map();
    let holidaysLoaded = false;
    let holidaysLoadPromise = null;

    /**
     * 从localStorage读取节假日缓存
     */
    function readLocalCache() {
        try {
            const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }

    /**
     * 写入节假日缓存到localStorage
     */
    function writeLocalCache(data) {
        try {
            localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            // localStorage满或不可用时静默忽略
        }
    }

    /**
     * 将某年节假日数据写入本地缓存
     */
    function saveYearToLocalCache(year, holidays) {
        const cache = readLocalCache();
        cache[year] = {
            holidays: Array.from(holidays),
            cachedAt: new Date().toISOString()
        };
        writeLocalCache(cache);
    }

    /**
     * 从本地缓存读取某年节假日数据
     */
    function loadYearFromLocalCache(year) {
        const cache = readLocalCache();
        const entry = cache[year];
        if (!entry || !Array.isArray(entry.holidays)) return null;
        return new Set(entry.holidays);
    }

    /**
     * 带重试的fetch请求
     */
    async function fetchWithRetry(url, retries) {
        retries = retries || MAX_RETRY;
        let lastError = null;
        for (let i = 0; i < retries; i++) {
            try {
                const res = await fetch(url);
                if (res.ok) return res;
                lastError = new Error('HTTP ' + res.status);
            } catch (e) {
                lastError = e;
            }
            if (i < retries - 1) {
                await new Promise(function (r) { setTimeout(r, RETRY_DELAYS[i]); });
            }
        }
        throw lastError || new Error('fetch failed');
    }

    /**
     * 加载某年的节假日数据
     * 优先级：内存缓存 → 本地缓存 → CDN（带重试）
     * @param {number} year - 年份
     * @returns {Promise<Set>} 节假日日期集合，格式 YYYY-MM-DD
     */
    async function loadHolidaysForYear(year) {
        if (yearCache.has(year)) {
            return yearCache.get(year);
        }

        const localData = loadYearFromLocalCache(year);
        if (localData && localData.size > 0) {
            yearCache.set(year, localData);
            return localData;
        }

        try {
            const res = await fetchWithRetry(CDN_BASE + '/' + year + '.json');
            const data = await res.json();
            const holidays = new Set(Object.keys(data.holidays || {}));
            if (holidays.size > 0) {
                yearCache.set(year, holidays);
                saveYearToLocalCache(year, holidays);
            }
            return holidays;
        } catch (e) {
            console.warn('加载 ' + year + ' 年节假日失败:', e);
            return new Set();
        }
    }

    /**
     * 确保节假日数据已加载（全局只加载一次）
     * @returns {Promise<void>}
     */
    function ensureHolidaysLoaded() {
        if (holidaysLoaded) return Promise.resolve();
        if (holidaysLoadPromise) return holidaysLoadPromise;

        const currentYear = new Date().getFullYear();
        holidaysLoadPromise = loadHolidaysForYear(currentYear)
            .then(function () { return loadHolidaysForYear(currentYear - 1); })
            .then(function () { holidaysLoaded = true; })
            .catch(function () { holidaysLoaded = true; });
        return holidaysLoadPromise;
    }

    /**
     * 判断某日期是否为A股交易日
     * @param {Date|string} date - 日期对象或YYYY-MM-DD字符串
     * @returns {boolean} 是否为交易日
     */
    function isTradingDay(date) {
        const d = typeof date === 'string' ? new Date(date + 'T00:00:00') : date;
        const dayOfWeek = d.getDay();

        // 周末不是交易日
        if (dayOfWeek === 0 || dayOfWeek === 6) return false;

        const year = d.getFullYear();
        const holidays = yearCache.get(year);

        if (holidays && holidays.size > 0) {
            const dateStr = formatDate(d);
            return !holidays.has(dateStr);
        }

        // 数据不可用时，默认视为交易日
        return true;
    }

    /**
     * 格式化日期为YYYY-MM-DD
     * @param {Date} date
     * @returns {string}
     */
    function formatDate(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + d;
    }

    /**
     * 获取最近的交易日（当天或往前找）
     * @returns {string} YYYY-MM-DD格式
     */
    function getLatestTradeDate() {
        const today = new Date();
        if (isTradingDay(today)) {
            return formatDate(today);
        }
        return getPreviousTradeDate(today, 1) || formatDate(today);
    }

    /**
     * 获取指定日期的前N个交易日
     * @param {Date} date - 基准日期
     * @param {number} days - 往前推的交易日数量，默认1
     * @returns {string|null} YYYY-MM-DD格式
     */
    function getPreviousTradeDate(date, days) {
        days = days || 1;
        let current = new Date(date);
        current.setDate(current.getDate() - 1);
        let count = 0;

        while (count < days && current.getFullYear() > 2000) {
            if (isTradingDay(current)) {
                count++;
                if (count === days) {
                    return formatDate(current);
                }
            }
            current.setDate(current.getDate() - 1);
        }
        return null;
    }

    /**
     * 获取指定日期的后N个交易日
     * @param {Date} date - 基准日期
     * @param {number} days - 往后推的交易日数量，默认1
     * @returns {string|null} YYYY-MM-DD格式
     */
    function getNextTradeDate(date, days) {
        days = days || 1;
        let current = new Date(date);
        current.setDate(current.getDate() + 1);
        let count = 0;

        while (count < days && current.getFullYear() < 2100) {
            if (isTradingDay(current)) {
                count++;
                if (count === days) {
                    return formatDate(current);
                }
            }
            current.setDate(current.getDate() + 1);
        }
        return null;
    }

    /**
     * 判断当前是否在交易时间内
     * @returns {boolean}
     */
    function isMarketOpen() {
        const now = new Date();
        const dayOfWeek = now.getDay();

        // 周末不交易
        if (dayOfWeek === 0 || dayOfWeek === 6) return false;

        // 非交易日不交易
        if (!isTradingDay(now)) return false;

        const hour = now.getHours();
        const minute = now.getMinutes();
        const timeVal = hour * 60 + minute;

        const openTime = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN;   // 9:30 = 570
        const closeTime = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN; // 15:00 = 900

        return timeVal >= openTime && timeVal < closeTime;
    }

    /**
     * 判断当前是否已收盘
     * @returns {boolean}
     */
    function isMarketClosed() {
        const now = new Date();

        // 非交易日视为已收盘
        if (!isTradingDay(now)) return true;

        const hour = now.getHours();
        const minute = now.getMinutes();
        const timeVal = hour * 60 + minute;
        const closeTime = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN; // 15:00

        return timeVal >= closeTime;
    }

    /**
     * 获取当前应该显示的"目标交易日"
     *
     * 规则：
     * - 交易时间内：目标交易日 = 当天
     * - 已收盘（交易日下午3点后）：目标交易日 = 下一交易日
     * - 非交易日（周末/节假日）：目标交易日 = 下一交易日
     *
     * @returns {string} YYYY-MM-DD格式
     */
    function getTargetTradeDate() {
        const now = new Date();

        // 交易时间内，目标就是今天
        if (isMarketOpen()) {
            return formatDate(now);
        }

        // 已收盘或非交易日，目标是下一交易日
        if (isTradingDay(now) && !isMarketClosed()) {
            // 交易日的盘前时段（9:30之前），目标还是今天
            return formatDate(now);
        }

        // 已收盘或非交易日，找下一交易日
        const nextDate = getNextTradeDate(now, 1);
        return nextDate || formatDate(now);
    }

    /**
     * 获取交易日偏移量
     * 返回值表示：当前K线数据的最新日期，距离目标交易日还有几个交易日
     *
     * 例如：K线最新日期6.12，目标交易日6.15，偏移量=1
     * 这意味着T+0列实际展示的是6.15的触发值，T+1是6.16...
     *
     * @param {string} klineLatestDate - K线最新日期 YYYY-MM-DD
     * @param {string} targetDate - 目标交易日 YYYY-MM-DD
     * @returns {number} 偏移的交易日数（0=当天，1=下一交易日...）
     */
    function getTradeDayOffset(klineLatestDate, targetDate) {
        if (klineLatestDate === targetDate) return 0;

        const start = new Date(klineLatestDate + 'T00:00:00');
        let current = new Date(start);
        let count = 0;

        while (count < 10 && current.getFullYear() < 2100) {
            current.setDate(current.getDate() + 1);
            if (isTradingDay(current)) {
                count++;
                if (formatDate(current) === targetDate) {
                    return count;
                }
            }
        }
        return 0;
    }

    /**
     * 获取指定日期对应的最近交易日
     * 如果是交易日，返回该日期；如果不是（周末/节假日），往前找最近的交易日
     * @param {string} dateStr - YYYY-MM-DD格式日期
     * @returns {string} YYYY-MM-DD格式交易日
     */
    function getNearestTradeDate(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        if (isTradingDay(d)) {
            return dateStr;
        }
        // 往前找最近的交易日
        return getPreviousTradeDate(d, 1) || dateStr;
    }

    return {
        ensureHolidaysLoaded,
        isTradingDay,
        getLatestTradeDate,
        getPreviousTradeDate,
        getNextTradeDate,
        getNearestTradeDate,
        isMarketOpen,
        isMarketClosed,
        getTargetTradeDate,
        getTradeDayOffset,
        formatDate
    };
})();
