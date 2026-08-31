/**
 * 东方财富API数据源模块
 * 通过代理或直连方式调用东方财富公开接口，获取板块分时资金流数据
 *
 * 接口说明：
 * - 使用 push2delay.eastmoney.com（有CORS头，支持直连；push2.eastmoney.com 服务器端请求会被拒绝）
 * - 板块列表：push2delay.eastmoney.com/api/qt/clist/get (fs=m:90+t:2 行业, fs=m:90+t:3 概念)
 * - 分时资金流：push2delay.eastmoney.com/api/qt/stock/fflow/kline/get (secid=90.BKxxxx, klt=1)
 * - 分时价格：push2his.eastmoney.com/api/qt/stock/trends2/get (secid=90.BKxxxx)
 */

const EastMoneyAPI = {

    // 板块类型映射：fs参数
    SECTOR_FS_MAP: {
        industry: 'm:90+t:2',   // 行业板块
        concept: 'm:90+t:3'     // 概念板块
    },

    // 板块名称到代码的缓存映射
    _sectorCodeMap: {
        industry: null,
        concept: null
    },

    // JSONP回调计数器
    _jsonpCounter: 0,

    /**
     * 构建代理URL（如果配置了代理）
     * 代理格式: 代理地址/proxy?target=encodeURIComponent(原始URL)
     * @param {string} originalUrl - 原始东方财富API URL
     * @param {string} proxyBase - 代理服务器地址
     * @returns {string} 经过代理转换的URL
     */
    _proxyUrl(originalUrl, proxyBase) {
        const proxy = proxyBase || CONFIG.apiProxy;
        if (proxy) {
            return `${proxy}/proxy?target=${encodeURIComponent(originalUrl)}`;
        }
        return originalUrl;
    },

    /**
     * JSONP请求封装
     * 支持通过代理中转请求，解决直连东方财富API被拦截的问题
     * 主代理失败自动切换备用代理，最后尝试直连
     * @param {string} url - 请求URL（不含callback参数）
     * @param {number} timeout - 超时时间(ms)
     * @returns {Promise<object>} 响应数据
     */
    _jsonp(url, timeout = 10000) {
        // 通过代理时使用fetch+JSON解析，因为代理返回的是JSON而非JSONP
        if (CONFIG.apiProxy) {
            return this._fetchJson(url, timeout);
        }

        // 直连模式：使用传统JSONP
        return this._jsonpDirect(url, timeout);
    },

    /**
     * 通过代理的fetch请求（主备自动切换）
     * 尝试顺序: 主代理 → 备用代理 → 直连
     * @param {string} url - 原始东方财富API URL
     * @param {number} timeout - 超时时间(ms)
     * @returns {Promise<object>} 响应数据
     */
    async _fetchJson(url, timeout = 15000) {
        const proxies = [CONFIG.apiProxy, CONFIG.apiProxyBackup].filter(Boolean);
        let lastErr = null;

        for (const proxy of proxies) {
            try {
                const proxyUrl = this._proxyUrl(url, proxy);
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeout);

                // 添加X-Override头，由代理转发给东方财富API绕过反爬
                const resp = await fetch(proxyUrl, {
                    signal: controller.signal,
                    headers: {
                        'X-Override-User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'X-Override-Referer': 'https://data.eastmoney.com/'
                    }
                });
                clearTimeout(timer);

                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                console.log(`代理请求成功: ${proxy}`);
                return data;
            } catch (err) {
                console.warn(`代理请求失败 ${proxy}: ${err.message}`);
                lastErr = err;
            }
        }

        // 所有代理都失败，尝试直连
        console.warn('所有代理均失败，尝试直连东方财富API');
        try {
            return await this._jsonpDirect(url, timeout);
        } catch (err) {
            throw lastErr || err;
        }
    },

    /**
     * 传统JSONP直连请求
     * @param {string} url - 请求URL（不含callback参数）
     * @param {number} timeout - 超时时间(ms)
     * @returns {Promise<object>} 响应数据
     */
    _jsonpDirect(url, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const callbackName = `em_callback_${++this._jsonpCounter}_${Date.now()}`;
            const script = document.createElement('script');
            let timer = null;

            // 清理函数
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                delete window[callbackName];
                if (script.parentNode) script.parentNode.removeChild(script);
            };

            // 回调函数
            window[callbackName] = (data) => {
                cleanup();
                resolve(data);
            };

            // 超时处理
            timer = setTimeout(() => {
                cleanup();
                reject(new Error('JSONP request timeout'));
            }, timeout);

            // 添加callback参数
            const separator = url.includes('?') ? '&' : '?';
            script.src = `${url}${separator}cb=${callbackName}`;
            script.onerror = () => {
                cleanup();
                reject(new Error('JSONP script load error'));
            };

            document.head.appendChild(script);
        });
    },

    /**
     * 获取板块列表（含代码映射）
     * 东方财富API每次最多返回100条，需要分页获取全部板块
     * @param {string} sectorType - 板块类型 industry/concept
     * @returns {Promise<Array>} 板块列表 [{code, name, mainNetInflow, changePct, ...}]
     */
    async fetchSectorList(sectorType = 'industry') {
        const fs = this.SECTOR_FS_MAP[sectorType] || this.SECTOR_FS_MAP.industry;
        const allSectors = [];
        const codeMap = {};
        let page = 1;
        const pageSize = 100;  // API每次最多返回100条

        try {
            // 分页获取全部板块
            // 精简fields避免代理URL过长（代理对query string有长度限制，完整fields会502）
            while (true) {
                const url = `https://push2delay.eastmoney.com/api/qt/clist/get?pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f62&fs=${fs}&fields=f12,f14,f3,f6,f62`;
                const resp = await this._jsonp(url);

                if (!resp || !resp.data || !resp.data.diff || resp.data.diff.length === 0) {
                    break;
                }

                const items = resp.data.diff;
                for (const item of items) {
                    const name = item.f14;
                    const code = item.f12;
                    codeMap[name] = code;

                    allSectors.push({
                        code: code,
                        name: name,
                        changePct: item.f3,
                        turnover: item.f6 || 0,          // 成交额（元）
                        turnoverYi: +((item.f6 || 0) / 1e8).toFixed(2),  // 成交额（亿元）
                        mainNetInflow: item.f62,
                        mainNetInflowYi: +(item.f62 / 1e8).toFixed(2),
                    });
                }

                // 已获取全部数据则退出
                const total = resp.data.total || 0;
                if (allSectors.length >= total || items.length < pageSize) {
                    break;
                }
                page++;
            }

            // 缓存映射
            this._sectorCodeMap[sectorType] = codeMap;
            console.log(`获取板块列表: ${allSectors.length}个 (${sectorType})`);
            return allSectors;
        } catch (err) {
            console.error('获取板块列表失败:', err);
            return [];
        }
    },

    /**
     * 获取板块分时资金流数据（分钟级）
     * @param {string} sectorCode - 板块代码（如BK0478）
     * @param {number} limit - 返回数据条数
     * @returns {Promise<Array>} 分时资金流 [{time, mainInflow, hugeInflow, bigInflow, mediumInflow, smallInflow}]
     */
    async fetchSectorFlowMinute(sectorCode, limit = 240) {
        const secid = `90.${sectorCode}`;
        const url = `https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get?fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56,f57&secid=${secid}&klt=1&lmt=${limit}`;

        try {
            const resp = await this._jsonp(url);
            if (!resp || !resp.data || !resp.data.klines) {
                return [];
            }

            // 解析klines: "2026-06-12 14:51,419255199.0,-214277921.0,-200206777.0,248181948.0,171073251.0"
            // 字段: 时间,主力净流入,超大单净流入,大单净流入,中单净流入,小单净流入
            return resp.data.klines.map(line => {
                const parts = line.split(',');
                return {
                    time: parts[0],                              // "2026-06-12 14:51"
                    timeShort: parts[0].split(' ')[1] || parts[0], // "14:51"
                    mainInflow: +parts[1],                       // 主力净流入（元）
                    mainInflowYi: +(parts[1] / 1e8).toFixed(4),  // 亿元
                    hugeInflow: +parts[2],                       // 超大单净流入
                    bigInflow: +parts[3],                        // 大单净流入
                    mediumInflow: +parts[4],                     // 中单净流入
                    smallInflow: +parts[5],                      // 小单净流入
                };
            });
        } catch (err) {
            console.error(`获取板块${sectorCode}分时资金流失败:`, err);
            return [];
        }
    },

    /**
     * 批量获取多个板块的分时资金流数据
     * @param {Array<string>} sectorCodes - 板块代码列表
     * @param {number} limit - 每个板块返回数据条数
     * @param {number} concurrency - 并发请求数
     * @returns {Promise<Object>} {code: [flowData]}
     */
    async fetchBatchSectorFlow(sectorCodes, limit = 240, concurrency = 3) {
        const results = {};
        const queue = [...sectorCodes];

        async function processNext(api) {
            while (queue.length > 0) {
                const code = queue.shift();
                try {
                    results[code] = await api.fetchSectorFlowMinute(code, limit);
                } catch (err) {
                    results[code] = [];
                }
            }
        }

        // 控制并发数
        const workers = [];
        for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
            workers.push(processNext(this));
        }
        await Promise.all(workers);

        return results;
    },

    /**
     * 获取板块名称对应的代码
     * @param {string} sectorName - 板块名称
     * @param {string} sectorType - 板块类型
     * @returns {Promise<string|null>} 板块代码（如BK0478）
     */
    async getSectorCode(sectorName, sectorType = 'industry') {
        // 检查缓存
        if (this._sectorCodeMap[sectorType] && this._sectorCodeMap[sectorType][sectorName]) {
            return this._sectorCodeMap[sectorType][sectorName];
        }

        // 重新获取板块列表
        await this.fetchSectorList(sectorType);

        return this._sectorCodeMap[sectorType]?.[sectorName] || null;
    },

    /**
     * 构建与本地JSON数据格式兼容的分时图数据
     * 从东方财富API获取数据，转换为前端分时图组件所需格式
     * @param {string} sectorType - 板块类型
     * @param {number} topN - 取前N个板块
     * @returns {Promise<Object>} 分时图数据
     */
    async buildIntradayData(sectorType = 'industry', topN = 30, selectedNames = null) {
        // 1. 获取板块列表（含代码映射和当日资金流排名）
        const sectors = await this.fetchSectorList(sectorType);
        if (sectors.length === 0) return null;

        // 按已选板块名称过滤，或按topN截取
        let displaySectors;
        if (selectedNames && selectedNames.length > 0) {
            displaySectors = sectors.filter(s => selectedNames.includes(s.name));
        } else {
            displaySectors = sectors.slice(0, topN);
        }

        // 2. 批量获取分时资金流
        const codes = displaySectors.map(s => s.code);
        const flowData = await this.fetchBatchSectorFlow(codes, 240, 3);

        // 3. 构建时间轴（取第一个有数据的板块的时间序列）
        // 同时校验数据日期：开市前调用东方财富API会返回上一交易日的数据，
        // 此时不应当作今日数据展示，需返回null让前端显示"暂无分时数据"
        let times = [];
        let flowDate = null;
        for (const code of codes) {
            const flows = flowData[code] || [];
            if (flows.length > 0) {
                times = flows.map(f => f.timeShort);
                // flow.time格式为"2026-07-01 14:51"，提取日期部分
                flowDate = (flows[0].time || '').split(' ')[0] || null;
                break;
            }
        }

        if (times.length === 0) return null;

        // 日期校验：API返回的数据日期非今日时，视为开市前/非交易时段的旧数据，不展示
        const todayStr = new Date().toISOString().slice(0, 10);
        if (flowDate && flowDate !== todayStr) {
            console.warn(`东方财富API返回的是${flowDate}的数据（非今日${todayStr}），可能开市前调用，忽略本次数据`);
            return null;
        }

        // 4. 构建每个板块的分时数据（klines返回的是累计主力净流入，直接使用）
        const sectorsData = displaySectors.map(sector => {
            const flows = flowData[sector.code] || [];
            const flowMap = {};
            flows.forEach(f => { flowMap[f.timeShort] = f.mainInflowYi; });

            const data = times.map(t => {
                const val = flowMap[t];
                return val !== undefined ? +val.toFixed(4) : null;
            });

            // 最后一个有效值作为最终值
            let finalValue = 0;
            for (let i = data.length - 1; i >= 0; i--) {
                if (data[i] !== null) {
                    finalValue = data[i];
                    break;
                }
            }

            return {
                name: sector.name,
                data: data,
                final_value: +finalValue.toFixed(2),
                change_pct: sector.changePct || 0,
                turnover_yi: sector.turnoverYi || 0
            };
        });

        // 按最终值降序排列
        sectorsData.sort((a, b) => b.final_value - a.final_value);

        // 5. 构建兼容格式
        const today = new Date();
        const dateStr = today.toISOString().slice(0, 10);

        return {
            update_time: today.toLocaleString('zh-CN'),
            date: dateStr,
            indicator: '今日',
            sector_type: sectorType === 'industry' ? '行业资金流' : '概念资金流',
            times: times,
            sectors: sectorsData,
            source: 'eastmoney'  // 标记数据来源
        };
    },

    /**
     * 构建与本地JSON数据格式兼容的实时排名数据
     * @param {string} sectorType - 板块类型
     * @returns {Promise<Object>} 实时排名数据
     */
    async buildRealtimeData(sectorType = 'industry', selectedNames = null) {
        const sectors = await this.fetchSectorList(sectorType);
        if (sectors.length === 0) return null;

        // 按已选板块名称过滤
        const displaySectors = selectedNames && selectedNames.length > 0
            ? sectors.filter(s => selectedNames.includes(s.name))
            : sectors;

        const today = new Date();

        return {
            update_time: today.toLocaleString('zh-CN'),
            indicator: '今日',
            sector_type: sectorType === 'industry' ? '行业资金流' : '概念资金流',
            sectors: displaySectors.map(s => ({
                name: s.name,
                main_net_inflow_yi: s.mainNetInflowYi,
                change_pct: s.changePct,
                turnover_yi: s.turnoverYi,
                // 净流入占成交额比例 = 净流入 / 成交额 * 100
                main_net_inflow_pct: (s.turnoverYi && s.turnoverYi > 0)
                    ? +(s.mainNetInflowYi / s.turnoverYi * 100).toFixed(2)
                    : 0
            })),
            source: 'eastmoney'
        };
    }
};
