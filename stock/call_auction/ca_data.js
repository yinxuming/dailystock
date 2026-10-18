/**
 * 集合竞价数据层（CAData）
 *
 * 职责：
 * 1. 解析「目标交易日 / 基准交易日」——集合竞价页永远展示"最近一次已完成集合竞价的交易日"
 * 2. 解析分析范围：昨日涨停股 / 全部自选 / 指定自选分组
 * 3. 采集昨日指标：昨日成交额、昨日成交量、昨日换手率、流通市值、连板数、封板时间等
 * 4. 采集今日集合竞价：9:25 撮合价、竞价量、竞价金额
 * 5. 每日缓存（localStorage），避免同一天重复请求
 *
 * 数据来源（已按 review 反馈优化）：
 * - 昨日涨停池 / 炸板池：直接复用「每日复盘」模块落盘的缓存
 *   data/fupan/days/YYYYMMDD.json 中的 ztpool / zbpool（由 fupan 后端采集，免代理、最可靠）。
 *   仅当缓存缺失时，才回退到东方财富 push2ex(getTopicZTPool) 实时拉取。
 * - 集合竞价撮合：东方财富 push2his trends2（首根 09:30 = 9:25 撮合单一价，与参考实现一致），
 *   腾讯 ifzq minute/query 作为兜底数据源。
 * - 自选股的昨日指标：东方财富 K线（走 StockAPI.batchGetKline，复用LRU缓存）
 */
const CAData = (function () {
    'use strict';

    // ===== 缓存键前缀 =====
    const CACHE_POOL = 'ca_ztpool_';        // + YYYYMMDD
    const CACHE_AUC = 'ca_auction_';        // + YYYY-MM-DD

    // 竞价撮合快照窗口（该时间段内 买一/卖一 即 9:25 撮合后的未匹配残量）
    const WINDOW_START = 9 * 60 + 15;       // 09:15
    const WINDOW_END = 9 * 60 + 31;         // 09:31

    // 腾讯行情数组下标（qt 数组为定长文本，索引即字段位置）
    const TQ = {
        NAME: 1, CODE: 2, PRICE: 3, PRE_CLOSE: 4, OPEN: 5, VOL: 6,
        BID1: 9, BID1_VOL: 10, ASK1: 19, ASK1_VOL: 20, TIME: 30,
        AMOUNT_WAN: 37, TURNOVER: 38, FLOAT_MV_YI: 44, TOTAL_MV_YI: 45,
        LIMIT_UP: 47, LIMIT_DOWN: 48, VOL_RATIO: 49
    };

    // ===== 基础工具 =====

    /** 日期 → YYYYMMDD */
    function toYmd(dateStr) {
        return String(dateStr || '').replace(/-/g, '');
    }

    /** Date → YYYY-MM-DD */
    function fmtDate(d) {
        return TradingCalendar.formatDate(d);
    }

    /** 当前是否处于竞价快照窗口（09:15-09:31） */
    function isAuctionWindow() {
        const now = new Date();
        const mins = now.getHours() * 60 + now.getMinutes();
        return mins >= WINDOW_START && mins <= WINDOW_END;
    }

    /** 数值容错 */
    function num(v) {
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
    }

    /** 由代码前缀推断市场：1=沪(6/9/5) 0=深/北(其余) */
    function marketOf(code) {
        const c = String(code || '');
        if (c[0] === '6' || c[0] === '9' || c[0] === '5') return 1;
        return 0;
    }

    /**
     * 涨停/跌停幅度（按代码/名称推断）
     * 主板10%、创业板(30)/科创板(688)20%、北交所(8/4开头)30%、主板ST 5%、创业板ST 20%
     */
    function limitPctOf(code, name) {
        const c = String(code || '');
        const isST = /ST/i.test(String(name || ''));
        if (c.startsWith('30') || c.startsWith('688')) return 0.20;
        if (c.startsWith('8') || c.startsWith('4') || c.startsWith('92')) return 0.30;
        if (isST) return 0.05;
        return 0.10;
    }

    /** 腾讯代码：0=深/北 → sz，1=沪 → sh */
    function tencentSymbol(code, market) {
        const c = String(code || '');
        const m = Number(market);
        if (m === 1) return 'sh' + c;
        if (m === 0) return (c.startsWith('8') || c.startsWith('4') || c.startsWith('92')) ? 'bj' + c : 'sz' + c;
        // 无市场信息时按代码前缀推断
        if (c.startsWith('6') || c.startsWith('9') || c.startsWith('5')) return 'sh' + c;
        if (c.startsWith('8') || c.startsWith('4')) return 'bj' + c;
        return 'sz' + c;
    }

    /**
     * 封板时间归一化：兼容 "09:25:00" / "09:2500" / 92500(数字) → HHMMSS 整数
     * 评级引擎 fbtMinutes/fbtText 依赖 HHMMSS 数值。
     */
    function normalizeFbt(v) {
        if (v == null) return null;
        if (typeof v === 'number') return v;
        const s = String(v).replace(/[^\d]/g, '');
        if (s.length >= 6) return parseInt(s.slice(0, 6), 10);
        if (s.length >= 4) return parseInt(s.slice(0, 4), 10);
        return null;
    }

    /**
     * 解析目标交易日与基准交易日
     * 目标日 = 最近一次已完成集合竞价的交易日（交易日 9:25 之后取当天，否则往前取）；
     *         若传入 dateStr（TODO38.3 历史日期选择），则直接以该日期为目标交易日。
     * 基准日 = 目标日的前一交易日（用于昨日涨停池与昨日指标）
     * @param {string} [dateStr] 指定目标交易日 YYYY-MM-DD（留空=自动取最近已完成竞价日）
     * @returns {{target:string, base:string, isToday:boolean, live:boolean}}
     */
    function resolveDates(dateStr) {
        const now = new Date();
        const today = fmtDate(now);
        const mins = now.getHours() * 60 + now.getMinutes();
        const isTradingToday = TradingCalendar.isTradingDay(now);
        // 交易日 09:25 之后，今日集合竞价已完成
        const todayReady = isTradingToday && mins >= (9 * 60 + 25);

        let target;
        if (dateStr) {
            // TODO38.3：指定历史（或当日）日期，直接作为目标交易日（实时接口仅"今天且已完成竞价"时有意义）
            target = String(dateStr).slice(0, 10);
        } else if (todayReady) {
            target = today;
        } else if (isTradingToday) {
            target = TradingCalendar.getPreviousTradeDate(now, 1) || today;
        } else {
            target = TradingCalendar.getLatestTradeDate();
        }

        const base = TradingCalendar.getPreviousTradeDate(new Date(target + 'T00:00:00'), 1) || target;
        const isToday = target === today;

        return {
            target: target,
            base: base,
            isToday: isToday,
            // 仅在"今天是交易日且竞价已完成"时走实时接口；历史日期/自动回退日均不实时
            live: isToday && todayReady
        };
    }

    // ===== 竞价缓存文件（TODO38.3 后端定时采集落地） =====

    /** 同源/直连 GET JSON（8s 超时；失败抛错由调用方尝试下一个路径） */
    async function fetchJson(url, timeout = 8000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const resp = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return await resp.json();
        } finally {
            clearTimeout(timer);
        }
    }

    // 后端定时采集落盘的竞价缓存线上镜像基址（本地 data/call_auction 缺失时兜底，同源直连无需代理）
    // 可由 localStorage 'ca_remote_base' 覆盖（便于切换镜像或私有部署）
    function caRemoteBase() {
        try {
            const v = localStorage.getItem('ca_remote_base');
            if (v) return v.replace(/\/+$/, '') + '/';
        } catch (e) { /* 忽略 */ }
        return 'https://yinxuming.github.io/dailystock/stock/data/call_auction/';
    }

    /**
     * 读取指定目标交易日的竞价缓存文件（后端定时采集产出）。
     * GitHub Pages 静态 JSON 与页面同源、无需代理：依次直连
     *   stock/data/call_auction/days/YYYYMMDD.json（GitHub Pages 部署路径）
     *   → data/call_auction/days/YYYYMMDD.json（本地服务器根=stock_analysis）
     *   → 线上镜像绝对地址直连；
     * 全部失败才回退代理兜底（实测主代理 vercel 在部分网络下 42s 超时不可达，静态文件不应走代理）。
     * @param {string} target YYYY-MM-DD
     * @returns {Promise<Object|null>} {date, stocks:{code:{auction,live,series}}} 或 null
     */
    async function fetchAuctionCacheFile(target) {
        const ymd = toYmd(target);
        const candidates = [
            'stock/data/call_auction/days/' + ymd + '.json',
            'data/call_auction/days/' + ymd + '.json',
            caRemoteBase() + 'days/' + ymd + '.json'
        ];
        for (const url of candidates) {
            try {
                return await fetchJson(url);
            } catch (e) { /* 尝试下一个路径 */ }
        }
        // 兜底：代理（静态文件同源一般直连可达，代理仅在特殊网络环境生效）
        try {
            return await StockAPI.request(caRemoteBase() + 'days/' + ymd + '.json');
        } catch (remoteErr) {
            console.warn('竞价缓存文件缺失（本地与线上均无）:', target);
            return null;
        }
    }

    /**
     * 将后端缓存文件中的单只股票归一化为与实时解析一致的形状 {date,stale,auction,live,series}
     * 后端 JSON 字段约定：{auction:{price,vol,amt,time,unmatchedVol,unmatchedAmt},
     *                     live:{price,preClose,open,vol,amount,turnover,volRatio,floatMV,totalMV,limitUp,limitDown,snapshotTime},
     *                     series:[{t,price,vol,bid1,bid1vol,ask1,ask1vol}]}
     */
    function normalizeFileStock(s, target) {
        const auc = s.auction || {};
        const live = s.live || {};
        return {
            date: target,
            stale: false,
            auction: {
                price: num(auc.price), vol: num(auc.vol), amt: num(auc.amt),
                time: auc.time || '09:25:00',
                unmatchedVol: num(auc.unmatchedVol),
                unmatchedAmt: num(auc.unmatchedAmt)
            },
            live: {
                price: num(live.price), preClose: num(live.preClose), open: num(live.open),
                vol: num(live.vol), amount: num(live.amount), turnover: num(live.turnover),
                volRatio: num(live.volRatio), floatMV: num(live.floatMV), totalMV: num(live.totalMV),
                limitUp: num(live.limitUp), limitDown: num(live.limitDown),
                snapshotTime: live.snapshotTime || ''
            },
            series: Array.isArray(s.series) ? s.series : null
        };
    }

    /**
     * 合成竞价初始缓存（优先级：后端缓存文件 → 本地 localStorage 当日缓存）
     * 历史日期的缺失代码不再走实时接口（实时接口只返回最新交易日，会错位）。
     * @param {string} target YYYY-MM-DD
     * @param {boolean} force 强制刷新时忽略 localStorage 缓存
     * @returns {Promise<Object>} {code: {date,stale,auction,live,series}}
     */
    async function buildStartCache(target, force) {
        const cache = {};
        // 1) 后端定时采集文件（含 9:25 残量 + 竞价期间采样序列，最权威）
        try {
            const file = await fetchAuctionCacheFile(target);
            if (file && file.stocks) {
                Object.keys(file.stocks).forEach(code => {
                    cache[code] = normalizeFileStock(file.stocks[code], target);
                });
            }
        } catch (e) { /* 无缓存文件时留空，后续走实时或标记无数据 */ }

        // 2) 本地 localStorage 当日缓存（浏览器运行时采的，含实时列）
        if (!force) {
            const ls = readCache(CACHE_AUC + target) || {};
            Object.keys(ls).forEach(code => { if (!cache[code]) cache[code] = ls[code]; });
        }
        return cache;
    }

    // ===== 缓存 =====

    function readCache(key) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function writeCache(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.warn('集合竞价缓存写入失败:', e.message);
        }
    }

    // ===== 昨日涨停池 =====

    /**
     * 拉取指定基准交易日的涨停池。
     * 优先复用每日复盘落盘的缓存（data/fupan/days/YYYYMMDD.json → ztpool/zbpool），
     * 缓存缺失时回退到东方财富 push2ex 实时拉取。
     * @param {string} dateStr - YYYY-MM-DD（基准交易日）
     * @returns {Promise<{pool:Array, zbCount:number, source:string}>}
     *   pool 元素统一为 {code,name,market,price,amount,turnover,floatMV,lbCount,openCount,firstSealTime,sealFund,industry}
     */
    async function fetchZTPool(dateStr) {
        // 1) 复用每日复盘缓存（免代理、最可靠）
        try {
            if (typeof FupanData !== 'undefined' && FupanData.getDay) {
                const day = await FupanData.getDay(dateStr);
                if (day && day.ztpool && day.ztpool.length) {
                    return {
                        pool: day.ztpool,
                        zbCount: (day.zbpool || []).length,
                        source: 'cache'
                    };
                }
            }
        } catch (e) {
            console.warn('涨停池缓存读取失败，回退实时接口:', e.message);
        }

        // 2) 兜底：运行时拉东财涨停池（需代理）
        const ymd = toYmd(dateStr);
        const url = 'https://push2ex.eastmoney.com/getTopicZTPool' +
            '?ut=7eea3edcaed734bea9cbfc24409ed989' +
            '&dpt=wz.ztzt' +
            '&Pageindex=0&Pagesize=1000' +
            '&sort=fbt%3Aasc' +
            '&date=' + ymd +
            '&_=' + Date.now();
        const data = await StockAPI.request(url);
        const pool = (data && data.data && data.data.pool) || [];
        if (!pool.length) {
            throw new Error('未获取到 ' + dateStr + ' 涨停池数据（复盘缓存缺失且实时接口无返回），请先运行复盘采集或检查网络');
        }
        return { pool: pool, zbCount: 0, source: 'live' };
    }

    /**
     * 昨日涨停范围：剔除 ST / 退市 / 北交所（与参考实现的样本口径一致）
     * @param {Array} pool
     * @returns {Array}
     */
    function filterZTPool(pool) {
        return pool.filter(s => {
            const n = String(s.name || '').toUpperCase();
            const c = String(s.code || '');
            if (n.includes('ST') || n.includes('退')) return false;
            if (c.startsWith('8') || c.startsWith('4') || c.startsWith('92')) return false;
            return true;
        });
    }

    /**
     * 由涨停池构造行（兼容两种字段形态：fupan 缓存 / 东财 push2ex 实时）
     * fupan ztpool：price(涨停价=今昨收) amount(昨日成交额) floatMV turnover(换手%) lbCount openCount firstSealTime sealFund industry
     * push2ex pool：c n m p(价格×1000) amount ltsz hs lbcc zbc fbt fund hybk
     * @param {Array} pool
     * @returns {Array}
     */
    function rowsFromPool(pool) {
        return pool.map(s => {
            const isFupan = (s.firstSealTime !== undefined) || (s.lbCount !== undefined) || (s.sealFund !== undefined);
            const code = isFupan ? String(s.code) : String(s.c);
            const name = isFupan ? s.name : s.n;
            const market = isFupan ? marketOf(code) : Number(s.m);
            const price = isFupan ? num(s.price) : (num(s.p) ? num(s.p) / 1000 : null);
            const amount = isFupan ? num(s.amount) : (num(s.amount) || 0);
            const turnover = isFupan ? num(s.turnover) : num(s.hs);
            const floatMV = isFupan ? num(s.floatMV) : num(s.ltsz);
            const lbCount = isFupan ? (num(s.lbCount) || 1) : (num(s.lbc) || 1);
            const openCount = isFupan ? (num(s.openCount) || 0) : (num(s.zbc) || 0);
            const firstSeal = isFupan ? s.firstSealTime : s.fbt;
            const sealFund = isFupan ? (num(s.sealFund) || 0) : (num(s.fund) || 0);
            const industry = isFupan ? (s.industry || '') : (s.hybk || '');

            return {
                code: code,
                name: name,
                market: market,
                preClose: price,           // 昨日涨停价 = 今日昨收
                yAmt: amount,               // 昨日成交额（元）
                yVol: null,                 // 涨停池无昨日成交量（手），由快照/估算补齐
                yTurnover: turnover,        // 昨日换手率（%）
                floatMV: floatMV,           // 流通市值（元）
                totalMV: null,
                lbc: lbCount,               // 连板数
                zbc: openCount,             // 炸板次数
                fbt: normalizeFbt(firstSeal),// 首次封板时间（HHMMSS）
                lbt: isFupan ? null : s.lbt,
                fund: sealFund,             // 封单额（元）
                hybk: industry,             // 细分行业
                limitPct: limitPctOf(code, name),
                from: 'zt'
            };
        });
    }

    // ===== 自选范围 =====

    /**
     * 自选范围：全部自选 或 指定分组
     * @param {string} groupId - '' 表示全部自选；其他为分组id
     * @returns {Array} [{code,name,market}]
     */
    function rowsFromWatchlist(groupId) {
        if (typeof Watchlist === 'undefined' || !Watchlist.getList) return [];
        let list = Watchlist.getList();
        if (groupId) list = list.filter(s => s.groupId === groupId);
        return list.map(s => ({
            code: String(s.code),
            name: s.name,
            market: s.market,
            from: 'wl'
        }));
    }

    /**
     * 补齐昨日指标（成交量/成交额/换手/昨收）
     * 涨停池范围已带成交额/换手/流通市值，缺的是"昨日成交量"，统一用K线补齐；
     * 自选范围四项都缺。已存在的字段不覆盖。
     * @param {Array} rows
     * @param {string} base - 基准交易日 YYYY-MM-DD
     * @param {Function} onProgress - (done, total)
     */
    async function fillPrevMetrics(rows, base, onProgress) {
        const need = rows.filter(r => r.yVol == null);
        if (!need.length) return;

        const secids = need.map(r => (Number(r.market) === 1 ? '1.' : '0.') + r.code);
        const klineMap = await StockAPI.batchGetKline(secids, 2, (done) => {
            if (onProgress) onProgress(done, secids.length);
        }, 6);

        need.forEach(r => {
            const secid = (Number(r.market) === 1 ? '1.' : '0.') + r.code;
            const bars = klineMap.get(secid) || [];
            // 取基准交易日的K线（K线最新一根可能已是目标日，故按日期精确匹配）
            const bar = bars.find(b => b.date === base) || bars[bars.length - 1];
            if (!bar) return;
            if (r.yAmt == null) r.yAmt = bar.amount;
            if (r.yVol == null) r.yVol = bar.volume;
            if (r.yTurnover == null) r.yTurnover = bar.turnover;
            if (r.preClose == null) r.preClose = bar.close;
        });
    }

    // ===== 集合竞价（东财 trends2 主源 / 腾讯分时兜底） =====

    /** 毫秒延时 */
    function sleep(ms) {
        return new Promise(res => setTimeout(res, ms));
    }

    /**
     * 解析东财 trends2 单只节点
     * trends[0] = "YYYY-MM-DD 09:30,开,收,高,低,量(手),额(元),均价"，即 9:25 集合竞价撮合单一价
     * @returns {Object|null}
     */
    function parseEMTrend(node) {
        if (!node || !node.data || !node.data.trends || !node.data.trends.length) return null;
        const t = String(node.data.trends[0]).split(',');
        // t[0]=时间 t[1]=开 t[2]=收 t[3]=高 t[4]=低 t[5]=量(手) t[6]=额(元) t[7]=均价
        const open = num(t[1]), close = num(t[2]), high = num(t[3]), low = num(t[4]);
        const vol = num(t[5]), amount = num(t[6]);
        if (close == null && open == null) return null;
        const preClose = num(node.data.preClose);
        return {
            date: (t[0] || '').slice(0, 8),
            stale: false,
            auction: {
                price: close != null ? close : open,
                vol: vol,
                amt: amount,
                time: '09:25:00',
                unmatchedVol: null,        // 东财趋势接口不含买卖盘残量
                unmatchedAmt: null
            },
            live: {
                price: close,
                preClose: preClose,
                open: open,
                vol: vol,
                amount: amount,
                turnover: null,
                volRatio: null,
                floatMV: null,
                totalMV: null,
                limitUp: null,
                limitDown: null,
                snapshotTime: ''
            }
        };
    }

    /**
     * 解析单只股票的竞价 + 实时快照（腾讯兜底源）
     * @param {Object} k - 腾讯 minute/query 单票节点
     * @param {string} sym - 腾讯代码（sz000001）
     * @param {string} targetYmd - 目标日 YYYYMMDD
     * @returns {Object|null}
     */
    function parseTencentNode(k, sym, targetYmd) {
        if (!k) return null;
        const dd = (k.data && k.data.data !== undefined) ? k.data : k;   // 兼容两种嵌套
        const bars = (dd && dd.data) || [];
        const date = (dd && dd.date) || '';
        const qt = (k.qt && (k.qt[sym] || k.qt[Object.keys(k.qt)[0]])) || [];
        const g = (i) => num(qt[i]);

        const preClose = g(TQ.PRE_CLOSE);
        const snapPrice = g(TQ.PRICE);
        const snapVol = g(TQ.VOL);
        const snapAmtWan = g(TQ.AMOUNT_WAN);

        let aucPrice = null;
        let aucVol = null;
        let aucAmt = null;
        let aucTime = '';

        if (bars.length) {
            const b = String(bars[0]).split(/\s+/);
            // 首点必须是 0930（该点即 9:25 集合竞价撮合结果）
            if (b[0] === '0930') {
                aucTime = '09:25:00';
                aucPrice = num(b[1]);
                aucVol = num(b[2]);
                aucAmt = num(b[3]);
            }
        }
        // 9:30 前分时尚未生成 → 回落到快照的今开/成交量/成交额
        if (aucPrice == null && isAuctionWindow()) {
            aucPrice = g(TQ.OPEN);
            aucVol = snapVol;
            aucAmt = snapAmtWan != null ? snapAmtWan * 1e4 : null;
            aucTime = '09:25:00';
        }

        // 未匹配量：仅当处于撮合快照窗口，或价格封在涨跌停（此时残量全在单边）时才有意义
        let unmatchedVol = null;
        const bid1 = g(TQ.BID1);
        const bid1Vol = g(TQ.BID1_VOL);
        const ask1 = g(TQ.ASK1);
        const ask1Vol = g(TQ.ASK1_VOL);
        const limitUp = g(TQ.LIMIT_UP);
        const limitDown = g(TQ.LIMIT_DOWN);

        if (aucPrice != null) {
            const atUp = limitUp != null && Math.abs(aucPrice - limitUp) < 0.005;
            const atDown = limitDown != null && Math.abs(aucPrice - limitDown) < 0.005;
            if (atUp && bid1Vol != null) {
                unmatchedVol = bid1Vol;                    // 涨停：买单残量
            } else if (atDown && ask1Vol != null) {
                unmatchedVol = -ask1Vol;                   // 跌停：卖单残量（负号表示卖方未匹配）
            } else if (isAuctionWindow() && bid1Vol != null && ask1Vol != null) {
                unmatchedVol = bid1Vol - ask1Vol;
            }
        }

        const price = snapPrice != null ? snapPrice : aucPrice;
        const floatMVYi = g(TQ.FLOAT_MV_YI);
        const totalMVYi = g(TQ.TOTAL_MV_YI);

        return {
            date: date,
            stale: !!date && date !== targetYmd,
            auction: {
                price: aucPrice, vol: aucVol, amt: aucAmt, time: aucTime,
                unmatchedVol: unmatchedVol,
                unmatchedAmt: (unmatchedVol != null && aucPrice != null)
                    ? Math.abs(unmatchedVol) * 100 * aucPrice : null
            },
            live: {
                price: price,
                preClose: preClose,
                open: g(TQ.OPEN),
                vol: snapVol,
                amount: snapAmtWan != null ? snapAmtWan * 1e4 : null,
                turnover: g(TQ.TURNOVER),
                volRatio: g(TQ.VOL_RATIO),
                floatMV: floatMVYi != null ? floatMVYi * 1e8 : null,
                totalMV: totalMVYi != null ? totalMVYi * 1e8 : null,
                limitUp: limitUp,
                limitDown: limitDown,
                snapshotTime: formatSnapTime(g(TQ.TIME))
            }
        };
    }

    /** 腾讯时间戳 20261016103015 → 10:30:15 */
    function formatSnapTime(v) {
        if (v == null) return '';
        const s = String(Math.floor(v)).padStart(14, '0');
        return s.slice(8, 10) + ':' + s.slice(10, 12) + ':' + s.slice(12, 14);
    }

    /**
     * 并发拉取单票竞价（带每日缓存；东财为主、腾讯兜底；全失败降级为"无数据"而非整体报错）
     * @param {Array} rows
     * @param {{target:string, concurrency?:number, onProgress?:Function, force?:boolean}} opts
     */
    async function fetchAuction(rows, opts) {
        opts = opts || {};
        const target = opts.target;
        // 初始缓存：优先用 collect 合成的多源起点（后端文件→本地localStorage），否则按本地键读取
        const cache = opts.cache || (opts.force ? {} : (readCache(CACHE_AUC + target) || {}));
        const concurrency = Math.max(1, opts.concurrency || 4);
        const total = rows.length;
        let done = 0;

        const queue = rows.filter(r => !cache[r.code]);
        const report = () => { if (opts.onProgress) opts.onProgress(done, total); };
        report();

        // 熔断：连续多只失败且一只都没成功，说明接口/代理不可用，停止重试而非逐只空耗
        let okCount = 0;
        let failStreak = 0;
        let aborted = false;

        async function one(r) {
            if (aborted) return;
            const market = Number(r.market);
            const secid = market + '.' + r.code;
            const sym = tencentSymbol(r.code, r.market);
            let parsed = null;
            let lastErr = null;

            // 主源：东财 1 分钟趋势（首根 09:30 = 9:25 撮合单一价）
            try {
                const em = await StockAPI.request(
                    'https://push2his.eastmoney.com/api/qt/stock/trends2/get' +
                    '?fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58' +
                    '&iscr=0&ndays=1&period=1&secid=' + secid +
                    '&ut=fa5fd1943c7b386f172d6893dbfba10b&_=' + Date.now());
                parsed = parseEMTrend(em);
            } catch (e) { lastErr = e; }

            // 兜底：腾讯分时首点
            if (!parsed) {
                try {
                    const tx = await StockAPI.request(
                        'https://ifzq.gtimg.cn/appstock/app/minute/query?code=' + sym);
                    const node = tx && tx.data && tx.data[sym];
                    parsed = parseTencentNode(node, sym, toYmd(target));
                } catch (e) { lastErr = e; }
            }

            if (parsed) {
                cache[r.code] = parsed; okCount++; failStreak = 0;
            } else {
                failStreak++;
                console.warn('竞价数据获取失败:', r.code, lastErr && lastErr.message);
                if (failStreak >= 8 && okCount === 0) aborted = true;
            }
            done++;
            report();
            if (!aborted && done % 4 === 0) await sleep(120);  // 轻微限流，避免触发反爬
        }

        let cursor = 0;
        async function worker() {
            while (cursor < queue.length && !aborted) {
                const r = queue[cursor++];
                await one(r);
            }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

        if (aborted) {
            console.warn('集合竞价接口连续失败：东财/腾讯接口当前不可访问（可能是代理受限或接口变更）。' +
                '已加载涨停池名单，未取到竞价数据的个股标记为「无数据」');
        }
        if (done > 0) writeCache(cacheKey, cache);
        return cache;
    }

    // ===== 主流程 =====

    /**
     * 采集完整数据集
     * @param {{scope:string, groupId:string, onProgress:Function, force:boolean}} opts
     *   scope: 'zt' 昨日涨停 | 'wl' 自选（groupId 为空=全部自选）
     * @returns {Promise<{rows:Array, dates:Object, scopeLabel:string, baseline:{ztCount:number, zbCount:number, source:string}}>}
     */
    async function collect(opts) {
        const o = opts || {};
        const dates = resolveDates(o.date);   // TODO38.3：支持指定历史日期
        const notify = o.onProgress || function () {};
        let rows = [];
        let scopeLabel = '';
        let ztCount = 0;
        let zbCount = 0;
        let source = 'cache';

        if (o.scope === 'zt') {
            notify(0, 0, '正在读取昨日涨停池（复盘缓存）...');
            const res = await fetchZTPool(dates.base);
            const pool = res.pool;
            source = res.source;
            ztCount = pool.length;
            zbCount = res.zbCount;
            if (!ztCount) {
                throw new Error('未获取到 ' + dates.base + ' 涨停池数据（复盘缓存缺失），请先运行复盘采集脚本');
            }
            rows = rowsFromPool(filterZTPool(pool));
            scopeLabel = '昨日涨停（' + dates.base + '）';
        } else {
            rows = rowsFromWatchlist(o.groupId);
            if (!rows.length) {
                throw new Error(o.groupId ? '该自选分组下没有股票' : '自选列表为空');
            }
            scopeLabel = o.groupId
                ? ('自选分组 · ' + (typeof WlGroup !== 'undefined' ? WlGroup.getGroupName(o.groupId) : o.groupId))
                : '全部自选';
            notify(0, rows.length, '正在获取昨日指标...');
            await fillPrevMetrics(rows, dates.base, (d, t) => {
                notify(0, rows.length, '正在获取昨日指标 ' + d + '/' + t + '...');
            });
        }

        // 竞价数据（逐票，带缓存；全失败降级为无数据，不整体抛错）
        // TODO38.3：初始缓存由多源合成（后端定时采集文件 → 本地localStorage），缺失部分仅"实时日"走接口
        const startCache = await buildStartCache(dates.target, o.force);
        const cache = await fetchAuction(rows, {
            target: dates.target,
            concurrency: 4,
            force: o.force,
            cache: startCache,
            onProgress: (d, t) => notify(d, t, '正在获取集合竞价 ' + d + '/' + t + '...')
        });

        // 合并竞价与快照
        rows.forEach(r => {
            const c = cache[r.code];
            r.auction = c ? c.auction : null;
            r.live = c ? c.live : null;
            r.stale = c ? c.stale : false;
            // 竞价期间采样序列（后端采集产出，评级引擎用于近似还原试盘/急速下跌等异动）
            r._series = (c && c.series) ? c.series : null;

            // 昨收优先取快照（最权威），涨停池价格作为兜底
            if (r.preClose == null && r.live && r.live.preClose != null) r.preClose = r.live.preClose;
            if (r.floatMV == null && r.live && r.live.floatMV != null) r.floatMV = r.live.floatMV;
            if (r.totalMV == null && r.live && r.live.totalMV != null) r.totalMV = r.live.totalMV;
        });

        return {
            rows: rows,
            dates: dates,
            scopeLabel: scopeLabel,
            baseline: { ztCount: ztCount, zbCount: zbCount, source: source }
        };
    }

    /** 清空指定日期的竞价缓存（刷新时强制重取） */
    function clearAuctionCache(target) {
        try {
            localStorage.removeItem(CACHE_AUC + target);
        } catch (e) { /* 忽略 */ }
    }

    // ===== 评分方案回测（TODO39.2） =====

    /**
     * 从后端竞价缓存文件提取「原始行」（供 CAScheme 按方案重算评分）
     * 复用 normalizeFileStock 的形状；额外带 limitPct 供涨跌停价推导。
     * @param {Object} file fetchAuctionCacheFile 的结果
     * @param {string} target YYYY-MM-DD
     * @returns {Array} 原始行（CARating.computeRow 可直接消费）
     */
    function rowsFromCacheFile(file, target) {
        if (!file || !file.stocks) return [];
        const rows = [];
        Object.keys(file.stocks).forEach(code => {
            const s = normalizeFileStock(file.stocks[code], target);
            rows.push({
                code: code,
                name: file.stocks[code].name || code,
                market: file.stocks[code].market,
                hybk: '',
                preClose: s.live.preClose,
                yAmt: null, yVol: null, yTurnover: null,
                floatMV: s.live.floatMV, totalMV: s.live.totalMV,
                lbc: null, zbc: null, fbt: null, fund: null,
                limitPct: 0.10,
                auction: s.auction, live: s.live, series: s.series
            });
        });
        return rows;
    }

    /**
     * 提取某日竞价文件的「收盘价表」{code: closePrice}（后端 15:05 收盘补采写入）
     * @param {Object} file fetchAuctionCacheFile 的结果
     * @returns {Object}
     */
    function closeMapFromCacheFile(file) {
        const map = {};
        if (!file || !file.stocks) return map;
        Object.keys(file.stocks).forEach(code => {
            const c = file.stocks[code].close;
            if (c && c.price != null) map[code] = c.price;
        });
        return map;
    }

    /**
     * 构建评分方案回测周期（TODO39.2）
     * 周期 = 预测日(T)原始行 + 次日(T+1)收盘价表；缺任一日文件或 T+1 无收盘价则跳过。
     * @param {Array<string>} tradeDates 升序交易日列表（YYYY-MM-DD，含目标日）
     * @param {string} target 目标交易日 YYYY-MM-DD（回测截止日，即"今日"视角）
     * @param {number} nWindows 回测窗口（1/3/5）
     * @returns {Promise<Array<{rows:Array, closeMap:Object}>>}
     */
    async function buildBacktestCycles(tradeDates, target, nWindows) {
        const idx = tradeDates.indexOf(target);
        if (idx <= 0) return [];
        const cycles = [];
        for (let i = Math.max(0, idx - nWindows); i < idx; i++) {
            const dayFile = await fetchAuctionCacheFile(tradeDates[i]).catch(() => null);
            const nextFile = await fetchAuctionCacheFile(tradeDates[i + 1]).catch(() => null);
            if (!dayFile || !nextFile) continue;
            const closeMap = closeMapFromCacheFile(nextFile);
            if (!Object.keys(closeMap).length) continue;   // 次日无收盘补采，跳过
            cycles.push({ date: tradeDates[i], rows: rowsFromCacheFile(dayFile, tradeDates[i]), closeMap: closeMap });
        }
        return cycles;
    }

    return {
        collect,
        resolveDates,
        isAuctionWindow,
        clearAuctionCache,
        limitPctOf,
        tencentSymbol,
        toYmd,
        buildBacktestCycles,
        // 纯函数，供Node测试使用
        _internals: {
            parseTencentNode,
            parseEMTrend,
            formatSnapTime,
            normalizeFbt,
            marketOf,
            filterZTPool,
            rowsFromPool,
            rowsFromWatchlist,
            normalizeFileStock,
            toYmd
        }
    };
})();

// Node测试环境导出
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CAData;
}
