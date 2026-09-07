/**
 * 每日复盘图表模块（FupanCharts）
 *
 * 纯SVG图表工厂：输入数据+配置，输出SVG DOM元素，无状态、不操作业务DOM。
 * 深色主题配色（与style.css一致：背景#0f172a、网格#334155、文字#94a3b8）。
 *
 * 图表类型：
 * 1. lineChart  折线图（多序列：涨停/跌停家数趋势等）
 * 2. barChart   柱状图（成交额、晋级率等）
 * 3. heatMatrix 板块轮动热力矩阵（日期×板块，格子颜色=当日板块涨跌幅）
 * 4. radarChart 雷达图（评分8维度）
 */
const FupanCharts = (function () {

    // 主题常量
    const C = {
        bg: 'transparent',
        grid: '#334155',
        axis: '#475569',
        text: '#94a3b8',
        textDim: '#64748b',
        up: '#ef4444',
        down: '#22c55e',
        blue: '#3b82f6',
        yellow: '#f59e0b',
        purple: '#a78bfa',
        cyan: '#22d3ee'
    };

    // 序列默认色板
    const PALETTE = [C.blue, C.up, C.down, C.yellow, C.purple, C.cyan];

    // SVG命名空间
    const NS = 'http://www.w3.org/2000/svg';

    /**
     * 创建SVG元素
     * @param {string} tag 标签名
     * @param {Object} attrs 属性字典
     * @returns {SVGElement}
     */
    function el(tag, attrs) {
        const node = document.createElementNS(NS, tag);
        for (const k in attrs) node.setAttribute(k, attrs[k]);
        return node;
    }

    /**
     * 创建文本元素
     * @param {number} x x坐标
     * @param {number} y y坐标
     * @param {string} text 文本
     * @param {Object} opts {fill, size, anchor, rotate}
     * @returns {SVGElement}
     */
    function text(x, y, str, opts = {}) {
        const t = el('text', {
            x, y,
            fill: opts.fill || C.text,
            'font-size': opts.size || 10,
            'text-anchor': opts.anchor || 'middle'
        });
        if (opts.rotate) {
            t.setAttribute('transform', `rotate(${opts.rotate} ${x} ${y})`);
        }
        t.textContent = str;
        return t;
    }

    /**
     * 折线图（多序列）
     * @param {Object} opts
     *   labels: string[] x轴标签
     *   series: [{name, values, color?}] 序列（values含null则断线）
     *   height: number 高度px（默认200）
     *   yFormat: (v)=>string y轴刻度格式化
     *   combinedHover: boolean 合并悬浮提示（每个x点一个透明热区，title显示所有序列值）
     *   smooth: 是否平滑（默认折线直连）
     * @returns {SVGElement} SVG元素（宽度100%自适应）
     */
    function lineChart(opts) {
        const labels = opts.labels || [];
        const series = opts.series || [];
        const height = opts.height || 200;
        const width = 800;                 // viewBox宽度（横向自适应拉伸）
        const padL = 46, padR = 12, padT = 14, padB = 24;
        const iw = width - padL - padR, ih = height - padT - padB;

        const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height: 'auto', class: 'fp-chart' });

        // 计算值域（所有序列合并）
        let min = Infinity, max = -Infinity;
        series.forEach(s => s.values.forEach(v => {
            if (v !== null && !isNaN(v)) { if (v < min) min = v; if (v > max) max = v; }
        }));
        if (min === Infinity) { min = 0; max = 1; }
        if (min === max) { min -= 1; max += 1; }
        const padding = (max - min) * 0.08;
        min -= padding; max += padding;

        // 坐标映射
        const n = labels.length;
        const xAt = i => n <= 1 ? padL + iw / 2 : padL + iw * i / (n - 1);
        const yAt = v => padT + ih * (1 - (v - min) / (max - min));

        // y轴网格线（5条）+ 刻度值
        const yFormat = opts.yFormat || (v => String(Math.round(v * 100) / 100));
        for (let i = 0; i <= 4; i++) {
            const v = min + (max - min) * i / 4;
            const y = yAt(v);
            svg.appendChild(el('line', { x1: padL, y1: y, x2: width - padR, y2: y, stroke: C.grid, 'stroke-width': 0.5, 'stroke-dasharray': '3,3' }));
            svg.appendChild(text(padL - 6, y + 3, yFormat(v), { anchor: 'end', size: 9, fill: C.textDim }));
        }

        // x轴标签（稀疏：最多8个）
        const step = Math.max(1, Math.ceil(n / 8));
        labels.forEach((lb, i) => {
            if (i % step === 0 || i === n - 1) {
                svg.appendChild(text(xAt(i), height - 6, lb, { size: 9, fill: C.textDim }));
            }
        });

        // 序列折线（null断线：分段path）
        series.forEach((s, si) => {
            const color = s.color || PALETTE[si % PALETTE.length];
            let d = '', pen = false;
            s.values.forEach((v, i) => {
                if (v === null || isNaN(v)) { pen = false; return; }
                const cmd = pen ? 'L' : 'M';
                d += `${cmd}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`;
                pen = true;
            });
            if (d) {
                svg.appendChild(el('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-linejoin': 'round' }));
            }
            // 数据点（稀疏：<=20个时显示，便于悬浮查看）
            if (n <= 20) {
                s.values.forEach((v, i) => {
                    if (v === null || isNaN(v)) return;
                    const c = el('circle', { cx: xAt(i).toFixed(1), cy: yAt(v).toFixed(1), r: 2.5, fill: color });
                    const title = el('title', {});
                    title.textContent = `${labels[i]} ${s.name}: ${yFormat(v)}`;
                    c.appendChild(title);
                    svg.appendChild(c);
                });
            }
        });

        // 合并悬浮热区（TODO5.1.4/5.1.5：hover显示各序列具体值，如"上涨X家 下跌Y家"）
        if (opts.combinedHover && n > 0) {
            for (let i = 0; i < n; i++) {
                const x = xAt(i);
                const hit = el('circle', { cx: x.toFixed(1), cy: (padT + ih / 2).toFixed(1), r: Math.max(10, iw / n / 2), fill: 'transparent', 'pointer-events': 'all' });
                const parts = series.map(s => `${s.name}: ${s.values[i] === null || s.values[i] === undefined ? '--' : yFormat(s.values[i])}`);
                const t = el('title', {});
                t.textContent = `${labels[i]}  ${parts.join('  ')}`;
                hit.appendChild(t);
                svg.appendChild(hit);
            }
        }

        // 图例
        let lx = padL;
        series.forEach((s, si) => {
            const color = s.color || PALETTE[si % PALETTE.length];
            svg.appendChild(el('rect', { x: lx, y: 4, width: 10, height: 3, fill: color, rx: 1 }));
            const t = text(lx + 14, 8, s.name, { size: 9, anchor: 'start' });
            svg.appendChild(t);
            lx += 20 + s.name.length * 9 + 8;
        });

        return svg;
    }

    /**
     * 柱状图（单序列，含正负值双向支持）
     * @param {Object} opts
     *   labels: string[] x轴标签
     *   values: number[] 数值（可含null）
     *   height: number 高度px
     *   color: string 柱色（默认蓝；含负值时红涨绿跌）
     *   valueFormat: (v)=>string 数值格式化（悬浮提示/柱顶标签用）
     *   axisFormat: (v)=>string y轴刻度格式化（默认同valueFormat）
     *   valueLabels: number 最近N根柱顶显示数值标签（TODO5.1.3）
     * @returns {SVGElement}
     */
    function barChart(opts) {
        const labels = opts.labels || [];
        const values = opts.values || [];
        const height = opts.height || 200;
        const width = 800;
        const padL = 46, padR = 12, padT = 16, padB = 24;
        const iw = width - padL - padR, ih = height - padT - padB;

        const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height: 'auto', class: 'fp-chart' });
        const valueFormat = opts.valueFormat || (v => String(Math.round(v * 100) / 100));
        const axisFormat = opts.axisFormat || valueFormat;
        const hasNeg = values.some(v => v !== null && v < 0);

        // 值域
        let min = 0, max = 0;
        values.forEach(v => { if (v !== null && !isNaN(v)) { if (v < min) min = v; if (v > max) max = v; } });
        if (min === max) { max = min + 1; }
        const padding = (max - min) * 0.08;
        max += padding;
        if (min < 0) min -= padding;

        const n = values.length;
        const slot = iw / Math.max(1, n);
        const barW = Math.max(4, Math.min(28, slot * 0.6));
        const yAt = v => padT + ih * (1 - (v - min) / (max - min));
        const zeroY = yAt(0);

        // 网格线
        for (let i = 0; i <= 4; i++) {
            const v = min + (max - min) * i / 4;
            const y = yAt(v);
            svg.appendChild(el('line', { x1: padL, y1: y, x2: width - padR, y2: y, stroke: C.grid, 'stroke-width': 0.5, 'stroke-dasharray': '3,3' }));
            svg.appendChild(text(padL - 6, y + 3, axisFormat(v), { anchor: 'end', size: 9, fill: C.textDim }));
        }

        // 柱体
        values.forEach((v, i) => {
            if (v === null || isNaN(v)) return;
            const x = padL + slot * i + (slot - barW) / 2;
            const y = v >= 0 ? yAt(v) : zeroY;
            const h = Math.max(1, Math.abs(zeroY - yAt(v)));
            const color = hasNeg ? (v >= 0 ? C.up : C.down) : (opts.color || C.blue);
            const bar = el('rect', { x: x.toFixed(1), y: y.toFixed(1), width: barW.toFixed(1), height: h.toFixed(1), fill: color, rx: 1.5 });
            const title = el('title', {});
            title.textContent = `${labels[i]}: ${valueFormat(v)}`;
            bar.appendChild(title);
            svg.appendChild(bar);
            // 最近N根柱顶数值标签（TODO5.1.3：最近5个交易日显示数值）
            if (opts.valueLabels && i >= n - opts.valueLabels) {
                svg.appendChild(text(x + barW / 2, y - 4, valueFormat(v), { size: 9, fill: C.text }));
            }
        });

        // x轴标签（稀疏）
        const step = Math.max(1, Math.ceil(n / 10));
        labels.forEach((lb, i) => {
            if (i % step === 0 || i === n - 1) {
                svg.appendChild(text(padL + slot * i + slot / 2, height - 6, lb, { size: 9, fill: C.textDim }));
            }
        });

        return svg;
    }

    /**
     * 板块轮动热力矩阵（行=板块，列=交易日，格子颜色=当日板块涨跌幅）
     * @param {Object} opts
     *   dates: string[] 列标签（交易日，显示MM-DD）
     *   rows: [{name, values: (number|null)[]}] 行数据（values与dates等长）
     *   valueFormat: (v)=>string 悬浮提示格式化
     *   cellSize: number 格子边px（默认34）
     * @returns {SVGElement}
     */
    function heatMatrix(opts) {
        const dates = opts.dates || [];
        const rows = opts.rows || [];
        const valueFormat = opts.valueFormat || (v => v.toFixed(2) + '%');
        const cell = opts.cellSize || 34;
        const gap = 3;
        const labelW = 86;    // 行标签宽度
        const headH = 22;     // 列标签高度
        const width = labelW + dates.length * (cell + gap) + 8;
        const height = headH + rows.length * (cell + gap) + 6;

        const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height: 'auto', class: 'fp-chart fp-matrix' });

        /**
         * 涨跌幅映射格子颜色：红涨绿跌，深浅随幅度
         * @param {number} v 涨跌幅%
         * @returns {string} fill颜色
         */
        function cellColor(v) {
            if (v === null || v === undefined || isNaN(v)) return '#1e293b';
            const intensity = Math.min(0.18 + Math.abs(v) / 8 * 0.72, 0.9);
            if (v > 0) return `rgba(239,68,68,${intensity.toFixed(2)})`;
            if (v < 0) return `rgba(34,197,94,${intensity.toFixed(2)})`;
            return '#26334d';
        }

        // 列标签
        dates.forEach((d, ci) => {
            const x = labelW + ci * (cell + gap) + cell / 2;
            svg.appendChild(text(x, 14, d.slice(5), { size: 9, fill: C.textDim }));
        });

        // 行：标签+格子
        rows.forEach((row, ri) => {
            const y = headH + ri * (cell + gap);
            // 行标签（左对齐，超长省略）
            const label = text(labelW - 8, y + cell / 2 + 3, row.name, { size: 10, anchor: 'end' });
            const t = el('title', {});
            t.textContent = row.name;
            label.appendChild(t);
            svg.appendChild(label);
            // 格子
            row.values.forEach((v, ci) => {
                const x = labelW + ci * (cell + gap);
                const rect = el('rect', {
                    x, y, width: cell, height: cell, rx: 3,
                    fill: cellColor(v), stroke: '#0f172a', 'stroke-width': 1
                });
                const title = el('title', {});
                title.textContent = `${row.name} ${dates[ci]}: ${v === null ? '无数据' : valueFormat(v)}`;
                rect.appendChild(title);
                svg.appendChild(rect);
                // 格内数值（|v|>=1%显示）
                if (v !== null && !isNaN(v) && Math.abs(v) >= 1) {
                    const vt = text(x + cell / 2, y + cell / 2 + 3, v.toFixed(1), { size: 8, fill: '#0f172a', 'font-weight': 700 });
                    svg.appendChild(vt);
                }
            });
        });

        return svg;
    }

    /**
     * 雷达图（评分维度）
     * @param {Object} opts
     *   dims: [{label, value, max}] 维度（3~10个）
     *   size: number 图表边px（默认240）
     * @returns {SVGElement}
     */
    function radarChart(opts) {
        const dims = opts.dims || [];
        const size = opts.size || 240;
        const cx = size / 2, cy = size / 2, r = size / 2 - 34;
        const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'fp-chart fp-radar' });

        const n = dims.length;
        if (n < 3) return svg;

        /**
         * 维度i（从正上方顺时针）半径比例t的坐标
         * @param {number} i 维度序号
         * @param {number} t 半径比例0-1
         * @returns {{x, y}}
         */
        function pt(i, t) {
            const angle = -Math.PI / 2 + i * 2 * Math.PI / n;
            return { x: cx + r * t * Math.cos(angle), y: cy + r * t * Math.sin(angle) };
        }

        // 背景网格（同心多边形，4层）
        for (let layer = 1; layer <= 4; layer++) {
            const t = layer / 4;
            let d = '';
            for (let i = 0; i < n; i++) {
                const p = pt(i, t);
                d += (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1);
            }
            svg.appendChild(el('path', { d: d + 'Z', fill: 'none', stroke: C.grid, 'stroke-width': 0.6 }));
        }

        // 轴线+维度标签
        dims.forEach((dim, i) => {
            const p = pt(i, 1);
            svg.appendChild(el('line', { x1: cx, y1: cy, x2: p.x, y2: p.y, stroke: C.grid, 'stroke-width': 0.6 }));
            const lp = pt(i, 1.22);
            // 标签带数值
            const label = text(lp.x, lp.y, `${dim.label} ${dim.value}`, { size: 9 });
            const t = el('title', {});
            t.textContent = `${dim.label}: ${dim.value}/${dim.max}`;
            label.appendChild(t);
            svg.appendChild(label);
        });

        // 数据多边形
        let d = '';
        dims.forEach((dim, i) => {
            const t = Math.max(0, Math.min(1, dim.value / dim.max));
            const p = pt(i, t);
            d += (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1);
        });
        svg.appendChild(el('path', { d: d + 'Z', fill: 'rgba(59,130,246,0.25)', stroke: C.blue, 'stroke-width': 1.8 }));
        // 顶点
        dims.forEach((dim, i) => {
            const t = Math.max(0, Math.min(1, dim.value / dim.max));
            const p = pt(i, t);
            svg.appendChild(el('circle', { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 2.5, fill: C.blue }));
        });

        return svg;
    }

    return { lineChart, barChart, heatMatrix, radarChart };
})();
