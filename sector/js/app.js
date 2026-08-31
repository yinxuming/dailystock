/**
 * 主应用逻辑
 * 负责数据加载、事件绑定、页面交互
 */

(function() {
    'use strict';

    let currentChart = null;
    let sectorListData = null;  // 板块列表数据缓存
    let selectedSectors = null; // 当前选中的板块（null=使用默认topN过滤）
    let lastRefreshTime = 0;    // 上次刷新数据的时间戳（毫秒）
    let intradayRefreshTimer = null;  // 分时图自动刷新定时器
    let isLoading = false;      // 数据加载中标志，防止自动刷新与手动刷新重叠
    let trendSelectedSectors = []; // 走势图选中的对比板块（最多5个）

    /**
     * 获取当前板块类型对应的typeKey
     * 'all' -> 'all', 'industry' -> 'industry', 'concept' -> 'concept'
     */
    function getTypeKey() {
        return document.getElementById('sectorType').value;
    }

    /**
     * 获取合并后的板块列表（全部模式下行概念同名板块加后缀区分）
     * @returns {{all: string[], preset: string[]}}
     */
    function getMergedSectorList() {
        const typeKey = getTypeKey();
        if (typeKey !== 'all' || !sectorListData) {
            return sectorListData?.[typeKey] || { all: [], preset: [] };
        }
        // 全部模式：合并行业+概念，同名时行业加"_行"后缀
        const industryAll = sectorListData.industry?.all || [];
        const conceptAll = sectorListData.concept?.all || [];
        const industryPreset = sectorListData.industry?.preset || [];
        const conceptPreset = sectorListData.concept?.preset || [];
        const conceptSet = new Set(conceptAll);

        const mergedAll = [];
        const mergedPreset = [];
        // 行业板块：与概念同名的加"_行"后缀
        industryAll.forEach(name => {
            const displayName = conceptSet.has(name) ? name + '_行' : name;
            mergedAll.push(displayName);
            if (industryPreset.includes(name)) mergedPreset.push(displayName);
        });
        // 概念板块：保持原名
        conceptAll.forEach(name => {
            mergedAll.push(name);
            if (conceptPreset.includes(name)) mergedPreset.push(name);
        });
        return { all: mergedAll, preset: mergedPreset };
    }

    /**
     * 将显示名称还原为原始板块名和类型
     * "_行"后缀的为行业板块，否则优先查概念板块（概念板块数量更多）
     * @param {string} displayName - 显示名称（可能带_行后缀）
     * @returns {{name: string, type: string}} 原始名称和板块类型
     */
    function parseDisplayName(displayName) {
        if (displayName.endsWith('_行')) {
            return { name: displayName.slice(0, -2), type: 'industry' };
        }
        // 无后缀：优先查概念板块（概念板块数量通常更多）
        const conceptAll = sectorListData?.concept?.all || [];
        if (conceptAll.includes(displayName)) {
            return { name: displayName, type: 'concept' };
        }
        return { name: displayName, type: 'industry' };
    }

    /**
     * 初始化应用
     */
    /**
     * 获取今天日期字符串 YYYY-MM-DD
     */
    function getTodayStr() {
        return new Date().toISOString().slice(0, 10);
    }

    /**
     * 判断指定日期是否为今天
     * @param {string} dateStr YYYY-MM-DD
     */
    function isToday(dateStr) {
        return dateStr === getTodayStr();
    }

    async function init() {
        bindEvents();
        // 初始化日期选择器：默认为最近一个交易日（含当日如果是交易日）
        const chartType = document.getElementById('chartType').value;
        const isIntraday = chartType === 'intraday';
        document.getElementById('intradayFullGroup').style.display = isIntraday ? 'inline-flex' : 'none';
        if (!document.getElementById('intradayDate').value) {
            try {
                // 异步获取最近交易日（先加载节假日数据）
                const latestTradeDate = await TradingCalendar.getLatestTradeDateAsync();
                document.getElementById('intradayDate').value = latestTradeDate;
                console.log(`默认日期设为最近交易日: ${latestTradeDate}`);
            } catch (e) {
                console.warn('交易日历加载失败，回退到今天:', e);
                document.getElementById('intradayDate').value = getTodayStr();
            }
        }
        // 初始化自定义日期段默认值（默认最近30天，截止到今天）
        const todayStr = getTodayStr();
        const monthAgo = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
        if (!document.getElementById('startDate').value) {
            document.getElementById('startDate').value = monthAgo;
        }
        if (!document.getElementById('endDate').value) {
            document.getElementById('endDate').value = todayStr;
        }
        updateDatePickersVisibility();
        // 先加载板块列表，完成后再加载数据（确保板块过滤生效）
        loadSectorList().then(() => {
            loadData();
            // 初始数据加载后启动分时图自动刷新
            startIntradayAutoRefresh();
        });
    }

    /**
     * 更新日期选择器组的可见性
     * 规则：
     * - intraday始终用单日期选择器（分时图只看单日）
     * - trend(板块走势)用日期范围选择器（多日趋势对比）
     * - "自定义"指标显示日期范围选择器（仅柱状图/热力图/表格）
     * - 其他情况显示单日期选择器
     */
    function updateDatePickersVisibility() {
        const chartType = document.getElementById('chartType').value;
        const indicator = document.getElementById('indicator').value;
        const isIntraday = chartType === 'intraday';
        const isTrend = chartType === 'trend';
        const isCustom = indicator === '自定义';
        // intraday始终用单日期选择器
        if (isIntraday) {
            document.getElementById('dateGroup').style.display = 'inline-flex';
            document.getElementById('dateRangeGroup').style.display = 'none';
            return;
        }
        // trend(板块走势)用日期范围选择器
        if (isTrend) {
            document.getElementById('dateGroup').style.display = 'none';
            document.getElementById('dateRangeGroup').style.display = 'inline-flex';
            return;
        }
        // "自定义"指标：显示日期范围选择器，隐藏单日期选择器
        if (isCustom) {
            document.getElementById('dateGroup').style.display = 'none';
            document.getElementById('dateRangeGroup').style.display = 'inline-flex';
        } else {
            document.getElementById('dateGroup').style.display = 'inline-flex';
            document.getElementById('dateRangeGroup').style.display = 'none';
        }
    }

    /**
     * 绑定事件
     */
    function bindEvents() {
        document.getElementById('sectorType').addEventListener('change', function() {
            selectedSectors = null; // 切换板块类型时重置选中
            loadSectorList();
            loadData();
        });
        document.getElementById('indicator').addEventListener('change', function() {
            // "自定义"不支持分时图，自动切换到柱状图
            if (this.value === '自定义') {
                const chartTypeEl = document.getElementById('chartType');
                if (chartTypeEl.value === 'intraday') {
                    chartTypeEl.value = 'bar';
                    // chartType的change事件会调用updateDatePickersVisibility + loadData
                    // 此时indicator已经是"自定义"，dateRangeGroup会正确显示
                    chartTypeEl.dispatchEvent(new Event('change'));
                    return;
                }
            }
            updateDatePickersVisibility();
            loadData();
            // 指标变化后重新评估自动刷新
            startIntradayAutoRefresh();
        });
        document.getElementById('chartType').addEventListener('change', function() {
            // 获取完整分时按钮仅分时图显示
            const isIntraday = this.value === 'intraday';
            document.getElementById('intradayFullGroup').style.display = isIntraday ? 'inline-flex' : 'none';
            // 切换图表时，默认日期为今天
            if (!document.getElementById('intradayDate').value) {
                document.getElementById('intradayDate').value = new Date().toISOString().slice(0, 10);
            }
            // 板块走势图隐藏时间指标（走势图自带日期范围），显示板块选择器
            const isTrend = this.value === 'trend';
            document.getElementById('indicator').parentElement.style.display = isTrend ? 'none' : 'inline-flex';
            document.getElementById('trendSelector').style.display = isTrend ? 'block' : 'none';
            if (isTrend) renderTrendTags();
            updateDatePickersVisibility();
            loadData();
            // 图表类型变化后重新评估自动刷新
            startIntradayAutoRefresh();
        });
        document.getElementById('topN').addEventListener('change', loadData);
        document.getElementById('intradayDate').addEventListener('change', function() {
            // 历史日期下，时间指标强制为"今日"（历史数据只有当日分时数据）
            // 但不禁用indicator下拉框，用户仍可切换到"自定义"使用日期段模式
            const selectedDate = this.value || new Date().toISOString().slice(0, 10);
            const today = new Date().toISOString().slice(0, 10);
            const indicatorSelect = document.getElementById('indicator');
            if (selectedDate !== today && indicatorSelect.value !== '自定义') {
                indicatorSelect.value = '今日';
                updateDatePickersVisibility();
            }
            loadData();
            // 日期变化后重新评估自动刷新（历史日期不自动刷新）
            startIntradayAutoRefresh();
        });
        // 自定义日期段变化事件
        document.getElementById('startDate').addEventListener('change', loadData);
        document.getElementById('endDate').addEventListener('change', loadData);
        // 走势图板块搜索
        document.getElementById('trendSectorSearch').addEventListener('input', handleTrendSearch);
        document.getElementById('trendSectorSearch').addEventListener('blur', function() {
            // 延迟隐藏，让click事件先触发
            setTimeout(() => {
                document.getElementById('trendSearchResults').style.display = 'none';
            }, 200);
        });
        // 分时图自动刷新间隔选择
        document.getElementById('intradayRefreshInterval').addEventListener('change', function() {
            console.log(`刷新间隔变更为: ${this.value}秒`);
            startIntradayAutoRefresh();
        });
        // 分时图趋势筛选变化时重新加载数据
        document.getElementById('intradayTrendFilter').addEventListener('change', function() {
            if (document.getElementById('chartType').value === 'intraday') {
                loadData();
            }
        });
        document.getElementById('intradayTrendMinutes').addEventListener('change', function() {
            // 限制输入范围 1-240
            let val = parseInt(this.value, 10);
            if (isNaN(val) || val < 1) val = 1;
            if (val > 240) val = 240;
            this.value = val;
            if (document.getElementById('chartType').value === 'intraday') {
                loadData();
            }
        });
        document.getElementById('btnRefresh').addEventListener('click', loadData);

        // 获取完整分时数据按钮
        document.getElementById('btnIntradayFull').addEventListener('click', handleIntradayFull);

        // 设置面板
        document.getElementById('btnSettings').addEventListener('click', toggleSettingsPanel);
        document.getElementById('btnCloseSettings').addEventListener('click', function() {
            document.getElementById('settingsPanel').style.display = 'none';
        });

        // 板块配置面板（按钮在设置面板内，点击打开板块配置并关闭设置面板）
        document.getElementById('btnConfig').addEventListener('click', function() {
            document.getElementById('settingsPanel').style.display = 'none';
            toggleConfigPanel();
        });
        document.getElementById('btnCloseConfig').addEventListener('click', function() {
            document.getElementById('configPanel').style.display = 'none';
        });
        document.getElementById('btnSelectAll').addEventListener('click', function() {
            setAllCheckboxes(true);
        });
        document.getElementById('btnDeselectAll').addEventListener('click', function() {
            setAllCheckboxes(false);
        });
        document.getElementById('btnPreset').addEventListener('click', function() {
            selectPresetSectors();
        });
        document.getElementById('btnExport').addEventListener('click', exportSelectedSectors);
        document.getElementById('btnImport').addEventListener('click', importSelectedSectors);
        document.getElementById('btnSyncSectors').addEventListener('click', syncToPresetSectors);
        document.getElementById('importFile').addEventListener('change', handleImportFile);
        document.getElementById('sectorSearch').addEventListener('input', filterSectors);

        // 页面可见性变化监听
        // 1. 从不可见到可见时，超过阈值自动刷新（保留旧图表避免空白）
        // 2. 可见→隐藏：停止自动刷新定时器；隐藏→可见：恢复自动刷新
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState === 'visible') {
                const now = Date.now();
                const elapsed = now - lastRefreshTime;
                // 仅当日实时数据（今天 + 今日指标）才自动刷新
                const selectedDate = document.getElementById('intradayDate').value || new Date().toISOString().slice(0, 10);
                const today = new Date().toISOString().slice(0, 10);
                const indicator = document.getElementById('indicator').value;
                if (selectedDate === today && indicator === '今日' && elapsed > CONFIG.refreshThreshold) {
                    console.log(`页面可见，距离上次刷新${Math.round(elapsed/1000)}秒，超过阈值${CONFIG.refreshThreshold/1000}秒，自动刷新（保留旧图表）`);
                    loadData(true);
                }
                // 恢复分时图自动刷新
                startIntradayAutoRefresh();
            } else {
                // 页面隐藏时停止自动刷新，节省资源
                stopIntradayAutoRefresh();
            }
        });
    }

    /**
     * 处理「获取完整分时数据」按钮点击
     * 今天：通过东方财富API获取实时分时数据（优先后端，fallback前端代理）
     * 历史日期：从本地JSON文件加载（由GitHub Actions收盘后采集保存）
     */
    async function handleIntradayFull() {
        const btn = document.getElementById('btnIntradayFull');
        const originalText = btn.textContent;
        const selectedDate = document.getElementById('intradayDate').value || new Date().toISOString().slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);
        const isToday = selectedDate === today;

        btn.disabled = true;
        btn.textContent = '获取中...';

        try {
            if (isToday) {
                // 今天：优先后端API，fallback前端代理
                let result = null;
                try {
                    const resp = await fetch('/api/intraday-full');
                    result = await resp.json();
                } catch (e) {
                    console.log('后端API不可用，通过前端代理获取分时数据');
                }

                if (!result || !result.success) {
                    const sectorType = getTypeKey();
                    const topN = getTopNValue() === -1 ? 500 : (getTopNValue() || 30);
                    const selectedNames = getFilterParam();
                    // "全部"模式分别获取行业和概念
                    if (sectorType === 'all') {
                        const [indResult, conResult] = await Promise.all([
                            EastMoneyAPI.buildIntradayData('industry', topN, selectedNames),
                            EastMoneyAPI.buildIntradayData('concept', topN, selectedNames)
                        ]);
                        result = (indResult || conResult) ? { success: true } : { success: false, message: '东方财富API获取失败' };
                    } else {
                        const data = await EastMoneyAPI.buildIntradayData(sectorType, topN, selectedNames);
                        result = data ? { success: true } : { success: false, message: '东方财富API获取失败' };
                    }
                }

                if (result.success) {
                    btn.textContent = '获取成功';
                    btn.classList.add('success');
                    // 清除前端缓存，确保loadData从API/本地JSON获取最新数据
                    clearIntradayCache(selectedDate);
                    loadData();
                    setTimeout(() => {
                        btn.disabled = false;
                        btn.textContent = originalText;
                        btn.classList.remove('success');
                    }, 3000);
                } else {
                    btn.textContent = result.message || '获取失败';
                    setTimeout(() => {
                        btn.disabled = false;
                        btn.textContent = originalText;
                    }, 2000);
                }
            } else {
                // 历史日期：直接从本地JSON加载
                loadData();
                btn.textContent = '已加载';
                setTimeout(() => {
                    btn.disabled = false;
                    btn.textContent = originalText;
                }, 1500);
            }
        } catch (err) {
            console.error('获取完整分时数据失败:', err);
            btn.textContent = '获取失败';
            setTimeout(() => {
                btn.disabled = false;
                btn.textContent = originalText;
            }, 2000);
        }
    }

    /**
     * 切换板块配置面板显示
     */
    function toggleConfigPanel() {
        const panel = document.getElementById('configPanel');
        if (panel.style.display === 'none') {
            panel.style.display = 'block';
            renderSectorCheckboxes();
        } else {
            panel.style.display = 'none';
            // 关闭时应用选择
            applySectorSelection();
            loadData();
        }
    }

    /**
     * 加载板块列表数据
     */
    async function loadSectorList() {
        try {
            const data = await fetchJSON(CONFIG.dataPath + 'sector_list.json');
            sectorListData = data;
            renderSectorCheckboxes();
        } catch (err) {
            console.warn('板块列表加载失败，使用默认配置');
        }
    }

    /**
     * 渲染板块复选框列表（已勾选排前面，其余按自然顺序）
     */
    function renderSectorCheckboxes() {
        const container = document.getElementById('sectorCheckboxes');
        if (!sectorListData) return;

        const typeKey = getTypeKey();
        const mergedList = getMergedSectorList();
        const allSectors = mergedList.all;
        const presetSectors = mergedList.preset;

        // 从localStorage恢复上次选择
        const storageKey = `selectedSectors_${typeKey}`;
        const saved = localStorage.getItem(storageKey);
        let checkedSectors;
        if (saved) {
            try { checkedSectors = JSON.parse(saved); } catch(e) { checkedSectors = presetSectors; }
        } else {
            checkedSectors = presetSectors.length > 0 ? presetSectors : allSectors;
        }

        // 排序：已勾选的排前面，未勾选的按自然顺序
        const sortedSectors = [...allSectors].sort((a, b) => {
            const aChecked = checkedSectors.includes(a);
            const bChecked = checkedSectors.includes(b);
            if (aChecked !== bChecked) return aChecked ? -1 : 1;
            return a.localeCompare(b, 'zh-CN');
        });

        container.innerHTML = '';
        sortedSectors.forEach(name => {
            const label = document.createElement('label');
            const checked = checkedSectors.includes(name);
            if (checked) label.classList.add('selected');
            label.innerHTML = `<input type="checkbox" value="${name}" ${checked ? 'checked' : ''} /> ${name}`;
            label.querySelector('input').addEventListener('change', function() {
                if (this.checked) {
                    label.classList.add('selected');
                } else {
                    label.classList.remove('selected');
                }
                // 勾选变化实时保存到localStorage
                saveSectorSelection();
            });
            container.appendChild(label);
        });

        // 如果localStorage中没有保存过选择，将当前勾选状态（预设或默认）存入localStorage
        if (!saved) {
            localStorage.setItem(`selectedSectors_${typeKey}`, JSON.stringify(checkedSectors));
        }
    }

    /**
     * 全选/全不选
     */
    function setAllCheckboxes(checked) {
        const checkboxes = document.querySelectorAll('#sectorCheckboxes input[type="checkbox"]');
        checkboxes.forEach(cb => {
            cb.checked = checked;
            cb.parentElement.classList.toggle('selected', checked);
        });
    }

    /**
     * 恢复预设选择
     */
    function selectPresetSectors() {
        if (!sectorListData) return;
        const mergedList = getMergedSectorList();
        const presetSectors = mergedList.preset;

        const checkboxes = document.querySelectorAll('#sectorCheckboxes input[type="checkbox"]');
        checkboxes.forEach(cb => {
            const isPreset = presetSectors.includes(cb.value);
            cb.checked = isPreset;
            cb.parentElement.classList.toggle('selected', isPreset);
        });
    }

    /**
     * 搜索过滤板块
     */
    function filterSectors() {
        const keyword = document.getElementById('sectorSearch').value.trim().toLowerCase();
        const labels = document.querySelectorAll('#sectorCheckboxes label');
        labels.forEach(label => {
            const name = label.textContent.trim().toLowerCase();
            label.style.display = name.includes(keyword) ? '' : 'none';
        });
    }

    /**
     * 保存板块选择到localStorage（实时保存）
     */
    function saveSectorSelection() {
        const typeKey = getTypeKey();

        const checkboxes = document.querySelectorAll('#sectorCheckboxes input[type="checkbox"]:checked');
        const selected = Array.from(checkboxes).map(cb => cb.value);

        if (selected.length > 0) {
            localStorage.setItem(`selectedSectors_${typeKey}`, JSON.stringify(selected));
            selectedSectors = selected;
        } else {
            localStorage.removeItem(`selectedSectors_${typeKey}`);
            selectedSectors = null;
        }
    }

    /**
     * 应用板块选择（关闭配置面板时调用）
     */
    function applySectorSelection() {
        saveSectorSelection();
    }

    /**
     * 导出已选择板块为JSON文件（同时包含行业和概念板块）
     * "全部"模式下从selectedSectors_all中拆分出行业和概念
     */
    function exportSelectedSectors() {
        let industrySectors = [];
        let conceptSectors = [];

        // 从各自的localStorage key读取
        const industrySaved = localStorage.getItem('selectedSectors_industry');
        const conceptSaved = localStorage.getItem('selectedSectors_concept');
        if (industrySaved) {
            try { industrySectors = JSON.parse(industrySaved); } catch(e) { industrySectors = []; }
        }
        if (conceptSaved) {
            try { conceptSectors = JSON.parse(conceptSaved); } catch(e) { conceptSectors = []; }
        }

        // "全部"模式下，从selectedSectors_all拆分（覆盖上面的值，更准确）
        const typeKey = getTypeKey();
        if (typeKey === 'all') {
            const allSaved = localStorage.getItem('selectedSectors_all');
            if (allSaved) {
                try {
                    const allNames = JSON.parse(allSaved);
                    industrySectors = [];
                    conceptSectors = [];
                    allNames.forEach(name => {
                        const parsed = parseDisplayName(name);
                        if (parsed.type === 'industry') {
                            industrySectors.push(parsed.name);
                        } else {
                            conceptSectors.push(parsed.name);
                        }
                    });
                } catch(e) {}
            }
        }

        const exportData = {
            exportTime: new Date().toISOString(),
            industry: industrySectors,
            concept: conceptSectors
        };

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sector_selection_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * 同步非预设板块到定时任务
     * 检测用户已选但不在预设列表中的板块，生成 GitHub Issue 链接提交同步请求
     * 权限控制：任何用户可提交 Issue，仅协作者可添加 sync-sectors 标签审批触发同步工作流
     */
    function syncToPresetSectors() {
        if (!sectorListData) {
            alert('板块列表未加载，请稍后再试');
            return;
        }

        if (!CONFIG.syncSectorsRepo) {
            alert('未配置源码仓库地址（CONFIG.syncSectorsRepo），无法生成 Issue 链接');
            return;
        }

        // 获取已选板块（同时处理"全部"模式的 _行 后缀拆分）
        let industrySelected = [];
        let conceptSelected = [];
        const industrySaved = localStorage.getItem('selectedSectors_industry');
        const conceptSaved = localStorage.getItem('selectedSectors_concept');
        if (industrySaved) {
            try { industrySelected = JSON.parse(industrySaved); } catch(e) { industrySelected = []; }
        }
        if (conceptSaved) {
            try { conceptSelected = JSON.parse(conceptSaved); } catch(e) { conceptSelected = []; }
        }

        // "全部"模式下从 selectedSectors_all 拆分（覆盖上面的值，更准确）
        const typeKey = getTypeKey();
        if (typeKey === 'all') {
            const allSaved = localStorage.getItem('selectedSectors_all');
            if (allSaved) {
                try {
                    const allNames = JSON.parse(allSaved);
                    industrySelected = [];
                    conceptSelected = [];
                    allNames.forEach(name => {
                        const parsed = parseDisplayName(name);
                        if (parsed.type === 'industry') {
                            industrySelected.push(parsed.name);
                        } else {
                            conceptSelected.push(parsed.name);
                        }
                    });
                } catch(e) {}
            }
        }

        // 获取预设板块列表
        const industryPreset = sectorListData.industry?.preset || [];
        const conceptPreset = sectorListData.concept?.preset || [];

        // 找出非预设板块（已选但不在预设列表中）
        const industryPresetSet = new Set(industryPreset);
        const conceptPresetSet = new Set(conceptPreset);
        const newIndustry = industrySelected.filter(name => !industryPresetSet.has(name));
        const newConcept = conceptSelected.filter(name => !conceptPresetSet.has(name));

        const totalCount = newIndustry.length + newConcept.length;
        if (totalCount === 0) {
            alert('当前已选板块均在预设列表中，无需同步');
            return;
        }

        // 构建提交数据（只包含有新增板块的类型）
        const syncData = {};
        if (newIndustry.length > 0) syncData['行业板块'] = newIndustry;
        if (newConcept.length > 0) syncData['概念板块'] = newConcept;

        // 生成 Issue body
        const dateStr = new Date().toISOString().slice(0, 10);
        const jsonStr = JSON.stringify(syncData, null, 2);
        const body = [
            `## 板块同步请求`,
            ``,
            `以下板块需要添加到定时任务预设板块中，以便定时任务能自动采集其数据。`,
            ``,
            `### 新增板块（共 ${totalCount} 个）`,
            ``,
            '```json',
            jsonStr,
            '```',
            ``,
            `---`,
            `> 提交时间: ${dateStr}`,
            `> 此 Issue 由前端"同步预设"按钮自动生成，添加 \`sync-sectors\` 标签后将自动触发同步工作流。`,
        ].join('\n');

        // 生成 GitHub Issue URL
        const title = `[板块同步] 新增预设板块 - ${dateStr}`;
        const issueUrl = `https://github.com/${CONFIG.syncSectorsRepo}/issues/new` +
            `?title=${encodeURIComponent(title)}` +
            `&body=${encodeURIComponent(body)}` +
            `&labels=sync-sectors`;

        // 打开 Issue 创建页面
        window.open(issueUrl, '_blank');
    }

    /**
     * 导入已选择板块JSON文件
     */
    function importSelectedSectors() {
        document.getElementById('importFile').click();
    }

    /**
     * 处理导入文件（同时导入行业和概念板块）
     */
    function handleImportFile(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = JSON.parse(e.target.result);
                const currentTypeKey = getTypeKey();
                let importedCount = 0;
                let skippedCount = 0;
                const types = ['industry', 'concept'];

                // 兼容旧格式（只有selectedSectors字段）
                if (data.selectedSectors && !data.industry && !data.concept) {
                    const typeKey = data.sectorType || currentTypeKey;
                    const allSectors = sectorListData[typeKey]?.all || [];
                    const validSectors = data.selectedSectors.filter(name => allSectors.includes(name));
                    if (validSectors.length > 0) {
                        localStorage.setItem(`selectedSectors_${typeKey}`, JSON.stringify(validSectors));
                        if (typeKey === currentTypeKey) selectedSectors = validSectors;
                        importedCount += validSectors.length;
                        skippedCount += data.selectedSectors.length - validSectors.length;
                    }
                } else {
                    // 新格式：同时包含industry和concept
                    for (const typeKey of types) {
                        const sectors = data[typeKey];
                        if (!sectors || !Array.isArray(sectors)) continue;
                        const allSectors = sectorListData[typeKey]?.all || [];
                        const validSectors = sectors.filter(name => allSectors.includes(name));
                        if (validSectors.length > 0) {
                            localStorage.setItem(`selectedSectors_${typeKey}`, JSON.stringify(validSectors));
                            importedCount += validSectors.length;
                            skippedCount += sectors.length - validSectors.length;
                        }
                    }
                    // "全部"模式下还需构建selectedSectors_all（带_行后缀）
                    if (currentTypeKey === 'all') {
                        const allDisplayNames = [];
                        const conceptAll = new Set(sectorListData?.concept?.all || []);
                        for (const typeKey of types) {
                            const sectors = data[typeKey];
                            if (!sectors || !Array.isArray(sectors)) continue;
                            const allSectors = sectorListData[typeKey]?.all || [];
                            const validSectors = sectors.filter(name => allSectors.includes(name));
                            validSectors.forEach(name => {
                                if (typeKey === 'industry' && conceptAll.has(name)) {
                                    allDisplayNames.push(name + '_行');
                                } else {
                                    allDisplayNames.push(name);
                                }
                            });
                        }
                        if (allDisplayNames.length > 0) {
                            localStorage.setItem('selectedSectors_all', JSON.stringify(allDisplayNames));
                            selectedSectors = allDisplayNames;
                        }
                    } else {
                        // 单类型模式下更新当前选中
                        const saved = localStorage.getItem(`selectedSectors_${currentTypeKey}`);
                        if (saved) {
                            try { selectedSectors = JSON.parse(saved); } catch(e) {}
                        }
                    }
                }

                if (importedCount === 0) {
                    alert('导入失败：没有匹配的板块名称');
                    return;
                }

                // 重新渲染
                renderSectorCheckboxes();

                let msg = `成功导入 ${importedCount} 个板块（行业+概念）`;
                if (skippedCount > 0) {
                    msg += `（${skippedCount} 个板块名称不匹配已忽略）`;
                }
                alert(msg);
            } catch (err) {
                alert('导入失败：文件解析错误 - ' + err.message);
            }
        };
        reader.readAsText(file);
        // 重置file input，允许重复选择同一文件
        event.target.value = '';
    }

    /**
     * 获取topN值（数字），如果是"已选择板块"返回-1
     */
    function getTopNValue() {
        const val = document.getElementById('topN').value;
        return val === 'selected' ? -1 : parseInt(val) || 30;
    }

    /**
     * 获取当前选中的板块名称列表
     * 无localStorage时使用预设板块作为默认值
     */
    function getSelectedSectorNames() {
        const typeKey = getTypeKey();
        const storageKey = `selectedSectors_${typeKey}`;
        const saved = localStorage.getItem(storageKey);
        if (saved) {
            try { return JSON.parse(saved); } catch(e) { return null; }
        }
        // 无localStorage时，使用预设板块作为默认值
        const mergedList = getMergedSectorList();
        if (mergedList.preset.length > 0) {
            return mergedList.preset;
        }
        return null;
    }

    /**
     * 获取过滤参数：topN为"已选择板块"时返回selectedNames，否则返回null
     */
    function getFilterParam() {
        return getTopNValue() === -1 ? getSelectedSectorNames() : null;
    }

    // ========== 分时数据前端缓存（localStorage） ==========
    // 当日已从东方财富API获取的分时数据缓存到localStorage，避免频繁请求API
    // 缓存TTL由CONFIG.intradayCacheTTL控制（默认60秒）

    /**
     * 获取分时数据缓存的localStorage key
     * @param {string} sectorType - 板块类型
     * @param {string} date - 日期
     * @returns {string} cache key
     */
    function getIntradayCacheKey(sectorType, date) {
        return `intraday_cache_${sectorType}_${date}`;
    }

    /**
     * 保存分时数据到localStorage缓存
     * @param {string} sectorType - 板块类型
     * @param {string} date - 日期
     * @param {Object} data - 分时数据
     */
    function saveIntradayCache(sectorType, date, data) {
        try {
            const cacheKey = getIntradayCacheKey(sectorType, date);
            const cacheEntry = {
                data: data,
                timestamp: Date.now(),
                ttl: CONFIG.intradayCacheTTL * 1000
            };
            localStorage.setItem(cacheKey, JSON.stringify(cacheEntry));
            console.log(`分时数据已缓存: ${sectorType} ${date}`);
        } catch (e) {
            console.warn('缓存分时数据失败:', e.message);
        }
    }

    /**
     * 从localStorage读取分时数据缓存（未过期才返回）
     * @param {string} sectorType - 板块类型
     * @param {string} date - 日期
     * @returns {Object|null} 缓存的数据，无缓存或已过期返回null
     */
    function loadIntradayCache(sectorType, date) {
        try {
            const cacheKey = getIntradayCacheKey(sectorType, date);
            const raw = localStorage.getItem(cacheKey);
            if (!raw) return null;
            const entry = JSON.parse(raw);
            const elapsed = Date.now() - entry.timestamp;
            if (elapsed > entry.ttl) {
                console.log(`缓存已过期(${Math.round(elapsed/1000)}秒): ${sectorType} ${date}`);
                localStorage.removeItem(cacheKey);
                return null;
            }
            console.log(`命中缓存(${Math.round(elapsed/1000)}秒前): ${sectorType} ${date}`);
            return entry.data;
        } catch (e) {
            console.warn('读取分时缓存失败:', e.message);
            return null;
        }
    }

    /**
     * 清除指定日期的分时数据缓存（获取完整分时数据后调用，确保刷新使用新数据）
     * @param {string} date - 日期，默认今天
     */
    function clearIntradayCache(date) {
        const targetDate = date || new Date().toISOString().slice(0, 10);
        ['industry', 'concept'].forEach(sectorType => {
            const cacheKey = getIntradayCacheKey(sectorType, targetDate);
            localStorage.removeItem(cacheKey);
        });
        console.log(`已清除${targetDate}的分时数据缓存`);
    }

    // ========== 分时图自动刷新管理 ==========

    /**
     * 启动分时图自动刷新定时器
     * 仅在分时图模式 + 当日 + 页面可见时启动
     */
    function startIntradayAutoRefresh() {
        stopIntradayAutoRefresh();
        const chartType = document.getElementById('chartType').value;
        const selectedDate = document.getElementById('intradayDate').value || new Date().toISOString().slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);
        const indicator = document.getElementById('indicator').value;
        // 仅分时图 + 今日 + 今日指标才自动刷新
        if (chartType !== 'intraday' || selectedDate !== today || indicator !== '今日') {
            return;
        }
        const intervalSeconds = parseInt(document.getElementById('intradayRefreshInterval').value) || 0;
        if (intervalSeconds <= 0) {
            return;
        }
        console.log(`启动分时图自动刷新，间隔${intervalSeconds}秒`);
        intradayRefreshTimer = setInterval(() => {
            // 页面不可见时跳过刷新（visibilitychange会单独处理）
            if (document.visibilityState !== 'visible') return;
            console.log('分时图自动刷新触发');
            loadData(true);
        }, intervalSeconds * 1000);
    }

    /**
     * 停止分时图自动刷新定时器
     */
    function stopIntradayAutoRefresh() {
        if (intradayRefreshTimer) {
            clearInterval(intradayRefreshTimer);
            intradayRefreshTimer = null;
            console.log('分时图自动刷新已停止');
        }
    }

    /**
     * 切换设置面板显示
     */
    function toggleSettingsPanel() {
        const panel = document.getElementById('settingsPanel');
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    }

    /**
     * 加载数据并渲染图表
     * 优先使用东方财富API获取实时数据，本地JSON作为fallback
     * "全部"模式下分别获取行业和概念数据后合并
     * @param {boolean} preserveOldChart - 是否保留旧图表直到新数据就绪（用于页面可见性刷新，避免空白）
     */
    async function loadData(preserveOldChart = false) {
        // 防止自动刷新与手动刷新重叠
        if (isLoading) {
            console.log('数据正在加载中，跳过本次刷新');
            return;
        }
        isLoading = true;
        // 记录刷新时间
        lastRefreshTime = Date.now();

        const sectorType = getTypeKey();
        const indicator = document.getElementById('indicator').value;
        const chartType = document.getElementById('chartType').value;

        const chartDom = document.getElementById('mainChart');

        // 仅在不保留旧图表时立即销毁（原行为，用于切换图表类型/指标等场景）
        // preserveOldChart=true时延迟到渲染前才销毁，避免数据加载期间出现空白
        if (!preserveOldChart && currentChart) {
            currentChart.dispose();
            currentChart = null;
        }

        try {
            if (chartType === 'intraday') {
                // 分时图：优先东方财富API
                await loadIntradayData(chartDom, sectorType);
            } else if (chartType === 'trend') {
                // 板块走势图：多日趋势对比（柱状+折线组合）
                await loadTrendData(chartDom, sectorType);
            } else if (indicator === '自定义') {
                // 自定义日期段：聚合多日intraday JSON数据
                await loadCustomRangeData(chartDom, sectorType, chartType);
            } else {
                // 实时数据：优先东方财富API，fallback本地JSON
                await loadRealtimeData(chartDom, sectorType, indicator, chartType);
            }
        } catch (err) {
            console.error('数据加载失败:', err);
            if (preserveOldChart && currentChart) {
                // 保留旧图表，仅在更新时间区域提示错误，避免覆盖现有显示
                console.warn('保留旧图表数据显示，数据刷新失败');
                const updateTimeEl = document.getElementById('updateTime');
                if (updateTimeEl) {
                    updateTimeEl.textContent = `数据刷新失败，显示旧数据: ${err.message}`;
                }
            } else {
                chartDom.innerHTML = '<div style="text-align:center;padding:100px;color:#8b949e;">' +
                    '<h2>数据加载失败</h2>' +
                    '<p>请先运行 Python 脚本生成数据文件</p>' +
                    '<p style="font-size:12px;margin-top:10px;">python main.py --export</p></div>';
            }
        } finally {
            isLoading = false;
        }
    }

    /**
     * 加载自定义日期段数据并渲染图表
     * 遍历日期范围内每个日期的intraday JSON文件，聚合（净流入求和、成交额求和、涨幅取平均）后渲染
     * @param {HTMLElement} chartDom - 图表容器DOM
     * @param {string} sectorType - 板块类型
     * @param {string} chartType - 图表类型
     */
    async function loadCustomRangeData(chartDom, sectorType, chartType) {
        const startDate = document.getElementById('startDate').value;
        const endDate = document.getElementById('endDate').value;

        if (!startDate || !endDate) {
            throw new Error('请选择起止日期');
        }
        if (startDate > endDate) {
            throw new Error('开始日期不能晚于结束日期');
        }
        // 限制最大范围30天（数据保留期）
        const diffDays = Math.round((new Date(endDate) - new Date(startDate)) / 86400000);
        if (diffDays > 30) {
            throw new Error('自定义日期段最多30天，请缩小范围');
        }

        // 生成日期列表（含非交易日，无JSON文件时自动跳过）
        const dates = [];
        let current = new Date(startDate);
        const end = new Date(endDate);
        while (current <= end) {
            dates.push(current.toISOString().slice(0, 10));
            current.setDate(current.getDate() + 1);
        }

        // "全部"模式：分别聚合行业和概念，然后合并
        if (sectorType === 'all') {
            const [industryData, conceptData] = await Promise.all([
                aggregateIntradayRange('industry', dates),
                aggregateIntradayRange('concept', dates)
            ]);
            const data = mergeIndustryConceptData(industryData, conceptData);
            if (!data) throw new Error('所选日期段无数据，请确认日期范围内有已采集的数据');
            const filteredData = filterDataBySectors(data);
            renderChart(chartDom, filteredData, chartType);
            updateSummary(filteredData);
            return;
        }

        const data = await aggregateIntradayRange(sectorType, dates);
        if (!data) throw new Error('所选日期段无数据，请确认日期范围内有已采集的数据');
        const filteredData = filterDataBySectors(data);
        renderChart(chartDom, filteredData, chartType);
        updateSummary(filteredData);
    }

    /**
     * 聚合日期范围内多个intraday JSON的数据
     * 并行加载所有日期的intraday文件，对每个板块：净流入求和、成交额求和、涨幅取平均
     * @param {string} sectorType - 板块类型
     * @param {string[]} dates - 日期列表
     * @returns {Promise<Object|null>} 聚合后的realtime格式数据，无数据时返回null
     */
    async function aggregateIntradayRange(sectorType, dates) {
        // 串行加载所有日期的intraday JSON，每次请求间加随机100-500ms间隔
        // 避免连续请求过快被服务器限流，文件不存在时静默跳过
        const results = [];
        for (const date of dates) {
            try {
                const data = await fetchJSON(CONFIG.dataPath + `intraday_${sectorType}_${date}.json`);
                results.push({ data, date });
            } catch(e) {
                // 文件不存在（非交易日/无数据日期）静默跳过
            }
            // 随机100-500ms间隔，避免连续请求过快
            if (dates.indexOf(date) < dates.length - 1) {
                await new Promise(r => setTimeout(r, 100 + Math.random() * 400));
            }
        }

        // 过滤出成功加载的日期数据
        const validResults = results.filter(r => r !== null && r.data && r.data.sectors);
        if (validResults.length === 0) return null;

        // 按板块名称聚合：净流入求和、成交额求和、涨幅收集用于取平均
        const sectorMap = {};
        validResults.forEach(({ data }) => {
            (data.sectors || []).forEach(s => {
                if (!sectorMap[s.name]) {
                    sectorMap[s.name] = {
                        name: s.name,
                        totalInflow: 0,
                        totalTurnover: 0,
                        changePcts: []
                    };
                }
                sectorMap[s.name].totalInflow += (s.final_value || 0);
                sectorMap[s.name].totalTurnover += (s.turnover_yi || 0);
                sectorMap[s.name].changePcts.push(s.change_pct || 0);
            });
        });

        // 转换为realtime排名格式（字段名与realtime JSON一致）
        const sectors = Object.values(sectorMap).map(s => {
            const avgChangePct = s.changePcts.length > 0
                ? s.changePcts.reduce((a, b) => a + b, 0) / s.changePcts.length
                : 0;
            const inflow = Math.round(s.totalInflow * 100) / 100;
            const turnover = Math.round(s.totalTurnover * 100) / 100;
            return {
                name: s.name,
                main_net_inflow_yi: inflow,
                change_pct: Math.round(avgChangePct * 100) / 100,
                turnover_yi: turnover,
                main_net_inflow_pct: turnover
                    ? Math.round((inflow / turnover * 100) * 100) / 100
                    : 0
            };
        });

        return {
            update_time: `${validResults[0].date} ~ ${validResults[validResults.length - 1].date}`,
            date: `${dates[0]}~${dates[dates.length - 1]}`,
            indicator: '自定义',
            sector_type: validResults[0].data.sector_type || '',
            sectors: sectors,
            source: 'custom_range_aggregate'
        };
    }

    /**
     * 检查远程 JSON 文件是否存在（使用 HEAD 请求，不下载 body）
     * @param {string} url - 文件 URL
     * @returns {Promise<boolean>}
     */
    async function checkRemoteFileExists(url) {
        try {
            const response = await fetch(url, { method: 'HEAD', mode: 'cors' });
            return response.ok;
        } catch (e) {
            return false;
        }
    }

    /**
     * 扫描 localStorage 中已缓存的每日汇总数据，返回单个板块类型最早日期
     * @param {string} type - 板块类型（industry/concept）
     * @returns {string|null} 最早日期 YYYY-MM-DD
     */
    function getLocalTrendStartDateSingle(type) {
        const prefix = `daily_summary_${type}_`;
        let minDate = null;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(prefix)) {
                const date = key.slice(prefix.length);
                if (!minDate || date < minDate) minDate = date;
            }
        }
        return minDate;
    }

    /**
     * 扫描 localStorage 已缓存的每日汇总数据，返回指定板块类型最早日期
     * "全部"模式取行业/概念最早日期的较小值
     * @param {string} sectorType - 板块类型
     * @returns {string|null}
     */
    function getLocalTrendStartDate(sectorType) {
        if (sectorType === 'all') {
            const ind = getLocalTrendStartDateSingle('industry');
            const con = getLocalTrendStartDateSingle('concept');
            if (!ind) return con;
            if (!con) return ind;
            return ind < con ? ind : con;
        }
        return getLocalTrendStartDateSingle(sectorType);
    }

    /**
     * 远程扫描发现最早有数据的分时日期
     * 从昨天开始往前扫描最多 maxDays 天，分批并行检查
     * @param {string} type - 板块类型（industry/concept）
     * @param {number} maxDays - 最大扫描天数
     * @param {number} batchSize - 每批并行检查天数
     * @returns {Promise<string|null>}
     */
    async function findRemoteTrendStartDateSingle(type, maxDays, batchSize) {
        const today = new Date();
        let minDate = null;
        for (let i = 1; i <= maxDays; i += batchSize) {
            const batch = [];
            for (let j = 0; j < batchSize && i + j <= maxDays; j++) {
                const d = new Date(today);
                d.setDate(d.getDate() - (i + j));
                batch.push(d.toISOString().slice(0, 10));
            }
            const results = await Promise.all(batch.map(date => {
                const filename = `intraday_${type}_${date}.json`;
                return checkRemoteFileExists(CONFIG.dataPath + filename);
            }));
            for (let j = 0; j < batch.length; j++) {
                if (results[j] && (!minDate || batch[j] < minDate)) {
                    minDate = batch[j];
                }
            }
        }
        return minDate;
    }

    /**
     * 远程扫描发现最早有数据的分时日期
     * "全部"模式分别扫描行业/概念，取较早日期
     * @param {string} sectorType - 板块类型
     * @param {number} maxDays - 最大扫描天数
     * @param {number} batchSize - 每批并行检查天数
     * @returns {Promise<string|null>}
     */
    async function findRemoteTrendStartDate(sectorType, maxDays, batchSize) {
        maxDays = maxDays || 90;
        batchSize = batchSize || 10;
        if (sectorType === 'all') {
            const [ind, con] = await Promise.all([
                findRemoteTrendStartDateSingle('industry', maxDays, batchSize),
                findRemoteTrendStartDateSingle('concept', maxDays, batchSize)
            ]);
            if (!ind) return con;
            if (!con) return ind;
            return ind < con ? ind : con;
        }
        return findRemoteTrendStartDateSingle(sectorType, maxDays, batchSize);
    }

    /**
     * 获取板块走势图默认开始日期
     * 优先级：缓存的起始日期 → localStorage已加载数据 → 远程扫描 → null
     * @param {string} sectorType - 板块类型
     * @returns {Promise<string|null>} 最早日期或null
     */
    async function getTrendStartDate(sectorType) {
        const cacheKey = `trend_start_date_${sectorType}`;
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            try {
                const obj = JSON.parse(cached);
                if (Date.now() - obj.ts < 6 * 3600 * 1000) {
                    return obj.value;
                }
            } catch (e) { /* 缓存损坏，忽略 */ }
        }
        const localMin = getLocalTrendStartDate(sectorType);
        if (localMin) {
            localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), value: localMin }));
            return localMin;
        }
        const remoteMin = await findRemoteTrendStartDate(sectorType);
        if (remoteMin) {
            localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), value: remoteMin }));
            return remoteMin;
        }
        return null;
    }

    /**
     * 更新板块走势图起始日期缓存
     * 如果本次加载到了更早的数据，更新缓存
     * @param {string} sectorType - 板块类型
     * @param {string} loadedMinDate - 本次加载到的最早日期
     */
    function updateTrendStartDateCache(sectorType, loadedMinDate) {
        const cacheKey = `trend_start_date_${sectorType}`;
        let shouldUpdate = true;
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            try {
                const obj = JSON.parse(cached);
                if (obj.value && obj.value <= loadedMinDate) {
                    shouldUpdate = false;
                }
            } catch (e) { /* 忽略 */ }
        }
        if (shouldUpdate) {
            localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), value: loadedMinDate }));
        }
    }

    /**
     * 获取分时图趋势筛选选项
     * @returns {{trendFilter: string, trendMinutes: number}}
     */
    function getIntradayTrendOptions() {
        const trendFilter = document.getElementById('intradayTrendFilter').value || 'all';
        let trendMinutes = parseInt(document.getElementById('intradayTrendMinutes').value, 10);
        if (isNaN(trendMinutes) || trendMinutes < 1) trendMinutes = 10;
        if (trendMinutes > 240) trendMinutes = 240;
        return { trendFilter, trendMinutes };
    }

    /**
     * 走势图：加载多日板块数据并渲染组合图（柱状+折线）
     * 从intraday JSON提取每日汇总数据，缓存到localStorage（TTL 6小时）
     * 支持多板块叠加对比（最多5个），通过trendSelector选择
     * 默认开始日期：优先使用已缓存数据中最早日期，未缓存时回退到最近30天
     * @param {HTMLElement} chartDom - 图表容器DOM
     * @param {string} sectorType - 板块类型
     */
    async function loadTrendData(chartDom, sectorType) {
        // 走势图选择器中没有板块时，默认添加已选板块中第一个
        if (trendSelectedSectors.length === 0) {
            const selectedNames = getSelectedSectorNames();
            if (selectedNames && selectedNames.length > 0) {
                trendSelectedSectors = [selectedNames[0]];
            } else {
                const merged = getMergedSectorList();
                if (merged.preset && merged.preset.length > 0) {
                    trendSelectedSectors = [merged.preset[0]];
                }
            }
            renderTrendTags();
        }

        if (trendSelectedSectors.length === 0) {
            chartDom.innerHTML = '<div style="text-align:center;padding:100px;color:#8b949e;">' +
                '<h2>请选择板块</h2><p>在上方搜索框输入板块名称添加对比板块</p></div>';
            return;
        }

        // 读取日期范围
        // 默认日期区间：最近一个月（30天）
        let startDate = document.getElementById('startDate').value;
        let endDate = document.getElementById('endDate').value;
        const today = new Date().toISOString().slice(0, 10);
        if (!endDate) endDate = today;
        if (!startDate) {
            const d = new Date(endDate);
            d.setDate(d.getDate() - 29);
            startDate = d.toISOString().slice(0, 10);
            console.log(`走势图默认开始日期（最近一个月）: ${startDate}`);
            document.getElementById('startDate').value = startDate;
            document.getElementById('endDate').value = endDate;
        }
        if (startDate > endDate) {
            throw new Error('开始日期不能晚于结束日期');
        }

        // 限制最大展示30天：若默认缓存起始日期距离结束日期超过30天，则截取最近30天
        const maxStart = new Date(endDate);
        maxStart.setDate(maxStart.getDate() - 29);
        const maxStartStr = maxStart.toISOString().slice(0, 10);
        if (startDate < maxStartStr) {
            startDate = maxStartStr;
            document.getElementById('startDate').value = startDate;
            console.log(`走势图起始日期超过30天上限，截断为: ${startDate}`);
        }

        // 生成日期列表
        const dates = [];
        let current = new Date(startDate);
        const end = new Date(endDate);
        while (current <= end) {
            dates.push(current.toISOString().slice(0, 10));
            current.setDate(current.getDate() + 1);
        }

        if (dates.length > 30) {
            throw new Error('走势图最多展示30天数据，请缩小日期范围');
        }

        // 串行加载每日汇总数据（带随机间隔，避免请求过快）
        const dailySummaries = []; // [{date, sectors: {name: {net_inflow, change_pct, turnover}}}]
        for (let i = 0; i < dates.length; i++) {
            const date = dates[i];
            try {
                const summary = await loadDailySummary(sectorType, date);
                if (summary) {
                    dailySummaries.push({ date, sectors: summary });
                }
            } catch (err) {
                console.warn(`加载${date}汇总数据失败:`, err.message);
            }
            // 请求间加随机100-500ms间隔
            if (i < dates.length - 1) {
                await new Promise(r => setTimeout(r, 100 + Math.random() * 400));
            }
        }

        if (dailySummaries.length === 0) {
            chartDom.innerHTML = '<div style="text-align:center;padding:100px;color:#8b949e;">' +
                '<h2>暂无走势数据</h2><p>所选日期范围内无已采集的分时数据</p>' +
                '<p style="font-size:12px;margin-top:10px;">历史数据由每日收盘后自动采集</p></div>';
            return;
        }

        // 更新走势图起始日期缓存（如果本次加载到了更早的数据）
        const loadedMinDate = dailySummaries[0].date;
        updateTrendStartDateCache(sectorType, loadedMinDate);

        // 渲染走势图
        chartDom.style.height = '600px';
        currentChart = ChartRender.renderTrendChart(chartDom, {
            dates: dailySummaries.map(d => d.date),
            sectors: trendSelectedSectors,
            dailyData: dailySummaries,
            sectorType: sectorType
        });

        document.getElementById('updateTime').textContent =
            `板块走势 | ${dailySummaries.length}天数据 | ${startDate} ~ ${endDate}`;
    }

    /**
     * 加载某日板块汇总数据（从intraday JSON提取，localStorage缓存）
     * 缓存TTL 6小时，避免重复请求JSON文件
     * @param {string} sectorType - 板块类型
     * @param {string} date - 日期 YYYY-MM-DD
     * @returns {Promise<Object|null>} {板块名: {net_inflow, change_pct, turnover}} 或null
     */
    async function loadDailySummary(sectorType, date) {
        // 优先读缓存
        const cacheKey = `daily_summary_${sectorType}_${date}`;
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            try {
                const obj = JSON.parse(cached);
                if (Date.now() - obj.ts < 6 * 3600 * 1000) {
                    return obj.data;
                }
            } catch (e) { /* 缓存损坏，忽略 */ }
        }

        // 缓存未命中：fetch intraday JSON
        // "全部"模式分别获取行业和概念后合并
        if (sectorType === 'all') {
            const [ind, con] = await Promise.all([
                loadDailySummary('industry', date).catch(() => null),
                loadDailySummary('concept', date).catch(() => null)
            ]);
            if (!ind && !con) return null;
            return { ...(ind || {}), ...(con || {}) };
        }

        const filename = `intraday_${sectorType}_${date}.json`;
        const data = await fetchJSON(CONFIG.dataPath + filename);
        const summary = {};
        (data.sectors || []).forEach(s => {
            summary[s.name] = {
                net_inflow: s.final_value || 0,
                change_pct: s.change_pct || 0,
                turnover: s.turnover_yi || 0
            };
        });

        // 缓存到localStorage
        try {
            localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: summary }));
        } catch (e) { /* localStorage满，忽略 */ }
        return summary;
    }

    /**
     * 渲染走势图已选板块标签
     */
    function renderTrendTags() {
        const container = document.getElementById('trendSelectedTags');
        const colors = ['#58a6ff', '#f85149', '#3fb950', '#d29922', '#bc8cff'];
        if (trendSelectedSectors.length === 0) {
            container.innerHTML = '<span class="trend-empty-hint">未选择板块，请在上方搜索添加</span>';
            return;
        }
        container.innerHTML = trendSelectedSectors.map((name, i) => {
            const color = colors[i % colors.length];
            return `<span class="trend-tag"><span class="tag-color" style="background:${color}"></span>${name}<span class="tag-remove" data-name="${name}">✕</span></span>`;
        }).join('');
        // 绑定移除事件
        container.querySelectorAll('.tag-remove').forEach(el => {
            el.addEventListener('click', function() {
                const name = this.getAttribute('data-name');
                trendSelectedSectors = trendSelectedSectors.filter(s => s !== name);
                renderTrendTags();
                loadData();
            });
        });
    }

    /**
     * 走势图板块搜索：过滤板块列表并显示搜索结果
     */
    function handleTrendSearch() {
        const keyword = this.value.trim();
        const resultsEl = document.getElementById('trendSearchResults');
        if (!keyword) {
            resultsEl.style.display = 'none';
            return;
        }
        const merged = getMergedSectorList();
        const allSectors = merged.all || [];
        const matches = allSectors.filter(name =>
            name.toLowerCase().includes(keyword.toLowerCase()) &&
            !trendSelectedSectors.includes(name)
        ).slice(0, 20);

        if (matches.length === 0) {
            resultsEl.innerHTML = '<div class="trend-search-item" style="color:#6e7681;cursor:default;">无匹配板块</div>';
        } else {
            resultsEl.innerHTML = matches.map(name =>
                `<div class="trend-search-item" data-name="${name}">${name}</div>`
            ).join('');
            resultsEl.querySelectorAll('.trend-search-item').forEach(el => {
                el.addEventListener('click', function() {
                    const name = this.getAttribute('data-name');
                    if (trendSelectedSectors.length >= 5) {
                        alert('最多对比5个板块，请先移除部分板块');
                        return;
                    }
                    trendSelectedSectors.push(name);
                    document.getElementById('trendSectorSearch').value = '';
                    resultsEl.style.display = 'none';
                    renderTrendTags();
                    loadData();
                });
            });
        }
        resultsEl.style.display = 'block';
    }

    /**
     * 合并行业和概念板块数据（用于"全部"模式）
     * 同名板块：行业板块名称加"_行"后缀
     * @param {Object} industryData - 行业板块数据
     * @param {Object} conceptData - 概念板块数据
     * @param {string} mergeField - 合并的板块数组字段名（sectors）
     * @returns {Object} 合并后的数据
     */
    function mergeIndustryConceptData(industryData, conceptData) {
        if (!industryData && !conceptData) return null;
        if (!industryData) return conceptData;
        if (!conceptData) return industryData;

        // 收集概念板块名称集合，用于判断同名
        const conceptNames = new Set((conceptData.sectors || []).map(s => s.name));

        // 行业板块中与概念同名的加"_行"后缀
        const industrySectors = (industryData.sectors || []).map(s => ({
            ...s,
            name: conceptNames.has(s.name) ? s.name + '_行' : s.name
        }));

        // 合并时间轴（分时图数据需要对齐）
        let mergedTimes = conceptData.times || [];
        const industryTimes = industryData.times || [];
        if (mergedTimes.length === 0 && industryTimes.length > 0) {
            mergedTimes = industryTimes;
        } else if (industryTimes.length > 0) {
            // 合并两个时间轴，取并集并排序
            const timeSet = new Set([...mergedTimes, ...industryTimes]);
            mergedTimes = [...timeSet].sort();
            // 对齐行业板块数据到合并后的时间轴
            industrySectors.forEach(sector => {
                const indTimeMap = {};
                (industryData.times || []).forEach((t, i) => {
                    indTimeMap[t] = sector.data[i];
                });
                sector.data = mergedTimes.map(t => indTimeMap[t] !== undefined ? indTimeMap[t] : null);
            });
            // 对齐概念板块数据到合并后的时间轴
            (conceptData.sectors || []).forEach((sector, idx) => {
                const conTimeMap = {};
                (conceptData.times || []).forEach((t, i) => {
                    conTimeMap[t] = sector.data[i];
                });
                sector.data = mergedTimes.map(t => conTimeMap[t] !== undefined ? conTimeMap[t] : null);
            });
        }

        const merged = {
            ...conceptData,
            times: mergedTimes,
            sectors: [...industrySectors, ...(conceptData.sectors || [])],
            sector_type: '全部板块',
            update_time: industryData.update_time || conceptData.update_time
        };
        return merged;
    }

    /**
     * 根据板块配置过滤数据
     * topN="已选择板块"时只保留已选板块；topN为数字时截取前N个
     */
    function filterDataBySectors(data) {
        const topN = getTopNValue();
        const filtered = { ...data };

        if (topN === -1) {
            // 已选择板块模式
            const selected = getSelectedSectorNames();
            if (selected && selected.length > 0) {
                filtered.sectors = data.sectors.filter(s => selected.includes(s.name));
            }
        } else if (topN > 0) {
            // 前N个模式
            filtered.sectors = data.sectors.slice(0, topN);
        }
        // topN===0 为全部，不过滤

        return filtered;
    }

    /**
     * 加载分时折线图数据
     * 今天：优先东方财富API（实时分钟级），fallback本地JSON
     * 历史日期：仅本地JSON（由GitHub Actions收盘后采集保存）
     */
    async function loadIntradayData(chartDom, sectorType) {
        // "全部"模式：分别获取行业和概念数据后合并
        if (sectorType === 'all') {
            const [industryData, conceptData] = await Promise.all([
                loadIntradayDataSingle(chartDom, 'industry'),
                loadIntradayDataSingle(chartDom, 'concept')
            ]);
            const data = mergeIndustryConceptData(industryData, conceptData);
            if (!data) {
                const selectedDate = document.getElementById('intradayDate').value || new Date().toISOString().slice(0, 10);
                const today = new Date().toISOString().slice(0, 10);
                const hint = selectedDate === today
                    ? '东方财富API和本地数据均不可用'
                    : `${selectedDate} 无本地分时数据（仅保留近期数据）`;
                chartDom.innerHTML = '<div style="text-align:center;padding:100px;color:#8b949e;">' +
                    '<h2>暂无分时数据</h2>' +
                    `<p>${hint}</p>` +
                    '<p style="font-size:12px;margin-top:10px;">历史分时数据由每日收盘后自动采集</p></div>';
                return;
            }
            const filteredData = filterDataBySectors(data);
            adjustChartHeight(chartDom, filteredData, 'intraday');
            currentChart = ChartRender.renderIntradayChart(chartDom, filteredData, getIntradayTrendOptions());
            const timeStr = data.update_time || '';
            const pointCount = data.times ? data.times.length : 0;
            document.getElementById('updateTime').textContent =
                `分时图 | ${data.date || ''} | ${pointCount}个采样点 | ${timeStr}`;
            updateIntradaySummary(data);
            return;
        }
        await loadIntradayDataSingle(chartDom, sectorType);
    }

    /**
     * 加载单个板块类型的分时数据
     * 数据优先级：前端缓存(localStorage) → dataPath JSON → 东方财富API
     * dataPath 由 config.js 根据访问域名动态决定：
     *   - 本地服务（localhost/局域网IP）：指向 GitHub Pages 在线缓存（本地 web/data/ 可能不全或旧）
     *   - GitHub Pages 部署：指向相对路径 ./data/（即自身仓库 data/ 目录）
     * 今日数据：dataPath JSON 不可用时 fallback 到 API；API 成功后缓存到 localStorage
     * 历史数据：仅从 dataPath JSON 获取（历史数据由定时任务采集，无 API fallback）
     * @returns {Promise<Object|null>} 分时数据对象，失败返回null
     */
    async function loadIntradayDataSingle(chartDom, sectorType) {
        let data = null;
        const selectedDate = document.getElementById('intradayDate').value || getTodayStr();
        const todayFlag = isToday(selectedDate);

        // 今天的数据：优先尝试前端缓存（未过期），命中则直接使用
        if (todayFlag) {
            const cached = loadIntradayCache(sectorType, selectedDate);
            if (cached) {
                data = cached;
                console.log(`分时图数据来源(${sectorType}): 前端缓存 (${selectedDate})`);
            }
        }

        // 缓存未命中：尝试 dataPath JSON（今日或历史日期）
        // dataPath 在本地服务时指向 GitHub Pages 在线缓存，避免依赖本地可能不全的数据
        if (!data) {
            try {
                const filename = `intraday_${sectorType}_${selectedDate}.json`;
                data = await fetchJSON(CONFIG.dataPath + filename);
                console.log(`分时图数据来源(${sectorType}): dataPath JSON (${selectedDate}) ${CONFIG.dataPath}`);
            } catch (err) {
                if (!todayFlag) {
                    // 历史日期 dataPath JSON 必存在，失败直接返回
                    console.warn(`dataPath 分时数据加载失败(${sectorType}, ${selectedDate}):`, err.message);
                    return null;
                }
                console.log(`dataPath 无今日分时数据(${sectorType})，回退到东方财富API`);
            }
        }

        // 今日数据API获取（仅当本地JSON不可用时）
        if (!data && todayFlag) {
            try {
                const topN = getTopNValue() === -1 ? 500 : (getTopNValue() || 30);
                const selectedNames = getFilterParam();
                data = await EastMoneyAPI.buildIntradayData(sectorType, topN, selectedNames);
                if (data) {
                    console.log(`分时图数据来源(${sectorType}): 东方财富API`);
                    // API获取成功后缓存到localStorage，供后续刷新使用
                    saveIntradayCache(sectorType, selectedDate, data);
                }
            } catch (err) {
                console.warn(`东方财富API获取${sectorType}分时数据失败:`, err);
                return null;
            }
        }

        // 单类型模式：直接渲染
        if (getTypeKey() !== 'all') {
            const filteredData = filterDataBySectors(data);
            adjustChartHeight(chartDom, filteredData, 'intraday');
            currentChart = ChartRender.renderIntradayChart(chartDom, filteredData, getIntradayTrendOptions());
            const timeStr = data.update_time || '';
            const pointCount = data.times ? data.times.length : 0;
            const sourceTag = data.source === 'eastmoney' ? ' [东方财富API]' : ' [本地数据]';
            document.getElementById('updateTime').textContent =
                `分时图 | ${data.date || ''} | ${pointCount}个采样点 | ${timeStr}${sourceTag}`;
            updateIntradaySummary(data);
        }
        return data;
    }

    /**
     * 加载实时排名数据（柱状图/热力图/表格）
     * 今日：优先本地JSON，fallback到东方财富API（仅"今日"指标）
     * 历史日期：从分时数据文件提取最终值作为该日期的排名数据
     * "全部"模式下分别获取行业和概念数据后合并
     */
    async function loadRealtimeData(chartDom, sectorType, indicator, chartType) {
        const selectedDate = document.getElementById('intradayDate').value || new Date().toISOString().slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);
        const isToday = selectedDate === today;
        console.log(`[debug] loadRealtimeData: chartType=${chartType}, sectorType=${sectorType}, indicator=${indicator}, selectedDate=${selectedDate}, isToday=${isToday}`);

        // "全部"模式：分别获取行业和概念数据后合并
        if (sectorType === 'all') {
            const [industryData, conceptData] = await Promise.all([
                loadRealtimeDataSingle('industry', indicator, isToday),
                loadRealtimeDataSingle('concept', indicator, isToday)
            ]);
            console.log(`[debug] 全部模式: industry=${industryData ? '有数据' : 'null'}, concept=${conceptData ? '有数据' : 'null'}`);
            const data = mergeIndustryConceptData(industryData, conceptData);
            if (!data) throw new Error('行业和概念数据均不可用');
            const filteredData = filterDataBySectors(data);
            console.log(`[debug] 全部模式 filteredData sectors[0] turnover_yi=${filteredData?.sectors?.[0]?.turnover_yi}`);
            renderChart(chartDom, filteredData, chartType);
            updateSummary(filteredData);
            return;
        }
        const data = await loadRealtimeDataSingle(sectorType, indicator, isToday);
        if (!data) throw new Error('数据加载失败');
        const filteredData = filterDataBySectors(data);
        console.log(`[debug] loadRealtimeData 返回 filteredData sectors[0] turnover_yi=${filteredData?.sectors?.[0]?.turnover_yi}, chartType=${chartType}`);
        renderChart(chartDom, filteredData, chartType);
        updateSummary(filteredData);
    }

    /**
     * 加载单个板块类型的实时排名数据
     * 数据优先级：dataPath JSON → 东方财富API（仅"今日"指标 fallback）
     * dataPath 由 config.js 根据访问域名动态决定：
     *   - 本地服务：指向 GitHub Pages 在线缓存（本地 web/data/ 可能不全或旧）
     *   - GitHub Pages 部署：指向相对路径 ./data/
     * 历史日期：从分时数据文件提取最终值作为该日期的排名数据
     * "全部"模式下分别获取行业和概念数据后合并
     * @param {string} sectorType - 板块类型
     * @param {string} indicator - 时间指标
     * @param {boolean} isToday - 是否为今天
     * @returns {Promise<Object|null>}
     */
    async function loadRealtimeDataSingle(sectorType, indicator, isToday) {
        let data = null;
        console.log(`[debug] loadRealtimeDataSingle 入口: sectorType=${sectorType}, indicator=${indicator}, isToday=${isToday}, dataPath=${CONFIG.dataPath}`);

        // dataPath JSON 优先：本地服务时读取 GitHub Pages 在线缓存，避免频繁请求东方财富API
        // GitHub Pages 部署时 dataPath 为相对路径，今日数据若未被定时任务更新则 404 fallback 到 API
        try {
            if (isToday) {
                if (indicator === '一周') {
                    // 一周汇总：读取 weekly JSON
                    const filename = `weekly_${sectorType}_${getTodayStr()}.json`;
                    data = await fetchJSON(CONFIG.dataPath + filename);
                    console.log(`[debug] 一周数据来源: ${CONFIG.dataPath + filename}, sectors=${data?.sectors?.length}`);
                } else {
                    // 今日：优先从 intraday JSON 提取（含 turnover_yi 成交额）
                    const todayStr = getTodayStr();
                    const intradayFilename = `intraday_${sectorType}_${todayStr}.json`;
                    console.log(`[debug] 尝试加载intraday: ${CONFIG.dataPath + intradayFilename}`);
                    try {
                        const intradayData = await fetchJSON(CONFIG.dataPath + intradayFilename);
                        console.log(`[debug] intraday加载成功, 有turnover_yi=${intradayData?.sectors?.[0]?.turnover_yi !== undefined}, sector_count=${intradayData?.sectors?.length}`);
                        data = convertIntradayToRealtime(intradayData, todayStr);
                        console.log(`[debug] 转换后sectors[0] turnover_yi=${data?.sectors?.[0]?.turnover_yi}, 数据源: intraday`);
                    } catch (intradayErr) {
                        console.log(`[debug] intraday加载失败: ${intradayErr.message}, 尝试检查localStorage缓存`);
                        // 未在dataPath找到intraday JSON时，尝试从localStorage缓存读取（分时图API数据已缓存）
                        const cached = loadIntradayCache(sectorType, todayStr);
                        if (cached) {
                            data = convertIntradayToRealtime(cached, todayStr);
                            console.log(`[debug] 从缓存转换成功, sectors[0] turnover_yi=${data?.sectors?.[0]?.turnover_yi}, 数据源: 缓存`);
                        } else {
                            // 缓存也没有，fallback到realtime JSON（不含turnover_yi，但可用）
                            console.log(`[debug] 缓存未命中, fallback到realtime JSON`);
                            const filename = `realtime_${sectorType}_${indicator}.json`;
                            data = await fetchJSON(CONFIG.dataPath + filename);
                            console.log(`[debug] realtime加载成功, sectors[0] turnover_yi=${data?.sectors?.[0]?.turnover_yi}, sector_count=${data?.sectors?.length}`);
                        }
                    }
                }
            } else {
                // 历史日期：从分时数据文件提取最终值作为该日期的排名数据
                const selectedDate = document.getElementById('intradayDate').value;
                const filename = `intraday_${sectorType}_${selectedDate}.json`;
                console.log(`[debug] 历史日期加载intraday: ${CONFIG.dataPath + filename}`);
                const intradayData = await fetchJSON(CONFIG.dataPath + filename);
                console.log(`[debug] 历史intraday加载成功, turnover_yi=${intradayData?.sectors?.[0]?.turnover_yi !== undefined}`);
                data = convertIntradayToRealtime(intradayData, selectedDate);
                console.log(`[debug] 转换后sectors[0] turnover_yi=${data?.sectors?.[0]?.turnover_yi}`);
            }
        } catch (err) {
            console.log(`[debug] 外层catch: isToday=${isToday}, indicator=${indicator}, err=${err.message}`);
            if (!isToday || indicator !== '今日') {
                console.warn(`dataPath 数据加载失败(${sectorType}):`, err.message);
                return null;
            }
            console.log(`dataPath 无今日${indicator}数据(${sectorType})，回退到东方财富API`);
        }

        // 今日+今日指标：dataPath JSON 不可用时 fallback 到东方财富API
        if (!data && isToday && indicator === '今日') {
            console.log(`[debug] 尝试东方财富API fallback`);
            try {
                const selectedNames = getFilterParam();
                data = await EastMoneyAPI.buildRealtimeData(sectorType, selectedNames);
                if (data) {
                    console.log(`[debug] 东方财富API成功, sectors[0] turnover_yi=${data?.sectors?.[0]?.turnover_yi}`);
                }
            } catch (err) {
                console.warn(`东方财富API获取${sectorType}实时数据失败:`, err);
                return null;
            }
        }
        console.log(`[debug] loadRealtimeDataSingle返回: data=${data ? '有数据' : 'null'}, sectors=${data?.sectors?.length}, turnover_yi_sample=${data?.sectors?.[0]?.turnover_yi}`);
        return data;
    }

    /**
     * 将分时数据转换为实时排名数据格式
     * 提取每个板块的final_value作为净流入，并构建sectors数组
     * 字段名需与realtime JSON一致：main_net_inflow_yi/change_pct/turnover_yi/main_net_inflow_pct
     * @param {Object} intradayData - 分时数据
     * @param {string} date - 日期
     * @returns {Object} 实时排名格式数据
     */
    function convertIntradayToRealtime(intradayData, date) {
        const sectors = (intradayData.sectors || []).map(s => {
            const finalValue = s.final_value || 0;
            const turnoverYi = s.turnover_yi || 0;
            return {
                name: s.name,
                main_net_inflow_yi: finalValue,
                change_pct: s.change_pct || 0,
                turnover_yi: turnoverYi,
                main_net_inflow_pct: turnoverYi ? (finalValue / turnoverYi * 100) : 0
            };
        });
        return {
            update_time: intradayData.update_time || '',
            date: date,
            indicator: '今日',
            sector_type: intradayData.sector_type || '',
            sectors: sectors,
            source: 'intraday_convert'
        };
    }

    /**
     * 更新分时图汇总信息
     */
    function updateIntradaySummary(data) {
        const sectors = data.sectors || [];
        const inflowSectors = sectors.filter(s => s.final_value > 0);
        const outflowSectors = sectors.filter(s => s.final_value < 0);

        document.getElementById('inflowCount').textContent = inflowSectors.length;
        document.getElementById('outflowCount').textContent = outflowSectors.length;

        if (inflowSectors.length > 0) {
            const maxIn = inflowSectors.reduce((a, b) =>
                a.final_value > b.final_value ? a : b);
            document.getElementById('maxInflow').textContent =
                `${maxIn.name} ${maxIn.final_value.toFixed(2)}亿`;
        } else {
            document.getElementById('maxInflow').textContent = '-';
        }

        if (outflowSectors.length > 0) {
            const maxOut = outflowSectors.reduce((a, b) =>
                a.final_value < b.final_value ? a : b);
            document.getElementById('maxOutflow').textContent =
                `${maxOut.name} ${maxOut.final_value.toFixed(2)}亿`;
        } else {
            document.getElementById('maxOutflow').textContent = '-';
        }
    }

    /**
     * 根据数据量自适应图表容器高度
     * 柱状图：每个板块约28px + 标题和边距
     * 热力图/分时图/走势图：使用默认高度
     */
    function adjustChartHeight(chartDom, data, chartType) {
        const sectorCount = (data.sectors || []).length;
        let height;

        if (chartType === 'bar') {
            // 横向柱状图：每个板块需要约28px高度，加上标题和边距
            height = Math.max(400, sectorCount * 28 + 80);
        } else if (chartType === 'heatmap') {
            // 热力图：根据板块数量计算网格
            const cols = Math.ceil(Math.sqrt(sectorCount));
            const rows = Math.ceil(sectorCount / cols);
            height = Math.max(400, rows * 70 + 80);
        } else if (chartType === 'table') {
            // 表格：每行约32px + 表头40px + 标题30px + 边距
            height = Math.max(400, sectorCount * 32 + 120);
        } else {
            // 分时图/走势图等：默认高度（调高20%）
            height = 720;
        }

        chartDom.style.height = height + 'px';
    }

    /**
     * 渲染图表
     */
    function renderChart(chartDom, data, chartType) {
        // 自适应高度
        adjustChartHeight(chartDom, data, chartType);

        switch (chartType) {
            case 'bar':
                currentChart = ChartRender.renderBarChart(chartDom, data);
                break;
            case 'heatmap':
                currentChart = ChartRender.renderHeatmap(chartDom, data);
                break;
            case 'table':
                currentChart = ChartRender.renderTable(chartDom, data);
                break;
            default:
                currentChart = ChartRender.renderBarChart(chartDom, data);
        }

        // 更新时间
        document.getElementById('updateTime').textContent =
            `数据更新时间: ${data.update_time || '-'}`;
    }

    /**
     * 更新汇总信息
     */
    function updateSummary(data) {
        const sectors = data.sectors || [];
        const inflowSectors = sectors.filter(s => s.main_net_inflow_yi > 0);
        const outflowSectors = sectors.filter(s => s.main_net_inflow_yi < 0);

        document.getElementById('inflowCount').textContent = inflowSectors.length;
        document.getElementById('outflowCount').textContent = outflowSectors.length;

        if (inflowSectors.length > 0) {
            const maxIn = inflowSectors.reduce((a, b) =>
                a.main_net_inflow_yi > b.main_net_inflow_yi ? a : b);
            document.getElementById('maxInflow').textContent =
                `${maxIn.name} ${maxIn.main_net_inflow_yi.toFixed(2)}亿`;
        } else {
            document.getElementById('maxInflow').textContent = '-';
        }

        if (outflowSectors.length > 0) {
            const maxOut = outflowSectors.reduce((a, b) =>
                a.main_net_inflow_yi < b.main_net_inflow_yi ? a : b);
            document.getElementById('maxOutflow').textContent =
                `${maxOut.name} ${maxOut.main_net_inflow_yi.toFixed(2)}亿`;
        } else {
            document.getElementById('maxOutflow').textContent = '-';
        }
    }

    /**
     * 请求JSON数据
     */
    async function fetchJSON(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    }

    // 页面加载完成后初始化
    document.addEventListener('DOMContentLoaded', init);
})();
