/**
 * ECharts图表封装模块
 * 提供柱状图、热力图、分时图、表格、板块走势图等图表
 */

const ChartRender = {

    /**
     * 渲染柱状图 - 板块资金净流入排名
     */
    renderBarChart(chartDom, data) {
        const chart = echarts.init(chartDom, 'dark');
        const sectors = data.sectors || [];
        const displaySectors = sectors;

        // 按净流入排序（从小到大，ECharts barh从下到上）
        displaySectors.sort((a, b) => a.main_net_inflow_yi - b.main_net_inflow_yi);

        // 为每个板块构建独立的rich样式（实现动态颜色）
        const richStyles = { name: { color: '#e6edf3', fontSize: 12 } };
        const names = displaySectors.map((s, i) => {
            const pct = s.change_pct || 0;
            const pctStr = pct >= 0 ? `+${pct.toFixed(2)}%` : `${pct.toFixed(2)}%`;
            const pctColor = pct >= 0 ? '#f85149' : '#3fb950';
            // 每个板块使用独立的rich样式key，避免内联style
            const pctKey = `pct_${i}`;
            richStyles[pctKey] = { color: pctColor, fontSize: 12, fontWeight: 'bold' };
            return `{name|${s.name}}{${pctKey}|(${pctStr})}`;
        });
        const values = displaySectors.map(s => s.main_net_inflow_yi);
        const changePcts = displaySectors.map(s => s.change_pct || 0);
        const turnoverYis = displaySectors.map(s => s.turnover_yi || 0);

        const option = {
            backgroundColor: '#161b22',
            title: {
                text: `${data.sector_type || '行业板块'} - ${data.indicator || '今日'}资金净流向`,
                left: 'center',
                textStyle: { color: '#e6edf3', fontSize: 18 }
            },
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'shadow' },
                formatter: function(params) {
                    const idx = params[0].dataIndex;
                    const s = displaySectors[idx];
                    const pctColor = s.change_pct >= 0 ? '#f85149' : '#3fb950';
                    const turnover = s.turnover_yi || 0;
                    return `<b>${s.name}</b><br/>` +
                           `主力净流入: <span style="color:${s.main_net_inflow_yi >= 0 ? '#f85149' : '#3fb950'}">${s.main_net_inflow_yi.toFixed(2)}亿</span><br/>` +
                           `涨跌幅: <span style="color:${pctColor}">${s.change_pct >= 0 ? '+' : ''}${s.change_pct.toFixed(2)}%</span><br/>` +
                           `成交额: <span style="color:#58a6ff">${turnover.toFixed(1)}亿</span><br/>` +
                           `主力净占比: ${(s.main_net_inflow_pct || 0).toFixed(2)}%`;
                }
            },
            grid: {
                left: '2%',
                right: '6%',
                bottom: '3%',
                top: '12%',
                containLabel: true
            },
            xAxis: {
                type: 'value',
                name: '主力资金净流入（亿元）',
                axisLine: { lineStyle: { color: '#30363d' } },
                axisLabel: { color: '#8b949e' },
                splitLine: { lineStyle: { color: '#21262d' } }
            },
            yAxis: {
                type: 'category',
                data: names,
                axisLine: { lineStyle: { color: '#30363d' } },
                axisLabel: {
                    color: '#e6edf3',
                    fontSize: 12,
                    width: 200,
                    overflow: 'none',
                    rich: richStyles
                }
            },
            series: [{
                type: 'bar',
                data: values.map((v, i) => ({
                    value: v,
                    itemStyle: {
                        color: v >= 0
                            ? new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                                { offset: 0, color: '#f8514966' },
                                { offset: 1, color: '#f85149' }
                            ])
                            : new echarts.graphic.LinearGradient(1, 0, 0, 0, [
                                { offset: 0, color: '#3fb95066' },
                                { offset: 1, color: '#3fb950' }
                            ])
                    },
                    label: {
                        show: true,
                        position: v >= 0 ? 'right' : 'left',
                        formatter: `${v.toFixed(2)}亿`,
                        color: '#e6edf3',
                        fontSize: 11
                    }
                })),
                barWidth: '60%'
            }],
            visualMap: {
                show: false,
                pieces: [
                    { gte: 0, color: '#f85149' },
                    { lt: 0, color: '#3fb950' }
                ]
            }
        };

        chart.setOption(option);
        window.addEventListener('resize', () => chart.resize());
        return chart;
    },

    /**
     * 渲染热力图 - 板块资金流向方块热力图
     */
    renderHeatmap(chartDom, data) {
        const chart = echarts.init(chartDom, 'dark');
        const sectors = data.sectors || [];
        const displaySectors = sectors;

        // 按净流入绝对值排序
        displaySectors.sort((a, b) => Math.abs(b.main_net_inflow_yi) - Math.abs(a.main_net_inflow_yi));

        const cols = 5;
        const rows = Math.ceil(displaySectors.length / cols);

        // 构建treemap数据
        const treeData = displaySectors.map(s => ({
            name: s.name,
            value: Math.abs(s.main_net_inflow_yi),
            netInflow: s.main_net_inflow_yi,
            changePct: s.change_pct || 0,
            turnoverYi: s.turnover_yi || 0,
            itemStyle: {
                color: s.main_net_inflow_yi >= 0 ? '#f85149' : '#3fb950',
                borderColor: '#0d1117',
                borderWidth: 2
            }
        }));

        const option = {
            backgroundColor: '#161b22',
            title: {
                text: `${data.sector_type || '行业板块'} - ${data.indicator || '今日'}资金流向热力图`,
                left: 'center',
                textStyle: { color: '#e6edf3', fontSize: 18 }
            },
            tooltip: {
                formatter: function(info) {
                    const d = info.data;
                    if (!d) return '';
                    const pctColor = d.changePct >= 0 ? '#f85149' : '#3fb950';
                    return `<b>${d.name}</b><br/>` +
                           `主力净流入: <span style="color:${d.netInflow >= 0 ? '#f85149' : '#3fb950'}">${d.netInflow.toFixed(2)}亿</span><br/>` +
                           `涨跌幅: <span style="color:${pctColor}">${d.changePct >= 0 ? '+' : ''}${d.changePct.toFixed(2)}%</span><br/>` +
                           `成交额: <span style="color:#58a6ff">${d.turnoverYi.toFixed(1)}亿</span>`;
                }
            },
            series: [{
                type: 'treemap',
                data: treeData,
                width: '95%',
                height: '85%',
                top: '10%',
                roam: false,
                nodeClick: false,
                breadcrumb: { show: false },
                label: {
                    show: true,
                    formatter: function(params) {
                        const d = params.data;
                        const pct = d.changePct >= 0 ? `+${d.changePct.toFixed(2)}%` : `${d.changePct.toFixed(2)}%`;
                        return `${d.name}(${pct})\n${d.netInflow.toFixed(1)}亿`;
                    },
                    fontSize: 12,
                    color: '#fff'
                },
                itemStyle: {
                    borderColor: '#0d1117',
                    borderWidth: 3,
                    gapWidth: 3
                },
                levels: [{
                    itemStyle: {
                        borderColor: '#0d1117',
                        borderWidth: 3,
                        gapWidth: 3
                    }
                }]
            }]
        };

        chart.setOption(option);
        window.addEventListener('resize', () => chart.resize());
        return chart;
    },


    /**
     * 渲染分时折线图 - 板块资金流向分时曲线
     * 每个板块一条折线，X轴为交易时间，Y轴为累计净流入金额
     * 右侧末端标签显示板块名称(涨幅)+净流入，防重叠依次展开
     * 支持趋势筛选：根据最近N分钟首尾点斜率，只显示上升/下降趋势的曲线
     * @param {HTMLElement} chartDom - 图表容器DOM
     * @param {Object} data - 分时数据
     * @param {Object} options - 趋势筛选选项 { trendFilter: 'all'|'rise'|'fall', trendMinutes: number }
     */
    renderIntradayChart(chartDom, data, options) {
        const chart = echarts.init(chartDom, 'dark');
        const times = data.times || [];
        const sectors = data.sectors || [];
        const displaySectors = sectors;
        options = options || {};
        const trendFilter = options.trendFilter || 'all';
        const trendMinutes = Math.max(1, Math.min(240, options.trendMinutes || 5));

        if (times.length === 0 || displaySectors.length === 0) {
            chart.showLoading({ text: '暂无分时数据\n需在交易时段运行定时采集积累数据' });
            return chart;
        }

        // 丰富颜色池：每个板块用不同颜色区分
        const colorPool = [
            '#f85149', '#ff7b72', '#ffa198',       // 红色系
            '#3fb950', '#56d364', '#7ee787',       // 绿色系
            '#58a6ff', '#79c0ff', '#a5d6ff',       // 蓝色系
            '#d2a8ff', '#bc8cff', '#e6b3ff',       // 紫色系
            '#f0883e', '#f7ba61', '#ffd700',       // 橙黄系
            '#a371f7', '#8957e5', '#da3633',       // 深色系
            '#39d353', '#26a641', '#1f6feb',       // 补充色
            '#f778ba', '#ff9bce', '#db61a2'        // 粉色系
        ];

        // 趋势筛选：计算每个板块最近N分钟首尾点斜率，判断上升/下降
        // slope > 0 为上升，slope < 0 为下降；数据点不足或斜率为0时不匹配上升/下降筛选
        const trendMatch = new Array(displaySectors.length).fill(true);
        if (trendFilter !== 'all') {
            displaySectors.forEach((s, i) => {
                const dataArr = s.data || [];
                const n = Math.min(trendMinutes, dataArr.length);
                if (n < 2) {
                    trendMatch[i] = false;
                    return;
                }
                const recent = dataArr.slice(-n);
                // 找到首尾有效值（跳过null/undefined）
                let firstVal = null;
                let lastVal = null;
                for (let k = 0; k < recent.length && firstVal === null; k++) {
                    if (recent[k] !== null && recent[k] !== undefined) firstVal = recent[k];
                }
                for (let k = recent.length - 1; k >= 0 && lastVal === null; k--) {
                    if (recent[k] !== null && recent[k] !== undefined) lastVal = recent[k];
                }
                if (firstVal === null || lastVal === null) {
                    trendMatch[i] = false;
                    return;
                }
                const slope = lastVal - firstVal;
                if (trendFilter === 'rise') {
                    trendMatch[i] = slope > 0;
                } else if (trendFilter === 'fall') {
                    trendMatch[i] = slope < 0;
                }
            });
            const matchedCount = trendMatch.filter(Boolean).length;
            console.log(`分时图趋势筛选[${trendFilter}/${trendMinutes}分钟]: 匹配 ${matchedCount}/${displaySectors.length} 个板块`);
        }

        // 计算Y轴范围（留出标签空间）
        let maxVal = -Infinity;
        let minVal = Infinity;
        displaySectors.forEach((s, i) => {
            if (!trendMatch[i]) return; // 趋势筛选不匹配的数据不参与Y轴范围计算
            s.data.forEach(v => {
                if (v !== null && v > maxVal) maxVal = v;
                if (v !== null && v < minVal) minVal = v;
            });
        });
        // 若全部不匹配，回退到全部数据计算范围，避免空范围
        if (maxVal === -Infinity || minVal === Infinity) {
            displaySectors.forEach(s => {
                s.data.forEach(v => {
                    if (v !== null && v > maxVal) maxVal = v;
                    if (v !== null && v < minVal) minVal = v;
                });
            });
        }
        const padding = Math.max(Math.abs(maxVal - minVal) * 0.15, 10);
        const yMin = Math.floor(minVal - padding);
        const yMax = Math.ceil(maxVal + padding);

        // 计算标签防重叠偏移量 - 从中间向上下两侧发散
        const labelHeight = 16; // 每个标签占用的像素高度
        const labelOffsets = new Array(displaySectors.length).fill(0);
        const sortedWithIndex = displaySectors
            .map((s, i) => ({ final_value: s.final_value, index: i }))
            .sort((a, b) => a.final_value - b.final_value);

        // 将Y值转换为像素位置
        const chartHeight = parseInt(chartDom.style.height) || 600;
        const gridTop = chartHeight * 0.12;
        const gridBottom = chartHeight * 0.05;
        const plotHeight = chartHeight - gridTop - gridBottom;
        const yRange = yMax - yMin || 1;

        // 计算每个标签的原始像素Y坐标
        const pixelPositions = sortedWithIndex.map(item =>
            gridTop + plotHeight * (1 - (item.final_value - yMin) / yRange)
        );

        // 从中间向两侧发散：中间标签不偏移，上方标签向上偏，下方标签向下偏
        const n = sortedWithIndex.length;
        const midIdx = Math.floor(n / 2);

        // 中间标签不偏移
        for (let i = midIdx; i < n; i++) {
            // 下半部分（Y值较大，像素位置靠上）：向下偏移
            for (let j = midIdx; j < i; j++) {
                const curY = pixelPositions[i] + labelOffsets[sortedWithIndex[i].index];
                const prevY = pixelPositions[j] + labelOffsets[sortedWithIndex[j].index];
                if (curY < prevY && prevY - curY < labelHeight) {
                    labelOffsets[sortedWithIndex[i].index] += (prevY - labelHeight) - curY;
                }
            }
        }

        for (let i = midIdx - 1; i >= 0; i--) {
            // 上半部分（Y值较小，像素位置靠下）：向上偏移
            for (let j = midIdx - 1; j > i; j--) {
                const curY = pixelPositions[i] + labelOffsets[sortedWithIndex[i].index];
                const prevY = pixelPositions[j] + labelOffsets[sortedWithIndex[j].index];
                if (curY > prevY && curY - prevY < labelHeight) {
                    labelOffsets[sortedWithIndex[i].index] -= (curY - (prevY + labelHeight));
                }
            }
        }

        // 构建series，应用偏移和板块名(涨幅)格式
        // 趋势筛选不匹配的数据初始淡化显示（复用点击聚焦的隐藏效果）
        const finalSeries = displaySectors.map((sector, index) => {
            const color = colorPool[index % colorPool.length];
            const isPositive = sector.final_value >= 0;
            const changePct = sector.change_pct || 0;
            const pctStr = changePct >= 0 ? `+${changePct.toFixed(2)}%` : `${changePct.toFixed(2)}%`;
            const turnoverYi = sector.turnover_yi || 0;
            const valStr = sector.final_value >= 0 ? `+${sector.final_value.toFixed(2)}` : `${sector.final_value.toFixed(2)}`;
            const valColor = isPositive ? '#f85149' : '#3fb950';
            const pctColor = changePct >= 0 ? '#f85149' : '#3fb950';
            const isMatched = trendMatch[index];
            const dimColor = '#484f58';
            const labelColors = isMatched ? {
                name: '#e6edf3',
                pct: pctColor,
                val: valColor,
                turnover: '#58a6ff'
            } : {
                name: dimColor,
                pct: dimColor,
                val: dimColor,
                turnover: dimColor
            };

            return {
                name: sector.name,
                type: 'line',
                data: sector.data,
                smooth: false,
                symbol: 'none',
                triggerLineEvent: true,  // symbol为none时仍需响应曲线点击事件
                lineStyle: { width: isMatched ? 1.5 : 1, color: color, opacity: isMatched ? 1 : 0.15 },
                itemStyle: { color: color },
                // 末端标签：与tooltip格式一致，富文本实现红涨绿跌
                markPoint: {
                    symbol: 'circle',
                    symbolSize: isMatched ? 8 : 6,
                    itemStyle: { color: color, opacity: isMatched ? 1 : 0.15 },
                    label: {
                        show: true,
                        position: 'right',
                        formatter: [
                            `{name|${sector.name}}`,
                            `{pct|(${pctStr})}: `,
                            `{val|${valStr}亿} `,
                            `{turnover|${turnoverYi.toFixed(1)}亿}`
                        ].join(''),
                        fontSize: 10,
                        fontWeight: 'normal',
                        rich: {
                            name: { color: labelColors.name, fontSize: 10, fontWeight: 'normal' },
                            pct: { color: labelColors.pct, fontSize: 10, fontWeight: 'normal' },
                            val: { color: labelColors.val, fontSize: 10, fontWeight: 'normal' },
                            turnover: { color: labelColors.turnover, fontSize: 10, fontWeight: 'normal' }
                        },
                        offset: [0, labelOffsets[index]]
                    },
                    data: [{ coord: [times.length - 1, sector.final_value] }]
                }
            };
        });

        // 跟踪鼠标Y位置对应的数据值，用于tooltip中高亮鼠标最近的曲线条目
        // 多条曲线相交或相邻时，高亮当前鼠标对应的曲线，方便准确区分是哪条曲线
        let mouseYDataValue = null;

        const option = {
            backgroundColor: '#161b22',
            title: {
                text: `${data.date || ''} 分时资金流向`,
                subtext: `${data.sector_type || ''}`,
                left: 'center',
                textStyle: { color: '#e6edf3', fontSize: 18 },
                subtextStyle: { color: '#8b949e', fontSize: 13 }
            },
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'cross' },
                // tooltip始终在图表区域上下居中
                position: function(point, params, dom, rect, size) {
                    // point: 鼠标位置 [x, y]
                    // size: {contentSize: [width, height], viewSize: [chartWidth, chartHeight]}
                    const x = point[0] + 15;
                    const y = (size.viewSize[1] - size.contentSize[1]) / 2;
                    // 防止右侧溢出
                    const maxX = size.viewSize[0] - size.contentSize[0] - 10;
                    return [Math.min(x, maxX), Math.max(y, 10)];
                },
                formatter: function(params) {
                    if (!params || params.length === 0) return '';
                    let html = `<b>${params[0].axisValue}</b><br/>`;
                    // 按当前值排序
                    params.sort((a, b) => (b.value || 0) - (a.value || 0));

                    // 找到鼠标Y位置最近的曲线条目（用于tooltip高亮）
                    // 多条曲线相交或相邻时，高亮当前鼠标对应的曲线，方便准确区分
                    let highlightedIndex = -1;
                    if (mouseYDataValue !== null) {
                        let minDist = Infinity;
                        params.forEach((p, i) => {
                            if (p.value !== null && p.value !== undefined) {
                                const dist = Math.abs(p.value - mouseYDataValue);
                                if (dist < minDist) {
                                    minDist = dist;
                                    highlightedIndex = i;
                                }
                            }
                        });
                    }

                    let totalTurnover = 0;
                    params.forEach((p, i) => {
                        const sector = displaySectors.find(s => s.name === p.seriesName);
                        if (!sector) return;
                        const val = p.value !== undefined && p.value !== null ? p.value.toFixed(2) : '-';
                        const changePct = sector.change_pct || 0;
                        const turnoverYi = sector.turnover_yi || 0;
                        totalTurnover += turnoverYi;
                        const pctStr = changePct >= 0 ? `+${changePct.toFixed(2)}%` : `${changePct.toFixed(2)}%`;
                        const valStr = (p.value >= 0 ? '+' : '') + val + '亿';
                        const valColor = p.value >= 0 ? '#f85149' : '#3fb950';
                        const pctColor = changePct >= 0 ? '#f85149' : '#3fb950';
                        // 格式: 板块名(涨幅): 净流入 成交额
                        // 仅高亮选中条目（背景色高亮），其余条目保持原有tooltip样式不变
                        if (i === highlightedIndex) {
                            html += `<div style="background:rgba(88,166,255,0.3);border-radius:3px;padding:1px 4px;">` +
                                    `<span style="color:${p.color}">●</span> <b>${p.seriesName}</b>` +
                                    `(<span style="color:${pctColor};font-weight:bold">${pctStr}</span>): ` +
                                    `<span style="color:${valColor};font-weight:bold">${valStr}</span> ` +
                                    `<span style="color:#58a6ff">${turnoverYi.toFixed(1)}亿</span>` +
                                    `</div>`;
                        } else {
                            html += `<span style="color:${p.color}">●</span> ${p.seriesName}` +
                                    `(<span style="color:${pctColor};font-weight:bold">${pctStr}</span>): ` +
                                    `<span style="color:${valColor};font-weight:bold">${valStr}</span> ` +
                                    `<span style="color:#58a6ff">${turnoverYi.toFixed(1)}亿</span><br/>`;
                        }
                    });
                    html += `<hr style="border-color:#30363d;margin:4px 0"/>` +
                            `<span style="color:#8b949e">总成交额: </span>` +
                            `<span style="color:#58a6ff;font-weight:bold">${totalTurnover.toFixed(1)}亿</span>`;
                    return html;
                }
            },
            legend: {
                show: false
            },
            grid: {
                left: '8%',
                right: '28%',
                bottom: '5%',
                top: '12%',
                containLabel: false
            },
            xAxis: {
                type: 'category',
                data: times,
                boundaryGap: false,
                axisLine: { lineStyle: { color: '#30363d' } },
                axisLabel: { color: '#8b949e', fontSize: 11 },
                splitLine: { show: false }
            },
            yAxis: {
                type: 'value',
                name: '主力资金净流入（亿元）',
                nameTextStyle: { color: '#8b949e', fontSize: 12 },
                axisLine: { lineStyle: { color: '#30363d' } },
                axisLabel: {
                    color: '#8b949e',
                    formatter: v => v + '亿'
                },
                splitLine: { lineStyle: { color: '#21262d', type: 'dashed' } },
                axisTick: { show: false },
                min: yMin,
                max: yMax
            },
            // 零线参考线
            markLine: {
                silent: true,
                symbol: 'none',
                lineStyle: { color: '#8b949e', width: 1, type: 'solid' },
                data: [{ yAxis: 0 }]
            },
            series: finalSeries,
            animationDuration: 1000,
            animationEasing: 'cubicOut'
        };

        chart.setOption(option);

        // 注册鼠标移动事件：跟踪鼠标Y位置对应的数据值
        // convertFromPixel将像素Y坐标转为y轴数据值，tooltip formatter中据此高亮最近曲线
        chart.getZr().on('mousemove', function(e) {
            mouseYDataValue = chart.convertFromPixel({yAxisIndex: 0}, e.offsetY);
        });
        chart.getZr().on('mouseout', function() {
            mouseYDataValue = null;
        });

        // 点击曲线聚焦：点击某条曲线只显示该曲线（高亮+加粗），隐藏其他曲线；
        // 再次点击同一条曲线，恢复显示所有曲线
        // 点击markPoint标签也触发聚焦
        let focusedIndex = -1;  // 当前聚焦的series索引，-1表示全部显示

        /**
         * 更新曲线聚焦状态：focusedIndex对应的曲线加粗高亮，其余淡化
         * 趋势筛选不匹配的曲线始终保持淡化，不受聚焦状态影响
         * @param {number} focusIdx - 聚焦的series索引，-1恢复全部
         */
        function updateFocusState(focusIdx) {
            // 重建完整series数组，确保markPoint和lineStyle样式完全生效
            const updatedSeries = displaySectors.map((sector, i) => {
                const color = colorPool[i % colorPool.length];
                const changePct = sector.change_pct || 0;
                const isPositive = sector.final_value >= 0;
                const pctStr = changePct >= 0 ? `+${changePct.toFixed(2)}%` : `${changePct.toFixed(2)}%`;
                const valStr = sector.final_value >= 0 ? `+${sector.final_value.toFixed(2)}` : `${sector.final_value.toFixed(2)}`;
                const valColor = isPositive ? '#f85149' : '#3fb950';
                const pctColor = changePct >= 0 ? '#f85149' : '#3fb950';
                const isMatched = trendMatch[i];
                const dimColor = '#484f58';

                let lineWidth, lineOpacity, labelColors, fontWeight;
                if (!isMatched) {
                    // 趋势筛选不匹配：始终保持淡化
                    lineWidth = 1;
                    lineOpacity = 0.15;
                    labelColors = { name: dimColor, pct: dimColor, val: dimColor, turnover: dimColor };
                    fontWeight = 'normal';
                } else if (focusIdx === -1 || i === focusIdx) {
                    // 全部显示 或 聚焦曲线：原色+正常/加粗
                    lineWidth = focusIdx === -1 ? 1.5 : 3;
                    lineOpacity = 1;
                    labelColors = {
                        name: '#e6edf3',
                        pct: pctColor,
                        val: valColor,
                        turnover: '#58a6ff'
                    };
                    fontWeight = focusIdx === -1 ? 'normal' : 'bold';
                } else {
                    // 非聚焦曲线：淡化
                    lineWidth = 1;
                    lineOpacity = 0.15;
                    labelColors = { name: dimColor, pct: dimColor, val: dimColor, turnover: dimColor };
                    fontWeight = 'normal';
                }

                return {
                    name: sector.name,
                    type: 'line',
                    data: sector.data,
                    smooth: false,
                    symbol: 'none',
                    triggerLineEvent: true,
                    lineStyle: { width: lineWidth, color: color, opacity: lineOpacity },
                    itemStyle: { color: color },
                    markPoint: {
                        symbol: 'circle',
                        symbolSize: focusIdx === i ? 10 : (isMatched ? 8 : 6),
                        itemStyle: { color: color, opacity: lineOpacity },
                        label: {
                            show: true,
                            position: 'right',
                            formatter: [
                                `{name|${sector.name}}`,
                                `{pct|(${pctStr})}: `,
                                `{val|${valStr}亿} `,
                                `{turnover|${(sector.turnover_yi || 0).toFixed(1)}亿}`
                            ].join(''),
                            fontSize: 10,
                            fontWeight: fontWeight,
                            rich: {
                                name: { color: labelColors.name, fontSize: 10, fontWeight: fontWeight },
                                pct: { color: labelColors.pct, fontSize: 10, fontWeight: fontWeight },
                                val: { color: labelColors.val, fontSize: 10, fontWeight: fontWeight },
                                turnover: { color: labelColors.turnover, fontSize: 10, fontWeight: fontWeight }
                            },
                            offset: [0, labelOffsets[i]]
                        },
                        data: [{ coord: [times.length - 1, sector.final_value] }]
                    }
                };
            });
            chart.setOption({ series: updatedSeries }, { replaceMerge: ['series'] });
        }

        chart.on('click', function(params) {
            // markPoint点击时可能没有seriesName，用seriesIndex兜底
            let seriesIndex = -1;
            if (params.seriesName) {
                seriesIndex = finalSeries.findIndex(s => s.name === params.seriesName);
            } else if (typeof params.seriesIndex === 'number') {
                seriesIndex = params.seriesIndex;
            }
            if (seriesIndex === -1 || seriesIndex >= finalSeries.length) return;

            if (focusedIndex === seriesIndex) {
                // 再次点击同一条曲线，恢复全部
                focusedIndex = -1;
            } else {
                // 聚焦该曲线
                focusedIndex = seriesIndex;
            }
            updateFocusState(focusedIndex);
        });

        window.addEventListener('resize', () => chart.resize());
        return chart;
    },

    /**
     * 渲染板块数据表格 - 显示每个板块的实时涨幅、成交额、净流入额，支持点击表头排序
     * @param {HTMLElement} chartDom - 图表容器DOM
     * @param {Object} data - 板块数据
     * @returns {Object} 包含dispose方法的对象（与其他渲染方法保持一致）
     */
    renderTable(chartDom, data) {
        const sectors = data.sectors || [];
        if (sectors.length === 0) {
            chartDom.innerHTML = '<div style="text-align:center;padding:100px;color:#8b949e;">暂无数据</div>';
            return { dispose: () => {} };
        }

        // 当前排序状态
        let sortField = 'main_net_inflow_yi';
        let sortOrder = 'desc'; // desc=降序, asc=升序

        /**
         * 渲染表格HTML
         */
        function render() {
            // 排序数据
            console.log(`[debug] renderTable render() 排序前sectors[0] turnover_yi=${sectors[0]?.turnover_yi}, sectors[1] turnover_yi=${sectors[1]?.turnover_yi}`);
            const sorted = [...sectors].sort((a, b) => {
                let va = a[sortField];
                let vb = b[sortField];
                // 字符串字段用localeCompare
                if (sortField === 'name') {
                    return sortOrder === 'desc'
                        ? (vb || '').localeCompare(va || '', 'zh-CN')
                        : (va || '').localeCompare(vb || '', 'zh-CN');
                }
                va = va || 0;
                vb = vb || 0;
                return sortOrder === 'desc' ? vb - va : va - vb;
            });

            // 排序指示箭头
            const arrow = (field) => {
                if (sortField !== field) return ' <span style="color:#484f58">&#9650;&#9660;</span>';
                return sortOrder === 'desc' ? ' <span style="color:#58a6ff">&#9660;</span>' : ' <span style="color:#58a6ff">&#9650;</span>';
            };

            let html = `
            <div class="sector-table-title">${data.sector_type || '板块'} - ${data.indicator || '今日'}资金净流向</div>
            <table class="sector-table">
                <thead>
                    <tr>
                        <th class="sortable" data-field="name">板块${arrow('name')}</th>
                        <th class="sortable" data-field="change_pct">涨跌幅${arrow('change_pct')}</th>
                        <th class="sortable" data-field="main_net_inflow_yi">主力净流入(亿)${arrow('main_net_inflow_yi')}</th>
                        <th class="sortable" data-field="turnover_yi">成交额(亿)${arrow('turnover_yi')}</th>
                        <th class="sortable" data-field="main_net_inflow_pct">净流入占比${arrow('main_net_inflow_pct')}</th>
                    </tr>
                </thead>
                <tbody>`;

            sorted.forEach((s, i) => {
                const pct = s.change_pct || 0;
                const pctColor = pct >= 0 ? '#f85149' : '#3fb950';
                const pctStr = pct >= 0 ? `+${pct.toFixed(2)}%` : `${pct.toFixed(2)}%`;
                const val = s.main_net_inflow_yi || 0;
                const valColor = val >= 0 ? '#f85149' : '#3fb950';
                const valStr = val >= 0 ? `+${val.toFixed(2)}` : `${val.toFixed(2)}`;
                const turnover = s.turnover_yi || 0;
                const pctInflow = s.main_net_inflow_pct || 0;

                html += `
                    <tr>
                        <td class="sector-name">${s.name}</td>
                        <td style="color:${pctColor};font-weight:bold">${pctStr}</td>
                        <td style="color:${valColor};font-weight:bold">${valStr}</td>
                        <td style="color:#58a6ff">${turnover.toFixed(1)}</td>
                        <td>${pctInflow.toFixed(2)}%</td>
                    </tr>`;
            });

            html += '</tbody></table>';
            chartDom.innerHTML = html;

            // 绑定表头排序事件
            chartDom.querySelectorAll('th.sortable').forEach(th => {
                th.addEventListener('click', function() {
                    const field = this.dataset.field;
                    if (sortField === field) {
                        sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
                    } else {
                        sortField = field;
                        sortOrder = field === 'name' ? 'asc' : 'desc';
                    }
                    render();
                });
            });
        }

        render();
        return { dispose: () => { chartDom.innerHTML = ''; } };
    },

    /**
     * 渲染板块走势图 - 多日趋势对比（柱状+折线组合）
     * 柱状图：每日交易额(蓝)+净流入额(红/绿)
     * 折线图：涨幅(%)，右Y轴
     * 多板块叠加对比，颜色区分
     * @param {HTMLElement} chartDom - 图表容器
     * @param {Object} data - {dates, sectors, dailyData, sectorType}
     */
    renderTrendChart(chartDom, data) {
        const chart = echarts.init(chartDom, 'dark');
        const dates = data.dates || [];
        const sectorNames = data.sectors || [];
        const dailyData = data.dailyData || [];
        const colors = ['#58a6ff', '#f85149', '#3fb950', '#d29922', '#bc8cff'];
        const isSingle = sectorNames.length === 1;

        // 构建series：每个板块一组柱(交易额+净流入) + 一条涨幅折线
        const series = [];
        sectorNames.forEach((name, idx) => {
            const color = colors[idx % colors.length];
            const turnoverData = dates.map(date => {
                const day = dailyData.find(d => d.date === date);
                return day && day.sectors[name] ? day.sectors[name].turnover : null;
            });
            const inflowData = dates.map(date => {
                const day = dailyData.find(d => d.date === date);
                return day && day.sectors[name] ? day.sectors[name].net_inflow : null;
            });
            const pctData = dates.map(date => {
                const day = dailyData.find(d => d.date === date);
                return day && day.sectors[name] ? day.sectors[name].change_pct : null;
            });

            // 单板块模式：成交额柱作为底柱（蓝色半透明），净流入柱覆盖其上（红绿）
            // 多板块模式：只显示净流入柱+涨幅线（避免太乱，各板块成交额在tooltip）
            if (isSingle) {
                // 成交额底柱（蓝色半透明）
                series.push({
                    name: `${name}-成交额`,
                    type: 'bar',
                    yAxisIndex: 0,
                    data: turnoverData,
                    itemStyle: { color: 'rgba(88, 166, 255, 0.3)' },
                    z: 1,
                    barGap: '-100%',
                    barCategoryGap: '40%'
                });
                // 净流入覆盖柱（红绿），与成交额同位置显示
                series.push({
                    name: `${name}-净流入`,
                    type: 'bar',
                    yAxisIndex: 0,
                    data: inflowData.map(v => ({
                        value: v,
                        itemStyle: { color: v >= 0 ? '#f85149' : '#3fb950' }
                    })),
                    z: 2,
                    barGap: '-100%',
                    barCategoryGap: '40%'
                });
            } else {
                // 多板块：每个板块净流入柱用各自颜色
                series.push({
                    name: `${name}-净流入`,
                    type: 'bar',
                    yAxisIndex: 0,
                    data: inflowData,
                    itemStyle: { color: color },
                    barGap: '20%',
                    barCategoryGap: '40%'
                });
            }

            // 涨幅折线（右Y轴）
            // 小圆点按红涨绿跌着色，折线保持板块色用于区分
            series.push({
                name: `${name}-涨幅`,
                type: 'line',
                yAxisIndex: 1,
                data: pctData.map(v => ({
                    value: v,
                    itemStyle: { color: v !== null && v >= 0 ? '#f85149' : '#3fb950' }
                })),
                smooth: true,
                symbol: 'circle',
                symbolSize: 6,
                lineStyle: { width: 2, color: color },
                // 0% 参考线：灰色虚线加粗，明显区分涨幅正负
                markLine: {
                    silent: true,
                    symbol: 'none',
                    lineStyle: { color: '#8b949e', type: 'dashed', width: 1.5 },
                    data: [{ yAxis: 0 }],
                    label: { show: false }
                }
            });
        });

        const option = {
            backgroundColor: '#161b22',
            title: {
                text: `${data.sectorType === 'all' ? '全部板块' : (data.sectorType === 'industry' ? '行业板块' : '概念板块')} - 板块走势对比`,
                subtext: `${dates[0]} ~ ${dates[dates.length - 1]} | ${sectorNames.length}个板块`,
                left: 'center',
                textStyle: { color: '#e6edf3', fontSize: 18 },
                subtextStyle: { color: '#8b949e', fontSize: 14 }
            },
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'cross' },
                formatter: function(params) {
                    const date = params[0].axisValue;
                    let html = `<div style="font-weight:bold;margin-bottom:4px;">${date}</div>`;
                    params.forEach(p => {
                        const val = p.value;
                        if (val === null || val === undefined) return;
                        let valStr;
                        if (p.seriesName.includes('涨幅')) {
                            valStr = `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
                        } else {
                            valStr = `${val.toFixed(2)}亿`;
                        }
                        html += `<div>${p.marker}${p.seriesName}: <b>${valStr}</b></div>`;
                    });
                    return html;
                }
            },
            legend: {
                top: 60,
                textStyle: { color: '#8b949e' },
                type: 'scroll'
            },
            grid: {
                left: '5%',
                right: '5%',
                bottom: '8%',
                top: '25%',
                containLabel: true
            },
            xAxis: {
                type: 'category',
                data: dates,
                axisLine: { lineStyle: { color: '#30363d' } },
                axisLabel: { color: '#8b949e' }
            },
            yAxis: [
                {
                    type: 'value',
                    name: '金额(亿)',
                    axisLine: { lineStyle: { color: '#30363d' } },
                    axisLabel: { color: '#8b949e' },
                    splitLine: { lineStyle: { color: '#21262d' } }
                },
                {
                    type: 'value',
                    name: '涨幅(%)',
                    axisLine: { lineStyle: { color: '#30363d' } },
                    axisLabel: {
                        color: '#8b949e',
                        formatter: function(value) {
                            const key = value > 0 ? 'up' : (value < 0 ? 'down' : 'zero');
                            return `{${key}|${value}%}`;
                        },
                        rich: {
                            up: { color: '#f85149', fontWeight: 'bold' },
                            down: { color: '#3fb950', fontWeight: 'bold' },
                            zero: { color: '#8b949e', fontWeight: 'bold' }
                        }
                    },
                    // 0% 参考线用虚线+灰色，与正负区间明显区分
                    splitLine: {
                        show: true,
                        lineStyle: {
                            color: function(params) {
                                return params.value === 0 ? '#8b949e' : '#21262d';
                            },
                            type: function(params) {
                                return params.value === 0 ? 'dashed' : 'solid';
                            },
                            width: function(params) {
                                return params.value === 0 ? 1.5 : 1;
                            }
                        }
                    }
                }
            ],
            series: series,
            dataZoom: [
                { type: 'inside', start: 0, end: 100 },
                { type: 'slider', start: 0, end: 100, height: 20, bottom: 10 }
            ]
        };

        chart.setOption(option);
        window.addEventListener('resize', () => chart.resize());
        return chart;
    }
};
