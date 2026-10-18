# 集合竞价开发进度TODO

> 最后更新：2026-10-17　状态：**已完成**（需求 1.1 / 1.2.1 / 1.2.2 全部实现）

## 一、需求与完成状态

| # | 需求 | 状态 | 实现位置 |
|---|------|------|----------|
| 1 | 集合竞价分析集成进 dailystock，代码放 `stock_analysis/call_auction/` | ✅ | `call_auction/` |
| 1 | 左侧菜单新增「集合竞价」独立菜单 | ✅ | `index.html`、`js/main.js` |
| 1 | 9:25 后可查看当日集合竞价分析结果 | ✅ | `ca_data.js` 交易日解析 |
| 1.1 | 分析范围可选：昨日涨停 / 全部自选 / 自选分组 | ✅ | 范围 tab（`#caTabs` + `#caGroupTabs`） |
| 1.1 | 默认昨日涨停股票 | ✅ | `scope` 默认 `zt` |
| 1.2 | 结果列表与同花顺一致 | ✅ | `ca_render.js` 22 列 |
| 1.2.1 | 支持按「竞价评级」「异动类型」筛选 | ✅ | 双行筛选条（多选 chips） |
| 1.2.1 | 同花顺基础上增加：流通市值、昨日金额 | ✅ | 第 13、14 列 |
| 1.2.2 | 各表头支持点击排序 | ✅ | 全部 22 列均可排序 |
| 1.3 | 板块竞价强度概览（按细分行业聚合，含家数/平均竞价涨幅/占昨成交） | ✅ | `ca_render.js` `renderSector` + `CARating.sectorTop` |
| 1.3 | 情绪概览新增「昨日炸板率」 | ✅ | `CARating.analyze(rows, baseline)` → `summary.zbRate` |
| 1.3 | 竞价评级列 hover 显示「AI 竞价评级分析」文字结论 | ✅ | `CARating.adviceFor` → 悬停卡 `.ca-tip-advice` |
| 1.3 | 昨日涨停池直接复用每日复盘缓存（免代理、最可靠） | ✅ | `CAData.fetchZTPool` → `FupanData.getDay(base)` |

## 二、代码结构

```
stock_analysis/call_auction/
├── ca_data.js      数据层：日期解析 / 分析范围 / 昨日指标 / 今日竞价采集 / 每日缓存
├── ca_rating.js    规则引擎：衍生指标 / 竞价评级 / 异动类型 / 0-100 评分（纯函数，可单测）
├── ca_render.js    渲染层：情绪概览 / 筛选条 / 结果表 / 评级明细悬停卡
├── ca.js           控制器：懒加载 / 范围切换 / 刷新 / 排序 / 筛选 / 悬停
├── ca.css          页面样式（深色，与主应用一致）
└── doc/            参考材料与本文件
```

外部改动：
- `index.html`：新增「集合竞价」页面容器 `#page-callauction`、范围 tab（`#caTabs` / `#caGroupTabs`）、板块强度面板 `#caSector`、样式与脚本引入
- `js/main.js`：`switchTab` 回调 `CA.onTabActivated()`，`validTabs` / `dailystock:navigate` postMessage 白名单均增加 `'callauction'`
- `js/api.js`：导出 `request`（集合竞价复用统一节流/代理切换逻辑）
- `web_shell/index.html`：统一外壳左侧菜单新增「集合竞价」入口（`data-menu="callauction"`）
- `web_shell/js/shell.js`：`STOCK_PAGES` 增加 `'callauction'`，支持同 iframe 内无刷新切 tab
- `js/fupan_data.js`：`getDay` / `getSummary` 本地 `data/fupan/` 404 时回退线上 GitHub Pages 镜像（经代理解决 CORS），
  使本地调试（缓存常滞后到 2026-09-10）也能拿到每日更新的涨停池/复盘，避免集合竞价"没数据"。镜像基址可用 localStorage `fupan_remote_base` 覆盖。
- `fupan/call_auction.py`：集合竞价定时采集器（`python -m fupan.call_auction`），交易日 09:15-09:26 每30s采样腾讯行情快照，
  落盘 `stock/data/call_auction/days/YYYYMMDD.json`（含 9:25 撮合残量 + 竞价期间采样序列），供前端历史回看。
- `.github/workflows/call-auction-data.yml`：定时（北京时间 09:05）采集并推送公开仓库 `stock/data/call_auction/`；
  新增 15:05 收盘补采 cron（`--mode close`，写 `days/*.json` 的 `close` 字段，供 TODO39.2 评分方案回溯）。
- `.github/workflows/sync-ca-watchlist.yml`：提交带 `sync-ca-watchlist` 标签的 GitHub Issue 自动合并自选配置
  `stock_analysis/data/ca_watchlist.json`（与板块同步逻辑一致：协作者加标签审批触发）。
- `js/ca_data.js`：支持指定历史日期（`resolveDates(date)`），数据读取链 = 后端缓存文件（本地→线上镜像）→ localStorage 当日缓存 → 实时接口。
- `js/ca.js` / `index.html`：头部日期选择器（max=今天，带「竞价日期：」标签提升可见性）+ 列设置接入（`TableColSettings.apply`，key=ca_list，afterApply 重算 sticky）；
  新增「同步自选」按钮，一键生成带 `sync-ca-watchlist` 标签的 GitHub Issue 同步自选到定时任务预设（对齐 sector_analysis 的「同步预设」UX）。
- `js/table_cols.js`：列设置组件扩展 `order` 列顺序（面板 ↑/↓ 按钮），所有已接入表格自动获得。
- `call_auction/ca_scheme.js`（TODO39.2 新增）：评分方案引擎（与 FupanScoring 同构、解耦）。命中口径=竞价买入→次日收盘收益
  （一字板封单额/竞价额≥5 判买不到记 null）；`optimizeScheme` 多尺度大步长爬山调优；`buildSchemes` 产出五方案。
- `call_auction/ca_rating.js`：评分参数化 `computeRow(r, config)` + `DEFAULT_SCORE_CFG/cloneCfg/normalizeCfg`（默认=现行口径，行为不变）。
- `js/ca_render.js`：COLS 新增「竞价评分」列（TODO39.1，评级列后，可排序、按档位着色）；新增 `renderSchemeArea`（TODO39.2 方案区）。
- `js/ca.js` / `index.html`：TODO39.2 方案回溯接线（`loadSchemes/buildBacktestDetail/onSchemeClick/applySchemeToRows` + 结果表下方可折叠方案区）。
- `fupan/call_auction.py`：新增 `--mode close` 收盘补采（`collect_close`），15:05 写 close 字段；`parse_quote` 增加最高/最低价。
- `js/ca_data.js`：`buildBacktestCycles` 读「历史竞价 + 次日收盘」构建回测周期（缺数据跳过）。

线上问题修复（2026-10-18，public 仓库竞价页空白）：
- **根因1（部署漏文件）**：`.github/workflows/deploy-public.yml` 组装站点时只复制 `index.html/css/js`，
  **漏复制 `stock_analysis/call_auction/`**（paths 也未包含），导致公开仓库 `stock/index.html` 引用的
  `call_auction/ca_data.js` 等 5 个文件 404、竞价页 JS 全挂页面空白。已修复：cp 增加 `call_auction` 目录 + paths 增加 `stock_analysis/call_auction/**`。
- **根因2（静态文件误走代理）**：`js/ca_data.js` / `js/fupan_data.js` / `js/fupan_render.js` 的 GitHub Pages
  静态 JSON 回退逻辑改为**多路径同源直连**（`stock/data/...` 带前缀路径 → 本地 `data/...` → 线上镜像绝对地址），
  代理仅作最后兜底。诊断结论（`tmp/test_network.py`，直连 vs 代理对比）：直连 GitHub Pages 200/1.1s；
  **主代理 vercel 在用户网络 WinError 10060 超时 42s 不可达**；备用代理 supabase 200/1.9s。
  GitHub Pages 与页面同源无 CORS，静态文件本就不需要代理（原注释"经代理解决 CORS"为错误假设）。
- 教训：新增前端目录/文件时，必须同步更新 `deploy-public.yml` 的 cp 清单与 paths 触发条件，否则线上 404。

测试：
- `test_case/test_ca_rating.js`：评级引擎（含序列增强 38.4，约 38 项断言）
- `test_case/test_ca_scheme.js`（TODO39.2 新增）：方案引擎（默认评分一致/一字板判定/收益/准确度/调优可复现/五方案/逐周期明细，约 29 项断言）
- `test_case/test_table_cols.js`：列设置组件（含列顺序 TODO37，约 42 项断言）
- `test_case/test_call_auction_data.js`：集合竞价数据层（缓存文件解析 TODO38.3）
- `test_case/test_callauction.html`：Mock 数据集成测试页（离线可看 UI，无需行情接口）

## 三、数据口径

| 字段 | 来源 | 说明 |
|------|------|------|
| 昨日涨停名单 / 连板 / 炸板次数 / 封板时间 / 封单额 | **每日复盘缓存** `data/fupan/days/YYYYMMDD.json` 的 `ztpool` / `zbpool` | 由 `CAData.fetchZTPool` 经 `FupanData.getDay(base)` 读取；本地缓存缺失时依次直连线上 GitHub Pages 镜像（同源多路径，代理仅兜底），仍缺失才回退东财 `getTopicZTPool` 实时拉取 |
| 昨日成交额 / 昨日换手 / 流通市值 | 涨停池字段（自选范围取K线） | `amount` / `hs` / `floatMV` |
| 竞价撮合价 / 竞价量 / 竞价金额 | 东财 `push2his stock/trends2`（首根 09:30 = 9:25 撮合单一价） | 与参考实现 `F:\10_LearnVideo\Investment\ai_daily_stock` 一致；腾讯分时 `0930` 首点作为兜底数据源 |
| 未匹配量 / 未匹配金额 | 腾讯快照买一/卖一（东财 trends2 不提供，故该列仅在腾讯源时有效） | 仅 9:15-9:31 窗口内、或封在涨跌停时有效，否则显示 `--` |
| 换手% / 涨幅 / 金额 / 量比 / 总手 / 现价 / 昨收 | 腾讯快照（东财主源时取撮合价/成交额） | 盘中实时 |

衍生指标：
- 竞价涨幅 = (撮合价 − 昨收) / 昨收
- 竞价额占昨日成交 `rAmt` = 竞价金额 / 昨日成交额
- 竞价量比 = `rAmt × 2.4`（竞价量 ÷ 昨日每分钟均量）
- 涨停/跌停价按板块推断：主板 10%、创业板(30)/科创板(688) 20%、北交所 30%、主板 ST 5%

评级 / 评分规则（`ca_rating.js`）：
- **异动类型**：大单封涨停、涨停试盘、高开抢筹、竞价抢筹、大笔买入、高开砸盘、急速下跌、竞价砸盘、大笔卖出、缩量高开、小幅高开/低开、平开观望、无数据
- **竞价评级**：看多（承接型异动）/ 看空（抛压型异动）/ 混战（方向与量能矛盾：巨量高开、涨停试盘、高位连板低开）/ 观望
- **综合评分（0-100）**：竞价涨幅 25 + 竞价量能 25 + 封板时间 12 + 炸板次数 8 + 连板高度 15 + 封单强度 8 + 昨日换手 7；缺失维度自动归一化
- **硬性淘汰**：竞价低开 / 竞价额不足昨日成交 1% / 昨日炸板≥2 次 / 连板≥5 板 / 涨停价开盘
- **封顶**：高开不足 2% 或竞价额超昨日 28%，最高 66 分
- **档位**：一字涨停开 / 可参与(≥70) / 观察确认(60-69) / 淘汰
- **评分方案化（TODO39.2）**：上述权重/封顶/档位阈值可通过 `computeRow(r, config)` 覆盖；`ca_scheme.js` 用历史
  「竞价 + 次日收盘」回测，爬山调优出昨日/3日/5日最准方案，用户可在结果表下方方案区切换并即时重算评分列

`days/YYYYMMDD.json` 字段（后端采集）：
- `auction` / `live` / `series`：见上方数据口径（9:25 撮合 + 实时快照 + 竞价期间采样序列）
- `close`（TODO39.2 收盘补采，15:05 写入）：`{price, high, low, snapshotTime}`，供评分方案回溯计算
  「竞价买入 → 次日收盘」收益；缺失该字段的日期不参与方案回测

## 四、已知限制

1. **9:15-9:25 逐笔路径无法还原**。同花顺的「急速拉高/涨停试盘」等异动基于 3 秒级虚拟撮合快照，公开接口不提供，
   本项目改为「竞价撮合结果的量价特征归类」，异动说明列写明触发判定的具体数值，因此异动类型与同花顺不会逐条一致。
   依需求确认，仅用 9:25 撮合结果数据做评级与异动分类即可，不追求 3 秒级曲线/异动流水。
2. **竞价评级列悬停**已包含「AI 竞价评级分析」文字结论（规则驱动，非大模型）+ 七维得分条 + 关键指标；
   同花顺原版的 9:15-9:25 价格/量能曲线 + 异动流水因缺少快照源无法复刻，故未实现该曲线图。
3. **未匹配量**：9:31 之后（且未封涨跌停）的实时路径只能显示 `--`（原始残量已不可回溯）；
   但 38.3 新增的后端定时采集在 9:15-9:26 每30s采样腾讯快照、落盘 `stock/data/call_auction/days/YYYYMMDD.json`，
   其中包含 9:25 时点的未匹配残量，历史日期回看可直接取该缓存（不再显示 `--`）。东财 trends2 主源不含买卖盘残量，实时路径该列仅在腾讯兜底下有意义。
4. **评分方案回溯（TODO39.2）依赖数据积累**：昨日/3日/5日最准方案需要「历史竞价缓存 + 次日收盘补采」两者齐备；
   38.3/39.2 采集上线初期样本不足，对应最准方案 tab 不显示，仅「当前/初始」可用，数据积累后自动出现。
   另：一字板「买不到」按封单额/竞价额≥5 判定为经验阈值，未匹配买量缺失时保守视为封死。
5. **历史竞价日期**：38.3 头部新增日期选择器，可查看历史交易日的竞价（后端定时采集缓存优先，含 9:25 残量 + 竞价期间采样序列）；
   未配置历史缓存的日期仍回退实时接口（仅返回最新交易日，对历史日会错位，故自动回看日仍取最近一个已完成竞价日）。
5. 昨日涨停名单依赖「每日复盘」缓存 `data/fupan/days/YYYYMMDD.json`；若该日缓存缺失且实时接口（代理）也不可达，
   页面会报错提示「运行复盘采集」。竞价撮合接口若整体不可达，则名单仍展示、未取到竞价数据的个股标记为「无数据」，不再整体报错。
6. 每只股票 1 次分时请求（昨日涨停约 60-90 只，默认并发 4、每 4 只间隔 120ms，约 20-40 秒），
   结果按自然日缓存在 localStorage，当天重复进入不再请求；「刷新」会清缓存重取。
7. **异动类型与同花顺靠拢（38.4）**：后端采集了竞价期间采样序列后，`ca_rating.js enhanceFromSeries` 可近似还原同花顺「涨停试盘/急速下跌/大单试盘」等分时级异动（基于序列触板回落 / 相邻急挫 / 单点大单）；无序列时保持原撮合结果量价归类。

## 五、验证方式

```bash
# 评级引擎单测（含序列增强 38.4，约 38 项断言）
node test_case/test_ca_rating.js

# 列设置组件单测（含列顺序 TODO37，约 42 项断言）
node test_case/test_table_cols.js

# 集合竞价数据层单测（缓存文件解析 TODO38.3）
node test_case/test_call_auction_data.js

# 集成测试页（Mock 数据，离线可看完整 UI：排序/筛选/悬停/范围切换）
python server.py    # 然后访问 http://localhost:8081/test_case/test_callauction.html
```
