/**
 * 每日复盘渲染模块（FupanRenderer）
 *
 * 职责：四个子tab的DOM渲染（数据由FupanData提供，图表由FupanCharts提供）
 * - renderMarket  大盘：指数卡片（全A置顶/环比/点击分时）、市场概况环比、全市场成交额（末5日标值）、涨跌停与市场宽度趋势（hover数值）
 * - renderSectors 板块轮动：全部/行业/概念涨跌榜TOP50（关注板块筛选）、近10日轮动矩阵（涨跌双榜+可调数量+固定身份色）
 * - renderZT      涨跌停：统计卡、分板块池列表（同花顺模式分类栏）、连板梯队（两行chip/晋级率/未晋级置灰）、晋级率、情绪
 * - renderScore   评分预测：Top5卡片（雷达图）、阈值设置（前端重算）、全量评分表、近5日回测正确率、模型说明
 *
 * 渲染约定：
 * - 板型徽章色：一字板(红最强)>T字(橙)>厂字(黄)>回封(蓝)>换手(灰蓝)>未判定(灰)
 * - 梯队角色色：龙头(金)>跟风(蓝)>首板(灰)>补涨候选(紫)
 * - 通用交互：.stock-table 表头点击排序（makeSortable）；勾选/下拉状态经 FupanData.getSetting/setSetting 持久化
 */
const FupanRenderer = (function () {

    // 板型徽章class映射
    const LIMIT_TYPE_CLASS = {
        '一字板': 'fp-type-yizi',
        'T字板': 'fp-type-t',
        '厂字板': 'fp-type-chang',
        '回封板': 'fp-type-huifeng',
        '换手板': 'fp-type-huanshou'
    };

    // 梯队角色class映射
    const ROLE_CLASS = {
        '龙头': 'fp-role-dragon',
        '跟风': 'fp-role-follower',
        '首板': 'fp-role-first',
        '补涨候选': 'fp-role-catchup'
    };

    // 评分维度中文标签（与后端scoring.py权重键一致）
    const SCORE_DIM_LABELS = {
        priceLevel: '股价',
        floatMV: '市值',
        ztActivity: '活跃',
        sectorEffect: '板块',
        sealQuality: '封板',
        boardType: '板型',
        position: '身位',
        sentiment: '情绪'
    };

    // ===== 通用小工具 =====

    /**
     * HTML转义（防XSS，板块名/股票名等外部数据）
     * @param {*} v 任意值
     * @returns {string} 转义后文本
     */
    function esc(v) {
        return String(v === null || v === undefined ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /**
     * 生成涨跌幅单元格HTML（红涨绿跌 + 空值占位）
     * @param {number} v 涨跌幅
     * @param {boolean} withPercent 是否带%后缀
     * @returns {string} td内容HTML
     */
    function changeTd(v, withPercent) {
        const cls = FupanData.changeClass(v);
        const txt = FupanData.formatChange(v) + (withPercent ? '%' : '');
        return `<td class="${cls}">${txt}</td>`;
    }

    /**
     * 生成板型徽章HTML
     * @param {string} limitType 板型
     * @returns {string} span HTML
     */
    function typeBadge(limitType) {
        if (!limitType) return '<span class="fp-type-badge fp-type-unknown">--</span>';
        const cls = LIMIT_TYPE_CLASS[limitType] || 'fp-type-unknown';
        return `<span class="fp-type-badge ${cls}" title="涨停板类型：${esc(limitType)}">${esc(limitType)}</span>`;
    }

    /**
     * 生成角色徽章HTML（梯队用）
     * @param {string} role 角色
     * @returns {string} span HTML
     */
    function roleBadge(role) {
        if (!role) return '';
        const cls = ROLE_CLASS[role] || '';
        return `<span class="fp-role-badge ${cls}">${esc(role)}</span>`;
    }

    /**
     * 生成统计卡片HTML
     * @param {string} label 标签
     * @param {string} value 值
     * @param {string} [extraCls] 附加class（颜色）
     * @param {string} [deltaHtml] 环比行HTML（较上一交易日，由deltaLine生成）
     * @returns {string} div HTML
     */
    function statCard(label, value, extraCls, deltaHtml) {
        return `<div class="fp-stat-card"><span class="fp-stat-label">${esc(label)}</span><span class="fp-stat-value ${extraCls || ''}">${value}</span>${deltaHtml || ''}</div>`;
    }

    /**
     * 生成环比增量行HTML（较上一交易日，红增绿减；任一侧无数据返回空串）
     * @param {number} cur 当前值
     * @param {number} prev 上一交易日值
     * @param {string} [unit] 单位后缀（'%'/'亿'等，默认无）
     * @param {number} [digits] 小数位（默认0）
     * @returns {string} span HTML
     */
    function deltaLine(cur, prev, unit, digits) {
        if (cur === null || cur === undefined || prev === null || prev === undefined
            || isNaN(cur) || isNaN(prev)) return '';
        const d = cur - prev;
        const cls = FupanData.changeClass(d);
        const txt = (d > 0 ? '+' : '') + d.toFixed(digits === undefined ? 0 : digits) + (unit || '');
        return `<span class="fp-delta ${cls}">较昨日 ${txt}</span>`;
    }

    /**
     * 生成区块容器HTML
     * @param {string} title 标题
     * @param {string} bodyHtml 内容HTML
     * @returns {string} section HTML
     */
    function section(title, bodyHtml) {
        return `<section class="fp-section"><h3 class="fp-section-title">${esc(title)}</h3>${bodyHtml}</section>`;
    }

    // ===== 通用表格排序（TODO5.6.1：所有列表支持点击表头排序） =====

    /**
     * 为表格绑定表头点击排序（幂等）
     * 规则：数值列（td[data-v]或可解析数字文本）按数值排序，否则按文本localeCompare；
     *      点击同列循环 降序→升序→还原，表头显示▼/▲指示；无效值(--等)始终排末尾
     * @param {HTMLElement} tableEl .stock-table 表格元素
     */
    function makeSortable(tableEl) {
        if (!tableEl || tableEl.dataset.sortableBound || tableEl.dataset.noSort) return;
        tableEl.dataset.sortableBound = '1';
        const thead = tableEl.querySelector('thead');
        const tbody = tableEl.querySelector('tbody');
        if (!thead || !tbody) return;
        const ths = Array.from(thead.querySelectorAll('th'));

        /**
         * 提取单元格排序值
         * @param {HTMLElement} tr 行元素
         * @param {number} idx 列序号
         * @returns {{num:number}|{text:string}|{missing:true}} 数值/文本/缺失
         */
        function cellInfo(tr, idx) {
            const td = tr.children[idx];
            if (!td) return { missing: true };
            const raw = (td.dataset.v !== undefined ? td.dataset.v : td.textContent).trim();
            if (raw === '' || raw === '--') return { missing: true };
            const m = raw.replace(/[,\s]/g, '').match(/^-?\d+(\.\d+)?$/);
            return m ? { num: parseFloat(m[0]) } : { text: raw };
        }

        ths.forEach((th, idx) => {
            th.classList.add('th-sortable');
            th.title = (th.title ? th.title + '\n' : '') + '点击排序';
            th.addEventListener('click', () => {
                const prev = th.dataset.sortDir;         // undefined/'desc'/'asc'
                const dir = !prev ? 'desc' : (prev === 'desc' ? 'asc' : null);
                ths.forEach(t => { delete t.dataset.sortDir; t.classList.remove('th-asc', 'th-desc'); });
                if (!tbody.children.length) return;
                // 首次点击时保存原始行序（还原用）
                if (!tbody.__origRows) tbody.__origRows = Array.from(tbody.children);
                if (dir) {
                    th.dataset.sortDir = dir;
                    th.classList.add(dir === 'desc' ? 'th-desc' : 'th-asc');
                    const infos = Array.from(tbody.children).map(tr => ({ tr, v: cellInfo(tr, idx) }));
                    const anyNum = infos.some(x => x.v.num !== undefined);
                    const numeric = anyNum && infos.every(x => x.v.num !== undefined || x.v.missing);
                    infos.sort((a, b) => {
                        // 缺失值（--/空）固定排末尾
                        if (a.v.missing !== b.v.missing) return a.v.missing ? 1 : -1;
                        let cmp;
                        if (numeric) cmp = a.v.num - b.v.num;
                        else cmp = String(a.v.text || '').localeCompare(String(b.v.text || ''), 'zh-CN');
                        return dir === 'desc' ? -cmp : cmp;
                    });
                    infos.forEach(x => tbody.appendChild(x.tr));
                } else {
                    // 第三次点击：还原原始顺序
                    (tbody.__origRows || []).forEach(r => tbody.appendChild(r));
                }
            });
        });
    }

    /**
     * 为容器内全部.stock-table绑定排序（渲染完列表后统一调用）
     * @param {HTMLElement} root 容器
     */
    function bindSortTables(root) {
        (root || document).querySelectorAll('table.stock-table').forEach(makeSortable);
    }

    /**
     * 生成复选框HTML（状态持久化由调用方绑定change事件）
     * @param {string} key data属性名（data-fp-xxx）
     * @param {boolean} checked 是否勾选
     * @param {string} label 文案
     * @returns {string} label HTML
     */
    function checkHtml(key, checked, label) {
        return `<label class="fp-check"><input type="checkbox" ${key}${checked ? ' checked' : ''}> ${esc(label)}</label>`;
    }

    // ===== 子tab1：大盘 =====

    /**
     * 渲染大盘tab
     * 主流程：取上一交易日数据（环比用）→ 指数卡片（全A置顶+可点击分时+成交额环比）
     *        → 市场概况（各指标较昨日增减）→ 全市场成交额柱状图（近5日标值）
     *        → 涨停/跌停与涨跌家数趋势（hover显示具体值）
     * @param {HTMLElement} container 容器
     * @param {Object} day 单日复盘数据
     * @param {string} dateStr 当前日期
     */
    async function renderMarket(container, day, dateStr) {
        const m = day.market || {};
        const act = m.activity || {};
        const allA = m.allA || {};
        const fmt = FupanData.formatAmount;

        // 0. 上一交易日数据（环比对比用；最早一日/数据缺失时不显示环比）
        let prevDay = null;
        try {
            const dates = await FupanData.getRecentDates(dateStr, 2);
            if (dates.length === 2) prevDay = await FupanData.getDay(dates[0]);
        } catch (e) { /* 首日无前日数据，环比隐藏 */ }
        const prevMarket = (prevDay && prevDay.market) || {};
        const prevAct = prevMarket.activity || {};
        const prevAllA = prevMarket.allA || {};

        // 1. 指数卡片行：中证全A置顶，全部可点击跳转东财分时页
        const indices = (m.indices || []).slice()
            .sort((a, b) => (b.code === '000985') - (a.code === '000985'));
        // 全A指数成交额环比（较上一交易日增量，红涨绿跌）
        const qa = indices.find(i => i.code === '000985') || {};
        const prevQa = ((prevMarket.indices || []).find(i => i.code === '000985')) || {};
        let indicesHtml = '<div class="fp-index-row">';
        indices.forEach(idx => {
            const cls = FupanData.changeClass(idx.change);
            let amountDelta = '';
            if (idx.code === '000985' && qa.amount != null && prevQa.amount != null) {
                amountDelta = deltaLine(qa.amount, prevQa.amount, '亿', 1);
            }
            indicesHtml += `
                <div class="fp-index-card" data-fp-index="${esc(idx.code)}" title="点击查看分时行情" role="button">
                    <div class="fp-index-name">${esc(idx.name)}</div>
                    <div class="fp-index-close">${idx.close !== null && idx.close !== undefined ? idx.close.toFixed(2) : '--'}</div>
                    <div class="fp-index-change ${cls}">${FupanData.formatChange(idx.change)}%</div>
                    <div class="fp-index-amount">成交 ${fmt(idx.amount)}</div>
                    ${amountDelta}
                </div>`;
        });
        indicesHtml += '</div>';

        // 2. 市场概况卡（各指标带较昨日增减，红涨绿跌）
        const overviewHtml = `
            <div class="fp-stat-grid">
                ${statCard('上涨家数', act.upCount ?? '--', 'change-up', deltaLine(act.upCount, prevAct.upCount))}
                ${statCard('下跌家数', act.downCount ?? '--', 'change-down', deltaLine(act.downCount, prevAct.downCount))}
                ${statCard('平盘', act.flatCount ?? '--', '', deltaLine(act.flatCount, prevAct.flatCount))}
                ${statCard('涨停(真实)', `${act.limitUp ?? '--'} (${act.realLimitUp ?? '--'})`, 'change-up', deltaLine(act.limitUp, prevAct.limitUp))}
                ${statCard('跌停(真实)', `${act.limitDown ?? '--'} (${act.realLimitDown ?? '--'})`, 'change-down', deltaLine(act.limitDown, prevAct.limitDown))}
                ${statCard('停牌', act.suspend ?? '--', '', deltaLine(act.suspend, prevAct.suspend))}
                ${statCard('全A中位数涨幅', FupanData.formatChange(allA.medianChange) + '%', FupanData.changeClass(allA.medianChange), deltaLine(allA.medianChange, prevAllA.medianChange, '%', 2))}
                ${statCard('全A平均涨幅', FupanData.formatChange(allA.avgChange) + '%', FupanData.changeClass(allA.avgChange), deltaLine(allA.avgChange, prevAllA.avgChange, '%', 2))}
            </div>`;

        // 3. 趋势图（近20日）：成交额为全市场口径（沪+深+北证），数值单位亿（不显示单位，2位小数）
        const amountTrend = await FupanData.getTrend(dateStr, 20, 'totalAmount');
        const ztTrend = await FupanData.getTrend(dateStr, 20, 'ztCount');
        const dtTrend = await FupanData.getTrend(dateStr, 20, 'dtCount');
        const upTrend = await FupanData.getTrend(dateStr, 20, 'upCount');
        const downTrend = await FupanData.getTrend(dateStr, 20, 'downCount');

        const amountChart = FupanCharts.barChart({
            labels: amountTrend.labels,
            values: amountTrend.values,
            height: 180,
            color: '#3b82f6',
            valueFormat: v => (v / 1e8).toFixed(2),
            axisFormat: v => (v / 1e8).toFixed(0),
            valueLabels: 5
        });
        const sentimentChart = FupanCharts.lineChart({
            labels: ztTrend.labels,
            series: [
                { name: '涨停家数', values: ztTrend.values, color: '#ef4444' },
                { name: '跌停家数', values: dtTrend.values, color: '#22c55e' }
            ],
            height: 180,
            combinedHover: true
        });
        const breadthChart = FupanCharts.lineChart({
            labels: upTrend.labels,
            series: [
                { name: '上涨家数', values: upTrend.values, color: '#ef4444' },
                { name: '下跌家数', values: downTrend.values, color: '#22c55e' }
            ],
            height: 180,
            combinedHover: true
        });

        container.innerHTML = `
            ${section('指数表现', indicesHtml)}
            ${section('市场概况', overviewHtml)}
            <div class="fp-chart-row">
                <div class="fp-chart-box"><h4 class="fp-chart-title">全市场成交额（近20日，含北证，单位亿）</h4></div>
                <div class="fp-chart-box"><h4 class="fp-chart-title">涨停/跌停家数（近20日）</h4></div>
            </div>
            ${section('市场宽度：涨跌家数（近20日）', '<div class="fp-chart-box"></div>')}`;

        // 图表插入对应容器
        const boxes = container.querySelectorAll('.fp-chart-box');
        boxes[0].appendChild(amountChart);
        boxes[1].appendChild(sentimentChart);
        boxes[2].appendChild(breadthChart);

        // 指数卡片点击跳转东财分时页
        container.querySelectorAll('[data-fp-index]').forEach(card => {
            card.addEventListener('click', () => {
                window.open('https://quote.eastmoney.com/zs' + card.dataset.fpIndex + '.html', '_blank');
            });
        });
    }

    // ===== 子tab2：板块轮动 =====

    // 板块视图与筛选的持久化key
    const BOARD_VIEW_KEY = 'fupan_board_view';          // 全部/行业/概念
    const BOARD_FOCUS_KEY = 'fupan_sectors_focus_only'; // 仅显示关注板块
    const MATRIX_COUNT_KEY = 'fupan_matrix_count';      // 矩阵每列涨跌榜板块数
    const MATRIX_FOCUS_KEY = 'fupan_matrix_focus_only'; // 矩阵仅显示关注板块
    const BOARD_TOP_N = 50;                             // 涨跌榜条数上限

    /**
     * 渲染板块轮动tab
     * 主流程：当日板块涨跌榜（全部/行业/概念，默认全部；关注板块筛选）→ 近10日轮动矩阵（涨跌双榜、数量可调、关注筛选、固定身份色）
     * @param {HTMLElement} container 容器
     * @param {Object} day 单日复盘数据
     * @param {string} dateStr 当前日期
     */
    function renderSectors(container, day, dateStr) {
        const sectors = day.sectors || {};

        // 工具栏状态（持久化：视图默认"全部"，关注筛选默认不勾选）
        const view = FupanData.getSetting(BOARD_VIEW_KEY, 'all');
        const focusOnly = FupanData.getSetting(BOARD_FOCUS_KEY, false);
        const mCount = clampMatrixCount(FupanData.getSetting(MATRIX_COUNT_KEY, 5));
        const mFocus = FupanData.getSetting(MATRIX_FOCUS_KEY, false);

        const boardHtml = `
            <div class="fp-board-toolbar">
                <div class="fp-board-switch">
                    <button class="sub-tab${view === 'all' ? ' active' : ''}" data-fp-board="all" title="行业+概念合并排序">全部</button>
                    <button class="sub-tab${view === 'industry' ? ' active' : ''}" data-fp-board="industry">行业</button>
                    <button class="sub-tab${view === 'concept' ? ' active' : ''}" data-fp-board="concept">概念</button>
                </div>
                ${checkHtml('data-fp-focus-only', focusOnly, '仅显示关注板块')}
            </div>
            <div class="fp-board-panels" id="fpBoardPanels"></div>`;

        const matrixHtml = `
            <div class="fp-board-toolbar">
                <label class="fp-check">每列显示
                    <input type="number" class="fp-matrix-n" data-fp-matrix-n min="3" max="10" step="1" value="${mCount}"> 个板块（涨/跌各）
                </label>
                ${checkHtml('data-fp-matrix-focus', mFocus, '仅显示关注板块')}
            </div>
            <div class="fp-rot-wrap" id="fpMatrixWrap">
                <div class="loading"><div class="loading-spinner"></div><span class="loading-text">正在加载近10日板块数据...</span></div>
            </div>`;

        container.innerHTML = `
            ${section('当日板块涨跌榜', boardHtml)}
            ${section('近10日行业轮动矩阵', matrixHtml)}`;

        const panelEl = document.getElementById('fpBoardPanels');
        const matrixWrap = document.getElementById('fpMatrixWrap');

        // 榜单渲染（关注筛选变化时整建）
        const rebuildBoards = () => {
            renderBoardPanels(panelEl, sectors,
                FupanData.getSetting(BOARD_VIEW_KEY, 'all'),
                FupanData.getSetting(BOARD_FOCUS_KEY, false));
            bindSortTables(panelEl);
        };
        rebuildBoards();

        // 视图切换（持久化）
        container.querySelectorAll('[data-fp-board]').forEach(btn => {
            btn.addEventListener('click', () => {
                FupanData.setSetting(BOARD_VIEW_KEY, btn.dataset.fpBoard);
                container.querySelectorAll('[data-fp-board]').forEach(b => b.classList.toggle('active', b === btn));
                panelEl.querySelectorAll('[data-fp-board-panel]').forEach(p => {
                    p.style.display = p.dataset.fpBoardPanel === btn.dataset.fpBoard ? '' : 'none';
                });
            });
        });

        // 关注板块筛选（持久化，重建榜单）
        const focusCb = container.querySelector('[data-fp-focus-only]');
        if (focusCb) focusCb.addEventListener('change', () => {
            FupanData.setSetting(BOARD_FOCUS_KEY, focusCb.checked);
            rebuildBoards();
            // 保持当前视图面板可见
            const cur = FupanData.getSetting(BOARD_VIEW_KEY, 'all');
            panelEl.querySelectorAll('[data-fp-board-panel]').forEach(p => {
                p.style.display = p.dataset.fpBoardPanel === cur ? '' : 'none';
            });
        });

        // 矩阵（近10日，异步多日取数）
        const rebuildMatrix = async () => {
            const n = clampMatrixCount(FupanData.getSetting(MATRIX_COUNT_KEY, 5));
            const mFocusNow = FupanData.getSetting(MATRIX_FOCUS_KEY, false);
            try {
                const dates = await FupanData.getRecentDates(dateStr, 10);
                const daysData = await Promise.all(dates.map(d => FupanData.getDay(d)));
                buildMatrix(matrixWrap, dates, daysData, n, mFocusNow);
            } catch (e) {
                matrixWrap.innerHTML = `<div class="error"><span>矩阵加载失败: ${esc(e.message)}</span></div>`;
            }
        };
        rebuildMatrix();

        // 矩阵板块数调整（持久化，重建矩阵）
        const nInput = container.querySelector('[data-fp-matrix-n]');
        if (nInput) nInput.addEventListener('change', () => {
            const n = clampMatrixCount(nInput.value);
            nInput.value = n;
            FupanData.setSetting(MATRIX_COUNT_KEY, n);
            rebuildMatrix();
        });
        // 矩阵关注筛选（持久化，重建矩阵）
        const mFocusCb = container.querySelector('[data-fp-matrix-focus]');
        if (mFocusCb) mFocusCb.addEventListener('change', () => {
            FupanData.setSetting(MATRIX_FOCUS_KEY, mFocusCb.checked);
            rebuildMatrix();
        });
    }

    /**
     * 矩阵板块数钳制（3~10，默认5）
     * @param {*} v 输入值
     * @returns {number}
     */
    function clampMatrixCount(v) {
        const n = Math.round(Number(v));
        if (isNaN(n)) return 5;
        return Math.max(3, Math.min(10, n));
    }

    /**
     * 关注板块名称集合（原始名集合；selectedSectors_all 中行业"_行"后缀归一为原始名）
     * @param {string} type 'industry'/'concept'/'all'（all=三类合并）
     * @returns {Set<string>} 原始板块名集合
     */
    function watchedNameSet(type) {
        const set = new Set();
        const absorb = arr => (arr || []).forEach(n => set.add(String(n).replace(/_行$/, '')));
        if (type === 'industry' || type === 'all') absorb(FupanData.getWatchedSectors('industry'));
        if (type === 'concept' || type === 'all') absorb(FupanData.getWatchedSectors('concept'));
        if (type === 'all') absorb(FupanData.getWatchedSectors('all'));
        return set;
    }

    /**
     * 组装某视图的板块涨跌榜数据（行携带type用于关注匹配）
     * 全部视图 = 行业+概念合并按涨跌幅排序；同名时行业显示名加"_行"后缀（仅显示，匹配仍用原名）
     * @param {Object} sectors day.sectors
     * @param {string} view all/industry/concept
     * @returns {{up: Array, down: Array}}
     */
    function boardsForView(sectors, view) {
        const pick = (board, list) => (((sectors[board] || {})[list]) || [])
            .map(r => Object.assign({ type: board }, r));
        if (view === 'industry') return { up: pick('industry', 'topUp'), down: pick('industry', 'topDown') };
        if (view === 'concept') return { up: pick('concept', 'topUp'), down: pick('concept', 'topDown') };
        // 全部：合并排序（跌幅榜由低到高）
        const indUp = pick('industry', 'topUp'), indDown = pick('industry', 'topDown');
        const conUp = pick('concept', 'topUp'), conDown = pick('concept', 'topDown');
        // 显示名加"_行"后缀（行业与概念同名时，便于区分）
        const conNames = new Set(conUp.concat(conDown).map(r => r.name));
        indUp.concat(indDown).forEach(r => { r.displayName = conNames.has(r.name) ? r.name + '_行' : r.name; });
        const up = indUp.concat(conUp).sort((a, b) => (b.change ?? -999) - (a.change ?? -999));
        const down = indDown.concat(conDown).sort((a, b) => (a.change ?? 999) - (b.change ?? 999));
        return { up, down };
    }

    /**
     * 按关注板块过滤榜单行
     * @param {Array} rows 榜单行（含type/name）
     * @param {string} view 当前视图
     * @returns {Array} 过滤后行
     */
    function filterWatched(rows, view) {
        const ind = watchedNameSet('industry');
        const con = watchedNameSet('concept');
        const all = watchedNameSet('all');
        return rows.filter(r => {
            if (r.type === 'industry') return ind.has(r.name) || all.has(r.name);
            return con.has(r.name) || all.has(r.name);
        });
    }

    /**
     * 渲染板块榜单面板（全部/行业/概念三面板，涨跌双榜TOP50）
     * @param {HTMLElement} panelEl 面板容器
     * @param {Object} sectors sectors数据
     * @param {string} view 当前视图 all/industry/concept
     * @param {boolean} focusOnly 是否仅显示关注板块
     */
    function renderBoardPanels(panelEl, sectors, view, focusOnly) {
        panelEl.innerHTML = '';
        ['all', 'industry', 'concept'].forEach(board => {
            const data = boardsForView(sectors, board);
            const upRows = focusOnly ? filterWatched(data.up, board) : data.up;
            const downRows = focusOnly ? filterWatched(data.down, board) : data.down;
            const emptyHint = focusOnly && !watchedNameSet('all').size;
            const upHtml = emptyHint ? FOCUS_EMPTY_HINT : boardTable(upRows, true);
            const downHtml = emptyHint ? FOCUS_EMPTY_HINT : boardTable(downRows, false);
            const upTitle = focusOnly ? `涨幅榜（关注 ${upRows.length}）` : `涨幅榜 TOP50`;
            const downTitle = focusOnly ? `跌幅榜（关注 ${downRows.length}）` : `跌幅榜 TOP50`;
            const panel = document.createElement('div');
            panel.className = 'fp-board-panel';
            panel.dataset.fpBoardPanel = board;
            panel.style.display = board === view ? '' : 'none';
            panel.innerHTML = `
                <div class="fp-board-cols">
                    <div><h4 class="fp-chart-title change-up">${upTitle}</h4>${upHtml}</div>
                    <div><h4 class="fp-chart-title change-down">${downTitle}</h4>${downHtml}</div>
                </div>`;
            panelEl.appendChild(panel);
        });
    }

    // 关注板块为空时的提示文案
    const FOCUS_EMPTY_HINT = '<div class="fp-empty">暂未配置关注板块（板块资金菜单 → 关注板块管理 勾选）</div>';

    /**
     * 生成板块榜单表格HTML（TOP50，数值格带data-v支持表头排序）
     * @param {Array} list 板块数组
     * @param {boolean} isUp 涨幅榜true/跌幅榜false
     * @returns {string} table HTML
     */
    function boardTable(list, isUp) {
        if (!list || !list.length) return '<div class="fp-empty">暂无数据</div>';
        const rows = list.slice(0, BOARD_TOP_N).map(s => {
            const inflow = s.mainNetInflow;
            return `
            <tr>
                <td class="fp-sec-name" title="${esc(s.name)}">${esc(s.displayName || s.name)}</td>
                <td class="${FupanData.changeClass(s.change)}" data-v="${s.change ?? ''}">${FupanData.formatChange(s.change)}%</td>
                <td data-v="${s.upCount ?? ''}">${s.upCount ?? '--'}</td>
                <td data-v="${s.downCount ?? ''}">${s.downCount ?? '--'}</td>
                <td>${esc(s.leadStock || '--')}</td>
                <td class="${FupanData.changeClass(s.leadChange)}" data-v="${s.leadChange ?? ''}">${FupanData.formatChange(s.leadChange)}%</td>
                <td class="${(inflow || 0) >= 0 ? 'change-up' : 'change-down'}" data-v="${inflow ?? ''}">${FupanData.formatYi(inflow)}</td>
            </tr>`;
        }).join('');
        return `
            <div class="table-wrapper">
                <table class="stock-table fp-board-table">
                    <thead><tr>
                        <th>板块</th><th>涨跌幅%</th><th>涨</th><th>跌</th><th>领涨股</th><th>领涨涨幅%</th><th title="主力净流入，单位亿元">主力净流入(亿)</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    /**
     * 板块身份固定背景色（同名板块跨日期/跨格子同色，追踪轮动）
     * @param {string} name 板块名
     * @returns {string} CSS颜色
     */
    function sectorColor(name) {
        let h = 0;
        const s = String(name);
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
        return `hsl(${h}, 42%, 30%)`;
    }

    /**
     * 构建近10日行业轮动矩阵（每列=一个交易日：上半涨幅榜TOP N、下半跌幅榜TOP N）
     * 格子背景=板块身份固定色，涨跌幅文字红涨绿跌；仅显示关注板块时过滤非关注格子
     * @param {HTMLElement} wrap 矩阵容器
     * @param {string[]} dates 交易日列表（升序）
     * @param {Object[]} daysData 各日复盘数据（与dates等长）
     * @param {number} n 每列涨/跌榜各显示板块数
     * @param {boolean} focusOnly 是否仅显示关注板块
     */
    function buildMatrix(wrap, dates, daysData, n, focusOnly) {
        if (focusOnly && !watchedNameSet('all').size) {
            wrap.innerHTML = FOCUS_EMPTY_HINT;
            return;
        }
        const watched = watchedNameSet(focusOnly ? 'all' : 'none');
        /**
         * 某日某榜单的展示行（关注过滤后截断TOP N）
         * @param {Object} secData 当日sectors.industry
         * @param {string} listKey topUp/topDown
         * @param {string} date 日期（title用）
         */
        const cellList = (secData, listKey, date) => {
            let rows = ((secData || {})[listKey]) || [];
            if (focusOnly) rows = rows.filter(r => watched.has(r.name));
            return rows.slice(0, n).map(r => {
                const chg = r.change;
                const chgCls = chg > 0 ? 'fp-rot-up' : (chg < 0 ? 'fp-rot-down' : '');
                return `<div class="fp-rot-cell" style="background:${sectorColor(r.name)}" title="${esc(r.name)} ${esc(date)}：${FupanData.formatChange(chg)}%">
                    <span class="fp-rot-name" title="${esc(r.name)}">${esc(r.name)}</span>
                    <span class="fp-rot-chg ${chgCls}">${FupanData.formatChange(chg)}%</span>
                </div>`;
            }).join('');
        };

        const cols = dates.map((d, i) => {
            const sec = (((daysData[i] || {}).sectors || {}).industry) || {};
            return `
                <div class="fp-rot-col">
                    <div class="fp-rot-date">${esc(d.slice(5))}</div>
                    ${cellList(sec, 'topUp', d) || '<div class="fp-rot-cell fp-rot-empty">--</div>'}
                    <div class="fp-rot-divider" title="以下为当日跌幅榜">跌幅榜</div>
                    ${cellList(sec, 'topDown', d) || '<div class="fp-rot-cell fp-rot-empty">--</div>'}
                </div>`;
        }).join('');

        wrap.innerHTML = `
            <div class="fp-rot-grid">${cols}</div>
            <div class="fp-matrix-legend"><span>每列=交易日：上段涨幅榜/下段跌幅榜；背景色=板块身份色（同板块跨日同色），数字红涨绿跌</span></div>`;
    }

    // ===== 子tab3：涨跌停 =====

    // 涨跌停池与梯队显示的持久化key
    const ZT_CAT_KEY = 'fupan_zt_cat';              // 选中分类（'__all__'=全部）
    const ZT_POOL_KEY = 'fupan_zt_pool';            // 池类型 zt/dt/zb
    const LADDER_ROLE_KEY = 'fupan_ladder_role';    // 梯队显示身位（默认开）
    const LADDER_TYPE_KEY = 'fupan_ladder_type';    // 梯队显示涨停类型（默认开）
    const LADDER_FAILED_KEY = 'fupan_ladder_failed';// 梯队显示未晋级股票（默认关）

    // 板型单字标签（梯队chip用，无数据不显示）
    const LIMIT_TYPE_MINI = { '一字板': '一', 'T字板': 'T', '厂字板': '厂', '回封板': '回', '换手板': '换' };

    /**
     * 时刻字符串转秒数（封板时间排序用）
     * @param {string} t "HH:MM:SS"/"HH:MM"
     * @returns {number} 秒（非法返回Infinity）
     */
    function sealSecs(t) {
        if (!t) return Infinity;
        const p = String(t).split(':').map(Number);
        if (p.length < 2 || p.some(isNaN)) return Infinity;
        return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
    }

    /**
     * 渲染涨跌停tab
     * 主流程：统计卡 → 分板块池列表（左分类栏+右列表，同花顺模式）→ 连板梯队（两行chip/晋级率/未晋级置灰）
     *        → 晋级率 → 情绪
     * @param {HTMLElement} container 容器
     * @param {Object} day 单日复盘数据
     * @param {string} dateStr 当前交易日（取前一日数据对比用）
     */
    async function renderZT(container, day, dateStr) {
        const stats = day.stats || {};
        const sentiment = day.sentiment || {};
        const metrics = sentiment.metrics || {};

        // 0. 上一交易日数据（梯队未晋级股票/多显示一级用）
        let prevDay = null;
        try {
            const dates = await FupanData.getRecentDates(dateStr, 2);
            if (dates.length === 2) prevDay = await FupanData.getDay(dates[0]);
        } catch (e) { /* 首日无前日数据，梯队降级为仅当日 */ }

        // 1. 统计卡
        const statsHtml = `
            <div class="fp-stat-grid">
                ${statCard('涨停', stats.ztCount ?? '--', 'change-up')}
                ${statCard('跌停', stats.dtCount ?? '--', 'change-down')}
                ${statCard('炸板', stats.zbCount ?? '--')}
                ${statCard('封板率', FupanData.formatRate(stats.sealRate), 'change-up')}
                ${statCard('连板数', stats.lbCount ?? '--')}
                ${statCard('最高板', (stats.maxLB ?? '--') + '板')}
                ${statCard('最高板个股', esc(stats.maxLBStock || '--'))}
                ${statCard('整体晋级率', FupanData.formatRate(stats.promotionRate))}
            </div>`;

        // 2. 池子：左分类栏 + 右列表（列表内容由bindPools按持久化状态填充）
        const poolHtml = `
            <div class="fp-zt-split">
                <div class="fp-cat-bar" data-fp-cat-bar>${catBarTable(day)}</div>
                <div class="fp-zt-list" data-fp-pool-list></div>
            </div>`;

        // 3. 连板梯队（工具栏复选框 + 梯队行，body可单独重渲染）
        const ladderHtml = `
            <div data-fp-ladder-section>
                <div class="fp-board-toolbar fp-ladder-toolbar">
                    ${checkHtml('data-fp-ladder-role', FupanData.getSetting(LADDER_ROLE_KEY, true), '显示身位')}
                    ${checkHtml('data-fp-ladder-type', FupanData.getSetting(LADDER_TYPE_KEY, true), '涨停类型')}
                    ${checkHtml('data-fp-ladder-failed', FupanData.getSetting(LADDER_FAILED_KEY, false), '未晋级股票')}
                </div>
                <div data-fp-ladder-body>${ladderBodyHtml(day, prevDay)}</div>
            </div>`;

        // 4. 晋级率
        const promoHtml = promotionView(day.promotion);

        // 5. 情绪
        const sentimentHtml = `
            <div class="fp-sentiment">
                <span class="fp-phase-badge">${esc(sentiment.phase || '--')}</span>
                <div class="fp-stat-grid">
                    ${statCard('涨停', metrics.ztCount ?? '--', 'change-up')}
                    ${statCard('跌停', metrics.dtCount ?? '--', 'change-down')}
                    ${statCard('炸板', metrics.zbCount ?? '--')}
                    ${statCard('封板率', FupanData.formatRate(metrics.sealRate))}
                    ${statCard('最高板', (metrics.maxLB ?? '--') + '板')}
                    ${statCard('晋级率', FupanData.formatRate(metrics.promotionRate))}
                </div>
                <p class="fp-sentiment-text">${esc(sentiment.summary || '')}</p>
            </div>`;

        container.innerHTML = `
            ${section('涨跌停统计', statsHtml)}
            ${section('涨跌停池（分板块）', poolHtml)}
            ${section('连板梯队', ladderHtml)}
            ${section('晋级率', promoHtml)}
            ${section('市场情绪', sentimentHtml)}`;

        bindPools(container, day);
        bindLadderControls(container, day, prevDay);
        // 全部列表绑定表头排序（分类栏除外）
        bindSortTables(container);
    }

    /**
     * 按行业聚合三类池数量（分类栏数据源）
     * @param {Object} day 单日复盘数据
     * @returns {Map<string, {zt:number, dt:number, zb:number}>} 行业 -> 数量（'__all__'=全部合计）
     */
    function buildCatStats(day) {
        const stats = new Map();
        const ensure = ind => {
            if (!stats.has(ind)) stats.set(ind, { zt: 0, dt: 0, zb: 0 });
            return stats.get(ind);
        };
        (day.ztpool || []).forEach(s => ensure(s.industry || '其他').zt++);
        (day.dtpool || []).forEach(s => ensure(s.industry || '其他').dt++);
        (day.zbpool || []).forEach(s => ensure(s.industry || '其他').zb++);
        return stats;
    }

    /**
     * 生成分类栏表格HTML（首行全部，其余按涨停数降序）
     * @param {Object} day 单日复盘数据
     * @returns {string} table HTML
     */
    function catBarTable(day) {
        const stats = buildCatStats(day);
        const total = { zt: 0, dt: 0, zb: 0 };
        const inds = [];
        stats.forEach((v, k) => {
            total.zt += v.zt; total.dt += v.dt; total.zb += v.zb;
            if (v.zt || v.dt || v.zb) inds.push({ name: k, ...v });
        });
        inds.sort((a, b) => b.zt - a.zt || b.dt - a.dt || b.zb - a.zb || a.name.localeCompare(b.name, 'zh-CN'));
        /**
         * 单行HTML
         */
        const rowHtml = (name, v) => `
            <tr data-cat="${esc(name)}" title="点击分类名/涨停数查看涨停列表，跌停数/炸板数同理">
                <td class="fp-cat-name">${esc(name === '__all__' ? '全部' : name)}</td>
                <td class="fp-cat-cell cell-zt" data-pool="zt">${v.zt || '<i class="fp-cat-zero">0</i>'}</td>
                <td class="fp-cat-cell cell-dt" data-pool="dt">${v.dt || '<i class="fp-cat-zero">0</i>'}</td>
                <td class="fp-cat-cell cell-zb" data-pool="zb">${v.zb || '<i class="fp-cat-zero">0</i>'}</td>
            </tr>`;
        return `
            <div class="table-wrapper">
                <table class="stock-table fp-cat-table" data-no-sort="1" title="分类栏：点击分类或数量切换右侧列表">
                    <thead><tr><th>分类</th><th>涨停</th><th>跌停</th><th>炸板</th></tr></thead>
                    <tbody>${rowHtml('__all__', total)}${inds.map(i => rowHtml(i.name, i)).join('')}</tbody>
                </table>
            </div>`;
    }

    /**
     * 绑定池分类栏交互（点击分类/数量切列表；选择状态持久化）
     * @param {HTMLElement} container tab容器
     * @param {Object} day 单日复盘数据
     */
    function bindPools(container, day) {
        const bar = container.querySelector('[data-fp-cat-bar]');
        const listEl = container.querySelector('[data-fp-pool-list]');
        if (!bar || !listEl) return;

        const select = (cat, pool) => {
            FupanData.setSetting(ZT_CAT_KEY, cat);
            FupanData.setSetting(ZT_POOL_KEY, pool);
            bar.querySelectorAll('tr[data-cat]').forEach(tr => {
                tr.classList.toggle('fp-cat-selected', tr.dataset.cat === cat);
            });
            bar.querySelectorAll('td.fp-cat-cell').forEach(td => {
                td.classList.toggle('fp-cat-cell-active',
                    td.dataset.pool === pool && td.closest('tr').dataset.cat === cat);
            });
            renderPoolList(listEl, day, cat, pool);
            bindSortTables(listEl);
        };

        bar.addEventListener('click', e => {
            const td = e.target.closest('td');
            if (!td) return;
            const tr = td.closest('tr[data-cat]');
            if (!tr) return;
            select(tr.dataset.cat, td.dataset.pool || 'zt');
        });

        // 恢复持久化状态（分类不存在时回退全部）
        const savedCat = FupanData.getSetting(ZT_CAT_KEY, '__all__');
        const savedPool = FupanData.getSetting(ZT_POOL_KEY, 'zt');
        const pool = ['zt', 'dt', 'zb'].includes(savedPool) ? savedPool : 'zt';
        const catExists = savedCat === '__all__'
            || Array.from(bar.querySelectorAll('tr[data-cat]')).some(tr => tr.dataset.cat === savedCat);
        select(catExists ? savedCat : '__all__', pool);
    }

    /**
     * 渲染右侧池列表（按分类过滤+默认排序）
     * @param {HTMLElement} listEl 列表容器
     * @param {Object} day 单日复盘数据
     * @param {string} cat 分类（'__all__'=全部）
     * @param {string} pool 池类型 zt/dt/zb
     */
    function renderPoolList(listEl, day, cat, pool) {
        const poolNames = { zt: '涨停池', dt: '跌停池', zb: '炸板池' };
        const poolKeys = { zt: 'ztpool', dt: 'dtpool', zb: 'zbpool' };
        let rows = (day[poolKeys[pool]] || []).slice();
        if (cat !== '__all__') rows = rows.filter(s => (s.industry || '其他') === cat);
        rows = sortPoolRows(rows, pool);
        const catLabel = cat === '__all__' ? '全部' : cat;
        const table = pool === 'zt' ? ztPoolTable(rows) : (pool === 'dt' ? dtPoolTable(rows) : zbPoolTable(rows));
        listEl.innerHTML = `<h4 class="fp-chart-title">${esc(poolNames[pool])}：${esc(catLabel)}（${rows.length}只）</h4>${table}`;
    }

    /**
     * 池列表默认排序（涨停/跌停按连板数降序再封板时间升序；炸板按首封时间升序）
     * @param {Array} rows 池数据
     * @param {string} pool 池类型
     * @returns {Array}
     */
    function sortPoolRows(rows, pool) {
        if (pool === 'zb') return rows.sort((a, b) => sealSecs(a.firstSealTime) - sealSecs(b.firstSealTime));
        const lbKey = pool === 'dt' ? 'lbCount' : 'lbCount';
        const timeKey = pool === 'dt' ? 'lastSealTime' : 'firstSealTime';
        return rows.sort((a, b) =>
            (b[lbKey] || 1) - (a[lbKey] || 1) || sealSecs(a[timeKey]) - sealSecs(b[timeKey]));
    }

    /**
     * 生成涨停池表格HTML（数值格带data-v支持表头排序）
     * @param {Array} pool 涨停池
     * @returns {string} table HTML
     */
    function ztPoolTable(pool) {
        if (!pool || !pool.length) return '<div class="fp-empty">当日无涨停</div>';
        const rows = pool.map((s, i) => `
            <tr>
                <td class="col-rank" data-v="${i + 1}">${i + 1}</td>
                <td class="col-name">${esc(s.name)}</td>
                <td class="col-code">${esc(s.code)}</td>
                <td data-v="${s.price ?? ''}">${s.price !== null && s.price !== undefined ? s.price.toFixed(2) : '--'}</td>
                <td class="${FupanData.changeClass(s.change)}" data-v="${s.change ?? ''}">${FupanData.formatChange(s.change)}%</td>
                <td data-v="${s.amount ?? ''}">${FupanData.formatAmount(s.amount)}</td>
                <td data-v="${s.floatMV ?? ''}">${FupanData.formatAmount(s.floatMV)}</td>
                <td data-v="${s.turnover ?? ''}">${s.turnover !== null && s.turnover !== undefined ? s.turnover.toFixed(2) + '%' : '--'}</td>
                <td class="change-up" data-v="${s.sealFund ?? ''}">${FupanData.formatAmount(s.sealFund)}</td>
                <td data-v="${s.sealRatio ?? ''}">${s.sealRatio !== null && s.sealRatio !== undefined ? s.sealRatio.toFixed(2) : '--'}</td>
                <td data-v="${sealSecs(s.firstSealTime) === Infinity ? '' : sealSecs(s.firstSealTime)}">${esc(s.firstSealTime || '--')}</td>
                <td data-v="${sealSecs(s.lastSealTime) === Infinity ? '' : sealSecs(s.lastSealTime)}">${esc(s.lastSealTime || '--')}</td>
                <td data-v="${s.openCount ?? ''}">${s.openCount ?? 0}</td>
                <td class="fp-lb" data-v="${s.lbCount ?? ''}">${s.lbCount ?? 1}板</td>
                <td>${esc(s.stats || '--')}</td>
                <td>${typeBadge(s.limitType)}</td>
                <td class="fp-industry" title="${esc(s.industry || '')}">${esc(s.industry || '--')}</td>
            </tr>`).join('');
        return `
            <div class="table-wrapper">
                <table class="stock-table fp-pool-table">
                    <thead><tr>
                        <th>#</th><th>名称</th><th>代码</th><th>现价</th><th>涨跌幅%</th><th>成交额</th><th>流通市值</th>
                        <th>换手%</th><th>封单额</th><th title="封单额/成交额，越大封板越坚决">封成比</th>
                        <th>首次封板</th><th>最后封板</th><th>开板</th><th>连板</th><th>几天几板</th><th>板型</th><th>行业</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    /**
     * 生成跌停池表格HTML（数值格带data-v支持表头排序）
     * @param {Array} pool 跌停池
     * @returns {string} table HTML
     */
    function dtPoolTable(pool) {
        if (!pool || !pool.length) return '<div class="fp-empty">当日无跌停</div>';
        const rows = pool.map((s, i) => `
            <tr>
                <td class="col-rank" data-v="${i + 1}">${i + 1}</td>
                <td class="col-name">${esc(s.name)}</td>
                <td class="col-code">${esc(s.code)}</td>
                <td data-v="${s.price ?? ''}">${s.price !== null && s.price !== undefined ? s.price.toFixed(2) : '--'}</td>
                <td class="${FupanData.changeClass(s.change)}" data-v="${s.change ?? ''}">${FupanData.formatChange(s.change)}%</td>
                <td data-v="${s.amount ?? ''}">${FupanData.formatAmount(s.amount)}</td>
                <td data-v="${s.turnover ?? ''}">${s.turnover !== null && s.turnover !== undefined ? s.turnover.toFixed(2) + '%' : '--'}</td>
                <td class="change-down" data-v="${s.sealFund ?? ''}">${FupanData.formatAmount(s.sealFund)}</td>
                <td data-v="${sealSecs(s.lastSealTime) === Infinity ? '' : sealSecs(s.lastSealTime)}">${esc(s.lastSealTime || '--')}</td>
                <td class="fp-lb" data-v="${s.lbCount ?? ''}">${s.lbCount ?? 1}连跌</td>
                <td class="fp-industry" title="${esc(s.industry || '')}">${esc(s.industry || '--')}</td>
            </tr>`).join('');
        return `
            <div class="table-wrapper">
                <table class="stock-table fp-pool-table">
                    <thead><tr>
                        <th>#</th><th>名称</th><th>代码</th><th>现价</th><th>跌跌幅%</th><th>成交额</th>
                        <th>换手%</th><th>封单额</th><th>最后封板</th><th>连续跌停</th><th>行业</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    /**
     * 生成炸板池表格HTML（数值格带data-v支持表头排序）
     * @param {Array} pool 炸板池
     * @returns {string} table HTML
     */
    function zbPoolTable(pool) {
        if (!pool || !pool.length) return '<div class="fp-empty">当日无炸板</div>';
        const rows = pool.map((s, i) => {
            // 距涨停：(现价-涨停价)/涨停价，负值=低于涨停价幅度
            const gapPct = (s.price !== null && s.price !== undefined && s.limitPrice)
                ? (s.price - s.limitPrice) / s.limitPrice * 100 : null;
            return `
            <tr>
                <td class="col-rank" data-v="${i + 1}">${i + 1}</td>
                <td class="col-name">${esc(s.name)}</td>
                <td class="col-code">${esc(s.code)}</td>
                <td data-v="${s.price ?? ''}">${s.price !== null && s.price !== undefined ? s.price.toFixed(2) : '--'}</td>
                <td class="${FupanData.changeClass(s.change)}" data-v="${s.change ?? ''}">${FupanData.formatChange(s.change)}%</td>
                <td data-v="${s.limitPrice ?? ''}">${s.limitPrice !== null && s.limitPrice !== undefined ? s.limitPrice.toFixed(2) : '--'}</td>
                <td class="${FupanData.changeClass(gapPct)}" data-v="${gapPct ?? ''}">${FupanData.formatChange(gapPct)}%</td>
                <td data-v="${s.amount ?? ''}">${FupanData.formatAmount(s.amount)}</td>
                <td data-v="${s.turnover ?? ''}">${s.turnover !== null && s.turnover !== undefined ? s.turnover.toFixed(2) + '%' : '--'}</td>
                <td data-v="${sealSecs(s.firstSealTime) === Infinity ? '' : sealSecs(s.firstSealTime)}">${esc(s.firstSealTime || '--')}</td>
                <td data-v="${s.openCount ?? ''}">${s.openCount ?? '--'}</td>
                <td class="fp-industry" title="${esc(s.industry || '')}">${esc(s.industry || '--')}</td>
            </tr>`;
        }).join('');
        return `
            <div class="table-wrapper">
                <table class="stock-table fp-pool-table">
                    <thead><tr>
                        <th>#</th><th>名称</th><th>代码</th><th>现价</th><th>涨跌幅%</th><th>涨停价</th><th>距涨停%</th>
                        <th>成交额</th><th>换手%</th><th>首次封板</th><th>炸板次数</th><th>行业</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    /**
     * 生成连板梯队HTML（工具栏 + 各板级行）
     * @param {Object} day 单日复盘数据
     * @param {Object|null} prevDay 前一日数据（未晋级股票/多显示一级）
     * @returns {string} HTML（仅梯队行，工具栏由renderZT构建）
     */
    function ladderBodyHtml(day, prevDay) {
        const levels = buildLadderLevels(day, prevDay);
        if (!levels.length) return '<div class="fp-empty">当日无连板梯队</div>';
        const roleOn = FupanData.getSetting(LADDER_ROLE_KEY, true);
        const typeOn = FupanData.getSetting(LADDER_TYPE_KEY, true);
        const failedOn = FupanData.getSetting(LADDER_FAILED_KEY, false);
        return levels.map(lv => {
            // 左侧：板级 + 家数 + 晋级率（首板/无昨日数据时不显示晋级率）
            const rate = lv.promo && lv.promo.rate;
            const rateHtml = (rate !== null && rate !== undefined)
                ? `<span class="fp-ladder-promo ${rate >= 0.3 ? 'change-up' : (rate <= 0.1 ? 'change-down' : '')}">晋级率${(rate * 100).toFixed(0)}%</span>`
                : '';
            const chips = lv.stocks.map(s => ladderChip(s, roleOn, typeOn, false, null)).join('');
            const failedChips = failedOn
                ? lv.failed.map(s => ladderChip(s, roleOn, typeOn, true, lv.changeByCode)).join('')
                : '';
            return `
                <div class="fp-ladder-row">
                    <div class="fp-ladder-level">
                        <span class="fp-ladder-badge">${lv.level}板</span>
                        <span class="fp-ladder-count">${lv.stocks.length}只</span>
                        ${rateHtml}
                    </div>
                    <div class="fp-ladder-stocks">${chips}${failedChips}</div>
                </div>`;
        }).join('');
    }

    /**
     * 构建梯队层级数据（含未晋级股票与晋级率；昨日最高板今日无人晋级时多显示一级）
     * @param {Object} day 单日复盘数据
     * @param {Object|null} prevDay 前一日数据
     * @returns {Array<{level, stocks, failed, promo, changeByCode}>} 高板→低板
     */
    function buildLadderLevels(day, prevDay) {
        const ztpool = day.ztpool || [];
        if (!ztpool.length) return [];
        const todayCodes = new Set(ztpool.map(s => s.code));
        const maxToday = Math.max(...ztpool.map(s => s.lbCount || 1));
        const prevZt = (prevDay && prevDay.ztpool) || [];
        const maxPrev = prevZt.length ? Math.max(...prevZt.map(s => s.lbCount || 1)) : 0;
        const top = Math.max(maxToday, maxPrev + 1);

        // 未晋级股票按目标板级分组（昨日N板 → 今日N+1板，今日池无此code）
        const failedByLevel = {};
        prevZt.forEach(s => {
            if (todayCodes.has(s.code)) return;
            const target = (s.lbCount || 1) + 1;
            (failedByLevel[target] = failedByLevel[target] || []).push(s);
        });
        // 今日各板级股票（同层按首封时间升序）
        const byLevel = {};
        ztpool.forEach(s => (byLevel[s.lbCount || 1] = byLevel[s.lbCount || 1] || []).push(s));
        // 今日炸板/跌停池行情（未晋级股展示今日涨跌幅，无则省略）
        const changeByCode = new Map();
        (day.zbpool || []).concat(day.dtpool || []).forEach(s => changeByCode.set(s.code, s.change));
        const overall = (day.promotion || {}).overall || {};

        const levels = [];
        for (let L = top; L >= 1; L--) {
            const stocks = (byLevel[L] || []).slice()
                .sort((a, b) => sealSecs(a.firstSealTime) - sealSecs(b.firstSealTime));
            const failed = failedByLevel[L] || [];
            const promo = L >= 2 ? overall[(L - 1) + '->' + L] : null;
            // 空板级（无今日股/无未晋级股/无晋级率桶）跳过
            if (!stocks.length && !failed.length && !(promo && promo.yesterday)) continue;
            levels.push({ level: L, stocks, failed, promo, changeByCode });
        }
        return levels;
    }

    /**
     * 生成梯队股票chip（两行结构：名称+几天几板 / 身位+板型单字；无数据项整体省略）
     * @param {Object} s 股票（今日池含role，昨日池无role）
     * @param {boolean} roleOn 显示身位
     * @param {boolean} typeOn 显示涨停类型
     * @param {boolean} isFailed 是否未晋级股票（置灰+断标签）
     * @param {Map|null} changeByCode 今日行情映射（未晋级股显示今日涨跌幅）
     * @returns {string} chip HTML
     */
    function ladderChip(s, roleOn, typeOn, isFailed, changeByCode) {
        const title = `${s.name} ${s.industry || ''} 首封${s.firstSealTime || '--'} 封单${FupanData.formatAmount(s.sealFund)}${isFailed ? '（昨日涨停今日未晋级）' : ''}`;
        const l1 = `<span class="fp-chip-l1"><b class="fp-chip-name">${esc(s.name)}</b><i class="fp-chip-stats">${esc(s.stats || '')}</i></span>`;
        let l2 = '';
        if (isFailed) {
            l2 += '<span class="fp-chip-broken" title="昨日涨停今日未晋级">断</span>';
            const chg = changeByCode ? changeByCode.get(s.code) : null;
            if (chg !== null && chg !== undefined) {
                l2 += `<span class="fp-chip-chg ${FupanData.changeClass(chg)}">${FupanData.formatChange(chg)}%</span>`;
            }
        } else if (roleOn && s.role) {
            l2 += roleBadge(s.role);
        }
        if (typeOn && s.limitType && LIMIT_TYPE_MINI[s.limitType]) {
            l2 += `<span class="fp-type-mini ${LIMIT_TYPE_CLASS[s.limitType] || ''}" title="${esc(s.limitType)}">${LIMIT_TYPE_MINI[s.limitType]}</span>`;
        }
        const cls = isFailed ? ' fp-chip-dim' : '';
        return `<span class="fp-ladder-chip2${cls}" title="${esc(title)}">${l1}${l2 ? `<span class="fp-chip-l2">${l2}</span>` : ''}</span>`;
    }

    /**
     * 绑定梯队显示复选框（勾选变化持久化并仅重渲染梯队body）
     * @param {HTMLElement} container tab容器
     * @param {Object} day 单日复盘数据
     * @param {Object|null} prevDay 前一日数据
     */
    function bindLadderControls(container, day, prevDay) {
        const sec = container.querySelector('[data-fp-ladder-section]');
        if (!sec) return;
        const keys = { role: LADDER_ROLE_KEY, type: LADDER_TYPE_KEY, failed: LADDER_FAILED_KEY };
        Object.keys(keys).forEach(k => {
            const cb = sec.querySelector(`[data-fp-ladder-${k}]`);
            if (cb) cb.addEventListener('change', () => {
                FupanData.setSetting(keys[k], cb.checked);
                const body = sec.querySelector('[data-fp-ladder-body]');
                if (body) body.innerHTML = ladderBodyHtml(day, prevDay);
            });
        });
    }

    /**
     * 生成晋级率视图HTML（分板级晋级 + 昨日涨停今日表现）
     * @param {Object} promotion 晋级率数据
     * @returns {string} HTML
     */
    function promotionView(promotion) {
        if (!promotion) return '<div class="fp-empty">暂无晋级数据</div>';
        const overall = promotion.overall || {};
        // 板级排序：1->2, 2->3, ...
        const levels = Object.keys(overall).sort((a, b) => {
            const na = parseInt(a), nb = parseInt(b);
            return na - nb;
        });
        const rows = levels.map(k => {
            const item = overall[k];
            const ratePct = item.rate !== null && item.rate !== undefined ? (item.rate * 100).toFixed(1) : '--';
            const rateCls = (item.rate || 0) >= 0.3 ? 'change-up' : ((item.rate || 0) <= 0.1 ? 'change-down' : '');
            return `
                <tr>
                    <td data-v="${parseInt(k) || 0}">${esc(k.replace('->', '板→'))}板</td>
                    <td data-v="${item.yesterday ?? ''}">${item.yesterday ?? '--'}</td>
                    <td data-v="${item.promoted ?? ''}">${item.promoted ?? '--'}</td>
                    <td class="${rateCls}" data-v="${item.rate ?? ''}">${ratePct}%</td>
                </tr>`;
        }).join('');

        const yp = promotion.yesterdayPerf || {};
        const perfHtml = `
            <div class="fp-stat-grid">
                ${statCard('昨日涨停今日均涨幅', FupanData.formatChange(yp.avgChange) + '%', FupanData.changeClass(yp.avgChange))}
                ${statCard('昨日涨停今日胜率', FupanData.formatRate(yp.winRate))}
                ${statCard('今日晋级', (yp.promoted ?? '--') + '/' + (yp.total ?? '--'))}
            </div>`;

        return `
            <div class="fp-promo-row">
                <div class="fp-promo-table">
                    <div class="table-wrapper">
                        <table class="stock-table">
                            <thead><tr><th>板级</th><th>昨日家数</th><th>晋级家数</th><th>晋级率</th></tr></thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>
                </div>
                <div class="fp-promo-perf">${perfHtml}</div>
            </div>`;
    }

    // ===== 子tab4：评分预测 =====

    /**
     * 渲染评分预测tab
     * 主流程：读取阈值配置（生效日机制：生效日起按自定义阈值前端重算，之前用采集端落盘评分）
     *        → 配置状态条 + 阈值设置面板 → Top5卡片（雷达图）→ 全量评分表 → 模型说明
     * @param {HTMLElement} container 容器
     * @param {Object} day 单日复盘数据
     * @param {string} dateStr 当前交易日 YYYY-MM-DD
     */
    async function renderScore(container, day, dateStr) {
        const config = FupanScoring.getSavedConfig();
        const hasCustom = config && !FupanScoring.isDefaultConfig(config);
        const active = hasCustom && FupanScoring.isActiveFor(config, dateStr);
        // 生效日及之后：前端按自定义阈值重算；之前：采集端落盘评分（历史不受影响）
        const scores = active ? FupanScoring.rescoreDay(day, config) : (day.scores || {});
        const top5 = scores.top5 || [];
        const weights = scores.weights || {};

        // 0. 配置状态条（已配置自定义阈值时提示生效状态）
        let configBanner = '';
        if (hasCustom) {
            configBanner = active
                ? `<div class="fp-config-banner">自定义阈值生效中（生效于 ${esc(config.effectiveDate)}，本页评分为前端按自定义阈值重算）</div>`
                : `<div class="fp-config-banner fp-config-muted">已配置自定义阈值（生效于 ${esc(config.effectiveDate)}），本日早于生效日，展示采集端原始评分</div>`;
        }

        // 1. Top5卡片
        const cardsHtml = top5.length
            ? `<div class="fp-top5-row">${top5.map((s, i) => top5Card(s, weights, i)).join('')}</div>`
            : '<div class="fp-empty">当日无评分标的</div>';

        // 2. 全量评分表（all，被否决的标的带否决标记）
        const allScores = scores.all || [];
        const allRows = allScores.map(s => `
            <tr>
                <td>${esc(s.name)}</td>
                <td class="col-code">${esc(s.code)}</td>
                <td class="fp-score-total ${scoreClass(s.score)}">${s.score ?? '--'}</td>
                <td>${s.probability !== null && s.probability !== undefined ? (s.probability * 100).toFixed(1) + '%' : '--'}</td>
                <td>${s.veto ? `<span class="fp-veto-badge" title="${esc(s.veto)}">否决</span>` : '<span class="fp-pass-badge">通过</span>'}</td>
            </tr>`).join('');
        const allTable = allRows ? `
            <div class="table-wrapper">
                <table class="stock-table">
                    <thead><tr><th>名称</th><th>代码</th><th>总分</th><th>晋级概率</th><th>否决</th></tr></thead>
                    <tbody>${allRows}</tbody>
                </table>
            </div>` : '<div class="fp-empty">暂无数据</div>';

        // 3. 模型说明（8维权重，自定义生效时展示自定义权重）
        const weightRows = Object.keys(SCORE_DIM_LABELS).map(k => `
            <tr><td>${SCORE_DIM_LABELS[k]}</td><td>${weights[k] ?? '--'}</td></tr>`).join('');
        const weightSum = Object.keys(SCORE_DIM_LABELS)
            .reduce((a, k) => a + (Number(weights[k]) || 0), 0);
        const modelHtml = `
            <div class="fp-model-row">
                <div class="fp-model-weights">
                    <h4 class="fp-chart-title">8维权重（满分${weightSum}）${active ? '<span class="fp-custom-badge">自定义</span>' : ''}</h4>
                    <div class="table-wrapper">
                        <table class="stock-table">
                            <thead><tr><th>维度</th><th>满分</th></tr></thead>
                            <tbody>${weightRows}</tbody>
                        </table>
                    </div>
                </div>
                <div class="fp-model-desc">
                    <h4 class="fp-chart-title">评分说明</h4>
                    <ul class="fp-model-tips">
                        <li>评分为收盘后基于当日涨停数据的静态计算，供次日竞价参考</li>
                        <li>涨停活跃度：近40自然日涨停次数越多得分越高（资金记忆）</li>
                        <li>封板质量：封成比、首封时间、开板次数综合（权重最高20分）</li>
                        <li>一票否决：触发性价比过低、情绪冰点加速等条件时直接否决</li>
                        <li>晋级概率：基于评分与同板级历史晋级率的估算，非精确预测</li>
                        <li>阈值自定义：点击"阈值设置"可调整维度权重/否决阈值/建议分级，自生效日起前端重算，生效日之前保留采集端评分</li>
                    </ul>
                </div>
            </div>`;

        container.innerHTML = `
            ${configBanner}
            <div class="fp-score-toolbar">
                <button class="fp-cfg-toggle" data-fp-cfg-toggle>⚙ 阈值设置</button>
            </div>
            <div data-fp-cfg-panel style="display:none"></div>
            ${section('Top5 关注标的（次日竞价参考）', cardsHtml)}
            ${section('全量评分（' + allScores.length + '只）', allTable)}
            ${section('近5日回测（Top5晋级正确率）', '<div data-fp-backtest><div class="fp-empty">回测计算中...</div></div>')}
            ${section('模型说明', modelHtml)}`;

        bindSortTables(container);

        // Top5卡片雷达图挂载（卡片模板中预留容器）
        container.querySelectorAll('[data-fp-radar]').forEach(box => {
            const idx = parseInt(box.dataset.fpRadar);
            const s = top5[idx];
            if (s) box.appendChild(radarFor(s, weights));
        });

        // 阈值设置面板（展开状态持久化）
        const panel = container.querySelector('[data-fp-cfg-panel]');
        if (FupanData.getSetting('fupan_score_cfg_open', false)) panel.style.display = '';
        await renderCfgPanel(panel, container, day, dateStr);
        container.querySelector('[data-fp-cfg-toggle]').addEventListener('click', () => {
            const show = panel.style.display === 'none';
            panel.style.display = show ? '' : 'none';
            FupanData.setSetting('fupan_score_cfg_open', show);
        });

        // 近5日回测（异步：保存阈值后此处展示对近5个交易日预测正确率的影响）
        renderBacktest(container.querySelector('[data-fp-backtest]'), dateStr)
            .catch(e => {
                const box = container.querySelector('[data-fp-backtest]');
                if (box) box.innerHTML = `<div class="error"><span>回测计算失败: ${esc(e.message)}</span></div>`;
            });
    }

    /**
     * 近5日回测（TODO5.5）：对当前交易日之前的最多5个交易日，
     * 默认阈值基线=采集端落盘评分Top5；自定义阈值=前端按当前已保存配置重算Top5；
     * 晋级判定=次日涨停池存在该股且连板数更高。展示整体正确率变化（百分点）与逐日明细。
     * @param {HTMLElement} box 回测容器（null时跳过）
     * @param {string} dateStr 当前交易日 YYYY-MM-DD
     */
    async function renderBacktest(box, dateStr) {
        if (!box) return;
        const dates = await FupanData.getAvailableDates();
        const idx = dates.indexOf(dateStr);
        if (idx < 0) { box.innerHTML = '<div class="fp-empty">当前日期无回测数据</div>'; return; }
        const targets = dates.slice(Math.max(0, idx - 5), idx).reverse();
        if (!targets.length) {
            box.innerHTML = '<div class="fp-empty">暂无可回测交易日（需次日数据判定晋级结果）</div>';
            return;
        }

        const config = FupanScoring.getSavedConfig();
        const custom = config && !FupanScoring.isDefaultConfig(config) ? config : null;

        const rows = [];
        for (const d of targets) {
            const i = dates.indexOf(d);
            const [day, next] = await Promise.all([FupanData.getDay(d), FupanData.getDay(dates[i + 1])]);
            /**
             * Top5次日晋级判定（true=晋级）
             */
            const judge = top5 => (top5 || []).map(s => {
                const ns = (next.ztpool || []).find(x => x.code === s.code);
                return {
                    name: s.name, code: s.code,
                    ok: !!(ns && (ns.lbCount || 1) > (s.lbCount || 1))
                };
            });
            const defR = judge((day.scores || {}).top5);
            const cusR = custom ? judge(FupanScoring.rescoreDay(day, custom).top5) : null;
            rows.push({ date: d, defR, cusR });
        }

        const okCount = r => (r || []).filter(x => x.ok).length;
        const pct = (ok, total) => total ? (ok / total * 100).toFixed(0) + '%' : '--';
        const totalDef = rows.reduce((a, r) => a + r.defR.length, 0);
        const okDef = rows.reduce((a, r) => a + okCount(r.defR), 0);
        const totalCus = custom ? rows.reduce((a, r) => a + r.cusR.length, 0) : 0;
        const okCus = custom ? rows.reduce((a, r) => a + okCount(r.cusR), 0) : 0;

        // 汇总行：默认 vs 自定义正确率（百分点差值）
        let summaryHtml;
        if (custom) {
            const dPct = (totalCus && totalDef) ? (okCus / totalCus - okDef / totalDef) * 100 : 0;
            summaryHtml = `
                <div class="fp-bt-summary">
                    <span>默认阈值：<b>${okDef}/${totalDef}</b>（${pct(okDef, totalDef)}）</span>
                    <span>自定义阈值：<b>${okCus}/${totalCus}</b>（${pct(okCus, totalCus)}）</span>
                    <span class="${dPct > 0 ? 'change-up' : (dPct < 0 ? 'change-down' : '')}">正确率变化：${dPct > 0 ? '+' : ''}${dPct.toFixed(1)}pp</span>
                </div>`;
        } else {
            summaryHtml = `
                <div class="fp-bt-summary">
                    <span>默认阈值正确率：<b>${okDef}/${totalDef}</b>（${pct(okDef, totalDef)}）</span>
                    <span class="fp-bt-hint">在"阈值设置"中调整并保存后，此处展示对近5日预测正确率的影响</span>
                </div>`;
        }

        const rowsHtml = rows.map(r => {
            const dOk = okCount(r.defR);
            const cOk = r.cusR ? okCount(r.cusR) : null;
            const delta = r.cusR ? cOk - dOk : null;
            const deltaCls = delta > 0 ? 'change-up' : (delta < 0 ? 'change-down' : '');
            // 明细：有自定义阈值时展示自定义Top5，否则展示默认Top5
            const detail = (r.cusR || r.defR).map(x =>
                `<span class="fp-bt-stock ${x.ok ? 'fp-bt-ok' : 'fp-bt-miss'}" title="${esc(x.name)}：${x.ok ? '次日晋级' : '次日未晋级'}">${esc(x.name)}${x.ok ? '✓' : '✗'}</span>`
            ).join('');
            return `<tr>
                <td>${esc(r.date)}</td>
                <td>${dOk}/${r.defR.length}</td>
                <td>${r.cusR ? cOk + '/' + r.cusR.length : '--'}</td>
                <td class="${deltaCls}">${delta === null ? '--' : (delta > 0 ? '+' : '') + delta}</td>
                <td class="fp-bt-detail">${detail || '--'}</td>
            </tr>`;
        }).join('');

        box.innerHTML = `
            ${summaryHtml}
            <div class="table-wrapper">
                <table class="stock-table fp-bt-table">
                    <thead><tr><th>交易日</th><th>默认正确</th><th>自定义正确</th><th>变化(只)</th><th>Top5明细（✓晋级/✗未晋级）</th></tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>`;
        bindSortTables(box);
    }

    /**
     * 渲染阈值设置面板（生效日期/维度权重/一票否决/建议分级）
     * 保存后清除展开状态并整tab重渲染生效；恢复默认仅清除本地配置（不影响采集端数据）
     * @param {HTMLElement} panel 面板容器
     * @param {HTMLElement} container tab容器（保存/重置后重渲染用）
     * @param {Object} day 单日复盘数据
     * @param {string} dateStr 当前交易日 YYYY-MM-DD
     */
    async function renderCfgPanel(panel, container, day, dateStr) {
        const saved = FupanScoring.getSavedConfig();
        const cur = {
            weights: Object.assign({}, FupanScoring.DEFAULT_WEIGHTS, (saved || {}).weights),
            veto: Object.assign({}, FupanScoring.DEFAULT_VETO, (saved || {}).veto),
            advice: Object.assign({}, FupanScoring.DEFAULT_ADVICE, (saved || {}).advice),
            effectiveDate: (saved || {}).effectiveDate || dateStr
        };

        // 生效日期下拉（可选交易日；早于生效日的交易日展示采集端评分）
        let dateOpts = `<option value="${esc(dateStr)}" selected>${esc(dateStr)}（当前日）</option>`;
        try {
            const dates = await FupanData.getAvailableDates();
            if (dates.includes(cur.effectiveDate)) {
                dateOpts = dates.map(d =>
                    `<option value="${esc(d)}"${d === cur.effectiveDate ? ' selected' : ''}>${esc(d)}${d === dateStr ? '（当前日）' : ''}</option>`).join('');
            }
        } catch (e) { /* 交易日列表获取失败时降级为仅当前日 */ }

        const wInputs = Object.keys(FupanScoring.DEFAULT_WEIGHTS).map(k => `
            <label class="fp-cfg-item">${SCORE_DIM_LABELS[k]}
                <input type="number" data-cfg-w="${k}" value="${cur.weights[k]}" min="0" max="50" step="1">
            </label>`).join('');

        panel.innerHTML = `
            <div class="fp-cfg-head">
                <span class="fp-cfg-title">评分阈值设置</span>
                <span class="fp-cfg-hint">仅影响生效日及之后的评分展示（前端重算），生效日之前保留采集端评分；采集端落盘数据不变</span>
            </div>
            <div class="fp-cfg-grid">
                <label class="fp-cfg-item">生效日期
                    <select class="fp-cfg-select" data-cfg-date>${dateOpts}</select>
                </label>
            </div>
            <div class="fp-cfg-group">维度权重（满分，默认合计100）</div>
            <div class="fp-cfg-grid">
                ${wInputs}
                <span class="fp-cfg-item fp-cfg-sum">合计 <b data-fp-cfg-sum>100</b></span>
            </div>
            <div class="fp-cfg-group">一票否决（数值0或时刻留空 = 关闭该项）</div>
            <div class="fp-cfg-grid">
                <label class="fp-cfg-item">尾盘偷袭：最后封板晚于
                    <input type="time" data-cfg-v="lateSealTime" value="${esc(cur.veto.lateSealTime)}">
                </label>
                <label class="fp-cfg-item">烂板：炸板 ≥
                    <input type="number" data-cfg-v="openCount" value="${cur.veto.openCount}" min="0" max="20" step="1"> 次
                </label>
                <label class="fp-cfg-item">冰点高位：冰点期连板 ≥
                    <input type="number" data-cfg-v="iceLbCount" value="${cur.veto.iceLbCount}" min="0" max="20" step="1"> 板
                </label>
                <label class="fp-cfg-item">巨无霸：流通市值 >
                    <input type="number" data-cfg-v="floatMvYi" value="${cur.veto.floatMvYi}" min="0" max="100000" step="10"> 亿
                </label>
            </div>
            <div class="fp-cfg-group">建议分级</div>
            <div class="fp-cfg-grid">
                <label class="fp-cfg-item">积极关注：总分 ≥
                    <input type="number" data-cfg-a="active" value="${cur.advice.active}" min="0" max="100" step="1">
                </label>
                <label class="fp-cfg-item">且晋级概率 ≥
                    <input type="number" data-cfg-a="probPct" value="${cur.advice.probPct}" min="0" max="100" step="1"> %
                </label>
                <label class="fp-cfg-item">关注：总分 ≥
                    <input type="number" data-cfg-a="watch" value="${cur.advice.watch}" min="0" max="100" step="1">
                </label>
                <label class="fp-cfg-item">观望：总分 ≥
                    <input type="number" data-cfg-a="wait" value="${cur.advice.wait}" min="0" max="100" step="1">
                </label>
            </div>
            <div class="fp-cfg-actions">
                <button class="btn btn-primary" data-fp-cfg-save>保存并重算</button>
                <button class="btn btn-secondary" data-fp-cfg-reset>恢复默认</button>
            </div>`;

        // 权重合计实时提示（≠100警示，不阻断保存）
        const sumEl = panel.querySelector('[data-fp-cfg-sum]');
        const updateSum = () => {
            let sum = 0;
            panel.querySelectorAll('[data-cfg-w]').forEach(el => {
                const n = Number(el.value);
                if (!isNaN(n)) sum += n;
            });
            sumEl.textContent = Math.round(sum);
            sumEl.classList.toggle('fp-sum-warn', Math.round(sum) !== 100);
        };
        panel.querySelectorAll('[data-cfg-w]').forEach(el => el.addEventListener('input', updateSum));
        updateSum();

        // 保存并重算：收集表单 → 规范化（数值钳制）→ 持久化 → 整tab重渲染
        panel.querySelector('[data-fp-cfg-save]').addEventListener('click', () => {
            const raw = { weights: {}, veto: {}, advice: {} };
            raw.effectiveDate = (panel.querySelector('[data-cfg-date]') || {}).value || dateStr;
            panel.querySelectorAll('[data-cfg-w]').forEach(el => raw.weights[el.dataset.cfgW] = el.value);
            panel.querySelectorAll('[data-cfg-v]').forEach(el => raw.veto[el.dataset.cfgV] = el.value);
            panel.querySelectorAll('[data-cfg-a]').forEach(el => raw.advice[el.dataset.cfgA] = el.value);
            FupanScoring.saveConfig(FupanScoring.normalizeConfig(raw));
            FupanData.setSetting('fupan_score_cfg_open', false);
            renderScore(container, day, dateStr);
        });

        // 恢复默认：清除本地配置（采集端数据不受影响）
        panel.querySelector('[data-fp-cfg-reset]').addEventListener('click', () => {
            if (!window.confirm('恢复默认将清除已保存的自定义阈值，确定？')) return;
            FupanScoring.clearConfig();
            FupanData.setSetting('fupan_score_cfg_open', false);
            renderScore(container, day, dateStr);
        });
    }

    /**
     * 生成Top5卡片HTML（雷达图占位，渲染后挂载）
     * @param {Object} s top5标的
     * @param {Object} weights 权重
     * @param {number} idx 序号（0起，data-fp-radar对应）
     * @returns {string} 卡片HTML
     */
    function top5Card(s, weights, idx) {
        const dims = s.score.dimensions || {};
        const probPct = s.probability !== null && s.probability !== undefined ? (s.probability * 100).toFixed(1) : '--';
        return `
            <div class="fp-top5-card">
                <div class="fp-top5-head">
                    <span class="fp-top5-rank">#${idx + 1}</span>
                    <span class="fp-top5-name">${esc(s.name)}</span>
                    <span class="col-code">${esc(s.code)}</span>
                    <span class="fp-lb">${s.lbCount ?? '--'}板</span>
                </div>
                <div class="fp-top5-meta">
                    ${typeBadge(s.limitType)}
                    <span class="fp-industry">${esc(s.industry || '--')}</span>
                </div>
                <div class="fp-top5-score-row">
                    <div class="fp-top5-score">
                        <span class="fp-score-big ${scoreClass(s.score.total)}">${s.score.total}</span>
                        <span class="fp-score-label">总分</span>
                    </div>
                    <div class="fp-top5-prob">
                        <span class="fp-prob-big">${probPct}%</span>
                        <span class="fp-score-label">晋级概率</span>
                    </div>
                    <div class="fp-top5-radar" data-fp-radar="${idx}"></div>
                </div>
                <div class="fp-top5-advice">${esc(s.advice || '')}</div>
            </div>`;
    }

    /**
     * 生成评分雷达图（8维度值/满分归一化）
     * @param {Object} s top5标的
     * @param {Object} weights 权重
     * @returns {SVGElement} 雷达图
     */
    function radarFor(s, weights) {
        const dims = (s.score && s.score.dimensions) || {};
        const dimList = Object.keys(SCORE_DIM_LABELS).map(k => ({
            label: SCORE_DIM_LABELS[k],
            value: dims[k] ?? 0,
            max: weights[k] || 10
        }));
        return FupanCharts.radarChart({ dims: dimList, size: 190 });
    }

    /**
     * 总分颜色分级：>=75金/60-75蓝/<60灰
     * @param {number} score 总分
     * @returns {string} class名
     */
    function scoreClass(score) {
        if (score === null || score === undefined) return '';
        if (score >= 75) return 'fp-score-high';
        if (score >= 60) return 'fp-score-mid';
        return 'fp-score-low';
    }

    return {
        renderMarket,
        renderSectors,
        renderZT,
        renderScore
    };
})();
