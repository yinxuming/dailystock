/**
 * 东方财富/腾讯API封装模块
 *
 * 数据获取策略：
 * 1. 用clist API获取阶段涨幅排行（5日涨幅TOP50 + 当日涨幅TOP50）
 * 2. 合并去重后，只对少量候选股票请求K线数据
 * 3. 用K线数据精确计算10日/30日涨幅和异动触发值
 *
 * K线多平台请求：东方财富 + 腾讯，平台轮询分散请求量避免单平台限流；
 * 失败自动切换另一平台，批量获取失败后整体重扫一轮
 *
 * K线本地缓存（localStorage）：
 * - 历史K线长期保留，跨天只增量补拉尾部（按日期合并，同日新数据覆盖旧数据）
 * - LRU容量淘汰（默认500只，设置页可配），自选移除联动清理
 * - 市场行情N个交易日（默认5）未出现的股票淘汰缓存，自选股保护除外
 *
 * 请求方式：所有请求走代理（主代理 → 备用代理自动切换）
 * 识别结果缓存：当日生效，点击刷新可清空缓存强制刷新
 */
const StockAPI = (function () {

    // ===== 东方财富API地址 =====
    const CLIST_BASE = 'https://push2.eastmoney.com/api/qt/clist/get';
    const KLINE_BASE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';

    // 东方财富API公共参数
    const UT = 'b2884a393a59ad64002292a3e90d46a5';

    // A股市场筛选条件（沪深京A股，排除ST）
    const FS_A_SHARE = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';

    // 全A股筛选条件（含北交所，用于自选股搜索的全量列表）
    const FS_ALL_SHARE = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';

    // 涨停池接口（东方财富push2ex）
    const ZTPOOL_BASE = 'https://push2ex.eastmoney.com/getTopicZTPool';

    // 同花顺涨停原因接口
    const THS_ZTPOOL_BASE = 'https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool';

    // ===== 代理配置 =====
    const PROXY_CONFIG = {
        primaryUrl: 'https://vercel-proxy-p.vercel.app',
        backupUrls: ['https://1429314495-dxb6k8oy7q.ap-beijing.tencentscf.com'],
        token: '',
        currentProxyIndex: -1,
        proxyFailCount: 0,
        failThreshold: 3
    };

    // ===== 请求频率控制 =====
    let requestInterval = 2000; // 每个请求之间的间隔(ms)，默认2000ms，避免东方财富限流
    let lastRequestTime = 0; // 上次请求时间戳
    let proxyBackoffUntil = 0; // 代理退避到何时（全局冷却）

    // ===== 缓存配置 =====
    const KLINE_CACHE_PREFIX = 'unusual_kline_';      // 股票K线缓存key前缀
    const INDEX_CACHE_PREFIX = 'unusual_index_';      // 基准指数K线缓存key前缀
    const RESULT_CACHE_KEY = 'unusual_result';        // 识别结果缓存key
    const KLINE_INDEX_KEY = 'unusual_kline_index';    // K线LRU索引 {secid: {la:最后访问时间, ls:最后出现在市场行情的日期}}
    const CACHE_CONFIG_KEY = 'unusual_cache_config';  // 缓存配置 {capacity:容量(只), marketKeepDays:市场股票保留交易日数}
    const CACHE_TTL = 4 * 60 * 60 * 1000;             // 结果缓存/K线新鲜度4小时（覆盖整个交易时段）
    const DEFAULT_CACHE_CONFIG = { capacity: 500, marketKeepDays: 5 };

    // ===== 运行状态（缓存，惰性加载） =====
    let klineCacheIndex = null;   // K线LRU索引
    let cacheConfig = null;       // 缓存配置

    // ===== 代理配置持久化 =====

    /** 从localStorage加载代理配置 */
    function loadProxyConfig() {
        try {
            const saved = localStorage.getItem('unusual_proxy');
            if (saved) {
                const data = JSON.parse(saved);
                if (data.primaryUrl !== undefined) PROXY_CONFIG.primaryUrl = data.primaryUrl;
                if (data.backupUrls !== undefined) PROXY_CONFIG.backupUrls = data.backupUrls;
                if (data.token !== undefined) PROXY_CONFIG.token = data.token;
            }
        } catch (e) {
            console.warn('加载代理配置失败:', e);
        }
    }

    /** 保存代理配置到localStorage */
    function saveProxyConfig() {
        try {
            localStorage.setItem('unusual_proxy', JSON.stringify({
                primaryUrl: PROXY_CONFIG.primaryUrl,
                backupUrls: PROXY_CONFIG.backupUrls,
                token: PROXY_CONFIG.token
            }));
        } catch (e) {
            console.warn('保存代理配置失败:', e);
        }
    }

    /** 获取代理配置 */
    function getProxyConfig() {
        return {
            primaryUrl: PROXY_CONFIG.primaryUrl,
            backupUrls: [...PROXY_CONFIG.backupUrls],
            token: PROXY_CONFIG.token
        };
    }

    /** 更新代理配置 */
    function setProxyConfig(config) {
        if (config.primaryUrl !== undefined) PROXY_CONFIG.primaryUrl = config.primaryUrl;
        if (config.backupUrls !== undefined) PROXY_CONFIG.backupUrls = config.backupUrls;
        if (config.token !== undefined) PROXY_CONFIG.token = config.token;
        PROXY_CONFIG.currentProxyIndex = -1;
        PROXY_CONFIG.proxyFailCount = 0;
        saveProxyConfig();
    }

    // ===== 请求方法（只走代理） =====

    /**
     * 通用请求方法（只走代理）
     * 代理失败时自动切换备用代理重试，每次重试增加指数退避延迟
     */
    async function request(url, timeout = 15000) {
        const maxAttempts = 1 + PROXY_CONFIG.backupUrls.length;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const data = await proxyRequest(url, timeout);
                PROXY_CONFIG.proxyFailCount = 0;
                return data;
            } catch (proxyError) {
                PROXY_CONFIG.proxyFailCount++;
                console.warn(`代理请求失败(第${attempt + 1}次):`, proxyError.message);

                // 指数退避延迟（第1次失败等2秒，第2次等4秒，第3次等8秒...）
                if (attempt < maxAttempts - 1) {
                    const backoffMs = Math.min(2000 * Math.pow(2, attempt), 10000);
                    console.log(`  退避 ${backoffMs}ms 后切换代理重试...`);
                    await new Promise(r => setTimeout(r, backoffMs));
                }

                if (PROXY_CONFIG.proxyFailCount >= PROXY_CONFIG.failThreshold) {
                    switchToNextProxy();
                }
            }
        }
        throw new Error('所有代理均请求失败');
    }

    /**
     * 通过代理发送请求
     * 代理URL格式：{proxyUrl}/proxy?target={encodedTargetUrl}
     */
    async function proxyRequest(targetUrl, timeout = 15000) {
        // 1. 检查是否需要全局退避（代理频繁失败后的冷却）
        const now = Date.now();
        if (proxyBackoffUntil > now) {
            const waitMs = proxyBackoffUntil - now;
            console.log(`代理退避中，等待 ${waitMs}ms...`);
            await new Promise(r => setTimeout(r, waitMs));
        }

        // 2. 强制请求间隔（确保每次请求之间有足够间隔）
        if (lastRequestTime > 0) {
            const elapsed = Date.now() - lastRequestTime;
            // 基础间隔 + 随机抖动（±30%）
            const jitter = Math.floor(requestInterval * 0.3 * (Math.random() - 0.5));
            const minGap = requestInterval + jitter;
            if (elapsed < minGap) {
                const waitMs = minGap - elapsed;
                await new Promise(r => setTimeout(r, waitMs));
            }
        }
        lastRequestTime = Date.now();

        const proxyUrl = getCurrentProxyUrl();
        if (!proxyUrl) throw new Error('无可用代理');

        const base = proxyUrl.replace(/\/+$/, '');
        const fullUrl = base + '/proxy?target=' + encodeURIComponent(targetUrl);

        const headers = { 'Accept': 'application/json' };
        if (PROXY_CONFIG.token) headers['X-Proxy-Token'] = PROXY_CONFIG.token;

        const resp = await fetchWithTimeout(fullUrl, timeout, headers);
        if (!resp.ok) {
            // HTTP 502/503/429：代理端限流或失败，增加全局退避
            if (resp.status === 502 || resp.status === 503 || resp.status === 429) {
                proxyBackoffUntil = Date.now() + 5000; // 全局冷却5秒
            }
            throw new Error(`代理返回HTTP ${resp.status}`);
        }

        const data = await resp.json();
        if (data && data.error && (!data.success || data.success === false)) {
            throw new Error('代理错误: ' + (data.message || data.error));
        }
        return data;
    }

    /** 获取当前代理URL */
    function getCurrentProxyUrl() {
        const idx = PROXY_CONFIG.currentProxyIndex;
        if (idx === -1) return PROXY_CONFIG.primaryUrl;
        if (idx < PROXY_CONFIG.backupUrls.length) return PROXY_CONFIG.backupUrls[idx];
        PROXY_CONFIG.currentProxyIndex = -1;
        return PROXY_CONFIG.primaryUrl;
    }

    /** 切换到下一个代理 */
    function switchToNextProxy() {
        PROXY_CONFIG.proxyFailCount = 0;
        const nextIndex = PROXY_CONFIG.currentProxyIndex + 1;
        if (nextIndex < PROXY_CONFIG.backupUrls.length) {
            PROXY_CONFIG.currentProxyIndex = nextIndex;
            console.log(`切换到备用代理${nextIndex + 1}: ${PROXY_CONFIG.backupUrls[nextIndex]}`);
        } else {
            PROXY_CONFIG.currentProxyIndex = -1;
            console.log('所有代理均已尝试，回到主代理');
        }
    }

    /** 带超时的fetch */
    function fetchWithTimeout(url, timeout, headers = {}) {
        return Promise.race([
            fetch(url, { headers }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时')), timeout))
        ]);
    }

    // ===== 识别结果缓存 =====

    /**
     * 获取缓存的识别结果
     * @returns {Array|null} 缓存的分析结果，过期或不存在返回null
     */
    function getResultCache() {
        try {
            const raw = localStorage.getItem(RESULT_CACHE_KEY);
            if (!raw) return null;

            const cache = JSON.parse(raw);
            const now = Date.now();

            // 检查缓存是否过期
            if (now - cache.timestamp > CACHE_TTL) {
                localStorage.removeItem(RESULT_CACHE_KEY);
                return null;
            }

            // 检查是否同一天（跨天缓存失效）
            const cacheDate = new Date(cache.timestamp).toDateString();
            const today = new Date().toDateString();
            if (cacheDate !== today) {
                localStorage.removeItem(RESULT_CACHE_KEY);
                return null;
            }

            return cache.data;
        } catch (e) {
            return null;
        }
    }

    /**
     * 写入识别结果缓存
     * @param {Array} results - 分析结果数组
     */
    function setResultCache(results) {
        try {
            const cache = {
                data: results,
                timestamp: Date.now()
            };
            localStorage.setItem(RESULT_CACHE_KEY, JSON.stringify(cache));
        } catch (e) {
            console.warn('结果缓存写入失败:', e.message);
        }
    }

    /**
     * 清除所有缓存（K线缓存 + 指数缓存 + LRU索引 + 结果缓存）
     * 点击刷新时调用
     */
    function clearAllCache() {
        try {
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.startsWith(KLINE_CACHE_PREFIX) || key.startsWith(INDEX_CACHE_PREFIX) ||
                    key === RESULT_CACHE_KEY || key === KLINE_INDEX_KEY)) {
                    keysToRemove.push(key);
                }
            }
            keysToRemove.forEach(key => localStorage.removeItem(key));
            klineCacheIndex = null; // 索引已清空，强制下次重载
            console.log('已清除' + keysToRemove.length + '条缓存');
        } catch (e) {
            console.warn('清除缓存失败:', e.message);
        }
    }

    // ===== 当日缓存（涨停池/涨停原因/全A股列表等，跨天自动失效） =====

    /**
     * 读取当日缓存（跨天自动失效）
     * @param {string} key - 缓存key
     * @returns {*} 缓存数据，过期或不存在返回null
     */
    function getDailyCache(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const cache = JSON.parse(raw);
            const cacheDate = new Date(cache.timestamp).toDateString();
            const today = new Date().toDateString();
            if (cacheDate !== today) {
                localStorage.removeItem(key);
                return null;
            }
            return cache.data;
        } catch (e) {
            return null;
        }
    }

    /**
     * 写入当日缓存
     * @param {string} key - 缓存key
     * @param {*} data - 缓存数据（需可JSON序列化）
     */
    function setDailyCache(key, data) {
        try {
            localStorage.setItem(key, JSON.stringify({
                data: data,
                timestamp: Date.now()
            }));
        } catch (e) {
            console.warn('当日缓存写入失败:', key, e.message);
        }
    }

    // ===== K线缓存（LRU + 历史保留 + 跨天增量合并 + 市场N交易日淘汰） =====

    /** 本地日期字符串 YYYY-MM-DD（本地时区） */
    function todayStr() {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    /** 读取缓存配置（含localStorage持久化，惰性加载） */
    function getCacheConfig() {
        if (!cacheConfig) {
            try {
                const saved = localStorage.getItem(CACHE_CONFIG_KEY);
                cacheConfig = saved ? { ...DEFAULT_CACHE_CONFIG, ...JSON.parse(saved) } : { ...DEFAULT_CACHE_CONFIG };
            } catch (e) {
                cacheConfig = { ...DEFAULT_CACHE_CONFIG };
            }
        }
        return { ...cacheConfig };
    }

    /** 更新缓存配置（容量缩小时立即触发LRU淘汰） */
    function setCacheConfig(partial) {
        const cfg = getCacheConfig();
        if (partial.capacity !== undefined) {
            // 下限2（设置页输入框min=50，代码层允许更小值便于测试极端容量）
            cfg.capacity = Math.max(2, Math.min(2000, parseInt(partial.capacity) || DEFAULT_CACHE_CONFIG.capacity));
        }
        if (partial.marketKeepDays !== undefined) {
            cfg.marketKeepDays = Math.max(1, Math.min(30, parseInt(partial.marketKeepDays) || DEFAULT_CACHE_CONFIG.marketKeepDays));
        }
        cacheConfig = cfg;
        try {
            localStorage.setItem(CACHE_CONFIG_KEY, JSON.stringify(cfg));
        } catch (e) {
            console.warn('保存缓存配置失败:', e.message);
        }
        evictKlineCacheLRU();
    }

    /** 加载K线LRU索引（惰性，格式 {secid: {la:最后访问时间戳, ls:最后出现市场日期}}） */
    function loadKlineIndex() {
        if (klineCacheIndex) return klineCacheIndex;
        try {
            const saved = localStorage.getItem(KLINE_INDEX_KEY);
            const parsed = saved ? JSON.parse(saved) : {};
            klineCacheIndex = (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (e) {
            klineCacheIndex = {};
        }
        return klineCacheIndex;
    }

    /** 保存K线LRU索引 */
    function saveKlineIndex() {
        try {
            localStorage.setItem(KLINE_INDEX_KEY, JSON.stringify(klineCacheIndex || {}));
        } catch (e) {
            console.warn('保存K线索引失败:', e.message);
        }
    }

    /**
     * 访问K线缓存时更新LRU索引（记录最后访问时间）
     * 索引数量超出容量时按最久未访问淘汰
     * @param {string} secid - 股票ID
     */
    function touchKlineIndex(secid) {
        const index = loadKlineIndex();
        const entry = index[secid] || {};
        index[secid] = { la: Date.now(), ls: entry.ls || todayStr() };
        evictKlineCacheLRU();
        saveKlineIndex();
    }

    /**
     * LRU容量淘汰：按最后访问时间升序移除最久未访问的股票K线缓存
     */
    function evictKlineCacheLRU() {
        const index = loadKlineIndex();
        const secids = Object.keys(index);
        const capacity = getCacheConfig().capacity;
        if (secids.length <= capacity) return;
        secids.sort((a, b) => (index[a].la || 0) - (index[b].la || 0));
        const removeCount = secids.length - capacity;
        for (let i = 0; i < removeCount; i++) {
            removeKlineCache(secids[i]);
        }
    }

    /**
     * 市场行情候选股票出现时刷新“最后出现日期”（市场N交易日淘汰依据）
     * @param {Array<string>} secids - 候选股票secid数组
     */
    function markKlineSeen(secids) {
        const index = loadKlineIndex();
        const today = todayStr();
        let changed = false;
        (secids || []).forEach(secid => {
            if (index[secid] && index[secid].ls !== today) {
                index[secid].ls = today;
                changed = true;
            }
        });
        if (changed) saveKlineIndex();
        evictStaleMarketStocks();
    }

    /**
     * 市场行情淘汰：连续N个交易日未出现在候选列表的股票移除K线缓存（自选股保护除外）
     * 说明：直接读取自选股存储key判断保护名单，避免与Watchlist模块循环依赖
     */
    function evictStaleMarketStocks() {
        const index = loadKlineIndex();
        const today = todayStr();
        const keepDays = getCacheConfig().marketKeepDays;
        const watchCodes = new Set();
        try {
            const wl = JSON.parse(localStorage.getItem('unusual_watchlist') || '[]');
            if (Array.isArray(wl)) wl.forEach(s => watchCodes.add(s.code));
        } catch (e) { /* 自选数据异常时不做保护判断 */ }

        Object.keys(index).forEach(secid => {
            const code = secid.split('.')[1];
            if (watchCodes.has(code)) return;
            if (businessDaysBetween(index[secid].ls || today, today) >= keepDays) {
                removeKlineCache(secid);
            }
        });
    }

    /**
     * 计算两个日期之间的工作日数量（周一~周五近似交易日，节假日只会让淘汰更保守）
     * @param {string} fromStr - 起始日期 YYYY-MM-DD（不含）
     * @param {string} toStr - 结束日期 YYYY-MM-DD（含）
     * @returns {number} 工作日数量
     */
    function businessDaysBetween(fromStr, toStr) {
        const from = new Date(fromStr + 'T00:00:00');
        const to = new Date(toStr + 'T00:00:00');
        if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) return 0;
        let count = 0;
        const cur = new Date(from);
        cur.setDate(cur.getDate() + 1);
        while (cur <= to) {
            const day = cur.getDay();
            if (day !== 0 && day !== 6) count++;
            cur.setDate(cur.getDate() + 1);
        }
        return count;
    }

    /**
     * 移除单只股票的K线缓存（自选股移除时联动调用，LRU索引一并清理）
     * @param {string} secid - 股票ID（如 '0.000017'）
     */
    function removeKlineCache(secid) {
        try {
            localStorage.removeItem(KLINE_CACHE_PREFIX + secid);
        } catch (e) { /* 忽略 */ }
        const index = loadKlineIndex();
        if (index[secid]) {
            delete index[secid];
            saveKlineIndex();
        }
    }

    /**
     * K线缓存占用统计（股票+指数，供设置页可视化）
     * @returns {Object} {count: 条数, sizeKB: 近似占用KB}
     */
    function getCacheStats() {
        let count = 0;
        let sizeBytes = 0;
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key) continue;
                if (!key.startsWith(KLINE_CACHE_PREFIX) && !key.startsWith(INDEX_CACHE_PREFIX)) continue;
                if (key === KLINE_INDEX_KEY) continue; // LRU索引key不计入缓存条目统计
                count++;
                const val = localStorage.getItem(key) || '';
                sizeBytes += (key.length + val.length) * 2; // UTF-16近似占用
            }
        } catch (e) { /* 忽略 */ }
        return { count: count, sizeKB: Math.round(sizeBytes / 1024) };
    }

    /**
     * 读取K线缓存条目
     * 历史K线长期保留：不再跨天整条失效，跨天由增量合并补新（见fetchKlineCached）
     * @param {string} key - 完整缓存key
     * @returns {Object|null} {data, timestamp, limit, lastFetchDate}
     */
    function readKlineEntry(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const cache = JSON.parse(raw);
            if (!Array.isArray(cache.data)) return null;
            return cache;
        } catch (e) {
            return null;
        }
    }

    /**
     * 写入K线缓存条目（localStorage配额不足时先LRU淘汰一批再重试）
     * @param {string} key - 完整缓存key
     * @param {Array} klines - K线数据（按日期升序）
     * @param {number} limit - 本次请求的K线数量
     */
    function writeKlineEntry(key, klines, limit) {
        const entry = {
            data: klines,
            timestamp: Date.now(),
            limit: limit || 40,
            lastFetchDate: todayStr()
        };
        try {
            localStorage.setItem(key, JSON.stringify(entry));
        } catch (e) {
            // 配额不足：按最久未访问淘汰20%后重试一次
            const index = loadKlineIndex();
            const secids = Object.keys(index).sort((a, b) => (index[a].la || 0) - (index[b].la || 0));
            const removeCount = Math.max(1, Math.ceil(secids.length * 0.2));
            for (let i = 0; i < removeCount && i < secids.length; i++) {
                removeKlineCache(secids[i]);
            }
            try {
                localStorage.setItem(key, JSON.stringify(entry));
            } catch (e2) {
                console.warn('K线缓存写入失败:', e2.message);
            }
        }
    }

    /**
     * 按日期合并两组K线（同日期新数据覆盖旧数据，结果按日期升序）
     * 用于跨天增量合并：保留本地历史 + 补充最新尾部
     * @param {Array} oldKlines - 本地缓存的历史K线
     * @param {Array} newKlines - 新拉取的K线
     * @returns {Array} 合并后的K线数组
     */
    function mergeKlinesByDate(oldKlines, newKlines) {
        const map = new Map();
        (oldKlines || []).forEach(k => map.set(k.date, k));
        (newKlines || []).forEach(k => map.set(k.date, k));
        return Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }

    // ===== 业务API方法 =====

    /**
     * 获取阶段涨幅候选股票（核心优化：减少K线请求量）
     * 策略：分别获取5日涨幅TOP50和当日涨幅TOP50，合并去重
     * @param {number} topN - 每个榜单获取数量
     * @returns {Promise<Array>} 候选股票列表（含5日涨幅）
     */
    async function getCandidateStocks(topN = 50) {
        try {
            // 1. 获取5日涨幅排行 TOP50
            const gain5dUrl = CLIST_BASE +
                '?pn=1&pz=' + topN + '&po=1&np=1' +
                '&ut=' + UT +
                '&fltt=2&invt=2' +
                '&fid=f127' +  // 按5日涨幅排序
                '&fs=' + FS_A_SHARE +
                '&fields=f12,f14,f2,f3,f13,f127' +
                '&_t=' + Date.now();

            // 2. 获取当日涨幅排行 TOP50
            const todayUrl = CLIST_BASE +
                '?pn=1&pz=' + topN + '&po=1&np=1' +
                '&ut=' + UT +
                '&fltt=2&invt=2' +
                '&fid=f3' +  // 按当日涨幅排序
                '&fs=' + FS_A_SHARE +
                '&fields=f12,f14,f2,f3,f13,f127' +
                '&_t=' + Date.now();

            // 并行请求两个榜单
            const [gain5dData, todayData] = await Promise.all([
                request(gain5dUrl).catch(e => {
                    console.warn('5日涨幅排行请求失败:', e.message);
                    return null;
                }),
                request(todayUrl).catch(e => {
                    console.warn('当日涨幅排行请求失败:', e.message);
                    return null;
                })
            ]);

            // 合并去重
            const stockMap = new Map();

            // 处理5日涨幅排行
            if (gain5dData && gain5dData.data && gain5dData.data.diff) {
                gain5dData.data.diff.forEach((item, index) => {
                    const code = item.f12;
                    const gain5d = parseFloat(item.f127) || 0;
                    // 5日涨幅>15%的进入候选（放宽门槛：部分股票如莱伯泰科等涨幅较低但已接近异动线）
                    if (gain5d >= 15 && !stockMap.has(code)) {
                        stockMap.set(code, {
                            code: code,
                            name: item.f14,
                            price: parseFloat(item.f2) || 0,
                            changePercent: parseFloat(item.f3) || 0,
                            market: item.f13,
                            secid: item.f13 + '.' + code,
                            gain5d: gain5d,
                            source: '5日涨幅榜'
                        });
                    }
                });
            }

            // 处理当日涨幅排行
            if (todayData && todayData.data && todayData.data.diff) {
                todayData.data.diff.forEach((item, index) => {
                    const code = item.f12;
                    const changePct = parseFloat(item.f3) || 0;
                    const gain5d = parseFloat(item.f127) || 0;
                    // 当日涨幅>3%的也加入候选（覆盖低涨幅但已接近异动线的股票如莱伯泰科）
                if (changePct >= 3 && !stockMap.has(code)) {
                        stockMap.set(code, {
                            code: code,
                            name: item.f14,
                            price: parseFloat(item.f2) || 0,
                            changePercent: changePct,
                            market: item.f13,
                            secid: item.f13 + '.' + code,
                            gain5d: gain5d,
                            source: '当日涨幅榜'
                        });
                    }
                });
            }

            if (stockMap.size === 0) {
                console.warn('未获取到候选股票');
                return [];
            }

            const result = Array.from(stockMap.values());
            console.log(`获取候选股票: ${result.length}只（5日涨幅榜+当日涨幅榜合并去重）`);
            // 刷新候选股票“最后出现日期”（市场行情N交易日淘汰的判断依据）
            markKlineSeen(result.map(s => s.secid));
            return result;

        } catch (error) {
            console.error('获取候选股票失败:', error.message);
            throw error;
        }
    }

    // ===== 多平台K线请求（东方财富 + 腾讯，平台轮询分散请求量避免单平台限流） =====
    const KLINE_PLATFORMS = ['eastmoney', 'tencent'];
    let platformCursor = 0;

    /** 轮询取下一个K线平台（请求量在平台间均匀分布） */
    function nextKlinePlatform() {
        const platform = KLINE_PLATFORMS[platformCursor % KLINE_PLATFORMS.length];
        platformCursor++;
        return platform;
    }

    /** 构建东方财富K线请求URL */
    function buildEastmoneyKlineUrl(secid, limit) {
        return KLINE_BASE +
            '?secid=' + secid +
            '&ut=' + UT +
            '&fields1=f1,f2,f3,f4,f5,f6' +
            '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
            '&klt=101' +
            '&fqt=1' +
            '&end=20500101' +
            '&lmt=' + limit +
            '&_t=' + Date.now();
    }

    /** secid转腾讯代码（0=深市sz，1=沪市sh，股票与指数通用） */
    function tencentSymbolFromSecid(secid) {
        const idx = secid.indexOf('.');
        const market = secid.substring(0, idx);
        const code = secid.substring(idx + 1);
        return (market === '1' ? 'sh' : 'sz') + code;
    }

    /** 构建腾讯前复权日K请求URL */
    function buildTencentKlineUrl(secid, limit) {
        return 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' +
            tencentSymbolFromSecid(secid) + ',day,,,' + limit + ',qfq&_t=' + Date.now();
    }

    /** 映射K线数据为统一格式（东方财富） */
    function mapKlineData(data) {
        return data.data.klines.map(line => {
            const parts = line.split(',');
            return {
                date: parts[0],
                open: parseFloat(parts[1]),
                close: parseFloat(parts[2]),
                high: parseFloat(parts[3]),
                low: parseFloat(parts[4]),
                volume: parseFloat(parts[5]),
                amount: parseFloat(parts[6]),
                amplitude: parseFloat(parts[7]),
                changePercent: parseFloat(parts[8]),
                changeAmount: parseFloat(parts[9]),
                turnover: parseFloat(parts[10])
            };
        });
    }

    /**
     * 将腾讯K线数据映射为统一格式
     * 接口：web.ifzq.gtimg.cn/appstock/app/fqkline/get
     * 返回结构：{code:0, data:{sz000017:{qfqday:[[日期,开,收,高,低,量],...]}}}
     * 无复权数据时节点为day；涨跌幅由前收盘推导（腾讯日线不含成交额/换手率）
     * @param {Object} data - 接口原始响应
     * @param {string} secid - 股票ID（用于定位腾讯代码）
     * @returns {Array} 统一格式K线数组
     */
    function mapTencentKlineData(data, secid) {
        const sym = tencentSymbolFromSecid(secid);
        const node = data && data.data && data.data[sym];
        const arr = node && (node.qfqday || node.day);
        if (!Array.isArray(arr) || arr.length === 0) {
            throw new Error('腾讯K线数据为空');
        }
        const result = [];
        let prevClose = null;
        arr.forEach(item => {
            const close = parseFloat(item[2]);
            result.push({
                date: item[0],
                open: parseFloat(item[1]),
                close: close,
                high: parseFloat(item[3]),
                low: parseFloat(item[4]),
                volume: parseFloat(item[5]),
                amount: null,                                    // 腾讯日线不含成交额
                amplitude: null,
                changePercent: prevClose !== null ? (close - prevClose) / prevClose * 100 : null,
                changeAmount: prevClose !== null ? close - prevClose : null,
                turnover: null
            });
            prevClose = close;
        });
        return result;
    }

    /**
     * 从指定平台拉取K线（失败抛异常，由调用方切换平台重试）
     * @param {string} secid - 股票/指数ID
     * @param {number} limit - K线数量
     * @param {string} platform - 平台名 eastmoney|tencent
     * @returns {Promise<Array>} 统一格式K线数组
     */
    async function fetchKlineFromPlatform(secid, limit, platform) {
        const url = platform === 'tencent' ? buildTencentKlineUrl(secid, limit) : buildEastmoneyKlineUrl(secid, limit);
        const data = await request(url);
        if (platform === 'tencent') {
            return mapTencentKlineData(data, secid);
        }
        if (!data || !data.data || !data.data.klines) {
            return [];
        }
        return mapKlineData(data);
    }

    /**
     * 带缓存的K线获取（历史K线本地长期保留，跨天只增量补拉尾部）
     * 主流程：
     * 1. 缓存当日已拉取且条数覆盖需求 → 直接返回（零请求）
     * 2. 有缓存但过期/跨天/条数不足 → 增量拉取（少量K线）按日期合并，同日新数据覆盖旧数据
     * 3. 无缓存 → 平台轮询全量拉取，失败自动切换另一平台
     * @param {string} cacheKey - 完整缓存key（含前缀）
     * @param {string} secid - 股票/指数ID
     * @param {number} limit - 需要的K线数量
     * @param {boolean} useLRU - 是否纳入股票K线LRU索引（指数不纳入）
     * @returns {Promise<Array>} K线数据数组
     */
    async function fetchKlineCached(cacheKey, secid, limit, useLRU) {
        const entry = readKlineEntry(cacheKey);
        const today = todayStr();

        if (entry) {
            if (useLRU) touchKlineIndex(secid);
            const data = entry.data;
            // 覆盖判断：请求limit已满足，或实际条数已达缓存时请求limit（新股/停牌已取到全部数据）
            const coversLimit = !limit || entry.limit >= limit || data.length >= limit;
            const isFresh = entry.lastFetchDate === today && (Date.now() - entry.timestamp) < CACHE_TTL;
            if (isFresh && coversLimit) {
                return data;
            }

            // 增量补拉：历史条数足够时只拉尾部少量，不足时按需求limit拉
            const incLimit = data.length >= limit ? Math.min(limit, 15) : limit;
            try {
                const fresh = await fetchKlineFromPlatform(secid, incLimit, nextKlinePlatform());
                const merged = fresh.length > 0 ? mergeKlinesByDate(data, fresh) : data;
                writeKlineEntry(cacheKey, merged, Math.max(entry.limit || 0, limit));
                return merged;
            } catch (e) {
                console.warn('K线增量更新失败(' + secid + '):', e.message);
                // 增量失败但缓存条数够用 → 降级返回旧数据（优先保证可用）
                if (coversLimit) return data;
                // 条数不够 → 走下方全量平台轮询
            }
        }

        // 全量请求：平台轮询 + 失败自动切换另一平台
        const first = nextKlinePlatform();
        const second = first === 'eastmoney' ? 'tencent' : 'eastmoney';
        let lastError = null;
        for (const platform of [first, second]) {
            try {
                const klines = await fetchKlineFromPlatform(secid, limit, platform);
                writeKlineEntry(cacheKey, klines, limit);
                if (useLRU) touchKlineIndex(secid);
                return klines;
            } catch (e) {
                lastError = e;
                console.warn('从' + platform + '获取K线失败(' + secid + '):', e.message);
            }
        }
        console.warn('获取K线失败(所有平台):', secid, lastError && lastError.message);
        return [];
    }

    /**
     * 获取个股日K线数据（前复权），带localStorage缓存（LRU+增量合并，多平台轮询）
     * @param {string} secid - 股票ID (格式: 市场编号.股票代码)
     * @param {number} limit - 获取K线数量
     * @returns {Promise<Array>} K线数据数组
     */
    async function getStockKline(secid, limit = 40) {
        return fetchKlineCached(KLINE_CACHE_PREFIX + secid, secid, limit, true);
    }

    /**
     * 批量获取K线数据（逐个请求+间隔，平台轮询分散请求量避免单平台限流）
     * 失败重扫：第一轮获取失败的股票再重试一轮（换平台组合），优先保证导入数据完整性
     * @param {Array} secids - 股票ID数组
     * @param {number} concurrency - 并发数（保留参数，实际逐个请求更稳定）
     * @param {Function} onProgress - 进度回调 (completed, total)
     * @param {number} limit - 每只股票获取的K线数量（默认40，自选浏览视图需260计算今年来涨幅）
     * @returns {Promise<Map>} secid -> klines 映射
     */
    async function batchGetKline(secids, concurrency = 2, onProgress = null, limit = 40) {
        const result = new Map();
        const total = secids.length;
        const failed = [];
        let completed = 0;

        // 第一轮：逐个请求（间隔由proxyRequest统一控制）
        for (let i = 0; i < total; i++) {
            try {
                const klines = await getStockKline(secids[i], limit);
                result.set(secids[i], klines);
                if (klines.length === 0) failed.push(secids[i]);
            } catch (e) {
                console.warn('获取K线失败:', secids[i], e.message);
                result.set(secids[i], []);
                failed.push(secids[i]);
            }
            completed++;
            if (onProgress) onProgress(completed, total);
        }

        // 失败重扫：换平台组合再试一轮
        if (failed.length > 0) {
            console.log('K线失败重扫: ' + failed.length + '只（' + failed.join(',') + '）');
            for (const secid of failed) {
                try {
                    const klines = await getStockKline(secid, limit);
                    if (klines.length > 0) {
                        result.set(secid, klines);
                    }
                } catch (e) {
                    console.warn('K线重扫仍失败:', secid, e.message);
                }
            }
        }

        return result;
    }

    // ===== 自选股相关API =====

    /** 数值安全转换（东财接口停牌/无数据时返回'-'） */
    function toNum(v) {
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
    }

    /**
     * 批量获取实时行情（东方财富ulist.np接口）
     * @param {Array<string>} secids - 股票secid数组（如 ['0.000017', '1.600371']），自动按50个分批
     * @returns {Promise<Map>} code -> 行情对象 映射
     *   行情对象: { code, name, price, changePercent, amount, turnover, volumeRatio,
     *              open, prevClose, totalMV, floatMV, mainNet }
     */
    async function getQuoteBatch(secids) {
        const result = new Map();
        if (!secids || secids.length === 0) return result;

        // 分批请求（每批最多50个，避免URL过长）
        const CHUNK_SIZE = 50;
        for (let i = 0; i < secids.length; i += CHUNK_SIZE) {
            const chunk = secids.slice(i, i + CHUNK_SIZE);
            const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get' +
                '?fltt=2&invt=2' +
                '&fields=f2,f3,f6,f8,f10,f12,f13,f14,f17,f18,f20,f21,f62' +
                '&secids=' + chunk.join(',') +
                '&_t=' + Date.now();

            try {
                const data = await request(url);
                const diff = data && data.data && data.data.diff;
                if (!diff) continue;

                diff.forEach(item => {
                    const code = String(item.f12);
                    result.set(code, {
                        code: code,
                        name: item.f14,
                        price: toNum(item.f2),               // 最新价
                        changePercent: toNum(item.f3),       // 涨跌幅%
                        amount: toNum(item.f6),              // 成交额(元)
                        turnover: toNum(item.f8),            // 换手率%
                        volumeRatio: toNum(item.f10),        // 量比
                        open: toNum(item.f17),               // 今开
                        prevClose: toNum(item.f18),          // 昨收
                        totalMV: toNum(item.f20),            // 总市值(元)
                        floatMV: toNum(item.f21),            // 流通市值(元)
                        mainNet: toNum(item.f62)             // 主力净额(元)
                    });
                });
            } catch (error) {
                console.warn('批量行情请求失败(批次' + (i / CHUNK_SIZE + 1) + '):', error.message);
            }
        }
        return result;
    }

    /**
     * 获取指定日期涨停池（东方财富push2ex接口，当日缓存）
     * @param {string} dateStr - 日期 YYYYMMDD
     * @returns {Promise<Map>} code -> { code, name, fbt, lbt, lbc, zbc, zttj, hybk }
     *   fbt:首次封板时间(HHMMSS数字) lbt:最后封板时间 lbc:连板数 zbc:炸板次数
     *   zttj:{days,ct}涨停统计(几天几板) hybk:所属行业
     */
    async function getZTPool(dateStr) {
        const cacheKey = 'unusual_ztpool_' + dateStr;
        const cached = getDailyCache(cacheKey);
        if (cached) {
            return new Map(cached.map(item => [item.code, item]));
        }

        const url = ZTPOOL_BASE +
            '?ut=7eea3edcaed734bea9cbfc24409ed989' +
            '&dpt=wz.ztzt' +
            '&Pageindex=0&Pagesize=1000' +
            '&sort=fbt%3Aasc' +
            '&date=' + dateStr +
            '&_=' + Date.now();

        const data = await request(url);
        const list = [];
        if (data && data.data && data.data.pool) {
            data.data.pool.forEach(item => {
                list.push({
                    code: String(item.c),
                    name: item.n,
                    fbt: item.fbt,
                    lbt: item.lbt,
                    lbc: item.lbc,
                    zbc: item.zbc,
                    zttj: item.zttj,
                    hybk: item.hybk
                });
            });
        }
        setDailyCache(cacheKey, list);
        return new Map(list.map(item => [item.code, item]));
    }

    /**
     * 获取指定日期涨停原因（同花顺dataapi接口，当日缓存，失败降级返回空Map）
     * 注：东财涨停池无涨停原因字段，此接口走代理访问同花顺，可能因反爬失败
     * @param {string} dateStr - 日期 YYYYMMDD
     * @returns {Promise<Map>} code -> { code, name, reason, firstTime }
     */
    async function getTHSZTReason(dateStr) {
        const cacheKey = 'unusual_ths_zt_' + dateStr;
        const cached = getDailyCache(cacheKey);
        if (cached) {
            return new Map(cached.map(item => [item.code, item]));
        }

        const url = THS_ZTPOOL_BASE +
            '?page=1&limit=300' +
            '&order=turnaround&sort=desc' +
            '&date=' + dateStr +
            '&_=' + Date.now();

        const list = [];
        try {
            const data = await request(url);
            // 同花顺返回格式兼容：{data:{info:[...]}} 或 {data:{list:[...]}}
            const info = data && data.data && (data.data.info || data.data.list);
            if (Array.isArray(info)) {
                info.forEach(item => {
                    list.push({
                        code: String(item.code || ''),
                        name: item.name || '',
                        reason: item.reason_type || item.reason || '',
                        firstTime: item.first_limit_up_time || ''
                    });
                });
            }
            setDailyCache(cacheKey, list);
        } catch (error) {
            // 失败不缓存（避免瞬时故障影响全天），降级返回空
            console.warn('同花顺涨停原因获取失败(降级显示--):', error.message);
        }
        return new Map(list.map(item => [item.code, item]));
    }

    /**
     * 获取全A股列表（用于自选股搜索，含北交所，当日缓存）
     * @param {Function} onProgress - 进度回调 (loadedPages)
     * @returns {Promise<Array>} [{code, market, name}]
     */
    async function getAllStockList(onProgress) {
        const cacheKey = 'unusual_all_stocks';
        const cached = getDailyCache(cacheKey);
        if (cached && cached.length > 0) return cached;

        const result = [];
        const pageSize = 500;
        const maxPages = 20; // 500*20=10000，覆盖全A股足够

        for (let page = 1; page <= maxPages; page++) {
            const url = CLIST_BASE +
                '?pn=' + page + '&pz=' + pageSize + '&po=0&np=1' +
                '&ut=' + UT +
                '&fltt=2&invt=2' +
                '&fid=f12' +
                '&fs=' + encodeURIComponent(FS_ALL_SHARE) +
                '&fields=f12,f13,f14' +
                '&_t=' + Date.now();

            const data = await request(url);
            const diff = data && data.data && data.data.diff;
            if (!diff || diff.length === 0) break;

            diff.forEach(item => {
                if (item.f12 !== undefined && item.f13 !== undefined) {
                    result.push({
                        code: String(item.f12),
                        market: item.f13,
                        name: item.f14 || ''
                    });
                }
            });

            if (onProgress) onProgress(page);
            if (diff.length < pageSize) break; // 最后一页
        }

        if (result.length > 0) {
            setDailyCache(cacheKey, result);
            console.log('全A股列表加载完成:', result.length + '只');
        }
        return result;
    }

    /**
     * 仅清除K线缓存（股票+指数+LRU索引，自选股强制刷新/设置页手动清理时使用，不影响结果缓存）
     */
    function clearKlineCache() {
        try {
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.startsWith(KLINE_CACHE_PREFIX) || key.startsWith(INDEX_CACHE_PREFIX) ||
                    key === KLINE_INDEX_KEY)) {
                    keysToRemove.push(key);
                }
            }
            keysToRemove.forEach(key => localStorage.removeItem(key));
            klineCacheIndex = null; // 索引已清空，强制下次重载
            console.log('已清除' + keysToRemove.length + '条K线缓存');
        } catch (e) {
            console.warn('清除K线缓存失败:', e.message);
        }
    }

    // ===== 基准指数配置 =====
    // 不同板块对应的基准指数secid（东方财富格式：市场编号.指数代码）
    const INDEX_MAP = {
        'sh_main': '1.000002',   // 沪市主板 → 上证A股指数
        'sz_main': '0.399107',   // 深市主板 → 深证A指
        'cyb':     '0.399102',   // 创业板 → 创业板综合指数
        'kcb':     '1.000688'    // 科创板 → 科创50指数
    };

    // 指数K线缓存前缀已统一定义于文件头部（INDEX_CACHE_PREFIX）

    /**
     * 根据股票代码判断对应的基准指数secid
     * @param {string} code - 股票代码
     * @returns {string} 基准指数secid
     */
    function getBenchmarkIndexSecid(code) {
        if (!code) return INDEX_MAP['sz_main'];
        // 创业板：30开头
        if (code.startsWith('30')) return INDEX_MAP['cyb'];
        // 科创板：68开头
        if (code.startsWith('68')) return INDEX_MAP['kcb'];
        // 北证：8/4/92开头（92为北证2024年新增代码段，暂用上证A股指数）
        if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) return INDEX_MAP['sh_main'];
        // 沪市主板：60开头
        if (code.startsWith('60')) return INDEX_MAP['sh_main'];
        // 深市主板：00开头
        if (code.startsWith('00')) return INDEX_MAP['sz_main'];
        // 默认深证A指
        return INDEX_MAP['sz_main'];
    }

    /**
     * 获取基准指数日K线数据（前复权），带localStorage缓存（与股票K线共用增量合并管线，不纳入LRU索引）
     * @param {string} secid - 指数secid (如 '0.399107')
     * @param {number} limit - 获取K线数量
     * @returns {Promise<Array>} K线数据数组
     */
    async function getIndexKline(secid, limit = 40) {
        return fetchKlineCached(INDEX_CACHE_PREFIX + secid, secid, limit, false);
    }

    /**
     * 批量获取所有需要的基准指数K线数据
     * 根据候选股票列表自动识别需要哪些指数
     * @param {Array} stocks - 候选股票列表
     * @param {number} limit - K线数量
     * @returns {Promise<Map>} secid -> klines 映射（指数K线）
     */
    async function getBenchmarkIndices(stocks, limit = 40) {
        // 收集所有需要的指数secid
        const indexSecids = new Set();
        stocks.forEach(stock => {
            indexSecids.add(getBenchmarkIndexSecid(stock.code));
        });

        console.log('需要获取基准指数:', Array.from(indexSecids).join(', '));

        const indexMap = new Map();
        for (const secid of indexSecids) {
            try {
                const klines = await getIndexKline(secid, limit);
                indexMap.set(secid, klines);
                // 注意：请求间隔已在 proxyRequest 中统一控制
            } catch (e) {
                console.warn('获取指数K线失败:', secid, e.message);
                indexMap.set(secid, []);
            }
        }

        return indexMap;
    }

    /** 获取当前请求模式描述 */
    function getRequestMode() {
        const idx = PROXY_CONFIG.currentProxyIndex;
        if (idx === -1) return '代理(主)';
        return `代理(备用${idx + 1})`;
    }

    /** 获取请求间隔(ms) */
    function getRequestInterval() {
        return requestInterval;
    }

    /** 设置请求间隔(ms) */
    function setRequestInterval(ms) {
        requestInterval = Math.max(500, Math.min(10000, parseInt(ms) || 2000));
    }

    // 初始化时加载代理配置
    loadProxyConfig();

    return {
        getCandidateStocks,
        getStockKline,
        batchGetKline,
        getIndexKline,
        getBenchmarkIndices,
        getBenchmarkIndexSecid,
        getRequestMode,
        getRequestInterval,
        setRequestInterval,
        getProxyConfig,
        setProxyConfig,
        clearAllCache,
        clearKlineCache,
        getResultCache,
        setResultCache,
        // ===== K线缓存管理（LRU/统计/配置） =====
        getCacheConfig,
        setCacheConfig,
        getCacheStats,
        removeKlineCache,
        // ===== 自选股相关 =====
        getQuoteBatch,
        getZTPool,
        getTHSZTReason,
        getAllStockList,
        // ===== 内部纯函数（仅供Node测试使用，业务代码勿调用） =====
        _internals: {
            mergeKlinesByDate,
            mapTencentKlineData,
            tencentSymbolFromSecid,
            businessDaysBetween,
            evictStaleMarketStocks,
            todayStr,
            /** 重置平台轮询游标（测试用，保证平台顺序确定） */
            resetPlatformCursor: () => { platformCursor = 0; },
            /** 重置内存中的LRU索引与缓存配置，强制从localStorage重新加载（测试用） */
            resetCacheState: () => { klineCacheIndex = null; cacheConfig = null; }
        }
    };
})();
