/**
 * 自选分组管理模块（TODO16.2 分组体系对齐fundhome-full + TODO15.3 加自选分组弹窗）
 *
 * 职责：
 * 1. 分组存储（localStorage 'unusual_wl_groups'）：{id, name, pinned, order}
 *    - pinned置顶分组始终排在最前（组内按order），未置顶分组按order
 * 2. 分组tabs：全部 / 各分组（置顶带📌图标）/ 未分组（存在未分组股票时才显示）
 *    - 当前分组持久化（'unusual_wl_active_group'），切换通过onChange回调通知刷新列表
 * 3. 分组管理弹窗：新建 / 上移下移排序 / 置顶取消置顶 / 重命名 / 删除
 *    （删除分组时组内股票自动移至未分组，不删除股票本身）
 * 4. 加自选分组弹窗（AddToGroupModal移植，TODO15.3）：
 *    - 单选已有分组（支持汉字/拼音首字母检索过滤）/ 新建分组并选中 / 不分组（仅加自选）
 *    - 供涨跌停池批量加自选（fupan_render.js）与自选列表分组列复用
 * 5. 拼音首字母匹配：CLDR拼音collation二分实现（无外部依赖）
 *    - 以23个拼音首字母边界字（啊芭擦搭蛾发噶哈击喀垃妈拿哦啪期然撒塌挖昔压匝）
 *      二分定位汉字的拼音首字母；常见字准确率约96%（多音字/生僻字有偏差，可接受）
 *
 * 解耦说明：
 * - 股票数据读写通过全局Watchlist模块（getList/saveList/addStock/setStockGroup），
 *   本模块只管分组存储与UI，不直接操作股票存储
 * - 分组/激活变化通过init注入的onChange回调通知Watchlist刷新浏览视图
 */
const WlGroup = (function () {

    // ===== 常量 =====
    const GROUPS_KEY = 'unusual_wl_groups';          // 分组列表持久化key
    const ACTIVE_KEY = 'unusual_wl_active_group';    // 当前激活分组持久化key
    const ALL_ID = '__all__';                        // 虚拟分组：全部
    const NONE_ID = '__none__';                      // 虚拟分组：未分组

    // 拼音首字母边界字（拼音升序：a b c d e f g h j k l m n o p q r s t w x y z，无i/u/v）
    const PY_BOUNDS = '啊芭擦搭蛾发噶哈击喀垃妈拿哦啪期然撒塌挖昔压匝';
    const PY_LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ';
    const PY_COLL = 'zh-Hans-CN-u-co-pinyin';        // CLDR拼音排序collation

    // ===== 模块状态 =====
    let onChange = null;   // 分组/激活变化回调（Watchlist注入，刷新浏览视图）

    // ============================================================
    // 拼音首字母匹配（纯函数，供Node测试）
    // ============================================================

    /**
     * 取单个汉字的拼音首字母（大写；非汉字返回''）
     * 实现：CLDR拼音collation二分——汉字与23个边界字比较（localeCompare拼音序），
     * 落在哪个边界区间即为哪个首字母
     * @param {string} ch 单个字符
     * @returns {string} 'A'~'Z' 或 ''
     */
    function charFirstLetter(ch) {
        if (!ch || !/[\u4e00-\u9fff]/.test(ch)) return '';
        let lo = 0, hi = PY_BOUNDS.length - 1, best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (ch.localeCompare(PY_BOUNDS[mid], PY_COLL) >= 0) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return best < 0 ? '' : PY_LETTERS[best];
    }

    /**
     * 取字符串的拼音首字母序列（小写，如"龙头"→"lt"）
     * @param {string} text 文本
     * @returns {string} 首字母序列（非汉字部分原样保留小写）
     */
    function pinyinFirstLetters(text) {
        return String(text || '').split('').map(ch => {
            if (/[\u4e00-\u9fff]/.test(ch)) return charFirstLetter(ch).toLowerCase();
            return ch.toLowerCase();
        }).join('');
    }

    /**
     * 拼音/汉字匹配（下拉过滤用，TODO15.3）
     * 匹配方式：汉字直接包含 / 拼音首字母序列包含（如输入"lt"匹配"龙头"）
     * @param {string} input 用户输入
     * @param {string} text 候选项文本
     * @returns {boolean} 是否匹配
     */
    function matchPinyin(input, text) {
        if (!input) return true;
        const lowerInput = String(input).toLowerCase();
        const lowerText = String(text || '').toLowerCase();
        if (lowerText.includes(lowerInput)) return true;
        return pinyinFirstLetters(lowerText).includes(lowerInput);
    }

    // ============================================================
    // 分组存储（localStorage）
    // ============================================================

    /**
     * 读取分组列表（已按 pinned desc, order asc 排序）
     * @returns {Array<{id,name,pinned,order}>}
     */
    function getGroups() {
        try {
            const raw = localStorage.getItem(GROUPS_KEY);
            const list = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(list)) return [];
            return list
                .filter(g => g && g.id && g.name)
                .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.order || 0) - (b.order || 0));
        } catch (e) {
            console.warn('读取分组失败:', e.message);
            return [];
        }
    }

    /**
     * 保存分组列表
     * @param {Array} groups 分组列表
     */
    function saveGroups(groups) {
        try {
            localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
        } catch (e) {
            console.warn('保存分组失败:', e.message);
        }
    }

    /**
     * 生成新分组id（时间戳+随机数，避免冲突）
     * @returns {string}
     */
    function newGroupId() {
        return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    /**
     * 新建分组（名称去重，新分组追加到末尾）
     * @param {string} name 分组名称
     * @returns {Object|null} 新分组（名称为空/重复返回null）
     */
    function addGroup(name) {
        const trimName = String(name || '').trim();
        if (!trimName) return null;
        const groups = getGroups();
        if (groups.some(g => g.name === trimName)) return null;
        const group = {
            id: newGroupId(),
            name: trimName,
            pinned: 0,
            order: groups.length ? Math.max(...groups.map(g => g.order || 0)) + 1 : 0
        };
        groups.push(group);
        saveGroups(groups);
        refreshGroupBar(); // 新建分组不影响股票归属，仅同步分组栏显示
        return group;
    }

    /**
     * 重命名分组（名称去重）
     * @param {string} id 分组id
     * @param {string} name 新名称
     * @returns {boolean} 是否成功
     */
    function renameGroup(id, name) {
        const trimName = String(name || '').trim();
        if (!trimName) return false;
        const groups = getGroups();
        if (groups.some(g => g.id !== id && g.name === trimName)) return false;
        const group = groups.find(g => g.id === id);
        if (!group) return false;
        group.name = trimName;
        saveGroups(groups);
        refreshGroupBar(); // 重命名不影响股票归属，仅同步分组栏显示
        return true;
    }

    /**
     * 删除分组（组内股票移至未分组，不删除股票；激活分组被删时切回全部）
     * @param {string} id 分组id
     */
    function deleteGroup(id) {
        const groups = getGroups();
        if (!groups.some(g => g.id === id)) return;
        saveGroups(groups.filter(g => g.id !== id));
        // 组内股票移至未分组
        if (typeof Watchlist !== 'undefined') {
            const list = Watchlist.getList();
            let changed = false;
            list.forEach(s => {
                if (s.groupId === id) { s.groupId = ''; changed = true; }
            });
            if (changed) Watchlist.saveList(list);
        }
        if (getActiveGroupId() === id) setActiveGroupId(ALL_ID, false);
        refreshGroupBar();
        notifyChange();
    }

    /**
     * 切换分组置顶状态（置顶分组始终排在最前）
     * @param {string} id 分组id
     */
    function togglePin(id) {
        const groups = getGroups();
        const group = groups.find(g => g.id === id);
        if (!group) return;
        group.pinned = group.pinned ? 0 : 1;
        saveGroups(groups);
        refreshGroupBar();
        notifyChange();
    }

    /**
     * 分组上移/下移（同一置顶层级内交换order；跨层级边界不动）
     * @param {string} id 分组id
     * @param {string} dir 'up'|'down'
     */
    function moveGroup(id, dir) {
        const groups = getGroups();
        const idx = groups.findIndex(g => g.id === id);
        if (idx < 0) return;
        const target = dir === 'up' ? idx - 1 : idx + 1;
        // 边界 / 跨置顶层级（pinned不同的相邻组不可交换，避免排序后视觉无变化）
        if (target < 0 || target >= groups.length) return;
        if ((groups[target].pinned ? 1 : 0) !== (groups[idx].pinned ? 1 : 0)) return;
        const tmp = groups[idx].order;
        groups[idx].order = groups[target].order;
        groups[target].order = tmp;
        saveGroups(groups);
        refreshGroupBar();
        notifyChange();
    }

    /**
     * 取分组名
     * @param {string} id 分组id
     * @returns {string} 分组名（不存在返回''）
     */
    function getGroupName(id) {
        const g = getGroups().find(x => x.id === id);
        return g ? g.name : '';
    }

    // ============================================================
    // 激活分组
    // ============================================================

    /**
     * 读取当前激活分组id（持久化；分组已删除时回退全部）
     * @returns {string} ALL_ID / NONE_ID / 分组id
     */
    function getActiveGroupId() {
        let saved = null;
        try {
            saved = localStorage.getItem(ACTIVE_KEY);
        } catch (e) { /* 忽略 */ }
        if (saved === ALL_ID || saved === NONE_ID) return saved;
        if (saved && getGroups().some(g => g.id === saved)) return saved;
        return ALL_ID;
    }

    /**
     * 设置当前激活分组（持久化；同步分组栏高亮）
     * @param {string} id 分组id / ALL_ID / NONE_ID
     * @param {boolean} [notify=true] 是否触发onChange（初始化恢复时不触发）
     */
    function setActiveGroupId(id, notify = true) {
        try {
            localStorage.setItem(ACTIVE_KEY, id);
        } catch (e) { /* 忽略 */ }
        document.querySelectorAll('#wlGroupBar .wl-gtab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.gid === id);
        });
        if (notify) notifyChange();
    }

    /**
     * 通知分组/激活变化（Watchlist刷新浏览视图）
     */
    function notifyChange() {
        if (typeof onChange === 'function') onChange();
    }

    // ============================================================
    // 分组栏UI（tabs + 管理入口）
    // ============================================================

    /**
     * 按激活分组过滤自选列表（Watchlist浏览视图数据源）
     * @param {Array} list 自选列表
     * @returns {Array} 过滤后列表
     */
    function filterByActive(list) {
        const active = getActiveGroupId();
        if (active === ALL_ID) return list;
        if (active === NONE_ID) {
            const gids = new Set(getGroups().map(g => g.id));
            return list.filter(s => !s.groupId || !gids.has(s.groupId));
        }
        return list.filter(s => s.groupId === active);
    }

    /**
     * 渲染分组栏（全部/各分组/未分组/管理按钮，含数量角标）
     */
    function refreshGroupBar() {
        const bar = document.getElementById('wlGroupBar');
        if (!bar) return;
        const list = typeof Watchlist !== 'undefined' ? Watchlist.getList() : [];
        const groups = getGroups();
        const gids = new Set(groups.map(g => g.id));
        const countByGid = {};
        let noneCount = 0;
        list.forEach(s => {
            if (s.groupId && gids.has(s.groupId)) {
                countByGid[s.groupId] = (countByGid[s.groupId] || 0) + 1;
            } else {
                noneCount++;
            }
        });
        const active = getActiveGroupId();

        /**
         * 单个tab按钮HTML
         */
        const tabHtml = (gid, label, count, isActive) =>
            `<button class="wl-gtab${isActive ? ' active' : ''}" data-gid="${esc(gid)}" title="${esc(label)}">${esc(label)}<i class="wl-gtab-count">${count}</i></button>`;

        let html = tabHtml(ALL_ID, '全部', list.length, active === ALL_ID);
        html += groups.map(g => tabHtml(g.id, (g.pinned ? '📌' : '') + g.name, countByGid[g.id] || 0,
            active === g.id)).join('');
        // 未分组tab：存在未分组股票时才显示（对齐fundhome-full）
        if (noneCount > 0) html += tabHtml(NONE_ID, '未分组', noneCount, active === NONE_ID);
        html += '<button class="wl-gtab wl-gtab-manage" data-gid="__manage__" title="分组管理：新建/排序/置顶/重命名/删除">⚙ 管理</button>';
        bar.innerHTML = html;
    }

    /**
     * 绑定分组栏事件（tab切换 + 管理入口）
     */
    function bindGroupBar() {
        const bar = document.getElementById('wlGroupBar');
        if (!bar) return;
        bar.addEventListener('click', e => {
            const btn = e.target.closest('.wl-gtab');
            if (!btn) return;
            if (btn.dataset.gid === '__manage__') {
                openManageModal();
                return;
            }
            if (btn.dataset.gid !== getActiveGroupId()) {
                setActiveGroupId(btn.dataset.gid);
            }
        });
    }

    // ============================================================
    // 通用弹窗骨架（遮罩+面板，关闭即销毁）
    // ============================================================

    /**
     * 创建模态弹窗（遮罩点击/ESC关闭）
     * @param {string} innerHtml 面板内容HTML
     * @returns {{mask:HTMLElement, panel:HTMLElement, close:Function}}
     */
    function createModal(innerHtml) {
        const mask = document.createElement('div');
        mask.className = 'wl-modal-mask';
        mask.innerHTML = `<div class="wl-modal">${innerHtml}</div>`;
        document.body.appendChild(mask);
        /**
         * 关闭并销毁弹窗
         */
        const close = () => {
            document.removeEventListener('keydown', onKey);
            mask.remove();
        };
        /**
         * ESC快捷关闭
         */
        const onKey = e => {
            if (e.key === 'Escape') close();
        };
        document.addEventListener('keydown', onKey);
        mask.addEventListener('click', e => {
            if (e.target === mask) close();
        });
        return { mask, panel: mask.querySelector('.wl-modal'), close };
    }

    // ============================================================
    // 分组管理弹窗（TODO16.2：新建/排序/置顶/重命名/删除）
    // ============================================================

    /**
     * 打开分组管理弹窗
     * 主流程：渲染分组行（名称/数量/上移/下移/置顶/重命名/删除）→ 新建分组行 → 关闭按钮
     */
    function openManageModal() {
        const modal = createModal(`
            <div class="wl-modal-title">分组管理</div>
            <div class="wl-mg-new">
                <input type="text" class="wl-mg-new-input" placeholder="新分组名称" maxlength="20">
                <button class="btn btn-primary btn-sm wl-mg-new-btn">新建分组</button>
            </div>
            <div class="wl-mg-list" data-wl-mg-list></div>
            <div class="wl-modal-actions">
                <button class="btn btn-primary wl-mg-close">关闭</button>
            </div>`);
        const listEl = modal.panel.querySelector('[data-wl-mg-list]');
        const input = modal.panel.querySelector('.wl-mg-new-input');

        /**
         * 渲染分组行列表
         */
        const renderRows = () => {
            const list = typeof Watchlist !== 'undefined' ? Watchlist.getList() : [];
            const groups = getGroups();
            const gids = new Set(groups.map(g => g.id));
            const countByGid = {};
            list.forEach(s => {
                if (s.groupId && gids.has(s.groupId)) countByGid[s.groupId] = (countByGid[s.groupId] || 0) + 1;
            });
            if (!groups.length) {
                listEl.innerHTML = '<div class="wl-mg-empty">暂无分组，输入名称新建</div>';
                return;
            }
            listEl.innerHTML = groups.map(g => `
                <div class="wl-mg-row" data-gid="${esc(g.id)}">
                    <span class="wl-mg-name">${g.pinned ? '📌 ' : ''}${esc(g.name)}</span>
                    <span class="wl-mg-count">${countByGid[g.id] || 0}只</span>
                    <span class="wl-mg-ops">
                        <button class="wl-mg-btn" data-act="up" title="上移">↑</button>
                        <button class="wl-mg-btn" data-act="down" title="下移">↓</button>
                        <button class="wl-mg-btn" data-act="pin" title="${g.pinned ? '取消置顶' : '置顶'}">${g.pinned ? '📍' : '📌'}</button>
                        <button class="wl-mg-btn" data-act="rename" title="重命名">✎</button>
                        <button class="wl-mg-btn wl-mg-del" data-act="del" title="删除分组（组内股票移至未分组）">✕</button>
                    </span>
                </div>`).join('');
        };
        renderRows();

        // 行操作（事件委托）
        listEl.addEventListener('click', e => {
            const btn = e.target.closest('.wl-mg-btn');
            if (!btn) return;
            const gid = btn.closest('.wl-mg-row').dataset.gid;
            const act = btn.dataset.act;
            if (act === 'up' || act === 'down') {
                moveGroup(gid, act);
                renderRows();
            } else if (act === 'pin') {
                togglePin(gid);
                renderRows();
            } else if (act === 'rename') {
                const g = getGroups().find(x => x.id === gid);
                const name = prompt('重命名分组', g ? g.name : '');
                if (name !== null && name.trim()) {
                    if (!renameGroup(gid, name.trim())) showToast('重命名失败：名称为空或已存在', 'error');
                    renderRows();
                }
            } else if (act === 'del') {
                const g = getGroups().find(x => x.id === gid);
                if (g && confirm(`删除分组「${g.name}」？\n组内股票将移至未分组，不会被删除。`)) {
                    deleteGroup(gid);
                    renderRows();
                }
            }
        });

        // 新建分组
        modal.panel.querySelector('.wl-mg-new-btn').addEventListener('click', () => {
            const name = input.value.trim();
            if (!name) { showToast('请输入分组名称', 'error'); return; }
            if (!addGroup(name)) { showToast('新建失败：名称为空或已存在', 'error'); return; }
            input.value = '';
            renderRows();
            showToast(`已新建分组「${name}」`, 'success');
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') modal.panel.querySelector('.wl-mg-new-btn').click();
        });

        modal.panel.querySelector('.wl-mg-close').addEventListener('click', modal.close);
    }

    // ============================================================
    // 加自选分组弹窗（TODO15.3，AddToGroupModal移植）
    // ============================================================

    /**
     * 打开加自选分组弹窗
     * 主流程：分组下拉（汉字/拼音首字母过滤，默认"不分组"）→ 可选新建分组并选中
     *        → 确认：逐只加自选（已存在的同步分组）→ 提示结果 → onDone回调
     * @param {Array<{code:string,name:string,market:number}>} stocks 待添加股票
     * @param {Object} [opts] {title:string, onDone:Function, setGroupMode:boolean}
     *   setGroupMode=true 时为"设置分组"模式：已存在股票选"不分组"会移出分组
     *   （默认模式下已存在股票选"不分组"仅跳过，不动其原分组，适配批量加自选场景）
     */
    function openAddToGroupModal(stocks, opts = {}) {
        if (!stocks || !stocks.length) return;
        const modal = createModal(`
            <div class="wl-modal-title">${esc(opts.title || '加自选')}（${stocks.length}只）</div>
            <div class="wl-ag-field">
                <div class="wl-ag-label">选择分组：</div>
                <div class="wl-ag-inputwrap">
                    <input type="text" class="wl-ag-input" placeholder="搜索分组（汉字/拼音首字母）" autocomplete="off">
                    <div class="wl-ag-dropdown" style="display:none;"></div>
                </div>
                <div class="wl-ag-selected"></div>
            </div>
            <div class="wl-ag-field">
                <div class="wl-ag-label">或新建分组：</div>
                <div class="wl-ag-newrow">
                    <input type="text" class="wl-ag-new-input" placeholder="新分组名称" maxlength="20">
                    <button class="btn btn-secondary btn-sm wl-ag-new-btn">新建并选中</button>
                </div>
            </div>
            <div class="wl-modal-actions">
                <button class="btn btn-secondary wl-ag-cancel">取消</button>
                <button class="btn btn-primary wl-ag-ok">确认添加</button>
            </div>`);

        let selectedGid = '';   // ''=不分组（仅加自选）
        const input = modal.panel.querySelector('.wl-ag-input');
        const dropdown = modal.panel.querySelector('.wl-ag-dropdown');
        const selectedEl = modal.panel.querySelector('.wl-ag-selected');

        /**
         * 更新"已选分组"提示
         */
        const renderSelected = () => {
            selectedEl.innerHTML = selectedGid
                ? `将加入分组：<b>${esc(getGroupName(selectedGid))}</b>`
                : '将<b>不分组</b>（仅加入自选列表）';
        };

        /**
         * 渲染下拉选项（按输入过滤：汉字/拼音首字母）
         */
        const renderOptions = () => {
            const kw = input.value.trim();
            const groups = getGroups().filter(g => matchPinyin(kw, g.name));
            const optHtml = (gid, label) =>
                `<div class="wl-ag-opt${selectedGid === gid ? ' wl-ag-opt-active' : ''}" data-gid="${esc(gid)}">${esc(label)}</div>`;
            let html = optHtml('', '不分组（仅加入自选）');
            html += groups.map(g => optHtml(g.id, (g.pinned ? '📌 ' : '') + g.name)).join('');
            if (!groups.length && kw) html += '<div class="wl-ag-none">无匹配分组</div>';
            dropdown.innerHTML = html;
            dropdown.style.display = 'block';
        };

        // 输入过滤（聚焦/输入时展示下拉）
        input.addEventListener('focus', renderOptions);
        input.addEventListener('input', renderOptions);
        // 点击下拉选项
        dropdown.addEventListener('click', e => {
            const opt = e.target.closest('.wl-ag-opt');
            if (!opt) return;
            selectedGid = opt.dataset.gid;
            input.value = selectedGid ? getGroupName(selectedGid) : '';
            dropdown.style.display = 'none';
            renderSelected();
        });
        // 点击其他区域收起下拉
        document.addEventListener('click', function onDocClick(e) {
            if (!modal.mask.contains(e.target)) {
                dropdown.style.display = 'none';
                document.removeEventListener('click', onDocClick);
            }
        });

        // 新建分组并选中
        const newInput = modal.panel.querySelector('.wl-ag-new-input');
        const doCreate = () => {
            const name = newInput.value.trim();
            if (!name) { showToast('请输入新分组名称', 'error'); return; }
            const g = addGroup(name);
            if (!g) { showToast('新建失败：分组名称已存在', 'error'); return; }
            selectedGid = g.id;
            newInput.value = '';
            input.value = g.name;
            dropdown.style.display = 'none';
            renderSelected();
            refreshGroupBar();
            showToast(`已新建并选中分组「${name}」`, 'success');
        };
        modal.panel.querySelector('.wl-ag-new-btn').addEventListener('click', doCreate);
        newInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') doCreate();
        });

        // 确认添加：逐只加自选（已存在则同步分组），弹窗内非阻塞展示结果后自动关闭
        // （不使用alert：阻塞式对话框与自动化测试/无头环境交互不可靠）
        const okBtn = modal.panel.querySelector('.wl-ag-ok');
        okBtn.addEventListener('click', () => {
            let added = 0;
            let existed = 0;
            stocks.forEach(s => {
                if (Watchlist.addStock(s.code, s.name, s.market, selectedGid)) {
                    added++;
                } else {
                    // 已存在：选择了分组时同步其分组；
                    // 设置分组模式下选"不分组"时移出分组（移至未分组），默认模式仅跳过
                    if (selectedGid || opts.setGroupMode) {
                        Watchlist.setStockGroup(s.code, selectedGid);
                    }
                    existed++;
                }
            });
            // 关闭弹窗 → 刷新UI → Toast 非阻塞提示（TODO18.3：替代原弹窗内回显）
            modal.close();
            refreshGroupBar();
            notifyChange();
            if (typeof opts.onDone === 'function') opts.onDone();
            const groupName = selectedGid ? `「${getGroupName(selectedGid)}」` : '自选列表';
            if (added > 0 || (existed > 0 && (selectedGid || opts.setGroupMode))) {
                let msg = `已添加${added}只到${groupName}`;
                if (existed > 0) msg += `，${existed}只已在自选中${(selectedGid || opts.setGroupMode) ? '（已同步分组）' : '，跳过'}`;
                showToast(msg, 'success');
            } else if (existed > 0) {
                showToast(`${existed}只已在自选中，跳过`, 'info');
            }
        });

        modal.panel.querySelector('.wl-ag-cancel').addEventListener('click', modal.close);
        renderSelected();
    }

    // ============================================================
    // HTML转义（分组名等用户输入回显前必须转义）
    // ============================================================

    /**
     * HTML转义
     * @param {string} s 原文
     * @returns {string}
     */
    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ============================================================
    // Toast 轻量提示（TODO18.3：非阻塞自动消失，替代 alert）
    // ============================================================

    /**
     * 显示一个轻量 Toast 提示（自动消失，堆叠显示，非阻塞）
     * @param {string} msg 提示文字
     * @param {'success'|'error'|'info'} [type='info'] 类型
     * @param {number} [duration=2200] 持续毫秒
     */
    function showToast(msg, type = 'info', duration = 2200) {
        if (!msg) return;
        // 容器
        let wrap = document.querySelector('.wl-toast-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.className = 'wl-toast-wrap';
            document.body.appendChild(wrap);
        }
        const toast = document.createElement('div');
        toast.className = 'wl-toast wl-toast-' + type;
        toast.textContent = msg;
        wrap.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('wl-toast-show'));
        setTimeout(() => {
            toast.classList.remove('wl-toast-show');
            toast.addEventListener('transitionend', () => toast.remove(), { once: true });
        }, duration);
    }

    // ============================================================
    // 初始化
    // ============================================================

    /**
     * 初始化分组模块
     * @param {Object} [opts] {onChange:Function} 分组/激活变化回调
     */
    function init(opts = {}) {
        onChange = opts.onChange || null;
        refreshGroupBar();
        bindGroupBar();
        // 恢复激活分组高亮（不触发数据刷新）
        setActiveGroupId(getActiveGroupId(), false);
    }

    // 公开接口
    return {
        init,
        // 虚拟分组id常量（外部判断用）
        ALL_ID,
        NONE_ID,
        // 分组CRUD
        getGroups,
        addGroup,
        renameGroup,
        deleteGroup,
        togglePin,
        moveGroup,
        getGroupName,
        // 激活分组
        getActiveGroupId,
        setActiveGroupId,
        filterByActive,
        // UI
        refreshGroupBar,
        openManageModal,
        openAddToGroupModal,
        showToast,
        // 拼音匹配（纯函数，供Node测试）
        pinyinFirstLetters,
        matchPinyin
    };
})();

// Node测试环境导出（浏览器环境为全局变量）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WlGroup;
}
