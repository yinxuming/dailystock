/**
 * 每日复盘控制器（Fupan）
 *
 * 职责：
 * 1. 四个子tab的状态管理与切换：大盘 / 板块轮动 / 涨跌停 / 评分预测
 * 2. 交易日选择（下拉，可选项来自summary可用日期列表）与数据联动刷新
 * 3. 懒加载：首次进入tab时才拉取数据（主应用main.js在switchTab时回调onTabActivated）
 * 4. 加载/错误状态管理
 *
 * 数据流：datePicker变更 → loadDate(date) → FupanData.getDay(date) → 当前子tab渲染
 * 模块分层：FupanData（数据）→ FupanRenderer（渲染）→ Fupan（控制）
 */
const Fupan = (function () {

    // 子tab标识与渲染函数映射（新增子tab在此扩展，控制器与渲染解耦）
    const SUB_TABS = {
        market: { title: '大盘', render: (el, day, date) => FupanRenderer.renderMarket(el, day, date) },
        sectors: { title: '板块轮动', render: (el, day, date) => FupanRenderer.renderSectors(el, day, date, getDate) },
        zt: { title: '涨跌停', render: (el, day, date) => FupanRenderer.renderZT(el, day, date) },
        score: { title: '评分预测', render: (el, day, date) => FupanRenderer.renderScore(el, day, date) }
    };

    // 子tab记忆持久化key
    const ACTIVE_SUB_KEY = 'fupan_active_sub';

    // 运行状态
    let initialized = false;      // 事件是否已绑定
    let loaded = false;           // 数据是否已加载（懒加载标记）
    let loading = false;          // 加载中（防重入）
    let currentDate = null;       // 当前展示的交易日 YYYY-MM-DD
    let currentSub = 'market';    // 当前子tab

    // DOM引用（init时缓存）
    let datePicker, loadingEl, loadingText, errorEl, errorText;

    // ===== 状态提示 =====

    /**
     * 显示加载状态
     * @param {string} msg 提示文本
     */
    function showLoading(msg) {
        loadingText.textContent = msg || '正在加载复盘数据...';
        loadingEl.style.display = '';
        errorEl.style.display = 'none';
    }

    /** 隐藏加载状态 */
    function hideLoading() {
        loadingEl.style.display = 'none';
    }

    /**
     * 显示错误状态
     * @param {string} msg 错误文本
     */
    function showError(msg) {
        errorText.textContent = msg;
        errorEl.style.display = '';
        hideLoading();
    }

    /** 隐藏错误状态 */
    function hideError() {
        errorEl.style.display = 'none';
    }

    // ===== 数据加载与渲染 =====

    /**
     * 获取指定交易日数据（供渲染层多日回溯复用，含缓存）
     * @param {string} date 日期
     * @returns {Promise<Object>} 单日数据
     */
    function getDate(date) {
        return FupanData.getDay(date);
    }

    /**
     * 加载指定交易日数据并渲染当前子tab
     * 主流程：置加载态 → 取day数据 → 填充日期元信息 → 渲染当前子tab
     * @param {string} date 交易日 YYYY-MM-DD
     * @param {boolean} force 是否强制刷新（跳过缓存）
     */
    async function loadDate(date, force = false) {
        if (loading) return;
        loading = true;
        showLoading('正在加载 ' + date + ' 复盘数据...');
        try {
            const day = await FupanData.getDay(date, force);
            currentDate = date;
            renderSub(currentSub, day);
            updateMeta(day);
            hideLoading();
        } catch (e) {
            console.error('复盘数据加载失败:', e);
            showError('复盘数据加载失败: ' + e.message + '（当日采集可能未完成，可稍后刷新重试）');
        } finally {
            loading = false;
        }
    }

    /**
     * 渲染指定子tab
     * @param {string} sub 子tab标识
     * @param {Object} day 单日数据
     */
    function renderSub(sub, day) {
        const conf = SUB_TABS[sub];
        if (!conf) return;
        // 面板由data属性定位（index.html中无id，与switchSub显隐控制同一属性）
        const panel = document.querySelector(`[data-fp-sub-panel="${sub}"]`);
        if (!panel) return;
        conf.render(panel, day, currentDate);
    }

    /**
     * 更新页面元信息（数据日期 + 生成时间）
     * @param {Object} day 单日数据
     */
    function updateMeta(day) {
        const metaEl = document.getElementById('fpMeta');
        if (metaEl) {
            metaEl.textContent = `数据日期 ${day.date} · 生成于 ${day.generatedAt || '--'}`;
        }
    }

    // ===== 初始化日期选择器 =====

    /**
     * 初始化日期下拉（可选项=summary可用交易日，倒序最新在前）
     * @param {string} [preferred] 优先选中的日期
     */
    async function initDatePicker(preferred) {
        const dates = await FupanData.getAvailableDates();
        if (!dates.length) {
            showError('暂无复盘数据：请等待私有仓库 fupan-data 工作流完成首次采集');
            return;
        }
        // 倒序填充（最新在前）
        datePicker.innerHTML = dates.slice().reverse()
            .map(d => `<option value="${d}">${d.slice(5).replace('-', '/')}（${weekdayLabel(d)}）</option>`)
            .join('');
        datePicker.value = preferred && dates.includes(preferred) ? preferred : dates[dates.length - 1];
    }

    /**
     * 日期对应的中文星期
     * @param {string} dateStr YYYY-MM-DD
     * @returns {string} 如 周一
     */
    function weekdayLabel(dateStr) {
        const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        return names[new Date(dateStr + 'T00:00:00').getDay()];
    }

    // ===== 子tab切换 =====

    /**
     * 切换子tab
     * 主流程：按钮高亮 → 面板显隐 → 若已加载数据则重渲染该tab（面板innerHTML每次重建）
     * @param {string} sub 子tab标识
     */
    function switchSub(sub) {
        if (!SUB_TABS[sub]) return;
        currentSub = sub;
        // 按钮高亮
        document.querySelectorAll('[data-fp-sub]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.fpSub === sub);
        });
        // 面板显隐
        document.querySelectorAll('[data-fp-sub-panel]').forEach(panel => {
            panel.style.display = panel.dataset.fpSubPanel === sub ? '' : 'none';
        });
        // 已有数据时渲染当前tab（首次进入页面时4个面板均空，由loadDate渲染）
        if (currentDate) {
            // 取缓存数据重渲染（loadDate已保证缓存存在，历史日不发网络请求）
            FupanData.getDay(currentDate)
                .then(day => renderSub(sub, day))
                .catch(() => { /* 数据异常时保持空面板 */ });
        }
        // 持久化子tab记忆
        try {
            localStorage.setItem(ACTIVE_SUB_KEY, sub);
        } catch (e) { /* 忽略 */ }
    }

    // ===== 事件绑定与入口 =====

    /**
     * 绑定页面事件（幂等，仅首次执行）
     */
    function bindEvents() {
        if (initialized) return;
        initialized = true;

        // DOM引用缓存
        datePicker = document.getElementById('fpDatePicker');
        loadingEl = document.getElementById('fpLoading');
        loadingText = document.getElementById('fpLoadingText');
        errorEl = document.getElementById('fpError');
        errorText = document.getElementById('fpErrorText');

        // 子tab切换
        document.querySelectorAll('[data-fp-sub]').forEach(btn => {
            btn.addEventListener('click', () => switchSub(btn.dataset.fpSub));
        });

        // 日期切换
        datePicker.addEventListener('change', () => {
            const val = datePicker.value;
            if (val) loadDate(val);
        });

        // 刷新按钮（强制刷新当前日数据）
        document.getElementById('btnFpRefresh').addEventListener('click', () => {
            const target = datePicker.value || currentDate;
            if (target) loadDate(target, true);
        });

        // 重试按钮
        document.getElementById('btnFpRetry').addEventListener('click', () => {
            hideError();
            const target = datePicker.value || currentDate;
            if (target) loadDate(target, true);
        });
    }

    /**
     * tab激活入口（主应用main.js在switchTab('fupan')时回调）
     * 首次激活：绑定事件 → 初始化日期下拉 → 加载最新交易日；重复激活直接返回
     */
    function onTabActivated() {
        bindEvents();
        if (loaded) return;
        loaded = true;

        // 恢复子tab记忆（默认大盘）
        let saved = 'market';
        try {
            saved = localStorage.getItem(ACTIVE_SUB_KEY) || 'market';
        } catch (e) { /* 忽略 */ }
        if (!SUB_TABS[saved]) saved = 'market';
        switchSub(saved);

        // 主流程：初始化日期下拉 → 加载最新交易日
        (async () => {
            try {
                await initDatePicker();
                const latest = await FupanData.getLatestDate();
                loadDate(latest);
            } catch (e) {
                showError('复盘数据初始化失败: ' + e.message);
            }
        })();
    }

    /**
     * 外部URL参数直接指定子tab（?page=fupan&sub=zt）
     * 在onTabActivated之前由main.js调用，激活时生效
     * @param {string} sub 子tab标识
     */
    function presetSub(sub) {
        if (SUB_TABS[sub]) {
            try { localStorage.setItem(ACTIVE_SUB_KEY, sub); } catch (e) { /* 忽略 */ }
        }
    }

    return { onTabActivated, presetSub };
})();
