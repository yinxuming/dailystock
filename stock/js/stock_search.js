/**
 * 股票搜索下拉组件（自选页与市场行情页共用）
 *
 * 搜索主源：东方财富suggest接口（StockAPI.searchStockSuggest）
 * - 单次轻量请求，支持中文名称/拼音首字母/代码模糊匹配，输入即时出结果
 * - 修复旧方案问题：首次搜索需经代理连拉11+页全A列表，东财对高频连发请求会
 *   异常断开连接，任一页失败即整体失败且无错误提示（下拉框停在加载中）
 *
 * 降级方案：suggest请求失败时回退全A股列表本地过滤（StockAPI.getAllStockList，
 * 当日缓存+单页重试）；仍失败时下拉框显示错误并可点击重试
 *
 * 用法：
 *   StockSearch.create({
 *       inputId: 'wlSearchInput',       // 搜索输入框id
 *       dropdownId: 'wlSearchDropdown', // 下拉容器id
 *       isExists: (code) => bool,       // 可选，判断是否已添加（显示"已添加"禁用点击）
 *       onPick: (item) => {}            // 选中回调 item={code,name,market,securityType}
 *   });
 */
const StockSearch = (function () {

    const SEARCH_LIMIT = 20;   // 降级本地过滤最大条数
    const DEBOUNCE_MS = 250;   // 输入防抖

    /**
     * 创建搜索框实例
     * @param {Object} opts - 配置 {inputId, dropdownId, isExists?, onPick?}
     * @returns {Object} {doSearch, hide}
     */
    function create(opts) {
        const input = document.getElementById(opts.inputId);
        const dropdown = document.getElementById(opts.dropdownId);
        if (!input || !dropdown) {
            console.warn('StockSearch: 输入框或下拉容器不存在', opts.inputId, opts.dropdownId);
            return { doSearch: function () {}, hide: function () {} };
        }
        const onPick = opts.onPick || function () {};
        const isExists = opts.isExists || function () { return false; };

        let timer = null;   // 输入防抖定时器
        let seq = 0;        // 搜索序号（防止慢响应覆盖新结果）
        let allStocks = null; // 降级用全量列表缓存

        /** 隐藏下拉 */
        function hide() {
            dropdown.style.display = 'none';
        }

        /**
         * 显示提示文本（加载中/未找到/失败）
         * @param {string} text - 提示文本
         * @param {boolean} retry - true时提示可点击重试
         */
        function showMessage(text, retry) {
            dropdown.innerHTML = '';
            dropdown.style.display = 'block';
            const div = document.createElement('div');
            div.className = 'search-hint' + (retry ? ' search-hint-retry' : '');
            div.textContent = text;
            if (retry) {
                div.title = '点击重试';
                div.addEventListener('click', () => doSearch(input.value));
            }
            dropdown.appendChild(div);
        }

        /**
         * 渲染搜索结果列表
         * @param {Array} items - [{code, name, market, securityType}]
         */
        function renderItems(items) {
            dropdown.innerHTML = '';
            dropdown.style.display = 'block';

            if (!items || items.length === 0) {
                showMessage('未找到匹配的股票');
                return;
            }

            items.forEach(item => {
                const exists = isExists(item.code);
                const div = document.createElement('div');
                div.className = 'search-item' + (exists ? ' search-item-exists' : '');

                const nameSpan = document.createElement('span');
                nameSpan.className = 'search-item-name';
                nameSpan.textContent = item.name;

                const codeSpan = document.createElement('span');
                codeSpan.className = 'search-item-code';
                codeSpan.textContent = (item.securityType ? item.securityType + ' ' : '') +
                    item.code + (exists ? ' (已添加)' : '');

                div.appendChild(nameSpan);
                div.appendChild(codeSpan);

                div.addEventListener('click', () => {
                    if (isExists(item.code)) return;
                    hide();
                    input.value = '';
                    onPick(item);
                });
                dropdown.appendChild(div);
            });
        }

        /**
         * 执行搜索（输入防抖后调用）
         * @param {string} keyword - 关键词（名称/拼音/代码）
         */
        async function doSearch(keyword) {
            const mySeq = ++seq;
            const kw = String(keyword || '').trim();
            if (!kw) {
                hide();
                return;
            }

            // 主源：suggest接口（轻量实时）
            showMessage('正在搜索...');
            try {
                const items = await StockAPI.searchStockSuggest(kw);
                if (mySeq !== seq) return; // 已有更新的搜索，丢弃旧结果
                renderItems(items);
                return;
            } catch (e) {
                console.warn('suggest搜索失败，回退全量列表:', e.message);
            }
            if (mySeq !== seq) return;

            // 降级：全A股列表本地过滤（当日缓存+单页重试）
            try {
                showMessage('正在加载股票列表...');
                if (!allStocks || allStocks.length === 0) {
                    allStocks = await StockAPI.getAllStockList();
                }
                if (mySeq !== seq) return;
                if (!allStocks || allStocks.length === 0) {
                    showMessage('股票列表加载失败，点击重试', true);
                    return;
                }
                const kwUpper = kw.toUpperCase();
                const matched = allStocks.filter(s =>
                    s.code.startsWith(kwUpper) || (s.name && s.name.includes(kw))
                ).slice(0, SEARCH_LIMIT);
                renderItems(matched);
            } catch (e2) {
                if (mySeq !== seq) return;
                showMessage('搜索失败：' + e2.message + '（点击重试）', true);
            }
        }

        // 输入防抖搜索
        input.addEventListener('input', function () {
            clearTimeout(timer);
            const val = this.value;
            timer = setTimeout(() => doSearch(val), DEBOUNCE_MS);
        });

        // 点击下拉外区域关闭
        document.addEventListener('click', (e) => {
            const box = input.closest('.search-box');
            if (box && !box.contains(e.target)) hide();
        });

        return { doSearch: doSearch, hide: hide };
    }

    return { create: create };
})();
