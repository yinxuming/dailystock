/**
 * 集合竞价控制器（CA）
 *
 * 职责：
 * 1. 页面懒加载（首次进入菜单才取数）
 * 2. 分析范围切换（昨日涨停 / 全部自选 / 自选分组）
 * 3. 加载/错误/进度状态管理，刷新（强制重取当日竞价缓存）
 * 4. 筛选（竞价评级、异动类型）、表头排序、评级明细悬停
 *
 * 数据流：CAData.collect → CARating.analyze → CARender 渲染
 */
const CA = (function () {
    'use strict';

    const SCOPE_KEY = 'ca_scope';   // 分析范围记忆 {scope, groupId}
    const SORT_KEY = 'ca_sort';     // 排序记忆 {key, dir}

    // 运行状态
    let initialized = false;
    let loaded = false;
    let loading = false;
    let bootstrapped = false;

    let data = null;                // CAData.collect 原始结果
    let rows = [];                  // 评级后全量行
    let summary = null;             // 汇总
    let visible = [];               // 过滤+排序后可见行

    let scope = { scope: 'zt', groupId: '' };
    let sort = { key: 'gap', dir: -1 };
    let filters = { ratings: new Set(), types: new Set() };

    let els = {};
    let selectedDate = null;        // TODO38.3：选中的竞价日期（null=自动取最近已完成竞价日）

    // TODO39.2：评分方案回溯状态
    let activeSchemeId = 'current'; // 当前选中方案（会话内，不持久化）
    let schemeData = null;          // CAScheme.buildSchemes 结果缓存
    let schemeCycles = null;        // 回测周期 {d1,d3,d5}（近5日明细复用）
    let schemeLoading = false;

    // ===== DOM =====

    function cacheEls() {
        els = {
            groupTabs: document.getElementById('caGroupTabs'),
            btnRefresh: document.getElementById('btnCaRefresh'),
            summary: document.getElementById('caSummary'),
            sector: document.getElementById('caSector'),
            filterBar: document.getElementById('caFilterBar'),
            thead: document.getElementById('caTableHead'),
            tbody: document.getElementById('caTableBody'),
            loading: document.getElementById('caLoading'),
            loadingText: document.getElementById('caLoadingText'),
            error: document.getElementById('caError'),
            errorText: document.getElementById('caErrorText'),
            notice: document.getElementById('caNotice'),
            meta: document.getElementById('caMeta'),
            btnRetry: document.getElementById('btnCaRetry'),
            datePicker: document.getElementById('caDatePicker'),
            btnSyncWl: document.getElementById('btnCaSyncWl'),
            scheme: document.getElementById('caScheme'),
            schemeToggle: document.getElementById('caSchemeToggle'),
            schemeBody: document.getElementById('caSchemeBody')
        };
    }

    function showLoading(msg) {
        if (!els.loading) return;
        els.loadingText.textContent = msg || '正在加载集合竞价数据...';
        els.loading.style.display = '';
        els.error.style.display = 'none';
    }

    function hideLoading() {
        if (els.loading) els.loading.style.display = 'none';
    }

    function showError(msg) {
        hideLoading();
        if (!els.error) return;
        els.errorText.textContent = msg;
        els.error.style.display = '';
    }

    // ===== 记忆 =====

    function restoreState() {
        try {
            const s = JSON.parse(localStorage.getItem(SCOPE_KEY) || 'null');
            if (s && s.scope) scope = { scope: s.scope, groupId: s.groupId || '' };
            const so = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
            if (so && so.key) sort = { key: so.key, dir: so.dir === 1 ? 1 : -1 };
        } catch (e) { /* 忽略 */ }
    }

    function saveState() {
        try {
            localStorage.setItem(SCOPE_KEY, JSON.stringify(scope));
            localStorage.setItem(SORT_KEY, JSON.stringify(sort));
        } catch (e) { /* 忽略 */ }
    }

    // ===== 分析范围 tab =====

    /** 重建范围 tab（含动态自选分组）并同步高亮 */
    function buildTabs() {
        const groups = (typeof WlGroup !== 'undefined' && WlGroup.getGroups) ? WlGroup.getGroups() : [];
        if (els.groupTabs) {
            els.groupTabs.innerHTML = groups.map(g =>
                `<button class="ca-tab" data-ca-scope="grp" data-ca-group="${escapeHtml(g.id)}">${escapeHtml(g.name)}</button>`
            ).join('');
        }
        syncTabActive();
    }

    /** 同步 tab 高亮状态（含动态生成的自选分组 tab） */
    function syncTabActive() {
        document.querySelectorAll('#caTabs .ca-tab, #caGroupTabs .ca-tab').forEach(t => {
            const sc = t.getAttribute('data-ca-scope');
            const grp = t.getAttribute('data-ca-group');
            const active = (scope.scope === sc) && (sc !== 'grp' || grp === scope.groupId);
            t.classList.toggle('active', !!active);
        });
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ===== 取数 =====

    async function load(force, date) {
        if (loading) return;
        loading = true;
        // TODO38.3：date 非空表示查看历史竞价；null 表示自动取最近已完成竞价日
        selectedDate = (date != null && String(date).trim()) ? String(date).slice(0, 10) : null;
        const forceFlag = !!force;

        showLoading('正在获取集合竞价数据...');
        if (els.notice) els.notice.style.display = 'none';

        try {
            const res = await CAData.collect({
                scope: scope.scope === 'zt' ? 'zt' : 'wl',
                groupId: scope.scope === 'grp' ? scope.groupId : '',
                date: selectedDate,
                force: forceFlag,
                onProgress: (done, total, msg) => {
                    if (msg) {
                        els.loadingText.textContent = msg;
                    } else if (total) {
                        els.loadingText.textContent = `正在获取集合竞价 ${done}/${total}...`;
                    }
                }
            });

            data = res;
            const analyzed = CARating.analyze(res.rows, res.baseline);
            rows = analyzed.rows;
            summary = analyzed.summary;
            loaded = true;

            hideLoading();
            renderAll();
            // TODO39.2：异步构建评分方案回溯（不阻塞主表）
            loadSchemes();
        } catch (e) {
            console.error('集合竞价加载失败:', e);
            showError(e.message || '集合竞价数据加载失败');
        } finally {
            loading = false;
        }
    }

    // ===== 过滤 / 排序 =====

    function applyFilters() {
        visible = rows.filter(r => {
            if (filters.ratings.size && !filters.ratings.has(r.rating)) return false;
            if (filters.types.size && !filters.types.has(r.anomalyType)) return false;
            return true;
        });

        const key = sort.key;
        const dir = sort.dir;
        visible.sort((a, b) => {
            const va = a[key];
            const vb = b[key];
            // 空值统一沉底
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
            return String(va).localeCompare(String(vb), 'zh-CN') * dir;
        });
    }

    // ===== 渲染 =====

    /** TODO38.2：对竞价结果表应用列设置（显隐/宽度/顺序），并在重排后重算前三列 sticky 偏移 */
    function applyTableSettings() {
        const table = els.thead && els.thead.closest('table');
        if (!table) return;
        TableColSettings.apply(table, {
            key: 'ca_list',
            lockKeys: ['code', 'name'],
            afterApply: () => {
                if (typeof CARender.updateStickyOffsets === 'function') {
                    CARender.updateStickyOffsets(els.thead);
                }
            }
        });
    }

    function renderAll() {
        if (!summary) return;
        CARender.renderSummary(els.summary, summary, data && data.dates);
        const sectors = (scope.scope === 'zt') ? CARating.sectorTop(rows) : null;
        CARender.renderSector(els.sector, sectors);
        CARender.renderFilters(els.filterBar, summary, filters);
        applyFilters();
        CARender.renderTable(els.thead, els.tbody, visible, sort,
            rows.length ? '当前筛选条件下没有匹配的个股' : '该范围下没有可分析的个股');
        applyTableSettings();
        renderMeta();
        renderNotice();
    }

    function renderMeta() {
        if (!els.meta || !data) return;
        const d = data.dates;
        const n = visible.length === rows.length
            ? `${rows.length} 只`
            : `${visible.length} / ${rows.length} 只`;
        els.meta.textContent = `${d.target} 集合竞价 · ${data.scopeLabel} · ${n}`;
    }

    function renderNotice() {
        if (!els.notice || !data) return;
        const d = data.dates;
        const missing = rows.filter(r => r.anomalyType === '无数据').length;
        const tips = [];

        if (!d.isToday) {
            if (selectedDate) {
                tips.push(`当前查看历史竞价 <b>${escapeHtml(d.target)}</b>（后端定时采集缓存，实时列以当日09:25快照为准）。`);
            } else {
                tips.push(`今日集合竞价尚未开始，当前展示最近一个交易日 <b>${escapeHtml(d.target)}</b> 的结果。`);
            }
        }
        if (missing > 0) {
            tips.push(`有 <b>${missing}</b> 只未取到竞价数据（停牌或接口未返回），已标记为「无数据」。`);
        }
        if (!tips.length) {
            els.notice.style.display = 'none';
            return;
        }
        els.notice.className = 'ca-notice info';
        els.notice.innerHTML = tips.join(' ');
        els.notice.style.display = '';
    }

    // ===== 评分方案回溯（TODO39.2） =====

    /**
     * 从目标日往前取 N 个交易日（升序，含目标日），供回测窗口使用
     * @param {string} target YYYY-MM-DD
     * @param {number} n 至少需要的回溯天数（含目标日）
     * @returns {Array<string>} 升序交易日列表
     */
    function recentTradeDates(target, n) {
        const arr = [target];
        let cur = new Date(target + 'T00:00:00');
        for (let i = 1; i < n; i++) {
            const prev = TradingCalendar.getPreviousTradeDate(cur, 1);
            if (!prev) break;
            arr.unshift(prev);
            cur = new Date(prev + 'T00:00:00');
        }
        return arr;
    }

    /**
     * 构建五方案并渲染方案区（异步，缓存避免重复调优）
     * 流程：确定目标日 → 构造回测窗口交易日 → 并行构建 d1/d3/d5 周期 →
     *       CAScheme.buildSchemes 爬山调优 → 渲染。
     */
    async function loadSchemes() {
        if (schemeLoading || !els.scheme || typeof CAScheme === 'undefined') return;
        const target = data && data.dates ? data.dates.target : null;
        if (!target) return;
        schemeLoading = true;
        els.scheme.style.display = '';
        if (els.schemeBody) els.schemeBody.innerHTML = '<div class="ca-empty">方案调优计算中...</div>';

        try {
            const dates = recentTradeDates(target, 8);   // 目标日 + 前7个交易日
            const [d1, d3, d5] = await Promise.all([
                CAData.buildBacktestCycles(dates, target, 1),
                CAData.buildBacktestCycles(dates, target, 3),
                CAData.buildBacktestCycles(dates, target, 5)
            ]);
            schemeCycles = { d1: d1, d3: d3, d5: d5 };
            schemeData = CAScheme.buildSchemes({
                base: CAScheme.defaultConfig(),
                cycles: { d1: d1, d3: d3, d5: d5 },
                topN: CAScheme.DEFAULT_TOPN,
                sealRatio: 5
            });
            renderScheme();
        } catch (e) {
            console.error('评分方案回溯失败:', e);
            if (els.schemeBody) {
                els.schemeBody.innerHTML = '<div class="ca-empty">方案回溯失败: ' + escapeHtml(e.message || e) + '</div>';
            }
        } finally {
            schemeLoading = false;
        }
    }

    /** 渲染方案区（tab + 参数 + 对比表 + 近5日回测明细） */
    function renderScheme() {
        if (!schemeData || !els.schemeBody) return;
        // 选中方案回退：默认当前方案（TODO39.2.4），不可用时回退
        if (!schemeData[activeSchemeId]) activeSchemeId = 'current';
        const backtest = buildBacktestDetail();
        CARender.renderSchemeArea(els.schemeBody, {
            schemes: schemeData,
            activeId: activeSchemeId,
            backtest: backtest,
            topN: CAScheme.DEFAULT_TOPN,
            sealRatio: 5
        });
    }

    /**
     * 近5日回测明细（用当前选中方案在 d5 窗口逐日算 TopN 及各自收益）
     * @returns {Array<{date:string, avg:number|null, top:Array}>}
     */
    function buildBacktestDetail() {
        if (!schemeData || !schemeCycles || !schemeCycles.d5) return [];
        const cfg = (schemeData[activeSchemeId] || schemeData.current).config;
        return CAScheme.evalSchemeDetail(schemeCycles.d5, cfg, CAScheme.DEFAULT_TOPN, 5);
    }

    /** 方案 tab 切换：选中后按该方案重算主表 score/tier 并重渲 */
    function onSchemeClick(e) {
        const btn = e.target.closest('[data-ca-scheme]');
        if (!btn) return;
        const id = btn.getAttribute('data-ca-scheme');
        if (!schemeData || !schemeData[id]) return;
        activeSchemeId = id;
        applySchemeToRows();
        renderScheme();
        applyFilters();
        CARender.renderTable(els.thead, els.tbody, visible, sort,
            rows.length ? '当前筛选条件下没有匹配的个股' : '该范围下没有可分析的个股');
        applyTableSettings();
    }

    /** 用选中方案配置重算全量行的 score/tier（默认方案=原始 analyze 结果） */
    function applySchemeToRows() {
        if (!schemeData || !data) return;
        const cfg = (schemeData[activeSchemeId] || schemeData.current).config;
        rows = data.rows.map(r => CARating.computeRow(r, cfg));
    }

    /** 方案区折叠开关 */
    function onSchemeToggle() {
        if (!els.schemeBody) return;
        const hidden = els.schemeBody.style.display === 'none';
        els.schemeBody.style.display = hidden ? '' : 'none';
        const arrow = els.schemeToggle ? els.schemeToggle.querySelector('.ca-scheme-arrow') : null;
        if (arrow) arrow.innerHTML = hidden ? '&#9660;' : '&#9654;';
        if (hidden && schemeData) renderScheme();
    }

    // ===== 事件 =====

    /** 范围切换 */
    function onTabClick(e) {
        const t = e.target.closest('.ca-tab');
        if (!t) return;
        const sc = t.getAttribute('data-ca-scope');
        if (sc === 'grp') scope = { scope: 'grp', groupId: t.getAttribute('data-ca-group') };
        else scope = { scope: sc, groupId: '' };

        saveState();
        filters = { ratings: new Set(), types: new Set() };
        buildTabs();
        load(false);
    }

    /** 表头排序 */
    function onHeadClick(e) {
        const th = e.target.closest('th[data-ca-sort]');
        if (!th) return;
        const key = th.getAttribute('data-ca-sort');
        if (sort.key === key) {
            sort.dir = sort.dir === 1 ? -1 : 1;
        } else {
            sort.key = key;
            // 数值列默认降序更直观，文本列默认升序
            sort.dir = key === 'name' || key === 'code' || key === 'anomalyType' || key === 'rating' || key === 'time' ? 1 : -1;
        }
        saveState();
        applyFilters();
        CARender.renderTable(els.thead, els.tbody, visible, sort, '暂无数据');
        applyTableSettings();
        renderMeta();
    }

    /** 筛选条点击 */
    function onFilterClick(e) {
        const btn = e.target.closest('[data-ca-filter]');
        if (!btn) return;
        const group = btn.getAttribute('data-ca-filter');
        const value = btn.getAttribute('data-ca-value');

        if (group === 'clear') {
            filters.ratings.clear();
            filters.types.clear();
        } else if (group === 'rating') {
            filters.ratings.has(value) ? filters.ratings.delete(value) : filters.ratings.add(value);
        } else if (group === 'type') {
            filters.types.has(value) ? filters.types.delete(value) : filters.types.add(value);
        }
        renderAll();
    }

    /** 评级列悬停显示明细 */
    function onBodyMove(e) {
        const td = e.target.closest('td[data-ca-detail]');
        if (!td) {
            CARender.hideTip();
            return;
        }
        const tr = td.closest('tr');
        if (!tr) return;
        const idx = Number(tr.getAttribute('data-ca-idx'));
        const r = visible[idx];
        if (!r) return;
        CARender.showTip(r, e.clientX, e.clientY);
    }

    function init() {
        if (initialized) return;
        cacheEls();
        restoreState();
        buildTabs();

        const tabsWrap = document.getElementById('caTabs');
        if (tabsWrap) tabsWrap.addEventListener('click', onTabClick);
        if (els.groupTabs) els.groupTabs.addEventListener('click', onTabClick);
        if (els.btnRefresh) {
            els.btnRefresh.addEventListener('click', () => {
                // 强制刷新：清掉当日竞价缓存后重取
                if (data) CAData.clearAuctionCache(data.dates.target);
                load(true);
            });
        }
        // TODO38.3：竞价日期选择器（查看历史交易日竞价，缓存优先；留空=自动取最近已完成竞价日）
        if (els.datePicker) {
            try { els.datePicker.max = TradingCalendar.formatDate(new Date()); } catch (e) { /* 忽略 */ }
            els.datePicker.addEventListener('change', (e) => {
                const v = (e.target.value || '').trim();
                load(false, v || null);
            });
        }
        // TODO38.3：同步自选到定时任务预设（生成带 sync-ca-watchlist 标签的 Issue，协作者审批触发）
        if (els.btnSyncWl) {
            els.btnSyncWl.addEventListener('click', openSyncWatchlistIssue);
        }
        // TODO39.2：评分方案区（tab 切换重算评分、折叠展开）
        if (els.schemeBody) els.schemeBody.addEventListener('click', onSchemeClick);
        if (els.schemeToggle) els.schemeToggle.addEventListener('click', onSchemeToggle);
        if (els.thead) els.thead.addEventListener('click', onHeadClick);
        if (els.btnRetry) els.btnRetry.addEventListener('click', () => load(false));
        if (els.filterBar) els.filterBar.addEventListener('click', onFilterClick);
        if (els.tbody) {
            els.tbody.addEventListener('mousemove', onBodyMove);
            els.tbody.addEventListener('mouseleave', () => CARender.hideTip());
        }
        window.addEventListener('scroll', () => CARender.hideTip(), true);

        initialized = true;
    }

    /**
     * 同步自选到定时任务预设（对齐 sector_analysis「同步预设」UX）：
     * 前端生成带 `sync-ca-watchlist` 标签的 GitHub Issue 链接并新窗口打开，
     * 协作者添加标签后由 sync-ca-watchlist 工作流合并到 ca_watchlist.json（补充，不删除已有）。
     */
    function openSyncWatchlistIssue() {
        const input = window.prompt('同步自选到定时任务预设（竞价每日采集范围）\n请输入 6 位股票代码，多个用逗号/空格/换行分隔：', '');
        if (input == null) return;   // 用户取消
        const valid = String(input).split(/[\s,，]+/).map(s => s.trim()).filter(Boolean)
            .filter(c => /^\d{6}$/.test(c));
        if (!valid.length) {
            alert('未识别到有效的 6 位股票代码');
            return;
        }
        const repo = 'yinxuming/dailystock';   // sync-ca-watchlist 工作流所在私有仓库
        const dateStr = new Date().toISOString().slice(0, 10);
        const body = [
            '## 竞价自选同步请求',
            '',
            '以下自选股票需加入定时任务竞价采集范围（昨日涨停池外的补充自选），以便每日 09:15 自动采样其竞价数据。',
            '',
            '### 新增自选（共 ' + valid.length + ' 只）',
            '',
            '```json',
            JSON.stringify({ stocks: valid }, null, 2),
            '```',
            '',
            '---',
            '> 提交时间: ' + dateStr,
            '> 此 Issue 由前端「同步自选」按钮生成，添加 `sync-ca-watchlist` 标签后将自动触发同步工作流合并到 ca_watchlist.json。'
        ].join('\n');
        const title = '[竞价自选同步] 新增自选 - ' + dateStr;
        const url = 'https://github.com/' + repo + '/issues/new' +
            '?title=' + encodeURIComponent(title) +
            '&body=' + encodeURIComponent(body) +
            '&labels=' + encodeURIComponent('sync-ca-watchlist');
        window.open(url, '_blank');
    }

    /**
     * 主应用切到集合竞价tab时回调（懒加载入口）
     */
    function onTabActivated() {
        init();
        // 每次进入都刷新范围 tab（自选分组可能被增删）
        buildTabs();
        if (!bootstrapped) {
            bootstrapped = true;
            load(false);
        }
    }

    /** 供外部（如自选分组变更）触发的重建 */
    function refreshScopes() {
        if (initialized) buildTabs();
    }

    return {
        onTabActivated,
        refreshScopes,
        reload: (force) => load(force),
        // 测试用
        _state: () => ({ scope, sort, filters, rows, visible, summary })
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CA;
}
