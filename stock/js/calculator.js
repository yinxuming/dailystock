/**
 * 异动计算核心算法模块
 *
 * 异动规则（交易所官方规则）：
 * - 100异动：连续10个交易日内日收盘价格涨跌幅偏离值累计达到+100%
 * - 200异动：连续30个交易日内日收盘价格涨跌幅偏离值累计达到+200%
 *
 * 偏离值计算（与同花顺一致的动态窗口算法）：
 * - 偏离值 = 个股区间涨幅 - 对应基准指数区间涨幅
 * - 区间涨幅 = (区间末收盘价 / 区间初收盘价 - 1)
 * - 基准点选取：在规则窗口内，找所有局部最低点，选取使偏离值最大但未触发的那个
 * - 如果固定窗口内偏离值已触发，缩短窗口找最近的局部最低点
 *
 * 基准指数映射：
 * - 沪市主板 → 上证A股指数(1.000002)
 * - 深市主板 → 深证A指(0.399107)
 * - 创业板 → 创业板综合指数(0.399102)
 * - 科创板 → 科创50指数(1.000688)
 *
 * 不同板块涨停幅度：
 * - 主板：10%
 * - 创业板/科创板：20%
 * - 北证：30%
 *
 * 可触发性过滤：
 * - T+0日：触发值 <= 当日涨停幅度 才有可能触发
 * - T+N日：触发值 <= (1+涨停幅度)^(N+1) - 1 才有可能触发
 * - 只有至少一天可触发的股票才展示
 */
const UnusualCalculator = (function () {

    // 异动规则配置
    const RULES = [
        { name: '100异动', windowDays: 10, threshold: 1.0, tagClass: 'tag-badge-100' },
        { name: '200异动', windowDays: 30, threshold: 2.0, tagClass: 'tag-badge-200' }
    ];

    // 板块涨停幅度映射（根据股票代码判断）
    const LIMIT_UP_MAP = {
        '30': 0.20,   // 创业板
        '68': 0.20,   // 科创板
        '8': 0.30,    // 北证
        '4': 0.30,    // 北证（老三板转板）
        'default': 0.10  // 主板
    };

    /**
     * 根据股票代码判断涨停幅度
     * 北证代码段：8/4/92开头（92为北证2024年新增代码段，如920083）
     * @param {string} code - 股票代码
     * @returns {number} 涨停幅度（如0.10表示10%）
     */
    function getLimitUpRate(code) {
        if (!code) return LIMIT_UP_MAP['default'];
        if (code.startsWith('30') || code.startsWith('68')) return LIMIT_UP_MAP['30'];
        if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) return LIMIT_UP_MAP['8'];
        return LIMIT_UP_MAP['default'];
    }

    /**
     * 计算T+N天的最大可能涨幅（连续涨停）
     * @param {number} limitUpRate - 涨停幅度（如0.10）
     * @param {number} days - 天数（T+0=1天，T+1=2天...）
     * @returns {number} 最大可能涨幅百分比
     */
    function getMaxPossibleGain(limitUpRate, days) {
        return ((1 + limitUpRate) ** days - 1) * 100;
    }

    /**
     * 判断触发值在某天是否可触发（是否在单日涨停限制内）
     *
     * 触发值表示"当日收盘需要涨多少"，单日最多涨涨停幅度，
     * 所以无论T+0还是T+N，触发值都必须<=单日涨停幅度才可能触发。
     *
     * @param {number} triggerValue - 触发值（百分比）
     * @param {number} limitUpRate - 涨停幅度
     * @param {number} dayOffset - 天数偏移（0=当日）
     * @returns {boolean}
     */
    function isTriggerAchievable(triggerValue, limitUpRate, dayOffset) {
        if (triggerValue === null || triggerValue === undefined) return false;
        if (triggerValue === 0) return true; // 已触发
        const limitUp = limitUpRate * 100; // 单日涨停幅度百分比
        return triggerValue > 0 && triggerValue <= limitUp; // 必须>0且<=涨停幅度才视为可触发
    }

    /**
     * 在窗口内找所有局部最低点
     * 局部最低点定义：收盘价比前后一天都低（或等于），边界点也算
     *
     * @param {Array} prices - 收盘价数组
     * @returns {Array} 局部最低点的索引数组，按价格从低到高排序
     */
    function findLocalMinima(prices) {
        const minima = [];
        const len = prices.length;

        if (len === 0) return minima;
        if (len === 1) return [0];

        for (let i = 0; i < len; i++) {
            const prev = i > 0 ? prices[i - 1] : Infinity;
            const next = i < len - 1 ? prices[i + 1] : Infinity;
            // 局部最低：比前后都低或相等
            if (prices[i] <= prev && prices[i] <= next) {
                minima.push(i);
            }
        }

        // 按价格从低到高排序（价格最低的优先）
        minima.sort((a, b) => prices[a] - prices[b]);

        return minima;
    }

    /**
     * 计算指定基准点的偏离值
     *
     * @param {Array} stockPrices - 个股窗口期收盘价数组
     * @param {Array} indexPrices - 指数窗口期收盘价数组
     * @param {number} baseIdx - 基准点索引（最低点位置）
     * @param {number} currentPrice - 个股当前收盘价
     * @param {number} currentIndexPrice - 指数当前收盘价
     * @returns {Object} { deviation, stockGain, indexGain, trendDays }
     */
    function calcDeviationAtBase(stockPrices, indexPrices, baseIdx, currentPrice, currentIndexPrice) {
        const basePrice = stockPrices[baseIdx];
        const stockGain = (currentPrice - basePrice) / basePrice;

        let indexGain = 0;
        const hasIndexData = indexPrices && indexPrices.length > 0 && currentIndexPrice > 0;

        if (hasIndexData) {
            const indexBasePrice = (indexPrices.length > baseIdx && indexPrices[baseIdx] > 0)
                ? indexPrices[baseIdx]
                : currentIndexPrice;
            if (indexBasePrice > 0) {
                indexGain = (currentIndexPrice - indexBasePrice) / indexBasePrice;
            }
        }

        const deviation = stockGain - indexGain;

        // 趋势天数：从基准点到当前的交易日数（不含基准点当天，与同花顺一致）
        // 同花顺"X日偏离值"中的X = 趋势天数（不含基准点当天）
        const trendDays = stockPrices.length - 1 - baseIdx;

        return { deviation, stockGain, indexGain, trendDays, basePrice, baseIdx };
    }

    /**
     * 在规则窗口内找最佳基准点（与同花顺一致的算法）
     *
     * 算法逻辑：
     * 1. 找所有局部最低点（考虑窗口外一天的数据）
     * 2. 计算每个局部最低点到窗口末尾的偏离值
     * 3. 排除已触发的（偏离值>=阈值的）
     * 4. 选偏离值最大的未触发基准点
     * 5. 检查选出的基准点在窗口内是否有某天的偏离值 >= 阈值
     * 6. 如果有，从最后一次触发后的最低点重新计算
     *
     * 示例（中巨芯6.16，100异动，10天窗口6.02-6.15）：
     * - 局部最低点：14.13, 15.99, 24.85
     * - 14.13到6.15偏离值87.81%<100%（窗口末尾未触发），但到6.11偏离值114.26%>100%（窗口中间触发）
     * - 14.13曾经触发过，重置到6.12(24.85)
     * - 最终基准点6.12(24.85)，1日偏离值3.62%
     *
     * 示例（中船特气6.12，200异动，30天窗口4.29-6.12）：
     * - 4.29不是局部最低点（4.28更低），5.6(77.25)偏离值290.49%>200%已触发排除
     * - 5.19(126.13)偏离值145.81%<200%未触发，且窗口内从未触发
     * - 最终基准点5.19(126.13)，18日偏离值145.74%
     *
     * @param {Array} stockPrices - 个股窗口期收盘价数组
     * @param {Array} indexPrices - 指数窗口期收盘价数组
     * @param {number} currentPrice - 个股当前收盘价（窗口末尾）
     * @param {number} currentIndexPrice - 指数当前收盘价（窗口末尾）
     * @param {number} threshold - 异动阈值(1.0或2.0)
     * @param {number} [prevStockPrice] - 窗口前一天的个股收盘价（用于判断窗口第一天是否局部最低）
     * @param {number} [prevIndexPrice] - 窗口前一天指数收盘价
     * @returns {Object} 最佳基准点的偏离值计算结果
     */
    function findBestBasePoint(stockPrices, indexPrices, currentPrice, currentIndexPrice, threshold, prevStockPrice, prevIndexPrice, dailyChangePcts, ratioThreshold) {
        if (!stockPrices || stockPrices.length === 0) {
            return { deviation: 0, stockGain: 0, indexGain: 0, trendDays: 0, basePrice: 0, baseIdx: -1 };
        }

        if (stockPrices.length === 1) {
            return calcDeviationAtBase(stockPrices, indexPrices, 0, currentPrice, currentIndexPrice);
        }

        // ratioThreshold默认值：T+0基准点用0.75(需要反映当前趋势), slideTrigger用0.0(不需要比率过滤)
        if (typeof ratioThreshold !== 'number') ratioThreshold = 0.75;

        const n = stockPrices.length;

        // 阶段1：枚举所有候选基准点，计算当前偏离、窗口内最大偏离、是否触发
        const candidates = [];
        // 同时收集一份"不依赖指数价格"的候选，用于指数数据缺失时的回退
        const fallbackCandidates = [];

        for (let bi = 0; bi < n - 1; bi++) {
            const bp = stockPrices[bi];
            const bip = (indexPrices && indexPrices.length > bi && indexPrices[bi] > 0) ? indexPrices[bi] : 0;

            // 始终记录fallback候选（只看股票价格，用于指数数据缺失时的回退）
            let fallbackMaxDev = 0;
            for (let i = bi + 1; i < n; i++) {
                const sg = (stockPrices[i] - bp) / bp;
                if (sg > fallbackMaxDev) fallbackMaxDev = sg;
                if (sg >= threshold) break;
            }
            const fallbackCurrentDev = (currentPrice - bp) / bp;
            fallbackCandidates.push({
                idx: bi,
                price: bp,
                deviation: fallbackCurrentDev,
                maxDev: fallbackMaxDev
            });

            if (bip === 0) continue;

            let triggered = false;
            let maxDev = 0;

            for (let i = bi + 1; i < n; i++) {
                const sg = (stockPrices[i] - bp) / bp;
                const dipIdx = (indexPrices && indexPrices.length > i && indexPrices[i] > 0) ? indexPrices[i] : 0;
                const ig = (dipIdx - bip) / bip;
                const dev = sg - ig;
                if (dev > maxDev) maxDev = dev;
                if (dev >= threshold) {
                    triggered = true;
                    break;
                }
            }

            const currentDev = (currentPrice - bp) / bp - (currentIndexPrice - bip) / bip;

            candidates.push({
                idx: bi,
                price: bp,
                indexPrice: bip,
                deviation: currentDev,
                maxDev: maxDev,
                triggered: triggered
            });
        }

        // 关键修复：如果没有有效候选（指数数据全部缺失），回退到只基于股票价格计算
        if (candidates.length === 0) {
            // 用fallbackCandidates选偏离值最大的（不考虑指数）
            fallbackCandidates.sort((a, b) => b.deviation - a.deviation);
            return calcDeviationAtBase(stockPrices, indexPrices, fallbackCandidates[0].idx, currentPrice, currentIndexPrice);
        }

        // 阶段2：过滤未触发的基准点
        const neverTriggered = candidates.filter(c => !c.triggered);
        if (neverTriggered.length === 0) {
            // 所有基准点都触发过（极端情况），选最接近当前的基准点（偏离值可能为负但相对最大）
            candidates.sort((a, b) => b.deviation - a.deviation);
            return calcDeviationAtBase(stockPrices, indexPrices, candidates[0].idx, currentPrice, currentIndexPrice);
        }

        // 阶段3：比率过滤 - 排除"当前偏离显著小于窗口内最大偏离"的基准点
        // 核心逻辑:
        //   maxDev <= 0: 基准点后价格持续下跌 → 不应选为基准点(当前相对基准点还下跌)
        //   currentDev <= 0: 当前相对基准点还下跌 → 不通过
        //   ratio = currentDev / maxDev >= 0.75: 当前偏离接近历史最大偏离 → 通过
        //   ratio < 0.75: 价格从峰值显著回落 → 过滤
        let validCandidates = neverTriggered.filter(c => {
            if (c.deviation <= 0) return false;
            if (c.maxDev <= 0) return false;
            const ratio = c.deviation / c.maxDev;
            return ratio >= 0.75;
        });

        // 如果比率过滤后无候选，回退到选最大偏离的未触发基准点
        if (validCandidates.length === 0) {
            validCandidates = neverTriggered.filter(c => c.deviation > 0);
            if (validCandidates.length === 0) {
                validCandidates = neverTriggered.slice();
            }
        }

        // 阶段4：选偏离值最大的基准点（增加安全检查）
        if (validCandidates.length === 0) {
            // 极端情况：没有任何有效基准点，选第一个候选
            return calcDeviationAtBase(stockPrices, indexPrices, candidates[0].idx, currentPrice, currentIndexPrice);
        }
        validCandidates.sort((a, b) => b.deviation - a.deviation);
        return calcDeviationAtBase(stockPrices, indexPrices, validCandidates[0].idx, currentPrice, currentIndexPrice);
    }

    /**
     * 计算单条异动规则下，未来各天的触发涨幅限制
     *
     * 核心逻辑（与同花顺一致）：
     * - 使用动态窗口算法找最佳基准点
     * - 偏离值 = 个股区间涨幅 - 指数区间涨幅
     * - 触发条件：偏离值 >= 阈值
     * - 触发所需额外涨幅：x = (1 + threshold + indexGain) / (1 + stockGain) - 1
     *
     * @param {Array} klines - K线数据数组（从旧到新排序）
     * @param {Array} indexKlines - 基准指数K线数据
     * @param {Object} rule - 异动规则 { windowDays, threshold }
     * @param {number} forwardDays - 提前天数
     * @returns {Object} 计算结果
     */
    function calcRuleTriggers(klines, indexKlines, rule, forwardDays) {
        const stockPrices = klines.map(k => k.close);
        const windowSize = rule.windowDays;
        const threshold = rule.threshold;

        // 构建指数K线映射 { date -> { close, changePercent } }
        const indexPriceMap = new Map();
        const indexChangeMap = new Map();
        if (indexKlines && indexKlines.length > 0) {
            indexKlines.forEach(k => {
                indexPriceMap.set(k.date, k.close);
                indexChangeMap.set(k.date, (typeof k.changePercent === 'number' ? k.changePercent : 0));
            });
        }

        // 需要足够的历史数据
        if (stockPrices.length < 2) {
            return {
                triggered: false,
                triggers: new Array(forwardDays).fill(null),
                currentGain: null,
                indexGain: null,
                deviation: null,
                basePrice: null,
                trendDays: 0
            };
        }

        // 取窗口期内的数据（最近windowSize个交易日）
        const actualWindowSize = Math.min(windowSize, stockPrices.length);
        const windowStockPrices = stockPrices.slice(-actualWindowSize);
        const currentPrice = windowStockPrices[windowStockPrices.length - 1];
        const currentDate = klines[klines.length - 1].date;
        const windowKl = klines.slice(-actualWindowSize);
        const windowChangePcts = windowKl.map(k => (typeof k.changePercent === 'number' ? k.changePercent : 0));

        // 获取窗口期对应的指数收盘价
        const windowDates = klines.slice(-actualWindowSize).map(k => k.date);
        const windowIndexPrices = windowDates.map(d => indexPriceMap.get(d) || 0);
        const currentIndexPrice = windowIndexPrices[windowIndexPrices.length - 1];

        // 获取窗口前一天的收盘价（用于判断窗口第一天是否为局部最低点）
        const windowStartIdx = stockPrices.length - actualWindowSize;
        let prevStockPriceVal, prevIndexPriceVal;
        if (windowStartIdx > 0) {
            prevStockPriceVal = stockPrices[windowStartIdx - 1];
            const prevDate = klines[windowStartIdx - 1].date;
            prevIndexPriceVal = indexPriceMap.get(prevDate) || 0;
        }

        // 使用动态窗口算法找最佳基准点（传递dailyChangePcts用于大跌日判断）
        const bestBase = findBestBasePoint(windowStockPrices, windowIndexPrices, currentPrice, currentIndexPrice, threshold, prevStockPriceVal, prevIndexPriceVal, windowChangePcts);

        const triggered = bestBase.deviation >= threshold;

        // 计算T+0触发值（额外涨幅）
        let trigger0 = null;
        if (triggered) {
            trigger0 = 0;
        } else if (bestBase.deviation > 0) {
            const triggerX = (1 + threshold + bestBase.indexGain) / (1 + bestBase.stockGain) - 1;
            trigger0 = Math.max(0, triggerX * 100);
        }

        // 计算T+1到T+(forwardDays-1)的触发值（T+0直接复用基准点方式）
        const triggers = [trigger0];
        for (let dayOffset = 1; dayOffset < forwardDays; dayOffset++) {
            const triggerValue = calcDayTriggerDirect(
                threshold, dayOffset, bestBase
            );
            triggers.push(triggerValue);
        }

        // 计算T+1滑动窗口后的触发值（仅当T+0不可触发时使用）
        // 关键改进：传递当前日的指数涨跌幅用于模拟T+1日的指数价
        const currentIndexChange = indexChangeMap.get(currentDate) || 0;
        let slideTrigger1 = null;
        if (forwardDays > 1) {
            slideTrigger1 = calcDayTriggerSlide(
                klines, indexPriceMap, windowSize, threshold, 1, currentIndexChange
            );
        }

        return {
            triggered,
            triggers,
            rawTrigger0: trigger0,
            slideTrigger1,
            currentGain: bestBase.deviation,
            stockGain: bestBase.stockGain,
            indexGain: bestBase.indexGain,
            deviation: bestBase.deviation,
            basePrice: bestBase.basePrice,
            trendDays: bestBase.trendDays
        };
    }

    /**
     * 计算未来第N天的异动触发涨幅限制（直接复用T+0基准点）
     *
     * 当T+0可触发时（trigger0 <= 涨停幅度），T+1及以后的值直接复用T+0基准点计算
     * 此时滑动窗口不会改变基准点（因为T+0基准点已包含在滑动后的窗口中）
     *
     * @param {number} threshold - 异动阈值
     * @param {number} dayOffset - 未来第几天(1=T+1, 2=T+2...)
     * @param {Object} baseResult - T+0的基准点计算结果
     * @returns {number|null} 触发所需额外涨幅百分比
     */
    function calcDayTriggerDirect(threshold, dayOffset, baseResult) {
        if (baseResult.deviation >= threshold) return 0;
        const triggerX = (1 + threshold + baseResult.indexGain) / (1 + baseResult.stockGain) - 1;
        return Math.max(0, triggerX * 100);
    }

    /**
     * 计算未来第N天的异动触发涨幅限制（滑动窗口重新计算基准点）
     *
     * 当T+0不可触发时（trigger0 > 涨停幅度），需要考虑滑动窗口效应，重新计算基准点
     * 当窗口滑动时，最早的数据点被移出窗口，可能导致基准点变化
     *
     * 示例（中巨芯6.16，100异动，10天窗口6.02-6.15）：
     * - T+0基准点6.12(24.85)，偏离值3.62%，触发值88.64%（>20%涨停，不可触发）
     * - T+1窗口滑动到6.03-6.16，6.02(14.13)被移出
     * - T+1基准点变为6.05(15.99)，偏离值64.19%，触发值21.19%
     *
     * @param {Array} klines - 全部K线数据
     * @param {Map} indexPriceMap - 指数日期->收盘价映射
     * @param {number} windowSize - 窗口天数
     * @param {number} threshold - 异动阈值
     * @param {number} dayOffset - 未来第几天(1=T+1, 2=T+2...)
     * @returns {number|null} 触发所需额外涨幅百分比
     */
    function calcDayTriggerSlide(klines, indexPriceMap, windowSize, threshold, dayOffset, currentIndexChange) {
        const stockPrices = klines.map(k => k.close);
        const len = stockPrices.length;
        if (len < windowSize) return null;

        const currentPrice = stockPrices[len - 1];
        const currentDate = klines[len - 1].date;
        const currentIndexPrice = indexPriceMap.get(currentDate) || 0;

        const slideCount = Math.min(dayOffset, windowSize);
        const newWindowStart = len - windowSize + slideCount;
        if (newWindowStart < 0) return null;

        // 滑动后的窗口
        const remainingStockPrices = stockPrices.slice(newWindowStart);
        const futureStockPrices = new Array(dayOffset).fill(currentPrice);
        const slidStockWindow = [...remainingStockPrices, ...futureStockPrices].slice(-windowSize);

        const remainingKl = klines.slice(newWindowStart);
        const remainingDates = remainingKl.map(k => k.date);
        const futureDatePlaceholder = '__future__';
        const slidDates = [...remainingDates, ...new Array(dayOffset).fill(futureDatePlaceholder)].slice(-windowSize);

        // 构建滑动窗口内的dailyChangePcts
        const remainingChangePcts = remainingKl.map(k => (typeof k.changePercent === 'number' ? k.changePercent : 0));
        const slidChangePcts = [...remainingChangePcts, ...new Array(dayOffset).fill(0)].slice(-windowSize);

        // 关键改进：模拟T+1日的指数价 = 当前指数价 * (1 + 当前日指数涨跌幅)
        // 如果currentIndexChange未提供，则复用当前指数价（退化为旧逻辑）
        const idxChange = (typeof currentIndexChange === 'number') ? currentIndexChange : 0;
        const simulatedIndexPrice = currentIndexPrice * (1 + idxChange / 100);

        const slidIndexPrices = slidDates.map(d => {
            if (d === futureDatePlaceholder) return simulatedIndexPrice;
            return indexPriceMap.get(d) || 0;
        });
        const slidCurrentIndexPrice = slidIndexPrices[slidIndexPrices.length - 1];

        // 获取滑动窗口前一天的收盘价（用于判断新窗口第一天是否局部最低）
        let prevStockPriceVal, prevIndexPriceVal;
        if (newWindowStart > 0) {
            prevStockPriceVal = stockPrices[newWindowStart - 1];
            const prevDate = klines[newWindowStart - 1].date;
            prevIndexPriceVal = indexPriceMap.get(prevDate) || 0;
        }

        // 使用动态窗口算法找最佳基准点（传递dailyChangePcts）
        // 滑动窗口计算触发值时不使用比率过滤（ratioThreshold=0.0）
        // 原因：slideTrigger是预测未来触发值，考虑所有可能的基准点
        // 而比率过滤用于T+0基准点(显示当前趋势)，两者逻辑不同
        const bestBase = findBestBasePoint(
            slidStockWindow, slidIndexPrices, currentPrice, slidCurrentIndexPrice, threshold,
            prevStockPriceVal, prevIndexPriceVal, slidChangePcts, 0.0
        );

        if (bestBase.deviation >= threshold) return 0;

        const triggerX = (1 + threshold + bestBase.indexGain) / (1 + bestBase.stockGain) - 1;
        return Math.max(0, triggerX * 100);
    }

    /**
     * 计算单只股票的完整异动分析结果
     * 同时计算100异动和200异动
     *
     * @param {Object} stock - 股票基本信息 { code, name, changePercent, secid, gain5d }
     * @param {Array} klines - K线数据
     * @param {Array} indexKlines - 基准指数K线数据
     * @param {number} forwardDays - 提前天数
     * @param {number} tradeDayOffset - 交易日偏移量（收盘后=1，交易时间=0）
     * @returns {Object} 异动分析结果
     */
    function analyzeStock(stock, klines, indexKlines, forwardDays, tradeDayOffset) {
        forwardDays = forwardDays || 5;
        tradeDayOffset = tradeDayOffset || 0;
        const allRuleResults = [];

        for (const rule of RULES) {
            const calcResult = calcRuleTriggers(klines, indexKlines, rule, forwardDays);
            allRuleResults.push({
                ruleName: rule.name,
                tagClass: rule.tagClass,
                windowDays: rule.windowDays,
                threshold: rule.threshold,
                ...calcResult
            });
        }

        // 获取涨停幅度
        const limitUpRate = getLimitUpRate(stock.code);

        // 将triggers从"额外涨幅"转换为"当日总涨幅"
        // 同花顺格式："收盘涨幅达到 X% 将触发"
        //
        // 转换规则（与同花顺一致）：
        // - T+0：当日总涨幅 = (1 + changePercent) * (1 + 额外涨幅) - 1
        // - T+1及以后：当日总涨幅 = 额外涨幅（新的一天从0%开始）
        //
        // - 显示逻辑：
        //   如果T+0当日总涨幅 <= 涨停幅度（可触发），显示T+0当日总涨幅
        //   如果T+0当日总涨幅 > 涨停幅度（不可触发），显示T+1当日总涨幅 = slideTrigger1
        //
        // 示例：
        //   津膜科技6.12：当日4.28%，额外5.55%，复合10.07%<=20%（创业板），T+0可触发→显示10.07%
        //   宿迁联盛6.12：当日10.03%，额外8.68%，复合19.58%>10%（主板），T+0不可触发→显示8.68%（T+1值）
        //   中巨芯6.16：T+0基准点6.12(24.85)，偏离值3.62%，触发值88.64%>20%不可触发
        //                 T+1滑动窗口到6.03-6.16，基准点变为6.05(15.99)，偏离值64.19%，触发值21.19%
        const dailyGainRate = (stock.changePercent || 0) / 100;
        for (const ruleResult of allRuleResults) {
            const slideTrigger1 = ruleResult.slideTrigger1;

            for (let day = 0; day < ruleResult.triggers.length; day++) {
                if (ruleResult.triggers[day] !== null && ruleResult.triggers[day] > 0) {
                    const additionalGainRate = ruleResult.triggers[day] / 100;
                    let totalDailyGain;
                    if (day === 0) {
                        totalDailyGain = ((1 + dailyGainRate) * (1 + additionalGainRate) - 1) * 100;
                    } else {
                        totalDailyGain = ruleResult.triggers[day];
                    }
                    ruleResult.triggers[day] = totalDailyGain;
                }
            }

            // 根据T+0是否可触发，决定T+1显示值
            // T+0可触发：T+1 = T+0当日总涨幅（滑动窗口不会改变基准点，T+1与T+0一致）
            // T+0不可触发：T+1 = slideTrigger1（滑动窗口后重新计算基准点，得到的T+1额外涨幅）
            const trigger0 = ruleResult.triggers[0];
            if (ruleResult.triggers.length > 1 && slideTrigger1 !== null && slideTrigger1 !== undefined) {
                if (trigger0 !== null && trigger0 !== undefined && isTriggerAchievable(trigger0, limitUpRate, 0)) {
                    ruleResult.triggers[1] = trigger0;
                } else {
                    ruleResult.triggers[1] = slideTrigger1;
                }
            }
        }

        // 同花顺6.12列触发值调整（与标准值一致）：
        // - 如果T+0不可触发（复合涨幅>涨停幅度），显示"额外涨幅"(rawTrigger0)而非"当日总涨幅"
        // - 当T+0可触发时，显示复合后的"当日总涨幅"
        //
        // 示例（标准值对照）：
        //   金安国纪6.15：当日8.30%，额外9.24%，复合18.31%>10%（主板）→ 显示9.24%（额外涨幅）
        //   宿迁联盛6.12：当日10.03%，额外8.68%，复合19.58%>10%（主板）→ 显示8.68%（额外涨幅）
        //   津膜科技6.12：当日4.28%，额外5.55%，复合10.07%<=20%（创业板）→ 显示10.07%（当日总涨幅）
        for (const ruleResult of allRuleResults) {
            ruleResult.displayTriggers = [...ruleResult.triggers];
            const trigger0 = ruleResult.triggers[0];
            const rawTrigger0 = ruleResult.rawTrigger0;
            if (trigger0 !== null && trigger0 !== undefined) {
                if (!isTriggerAchievable(trigger0, limitUpRate, 0)) {
                    ruleResult.displayTriggers[0] = rawTrigger0;
                }
            }
        }

        // 找最紧急的规则（优先选有可触发的规则中触发值最小的）
        let dominantRule = null;
        let minAchievableTrigger = Infinity;

        // 先找有可触发的规则
        for (const ruleResult of allRuleResults) {
            for (let day = 0; day < ruleResult.triggers.length; day++) {
                const trigger = ruleResult.triggers[day];
                if (isTriggerAchievable(trigger, limitUpRate, day) && trigger > 0) {
                    if (trigger < minAchievableTrigger) {
                        minAchievableTrigger = trigger;
                        dominantRule = ruleResult;
                    }
                    break; // 每个规则只看最早可触发的天
                }
            }
        }

        // 如果没有可触发的规则，选触发值最小的
        if (!dominantRule) {
            let minTrigger = Infinity;
            for (const ruleResult of allRuleResults) {
                const trigger0 = ruleResult.triggers[0];
                if (trigger0 !== null && trigger0 > 0 && trigger0 < minTrigger) {
                    minTrigger = trigger0;
                    dominantRule = ruleResult;
                }
            }
        }

        if (!dominantRule) {
            dominantRule = allRuleResults[0];
        }

        // 判断是否有可触发的风险（只看T+0和T+1，与同花顺一致）
        let hasAchievableRisk = false;
        const checkDays = Math.min(2, forwardDays);
        for (const ruleResult of allRuleResults) {
            for (let day = 0; day < checkDays; day++) {
                const trigger = ruleResult.triggers[day];
                if (isTriggerAchievable(trigger, limitUpRate, day)) {
                    hasAchievableRisk = true;
                    break;
                }
            }
            if (hasAchievableRisk) break;
        }

        const urgency = dominantRule.triggers[0];
        const latestDate = klines.length > 0 ? klines[klines.length - 1].date : '';

        return {
            code: stock.code,
            name: stock.name,
            secid: stock.secid,
            changePercent: stock.changePercent,
            gain5d: stock.gain5d || null,
            limitUpRate: limitUpRate,
            date: latestDate,
            rules: allRuleResults,
            hasAchievableRisk,
            urgency,
            dominantRule: dominantRule.ruleName
        };
    }

    /**
     * 批量分析股票严重异动
     *
     * @param {Array} stocks - 股票基本信息数组
     * @param {Map} klineMap - secid -> klines 映射
     * @param {Map} indexKlineMap - 指数secid -> klines 映射
     * @param {number} forwardDays - 提前天数
     * @param {boolean} onlyAchievable - 是否仅返回有可触发风险的股票
     * @param {number} tradeDayOffset - 交易日偏移量（收盘后=1，交易时间=0）
     * @returns {Array} 分析结果数组
     */
    function analyzeStocks(stocks, klineMap, indexKlineMap, forwardDays, onlyAchievable, tradeDayOffset) {
        const results = [];

        for (const stock of stocks) {
            const klines = klineMap.get(stock.secid);
            if (!klines || klines.length === 0) continue;

            // 获取对应指数K线
            const indexSecid = getIndexSecid(stock.secid);
            const indexKlines = indexKlineMap.get(indexSecid) || [];

            const result = analyzeStock(stock, klines, indexKlines, forwardDays, tradeDayOffset || 0);

            if (!onlyAchievable || result.hasAchievableRisk) {
                results.push(result);
            }
        }

        // 按紧急程度排序（触发值小的排前面）
        results.sort((a, b) => {
            const aVal = a.urgency === 0 ? Infinity : (a.urgency || Infinity);
            const bVal = b.urgency === 0 ? Infinity : (b.urgency || Infinity);
            return aVal - bVal;
        });

        return results;
    }

    /**
     * 根据股票secid获取对应指数secid
     * 注意：北证（8/4/92开头）与api.js getBenchmarkIndexSecid保持一致（上证A股指数），
     * 否则indexKlineMap的key不匹配会导致北证股票取不到指数K线
     * @param {string} secid - 股票secid（如"0.300334"）
     * @returns {string} 指数secid
     */
    function getIndexSecid(secid) {
        if (!secid) return '1.000002';
        const parts = secid.split('.');
        const market = parts[0];
        const code = parts[1] || '';

        if (code.startsWith('30')) return '0.399102';   // 创业板 → 创业板综合指数
        if (code.startsWith('68')) return '1.000688';   // 科创板 → 科创50指数
        // 北证：8/4/92开头（92为北证2024年新增代码段）→ 上证A股指数（与api.js一致）
        if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) return '1.000002';
        if (market === '0') return '0.399107';          // 深市主板 → 深证A指
        return '1.000002';                              // 沪市主板 → 上证A股指数
    }

    // 导出公共接口
    return {
        RULES,
        getLimitUpRate,
        isTriggerAchievable,
        getMaxPossibleGain,
        analyzeStock,
        analyzeStocks,
        getIndexSecid,
        // 测试用
        findLocalMinima,
        findBestBasePoint,
        calcDeviationAtBase
    };
})();
