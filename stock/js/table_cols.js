/**
 * 通用表格列设置组件（TODO31；TODO37 增加列顺序调整）
 *
 * 功能：超过7列的表格，在首列表头末尾插入⚙齿轮，点击打开列设置面板，
 * 可显示/隐藏每一列、调整列宽（px步进）、调整列顺序（↑/↓），配置按表格key持久化到localStorage。
 *
 * 设计（参考基金项目 tableColumns.ts 的集中列配置思想，适配本项目原生JS重建式渲染）：
 * - 幂等apply模式：本项目表格大多是每次渲染innerHTML重建thead/tbody，
 *   宿主渲染完成后调用 TableColSettings.apply(tableEl, opts) 重新应用配置并插齿轮
 * - 列key稳定性：th有data-sort/data-ca-sort属性用之（动态日期表头如T+N列、竞价表均稳定），
 *   否则用th文本（fupan各池表列名固定），空文本回退col+索引
 * - 显隐直接改 th/td 的 display（即时生效不重渲染），下次渲染apply重新应用
 * - 列宽用 th.style.width 内联px（table-layout:fixed 下生效，覆盖类默认宽度；
 *   重置时清内联样式恢复CSS类默认）
 * - 列顺序（TODO37）：settings.order 保存key有序数组，apply 时先按其重排
 *   thead th 与各行 td 的 DOM 顺序（appendChild 移动节点），再重新收集列应用显隐/宽度；
 *   未保存的列（表新增列）追加在末尾；恢复默认回到首次apply时记录的原始列序
 * - 面板全局单例（position:fixed 跟随齿轮定位，视口边界修正，外点关闭）
 * - 安全边界：齿轮所在列锁定不可隐藏；lockKeys指定列（名称/代码等关键列）锁定；
 *   行内含colspan的单元格与th数不齐的行跳过隐藏/重排（防错位）
 * - opts.afterApply：宿主回调（列顺序/显隐变化后触发，如竞价表重算前三列sticky偏移）
 *
 * 面板交互：
 * - 每列一行：显隐checkbox + 列名 + 宽度−/+步进10px（仅显示的列可调）+ 顺序↑/↓ + 双击列名重置该列宽
 * - 底部：恢复默认（清除该表配置重新应用）/ 关闭
 */
const TableColSettings = (function () {

    const LS_PREFIX = 'table_col_settings_'; // localStorage key前缀，后接表格key
    const MIN_COLS = 8;       // 超过7列才启用列设置
    const WIDTH_STEP = 10;    // 列宽调整步进(px)
    const WIDTH_MIN = 30;     // 列宽下限(px)
    const WIDTH_MAX = 400;    // 列宽上限(px)
    const GEAR_CLASS = 'fp-col-gear'; // 齿轮元素类名（幂等移除依据）

    // 面板单例状态
    let panel = null;         // 面板DOM（懒创建）
    let panelOwner = null;    // 当前面板绑定的齿轮元素（同一齿轮重复点击=关闭）

    // 各表格首次apply时的原始列序（key数组），恢复默认时还原列顺序（TODO37）
    const defaultOrders = new Map();

    // ============================================================
    // 配置读写
    // ============================================================

    /**
     * 读取表格列配置
     * @param {string} key 表格唯一key
     * @returns {{hidden: Object<string, boolean>, widths: Object<string, number>, order: string[]}}
     */
    function loadSettings(key) {
        try {
            const raw = localStorage.getItem(LS_PREFIX + key);
            if (raw) {
                const data = JSON.parse(raw);
                return {
                    hidden: (data && typeof data.hidden === 'object' && data.hidden) || {},
                    widths: (data && typeof data.widths === 'object' && data.widths) || {},
                    order: (data && Array.isArray(data.order)) ? data.order : []
                };
            }
        } catch (e) { /* 配置损坏时回退默认 */ }
        return { hidden: {}, widths: {}, order: [] };
    }

    /**
     * 保存表格列配置
     * @param {string} key 表格唯一key
     * @param {{hidden: Object, widths: Object, order: string[]}} settings
     */
    function saveSettings(key, settings) {
        try {
            localStorage.setItem(LS_PREFIX + key, JSON.stringify(settings));
        } catch (e) {
            console.warn('保存列配置失败:', e.message);
        }
    }

    // ============================================================
    // 列收集与应用
    // ============================================================

    /**
     * 计算列稳定key：data-sort / data-ca-sort 优先 → th文本 → col+索引兜底
     * @param {HTMLElement} th
     * @param {number} idx 列索引
     */
    function colKey(th, idx) {
        if (th.dataset.sort) return th.dataset.sort;
        if (th.dataset.caSort) return th.dataset.caSort;
        const text = (th.textContent || '').trim();
        if (text) return text;
        return 'col' + idx;
    }

    /**
     * 收集表格第一行表头的列信息
     * @param {HTMLTableElement} table
     * @returns {Array<{idx: number, key: string, label: string, th: HTMLElement}>}
     */
    function collectColumns(table) {
        const tr = table.querySelector('thead tr');
        if (!tr) return [];
        return Array.from(tr.children).filter(el => el.tagName === 'TH').map((th, i) => ({
            idx: i,
            key: colKey(th, i),
            label: (th.textContent || '').trim() || ('列' + (i + 1)),
            th: th
        }));
    }

    /**
     * 应用列显隐与宽度到整个表格
     * 主流程：遍历列 → th显隐/宽度 → 每行body单元格按cellIndex对齐应用显隐
     * （cellIndex为真实单元格索引，与无colspan表的列索引一致；含colspan的行单元格数
     *   与th数不齐时跳过该行的隐藏操作防错位）
     * @param {HTMLTableElement} table
     * @param {Array} cols collectColumns结果
     * @param {{hidden: Object, widths: Object}} settings
     */
    function applyColumns(table, cols, settings) {
        const thCount = cols.length;
        // 第一行单元格数与th数一致的行才做列隐藏（含colspan的行跳过）
        const rows = Array.from(table.querySelectorAll('tbody tr'));
        for (const col of cols) {
            const hide = !!settings.hidden[col.key];
            col.th.style.display = hide ? 'none' : '';
            // 列宽：有保存值且显示中设内联px，否则清内联恢复CSS类默认
            const w = settings.widths[col.key];
            col.th.style.width = (!hide && w) ? w + 'px' : '';
            for (const tr of rows) {
                if (tr.children.length !== thCount) continue;
                const td = tr.children[col.idx];
                if (td) td.style.display = hide ? 'none' : '';
            }
        }
    }

    // ============================================================
    // 列顺序（TODO37）
    // ============================================================

    /**
     * 按保存的列顺序重排表格（thead th 与每行 td 同步移动）
     * 主流程：按 order 中的 key 位置排序（未保存的列追加在末尾、保持原DOM相对序）→
     *         表头 th 与各 body 行 td 按目标顺序 appendChild 移动（先快照原索引再移动）
     * @param {HTMLTableElement} table
     * @param {Array} cols collectColumns结果（调用时的DOM序）
     * @param {{order: string[]}} settings
     * @returns {Array|null} 重排后的列（新DOM序）；未配置顺序时返回 null（DOM不动）
     */
    /**
     * 按保存顺序对列做纯排序（TODO37 核心算法，不依赖DOM，可单测）
     * 规则：order 中出现的 key 按出现位置排序；未出现的列（新增列）追加在末尾、
     *       保持其在原 DOM 中的相对顺序（按原 idx）。
     * @param {Array} cols - collectColumns结果（含 .key / .idx）
     * @param {string[]} order - 保存的列顺序 key 数组
     * @returns {Array} 排序后的列（新数组）
     */
    function sortCols(cols, order) {
        const pos = new Map();
        (order || []).forEach((k, i) => { if (!pos.has(k)) pos.set(k, i); });
        return cols.slice().sort((a, b) => {
            const pa = pos.has(a.key) ? pos.get(a.key) : Infinity;
            const pb = pos.has(b.key) ? pos.get(b.key) : Infinity;
            if (pa !== pb) return pa - pb;
            return a.idx - b.idx;   // 未保存的列（新增列）保持DOM相对顺序，追加在末尾
        });
    }

    function applyOrder(table, cols, settings) {
        if (!settings.order || !settings.order.length) return null;
        const sorted = sortCols(cols, settings.order);

        // 重排表头（先按原始索引快照节点，再按目标顺序appendChild移动）
        const tr = table.querySelector('thead tr');
        if (tr) {
            const ths = Array.from(tr.children);
            sorted.forEach(c => tr.appendChild(ths[c.idx]));
        }
        // 重排每行单元格（colspan等单元格数与列数不齐的行跳过，防错位）
        const rows = Array.from(table.querySelectorAll('tbody tr'));
        rows.forEach(r => {
            if (r.children.length !== cols.length) return;
            const cells = Array.from(r.children);
            sorted.forEach(c => r.appendChild(cells[c.idx]));
        });
        return sorted;
    }

    /**
     * 重新应用全部列配置（顺序 → 重新收集列 → 显隐/宽度 → 宿主回调）
     * 面板内任何改动后统一走此入口，保证顺序/显隐/宽度三者始终一致
     * @param {HTMLTableElement} table
     * @param {Object} opts apply传入的选项
     * @returns {Array} 应用后的最新列集合（DOM序）
     */
    function reapply(table, opts) {
        let cols = collectColumns(table);
        const settings = loadSettings(opts.key);
        applyOrder(table, cols, settings);
        cols = collectColumns(table);   // 重排后重新收集（idx已更新）
        applyColumns(table, cols, settings);
        if (opts.afterApply) {
            try { opts.afterApply(table); } catch (e) { /* 宿主回调异常不影响列设置 */ }
        }
        return cols;
    }

    // ============================================================
    // 齿轮与面板
    // ============================================================

    /**
     * 在指定表头单元格末尾插入齿轮按钮（幂等：先移除表内旧齿轮）
     * @param {HTMLTableElement} table
     * @param {HTMLElement} gearTh 齿轮插入的th
     */
    function attachGear(table, gearTh) {
        const old = table.querySelector('.' + GEAR_CLASS);
        if (old) old.remove();
        const gear = document.createElement('span');
        gear.className = GEAR_CLASS;
        gear.title = '列设置';
        gear.textContent = '⚙';
        gearTh.appendChild(gear);
    }

    /**
     * 构建/复用列设置面板并渲染当前表格的列列表
     * 主流程：懒创建单例面板 → 定位到齿轮下方（视口边界修正）→ 渲染列行 → 绑定事件
     * @param {HTMLElement} gear 齿轮元素
     * @param {HTMLTableElement} table
     * @param {string} key 表格唯一key
     * @param {Array} cols
     * @param {Object} opts apply传入的选项（lockKeys等）
     */
    function openPanel(gear, table, key, cols, opts) {
        if (!panel) {
            panel = document.createElement('div');
            panel.className = 'fp-col-panel';
            document.body.appendChild(panel);
            // 外点关闭（点击面板与齿轮本身除外）
            document.addEventListener('click', e => {
                if (panel.style.display !== 'flex') return;
                if (panel.contains(e.target) || (e.target.closest && e.target.closest('.' + GEAR_CLASS))) return;
                closePanel();
            });
        }
        panelOwner = gear;
        renderPanelBody(table, key, cols, opts);
        panel.style.display = 'flex';

        // 定位：齿轮下方对齐，超出视口右/下边界时修正
        const rect = gear.getBoundingClientRect();
        const pw = panel.offsetWidth || 280;
        const ph = panel.offsetHeight || 300;
        let left = rect.left;
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
        if (left < 8) left = 8;
        let top = rect.bottom + 6;
        if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 6);
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
    }

    /** 关闭面板 */
    function closePanel() {
        if (panel) panel.style.display = 'none';
        panelOwner = null;
    }

    /**
     * 渲染面板内容（列行 + 底部按钮）
     * @param {HTMLTableElement} table
     * @param {string} key
     * @param {Array} cols
     * @param {Object} opts apply传入的选项（lockKeys等）
     */
    function renderPanelBody(table, key, cols, opts) {
        const settings = loadSettings(key);
        const lockKeys = new Set(opts.lockKeys || []);
        // 锁定列：齿轮实际所在列（按齿轮元素反查th匹配）+ lockKeys（关键列隐藏后表格失去识别意义）
        const gear = table.querySelector('.' + GEAR_CLASS);
        const gearTh = gear ? gear.closest('th') : null;
        const gearCol = gearTh ? cols.find(c => c.th === gearTh) : null;
        if (gearCol) lockKeys.add(gearCol.key);

        const rowsHtml = cols.map(col => {
            const locked = lockKeys.has(col.key);
            const hide = !!settings.hidden[col.key];
            const width = settings.widths[col.key];
            return `
                <div class="fp-col-row${locked ? ' fp-col-locked' : ''}" data-col-key="${escapeAttr(col.key)}">
                    <label class="fp-col-toggle">
                        <input type="checkbox" data-col-show ${hide ? '' : 'checked'} ${locked ? 'disabled' : ''}>
                        <span class="fp-col-name" title="${locked ? '关键列不可隐藏' : '双击重置列宽'}">${escapeHtml(col.label)}</span>
                    </label>
                    <span class="fp-col-order">
                        <button class="fp-col-wbtn" data-col-move="-1" title="上移">↑</button>
                        <button class="fp-col-wbtn" data-col-move="1" title="下移">↓</button>
                    </span>
                    <span class="fp-col-width" style="visibility:${hide ? 'hidden' : 'visible'}">
                        <button class="fp-col-wbtn" data-col-w="-" title="减小10px">−</button>
                        <b class="fp-col-wval">${width ? width : '默认'}</b>
                        <button class="fp-col-wbtn" data-col-w="+" title="增大10px">＋</button>
                    </span>
                </div>`;
        }).join('');

        panel.innerHTML = `
            <div class="fp-col-panel-title">列设置（${cols.length}列）</div>
            <div class="fp-col-panel-body">${rowsHtml}</div>
            <div class="fp-col-panel-foot">
                <button class="btn btn-sm btn-secondary" data-col-reset>恢复默认</button>
                <button class="btn btn-sm btn-secondary" data-col-close>关闭</button>
            </div>`;

        bindPanelEvents(table, key, cols, opts);
    }

    /**
     * 绑定面板事件：显隐切换 / 宽度± / 顺序↑↓ / 列名双击重置宽 / 恢复默认 / 关闭
     * @param {HTMLTableElement} table
     * @param {string} key
     * @param {Array} cols
     * @param {Object} opts apply传入的选项（lockKeys/afterApply等）
     */
    function bindPanelEvents(table, key, cols, opts) {
        const lockKeys = new Set(opts.lockKeys || []);
        // 锁定列：齿轮实际所在列（按齿轮元素反查th匹配）+ lockKeys（关键列隐藏后表格失去识别意义）
        const gear = table.querySelector('.' + GEAR_CLASS);
        const gearTh = gear ? gear.closest('th') : null;
        const gearCol = gearTh ? cols.find(c => c.th === gearTh) : null;
        if (gearCol) lockKeys.add(gearCol.key);
        const keyToCol = new Map(cols.map(c => [c.key, c]));
        const lockKeyArr = Array.from(lockKeys);

        // 显隐切换：即时应用到表格并持久化
        panel.querySelectorAll('input[data-col-show]').forEach(cb => {
            cb.addEventListener('change', () => {
                const row = cb.closest('.fp-col-row');
                const col = keyToCol.get(row.dataset.colKey);
                if (!col) return;
                const settings = loadSettings(key);
                if (cb.checked) delete settings.hidden[col.key];
                else settings.hidden[col.key] = true;
                saveSettings(key, settings);
                applyColumns(table, cols, settings);
                // 该行宽度控制随显隐切换可用性
                row.querySelector('.fp-col-width').style.visibility = cb.checked ? 'visible' : 'hidden';
            });
        });

        // 宽度±：步进调整并即时生效（th.style.width内联px）
        panel.querySelectorAll('.fp-col-wbtn[data-col-w]').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const row = btn.closest('.fp-col-row');
                const col = keyToCol.get(row.dataset.colKey);
                if (!col) return;
                const settings = loadSettings(key);
                const cur = settings.widths[col.key] || parseInt(col.th.style.width) || defaultWidth(col.th);
                const next = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, cur + (btn.dataset.colW === '+' ? WIDTH_STEP : -WIDTH_STEP)));
                settings.widths[col.key] = next;
                saveSettings(key, settings);
                applyColumns(table, cols, settings);
                row.querySelector('.fp-col-wval').textContent = next;
            });
        });

        // 顺序↑↓（TODO37）：交换目标列在有效顺序中的位置，保存完整顺序并重排DOM
        panel.querySelectorAll('.fp-col-wbtn[data-col-move]').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const row = btn.closest('.fp-col-row');
                const colKeyVal = row.dataset.colKey;
                // 当前面板行的顺序即当前DOM顺序
                const curOrder = cols.map(c => c.key);
                const i = curOrder.indexOf(colKeyVal);
                const j = i + Number(btn.dataset.colMove);
                if (i < 0 || j < 0 || j >= curOrder.length) return;
                const tmp = curOrder[i]; curOrder[i] = curOrder[j]; curOrder[j] = tmp;
                const settings = loadSettings(key);
                settings.order = curOrder;
                saveSettings(key, settings);
                // 重排DOM并按新顺序刷新面板（列行顺序随之更新）
                const newCols = reapply(table, opts);
                renderPanelBody(table, key, newCols, opts);
            });
        });

        // 双击列名重置该列宽（清内联恢复CSS类默认）
        panel.querySelectorAll('.fp-col-name').forEach(name => {
            name.addEventListener('dblclick', () => {
                const row = name.closest('.fp-col-row');
                const col = keyToCol.get(row.dataset.colKey);
                if (!col) return;
                const settings = loadSettings(key);
                delete settings.widths[col.key];
                saveSettings(key, settings);
                applyColumns(table, cols, settings);
                row.querySelector('.fp-col-wval').textContent = '默认';
            });
        });

        // 恢复默认：清除该表全部配置，列顺序回到首次apply记录的原始列序
        panel.querySelector('[data-col-reset]').addEventListener('click', () => {
            const defOrder = defaultOrders.get(key) || [];
            saveSettings(key, { hidden: {}, widths: {}, order: defOrder.slice() });
            const newCols = reapply(table, opts);
            renderPanelBody(table, key, newCols, { ...opts, lockKeys: lockKeyArr });
        });

        panel.querySelector('[data-col-close]').addEventListener('click', closePanel);
    }

    /**
     * 取列默认渲染宽度（无内联无保存时，读computed width四舍五入）
     * @param {HTMLElement} th
     */
    function defaultWidth(th) {
        const w = th.getBoundingClientRect().width;
        return Math.round(w) || WIDTH_MIN;
    }

    // ============================================================
    // HTML转义（列名/attr安全输出）
    // ============================================================
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function escapeAttr(s) { return escapeHtml(s); }

    // ============================================================
    // 对外主入口
    // ============================================================

    /**
     * 对表格应用列设置并插入齿轮（幂等，渲染后调用）
     * 主流程：清理旧齿轮 → 收集列（记录原始列序，恢复默认用）→ 列数≤7时直接返回 →
     *         按保存顺序重排 → 重新收集列应用显隐/宽度 → afterApply回调 →
     *         齿轮插入第一个非跳过列的th → 绑定齿轮点击开关面板
     * @param {HTMLTableElement} table 表格元素
     * @param {Object} opts
     * @param {string} opts.key 表格唯一持久化key（必填）
     * @param {string[]} [opts.lockKeys] 锁定不可隐藏的列key（名称/代码等关键列）
     * @param {string[]} [opts.skipGearClasses] 齿轮插入时跳过的th类名（如checkbox列，齿轮插到其后的第一列）
     * @param {Function} [opts.afterApply] 列配置应用后的宿主回调({table})，如竞价表重算sticky偏移
     */
    function apply(table, opts) {
        if (!table || !opts || !opts.key) return;
        // 先移除旧齿轮再收集列（否则旧齿轮的"⚙"字符会混入th文本污染列key/label）
        const oldGear = table.querySelector('.' + GEAR_CLASS);
        if (oldGear) oldGear.remove();

        const rawCols = collectColumns(table);
        if (rawCols.length < MIN_COLS) {
            // 列数不足时已清理齿轮，直接返回
            return;
        }
        // 记录原始列序（首次apply时），恢复默认时还原列顺序（TODO37）
        if (!defaultOrders.has(opts.key)) {
            defaultOrders.set(opts.key, rawCols.map(c => c.key));
        }

        // 应用顺序/显隐/宽度（统一走reapply）
        const cols = reapply(table, opts);

        // 齿轮插入列：第一个不含跳过类名的列（checkbox列跳过）
        const skipClasses = opts.skipGearClasses || [];
        const gearTh = cols.find(c => !skipClasses.some(cls => c.th.classList.contains(cls)));
        if (!gearTh) return;
        attachGear(table, gearTh.th);

        // 绑定齿轮点击（每次apply重建齿轮，重新绑定）
        const gear = table.querySelector('.' + GEAR_CLASS);
        gear.addEventListener('click', e => {
            e.stopPropagation();
            // 同一齿轮重复点击=关闭；点其他齿轮=切换目标
            if (panelOwner === gear && panel && panel.style.display === 'flex') {
                closePanel();
                return;
            }
            // 打开面板前重新收集列（宿主可能在apply后渲染/排序过表格）
            openPanel(gear, table, opts.key, collectColumns(table), opts);
        });
    }

    return {
        apply,
        MIN_COLS: MIN_COLS,
        // 测试内部函数用（Node环境，参考api.js _internals先例）
        _internals: { loadSettings, saveSettings, colKey, escapeHtml, applyOrder, sortCols }
    };
})();

// Node测试环境导出（浏览器走全局变量）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TableColSettings;
}
