/**
 * 统一外壳脚本
 *
 * 职责：
 * 1. 左侧菜单切换：板块资金（sector应用）/ 异动监控、每日复盘、自选、设置（stock应用）
 * 2. 双iframe架构（TODO5.3）：sector与stock各一个iframe，懒加载（首次切换才设src），
 *    切换=display显隐 → 板块资金⇄stock应用来回切换零重载，CSS/JS 完全隔离
 * 3. 同一应用内切换（stock四个页面）通过 postMessage 通知子应用切tab，避免整页刷新丢失状态
 * 4. 菜单选中状态持久化（localStorage），下次进入恢复
 * 5. 菜单栏展开/收起：收起后仅显示图标，状态持久化，下次进入恢复
 *
 * 与子应用的通信协议（同源 iframe）：
 * - shell → 子应用: postMessage({type:'dailystock:navigate', page:'market'|'fupan'|'watchlist'|'settings'})
 * - 子应用无需回传消息，切换失败时由 data-src 兜底刷新
 *
 * localStorage 持久化key：
 * - dailystock_active_menu：最后选中的菜单
 * - dailystock_menu_collapsed：菜单栏是否收起（'1'=收起）
 */
const Shell = (function () {

    // 菜单持久化key
    const ACTIVE_MENU_KEY = 'dailystock_active_menu';

    // 菜单收起状态持久化key
    const COLLAPSED_KEY = 'dailystock_menu_collapsed';

    // stock应用四个页面（共用appFrame）
    const STOCK_PAGES = ['market', 'fupan', 'watchlist', 'settings'];

    // 当前激活菜单（默认板块资金）
    let activeMenu = 'sector';

    // stock应用iframe是否已加载完成（加载完成前只能通过 src 跳转）
    let frameReady = false;

    const frame = document.getElementById('appFrame');          // stock应用
    const frameSector = document.getElementById('appFrameSector'); // sector应用
    const menuItems = document.querySelectorAll('.shell-menu-item');
    const sidebar = document.getElementById('shellSidebar');
    const collapseBtn = document.getElementById('btnCollapse');

    /**
     * 初始化外壳
     * 主流程：绑定菜单/收起事件 → 恢复菜单收起态 → 恢复菜单选中态（按需加载对应iframe）
     */
    function init() {
        // 菜单点击事件
        menuItems.forEach(btn => {
            btn.addEventListener('click', () => switchMenu(btn.dataset.menu));
        });

        // 展开/收起按钮
        collapseBtn.addEventListener('click', () => {
            setCollapsed(!sidebar.classList.contains('collapsed'), true);
        });

        // stock iframe 加载完成后标记就绪（此后同应用切换走 postMessage）
        frame.addEventListener('load', () => {
            frameReady = true;
        });

        // 恢复菜单栏收起状态（默认展开）
        if (localStorage.getItem(COLLAPSED_KEY) === '1') {
            setCollapsed(true, false);
        }

        // 恢复上次选中的菜单（按需加载对应iframe + 同步菜单高亮，两者必须一致）
        const saved = localStorage.getItem(ACTIVE_MENU_KEY);
        const target = saved && menuItemsOwn(saved) ? saved : 'sector';
        if (target === activeMenu) {
            // 默认菜单与恢复值相同：直接加载（switchMenu对相同菜单短路）
            const btn = document.querySelector(`.shell-menu-item[data-menu="${target}"]`);
            if (btn) showFrame(target === 'sector' ? 'sector' : 'stock', btn.dataset.src);
        } else {
            switchMenu(target);
        }
    }

    /**
     * 菜单是否存在
     * @param {string} menu 菜单标识
     * @returns {boolean}
     */
    function menuItemsOwn(menu) {
        return Array.from(menuItems).some(b => b.dataset.menu === menu);
    }

    /**
     * 设置菜单栏展开/收起
     * @param {boolean} collapsed true=收起（仅图标），false=展开（图标+文字）
     * @param {boolean} persist 是否持久化到localStorage（初始化恢复时不写回）
     */
    function setCollapsed(collapsed, persist) {
        sidebar.classList.toggle('collapsed', collapsed);
        collapseBtn.title = collapsed ? '展开菜单' : '收起菜单';
        collapseBtn.setAttribute('aria-label', collapseBtn.title);
        if (persist) {
            try {
                localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
            } catch (e) {
                console.warn('保存菜单收起状态失败:', e);
            }
        }
    }

    /**
     * 激活指定应用的iframe（懒加载：src为空时才设置），另一个隐藏
     * @param {string} app 'stock' / 'sector'
     * @param {string} src 目标地址（懒加载首次设置src用）
     */
    function showFrame(app, src) {
        const target = app === 'sector' ? frameSector : frame;
        const other = app === 'sector' ? frame : frameSector;
        if (!target.src) target.src = src;   // 懒加载：首次切换才加载
        target.style.display = '';
        other.style.display = 'none';
    }

    /**
     * 切换菜单
     * 主流程：
     * 1. 更新菜单高亮与持久化
     * 2. sector → 显示sector iframe（懒加载，切换无重载）
     * 3. stock页面 → 显示stock iframe；iframe就绪且当前已在stock应用时 postMessage 内部切tab（无刷新），
     *    否则设置src跳转到目标页面
     * @param {string} menu 菜单标识：sector/market/fupan/watchlist/settings
     */
    function switchMenu(menu) {
        if (menu === activeMenu) return;
        const btn = document.querySelector(`.shell-menu-item[data-menu="${menu}"]`);
        if (!btn) return;

        // 更新高亮与持久化
        menuItems.forEach(b => b.classList.toggle('active', b === btn));
        const prevMenu = activeMenu;
        activeMenu = menu;
        localStorage.setItem(ACTIVE_MENU_KEY, menu);

        if (menu === 'sector') {
            showFrame('sector', btn.dataset.src);
            return;
        }

        // stock应用页面
        const isStockApp = STOCK_PAGES.includes(menu);
        if (!isStockApp) return;
        const wasStock = STOCK_PAGES.includes(prevMenu) && frameReady;
        if (wasStock) {
            // 同应用切换：postMessage 让子应用内部切tab，保留其运行状态
            try {
                showFrame('stock', btn.dataset.src);
                frame.contentWindow.postMessage({ type: 'dailystock:navigate', page: menu }, '*');
                return;
            } catch (e) {
                console.warn('postMessage 切换失败，回退到 src 跳转:', e);
            }
        }
        // 跨应用切换（或postMessage失败兜底）：设置src跳转
        frameReady = false;
        showFrame('stock', btn.dataset.src);
        if (!wasStock) frame.src = btn.dataset.src;
    }

    return { init };
})();

Shell.init();
