/**
 * 自选股模块
 *
 * 功能：
 * 1. 自选股CRUD：localStorage持久化（代码/名称/市场/备注/添加时间）
 * 2. CSV导入：兼容GBK/UTF-8编码，代码格式兼容 SZ000017 / 000017 / 000017.SZ
 * 3. CSV导出：UTF-8带BOM（Excel兼容），列：名称,代码,备注
 * 4. 搜索添加：输入名称或代码，从全A股列表（含北交所）模糊匹配下拉选择
 * 5. 二级菜单：异动风险视图（默认）/ 普通浏览视图，切换状态记忆
 *    - 异动风险视图：复用UnusualCalculator计算100/200异动触发值（与市场行情页同算法）
 *    - 普通浏览视图：行情快照+阶段涨幅+涨停信息（详见renderBrowseTable），27列全部支持点击表头排序
 * 6. 移除自选股时联动清理该股票K线缓存（StockAPI.removeKlineCache）
 *
 * 数据来源：
 * - 实时行情：东方财富ulist.np批量接口（StockAPI.getQuoteBatch）
 * - K线：东方财富kline接口（StockAPI.batchGetKline，浏览视图limit=260覆盖今年来涨幅）
 * - 涨停池/涨停时间：东方财富push2ex（StockAPI.getZTPool）
 * - 涨停原因：同花顺dataapi（StockAPI.getTHSZTReason，失败降级显示--）
 */
const Watchlist = (function () {

    // ===== 常量配置 =====
    const STORAGE_KEY = 'unusual_watchlist';   // 自选股持久化key
    const SUBTAB_KEY = 'unusual_wl_subtab';    // 二级菜单记忆key
    const FORWARD_DAYS = 4;                    // 异动风险视图提前天数（T+0~T+3，与市场行情页一致）
    const BROWSE_KLINE_LIMIT = 260;            // 浏览视图K线数量（覆盖今年来涨幅计算）
    const SEARCH_LIMIT = 20;                   // 搜索下拉最大条数

    // ===== 运行状态 =====
    let wlRenderer = null;          // 异动风险视图渲染器实例（Renderer工厂创建）
    let currentSubTab = 'risk';     // 当前二级菜单：risk|browse
    let isRiskLoading = false;      // 异动风险视图加载中标记
    let isBrowseLoading = false;    // 浏览视图加载中标记
    let allStocks = null;           // 全A股列表缓存（搜索用，当日有效，由StockAPI管理缓存）
    let searchTimer = null;         // 搜索防抖定时器
    let browseRows = [];            // 浏览视图当前行数据（表头排序基于此数据重渲染）
    const viewLoaded = { risk: false, browse: false }; // 各视图是否已加载过（懒加载标记）

    // 浏览视图可排序字段 → 行数据取值器（与index.html表头data-sort属性一一对应）
    const BROWSE_SORT_FIELDS = {
        code: r => r.code,
        name: r => r.name,
        floatMV: r => r.floatMV,
        totalMV: r => r.totalMV,
        changePercent: r => r.changePercent,
        auctionGain: r => r.auctionGain,
        turnover: r => r.turnover,
        volumeRatio: r => r.volumeRatio,
        mainNet: r => r.mainNet,
        amount: r => r.amount,
        upDays: r => r.upDays,
        zt10: r => r.zt10,
        zt30: r => r.zt30,
        ztTime: r => r.ztTime,
        ztReason: r => r.ztReason,
        prevDay: r => r.gains.prevDay,
        yesterday: r => r.gains.yesterday,
        d2: r => r.gains.d2,
        d3: r => r.gains.d3,
        d5: r => r.gains.d5,
        d10: r => r.gains.d10,
        d20: r => r.gains.d20,
        d25: r => r.gains.d25,
        d30: r => r.gains.d30,
        ytd: r => r.gains.ytd,
        note: r => r.note
    };

    // ============================================================
    // 自选数据存储（localStorage）
    // ============================================================

    /**
     * 读取自选股列表
     * @returns {Array} [{code, market, name, note, addedAt}]
     */
    function getList() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list : [];
        } catch (e) {
            console.warn('读取自选股失败:', e.message);
            return [];
        }
    }

    /**
     * 保存自选股列表
     * @param {Array} list - 自选股列表
     */
    function saveList(list) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        } catch (e) {
            console.warn('保存自选股失败:', e.message);
        }
    }

    /**
     * 判断股票是否已在自选中
     * @param {string} code - 股票代码
     * @returns {boolean}
     */
    function isInList(code) {
        return getList().some(s => s.code === code);
    }

    /**
     * 添加股票到自选
     * @param {string} code - 股票代码（6位数字）
     * @param {string} name - 股票名称
     * @param {number} market - 市场编号（0=深/北，1=沪）
     * @returns {boolean} 是否添加成功（已存在返回false）
     */
    function addStock(code, name, market) {
        if (isInList(code)) return false;
        const list = getList();
        list.push({
            code: code,
            market: market,
            name: name,
            note: '',
            addedAt: Date.now()
        });
        saveList(list);
        return true;
    }

    /**
     * 从自选移除股票（联动清理该股票的K线缓存及LRU索引）
     * @param {string} code - 股票代码
     * @returns {boolean} 是否移除成功
     */
    function removeStock(code) {
        const list = getList();
        const idx = list.findIndex(s => s.code === code);
        if (idx === -1) return false;
        const stock = list[idx];
        list.splice(idx, 1);
        saveList(list);
        // 联动清理K线缓存（StockAPI.removeKlineCache同时移除LRU索引记录；Node测试环境无StockAPI时跳过）
        if (typeof StockAPI !== 'undefined' && stock.market !== undefined) {
            StockAPI.removeKlineCache(stock.market + '.' + stock.code);
        }
        return true;
    }

    /**
     * 更新自选股备注
     * @param {string} code - 股票代码
     * @param {string} note - 备注内容
     */
    function updateNote(code, note) {
        const list = getList();
        const stock = list.find(s => s.code === code);
        if (stock) {
            stock.note = note || '';
            saveList(list);
        }
    }

    // ============================================================
    // 代码格式工具
    // ============================================================

    /**
     * 根据市场编号获取前缀（用于导出SZ000017格式）
     * 北证代码段：8/4/92开头（92为北证2024年新增代码段）
     * @param {number} market - 市场编号
     * @param {string} code - 股票代码（用于北证判断）
     * @returns {string} SH|SZ|BJ
     */
    function getMarketPrefix(market, code) {
        if (code && (code.startsWith('8') || code.startsWith('4') || code.startsWith('92'))) return 'BJ';
        return market === 1 ? 'SH' : 'SZ';
    }

    /**
     * 规范化代码字段（纯函数，供CSV解析与Node测试用）
     * 兼容格式：SZ000017 / SH600371 / BJ832566 / 000017 / 600371 / 000017.SZ
     * @param {string} field - 原始代码字段
     * @returns {Object|null} {code, market}，无法解析返回null
     */
    function normalizeCodeField(field) {
        if (field === null || field === undefined) return null;
        let s = String(field).trim().toUpperCase().replace(/["']/g, '');
        let market = null;

        // 前缀格式：SZ000017
        const m1 = s.match(/^(SH|SZ|BJ)(\d{4,6})$/);
        if (m1) {
            market = (m1[1] === 'SH') ? 1 : 0;
            s = m1[2];
        } else {
            // 后缀格式：000017.SZ
            const m2 = s.match(/^(\d{4,6})\.(SH|SZ|BJ)$/);
            if (m2) {
                market = (m2[2] === 'SH') ? 1 : 0;
                s = m2[1];
            }
        }

        // 提取数字部分，必须为6位
        const digits = s.replace(/\D/g, '');
        if (!/^\d{6}$/.test(digits)) return null;

        // 无前缀时按代码推断市场：6开头沪市，其余深/北
        if (market === null) {
            market = digits.startsWith('6') ? 1 : 0;
        }
        return { code: digits, market: market };
    }

    // ============================================================
    // CSV导入导出
    // ============================================================

    /**
     * 解码CSV文件内容（纯函数，供Node测试用）
     * 先尝试UTF-8严格解码，失败则回退GBK（同花顺导出为GBK编码）
     * @param {ArrayBuffer} buffer - 文件二进制内容
     * @returns {string} 解码后的文本
     */
    function decodeCSVBuffer(buffer) {
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        } catch (e) {
            // UTF-8解码失败（含中文GBK字节），回退GBK解码
            try {
                return new TextDecoder('gbk').decode(buffer);
            } catch (e2) {
                console.warn('GBK解码失败，使用默认解码:', e2.message);
                return new TextDecoder().decode(buffer);
            }
        }
    }

    /**
     * 解析CSV文本为股票列表（纯函数，供Node测试用）
     *
     * 列识别规则：代码列/名称列位置不固定，但列头名称固定
     * - 首行为表头时：按列头文本识别"代码/code"列与"名称/简称"列的索引，表头行跳过
     * - 无表头或表头无法识别时：回退旧格式约定（第1列名称，第2列代码）
     * 兼容示例：`名称,代码`、`代码,    名称`（表头允许带空格）、无表头 `深中华A,SZ000017`
     *
     * @param {string} text - CSV文本
     * @returns {Object} {stocks: [{name, code, market}], failed: 行号数组}
     */
    function parseCSVText(text) {
        const stocks = [];
        const failed = [];
        const seen = new Set();
        const lines = String(text || '').split(/\r?\n/);

        // ===== 第1步：识别表头列索引（列头名称固定，位置不固定） =====
        let codeIdx = -1;  // 代码列索引
        let nameIdx = -1;  // 名称列索引
        let dataStart = 0; // 数据起始行号（识别到表头时跳过表头行）

        if (lines.length > 0 && lines[0]) {
            const headerCells = lines[0].split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
            headerCells.forEach((cell, i) => {
                // 代码列头：含"代码"或纯"code"
                if (codeIdx < 0 && /代码/i.test(cell)) codeIdx = i;
                // 名称列头：含"名称"或"简称"
                if (nameIdx < 0 && /名称|简称/.test(cell)) nameIdx = i;
            });
            // 识别到代码列头 → 首行为表头，数据从第2行开始
            if (codeIdx >= 0) {
                dataStart = 1;
                // 有代码列但未识别到名称列时，取代码列外的第一列兜底
                if (nameIdx < 0) nameIdx = (codeIdx === 0) ? 1 : 0;
            }
        }

        // 未识别到表头：回退旧格式（第1列名称，第2列代码）
        if (codeIdx < 0) {
            codeIdx = 1;
            nameIdx = 0;
        }

        // ===== 第2步：逐行解析数据 =====
        for (let i = dataStart; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (!trimmed) continue;

            const parts = trimmed.split(',');
            if (parts.length < 2) {
                failed.push(i + 1);
                continue;
            }

            const codeInfo = normalizeCodeField(parts[codeIdx]);
            if (!codeInfo) {
                failed.push(i + 1);
                continue;
            }

            const name = (parts[nameIdx] || '').trim().replace(/^["']|["']$/g, '');

            // 去重
            if (seen.has(codeInfo.code)) continue;
            seen.add(codeInfo.code);
            stocks.push({
                name: name || codeInfo.code,
                code: codeInfo.code,
                market: codeInfo.market
            });
        }

        return { stocks: stocks, failed: failed };
    }

    /**
     * 导入CSV文件（入口：文件选择框change事件）
     * 主流程：读取文件 → 解码 → 解析 → 合并到自选（已存在跳过）
     * @param {File} file - CSV文件对象
     */
    async function importCSVFile(file) {
        try {
            const buffer = await file.arrayBuffer();
            const text = decodeCSVBuffer(buffer);
            const { stocks, failed } = parseCSVText(text);

            if (stocks.length === 0) {
                alert('CSV中未解析到有效股票数据' + (failed.length ? `（${failed.length}行解析失败）` : ''));
                return;
            }

            // 合并导入：已存在的跳过，保留原有备注
            let added = 0;
            let skipped = 0;
            stocks.forEach(s => {
                if (addStock(s.code, s.name, s.market)) {
                    added++;
                } else {
                    skipped++;
                }
            });

            let msg = `导入完成：新增${added}只`;
            if (skipped > 0) msg += `，已存在跳过${skipped}只`;
            if (failed.length > 0) msg += `，${failed.length}行格式无效`;
            alert(msg);

            // 导入后刷新当前视图
            refreshCurrentView(true);
        } catch (e) {
            console.error('CSV导入失败:', e);
            alert('CSV导入失败: ' + e.message);
        }
    }

    /**
     * 导出自选列表为CSV（UTF-8带BOM，Excel可直接打开）
     * 列：名称,代码,备注；代码格式 SZ000017
     */
    function exportCSV() {
        const list = getList();
        if (list.length === 0) {
            alert('自选列表为空，无数据可导出');
            return;
        }

        // 构建CSV内容（\r\n换行，Excel兼容）
        const lines = ['名称,代码,备注'];
        list.forEach(s => {
            // 备注中的逗号/引号按CSV规则转义
            const note = (s.note || '').replace(/"/g, '""');
            const noteField = note ? `"${note}"` : '';
            lines.push(`${s.name},${getMarketPrefix(s.market, s.code)}${s.code},${noteField}`);
        });
        const csvText = lines.join('\r\n');

        // UTF-8 BOM + 下载
        const blob = new Blob(['\ufeff' + csvText], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const today = new Date();
        const dateStr = today.getFullYear() +
            String(today.getMonth() + 1).padStart(2, '0') +
            String(today.getDate()).padStart(2, '0');
        a.href = url;
        a.download = `自选数据_${dateStr}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ============================================================
    // 搜索添加股票
    // ============================================================

    /**
     * 确保全A股列表已加载（首次搜索时懒加载，当日缓存由StockAPI管理）
     */
    async function ensureAllStocksLoaded() {
        if (allStocks && allStocks.length > 0) return;
        const dropdown = document.getElementById('wlSearchDropdown');
        showDropdown('正在加载股票列表...');
        allStocks = await StockAPI.getAllStockList();
        if (!allStocks || allStocks.length === 0) {
            showDropdown('股票列表加载失败，请稍后重试');
        }
    }

    /**
     * 显示搜索下拉内容
     * @param {string|Array} content - 提示文本或建议列表 [{code, name, market}]
     */
    function showDropdown(content) {
        const dropdown = document.getElementById('wlSearchDropdown');
        dropdown.innerHTML = '';
        dropdown.style.display = 'block';

        if (typeof content === 'string') {
            const div = document.createElement('div');
            div.className = 'search-hint';
            div.textContent = content;
            dropdown.appendChild(div);
            return;
        }

        content.forEach(item => {
            const div = document.createElement('div');
            div.className = 'search-item' + (isInList(item.code) ? ' search-item-exists' : '');
            div.innerHTML = `<span class="search-item-name"></span><span class="search-item-code"></span>`;
            div.querySelector('.search-item-name').textContent = item.name;
            div.querySelector('.search-item-code').textContent =
                getMarketPrefix(item.market, item.code) + item.code + (isInList(item.code) ? ' (已添加)' : '');
            div.addEventListener('click', () => {
                if (isInList(item.code)) return;
                addStock(item.code, item.name, item.market);
                hideDropdown();
                document.getElementById('wlSearchInput').value = '';
                refreshCurrentView(false);
            });
            dropdown.appendChild(div);
        });

        if (content.length === 0) {
            const div = document.createElement('div');
            div.className = 'search-hint';
            div.textContent = '未找到匹配的股票';
            dropdown.appendChild(div);
        }
    }

    /** 隐藏搜索下拉 */
    function hideDropdown() {
        document.getElementById('wlSearchDropdown').style.display = 'none';
    }

    /**
     * 执行搜索（防抖后调用）
     * @param {string} keyword - 搜索关键词（名称或代码）
     */
    async function doSearch(keyword) {
        const kw = keyword.trim();
        if (!kw) {
            hideDropdown();
            return;
        }

        await ensureAllStocksLoaded();
        if (!allStocks || allStocks.length === 0) return;

        // 模糊匹配：代码前缀 或 名称包含
        const kwUpper = kw.toUpperCase();
        const matched = allStocks.filter(s =>
            s.code.startsWith(kwUpper) || (s.name && s.name.includes(kw))
        ).slice(0, SEARCH_LIMIT);

        showDropdown(matched);
    }

    /**
     * 初始化搜索框事件（输入防抖 + 下拉外点击关闭）
     */
    function initSearch() {
        const input = document.getElementById('wlSearchInput');
        input.addEventListener('input', function () {
            clearTimeout(searchTimer);
            const val = this.value;
            searchTimer = setTimeout(() => doSearch(val), 250);
        });

        // 点击下拉外区域关闭
        document.addEventListener('click', (e) => {
            const box = document.querySelector('.search-box');
            if (box && !box.contains(e.target)) {
                hideDropdown();
            }
        });
    }

    // ============================================================
    // 二级菜单切换
    // ============================================================

    /**
     * 仅应用二级菜单UI状态（不触发数据加载，初始化时用）
     * @param {string} sub - risk|browse
     */
    function applySubTabState(sub) {
        currentSubTab = sub;
        localStorage.setItem(SUBTAB_KEY, sub);
        document.querySelectorAll('.sub-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.sub === sub);
        });
        document.getElementById('wlRiskView').style.display = sub === 'risk' ? 'block' : 'none';
        document.getElementById('wlBrowseView').style.display = sub === 'browse' ? 'block' : 'none';
    }

    /**
     * 切换二级菜单（异动风险/普通浏览）
     * 主流程：更新UI状态 → 视图未加载过或强制刷新时加载数据（懒加载）
     * @param {string} sub - risk|browse
     * @param {boolean} forceRefresh - 是否强制刷新
     */
    function switchSubTab(sub, forceRefresh = false) {
        applySubTabState(sub);
        // 懒加载：视图未加载过 或 强制刷新 时才拉取数据
        if (forceRefresh || !viewLoaded[sub]) {
            refreshCurrentView(forceRefresh);
        }
    }

    /**
     * 自选tab被激活时回调（main.js切tab时调用）
     * 首次进入自选页时加载当前二级视图数据（懒加载入口）
     */
    function onTabActivated() {
        if (!viewLoaded[currentSubTab]) {
            refreshCurrentView(false);
        }
    }

    /**
     * 刷新当前二级视图
     * @param {boolean} forceRefresh - 是否强制刷新（清K线缓存）
     */
    function refreshCurrentView(forceRefresh) {
        if (currentSubTab === 'risk') {
            viewLoaded.risk = true;
            refreshRisk(forceRefresh);
        } else {
            viewLoaded.browse = true;
            refreshBrowse(forceRefresh);
        }
    }

    /**
     * 初始化二级菜单点击事件
     */
    function initSubTabs() {
        document.querySelectorAll('.sub-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.sub !== currentSubTab) {
                    switchSubTab(btn.dataset.sub);
                }
            });
        });
    }

    // ============================================================
    // 异动风险视图（复用市场行情页异动计算管线）
    // ============================================================

    /**
     * 刷新异动风险视图
     * 主流程：交易日定位 → 批量K线(40) → 基准指数 → 异动计算 → 渲染
     * @param {boolean} forceRefresh - 强制刷新时清K线缓存
     */
    async function refreshRisk(forceRefresh = false) {
        const list = getList();

        // 空列表直接显示空状态
        if (list.length === 0) {
            wlRenderer.renderEmpty('自选列表为空，请通过搜索或导入CSV添加股票');
            document.getElementById('wlCount100').textContent = '0';
            document.getElementById('wlCount200').textContent = '0';
            document.getElementById('wlCountTotal').textContent = '0';
            return;
        }

        if (isRiskLoading) return;
        isRiskLoading = true;

        try {
            // 强制刷新时仅清K线缓存（不影响市场行情页结果缓存）
            if (forceRefresh) {
                StockAPI.clearKlineCache();
            }

            // 交易日定位（与市场行情页run()逻辑一致）
            await TradingCalendar.ensureHolidaysLoaded();
            const targetDate = TradingCalendar.getTargetTradeDate();
            const latestTradeDate = TradingCalendar.getLatestTradeDate();
            const tradeDayOffset = TradingCalendar.getTradeDayOffset(latestTradeDate, targetDate);

            // 构造候选结构（与getCandidateStocks返回结构对齐）
            const stocks = list.map(s => ({
                code: s.code,
                name: s.name,
                market: s.market,
                secid: s.market + '.' + s.code,
                price: 0,
                changePercent: 0,
                gain5d: 0,
                source: '自选'
            }));

            // 批量获取K线
            wlRenderer.showLoading('正在获取自选股K线数据... (0/' + stocks.length + ')');
            const klineMap = await StockAPI.batchGetKline(
                stocks.map(s => s.secid),
                2,
                (completed, total) => wlRenderer.updateProgress(completed, total)
            );

            // 获取基准指数并计算异动
            wlRenderer.showLoading('正在计算异动分析...');
            const indexKlineMap = await StockAPI.getBenchmarkIndices(stocks, 40);
            const results = UnusualCalculator.analyzeStocks(
                stocks,
                klineMap,
                indexKlineMap,
                FORWARD_DAYS,
                true,           // 仅显示有异动风险的
                tradeDayOffset
            );

            // 渲染（统计中自选数量显示总数而非风险数）
            if (results.length === 0) {
                wlRenderer.renderEmpty('当前自选股无100/200异动风险');
            } else {
                wlRenderer.renderTable(results, FORWARD_DAYS, targetDate);
            }
            document.getElementById('wlCountTotal').textContent = list.length;

        } catch (error) {
            console.error('自选异动计算失败:', error);
            wlRenderer.showError('自选数据加载失败: ' + error.message);
        } finally {
            isRiskLoading = false;
        }
    }

    // ============================================================
    // 普通浏览视图（行情快照+阶段涨幅+涨停信息）
    // ============================================================

    /**
     * 刷新普通浏览视图
     * 主流程：批量行情 → 批量K线(260) → 涨停池 → 同花顺涨停原因 → 计算渲染
     * @param {boolean} forceRefresh - 强制刷新时清K线缓存
     */
    async function refreshBrowse(forceRefresh = false) {
        const list = getList();
        const tbody = document.getElementById('wlBrowseTableBody');

        // 空列表处理
        if (list.length === 0) {
            renderBrowseEmpty('自选列表为空，请通过搜索或导入CSV添加股票');
            return;
        }

        if (isBrowseLoading) return;
        isBrowseLoading = true;
        showBrowseLoading('正在加载自选股数据...');

        try {
            if (forceRefresh) {
                StockAPI.clearKlineCache();
            }

            const secids = list.map(s => s.market + '.' + s.code);

            // 1. 批量实时行情
            showBrowseLoading('正在获取实时行情...');
            const quoteMap = await StockAPI.getQuoteBatch(secids);

            // 2. 批量K线（260根，覆盖今年来涨幅）
            showBrowseLoading(`正在获取K线数据... (0/${list.length})`);
            const klineMap = await StockAPI.batchGetKline(
                secids, 2,
                (completed, total) => showBrowseLoading(`正在获取K线数据... (${completed}/${total})`),
                BROWSE_KLINE_LIMIT
            );

            // 3. 涨停池 + 同花顺涨停原因（最新交易日）
            await TradingCalendar.ensureHolidaysLoaded();
            const latestDate = TradingCalendar.getLatestTradeDate().replace(/-/g, '');
            showBrowseLoading('正在获取涨停数据...');
            const [ztPool, thsReason] = await Promise.all([
                StockAPI.getZTPool(latestDate).catch(e => {
                    console.warn('涨停池获取失败:', e.message);
                    return new Map();
                }),
                StockAPI.getTHSZTReason(latestDate).catch(e => new Map())
            ]);

            // 4. 逐股组装行数据并渲染
            const rows = list.map(s => buildBrowseRow(s, quoteMap.get(s.code), klineMap.get(s.market + '.' + s.code), ztPool, thsReason));
            renderBrowseTable(rows);

        } catch (error) {
            console.error('自选浏览数据加载失败:', error);
            hideBrowseLoading();
            document.getElementById('wlBrowseErrorText').textContent = '自选数据加载失败: ' + error.message;
            document.getElementById('wlBrowseError').style.display = 'flex';
            document.getElementById('wlBrowseTableSection').style.display = 'none';
        } finally {
            isBrowseLoading = false;
        }
    }

    /**
     * 组装单只股票的浏览视图行数据
     * @param {Object} stock - 自选股 {code, market, name, note}
     * @param {Object|null} quote - 实时行情
     * @param {Array|null} klines - K线数据
     * @param {Map} ztPool - 涨停池（code -> pool item）
     * @param {Map} thsReason - 同花顺涨停原因（code -> reason item）
     * @returns {Object} 行数据
     */
    function buildBrowseRow(stock, quote, klines, ztPool, thsReason) {
        const k = klines || [];
        const gains = computeStageGains(k);
        const limitRate = UnusualCalculator.getLimitUpRate(stock.code);

        return {
            code: stock.code,
            name: (quote && quote.name) || stock.name,
            note: stock.note || '',
            // 行情快照
            floatMV: quote ? quote.floatMV : null,      // 流通市值(元)
            totalMV: quote ? quote.totalMV : null,      // 总市值(元)
            changePercent: quote ? quote.changePercent : null,  // 最新涨幅%
            auctionGain: computeAuctionGain(quote),     // 竞价涨幅%
            turnover: quote ? quote.turnover : null,    // 换手率%
            volumeRatio: quote ? quote.volumeRatio : null, // 量比
            mainNet: quote ? quote.mainNet : null,      // 主力净额(元)
            amount: quote ? quote.amount : null,        // 成交额(元)
            // K线衍生指标
            upDays: countConsecutiveUp(k),              // 连涨天数
            zt10: countLimitUp(k, 10, limitRate),       // 10日涨停数
            zt30: countLimitUp(k, 30, limitRate),       // 30日涨停数
            // 涨停池信息
            ztTime: formatZTTime(ztPool.get(stock.code)),   // 涨停时间
            ztReason: (thsReason.get(stock.code) || {}).reason || '--', // 涨停原因
            // 阶段涨幅（%）
            gains: gains
        };
    }

    /**
     * 计算竞价涨幅（今开相对昨收）
     * @param {Object|null} quote - 行情
     * @returns {number|null} 竞价涨幅%
     */
    function computeAuctionGain(quote) {
        if (!quote || !quote.open || !quote.prevClose) return null;
        return (quote.open - quote.prevClose) / quote.prevClose * 100;
    }

    /**
     * 计算阶段涨幅（前日/昨日/近N日/今年来，单位%）
     * 约定：klines最后一根为最新交易日
     * @param {Array} klines - K线数组
     * @returns {Object} {prevDay, yesterday, d2, d3, d5, d10, d20, d25, d30, ytd}
     */
    function computeStageGains(klines) {
        const empty = { prevDay: null, yesterday: null, d2: null, d3: null, d5: null, d10: null, d20: null, d25: null, d30: null, ytd: null };
        if (!klines || klines.length < 2) return empty;

        const n = klines.length;
        const last = klines[n - 1];

        // 单日涨幅：昨日=倒数第2根，前日=倒数第3根
        const yesterday = n >= 2 ? klines[n - 2].changePercent : null;
        const prevDay = n >= 3 ? klines[n - 3].changePercent : null;

        // 近N日累计：last.close / close[n-1-N] - 1
        const rangeGain = (days) => {
            if (n < days + 1) return null;
            const base = klines[n - 1 - days].close;
            if (!base) return null;
            return (last.close / base - 1) * 100;
        };

        // 今年来：最新收盘 / 今年第一根K线开盘 - 1（近似去年末收盘）
        let ytd = null;
        const year = last.date ? last.date.substring(0, 4) : null;
        if (year) {
            const firstOfYear = klines.find(k => k.date && k.date.substring(0, 4) === year);
            if (firstOfYear && firstOfYear.open) {
                ytd = (last.close / firstOfYear.open - 1) * 100;
            }
        }

        return {
            prevDay: prevDay,
            yesterday: yesterday,
            d2: rangeGain(2),
            d3: rangeGain(3),
            d5: rangeGain(5),
            d10: rangeGain(10),
            d20: rangeGain(20),
            d25: rangeGain(25),
            d30: rangeGain(30),
            ytd: ytd
        };
    }

    /**
     * 计算连涨天数（从最新K线往前连续上涨的交易日数）
     * @param {Array} klines - K线数组
     * @returns {number} 连涨天数
     */
    function countConsecutiveUp(klines) {
        if (!klines || klines.length === 0) return 0;
        let count = 0;
        for (let i = klines.length - 1; i >= 0; i--) {
            const chg = klines[i].changePercent;
            if (typeof chg === 'number' && chg > 0) {
                count++;
            } else {
                break;
            }
        }
        return count;
    }

    /**
     * 统计近N个交易日涨停天数
     * 判定标准：单日涨幅 >= 涨停幅度-0.2%（考虑四舍五入误差）
     * @param {Array} klines - K线数组
     * @param {number} days - 统计交易日数
     * @param {number} limitRate - 涨停幅度（0.10/0.20/0.30）
     * @returns {number} 涨停天数
     */
    function countLimitUp(klines, days, limitRate) {
        if (!klines || klines.length === 0) return 0;
        const threshold = (limitRate || 0.10) * 100 - 0.2;
        const start = Math.max(0, klines.length - days);
        let count = 0;
        for (let i = start; i < klines.length; i++) {
            const chg = klines[i].changePercent;
            if (typeof chg === 'number' && chg >= threshold) count++;
        }
        return count;
    }

    /**
     * 格式化涨停时间（涨停池fbt字段为HHMMSS数字）
     * @param {Object|null} poolItem - 涨停池条目
     * @returns {string} HH:MM 或 '--'
     */
    function formatZTTime(poolItem) {
        if (!poolItem || poolItem.fbt === null || poolItem.fbt === undefined) return '--';
        const s = String(poolItem.fbt).padStart(6, '0');
        return s.substring(0, 2) + ':' + s.substring(2, 4);
    }

    /**
     * 格式化金额（元 → 亿/万）
     * @param {number|null} value - 金额（元）
     * @returns {string}
     */
    function formatAmount(value) {
        if (value === null || value === undefined || isNaN(value)) return '--';
        const abs = Math.abs(value);
        if (abs >= 1e8) return (value / 1e8).toFixed(2) + '亿';
        if (abs >= 1e4) return (value / 1e4).toFixed(2) + '万';
        return value.toFixed(0);
    }

    /** 格式化涨跌幅（带正负号） */
    function formatPct(value) {
        if (value === null || value === undefined || isNaN(value)) return '--';
        return (value > 0 ? '+' : '') + value.toFixed(2) + '%';
    }

    /** 显示浏览视图加载状态 */
    function showBrowseLoading(text) {
        document.getElementById('wlBrowseLoading').style.display = 'flex';
        document.getElementById('wlBrowseLoadingText').textContent = text;
        document.getElementById('wlBrowseError').style.display = 'none';
        document.getElementById('wlBrowseTableSection').style.display = 'none';
    }

    /** 隐藏浏览视图加载状态 */
    function hideBrowseLoading() {
        document.getElementById('wlBrowseLoading').style.display = 'none';
    }

    /**
     * 渲染浏览视图空状态
     * @param {string} message - 提示信息
     */
    function renderBrowseEmpty(message) {
        hideBrowseLoading();
        const tbody = document.getElementById('wlBrowseTableBody');
        tbody.innerHTML = '';
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 27; // 27列
        td.style.textAlign = 'center';
        td.style.padding = '40px';
        td.style.color = '#64748b';
        td.textContent = message;
        tr.appendChild(td);
        tbody.appendChild(tr);
        document.getElementById('wlBrowseTableSection').style.display = 'block';
    }

    /**
     * 渲染浏览视图表格
     * @param {Array} rows - buildBrowseRow生成的行数据数组
     */
    function renderBrowseTable(rows) {
        browseRows = rows; // 记录当前行数据，供表头排序重渲染使用
        hideBrowseLoading();
        const tbody = document.getElementById('wlBrowseTableBody');
        const fragment = document.createDocumentFragment();

        rows.forEach(row => {
            const tr = document.createElement('tr');
            const g = row.gains;

            // 辅助：创建单元格
            const addTd = (text, className = '') => {
                const td = document.createElement('td');
                td.textContent = text;
                if (className) td.className = className;
                tr.appendChild(td);
                return td;
            };
            // 辅助：带涨跌颜色的涨幅单元格
            const addPctTd = (value) => {
                const cls = value === null || value === undefined ? '' :
                    (value > 0 ? 'change-up' : value < 0 ? 'change-down' : 'change-zero');
                addTd(formatPct(value), cls);
            };

            // 代码（东财链接）
            const tdCode = document.createElement('td');
            tdCode.className = 'bt-sticky-code';
            const link = document.createElement('a');
            link.href = Renderer.getEastmoneyUrl(row.code);
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.className = 'code-link';
            link.textContent = row.code;
            tdCode.appendChild(link);
            tr.appendChild(tdCode);

            // 名称
            addTd(row.name, 'bt-sticky-name');

            // 市值
            addTd(formatAmount(row.floatMV));
            addTd(formatAmount(row.totalMV));

            // 涨幅 / 竞价涨幅
            addPctTd(row.changePercent);
            addPctTd(row.auctionGain);

            // 换手率 / 量比
            addTd(row.turnover === null ? '--' : row.turnover.toFixed(2) + '%');
            addTd(row.volumeRatio === null ? '--' : row.volumeRatio.toFixed(2));

            // 主力净额 / 成交额
            const mainCls = row.mainNet === null ? '' : (row.mainNet > 0 ? 'change-up' : 'change-down');
            addTd(formatAmount(row.mainNet), mainCls);
            addTd(formatAmount(row.amount));

            // 连涨天数 / 涨停统计
            addTd(row.upDays > 0 ? String(row.upDays) + '天' : '--');
            addTd(row.zt10 > 0 ? String(row.zt10) : '0');
            addTd(row.zt30 > 0 ? String(row.zt30) : '0');

            // 涨停时间 / 涨停原因
            addTd(row.ztTime);
            addTd(row.ztReason, 'bt-reason');

            // 阶段涨幅：前日/昨日/近2~30日/今年来
            addPctTd(g.prevDay);
            addPctTd(g.yesterday);
            addPctTd(g.d2);
            addPctTd(g.d3);
            addPctTd(g.d5);
            addPctTd(g.d10);
            addPctTd(g.d20);
            addPctTd(g.d25);
            addPctTd(g.d30);
            addPctTd(g.ytd);

            // 备注（点击编辑）
            const tdNote = document.createElement('td');
            tdNote.className = 'bt-note wl-note';
            tdNote.textContent = row.note || '点击填写';
            tdNote.title = '点击编辑备注';
            tdNote.addEventListener('click', () => {
                const newNote = prompt('编辑备注（' + row.name + ' ' + row.code + '）', row.note || '');
                if (newNote !== null) {
                    updateNote(row.code, newNote.trim());
                    tdNote.textContent = newNote.trim() || '点击填写';
                }
            });
            tr.appendChild(tdNote);

            // 操作：移除
            const tdOp = document.createElement('td');
            tdOp.className = 'bt-op';
            const btnRemove = document.createElement('button');
            btnRemove.className = 'btn btn-secondary btn-sm';
            btnRemove.textContent = '移除';
            btnRemove.addEventListener('click', () => {
                if (confirm('确定从自选中移除 ' + row.name + '（' + row.code + '）？')) {
                    removeStock(row.code);
                    refreshCurrentView(false);
                }
            });
            tdOp.appendChild(btnRemove);
            tr.appendChild(tdOp);

            fragment.appendChild(tr);
        });

        tbody.innerHTML = '';
        tbody.appendChild(fragment);
        document.getElementById('wlBrowseTableSection').style.display = 'block';
    }

    /**
     * 浏览视图表头排序（基于行数据排序后重渲染，27列全部支持）
     * @param {string} field - 排序字段（对应BROWSE_SORT_FIELDS的key）
     * @param {HTMLElement} th - 被点击的表头元素
     */
    function sortBrowseTable(field, th) {
        const getter = BROWSE_SORT_FIELDS[field];
        if (!getter || browseRows.length === 0) return;

        // 切换排序方向：当前升序则改降序，否则改升序
        const isAsc = !th.classList.contains('sort-asc');
        const table = th.closest('table');
        table.querySelectorAll('th').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
        th.classList.add(isAsc ? 'sort-asc' : 'sort-desc');

        const sorted = [...browseRows].sort((a, b) => {
            return compareBrowseValues(getter(a), getter(b)) * (isAsc ? 1 : -1);
        });
        renderBrowseTable(sorted);
    }

    /**
     * 浏览视图排序取值比较：空值恒排最后，数值比大小，字符串本地化比较
     * @param {*} va - 值A
     * @param {*} vb - 值B
     * @returns {number} 比较结果
     */
    function compareBrowseValues(va, vb) {
        const aNull = va === null || va === undefined || va === '';
        const bNull = vb === null || vb === undefined || vb === '';
        if (aNull && bNull) return 0;
        if (aNull) return 1;
        if (bNull) return -1;
        if (typeof va === 'number' && typeof vb === 'number') return va - vb;
        return String(va).localeCompare(String(vb), 'zh');
    }

    /**
     * 初始化浏览视图表头排序事件（main.js的通用排序已排除浏览视图，由此处接管）
     */
    function initBrowseTableSort() {
        document.querySelectorAll('#wlBrowseTable th[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                sortBrowseTable(th.dataset.sort, th);
            });
        });
    }

    // ============================================================
    // 事件绑定与初始化
    // ============================================================

    /**
     * 绑定自选页事件
     */
    function bindEvents() {
        // 导入CSV（隐藏file input触发）
        document.getElementById('btnWlImport').addEventListener('click', () => {
            document.getElementById('wlImportFile').click();
        });
        document.getElementById('wlImportFile').addEventListener('change', function () {
            if (this.files && this.files.length > 0) {
                importCSVFile(this.files[0]);
                this.value = ''; // 允许重复导入同一文件
            }
        });

        // 导出CSV
        document.getElementById('btnWlExport').addEventListener('click', exportCSV);

        // 刷新（当前视图）
        document.getElementById('btnWlRefresh').addEventListener('click', () => {
            refreshCurrentView(true);
        });

        // 重试（当前视图）
        document.getElementById('btnWlRetry').addEventListener('click', () => {
            refreshCurrentView(true);
        });

        // 搜索
        initSearch();

        // 二级菜单
        initSubTabs();

        // 浏览视图表头排序（27列）
        initBrowseTableSort();
    }

    /**
     * 处理自选移除（供异动风险视图操作列回调）
     * @param {string} code - 股票代码
     */
    function handleRemove(code) {
        const list = getList();
        const stock = list.find(s => s.code === code);
        const name = stock ? stock.name : code;
        if (confirm('确定从自选中移除 ' + name + '（' + code + '）？')) {
            removeStock(code);
            refreshCurrentView(false);
        }
    }

    /**
     * 初始化自选模块
     * 主流程：创建渲染器实例 → 绑定事件 → 恢复二级菜单记忆
     */
    function init() {
        // 创建异动风险视图渲染器实例（wl前缀DOM + 移除操作列）
        wlRenderer = Renderer.createTableRenderer({
            tableBody: 'wlTableBody',
            loading: 'wlLoading',
            loadingText: 'wlLoadingText',
            error: 'wlError',
            errorText: 'wlErrorText',
            dataDate: null,     // 自选风险视图无日期元素
            count100: 'wlCount100',
            count200: 'wlCount200',
            countTotal: 'wlCountTotal',
            tableSection: 'wlTableSection',
            table: 'wlStockTable'
        }, { onRemove: handleRemove });
        wlRenderer.init();

        bindEvents();

        // 恢复上次选中的二级菜单（默认risk），仅恢复UI状态不拉数据
        // 数据懒加载：main.js切到自选tab时通过onTabActivated触发
        const saved = localStorage.getItem(SUBTAB_KEY);
        applySubTabState(saved === 'browse' ? 'browse' : 'risk');
    }

    // 公开接口
    return {
        init,
        onTabActivated,
        // 数据操作（供外部/测试调用）
        getList,
        addStock,
        removeStock,
        updateNote,
        // CSV（纯函数供Node测试）
        parseCSVText,
        decodeCSVBuffer,
        normalizeCodeField,
        exportCSV,
        // 视图刷新
        refreshRisk,
        refreshBrowse
    };
})();
