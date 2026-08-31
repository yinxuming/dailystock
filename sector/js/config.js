/**
 * 前端配置
 */
const CONFIG = {
    // 数据文件路径
    // - GitHub Pages 部署：使用相对路径 './data/'（即自身仓库的 data/ 目录）
    // - 本地启动服务测试：使用 GitHub Pages 在线缓存（本地 web/data/ 数据可能不全或旧）
    //   URL 参数 ?localData=1 可强制使用本地数据（用于测试本地刚采集的数据）
    // - GitHub Pages 支持 CORS，本地服务可跨域请求在线 JSON
    dataPath: (function () {
        // URL 参数 ?localData=1 强制使用本地数据
        const params = new URLSearchParams(window.location.search);
        if (params.get('localData') === '1') {
            return './data/';
        }
        const host = window.location.hostname;
        // 本地服务（localhost/127.0.0.1/局域网IP）：从 GitHub Pages 在线缓存获取
        const isLocalHost =
            host === 'localhost' ||
            host === '127.0.0.1' ||
            /^192\.168\./.test(host) ||
            /^10\./.test(host) ||
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host);
        if (isLocalHost) {
            // 统一部署后数据在公开仓库 dailystock 的 sector/data/ 目录
            return 'https://yinxuming.github.io/dailystock/sector/data/';
        }
        // GitHub Pages 部署：使用相对路径（部署于 /sector/ 子目录，对应 ./data/ 即 sector/data/）
        return './data/';
    })(),

    // 东方财富API代理配置
    // 直连 push2.eastmoney.com 在部分网络环境下会被拦截，通过代理中转解决
    // 代理格式: 代理地址/proxy?target=encodeURIComponent(原始URL)
    // 设为 null 则直连东方财富API
    apiProxy: 'https://vercel-proxy-p.vercel.app',

    // 备用代理（主代理失败时自动切换）
    apiProxyBackup: 'https://cdgfbtemospbwxlyyxib.supabase.co/functions/v1/fund-proxy',

    // 数据刷新阈值（毫秒）：页面从不可见到可见时，超过此间隔自动刷新
    refreshThreshold: 5 * 60 * 1000,  // 5分钟

    // 分时图自动刷新间隔（秒）：分时图可见时按此间隔自动刷新，0=不自动刷新
    intradayRefreshInterval: 30,

    // 分时数据前端缓存TTL（秒）：从东方财富API获取的数据缓存此时长，避免频繁请求
    intradayCacheTTL: 60,

    // 默认配置
    defaults: {
        sectorType: 'concept',
        indicator: '今日',
        chartType: 'intraday',
        topN: 30
    },

    // 预设板块同步：源码仓库地址（owner/repo），用于生成 Issue 链接
    // 用户在前端勾选了非预设板块时，可一键生成 Issue 提议新增到定时任务预设板块
    // 权限控制：任何用户可提交 Issue，仅协作者可添加 sync-sectors 标签审批触发同步
    syncSectorsRepo: 'yinxuming/dailystock_full',
    // 颜色配置
    colors: {
        inflow: '#f85149',       // 红色-净流入
        inflowLight: '#ff7b72',
        outflow: '#3fb950',      // 绿色-净流出
        outflowLight: '#7ee787',
        neutral: '#8b949e',
        background: '#0d1117',
        cardBg: '#161b22',
        border: '#30363d',
        text: '#e6edf3',
        textMuted: '#8b949e'
    },
    // ECharts主题色
    echartsTheme: {
        color: ['#f85149', '#3fb950', '#58a6ff', '#d29922', '#bc8cff',
                '#ff7b72', '#7ee787', '#79c0ff', '#e3b341', '#d2a8ff']
    }
};
