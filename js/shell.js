/**
 * 统一外壳脚本
 *
 * 职责：
 * 1. 左侧菜单切换：板块资金（sector应用）/ 异动监控、自选、设置（stock应用）
 * 2. iframe 加载子应用，CSS/JS 完全隔离，子应用零侵入
 * 3. 同一应用内切换（stock三个页面）通过 postMessage 通知子应用切tab，避免整页刷新丢失状态
 * 4. 菜单选中状态持久化（localStorage），下次进入恢复
 *
 * 与子应用的通信协议（同源 iframe）：
 * - shell → 子应用: postMessage({type:'dailystock:navigate', page:'market'|'watchlist'|'settings'})
 * - 子应用无需回传消息，切换失败时由 data-src 兜底刷新
 */
const Shell = (function () {

    // 菜单持久化key
    const ACTIVE_MENU_KEY = 'dailystock_active_menu';

    // 当前激活菜单（默认板块资金）
    let activeMenu = 'sector';

    // iframe 是否已加载完成（加载完成前只能通过 src 跳转）
    let frameReady = false;

    const frame = document.getElementById('appFrame');
    const menuItems = document.querySelectorAll('.shell-menu-item');

    /**
     * 初始化外壳
     */
    function init() {
        // 恢复上次选中的菜单
        const saved = localStorage.getItem(ACTIVE_MENU_KEY);
        if (saved) {
            const btn = document.querySelector(`.shell-menu-item[data-menu="${saved}"]`);
            if (btn) {
                activeMenu = saved;
                frame.src = btn.dataset.src;
            }
        }

        // 菜单点击事件
        menuItems.forEach(btn => {
            btn.addEventListener('click', () => switchMenu(btn.dataset.menu));
        });

        // iframe 加载完成后标记就绪（此后同应用切换走 postMessage）
        frame.addEventListener('load', () => {
            frameReady = true;
        });
    }

    /**
     * 切换菜单
     * 主流程：
     * 1. 更新菜单高亮与持久化
     * 2. 目标应用与当前iframe应用相同且iframe就绪 → postMessage 通知子应用内部切tab（无刷新）
     * 3. 不同应用 → 直接切换 iframe src
     * @param {string} menu 菜单标识：sector/market/watchlist/settings
     */
    function switchMenu(menu) {
        if (menu === activeMenu) return;

        const btn = document.querySelector(`.shell-menu-item[data-menu="${menu}"]`);
        if (!btn) return;

        // 更新高亮与持久化
        menuItems.forEach(b => b.classList.toggle('active', b === btn));
        activeMenu = menu;
        localStorage.setItem(ACTIVE_MENU_KEY, menu);

        // 判断目标应用：market/watchlist/settings 属于 stock 应用
        const isStockApp = ['market', 'watchlist', 'settings'].includes(menu);
        const currentIsStock = frame.src.includes('stock/index.html');

        if (isStockApp && currentIsStock && frameReady) {
            // 同应用切换：postMessage 让子应用内部切tab，保留其运行状态
            try {
                frame.contentWindow.postMessage({ type: 'dailystock:navigate', page: menu }, '*');
                return;
            } catch (e) {
                console.warn('postMessage 切换失败，回退到 src 跳转:', e);
            }
        }

        // 跨应用切换（或postMessage失败兜底）：切换 iframe src
        frameReady = false;
        frame.src = btn.dataset.src;
    }

    return { init };
})();

Shell.init();
