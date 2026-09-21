/**
 * 主程序入口
 * 协调API、计算器、渲染器、自选模块，处理用户交互
 *
 * 新流程：
 * 1. 检查识别结果缓存（当日有效）
 * 2. 无缓存时：获取阶段涨幅候选股票 → 获取K线 → 计算异动 → 缓存结果
 * 3. 有缓存时：直接渲染缓存结果
 * 4. 点击刷新：清空缓存，强制重新获取
 *
 * 页面结构（左侧菜单栏四页）：
 * - market：市场行情（TODO16.3双子tab：市场异动=全量按风险降序 / 关注异动=自定义监控个股）
 * - fupan：每日复盘（Fupan模块，四子tab：大盘/板块轮动/涨跌停/评分预测）
 * - watchlist：自选（Watchlist模块，分组栏+浏览列表+查询异动列，CSV导入导出+搜索）
 * - settings：设置（原顶部设置弹窗迁入）
 * - tab切换状态持久化：进入首页时恢复最后一次选中的tab
 *
 * TODO16.3.1数据策略：市场异动显示全部结果（不再按onlyRisk过滤）按风险降序；
 * 超过涨停限制的仅title提示（取消删除线）；默认提前天数8天（T+0~T+7）
 */
const App = (function () {

    // 默认配置
    const DEFAULT_CONFIG = {
        topN: 50,               // 每个榜单获取数量
        forwardDays: 8,         // 提前天数（TODO16.3.1默认8天：T+0~T+7）
        autoRefresh: 0,         // 自动刷新间隔(秒)，0=关闭（默认不自动刷新）
        concurrency: 2          // API并发数
    };

    // 左侧菜单tab持久化key
    const ACTIVE_TAB_KEY = 'unusual_active_tab';

    // 市场行情页二级tab持久化key（TODO16.3：all=市场异动 / focus=关注异动）
    const MKT_SUB_KEY = 'unusual_market_sub';

    // 自定义监控股票持久化key（关注异动tab搜索添加，即"关注异动"监控列表）
    const CUSTOM_MONITOR_KEY = 'unusual_custom_monitor';

    // 运行状态
    let config = { ...DEFAULT_CONFIG };
    let autoRefreshTimer = null;
    let isLoading = false;
    let pendingRerun = false; // 运行中收到自定义监控增删请求时，本轮结束后补跑一次
    let selectedDate = null; // 用户选择的日期（YYYY-MM-DD），null=自动
    let marketSub = 'focus'; // 异动监控页当前二级tab（focus=关注异动放最前 / all=市场异动，TODO19.2）
    let lastResults = [];    // 最近一次全量分析结果（含isCustom标记，双视图过滤渲染用）
    let lastTargetDate = null; // 最近一次渲染目标交易日（二级tab切换重渲染用）

    /**
     * 从localStorage加载配置
     */
    function loadConfig() {
        try {
            const saved = localStorage.getItem('unusual_config');
            if (saved) {
                const parsed = JSON.parse(saved);
                // 配置迁移：旧版默认/钳制的forwardDays(<=4)一次性升级为8（TODO16.3.1）
                if (parsed.forwardDays && parsed.forwardDays <= 4) {
                    parsed.forwardDays = 8;
                }
                // onlyRisk配置废弃（TODO16.3.1改为全量显示），忽略旧值
                delete parsed.onlyRisk;
                config = { ...DEFAULT_CONFIG, ...parsed };
            }
        } catch (e) {
            config = { ...DEFAULT_CONFIG };
        }
    }

    /**
     * 保存配置到localStorage
     */
    function saveConfig() {
        try {
            localStorage.setItem('unusual_config', JSON.stringify(config));
        } catch (e) {
            console.warn('保存配置失败:', e);
        }
    }

    // ============================================================
    // 自定义监控股票（异动监控页搜索添加，置顶显示，可删除）
    // ============================================================

    /**
     * 读取自定义监控股票列表
     * @returns {Array} [{code, name, market, addedAt}]
     */
    function getCustomMonitors() {
        try {
            const raw = localStorage.getItem(CUSTOM_MONITOR_KEY);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list : [];
        } catch (e) {
            console.warn('读取自定义监控失败:', e.message);
            return [];
        }
    }

    /**
     * 保存自定义监控股票列表
     */
    function saveCustomMonitors(list) {
        try {
            localStorage.setItem(CUSTOM_MONITOR_KEY, JSON.stringify(list));
        } catch (e) {
            console.warn('保存自定义监控失败:', e.message);
        }
    }

    /**
     * 添加自定义监控股票
     * @param {string} code - 股票代码
     * @param {string} name - 股票名称
     * @param {number} market - 市场编号（0=深/北，1=沪）
     */
    function addCustomMonitor(code, name, market) {
        if (!code || getCustomMonitors().some(s => s.code === code)) return false;
        const list = getCustomMonitors();
        list.push({ code: code, name: name, market: market, addedAt: Date.now() });
        saveCustomMonitors(list);
        // 结果缓存已过时（需包含新监控股），仅清结果缓存；K线缓存保留避免重复拉取
        StockAPI.clearResultCache();
        rerunAfterCustomChange();
        return true;
    }

    /**
     * 移除自定义监控股票（表格操作列移除按钮回调，Renderer转发）
     * @param {string} code - 股票代码
     */
    function removeCustomMonitor(code) {
        const list = getCustomMonitors();
        const stock = list.find(s => s.code === code);
        if (!stock) return false;
        if (!confirm('确定移除自定义监控 ' + stock.name + '（' + code + '）？')) return false;
        const idx = list.indexOf(stock);
        list.splice(idx, 1);
        saveCustomMonitors(list);
        StockAPI.clearResultCache();
        rerunAfterCustomChange();
        return true;
    }

    /**
     * TODO27.1：批量移除自定义监控（关注异动 sub tab 多选后"批量移除"按钮触发）
     * 一次确认，一次持久化，一次重渲染（比逐只删高效）
     * @param {string[]} codes - 股票代码数组
     */
    function removeCustomMonitorBatch(codes) {
        if (!codes || !codes.length) return 0;
        const list = getCustomMonitors();
        const before = list.length;
        // 一次确认（批量时比逐只 confirm 高效）
        const matches = list.filter(s => codes.includes(s.code));
        if (!matches.length) return 0;
        if (!confirm(`确定批量移除 ${matches.length} 只关注异动股票？\n`
            + matches.map(s => `  · ${s.name}（${s.code}）`).join('\n'))) return 0;
        const newList = list.filter(s => !codes.includes(s.code));
        saveCustomMonitors(newList);
        StockAPI.clearResultCache();
        rerunAfterCustomChange();
        return before - newList.length;
    }

    /**
     * 自定义监控增删后重新分析渲染（运行中则等本轮结束后补跑）
     */
    function rerunAfterCustomChange() {
        if (isLoading) {
            pendingRerun = true;
        } else {
            run(false);
        }
    }

    /**
     * 初始化市场行情页搜索框（添加关注异动监控股票，共用StockSearch组件）
     * TODO16.3：搜索添加即"关注异动"，添加成功自动切到关注异动tab查看
     */
    function initMarketSearch() {
        StockSearch.create({
            inputId: 'mktSearchInput',
            dropdownId: 'mktSearchDropdown',
            isExists: (code) => getCustomMonitors().some(s => s.code === code),
            onPick: (item) => {
                if (addCustomMonitor(item.code, item.name, item.market)) {
                    console.log('已添加关注异动监控:', item.name, item.code);
                    // 添加成功切到关注异动tab立即查看（新增触发重算，切换本身也会重渲染）
                    switchMarketSub('focus');
                }
            }
        });
    }

    /**
     * 初始化设置面板的值
     */
    function initSettingsUI() {
        document.getElementById('settingTopN').value = config.topN;
        document.getElementById('settingForwardDays').value = config.forwardDays;
        document.getElementById('settingAutoRefresh').value = config.autoRefresh;
        document.getElementById('settingRequestInterval').value = StockAPI.getRequestInterval();

        // 代理配置
        const proxyConfig = StockAPI.getProxyConfig();
        document.getElementById('settingProxyUrl').value = proxyConfig.primaryUrl || '';
        document.getElementById('settingBackupProxy').value = (proxyConfig.backupUrls || []).join('\n');
        document.getElementById('settingProxyToken').value = proxyConfig.token || '';
        document.getElementById('currentMode').textContent = StockAPI.getRequestMode();

        // 本地缓存配置 + 占用统计
        const cacheConfig = StockAPI.getCacheConfig();
        document.getElementById('settingCacheCapacity').value = cacheConfig.capacity;
        document.getElementById('settingCacheDays').value = cacheConfig.marketKeepDays;
        updateCacheStats();
    }

    /**
     * 从设置面板读取配置
     */
    function readSettingsUI() {
        config.topN = parseInt(document.getElementById('settingTopN').value) || DEFAULT_CONFIG.topN;
        config.forwardDays = parseInt(document.getElementById('settingForwardDays').value) || DEFAULT_CONFIG.forwardDays;
        config.autoRefresh = parseInt(document.getElementById('settingAutoRefresh').value) || 0;

        // 请求间隔
        const intervalVal = parseInt(document.getElementById('settingRequestInterval').value) || 500;
        StockAPI.setRequestInterval(intervalVal);

        // 校验范围
        config.topN = Math.max(10, Math.min(200, config.topN));
        config.forwardDays = Math.max(1, Math.min(10, config.forwardDays));
        config.autoRefresh = Math.max(0, Math.min(600, config.autoRefresh));

        // 代理配置
        const proxyUrl = document.getElementById('settingProxyUrl').value.trim();
        const backupText = document.getElementById('settingBackupProxy').value.trim();
        const proxyToken = document.getElementById('settingProxyToken').value.trim();

        const backupUrls = backupText
            ? backupText.split('\n').map(u => u.trim()).filter(u => u)
            : [];

        StockAPI.setProxyConfig({
            primaryUrl: proxyUrl,
            backupUrls: backupUrls,
            token: proxyToken
        });

        // 本地缓存配置（容量缩小时StockAPI内部立即触发LRU淘汰）
        StockAPI.setCacheConfig({
            capacity: parseInt(document.getElementById('settingCacheCapacity').value) || 500,
            marketKeepDays: parseInt(document.getElementById('settingCacheDays').value) || 5
        });
        updateCacheStats();
    }

    /**
     * 主流程：检查缓存 → 获取候选股票 → 获取K线 → 计算异动 → 渲染结果
     * @param {boolean} forceRefresh - 是否强制刷新（清空缓存）
     */
    async function run(forceRefresh = false) {
        if (isLoading) return;
        isLoading = true;

        const btnRefresh = document.getElementById('btnRefresh');
        btnRefresh.disabled = true;

        try {
            // 确保交易日历数据已加载
            await TradingCalendar.ensureHolidaysLoaded();

            // 计算交易日偏移量
            let targetDate;
            if (selectedDate) {
                // 用户选择了日期，取该日期对应的最近交易日
                targetDate = TradingCalendar.getNearestTradeDate(selectedDate);
            } else {
                targetDate = TradingCalendar.getTargetTradeDate();
            }
            const latestTradeDate = TradingCalendar.getLatestTradeDate();
            const tradeDayOffset = TradingCalendar.getTradeDayOffset(latestTradeDate, targetDate);

            console.log(`目标交易日: ${targetDate}, K线最新日: ${latestTradeDate}, 偏移: ${tradeDayOffset}`);

            // 强制刷新时清空所有缓存
            if (forceRefresh) {
                StockAPI.clearAllCache();
            }

            // 第0步：检查识别结果缓存（TODO20：带K线日期/收盘后/offset三重判定）
            if (!forceRefresh) {
                const cacheWrap = StockAPI.getResultCache();
                if (cacheWrap && cacheWrap.data && cacheWrap.data.length > 0) {
                    const meta = cacheWrap.meta || {};
                    // 缓存时效三条件：
                    // 1) K线最新日与目标交易日的 offset 一致（否则切了日期仍返回旧数据）
                    // 2) K线最新日 == latestTradeDate（否则缓存是更早拉的）
                    // 3) 已收盘后获取 or latestTradeDate < today（历史交易日无盘中问题）
                    const klineDateOk = meta.klineLatestDate === latestTradeDate;
                    const offsetOk = meta.tradeDayOffset === tradeDayOffset;
                    const afterClose = meta.capturedAfterClose || latestTradeDate !== TradingCalendar.formatDate(new Date());
                    if (klineDateOk && offsetOk && afterClose) {
                        console.log('使用缓存结果，共' + cacheWrap.data.length + '只（meta=' + JSON.stringify(meta) + '）');
                        lastResults = cacheWrap.data;
                        renderActiveMarketView(targetDate);
                        updateDataInfo(cacheWrap.data, targetDate);
                        return;
                    } else {
                        console.log('缓存条件不全，重新拉取（klineDateOk=' + klineDateOk + ', offsetOk=' + offsetOk + ', afterClose=' + afterClose + ', meta=' + JSON.stringify(meta) + '）');
                        StockAPI.clearResultCache();
                    }
                }
            }

            // 第1步：获取阶段涨幅候选股票
            Renderer.showLoading('正在获取阶段涨幅排行...');
            const stocks = await StockAPI.getCandidateStocks(config.topN);

            // 合并自定义监控股票（已在候选中的不重复拉取，isCustom标记在结果阶段补）
            const customs = getCustomMonitors();
            const candidateCodes = new Set(stocks.map(s => s.code));
            const customStocks = customs
                .filter(s => !candidateCodes.has(s.code))
                .map(s => ({
                    code: s.code,
                    name: s.name,
                    market: s.market,
                    secid: s.market + '.' + s.code,
                    price: 0,
                    changePercent: 0,
                    gain5d: 0,
                    source: '自定义'
                }));
            const allStocks = stocks.concat(customStocks);

            if (allStocks.length === 0) {
                Renderer.renderEmpty('未获取到候选股票数据，可能非交易时间');
                return;
            }

            console.log(`候选股票: ${stocks.length}只${customStocks.length > 0 ? `，自定义监控追加${customStocks.length}只` : ''}`);

            // 第2步：批量获取K线数据（只对候选股票请求，大幅减少请求量）
            Renderer.showLoading('正在获取K线数据... (0/' + allStocks.length + ')');
            const klineMap = await StockAPI.batchGetKline(
                allStocks.map(s => s.secid),
                config.concurrency,
                (completed, total) => Renderer.updateProgress(completed, total)
            );

            // 第2.5步：获取基准指数K线数据（用于偏离值计算）
            Renderer.showLoading('正在获取基准指数数据...');
            const indexKlineMap = await StockAPI.getBenchmarkIndices(allStocks, 40);
            console.log('基准指数获取完成:', Array.from(indexKlineMap.keys()).join(', '));

            // 第3步：计算异动分析（传入指数K线数据和交易日偏移量）
            // TODO16.3.1：全量分析不做风险过滤（市场异动tab显示全部按风险降序，
            // 关注异动tab单独过滤自定义监控股），双视图在渲染阶段分流
            Renderer.showLoading('正在计算异动分析...');
            const results = UnusualCalculator.analyzeStocks(
                allStocks,
                klineMap,
                indexKlineMap,
                config.forwardDays,
                false,
                tradeDayOffset
            );

            // 标记自定义监控行（关注异动tab数据源）
            const customCodeSet = new Set(customs.map(s => s.code));
            results.forEach(r => { if (customCodeSet.has(r.code)) r.isCustom = true; });

            // 第4步：缓存识别结果（TODO20：附带K线日期/offset/收盘后判定，保证切日期/盘前盘中不命中旧缓存）
            if (results.length > 0) {
                const klineDate = results[0].date || latestTradeDate;
                const capturedAfterClose = TradingCalendar.isMarketClosed();
                StockAPI.setResultCache(results, {
                    klineLatestDate: klineDate,
                    tradeDayOffset: tradeDayOffset,
                    capturedAfterClose: capturedAfterClose
                });
            }
            lastResults = results;

            // 第5步：按当前二级tab渲染（市场异动=全量除自定义 / 关注异动=仅自定义）
            renderActiveMarketView(targetDate);

            // 更新数据日期和请求模式
            updateDataInfo(results, targetDate);

        } catch (error) {
            console.error('运行异常:', error);
            Renderer.showError('数据加载失败: ' + error.message);
        } finally {
            isLoading = false;
            btnRefresh.disabled = false;
        }
    }

    /**
     * 更新数据日期和请求模式信息
     * @param {Array} results - 分析结果
     * @param {string} targetDate - 目标交易日
     */
    function updateDataInfo(results, targetDate) {
        const dataDate = document.getElementById('dataDate');
        const mode = StockAPI.getRequestMode();

        const klineDate = results.length > 0 ? results[0].date : '--';
        let dateHtml = `K线日期: ${klineDate}`;

        // 如果目标交易日与K线日期不同，显示目标交易日
        if (targetDate && targetDate !== klineDate) {
            dateHtml += ` → 目标: ${targetDate}`;
        }

        // 如果用户选择了日期且不是交易日，提示实际交易日
        if (selectedDate && selectedDate !== targetDate) {
            dateHtml += ` <span style="color:#f59e0b;margin-left:4px">(${selectedDate}非交易日)</span>`;
        }

        dateHtml += ` <span style="color:#3b82f6;margin-left:8px">[${mode}]</span>`;
        dataDate.innerHTML = dateHtml;
        dataDate.style.color = '';
    }

    // ============================================================
    // 市场行情页二级tab（TODO16.3：市场异动 / 关注异动）
    // ============================================================

    /**
     * 渲染当前二级tab对应的视图（基于lastResults过滤，无需重新计算）
     * 主流程：市场异动=全量结果剔除自定义监控股（按风险降序，即urgency升序）
     *        → 关注异动=仅自定义监控股（个股异动空间展示）
     * @param {string} [targetDate] 目标交易日（缺省用lastTargetDate）
     */
    function renderActiveMarketView(targetDate) {
        if (targetDate) lastTargetDate = targetDate;
        if (!lastResults.length) {
            Renderer.renderEmpty(marketSub === 'focus'
                ? '暂无关注异动股票，请通过右上角搜索添加个股监控'
                : '当前无股票接近异动线');
            return;
        }
        const rows = marketSub === 'focus'
            ? lastResults.filter(r => r.isCustom)
            : lastResults.filter(r => !r.isCustom);
        if (!rows.length) {
            Renderer.renderEmpty(marketSub === 'focus'
                ? '暂无关注异动股票，请通过右上角搜索添加个股监控'
                : '当前无股票接近异动线');
            return;
        }
        Renderer.renderTable(rows, config.forwardDays, lastTargetDate);
    }

    /**
     * 切换异动监控页二级tab（TODO19.2：关注异动放最前 + 切市场异动时缓存时效弹窗确认）
     * 主流程：更新按钮态+持久化 → 基于已有结果重渲染视图 → 上报子tab变化（URL hash同步）
     * @param {string} sub - all=市场异动 / focus=关注异动
     * @param {boolean} [notify=true] 是否上报subchange（初始化恢复时不触发）
     */
    function switchMarketSub(sub, notify = true) {
        if (sub !== 'all' && sub !== 'focus') return;
        marketSub = sub;
        try {
            localStorage.setItem(MKT_SUB_KEY, sub);
        } catch (e) { /* 忽略 */ }
        document.querySelectorAll('[data-mkt-sub]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mktSub === sub);
        });

        // TODO19.2：切到"市场异动"tab时，如果缓存已过时且在盘中，弹窗确认是否刷新
        if (sub === 'all' && lastResults.length && !TradingCalendar.isMarketClosed()) {
            const cacheWrap = StockAPI.getResultCache();
            if (cacheWrap) {
                const meta = cacheWrap.meta || {};
                const latestTradeDate = TradingCalendar.getLatestTradeDate();
                const todayStr = TradingCalendar.formatDate(new Date());
                // 缓存是盘中拉的 + K线不是收盘定型 → 提示刷新
                if (!meta.capturedAfterClose && meta.klineLatestDate !== latestTradeDate) {
                    const ok = window.confirm('当前数据为盘中更新（未收盘定型），是否刷新获取最新K线？');
                    if (ok) {
                        run(true);
                        return;
                    }
                }
            }
        }

        renderActiveMarketView();
        if (notify) {
            document.dispatchEvent(new CustomEvent('dailystock:subchange', {
                detail: { page: 'market', sub }
            }));
        }
    }

    /**
     * 初始化市场行情页二级tab（绑定点击+恢复持久化状态）
     */
    function initMarketSubTabs() {
        document.querySelectorAll('[data-mkt-sub]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.mktSub !== marketSub) switchMarketSub(btn.dataset.mktSub);
            });
        });
        let saved = 'all';
        try {
            saved = localStorage.getItem(MKT_SUB_KEY) || 'all';
        } catch (e) { /* 忽略 */ }
        switchMarketSub(saved === 'focus' ? 'focus' : 'all', false);
    }

    /**
     * 查询个股异动空间（TODO16.1：自选列表"查询异动"列入口）
     * 主流程：加入关注监控（已存在跳过）→ 切市场行情页-关注异动tab展示其异动计算
     *        → 新增时结果缓存失效自动重算；已存在且有缓存则直接渲染
     * @param {string} code - 股票代码
     * @param {string} name - 股票名称
     * @param {number} market - 市场编号（0=深/北，1=沪）
     */
    function showStockUnusual(code, name, market) {
        if (!code) return;
        const isNew = addCustomMonitor(code, name, market);
        // 切到市场行情页关注异动tab（addCustomMonitor内部已触发重算/补跑）
        switchTab('market');
        switchMarketSub('focus');
        // 已存在且未触发重算时，直接从缓存结果渲染关注视图
        if (!isNew && !isLoading && lastResults.length) {
            renderActiveMarketView();
        }
        if (isNew) {
            console.log('已加入关注异动监控:', name, code);
        }
    }

    /**
     * 启动自动刷新
     */
    function startAutoRefresh() {
        stopAutoRefresh();
        if (config.autoRefresh > 0) {
            autoRefreshTimer = setInterval(() => {
                run(true); // 自动刷新时强制清缓存
            }, config.autoRefresh * 1000);
        }
    }

    /**
     * 停止自动刷新
     */
    function stopAutoRefresh() {
        if (autoRefreshTimer) {
            clearInterval(autoRefreshTimer);
            autoRefreshTimer = null;
        }
    }

    /**
     * 初始化日期选择器
     */
    function initDatePicker() {
        const datePicker = document.getElementById('datePicker');
        // 默认设为目标交易日
        const targetDate = TradingCalendar.getTargetTradeDate();
        datePicker.value = targetDate;
        selectedDate = null; // 初始为自动模式
    }

    /**
     * 切换左侧菜单tab
     * 主流程：更新菜单按钮态 → 切换页面显隐 → 通知懒加载模块 → 持久化tab状态 → 同步URL hash
     * @param {string} tab - market|fupan|watchlist|settings
     */
    function switchTab(tab) {
        // 更新菜单按钮激活态
        document.querySelectorAll('.menu-item').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        // 切换页面显隐
        document.querySelectorAll('.main-content .page').forEach(page => {
            page.classList.toggle('active', page.id === 'page-' + tab);
        });
        // 自选tab激活时通知自选模块（首次进入懒加载数据）
        if (tab === 'watchlist' && typeof Watchlist !== 'undefined') {
            Watchlist.onTabActivated();
        }
        // 复盘tab激活时通知复盘模块（首次进入懒加载数据）
        if (tab === 'fupan' && typeof Fupan !== 'undefined') {
            Fupan.onTabActivated();
        }
        // 记住最后一次选中的tab
        try {
            localStorage.setItem(ACTIVE_TAB_KEY, tab);
        } catch (e) {
            console.warn('保存tab状态失败:', e);
        }
        // TODO12：点击菜单对应不同URL（可收藏）；主tab切换压入历史支持前进/后退
        if (routeState.page !== tab) {
            routeState.page = tab;
            routeState.sub = lastSubByPage[tab] || null;
            if (tab !== 'fupan') routeState.date = null;
        }
        syncRouteHash(true);
    }

    // 各菜单支持的二级子tab（URL ?sub= 或 hash #/page/sub 均需命中此映射）
    const VALID_SUB_TABS = {
        market:    ['all', 'focus'],               // TODO16.3：市场异动/关注异动
        fupan:     ['market', 'sectors', 'zt', 'score'],
        settings:  ['monitor', 'cache', 'proxy'],
        // watchlist无二级tab（TODO16.1异动风险tab移除，仅保留浏览视图+分组栏）
    };

    // 当前路由状态（URL hash 同步用：点击菜单/子tab/切换日期后地址栏始终可收藏）
    const routeState = { page: 'market', sub: null, date: null };
    // 各主tab最近一次的子tab（切回主tab时hash带上，subchange事件更新）
    const lastSubByPage = {};

    /**
     * 同步当前路由到地址栏hash（TODO12：点击菜单对应不同URL，可保存到收藏夹）
     * 主tab切换用pushState（前进/后退可在tab间导航），子tab/日期变化用replaceState（不产生历史记录）
     * @param {boolean} [push] true=压入历史记录（主tab切换），false=原地替换
     */
    function syncRouteHash(push) {
        let hash = '#/' + routeState.page;
        if (routeState.sub && VALID_SUB_TABS[routeState.page]
            && VALID_SUB_TABS[routeState.page].includes(routeState.sub)) {
            hash += '/' + routeState.sub;
        }
        if (routeState.page === 'fupan' && routeState.date) {
            hash += '?date=' + encodeURIComponent(routeState.date);
        }
        try {
            history[push ? 'pushState' : 'replaceState'](
                null, '', location.pathname + location.search + hash);
        } catch (e) { /* file://等场景可能受限，忽略 */ }
    }

    /**
     * 应用路由：预置子tab/日期 → 切主tab → settings子tab直达
     * initTabs初始加载与hashchange（手动改URL/前进后退）共用
     * @param {{page:string, sub:string|null, date:string|null}} route parseRoute结果
     */
    function applyRoute(route) {
        if (!route || !route.page) return;
        // URL 指定子tab/日期 → 先预置到模块（switchTab激活模块时生效）
        if (route.sub) {
            if (route.page === 'fupan' && typeof Fupan !== 'undefined' && Fupan.presetSub) {
                Fupan.presetSub(route.sub);
            } else if (route.page === 'market' && ['all', 'focus'].includes(route.sub)) {
                // TODO16.3：市场行情页二级tab直达（#/market/focus 关注异动）
                switchMarketSub(route.sub, false);
            }
        }
        if (route.date && route.page === 'fupan' && typeof Fupan !== 'undefined' && Fupan.presetDate) {
            Fupan.presetDate(route.date);
        }
        routeState.page = route.page;
        routeState.sub = route.sub || lastSubByPage[route.page] || null;
        if (route.page !== 'fupan') routeState.date = null;
        switchTab(route.page);
        // settings 二级tab直达：复用initSettingsTabs已绑定的点击事件
        if (route.page === 'settings' && route.sub && VALID_SUB_TABS.settings.includes(route.sub)) {
            const btn = document.querySelector(`[data-settings-tab="${route.sub}"]`);
            if (btn) btn.click();
        }
    }

    /**
     * 解析 URL 路由（同时兼容 query 参数和 hash 两种风格）
     *  - query：   ?page=fupan&sub=zt&date=2026-09-11
     *  - hash：    #/fupan/zt?date=2026-09-11（更干净，支持书签）
     * hash 优先级高于 query（用户显式 bookmark 的 URL 不应被 query 覆盖）。
     * @returns {{page: string, sub: string|null, date: string|null}}
     */
    function parseRoute() {
        const validTabs = ['market', 'fupan', 'watchlist', 'settings'];
        const params = new URLSearchParams(window.location.search);

        let page = params.get('page');
        let sub = params.get('sub');
        let date = params.get('date');

        // hash 路由覆盖：#/page/sub 或 #/page/sub?date=xxx
        const hash = window.location.hash;
        if (hash && hash.startsWith('#/')) {
            const [path, hashQs] = hash.slice(2).split('?');
            const parts = path.split('/').filter(Boolean);
            if (parts.length >= 1 && validTabs.includes(parts[0])) {
                page = parts[0];
                if (parts.length >= 2 && VALID_SUB_TABS[page]?.includes(parts[1])) {
                    sub = parts[1];
                }
            }
            if (hashQs) {
                const hp = new URLSearchParams(hashQs);
                if (hp.get('date')) date = hp.get('date');
            }
        }

        // 校验 page/sub 合法性
        if (!validTabs.includes(page)) page = null;
        if (sub && VALID_SUB_TABS[page] && !VALID_SUB_TABS[page].includes(sub)) sub = null;

        return { page, sub, date };
    }

    /**
     * 初始化左侧菜单tab
     * 优先级：URL路由（hash > query） > localStorage记忆 > 默认market
     * 初始化完成后地址栏hash同步为当前路由（URL始终可收藏），并监听：
     * - 子tab/日期变化事件（模块dispatch）→ 同步hash
     * - hashchange（手动改URL/前进后退）→ 按新路由切换
     */
    function initTabs() {
        const route = parseRoute();
        const validTabs = ['market', 'fupan', 'watchlist', 'settings'];

        let saved = 'market';
        if (route.page && validTabs.includes(route.page)) {
            saved = route.page;
        } else {
            try {
                saved = localStorage.getItem(ACTIVE_TAB_KEY) || 'market';
            } catch (e) { /* 忽略 */ }
            if (!validTabs.includes(saved)) saved = 'market';
        }

        // 统一入口：预置子tab/日期 → 切主tab → settings子tab直达
        applyRoute({ page: saved, sub: route.sub, date: route.date });
        // 初始同步hash（原地替换，不加历史记录）
        syncRouteHash(false);

        // 菜单点击切换
        document.querySelectorAll('.menu-item').forEach(btn => {
            btn.addEventListener('click', () => {
                switchTab(btn.dataset.tab);
            });
        });

        // 子tab/日期变化 → 同步hash（模块通过CustomEvent解耦上报，仅当前激活tab的事件生效）
        document.addEventListener('dailystock:subchange', (e) => {
            const { page, sub, date } = e.detail || {};
            if (!page || page !== routeState.page) return;
            if (sub && VALID_SUB_TABS[page] && VALID_SUB_TABS[page].includes(sub)) {
                routeState.sub = sub;
                lastSubByPage[page] = sub;
            }
            if (page === 'fupan' && date !== undefined && date !== null) {
                routeState.date = date;
            }
            syncRouteHash(false);
        });

        // hashchange：手动编辑URL或浏览器前进/后退时按新路由切换
        window.addEventListener('hashchange', () => {
            const r = parseRoute();
            if (!r.page) return;
            const subChanged = r.sub && r.sub !== routeState.sub;
            const dateChanged = r.page === 'fupan' && r.date && r.date !== routeState.date;
            if (r.page !== routeState.page) {
                applyRoute(r);
                syncRouteHash(false);
            } else if (subChanged || dateChanged) {
                applyRoute({ page: r.page, sub: subChanged ? r.sub : null, date: dateChanged ? r.date : null });
            }
        });
    }

    /**
     * 初始化设置页二级tab（监控参数/数据缓存/网络代理）
     * 切换tab时同步高亮与面板显隐，并上报子tab变化（main.js同步URL hash）
     */
    function initSettingsTabs() {
        document.querySelectorAll('[data-settings-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.settingsTab;
                // 更新tab按钮高亮
                document.querySelectorAll('[data-settings-tab]').forEach(b => {
                    b.classList.toggle('active', b === btn);
                });
                // 切换对应面板显隐
                document.querySelectorAll('.settings-tab-panel').forEach(panel => {
                    panel.classList.toggle('active', panel.dataset.settingsPanel === tab);
                });
                // TODO12：上报子tab变化（URL hash同步 #/settings/{tab}）
                document.dispatchEvent(new CustomEvent('dailystock:subchange', {
                    detail: { page: 'settings', sub: tab }
                }));
            });
        });
    }

    /**
     * 初始化嵌入模式（被统一外壳iframe加载时）
     * 主流程：
     * 1. embedded=1 时给body加embedded类（CSS隐藏自身左侧菜单，外壳菜单已承担导航）
     * 2. 监听外壳postMessage消息，实现同应用内无刷新切换tab
     */
    function initEmbedded() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('embedded') === '1') {
            document.body.classList.add('embedded');
        }

        // 接收统一外壳的导航消息：
        // {type:'dailystock:navigate', page, sub?}
        //   page: market|fupan|watchlist|settings
        //   sub:  可选二级子tab（market: all/focus; fupan: market/sectors/zt/score; settings: monitor/cache/proxy）
        window.addEventListener('message', (event) => {
            const data = event.data;
            if (data && data.type === 'dailystock:navigate' &&
                ['market', 'fupan', 'watchlist', 'settings'].includes(data.page)) {
                switchTab(data.page);
                // runtime 子tab跳转：fupan 在已激活后通过模块自身 API 切
                if (data.sub) {
                    if (data.page === 'market' && ['all', 'focus'].includes(data.sub)) {
                        switchMarketSub(data.sub);
                    } else if (data.page === 'fupan' && typeof Fupan !== 'undefined' && Fupan.presetSub) {
                        Fupan.presetSub(data.sub);
                        // 直接让 Fupan 重激活（或等待下次 loadDate 时读子tab）
                        if (typeof Fupan.switchSub === 'function') Fupan.switchSub(data.sub);
                    } else if (data.page === 'settings' && VALID_SUB_TABS.settings.includes(data.sub)) {
                        const btn = document.querySelector(`[data-settings-tab="${data.sub}"]`);
                        if (btn) btn.click();
                    }
                }
            }
        });
    }

    /**
     * 绑定事件
     */
    function bindEvents() {
        // 日期选择器
        document.getElementById('datePicker').addEventListener('change', function () {
            const val = this.value;
            if (!val) {
                selectedDate = null;
            } else {
                selectedDate = val;
            }
            // 清空缓存，强制刷新
            StockAPI.clearAllCache();
            run(true);
        });

        // 刷新按钮（强制清缓存刷新）
        document.getElementById('btnRefresh').addEventListener('click', () => {
            run(true);
        });

        // 重试按钮
        document.getElementById('btnRetry').addEventListener('click', () => {
            Renderer.hideError();
            run(true);
        });

        // 保存设置按钮（设置已从弹窗迁入独立页面，无弹窗关闭逻辑）
        document.getElementById('btnSaveSettings').addEventListener('click', () => {
            readSettingsUI();
            saveConfig();
            // 保存成功反馈（按钮文字临时变化）
            const btn = document.getElementById('btnSaveSettings');
            const original = btn.textContent;
            btn.textContent = '已保存';
            setTimeout(() => { btn.textContent = original; }, 1500);
            // 配置变更后强制刷新
            startAutoRefresh();
            run(true);
        });

        // 测试代理按钮
        document.getElementById('btnTestProxy').addEventListener('click', async () => {
            await testProxyConnection();
        });

        // 表头排序（事件委托：每个表格的表头只排序自己的tbody；支持动态增删的T+N列）
        // 普通浏览视图29列宽表由Watchlist模块基于行数据排序，此处排除
        document.querySelectorAll('.stock-table').forEach(table => {
            if (table.id === 'wlBrowseTable') return;
            const tbody = table.querySelector('tbody');
            if (!tbody) return;
            table.addEventListener('click', e => {
                const th = e.target.closest('th[data-sort]');
                if (!th || !table.contains(th)) return;
                sortTable(th.dataset.sort, th, tbody);
            });
        });

        // 手动清理K线缓存（设置页）
        document.getElementById('btnClearKlineCache').addEventListener('click', () => {
            StockAPI.clearKlineCache();
            updateCacheStats();
            const btn = document.getElementById('btnClearKlineCache');
            const original = btn.textContent;
            btn.textContent = '已清理';
            setTimeout(() => { btn.textContent = original; }, 1500);
        });
    }

    /**
     * 更新设置页缓存占用统计（条数+近似占用空间）
     */
    function updateCacheStats() {
        const stats = StockAPI.getCacheStats();
        document.getElementById('cacheStats').textContent =
            '当前K线缓存：' + stats.count + ' 只，占用约 ' + stats.sizeKB + ' KB';
    }

    /**
     * 测试代理连通性
     * 用东方财富clist API作为测试目标
     */
    async function testProxyConnection() {
        const btnTest = document.getElementById('btnTestProxy');
        const resultDiv = document.getElementById('proxyTestResult');
        const resultText = document.getElementById('proxyTestText');

        // 先读取当前设置面板的代理配置
        readSettingsUI();

        btnTest.disabled = true;
        btnTest.textContent = '测试中...';
        resultDiv.style.display = 'block';
        resultText.textContent = '正在测试代理连通性...';
        resultText.style.color = '#94a3b8';

        try {
            // 用clist API作为测试目标（轻量级请求）
            const testUrl = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=1&po=1&np=1&ut=b2884a393a59ad64002292a3e90d46a5&fltt=2&invt=2&fid=f3&fs=m:1+t:2&fields=f12,f14&_t=' + Date.now();

            const startTime = Date.now();
            const data = await fetchProxyTest(testUrl);
            const elapsed = Date.now() - startTime;

            if (data && data.data) {
                resultText.textContent = `代理连通成功！耗时 ${elapsed}ms`;
                resultText.style.color = '#10b981';
            } else {
                resultText.textContent = `代理返回数据异常，耗时 ${elapsed}ms`;
                resultText.style.color = '#f59e0b';
            }
        } catch (error) {
            resultText.textContent = '代理连通失败: ' + error.message;
            resultText.style.color = '#ef4444';
        } finally {
            btnTest.disabled = false;
            btnTest.textContent = '测试代理';
        }
    }

    /**
     * 通过代理发送测试请求
     */
    async function fetchProxyTest(targetUrl) {
        const proxyConfig = StockAPI.getProxyConfig();
        const proxyUrl = proxyConfig.primaryUrl;
        if (!proxyUrl) throw new Error('未配置代理地址');

        const base = proxyUrl.replace(/\/+$/, '');
        const fullUrl = base + '/proxy?target=' + encodeURIComponent(targetUrl);

        const headers = { 'Accept': 'application/json' };
        if (proxyConfig.token) headers['X-Proxy-Token'] = proxyConfig.token;

        const resp = await fetch(fullUrl, { headers });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return await resp.json();
    }

    /**
     * 表格排序
     * @param {string} field - 排序字段
     * @param {HTMLElement} th - 表头元素
     * @param {HTMLElement} tbody - 目标表体（支持市场行情页/自选页各自排序）
     */
    function sortTable(field, th, tbody) {
        const rows = Array.from(tbody.querySelectorAll('tr'));

        if (rows.length === 0) return;

        // 切换排序方向（排序态限定在当前表格内）：当前升序则改降序，否则改升序
        const isAsc = th.classList.contains('sort-asc');
        const table = th.closest('table');
        table.querySelectorAll('th').forEach(h => {
            h.classList.remove('sort-asc', 'sort-desc');
        });
        th.classList.add(isAsc ? 'sort-desc' : 'sort-asc');

        const direction = isAsc ? -1 : 1;

        rows.sort((a, b) => {
            const cellsA = a.querySelectorAll('td');
            const cellsB = b.querySelectorAll('td');

            let valA, valB;
            // T+N触发列：列索引 = 天数N + 8（排名0,名称1,代码2,日期3,当前幅度4,异动类型5,偏离值6,是否触发7,触发8开始）
            // 通用triggerN匹配（TODO16.3.1：列数随forwardDays动态增减）
            const trigMatch = field.match(/^trigger(\d+)$/);

            switch (true) {
                case field === 'name':
                    valA = cellsA[1].textContent;
                    valB = cellsB[1].textContent;
                    return direction * valA.localeCompare(valB, 'zh');
                case field === 'change':
                    valA = parseFloat(cellsA[4].textContent) || 0;
                    valB = parseFloat(cellsB[4].textContent) || 0;
                    break;
                case !!trigMatch:
                    // 触发格含换行触发价格（"10.07%\n12.34"），parseFloat取首个数值即涨幅
                    valA = parseFloat(cellsA[parseInt(trigMatch[1]) + 8].textContent) || 999;
                    valB = parseFloat(cellsB[parseInt(trigMatch[1]) + 8].textContent) || 999;
                    break;
                default:
                    return 0;
            }

            return direction * (valA - valB);
        });

        // 重新插入排序后的行
        rows.forEach(row => tbody.appendChild(row));
    }

    /**
     * 初始化应用
     * 主流程：加载配置 → 初始化渲染器/自选模块 → 恢复tab记忆 → 嵌入模式 → 绑定事件 → 加载数据
     */
    function init() {
        loadConfig();
        Renderer.init();
        Watchlist.init();       // 自选模块（内部分组栏初始化并懒加载浏览视图）
        initTabs();             // 左侧菜单tab（URL参数page优先，其次恢复上次选中tab）
        initEmbedded();         // 嵌入模式（统一外壳iframe加载时隐藏自身菜单+监听导航消息）
        initDatePicker();
        initMarketSubTabs();    // 市场行情页二级tab（TODO16.3：市场异动/关注异动，恢复持久化状态）
        initMarketSearch();     // 市场行情页搜索添加关注异动监控股票
        initSettingsUI();       // 设置页为常驻页面，初始化时同步当前配置值
        initSettingsTabs();     // 设置页二级tab（监控参数/数据缓存/网络代理）
        bindEvents();
        startAutoRefresh();
        run(); // 首次加载使用缓存
    }

    // 页面加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return {
        init,
        run,
        // 关注异动监控（renderer操作列移除按钮转发）
        removeCustomMonitor,
        removeCustomMonitorBatch,
        // TODO16.1：自选列表"查询异动"列入口（跳转个股异动空间=市场行情页关注异动tab）
        showStockUnusual
    };
})();
