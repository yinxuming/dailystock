/**
 * A股交易日历工具（前端JavaScript版本）
 * 基于 chinese-days 节假日数据，判断某日期是否为交易日
 * 交易日 = 周一至周五 且 不在法定节假日
 * 调休补班日（周末变工作日）A股仍休市，故不视为交易日
 *
 * 参考实现：D:\Code\test\Invest\fund\fundhome-full\app\src\utils\tradingCalendar.ts
 *
 * 缓存策略：
 * - localStorage: 节假日数据本地持久化，避免每次刷新重新请求CDN
 * - yearCache: 内存缓存，避免重复解析JSON
 * - latestTradeDateCache: 最近交易日结果缓存（同一天内不变）
 * - tradingDayCache: isTradingDay结果缓存（同一天内不变）
 *
 * 重试策略：
 * - CDN加载失败时自动重试，最多3次，间隔递增（1s/2s/4s）
 *
 * 容错策略：
 * - 节假日数据不可用时，周一到周五默认视为交易日（保证数据正确性）
 * - 最坏情况：假期当天多请求一次API，但不会导致正常交易日数据不更新
 */
(function (global) {
    'use strict';

    const CDN_BASE = 'https://cdn.jsdelivr.net/npm/chinese-days@1/dist/years';
    const LOCAL_STORAGE_KEY = 'sector_analysis_holidays_cache';
    const MAX_RETRY = 3;
    const RETRY_DELAYS = [1000, 2000, 4000];

    // 内存缓存：年份 -> 节假日集合
    const yearCache = new Map();
    let latestTradeDateCache = null;       // {date, value}
    let previousTradeDateCache = null;     // {date, baseDate, days, value}
    const tradingDayCache = new Map();     // dateStr -> boolean

    let holidaysLoaded = false;
    let holidaysLoadPromise = null;

    /**
     * 格式化日期为 YYYY-MM-DD
     */
    function formatDate(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

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
            /* localStorage满或不可用时静默忽略 */
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
     * 清除节假日本地缓存
     */
    function clearHolidaysCache() {
        localStorage.removeItem(LOCAL_STORAGE_KEY);
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
                lastError = new Error(`HTTP ${res.status}`);
            } catch (e) {
                lastError = e;
            }
            if (i < retries - 1) {
                await new Promise(r => setTimeout(r, RETRY_DELAYS[i]));
            }
        }
        throw lastError || new Error('fetch failed');
    }

    /**
     * 加载某年的节假日数据
     * 优先级：内存缓存 → 本地缓存 → CDN（带重试）
     * CDN加载成功后写入本地缓存
     *
     * @param {number} year 年份
     * @returns {Promise<Set<string>>} 节假日日期集合，格式 YYYY-MM-DD
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
            const res = await fetchWithRetry(`${CDN_BASE}/${year}.json`);
            const data = await res.json();
            const holidays = new Set(Object.keys((data && data.holidays) || {}));
            if (holidays.size > 0) {
                yearCache.set(year, holidays);
                saveYearToLocalCache(year, holidays);
            }
            return holidays;
        } catch (e) {
            console.warn(`[tradingCalendar] 加载 ${year} 年节假日失败（已重试${MAX_RETRY}次）:`, e);
            return new Set();
        }
    }

    /**
     * 加载多个年份的节假日数据
     * 只加载当前年份及之前的年份，未来年份无CDN数据
     */
    async function loadHolidaysForYears(years) {
        const currentYear = new Date().getFullYear();
        const validYears = [...new Set(years)].filter(y => y <= currentYear);
        await Promise.all(validYears.map(loadHolidaysForYear));
    }

    /**
     * 确保节假日数据已加载（全局只加载一次）
     * 后续调用直接返回已加载的Promise，避免重复网络请求
     */
    function ensureHolidaysLoaded() {
        if (holidaysLoaded) return Promise.resolve();
        if (holidaysLoadPromise) return holidaysLoadPromise;

        holidaysLoadPromise = loadHolidaysForYears([new Date().getFullYear()])
            .then(() => { holidaysLoaded = true; })
            .catch(() => { holidaysLoaded = true; });
        return holidaysLoadPromise;
    }

    /**
     * 判断某日期是否为 A股交易日
     * 结果按日期字符串缓存，同一天内不重复计算
     *
     * 判断优先级：
     * 1. 周末 → 非交易日
     * 2. 节假日数据已加载且非空 → 以数据为准
     * 3. 数据不可用 → 默认视为交易日（保证数据正确性）
     *
     * @param {Date} date 日期对象
     * @returns {boolean} 是否为交易日
     */
    function isTradingDay(date) {
        const dateStr = formatDate(date);

        if (tradingDayCache.has(dateStr)) {
            return tradingDayCache.get(dateStr);
        }

        const dayOfWeek = date.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            tradingDayCache.set(dateStr, false);
            return false;
        }

        const year = date.getFullYear();
        const holidays = yearCache.get(year);

        if (holidays && holidays.size > 0) {
            const result = !holidays.has(dateStr);
            tradingDayCache.set(dateStr, result);
            return result;
        }

        tradingDayCache.set(dateStr, true);
        return true;
    }

    /**
     * 获取指定日期的前N个交易日
     * 结果按(当天日期, days)缓存，同一天内不重复计算
     *
     * @param {Date} date 基准日期
     * @param {number} days 往前推的交易日数量，默认1
     * @returns {string|null} 交易日字符串 YYYY-MM-DD，失败返回null
     */
    function getPreviousTradeDate(date, days) {
        days = days || 1;
        const today = formatDate(new Date());
        const baseDate = formatDate(date);

        if (previousTradeDateCache &&
            previousTradeDateCache.date === today &&
            previousTradeDateCache.baseDate === baseDate &&
            previousTradeDateCache.days === days) {
            return previousTradeDateCache.value;
        }

        let current = new Date(date);
        current.setDate(current.getDate() - 1);
        let count = 0;

        while (count < days && current.getFullYear() > 2000) {
            if (isTradingDay(current)) {
                count++;
                if (count === days) {
                    const result = formatDate(current);
                    previousTradeDateCache = { date: today, baseDate, days, value: result };
                    return result;
                }
            }
            current.setDate(current.getDate() - 1);
        }
        return null;
    }

    /**
     * 获取最近的交易日（当天如果是交易日返回当天，否则往前找）
     * 结果按天缓存，同一天内不重复计算
     *
     * @returns {string} 最近的交易日字符串 YYYY-MM-DD
     */
    function getLatestTradeDate() {
        const today = formatDate(new Date());

        if (latestTradeDateCache && latestTradeDateCache.date === today) {
            return latestTradeDateCache.value;
        }

        const todayDate = new Date();
        let result;
        if (isTradingDay(todayDate)) {
            result = today;
        } else {
            result = getPreviousTradeDate(todayDate, 1) || today;
        }

        latestTradeDateCache = { date: today, value: result };
        return result;
    }

    /**
     * 异步获取最近交易日（确保节假日数据已加载）
     * 与getLatestTradeDate区别：先await节假日数据加载，再计算
     *
     * @returns {Promise<string>} 最近的交易日字符串 YYYY-MM-DD
     */
    async function getLatestTradeDateAsync() {
        await ensureHolidaysLoaded();
        // 清空缓存重新计算，确保使用最新的节假日数据
        latestTradeDateCache = null;
        previousTradeDateCache = null;
        tradingDayCache.clear();
        return getLatestTradeDate();
    }

    // 导出到全局
    global.TradingCalendar = {
        formatDate,
        isTradingDay,
        getPreviousTradeDate,
        getLatestTradeDate,
        getLatestTradeDateAsync,
        ensureHolidaysLoaded,
        loadHolidaysForYear,
        clearHolidaysCache
    };
})(window);
