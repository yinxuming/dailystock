/**
 * 集合竞价渲染层（CARender）
 *
 * 负责：情绪概览 KPI、筛选条、结果表（表头排序 + 列定义）、评级悬停明细卡
 * 不负责：取数、状态管理、事件绑定（由 CA 控制器处理）
 */
const CARender = (function () {
    'use strict';

    // ===== 列定义（顺序即表格列顺序；sort=false 表示不可排序） =====
    // 列顺序与同花顺「早盘竞价监控」结果表一致，并在 未匹配金额 之后插入 流通市值、昨日金额
    const COLS = [
        { key: 'time', label: '时间', cls: 'ca-col-time', sort: true, align: 'left' },
        { key: 'code', label: '代码', cls: 'ca-col-code', sort: true, align: 'left' },
        { key: 'name', label: '名称', cls: 'ca-col-name', sort: true, align: 'left' },
        { key: 'lbc', label: '连板', cls: 'ca-col-lbc', sort: true, fmt: 'board' },   // TODO43：连板数（数据来自每日复盘涨停池缓存 row.lbc）
		{ key: 'gap', label: '竞价涨幅', sort: true, fmt: 'pct', color: 'sign' },
		{ key: 'chgPct', label: '涨幅', sort: true, fmt: 'pct', color: 'sign' },
		{ key: 'aucAmt', label: '竞价金额', sort: true, fmt: 'amt' },
        { key: 'amount', label: '金额', sort: true, fmt: 'amt' },
		{ key: 'turnover', label: '换手%', sort: true, fmt: 'pct2' },
        { key: 'volRatio', label: '量比', sort: true, fmt: 'num2' },
		{ key: 'floatMV', label: '流通市值', sort: true, fmt: 'mv' },
		{ key: 'score', label: '竞价评分', cls: 'ca-col-score', sort: true, fmt: 'score' },
		{ key: 'rating', label: '竞价评级', cls: 'ca-col-rating', sort: true },
        { key: 'anomalyType', label: '异动类型', cls: 'ca-col-type', sort: true, align: 'left' },
        { key: 'anomalyDesc', label: '异动说明', cls: 'ca-col-desc', sort: false, align: 'left' },
        { key: 'aucVol', label: '竞价量', sort: true, fmt: 'lots' },
        { key: 'unmatchedVol', label: '未匹配量', sort: true, fmt: 'lots' },
        { key: 'unmatchedAmt', label: '未匹配金额', sort: true, fmt: 'amt' },
		{ key: 'match', label: '匹配价', sort: true, fmt: 'price' },
        { key: 'yAmt', label: '昨日金额', sort: true, fmt: 'amt' },
        { key: 'yTurnover', label: '昨日换手', sort: true, fmt: 'pct2' },
        { key: 'volLots', label: '总手', sort: true, fmt: 'lots' },
        { key: 'price', label: '现价', sort: true, fmt: 'price' },
        { key: 'preClose', label: '昨收', sort: true, fmt: 'price' }
    ];

    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    // ===== 数值格式 =====

    function fmtAmount(v) {
        if (v == null) return '--';
        const a = Math.abs(v);
        if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿';
        if (a >= 1e4) return (v / 1e4).toFixed(0) + '万';
        return v.toFixed(0);
    }

    function fmtLots(v) {
        if (v == null) return '--';
        const a = Math.abs(v);
        if (a >= 1e4) return (v / 1e4).toFixed(2) + '万';
        return v.toFixed(0);
    }

    function fmtMV(v) {
        if (v == null) return '--';
        return (v / 1e8).toFixed(1) + '亿';
    }

    function fmtPct(v, digits) {
        if (v == null) return '--';
        return (v >= 0 ? '+' : '') + v.toFixed(digits == null ? 2 : digits) + '%';
    }

    /** 单元格值格式化 */
    function cellText(row, col) {
        const v = row[col.key];
        switch (col.fmt) {
            case 'price': return v == null ? '--' : v.toFixed(2);
            case 'pct': return fmtPct(v);
            case 'pct2': return v == null ? '--' : v.toFixed(2) + '%';
            case 'num2': return v == null ? '--' : v.toFixed(2);
            case 'amt': return fmtAmount(v);
            case 'lots': return fmtLots(v);
            case 'mv': return fmtMV(v);
            case 'board': return v == null ? '--' : (v + '板');   // TODO43：连板数展示（1→1板，缺失→--）
            default: return v == null || v === '' ? '--' : String(v);
        }
    }

    /** 涨跌配色（红涨绿跌） */
    function signCls(v) {
        if (v == null) return '';
        if (v > 0.0001) return 'ca-up';
        if (v < -0.0001) return 'ca-down';
        return '';
    }

    // ===== 情绪概览 =====

    /**
     * 渲染情绪概览
     * @param {HTMLElement} el
     * @param {Object} s - CARating.summary
     * @param {Object} ctx - {dates, scopeLabel}
     */
    function renderSummary(el, s, ctx) {
        if (!el) return;
        if (!s || !s.total) {
            el.innerHTML = '';
            return;
        }
        const avg = s.avgGap;
        const mood = avg == null ? '--'
            : avg >= 3 ? '情绪偏强'
                : avg >= 1 ? '中性分化'
                    : avg >= 0 ? '情绪偏弱' : '退潮';

        const kpis = [
            { v: s.total, l: '样本数量', cls: '' },
            { v: s.upOpen + ' / ' + s.downOpen, l: '竞价高开 / 低开', cls: '' },
            { v: avg == null ? '--' : fmtPct(avg), l: '平均竞价溢价', cls: signCls(avg) },
            { v: s.limitOpen, l: '竞价涨停开', cls: 'ca-up' },
            { v: fmtAmount(s.aucTotal), l: '竞价成交总额', cls: '' },
            { v: s.zbRate == null ? '--' : s.zbRate.toFixed(1) + '%', l: '昨日炸板率', cls: '' },
            { v: (s.ratingDist['看多'] || 0) + ' / ' + (s.ratingDist['看空'] || 0), l: '看多 / 看空', cls: '' },
            { v: s.buyCount + ' / ' + s.watchCount, l: '可参与 / 观察', cls: '' },
            { v: mood, l: '开盘情绪', cls: '' }
        ];

        el.innerHTML = kpis.map(k =>
            `<div class="ca-kpi"><div class="ca-kpi-v ${k.cls}">${esc(k.v)}</div>` +
            `<div class="ca-kpi-l">${esc(k.l)}</div></div>`
        ).join('');
    }

    /**
     * 渲染「板块竞价强度」面板（按细分行业聚合）
     * @param {HTMLElement} el
     * @param {Array} sectors - CARating.sectorTop 结果
     */
    function renderSector(el, sectors) {
        if (!el) return;
        if (!sectors || !sectors.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
        el.style.display = '';
        const items = sectors.slice(0, 14).map(s => {
            const gap = s.avgGap == null ? '--' : (s.avgGap >= 0 ? '+' : '') + s.avgGap.toFixed(2) + '%';
            const r = s.avgR == null ? '--' : s.avgR.toFixed(2) + '%';
            const codes = s.codes.slice(0, 10).join('、');
            return `<div class="ca-sec">
                <div class="ca-sec-head">
                    <b>${esc(s.name)}</b><span class="ca-sec-n">${s.n}只</span>
                    <span class="ca-sec-gap ${s.avgGap >= 0 ? 'ca-up' : 'ca-down'}">${gap}</span>
                    <span class="ca-sec-r">占昨成交 ${r}</span>
                </div>
                <div class="ca-sec-codes">${esc(codes)}</div>
            </div>`;
        }).join('');
        el.innerHTML = `<div class="ca-sec-title">板块竞价强度（按细分行业聚合 · 共 ${sectors.length} 个板块）</div>` +
            `<div class="ca-sec-list">${items}</div>`;
    }

    // ===== 筛选条 =====

    /**
     * 渲染筛选条（竞价评级 + 异动类型，多选，空集合=全部）
     * @param {HTMLElement} el
     * @param {Object} summary
     * @param {{ratings:Set, types:Set}} state
     */
    function renderFilters(el, summary, state) {
        if (!el) return;
        const ratingOrder = CARating.RATINGS;
        const typeOrder = CARating.ANOMALY_TYPES;

        const chip = (group, value, count, active) =>
            `<button class="ca-chip${active ? ' active' : ''}" data-ca-filter="${group}" data-ca-value="${esc(value)}">` +
            `${esc(value)}<span class="ca-chip-n">${count}</span></button>`;

        const ratingChips = ratingOrder
            .filter(k => (summary.ratingDist[k] || 0) > 0)
            .map(k => chip('rating', k, summary.ratingDist[k] || 0, state.ratings.has(k)))
            .join('');

        const typeChips = typeOrder
            .filter(k => (summary.anomalyDist[k] || 0) > 0)
            .map(k => chip('type', k, summary.anomalyDist[k] || 0, state.types.has(k)))
            .join('');

        const hasAny = state.ratings.size > 0 || state.types.size > 0;

        el.innerHTML =
            `<div class="ca-filter-row"><span class="ca-filter-label">竞价评级</span>${ratingChips}` +
            (hasAny ? `<button class="ca-chip ca-chip-clear" data-ca-filter="clear">清除筛选</button>` : '') +
            `</div>` +
            `<div class="ca-filter-row"><span class="ca-filter-label">异动类型</span>${typeChips}</div>`;
    }

    // ===== 结果表 =====

    /**
     * 渲染表头（含排序指示）
     * @param {HTMLElement} thead
     * @param {{key:string, dir:number}} sort
     */
    function renderHead(thead, sort) {
        if (!thead) return;
        const ths = COLS.map(c => {
            const sortable = c.sort !== false;
            let cls = c.cls || '';
            if (sortable) cls += ' sortable';
            if (sort && sort.key === c.key) cls += sort.dir > 0 ? ' sort-asc' : ' sort-desc';
            return `<th class="${cls}"${sortable ? ` data-ca-sort="${c.key}"` : ''}` +
                `${c.align === 'left' ? ' style="text-align:left"' : ''}>${esc(c.label)}</th>`;
        }).join('');
        thead.innerHTML = '<tr>' + ths + '</tr>';
    }

    /** 单行 HTML */
    function renderRow(r, idx) {
        const tds = COLS.map(c => {
            let text = cellText(r, c);
            let cls = c.cls || '';
            let extra = '';

            if (c.key === 'anomalyType') {
                const t = r.anomalyType || '';
                cls += ' ca-type';
                if (['大单封涨停', '高开抢筹', '竞价抢筹', '大笔买入'].includes(t)) cls += ' ca-type-up';
                else if (['急速下跌', '竞价砸盘', '大笔卖出', '高开砸盘'].includes(t)) cls += ' ca-type-down';
                else if (t === '涨停试盘' || t === '缩量高开') cls += ' ca-type-warn';
            }
            if (c.key === 'rating') {
                cls += ' ca-rating ca-rating-' + ratingSlug(r.rating);
                extra = ' data-ca-detail="1"';
            }
            // TODO39.1：竞价评分按 tier 着色（可参与/一字涨停开=红，观察确认=黄，淘汰=灰）
            if (c.key === 'score') {
                cls += ' ca-score';
                if (r.tier === '可参与' || r.tier === '一字涨停开') cls += ' ca-score-high';
                else if (r.tier === '观察确认') cls += ' ca-score-mid';
                else cls += ' ca-score-low';
            }
            if (c.color === 'sign') cls += ' ' + signCls(r[c.key]);
            if (c.key === 'unmatchedVol' && r.unmatchedVol != null) {
                cls += r.unmatchedVol > 0 ? ' ca-up' : (r.unmatchedVol < 0 ? ' ca-down' : '');
                text = fmtLots(Math.abs(r.unmatchedVol));
            }
            if (c.key === 'chgPct' || c.key === 'price') {
                const base = c.key === 'price' ? r.preClose : null;
                if (base) cls += ' ' + signCls((r.price - base));
                else if (c.key === 'chgPct') cls += ' ' + signCls(r.chgPct);
            }

            return `<td class="${cls}"${extra}>${esc(text)}</td>`;
        }).join('');

        return `<tr data-ca-idx="${idx}">${tds}</tr>`;
    }

    function ratingSlug(r) {
        return { '看多': 'bull', '看空': 'bear', '混战': 'mix', '观望': 'wait' }[r] || 'wait';
    }

    /**
     * 渲染结果表
     * @param {HTMLElement} thead
     * @param {HTMLElement} tbody
     * @param {Array} rows - 已过滤排序的行
     * @param {Object} sort
     * @param {string} emptyText
     */
    function renderTable(thead, tbody, rows, sort, emptyText) {
        renderHead(thead, sort);
        if (!rows.length) {
            tbody.innerHTML = `<tr><td class="ca-empty" colspan="${COLS.length}">${esc(emptyText || '暂无数据')}</td></tr>`;
            updateStickyOffsets(thead);
            return;
        }
        tbody.innerHTML = rows.map((r, i) => renderRow(r, i)).join('');
        updateStickyOffsets(thead);
    }

    // ===== 评分方案回溯区（TODO39.2） =====

    const SCHEME_LABELS = { current: '当前方案', ybest: '昨日最准', d3best: '3日最准', d5best: '5日最准', initial: '初始' };
    const SCHEME_ORDER = ['current', 'ybest', 'd3best', 'd5best', 'initial'];

    /** 收益值着色（正=红/负=绿，A股红涨绿跌） */
    function retCls(v) {
        if (v == null) return '';
        return v > 0.0001 ? 'ca-up' : (v < -0.0001 ? 'ca-down' : '');
    }

    /** 准确度文本（TopN 平均收益 %） */
    function accText(a) {
        return (a == null || a.rate == null) ? '--' : (a.rate >= 0 ? '+' : '') + a.rate.toFixed(2) + '%';
    }

    /**
     * 渲染方案区（tab 栏 + 当前方案参数 + 方案对比表 + 近5日回测明细）
     * @param {HTMLElement} body 容器 #caSchemeBody
     * @param {Object} ctx
     *   - schemes: CAScheme.buildSchemes 结果 {current,initial,ybest,d3best,d5best}
     *   - activeId: 当前选中方案 id
     *   - backtest: [{date, avg, top:[{name,code,score,ret}]}] 近5日回测明细
     *   - topN, sealRatio
     */
    function renderSchemeArea(body, ctx) {
        if (!body) return;
        const S = ctx.schemes || {};
        const esc2 = esc;

        // 方案 tab（不可用的自动方案不显示）
        const tabs = SCHEME_ORDER.filter(id => S[id]).map(id => {
            const act = id === ctx.activeId ? ' active' : '';
            const eq = (id !== 'current' && id !== 'initial' && S.current && CAScheme.configsEqual(S.current.config, S[id].config))
                ? '<span class="ca-scheme-eq">=当前</span>' : '';
            return `<button class="ca-scheme-tab${act}" data-ca-scheme="${id}">${esc2(SCHEME_LABELS[id])}${eq}</button>`;
        }).join('');

        // 当前选中方案参数
        const cur = S[ctx.activeId] || S.current;
        const cfg = cur && cur.config;
        const w = cfg ? cfg.weights : {};
        const cap = cfg ? cfg.cap : {};
        const tier = cfg ? cfg.tier : {};
        const paramHtml = cfg ? `
            <div class="ca-scheme-params">
                <span class="ca-scheme-param"><i>溢价${esc2(String(cap.premiumGapMax))}%</i>封顶<b>${esc2(String(cap.capValue))}</b></span>
                <span class="ca-scheme-param"><i>量能>${esc2(String(cap.divergenceRAmt))}%</i>封顶<b>${esc2(String(cap.capValue))}</b></span>
                <span class="ca-scheme-param"><i>可参与≥</i><b>${esc2(String(tier.buy))}</b></span>
                <span class="ca-scheme-param"><i>观察≥</i><b>${esc2(String(tier.watch))}</b></span>
                <span class="ca-scheme-param"><i>权重</i><b>溢价${esc2(String(w.gap))}/量能${esc2(String(w.amt))}/封板${esc2(String(w.fbt))}/炸板${esc2(String(w.zbc))}/连板${esc2(String(w.lbc))}/资金${esc2(String(w.fund))}/换手${esc2(String(w.hs))}</b></span>
            </div>` : '';

        // 方案对比表（各方案在 昨日/3日/5日 窗口的 TopN 平均收益）
        const cmpRows = SCHEME_ORDER.filter(id => S[id]).map(id => {
            const a = S[id].acc || {};
            const act = id === ctx.activeId ? ' class="ca-scheme-row-active"' : '';
            return `<tr${act}><td>${esc2(SCHEME_LABELS[id])}</td>` +
                `<td class="${retCls(a.d1)}">${accText({ rate: a.d1 })}</td>` +
                `<td class="${retCls(a.d3)}">${accText({ rate: a.d3 })}</td>` +
                `<td class="${retCls(a.d5)}">${accText({ rate: a.d5 })}</td></tr>`;
        }).join('');

        // 近5日回测明细（用当前选中方案）
        const bt = ctx.backtest || [];
        const btHtml = bt.length ? `
            <table class="ca-scheme-bt-table">
                <thead><tr><th>交易日</th><th>TopN 均收益</th><th>明细（评分/竞价买入→次日收盘收益）</th></tr></thead>
                <tbody>${bt.map(d => `
                    <tr><td>${esc2(d.date)}</td><td class="${retCls(d.avg)}">${accText({ rate: d.avg })}</td>
                    <td class="ca-scheme-bt-detail">${(d.top || []).map(t =>
                        `<span class="ca-scheme-bt-item"><b>${esc2(t.name || t.code)}</b>` +
                        `<i>${esc2(String(t.score))}分</i>` +
                        `<em class="${retCls(t.ret)}">${accText({ rate: t.ret })}</em></span>`).join('') ||
                        '<span class="ca-empty">无可成交标的</span>'}</td></tr>`).join('')}
                </tbody>
            </table>` : '<div class="ca-empty">暂无回测数据（需历史竞价缓存 + 次日收盘补采，数据积累后自动出现）</div>';

        body.innerHTML =
            `<div class="ca-scheme-tabs">${tabs || '<span class="ca-empty">方案计算中...</span>'}</div>` +
            paramHtml +
            `<div class="ca-scheme-cmp">
                <div class="ca-scheme-cmp-title">方案对比（Top${esc2(String(ctx.topN))} 竞价买入→次日收盘平均收益，一字板买不到不计）</div>
                <table class="ca-scheme-cmp-table">
                    <thead><tr><th>方案</th><th>昨日窗口</th><th>3日窗口</th><th>5日窗口</th></tr></thead>
                    <tbody>${cmpRows}</tbody>
                </table>
            </div>` +
            `<div class="ca-scheme-bt">
                <div class="ca-scheme-cmp-title">近5日回测（当前方案）</div>
                ${btHtml}
            </div>`;
    }

    /**
     * 前 3 列冻结需要知道实际列宽（table-layout:auto 下列宽由内容决定），
     * 渲染后量一次表头宽度写进 CSS 变量，供 sticky left 使用
     */
    function updateStickyOffsets(thead) {
        if (!thead) return;
        const table = thead.closest('table');
        if (!table) return;
        const ths = thead.querySelectorAll('th');
        if (ths.length < 3) return;
        const w0 = ths[0].offsetWidth;
        const w1 = ths[1].offsetWidth;
        if (!w0 || !w1) return;                 // 隐藏状态下宽度为0，下次渲染再量
        table.style.setProperty('--ca-w0', w0 + 'px');
        table.style.setProperty('--ca-w1', (w0 + w1) + 'px');
    }

    // ===== 评级明细卡（悬停） =====

    let tipEl = null;

    function ensureTip() {
        if (tipEl) return tipEl;
        tipEl = document.createElement('div');
        tipEl.className = 'ca-tip';
        tipEl.style.display = 'none';
        document.body.appendChild(tipEl);
        return tipEl;
    }

    /** 评级明细内容 */
    function tipHtml(r) {
        const dim = [
            ['竞价涨幅', r.dims.gap, 25],
            ['竞价量能', r.dims.amt, 25],
            ['封板时间', r.dims.fbt, 12],
            ['炸板次数', r.dims.zbc, 8],
            ['连板高度', r.dims.lbc, 15],
            ['封单强度', r.dims.fund, 8],
            ['昨日换手', r.dims.hs, 7]
        ].filter(d => d[2] > 0);

        const bars = dim.map(d => {
            const pctW = Math.round(d[1].v / d[2] * 100);
            return `<div class="ca-tip-dim">
                <span class="ca-tip-dim-l">${esc(d[0])}</span>
                <span class="ca-tip-bar"><i style="width:${pctW}%"></i></span>
                <span class="ca-tip-dim-v">${d[1].v}/${d[2]}</span>
            </div>`;
        }).join('');

        const kv = [
            ['匹配价', r.match == null ? '--' : r.match.toFixed(2)],
            ['昨收', r.preClose == null ? '--' : r.preClose.toFixed(2)],
            ['涨停价', r.limitUp == null ? '--' : r.limitUp.toFixed(2)],
            ['竞价量比', r.volRatioAuc == null ? '--' : r.volRatioAuc.toFixed(1)],
            ['竞价额占昨成交', r.rAmt == null ? '--' : r.rAmt.toFixed(2) + '%'],
            ['竞价额占流通市值', r.rMkt == null ? '--' : r.rMkt.toFixed(3) + '%'],
            ['封单额/昨成交', r.rFund == null ? '--' : r.rFund.toFixed(1) + '%'],
            ['连板 / 炸板', (r.lbc == null ? '--' : r.lbc + '板') + ' / ' + (r.zbc == null ? '--' : r.zbc + '次')],
            ['昨日封板', r.fbt]
        ].map(x => `<div class="ca-tip-kv"><span>${esc(x[0])}</span><b>${esc(x[1])}</b></div>`).join('');

        return `<div class="ca-tip-head">
                <b>${esc(r.name)}</b><span class="ca-tip-code">${esc(r.code)}</span>
                <span class="ca-tip-badge ca-rating-${ratingSlug(r.rating)}">${esc(r.rating)}</span>
                <span class="ca-tip-score">${r.score}<i>分</i></span>
                <span class="ca-tip-tier">${esc(r.tier)}</span>
            </div>
            <div class="ca-tip-desc">${esc(r.anomalyDesc)}</div>
            <div class="ca-tip-advice"><b>AI 竞价评级分析：</b>${esc(CARating.adviceFor(r))}</div>
            <div class="ca-tip-bars">${bars}</div>
            <div class="ca-tip-kvs">${kv}</div>
            ${r.outs.length ? `<div class="ca-tip-outs">淘汰项：${esc(r.outs.join('、'))}</div>` : ''}`;
    }

    /**
     * 在指定位置显示明细卡
     * @param {Object} r - 行数据
     * @param {number} x - 视口坐标
     * @param {number} y
     */
    function showTip(r, x, y) {
        const el = ensureTip();
        el.innerHTML = tipHtml(r);
        el.style.display = 'block';
        // 先渲染再测量，做边界收敛
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        let left = x + 14;
        let top = y + 14;
        if (left + w > window.innerWidth - 8) left = Math.max(8, x - w - 14);
        if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
        el.style.left = left + 'px';
        el.style.top = top + 'px';
    }

    function hideTip() {
        if (tipEl) tipEl.style.display = 'none';
    }

    return {
        COLS,
        renderSummary,
        renderSector,
        renderFilters,
        renderTable,
        renderHead,
        renderSchemeArea,
        SCHEME_LABELS,
        SCHEME_ORDER,
        showTip,
        hideTip,
        // 纯函数（Node测试）
        _internals: { fmtAmount, fmtLots, fmtMV, fmtPct, cellText, signCls }
    };
})();

// Node 测试环境下导出（浏览器无 module，此分支不执行）
if (typeof module !== 'undefined' && module.exports) module.exports = CARender;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CARender;
}
