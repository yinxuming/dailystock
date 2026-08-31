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
 * 页面结构（左侧菜单栏三页）：
 * - market：市场行情（原有异动监控）
 * - watchlist：自选（Watchlist模块，二级菜单+CSV导入导出+搜索）
 * - settings：设置（原顶部设置弹窗迁入）
 * - tab切换状态持久化：进入首页时恢复最后一次选中的tab
 */
const App = (function () {

    // 默认配置
    const DEFAULT_CONFIG = {
        topN: 50,               // 每个榜单获取数量
        forwardDays: 4,         // 提前天数（默认4天：T+0~T+3）
        autoRefresh: 0,         // 自动刷新间隔(秒)，0=关闭（默认不自动刷新）
        onlyRisk: true,         // 仅显示有异动风险的股票
        concurrency: 2          // API并发数
    };

    // 左侧菜单tab持久化key
    const ACTIVE_TAB_KEY = 'unusual_active_tab';

    // 运行状态
    let config = { ...DEFAULT_CONFIG };
    let autoRefreshTimer = null;
    let isLoading = false;
    let selectedDate = null; // 用户选择的日期（YYYY-MM-DD），null=自动

    /**
     * 从localStorage加载配置
     */
    function loadConfig() {
        try {
            const saved = localStorage.getItem('unusual_config');
            if (saved) {
                const parsed = JSON.parse(saved);
                // 迁移旧配置：forwardDays从5改为4
                if (parsed.forwardDays && parsed.forwardDays > 4) {
                    parsed.forwardDays = 4;
                }
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

    /**
     * 初始化设置面板的值
     */
    function initSettingsUI() {
        document.getElementById('settingTopN').value = config.topN;
        document.getElementById('settingForwardDays').value = config.forwardDays;
        document.getElementById('settingAutoRefresh').value = config.autoRefresh;
        document.getElementById('settingRequestInterval').value = StockAPI.getRequestInterval();
        document.getElementById('settingOnlyRisk').checked = config.onlyRisk;

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
        config.onlyRisk = document.getElementById('settingOnlyRisk').checked;

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

            // 第0步：检查识别结果缓存
            if (!forceRefresh) {
                const cachedResults = StockAPI.getResultCache();
                if (cachedResults && cachedResults.length > 0) {
                    console.log('使用缓存结果，共' + cachedResults.length + '只');
                    Renderer.renderTable(cachedResults, config.forwardDays, targetDate);
                    updateDataInfo(cachedResults, targetDate);
                    return;
                }
            }

            // 第1步：获取阶段涨幅候选股票
            Renderer.showLoading('正在获取阶段涨幅排行...');
            const stocks = await StockAPI.getCandidateStocks(config.topN);

            if (stocks.length === 0) {
                Renderer.renderEmpty('未获取到候选股票数据，可能非交易时间');
                return;
            }

            console.log(`候选股票: ${stocks.length}只`);

            // 第2步：批量获取K线数据（只对候选股票请求，大幅减少请求量）
            Renderer.showLoading('正在获取K线数据... (0/' + stocks.length + ')');
            const klineMap = await StockAPI.batchGetKline(
                stocks.map(s => s.secid),
                config.concurrency,
                (completed, total) => Renderer.updateProgress(completed, total)
            );

            // 第2.5步：获取基准指数K线数据（用于偏离值计算）
            Renderer.showLoading('正在获取基准指数数据...');
            const indexKlineMap = await StockAPI.getBenchmarkIndices(stocks, 40);
            console.log('基准指数获取完成:', Array.from(indexKlineMap.keys()).join(', '));

            // 第3步：计算异动分析（传入指数K线数据和交易日偏移量）
            Renderer.showLoading('正在计算异动分析...');
            let results = UnusualCalculator.analyzeStocks(
                stocks,
                klineMap,
                indexKlineMap,
                config.forwardDays,
                config.onlyRisk,
                tradeDayOffset
            );

            // 如果仅显示可触发风险股票且结果为空，尝试显示全部
            if (results.length === 0 && config.onlyRisk) {
                results = UnusualCalculator.analyzeStocks(
                    stocks,
                    klineMap,
                    indexKlineMap,
                    config.forwardDays,
                    false,
                    tradeDayOffset
                );
            }

            // 第4步：缓存识别结果
            if (results.length > 0) {
                StockAPI.setResultCache(results);
            }

            // 第5步：渲染结果
            if (results.length === 0) {
                Renderer.renderEmpty('当前无股票接近异动线');
            } else {
                Renderer.renderTable(results, config.forwardDays, targetDate);
            }

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
     * 主流程：更新菜单按钮态 → 切换页面显隐 → 持久化tab状态
     * @param {string} tab - market|watchlist|settings
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
        // 记住最后一次选中的tab
        try {
            localStorage.setItem(ACTIVE_TAB_KEY, tab);
        } catch (e) {
            console.warn('保存tab状态失败:', e);
        }
    }

    /**
     * 初始化左侧菜单tab
     * 优先级：URL参数page > localStorage记忆（无记录时默认market），并绑定菜单点击事件
     * URL参数page用于统一外壳（dailystock）iframe 定位到指定tab
     */
    function initTabs() {
        // 统一外壳通过URL参数page指定初始tab（market|watchlist|settings）
        const urlPage = new URLSearchParams(window.location.search).get('page');
        let saved = 'market';
        if (urlPage && ['market', 'watchlist', 'settings'].includes(urlPage)) {
            saved = urlPage;
        } else {
            try {
                saved = localStorage.getItem(ACTIVE_TAB_KEY) || 'market';
            } catch (e) { /* 忽略 */ }
            if (!['market', 'watchlist', 'settings'].includes(saved)) saved = 'market';
        }
        switchTab(saved);

        // 菜单点击切换
        document.querySelectorAll('.menu-item').forEach(btn => {
            btn.addEventListener('click', () => {
                switchTab(btn.dataset.tab);
            });
        });
    }

    /**
     * 初始化设置页二级tab（监控参数/数据缓存/网络代理）
     * 切换tab时同步高亮与面板显隐
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

        // 接收统一外壳的导航消息：{type:'dailystock:navigate', page:'market'|'watchlist'|'settings'}
        window.addEventListener('message', (event) => {
            const data = event.data;
            if (data && data.type === 'dailystock:navigate' &&
                ['market', 'watchlist', 'settings'].includes(data.page)) {
                switchTab(data.page);
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

        // 表头排序（每个表格的表头只排序自己的tbody，市场行情页与自选风险页互不影响）
        // 普通浏览视图27列宽表由Watchlist模块基于行数据排序，此处排除
        document.querySelectorAll('.stock-table').forEach(table => {
            if (table.id === 'wlBrowseTable') return;
            const tbody = table.querySelector('tbody');
            if (!tbody) return;
            table.querySelectorAll('th[data-sort]').forEach(th => {
                th.addEventListener('click', () => {
                    sortTable(th.dataset.sort, th, tbody);
                });
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

            switch (field) {
                case 'name':
                    valA = cellsA[1].textContent;
                    valB = cellsB[1].textContent;
                    return direction * valA.localeCompare(valB, 'zh');
                case 'change':
                    valA = parseFloat(cellsA[4].textContent) || 0;
                    valB = parseFloat(cellsB[4].textContent) || 0;
                    break;
                case 'trigger0':
                case 'trigger1':
                case 'trigger2':
                case 'trigger3':
                case 'trigger4':
                    // 列索引：排名0,名称1,代码2,日期3,当前幅度4,异动类型5,偏离值6,是否触发7,触发8开始
                    const colIndex = parseInt(field.replace('trigger', '')) + 8;
                    valA = parseFloat(cellsA[colIndex].textContent) || 999;
                    valB = parseFloat(cellsB[colIndex].textContent) || 999;
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
        Watchlist.init();       // 自选模块（内部会恢复二级菜单记忆并懒加载）
        initTabs();             // 左侧菜单tab（URL参数page优先，其次恢复上次选中tab）
        initEmbedded();         // 嵌入模式（统一外壳iframe加载时隐藏自身菜单+监听导航消息）
        initDatePicker();
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

    return { init, run };
})();
