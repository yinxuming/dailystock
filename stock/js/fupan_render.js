/**
 * 每日复盘渲染模块（FupanRenderer）
 *
 * 职责：四个子tab的DOM渲染（数据由FupanData提供，图表由FupanCharts提供）
 * - renderMarket  大盘：指数卡片、市场概况、成交额/涨停家数趋势
 * - renderSectors 板块轮动：行业/概念榜单、近10日行业轮动热力矩阵
 * - renderZT      涨跌停：统计卡、涨停/跌停/炸板池、连板梯队、晋级率、情绪
 * - renderScore   评分预测：Top5卡片（雷达图）、评分全表、模型说明
 *
 * 渲染约定：
 * - 板型徽章色：一字板(红最强)>T字(橙)>厂字(黄)>回封(蓝)>换手(灰蓝)>未判定(灰)
 * - 梯队角色色：龙头(金)>跟风(蓝)>首板(灰)>补涨候选(紫)
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

    /**
     * 渲染板块轮动tab
     * 主流程：行业/概念榜单（子tab切换） → 近10日行业轮动热力矩阵
     * 矩阵数据：行=近10日涨幅榜TOP5高频板块，列=交易日，值=当日板块涨幅
     * @param {HTMLElement} container 容器
     * @param {Object} day 单日复盘数据
     * @param {string} dateStr 当前日期
     * @param {Function} getDayFn 异步取某日数据（矩阵多日回溯）
     */
    async function renderSectors(container, day, dateStr, getDayFn) {
        const sectors = day.sectors || {};

        // 1. 榜单（行业/概念切换）
        const boardHtml = `
            <div class="fp-board-switch">
                <button class="sub-tab active" data-fp-board="industry">行业</button>
                <button class="sub-tab" data-fp-board="concept">概念</button>
            </div>
            <div class="fp-board-panels" id="fpBoardPanels"></div>`;

        // 2. 矩阵骨架（加载中提示，数据异步填充）
        const matrixHtml = '<div class="fp-matrix-wrap" id="fpMatrixWrap"><div class="loading"><div class="loading-spinner"></div><span class="loading-text">正在加载近10日板块数据...</span></div></div>';

        container.innerHTML = `
            ${section('当日板块涨跌榜', boardHtml)}
            ${section('近10日行业轮动矩阵', matrixHtml)}`;

        // 渲染榜单面板（含切换事件）
        renderBoardPanels(document.getElementById('fpBoardPanels'), sectors);

        // 3. 异步构建矩阵（近10日行业涨幅数据）
        try {
            const dates = await FupanData.getRecentDates(dateStr, 10);
            const daysData = await Promise.all(dates.map(d => getDayFn(d)));
            buildMatrix(document.getElementById('fpMatrixWrap'), dates, daysData);
        } catch (e) {
            const wrap = document.getElementById('fpMatrixWrap');
            if (wrap) wrap.innerHTML = `<div class="error"><span>矩阵加载失败: ${esc(e.message)}</span></div>`;
        }
    }

    /**
     * 渲染行业/概念榜单面板（涨跌双榜）
     * @param {HTMLElement} panelEl 面板容器
     * @param {Object} sectors sectors数据 {industry:{topUp,topDown}, concept:{topUp,topDown}}
     */
    function renderBoardPanels(panelEl, sectors) {
        ['industry', 'concept'].forEach(board => {
            const data = sectors[board] || { topUp: [], topDown: [] };
            const upTable = boardTable(data.topUp, true);
            const downTable = boardTable(data.topDown, false);
            const panel = document.createElement('div');
            panel.className = 'fp-board-panel';
            panel.dataset.fpBoardPanel = board;
            panel.style.display = board === 'industry' ? '' : 'none';
            panel.innerHTML = `
                <div class="fp-board-cols">
                    <div><h4 class="fp-chart-title change-up">涨幅榜 TOP15</h4>${upTable}</div>
                    <div><h4 class="fp-chart-title change-down">跌幅榜 TOP15</h4>${downTable}</div>
                </div>`;
            panelEl.appendChild(panel);
        });

        // 榜单子tab切换
        panelEl.closest('.fp-section').querySelectorAll('[data-fp-board]').forEach(btn => {
            btn.addEventListener('click', () => {
                const board = btn.dataset.fpBoard;
                panelEl.closest('.fp-section').querySelectorAll('[data-fp-board]').forEach(b => {
                    b.classList.toggle('active', b === btn);
                });
                panelEl.querySelectorAll('[data-fp-board-panel]').forEach(p => {
                    p.style.display = p.dataset.fpBoardPanel === board ? '' : 'none';
                });
            });
        });
    }

    /**
     * 生成板块榜单表格HTML
     * @param {Array} list 板块数组
     * @param {boolean} isUp 涨幅榜true/跌幅榜false
     * @returns {string} table HTML
     */
    function boardTable(list, isUp) {
        if (!list || !list.length) return '<div class="fp-empty">暂无数据</div>';
        const rows = list.slice(0, 15).map(s => `
            <tr>
                <td class="fp-sec-name" title="${esc(s.name)}">${esc(s.name)}</td>
                ${changeTd(s.change, true)}
                <td class="change-up">${s.upCount ?? '--'}</td>
                <td class="change-down">${s.downCount ?? '--'}</td>
                <td>${esc(s.leadStock || '--')}</td>
                ${changeTd(s.leadChange, true)}
                <td class="${(s.mainNetInflow || 0) >= 0 ? 'change-up' : 'change-down'}">${FupanData.formatAmount(s.mainNetInflow)}</td>
            </tr>`).join('');
        return `
            <div class="table-wrapper">
                <table class="stock-table fp-board-table">
                    <thead><tr>
                        <th>板块</th><th>涨跌幅</th><th>涨</th><th>跌</th><th>领涨股</th><th>领涨涨幅</th><th>主力净流入</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    /**
     * 构建近10日行业轮动热力矩阵
     * 行选择逻辑：统计各日涨幅榜TOP5板块出现频次，取频次最高的12个板块
     * @param {HTMLElement} wrap 矩阵容器
     * @param {string[]} dates 交易日列表（升序）
     * @param {Object[]} daysData 各日复盘数据（与dates等长）
     */
    function buildMatrix(wrap, dates, daysData) {
        // 统计板块出现频次（每日topUp前5）
        const freq = new Map();  // name -> 出现次数
        const changeMap = new Map();  // name -> Map(date -> change)
        daysData.forEach((day, di) => {
            const top = ((day.sectors || {}).industry || {}).topUp || [];
            top.slice(0, 5).forEach(sec => {
                freq.set(sec.name, (freq.get(sec.name) || 0) + 1);
            });
            // 记录全部板块当日涨幅（矩阵值）
            top.forEach(sec => {
                if (!changeMap.has(sec.name)) changeMap.set(sec.name, new Map());
                changeMap.get(sec.name).set(dates[di], sec.change);
            });
        });

        // 高频板块（出现>=2次优先，按频次排序，最多12行；不足时补0次板块）
        let names = Array.from(freq.entries())
            .filter(([, c]) => c >= 2)
            .sort((a, b) => b[1] - a[1])
            .map(([n]) => n);
        if (names.length < 8) {
            // 补充当日涨幅榜靠前板块
            const todayTop = (((daysData[daysData.length - 1] || {}).sectors || {}).industry || {}).topUp || [];
            for (const sec of todayTop) {
                if (names.length >= 12) break;
                if (!names.includes(sec.name)) names.push(sec.name);
            }
        }
        names = names.slice(0, 12);

        if (!names.length) {
            wrap.innerHTML = '<div class="fp-empty">暂无板块数据</div>';
            return;
        }

        const rows = names.map(name => {
            const byDate = changeMap.get(name) || new Map();
            return {
                name,
                values: dates.map(d => byDate.has(d) ? byDate.get(d) : null)
            };
        });

        wrap.innerHTML = '';
        wrap.appendChild(FupanCharts.heatMatrix({
            dates,
            rows,
            cellSize: 40,
            valueFormat: v => v.toFixed(2) + '%'
        }));
        // 图例说明
        const legend = document.createElement('div');
        legend.className = 'fp-matrix-legend';
        legend.innerHTML = '<span>颜色=当日板块涨幅（红涨绿跌，深浅随幅度）| 行=近10日涨幅榜高频板块</span>';
        wrap.appendChild(legend);
    }

    // ===== 子tab3：涨跌停 =====

    /**
     * 渲染涨跌停tab
     * 主流程：统计卡 → 池子三视图（涨停/跌停/炸板）→ 连板梯队 → 晋级率 → 情绪
     * @param {HTMLElement} container 容器
     * @param {Object} day 单日复盘数据
     */
    function renderZT(container, day) {
        const stats = day.stats || {};
        const sentiment = day.sentiment || {};
        const metrics = sentiment.metrics || {};

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

        // 2. 池子视图切换
        const poolHtml = `
            <div class="fp-board-switch">
                <button class="sub-tab active" data-fp-pool="zt">涨停池 (${(day.ztpool || []).length})</button>
                <button class="sub-tab" data-fp-pool="dt">跌停池 (${(day.dtpool || []).length})</button>
                <button class="sub-tab" data-fp-pool="zb">炸板池 (${(day.zbpool || []).length})</button>
            </div>
            <div class="fp-board-panels">
                <div data-fp-pool-panel="zt">${ztPoolTable(day.ztpool)}</div>
                <div data-fp-pool-panel="dt" style="display:none">${dtPoolTable(day.dtpool)}</div>
                <div data-fp-pool-panel="zb" style="display:none">${zbPoolTable(day.zbpool)}</div>
            </div>`;

        // 3. 连板梯队
        const ladderHtml = ladderView(day.ladder);

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
            ${section('涨跌停池', poolHtml)}
            ${section('连板梯队', ladderHtml)}
            ${section('晋级率', promoHtml)}
            ${section('市场情绪', sentimentHtml)}`;

        // 池子子tab切换
        container.querySelectorAll('[data-fp-pool]').forEach(btn => {
            btn.addEventListener('click', () => {
                const pool = btn.dataset.fpPool;
                container.querySelectorAll('[data-fp-pool]').forEach(b => b.classList.toggle('active', b === btn));
                container.querySelectorAll('[data-fp-pool-panel]').forEach(p => {
                    p.style.display = p.dataset.fpPoolPanel === pool ? '' : 'none';
                });
            });
        });
    }

    /**
     * 生成涨停池表格HTML
     * @param {Array} pool 涨停池
     * @returns {string} table HTML
     */
    function ztPoolTable(pool) {
        if (!pool || !pool.length) return '<div class="fp-empty">当日无涨停</div>';
        const rows = pool.map((s, i) => `
            <tr>
                <td class="col-rank">${i + 1}</td>
                <td class="col-name">${esc(s.name)}</td>
                <td class="col-code">${esc(s.code)}</td>
                <td>${s.price !== null ? s.price.toFixed(2) : '--'}</td>
                ${changeTd(s.change, true)}
                <td>${FupanData.formatAmount(s.amount)}</td>
                <td>${FupanData.formatAmount(s.floatMV)}</td>
                <td>${s.turnover !== null && s.turnover !== undefined ? s.turnover.toFixed(2) + '%' : '--'}</td>
                <td class="change-up">${FupanData.formatAmount(s.sealFund)}</td>
                <td>${s.sealRatio !== null && s.sealRatio !== undefined ? s.sealRatio.toFixed(2) : '--'}</td>
                <td>${esc(s.firstSealTime || '--')}</td>
                <td>${esc(s.lastSealTime || '--')}</td>
                <td>${s.openCount ?? 0}</td>
                <td class="fp-lb">${s.lbCount ?? 1}板</td>
                <td>${esc(s.stats || '--')}</td>
                <td>${typeBadge(s.limitType)}</td>
                <td class="fp-industry" title="${esc(s.industry || '')}">${esc(s.industry || '--')}</td>
            </tr>`).join('');
        return `
            <div class="table-wrapper">
                <table class="stock-table fp-pool-table">
                    <thead><tr>
                        <th>#</th><th>名称</th><th>代码</th><th>现价</th><th>涨跌幅</th><th>成交额</th><th>流通市值</th>
                        <th>换手</th><th>封单额</th><th title="封单额/成交额，越大封板越坚决">封成比</th>
                        <th>首次封板</th><th>最后封板</th><th>开板</th><th>连板</th><th>几天几板</th><th>板型</th><th>行业</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    /**
     * 生成跌停池表格HTML
     * @param {Array} pool 跌停池
     * @returns {string} table HTML
     */
    function dtPoolTable(pool) {
        if (!pool || !pool.length) return '<div class="fp-empty">当日无跌停</div>';
        const rows = pool.map((s, i) => `
            <tr>
                <td class="col-rank">${i + 1}</td>
                <td class="col-name">${esc(s.name)}</td>
                <td class="col-code">${esc(s.code)}</td>
                <td>${s.price !== null ? s.price.toFixed(2) : '--'}</td>
                ${changeTd(s.change, true)}
                <td>${FupanData.formatAmount(s.amount)}</td>
                <td>${s.turnover !== null && s.turnover !== undefined ? s.turnover.toFixed(2) + '%' : '--'}</td>
                <td class="change-down">${FupanData.formatAmount(s.sealFund)}</td>
                <td>${esc(s.lastSealTime || '--')}</td>
                <td>${s.lbCount ?? 1}连跌</td>
                <td class="fp-industry" title="${esc(s.industry || '')}">${esc(s.industry || '--')}</td>
            </tr>`).join('');
        return `
            <div class="table-wrapper">
                <table class="stock-table fp-pool-table">
                    <thead><tr>
                        <th>#</th><th>名称</th><th>代码</th><th>现价</th><th>跌跌幅</th><th>成交额</th>
                        <th>换手</th><th>封单额</th><th>最后封板</th><th>连续跌停</th><th>行业</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    /**
     * 生成炸板池表格HTML
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
                <td class="col-rank">${i + 1}</td>
                <td class="col-name">${esc(s.name)}</td>
                <td class="col-code">${esc(s.code)}</td>
                <td>${s.price !== null ? s.price.toFixed(2) : '--'}</td>
                ${changeTd(s.change, true)}
                <td>${s.limitPrice !== null && s.limitPrice !== undefined ? s.limitPrice.toFixed(2) : '--'}</td>
                ${changeTd(gapPct, true)}
                <td>${FupanData.formatAmount(s.amount)}</td>
                <td>${s.turnover !== null && s.turnover !== undefined ? s.turnover.toFixed(2) + '%' : '--'}</td>
                <td>${esc(s.firstSealTime || '--')}</td>
                <td>${s.openCount ?? '--'}</td>
                <td class="fp-industry" title="${esc(s.industry || '')}">${esc(s.industry || '--')}</td>
            </tr>`;
        }).join('');
        return `
            <div class="table-wrapper">
                <table class="stock-table fp-pool-table">
                    <thead><tr>
                        <th>#</th><th>名称</th><th>代码</th><th>现价</th><th>涨跌幅</th><th>涨停价</th><th>距涨停</th>
                        <th>成交额</th><th>换手</th><th>首次封板</th><th>炸板次数</th><th>行业</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    /**
     * 生成连板梯队视图HTML（从高板到首板，横向chips）
     * @param {Array} ladder 梯队数据
     * @returns {string} HTML
     */
    function ladderView(ladder) {
        if (!ladder || !ladder.length) return '<div class="fp-empty">当日无连板梯队</div>';
        const levels = ladder.slice().sort((a, b) => b.level - a.level);
        return levels.map(level => `
            <div class="fp-ladder-row">
                <div class="fp-ladder-level">
                    <span class="fp-ladder-badge">${level.level}板</span>
                    <span class="fp-ladder-count">${level.count}只</span>
                </div>
                <div class="fp-ladder-stocks">
                    ${(level.stocks || []).map(s => `
                        <span class="fp-ladder-chip" title="${esc(s.name)} ${esc(s.industry || '')} 首封${esc(s.firstSealTime || '--')} 封单${FupanData.formatAmount(s.sealFund)}">
                            ${roleBadge(s.role)}${esc(s.name)}
                            <span class="fp-chip-stats">${esc(s.stats || '')}</span>
                            ${typeBadge(s.limitType)}
                        </span>`).join('')}
                </div>
            </div>`).join('');
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
                    <td>${esc(k.replace('->', '板→'))}板</td>
                    <td>${item.yesterday ?? '--'}</td>
                    <td>${item.promoted ?? '--'}</td>
                    <td class="${rateCls}">${ratePct}%</td>
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
            ${section('模型说明', modelHtml)}`;

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
