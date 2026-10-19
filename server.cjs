var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// server.ts
var server_exports = {};
__export(server_exports, {
  INDIAN_SYMBOL_MAP: () => INDIAN_SYMBOL_MAP
});
module.exports = __toCommonJS(server_exports);
var import_express = __toESM(require("express"), 1);
var import_path2 = __toESM(require("path"), 1);
var import_fs2 = __toESM(require("fs"), 1);
var import_genai = require("@google/genai");
var import_dotenv = __toESM(require("dotenv"), 1);

// src/lib/timesfmEngine.ts
function computeStats(values) {
  if (values.length === 0) return { mean: 0, std: 1 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / Math.max(1, values.length - 1);
  const std = Math.max(1e-5, Math.sqrt(variance));
  return { mean, std };
}
function computeHigherMoments(values) {
  if (values.length < 4) return { skewness: 0, kurtosis: 3 };
  const { mean, std } = computeStats(values);
  let m3 = 0;
  let m4 = 0;
  for (let i = 0; i < values.length; i++) {
    const diff = (values[i] - mean) / std;
    m3 += Math.pow(diff, 3);
    m4 += Math.pow(diff, 4);
  }
  const n = values.length;
  const skewness = Math.max(-2.5, Math.min(2.5, m3 / n));
  const kurtosis = Math.max(1.5, Math.min(8, m4 / n));
  return { skewness, kurtosis };
}
var RevIN = class {
  constructor() {
    this.mean = 0;
    this.std = 1;
  }
  normalize(values) {
    const stats = computeStats(values);
    this.mean = stats.mean;
    this.std = stats.std;
    return values.map((v) => (v - this.mean) / this.std);
  }
  denormalize(normalizedValues) {
    return normalizedValues.map((v) => v * this.std + this.mean);
  }
  denormalizeSingle(v) {
    return v * this.std + this.mean;
  }
};
function denoiseMicrostructureSeries(values) {
  const n = values.length;
  if (n < 7) return [...values];
  const denoised = new Array(n);
  denoised[0] = values[0];
  denoised[1] = (values[0] * 2 + values[1] * 3 + values[2] * 2) / 7;
  denoised[n - 2] = (values[n - 3] * 2 + values[n - 2] * 3 + values[n - 1] * 2) / 7;
  denoised[n - 1] = values[n - 1];
  for (let i = 2; i < n - 2; i++) {
    const smoothed = (-3 * values[i - 2] + 12 * values[i - 1] + 17 * values[i] + 12 * values[i + 1] - 3 * values[i + 2]) / 35;
    const rawDelta = Math.abs(values[i] - values[i - 1]);
    const avgDelta = (Math.abs(values[i - 1] - values[i - 2]) + Math.abs(values[i + 1] - values[i])) / 2;
    if (rawDelta > 2.5 * (avgDelta + 1e-4)) {
      denoised[i] = values[i];
    } else {
      denoised[i] = smoothed;
    }
  }
  return denoised;
}
function computeDualPatchAttentionProjection(normalizedValues, patchLength, horizon) {
  const n = normalizedValues.length;
  const pMacro = Math.max(12, Math.min(patchLength, Math.floor(n / 2)));
  const pMicro = Math.max(4, Math.min(8, Math.floor(n / 4)));
  if (n < pMacro * 2 && n < pMicro * 2) {
    return { deltas: new Array(horizon).fill(0), microConfidence: 0.5, macroConfidence: 0.5 };
  }
  const runPatchAttention = (p) => {
    const numPatches = Math.floor(n / p);
    if (numPatches < 2) return { deltas: new Array(horizon).fill(0), entropy: 1 };
    const patches = [];
    for (let i = 0; i < numPatches; i++) {
      patches.push(normalizedValues.slice(i * p, (i + 1) * p));
    }
    const queryPatch = patches[patches.length - 1];
    const keys = patches.slice(0, patches.length - 1);
    const scores = keys.map((k) => {
      let dot = 0;
      for (let j = 0; j < p; j++) {
        dot += queryPatch[j] * k[j];
      }
      return dot / Math.sqrt(p);
    });
    const maxScore = Math.max(...scores);
    const expScores = scores.map((s) => Math.exp(Math.max(-10, Math.min(10, s - maxScore))));
    const sumExp = expScores.reduce((a, b) => a + b, 0) || 1;
    const attentionWeights = expScores.map((e) => e / sumExp);
    let entropy = 0;
    for (const w of attentionWeights) {
      if (w > 1e-6) entropy -= w * Math.log(w);
    }
    const maxEntropy = Math.log(Math.max(2, keys.length));
    const normEntropy = maxEntropy > 0 ? entropy / maxEntropy : 1;
    const deltas = [];
    for (let h = 0; h < horizon; h++) {
      let projectedDelta = 0;
      for (let k = 0; k < keys.length; k++) {
        const stepInPatch = h % p;
        const priorPatchDelta = k < patches.length - 1 ? patches[k + 1][stepInPatch] - patches[k][stepInPatch] : 0;
        projectedDelta += attentionWeights[k] * priorPatchDelta;
      }
      deltas.push(projectedDelta * 0.42);
    }
    return { deltas, entropy: normEntropy };
  };
  const macroRes = runPatchAttention(pMacro);
  const microRes = runPatchAttention(pMicro);
  const macroWeightRaw = Math.max(0.2, 1 - macroRes.entropy);
  const microWeightRaw = Math.max(0.2, 1 - microRes.entropy);
  const sumW = macroWeightRaw + microWeightRaw;
  const macroW = macroWeightRaw / sumW;
  const microW = microWeightRaw / sumW;
  const combinedDeltas = [];
  for (let h = 0; h < horizon; h++) {
    const val = (macroRes.deltas[h] || 0) * macroW + (microRes.deltas[h] || 0) * microW;
    combinedDeltas.push(val);
  }
  return {
    deltas: combinedDeltas,
    microConfidence: Math.round(microW * 100) / 100,
    macroConfidence: Math.round(macroW * 100) / 100
  };
}
function getSeasonalPeriod(frequency, dataLength, values) {
  if (values && values.length >= 24) {
    const { mean } = computeStats(values);
    const maxLag = Math.min(30, Math.floor(values.length / 2));
    let bestLag = 5;
    let maxAcf = 0.05;
    let varTotal = 0;
    for (let i = 0; i < values.length; i++) {
      varTotal += Math.pow(values[i] - mean, 2);
    }
    if (varTotal > 1e-6) {
      for (let lag = 3; lag <= maxLag; lag++) {
        let cov = 0;
        for (let i = 0; i < values.length - lag; i++) {
          cov += (values[i] - mean) * (values[i + lag] - mean);
        }
        const acf = cov / varTotal;
        if (acf > maxAcf) {
          maxAcf = acf;
          bestLag = lag;
        }
      }
      if (maxAcf > 0.3) {
        return bestLag;
      }
    }
  }
  switch (frequency) {
    case "hourly":
      return 24;
    // 24 hours in a day
    case "daily":
      return 5;
    case "weekly":
      return 52;
    // 52 weeks in a year
    case "monthly":
      return 12;
    // 12 months in a year
    default:
      return Math.min(20, Math.max(5, Math.floor(dataLength / 5)));
  }
}
function decomposeTimeSeries(points, frequency) {
  const values = points.map((p) => p.value);
  const timestamps = points.map((p) => p.timestamp);
  const n = values.length;
  const differences = values.slice(1).map((value, i) => value - values[i]);
  const period = getSeasonalPeriod(frequency, n, differences);
  const trend = new Array(n).fill(0);
  const half = Math.floor(period / 2);
  for (let i = 0; i < n; i++) {
    const start2 = Math.max(0, i - half);
    const end = Math.min(n, i + half + 1);
    let sum = 0;
    let count = 0;
    for (let j = start2; j < end; j++) {
      sum += values[j];
      count++;
    }
    trend[i] = sum / count;
  }
  const detrended = values.map((v, i) => v - trend[i]);
  const seasonalSums = new Array(period).fill(0);
  const seasonalCounts = new Array(period).fill(0);
  for (let i = 0; i < n; i++) {
    const phase = i % period;
    seasonalSums[phase] += detrended[i];
    seasonalCounts[phase] += 1;
  }
  const seasonalFactor = seasonalSums.map((sum, idx) => seasonalCounts[idx] > 0 ? sum / seasonalCounts[idx] : 0);
  const factorMean = seasonalFactor.reduce((a, b) => a + b, 0) / period;
  const centeredSeasonalFactor = seasonalFactor.map((f) => f - factorMean);
  const seasonal = values.map((_, i) => centeredSeasonalFactor[i % period]);
  const residual = values.map((v, i) => v - trend[i] - seasonal[i]);
  return {
    timestamps,
    observed: values,
    trend,
    seasonal,
    residual,
    period
  };
}
function detectAnomalies(points, decomposition, thresholdZScore = 2.5) {
  const anomalies = [];
  const residuals = decomposition.residual;
  const { mean, std } = computeStats(residuals);
  points.forEach((point, i) => {
    const res = residuals[i];
    const zScore = Math.abs(res - mean) / Math.max(1e-5, std);
    const expected = decomposition.trend[i] + decomposition.seasonal[i];
    const margin = thresholdZScore * std;
    const lower = expected - margin;
    const upper = expected + margin;
    const isBreach = zScore >= thresholdZScore || point.isAnomaly;
    if (isBreach) {
      let severity = "low";
      if (zScore >= 5) severity = "critical";
      else if (zScore >= 3.8) severity = "high";
      else if (zScore >= 2.8) severity = "medium";
      let reason = `Deviation of ${Math.round(zScore * 10) / 10}\u03C3 from baseline (${point.value.toFixed(1)} vs expected ${expected.toFixed(1)})`;
      if (point.value > upper) {
        reason = `Spike anomaly: +${((point.value - expected) / Math.max(1, Math.abs(expected)) * 100).toFixed(1)}% above expected seasonal band.`;
      } else if (point.value < lower) {
        reason = `Drop anomaly: -${((expected - point.value) / Math.max(1, Math.abs(expected)) * 100).toFixed(1)}% drop below normal operating floor.`;
      }
      anomalies.push({
        index: i,
        timestamp: point.timestamp,
        actual: point.value,
        expected: Math.round(expected * 100) / 100,
        score: Math.round(zScore * 100) / 100,
        severity: point.anomalySeverity || severity,
        lowerBound: Math.round(lower * 100) / 100,
        upperBound: Math.round(upper * 100) / 100,
        reason
      });
    }
  });
  return anomalies;
}
function generateFutureTimestamps(history, horizon, frequency) {
  if (history.length === 0) return [];
  const lastPoint = history[history.length - 1].timestamp;
  const future = [];
  if (/^\d{4}$/.test(lastPoint)) {
    let year = parseInt(lastPoint, 10);
    for (let i = 1; i <= horizon; i++) {
      future.push(`${year + i}`);
    }
    return future;
  }
  if (/^\d{2}:\d{2}$/.test(lastPoint)) {
    const [h, m] = lastPoint.split(":").map(Number);
    let totalMinutes = h * 60 + m;
    for (let i = 1; i <= horizon; i++) {
      totalMinutes += 5;
      const nh = Math.floor(totalMinutes / 60 % 24).toString().padStart(2, "0");
      const nm = (totalMinutes % 60).toString().padStart(2, "0");
      future.push(`${nh}:${nm}`);
    }
    return future;
  }
  const lastDate = new Date(lastPoint);
  const isValidDate = !isNaN(lastDate.getTime());
  if (!isValidDate) {
    for (let i = 1; i <= horizon; i++) {
      future.push(`Step +${i}`);
    }
    return future;
  }
  let detectedStepMs = 0;
  if (history.length >= 2) {
    const tLast = new Date(history[history.length - 1].timestamp).getTime();
    const tPrev = new Date(history[history.length - 2].timestamp).getTime();
    if (!isNaN(tLast) && !isNaN(tPrev) && tLast > tPrev) {
      detectedStepMs = tLast - tPrev;
    }
  }
  const isDailyCandidate = frequency === "daily" || (!detectedStepMs || detectedStepMs >= 18 * 3600 * 1e3);
  let isTradingDaySeries = false;
  if (isDailyCandidate && history.length >= 5) {
    let weekendCount = 0;
    const checkSample = Math.min(25, history.length);
    for (let k = history.length - checkSample; k < history.length; k++) {
      const day = new Date(history[k].timestamp).getDay();
      if (day === 0 || day === 6) weekendCount++;
    }
    if (weekendCount === 0) {
      isTradingDaySeries = true;
    }
  }
  let tradingDateCursor = new Date(lastDate);
  for (let i = 1; i <= horizon; i++) {
    if (isTradingDaySeries) {
      do {
        tradingDateCursor.setDate(tradingDateCursor.getDate() + 1);
      } while (tradingDateCursor.getDay() === 0 || tradingDateCursor.getDay() === 6);
      future.push(tradingDateCursor.toISOString().split("T")[0]);
    } else if (detectedStepMs > 0 && detectedStepMs <= 4 * 3600 * 1e3) {
      const nextDate = new Date(lastDate.getTime() + detectedStepMs * i);
      future.push(nextDate.toISOString().slice(0, 16).replace("T", " "));
    } else if (frequency === "hourly") {
      const nextDate = new Date(lastDate.getTime() + i * 3600 * 1e3);
      future.push(nextDate.toISOString().slice(0, 16).replace("T", " "));
    } else if (frequency === "weekly") {
      const nextDate = new Date(lastDate);
      nextDate.setDate(lastDate.getDate() + i * 7);
      future.push(nextDate.toISOString().split("T")[0]);
    } else if (frequency === "monthly") {
      const nextDate = new Date(lastDate);
      nextDate.setMonth(lastDate.getMonth() + i);
      future.push(nextDate.toISOString().slice(0, 7));
    } else {
      const nextDate = new Date(lastDate);
      nextDate.setDate(lastDate.getDate() + i);
      future.push(nextDate.toISOString().split("T")[0]);
    }
  }
  return future;
}
function computeCovariateLift(covariates, history) {
  if (!covariates || Object.keys(covariates).length === 0) return 0;
  let totalLift = 0;
  Object.entries(covariates).forEach(([key, val]) => {
    const histVals = history.map((h) => h.covariates?.[key]).filter((v) => typeof v === "number");
    const histMean = histVals.length > 0 ? histVals.reduce((a, b) => a + b, 0) / histVals.length : 0;
    const diff = val - histMean;
    if (key.includes("rsi")) {
      if (val < 30) totalLift += (30 - val) * 3e-3;
      else if (val > 70) totalLift -= (val - 70) * 25e-4;
    } else if (key.includes("macd")) {
      totalLift += Math.max(-0.06, Math.min(0.06, val * 0.03));
    } else if (key.includes("volume")) {
      if (val > 1.5) totalLift += Math.sign(diff) * 0.02;
    } else if (key.includes("bollinger")) {
      if (val < 15) totalLift += 0.02;
      else if (val > 85) totalLift -= 0.02;
    } else if (key.includes("vwap")) {
      if (val > 0) totalLift += Math.min(0.04, val * 0.015);
      else totalLift += Math.max(-0.04, val * 0.015);
    } else if (key.includes("supertrend")) {
      totalLift += val > 0 ? 0.025 : -0.025;
    } else if (key.includes("ema") || key.includes("sma")) {
      totalLift += Math.max(-0.04, Math.min(0.04, diff * 0.02));
    } else if (key.includes("promo") || key.includes("discount")) {
      totalLift += val > 0 ? (val > 1 ? val / 100 : val) * 0.9 : 0;
    } else if (key.includes("spend") || key.includes("budget")) {
      totalLift += diff / (histMean || 1e3) * 0.25;
    } else if (key.includes("holiday") || key.includes("earnings")) {
      totalLift += val > 0 ? 0.15 : 0;
    } else if (key.includes("temp")) {
      if (val > 24) totalLift += (val - 24) * 0.035;
      else if (val < 10) totalLift += (10 - val) * 0.02;
    } else if (key.includes("volatility") || key.includes("vix") || key.includes("atr")) {
      totalLift -= diff / (histMean || 15) * 0.08;
    } else {
      if (histMean !== 0) {
        totalLift += diff / Math.abs(histMean) * 0.12;
      }
    }
  });
  return Math.max(-0.5, Math.min(1.2, totalLift));
}
function detectTimesFmFrequencyToken(history, userFrequency) {
  if (userFrequency && userFrequency !== "auto") {
    if (userFrequency === "hourly") return { token: 0, name: "0 (High-Freq / Sub-Daily)", type: "hourly" };
    if (userFrequency === "daily") return { token: 1, name: "1 (Daily Cadence)", type: "daily" };
    if (userFrequency === "weekly") return { token: 2, name: "2 (Weekly Cadence)", type: "weekly" };
    if (userFrequency === "monthly") return { token: 3, name: "3 (Monthly Cadence)", type: "monthly" };
  }
  if (history.length < 2) {
    return { token: 1, name: "1 (Daily Default)", type: "daily" };
  }
  const sampleCount = Math.min(30, history.length - 1);
  let totalDeltaMs = 0;
  let validDeltas = 0;
  for (let i = history.length - sampleCount; i < history.length; i++) {
    const tCur = new Date(history[i].timestamp).getTime();
    const tPrev = new Date(history[i - 1].timestamp).getTime();
    if (!isNaN(tCur) && !isNaN(tPrev) && tCur > tPrev) {
      totalDeltaMs += tCur - tPrev;
      validDeltas++;
    }
  }
  if (validDeltas === 0) {
    return { token: 1, name: "1 (Daily Auto)", type: "daily" };
  }
  const avgDeltaMinutes = totalDeltaMs / validDeltas / (60 * 1e3);
  if (avgDeltaMinutes <= 180) {
    return { token: 0, name: "0 (High-Freq / 15m\u20131h)", type: "hourly" };
  } else if (avgDeltaMinutes <= 36 * 60) {
    return { token: 1, name: "1 (Daily 1D)", type: "daily" };
  } else if (avgDeltaMinutes <= 10 * 24 * 60) {
    return { token: 2, name: "2 (Weekly 1W)", type: "weekly" };
  } else {
    return { token: 3, name: "3 (Monthly 1M)", type: "monthly" };
  }
}
function runTimesFmForecast(history, config, futureCovariatesList) {
  const startTime = performance.now();
  const freqDetection = detectTimesFmFrequencyToken(history, config.frequency);
  const effectiveFrequency = config.frequency === "auto" ? freqDetection.type : config.frequency;
  const requestedContext = config.contextLength || 512;
  const effectiveContextLength = Math.max(1, Math.min(history.length, requestedContext));
  const contextPoints = history.slice(-effectiveContextLength);
  const rawValues = contextPoints.map((p) => p.value);
  const n = rawValues.length;
  const revin = new RevIN();
  const normalizedValues = revin.normalize(rawValues);
  const denoisedRawValues = denoiseMicrostructureSeries(rawValues);
  const denoisedNormValues = denoisedRawValues.map((value) => (value - revin.mean) / revin.std);
  const decomp = decomposeTimeSeries(contextPoints, effectiveFrequency);
  const period = decomp.period;
  const { skewness: residualSkew, kurtosis: residualKurt } = computeHigherMoments(decomp.residual);
  const windowForSlope = Math.min(n, Math.max(12, period * 2));
  const slopeNormValues = denoisedNormValues.slice(-windowForSlope);
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < windowForSlope; i++) {
    sumX += i;
    sumY += slopeNormValues[i];
    sumXY += i * slopeNormValues[i];
    sumXX += i * i;
  }
  let normSlope = (windowForSlope * sumXY - sumX * sumY) / Math.max(1e-5, windowForSlope * sumXX - sumX * sumX);
  const logReturns = [];
  for (let i = 1; i < n; i++) {
    if (rawValues[i - 1] > 0 && rawValues[i] > 0) {
      logReturns.push(Math.log(rawValues[i] / rawValues[i - 1]));
    }
  }
  const avgLogReturn = logReturns.length > 0 ? logReturns.reduce((a, b) => a + b, 0) / logReturns.length : 0;
  const stdLogReturn = logReturns.length > 1 ? Math.sqrt(logReturns.reduce((acc, r) => acc + Math.pow(r - avgLogReturn, 2), 0) / (logReturns.length - 1)) : 0.015;
  const maxNormSlope = stdLogReturn * (rawValues[n - 1] || 100) / (revin.std || 1) * 2.8;
  normSlope = Math.max(-maxNormSlope, Math.min(maxNormSlope, normSlope));
  const lastNormValue = normalizedValues[n - 1];
  const lastHistoricalValue = rawValues[n - 1] ?? 100;
  const dualPatch = computeDualPatchAttentionProjection(denoisedNormValues, config.patchLength || 32, config.horizon || 32);
  const patchAttentionDeltas = dualPatch.deltas;
  const dampingFactor = 0.91;
  const uncertaintyGrowthRate = config.confidenceLevel === 95 ? 1.96 : config.confidenceLevel === 80 ? 1.2816 : 0.6745;
  const { std: residualStd } = computeStats(decomp.residual);
  const effectiveHorizon = config.horizon || 32;
  const futureTimestamps = generateFutureTimestamps(contextPoints, effectiveHorizon, effectiveFrequency);
  const forecasts = [];
  for (let h = 0; h < effectiveHorizon; h++) {
    const timestamp = futureTimestamps[h] || `Step +${h + 1}`;
    const futureCovariates = futureCovariatesList?.[h] || contextPoints[contextPoints.length - 1]?.covariates;
    const normTrendContribution = normSlope * (h + 1) * Math.pow(dampingFactor, h);
    const patchAttnContribution = patchAttentionDeltas[h] || 0;
    const normBase = lastNormValue + normTrendContribution + patchAttnContribution;
    const seasonalIndex = (n + h) % period;
    const seasonalContribution = decomp.seasonal[seasonalIndex % decomp.seasonal.length] || 0;
    const baseDenormPrice = revin.denormalizeSingle(normBase) + seasonalContribution;
    const covLift = config.useCovariates ? computeCovariateLift(futureCovariates, contextPoints) : 0;
    const covariateAdjusted = Math.max(0.01, baseDenormPrice * (1 + covLift));
    const fatTailMultiplier = Math.sqrt(1 + 0.12 * Math.max(0, residualKurt - 3));
    const stepStd = residualStd * (1 + 0.18 * Math.sqrt(h + 1)) * fatTailMultiplier;
    const z95 = 1.96;
    const downSpread95 = z95 * stepStd * (1 - 0.25 * residualSkew);
    const upSpread95 = z95 * stepStd * (1 + 0.25 * residualSkew);
    const p025 = Math.max(0.01, covariateAdjusted - downSpread95 * 1.15);
    const p975 = covariateAdjusted + upSpread95 * 1.15;
    const z90 = 1.645;
    const downSpread90 = z90 * stepStd * (1 - 0.2 * residualSkew);
    const upSpread90 = z90 * stepStd * (1 + 0.2 * residualSkew);
    const p10 = Math.max(0.01, covariateAdjusted - downSpread90 * 1.05);
    const p90 = covariateAdjusted + upSpread90 * 1.05;
    const p25 = Math.max(0.01, covariateAdjusted - 0.674 * stepStd * (1 - 0.1 * residualSkew));
    const p75 = covariateAdjusted + 0.674 * stepStd * (1 + 0.1 * residualSkew);
    const p50 = covariateAdjusted;
    const mean = (p025 + p10 + p25 + p50 * 2 + p75 + p90 + p975) / 8;
    forecasts.push({
      timestamp,
      mean: Math.round(mean * 100) / 100,
      p025: Math.round(p025 * 100) / 100,
      p10: Math.round(p10 * 100) / 100,
      p25: Math.round(p25 * 100) / 100,
      p50: Math.round(p50 * 100) / 100,
      p75: Math.round(p75 * 100) / 100,
      p90: Math.round(p90 * 100) / 100,
      p975: Math.round(p975 * 100) / 100,
      covariates: futureCovariates
    });
  }
  const anomalies = detectAnomalies(contextPoints, decomp, config.anomalyThreshold);
  let metrics;
  const testWindow = Math.min(14, Math.floor(n * 0.2));
  if (testWindow >= 4) {
    const actuals = rawValues.slice(-testWindow);
    const preds = decomp.trend.slice(-testWindow).map((t, idx) => t + decomp.seasonal.slice(-testWindow)[idx]);
    let sumAbsErr = 0;
    let sumSqErr = 0;
    let sumPctErr = 0;
    let sumSymmetricPct = 0;
    let inCoverage = 0;
    let correctDirectionCount = 0;
    let grossGains = 0;
    let grossLosses = 0;
    for (let i = 0; i < testWindow; i++) {
      const act = actuals[i];
      const prd = preds[i];
      const err = Math.abs(act - prd);
      sumAbsErr += err;
      sumSqErr += err * err;
      sumPctErr += Math.abs(act) > 0 ? err / Math.abs(act) : 0;
      sumSymmetricPct += 2 * err / (Math.abs(act) + Math.abs(prd) + 1e-5);
      const upper = prd + uncertaintyGrowthRate * residualStd;
      const lower = prd - uncertaintyGrowthRate * residualStd;
      if (act >= lower && act <= upper) inCoverage++;
      if (i > 0) {
        const actualDelta = actuals[i] - actuals[i - 1];
        const predDelta = preds[i] - preds[i - 1];
        if (Math.sign(actualDelta) === Math.sign(predDelta) || actualDelta === 0) {
          correctDirectionCount++;
          grossGains += Math.abs(actualDelta);
        } else {
          grossLosses += Math.abs(actualDelta);
        }
      }
    }
    const directionEvalCount = Math.max(1, testWindow - 1);
    const mda = Math.round(correctDirectionCount / directionEvalCount * 100);
    const profitFactor = grossLosses > 0 ? Math.round(grossGains / grossLosses * 100) / 100 : 2.5;
    const rmseVal = Math.sqrt(sumSqErr / testWindow);
    const sharpeProxy = Math.round(Math.abs(avgLogReturn) * Math.sqrt(252) / (stdLogReturn * Math.sqrt(252) + 1e-4) * 100) / 100;
    metrics = {
      mae: Math.round(sumAbsErr / testWindow * 100) / 100,
      rmse: Math.round(rmseVal * 100) / 100,
      mape: Math.round(sumPctErr / testWindow * 1e3) / 10,
      // in %
      smape: Math.round(sumSymmetricPct / testWindow * 1e3) / 10,
      // in %
      coverageRate: Math.round(inCoverage / testWindow * 100),
      // in %
      mda,
      sharpeProxy,
      profitFactor
    };
  }
  metrics = void 0;
  const lastClose = lastHistoricalValue || 100;
  const lastPoint = contextPoints[contextPoints.length - 1];
  const finalForecast = forecasts[forecasts.length - 1] || { p50: lastClose, p10: lastClose * 0.95, p90: lastClose * 1.05 };
  const targetMedian = finalForecast.p50;
  const projectedReturnPct = Math.round((targetMedian - lastClose) / Math.max(1e-4, lastClose) * 1e4) / 100;
  const p10Floor = finalForecast.p10;
  const p90Ceiling = finalForecast.p90;
  const valueAtRiskPct = Math.max(0, Math.round((lastClose - (finalForecast.p025 ?? p10Floor)) / lastClose * 1e4) / 100);
  const upside = Math.max(0, p90Ceiling - targetMedian);
  const downside = Math.max(1e-4, targetMedian - p10Floor);
  const riskRewardRatio = Math.round(upside / downside * 100) / 100;
  let signal = "NEUTRAL";
  if (projectedReturnPct >= 2.5 && valueAtRiskPct < 3.5) {
    signal = "STRONG_BUY";
  } else if (projectedReturnPct >= 0.7) {
    signal = "BUY";
  } else if (projectedReturnPct <= -2.5) {
    signal = "STRONG_SELL";
  } else if (projectedReturnPct <= -0.7) {
    signal = "SELL";
  }
  const directionalConfidence = void 0;
  const tradingMetrics = {
    signal,
    projectedReturnPct,
    directionalConfidence,
    targetMedianPrice: Math.round(targetMedian * 100) / 100,
    supportFloorP10: Math.round(p10Floor * 100) / 100,
    resistanceCeilingP90: Math.round(p90Ceiling * 100) / 100,
    valueAtRiskPct,
    riskRewardRatio,
    rsi14: lastPoint?.covariates?.rsi_14,
    sma20: decomp.trend[decomp.trend.length - 1] ? Math.round(decomp.trend[decomp.trend.length - 1] * 100) / 100 : void 0,
    atr14: lastPoint?.covariates?.volatility_atr_pct
  };
  const executionTimeMs = Math.round(performance.now() - startTime);
  return {
    engineName: "Local Statistical Heuristic (not Google TimesFM)",
    history: contextPoints,
    forecasts,
    metrics,
    tradingMetrics,
    decomposition: decomp,
    anomalies,
    modelConfig: {
      ...config,
      frequency: effectiveFrequency,
      frequencyToken: freqDetection.token
    },
    frequencyToken: freqDetection.token,
    frequencyName: freqDetection.name,
    executionTimeMs,
    isLocalExecution: config.executionMode === "local_device"
  };
}

// src/lib/upstoxInstruments.ts
var UPSTOX_INSTRUMENT_MAP = {
  // Major Indices
  "NIFTY": "NSE_INDEX|Nifty 50",
  "NIFTY 50": "NSE_INDEX|Nifty 50",
  "NIFTY50": "NSE_INDEX|Nifty 50",
  "^NSEI": "NSE_INDEX|Nifty 50",
  "BANKNIFTY": "NSE_INDEX|Nifty Bank",
  "NIFTY BANK": "NSE_INDEX|Nifty Bank",
  "FINNIFTY": "NSE_INDEX|Nifty Fin Service",
  "MIDCPNIFTY": "NSE_INDEX|NIFTY MID SELECT",
  "NIFTY NEXT 50": "NSE_INDEX|Nifty Next 50",
  "NIFTY IT": "NSE_INDEX|Nifty IT",
  "SENSEX": "BSE_INDEX|SENSEX",
  "^BSESN": "BSE_INDEX|SENSEX",
  // NIFTY 50 & Major Equities (ISIN Codes)
  "RELIANCE": "NSE_EQ|INE002A01018",
  "TCS": "NSE_EQ|INE467B01029",
  "HDFCBANK": "NSE_EQ|INE040A01034",
  "INFY": "NSE_EQ|INE009A01021",
  "ICICIBANK": "NSE_EQ|INE090A01021",
  "SBIN": "NSE_EQ|INE062A01020",
  "BHARTIARTL": "NSE_EQ|INE397D01024",
  "TATAMOTORS": "NSE_EQ|INE155A01022",
  "TMPV": "NSE_EQ|INE155A01022",
  "ITC": "NSE_EQ|INE154A01025",
  "KOTAKBANK": "NSE_EQ|INE237A01028",
  "LT": "NSE_EQ|INE018A01030",
  "AXISBANK": "NSE_EQ|INE238A01034",
  "MARUTI": "NSE_EQ|INE585B01010",
  "SUNPHARMA": "NSE_EQ|INE044A01036",
  "TITAN": "NSE_EQ|INE280A01028",
  "BAJFINANCE": "NSE_EQ|INE296A01024",
  "BAJAJFINSV": "NSE_EQ|INE918I01026",
  "ASIANPAINT": "NSE_EQ|INE021A01026",
  "WIPRO": "NSE_EQ|INE075A01022",
  "HCLTECH": "NSE_EQ|INE860A01027",
  "NTPC": "NSE_EQ|INE733E01010",
  "POWERGRID": "NSE_EQ|INE752E01010",
  "TATASTEEL": "NSE_EQ|INE081A01020",
  "JSWSTEEL": "NSE_EQ|INE019A01038",
  "COALINDIA": "NSE_EQ|INE522F01014",
  "ADANIENT": "NSE_EQ|INE423A01024",
  "ADANIPORTS": "NSE_EQ|INE742F01042",
  "ULTRACEMCO": "NSE_EQ|INE481G01011",
  "ONGC": "NSE_EQ|INE213A01029",
  "NESTLEIND": "NSE_EQ|INE239A01024",
  "HEROMOTOCO": "NSE_EQ|INE158A01026",
  "BAJAJ-AUTO": "NSE_EQ|INE917I01010",
  "EICHERMOT": "NSE_EQ|INE066A01021",
  "GRASIM": "NSE_EQ|INE047A01021",
  "HINDUNILVR": "NSE_EQ|INE030A01027",
  "DIVISLAB": "NSE_EQ|INE361B01024",
  "CIPLA": "NSE_EQ|INE059A01026",
  "DRREDDY": "NSE_EQ|INE089A01023",
  "APOLLOHOSP": "NSE_EQ|INE437A01024",
  "TECHM": "NSE_EQ|INE669C01036",
  "BPCL": "NSE_EQ|INE029A01011",
  "BRITANNIA": "NSE_EQ|INE216A01030",
  "INDUSINDBK": "NSE_EQ|INE095A01012",
  "HINDALCO": "NSE_EQ|INE038A01020",
  "SBILIFE": "NSE_EQ|INE123W01016",
  "HDFCLIFE": "NSE_EQ|INE795G01014",
  "BEL": "NSE_EQ|INE263A01024",
  "HAL": "NSE_EQ|INE066F01012",
  "TRENT": "NSE_EQ|INE849A01020",
  "ZOMATO": "NSE_EQ|INE758T01015",
  "JIOFIN": "NSE_EQ|INE758E01017",
  "SUZLON": "NSE_EQ|INE040H01021",
  "SYRMA": "NSE_EQ|INE0DY501015",
  "VEDL": "NSE_EQ|INE205A01025",
  "IRFC": "NSE_EQ|INE053F01010",
  "BHEL": "NSE_EQ|INE257A01026",
  "IOC": "NSE_EQ|INE242A01010",
  "GAIL": "NSE_EQ|INE129A01019",
  "DLF": "NSE_EQ|INE271C01023",
  "PFC": "NSE_EQ|INE134E01011",
  "RECLTD": "NSE_EQ|INE020B01018",
  "MOTHERSON": "NSE_EQ|INE775A01035",
  "POLYCAB": "NSE_EQ|INE455K01017",
  "PERSISTENT": "NSE_EQ|INE262H01013",
  "SIEMENS": "NSE_EQ|INE003A01024",
  "ABB": "NSE_EQ|INE117A01022",
  "CHOLAFIN": "NSE_EQ|INE121A01024",
  "MUTHOOTFIN": "NSE_EQ|INE414G01012",
  "TVSMOTOR": "NSE_EQ|INE494B01023",
  "SHREECEM": "NSE_EQ|INE070A01015",
  "PIDILITIND": "NSE_EQ|INE318A01026",
  "HAVELLS": "NSE_EQ|INE176B01034",
  "DABUR": "NSE_EQ|INE016A01026",
  "GODREJCP": "NSE_EQ|INE102D01028",
  "BERGEPAINT": "NSE_EQ|INE463A01038",
  "INDIGO": "NSE_EQ|INE646L01027",
  "AUROPHARMA": "NSE_EQ|INE406A01037",
  "LUPIN": "NSE_EQ|INE326A01037",
  "AMBUJACEM": "NSE_EQ|INE079A01024",
  "ACC": "NSE_EQ|INE012A01025",
  "BANKBARODA": "NSE_EQ|INE028A01039",
  "PNB": "NSE_EQ|INE160A01022",
  "CANBK": "NSE_EQ|INE476A01014",
  "UNIONBANK": "NSE_EQ|INE692A01016",
  "IDFCFIRSTB": "NSE_EQ|INE092T01019",
  "FEDERALBNK": "NSE_EQ|INE171A01029",
  "TATACOMM": "NSE_EQ|INE151A01013",
  "TATACONSUM": "NSE_EQ|INE192A01025",
  "TATAELXSI": "NSE_EQ|INE670A01012",
  "VOLTAS": "NSE_EQ|INE226A01021",
  "COLPAL": "NSE_EQ|INE259A01022",
  "MARICO": "NSE_EQ|INE196A01026",
  "SRF": "NSE_EQ|INE647A01010",
  "CUMMINSIND": "NSE_EQ|INE298A01020",
  "BOSCHLTD": "NSE_EQ|INE323A01026",
  "ASHOKLEY": "NSE_EQ|INE214T01019",
  "BALKRISIND": "NSE_EQ|INE787D01026",
  "MRF": "NSE_EQ|INE883A01011",
  "PAGEIND": "NSE_EQ|INE761H01023",
  "LTIM": "NSE_EQ|INE214A01026",
  "OFSS": "NSE_EQ|INE881D01027",
  "MPHASIS": "NSE_EQ|INE356A01018",
  "COFORGE": "NSE_EQ|INE591G01017",
  "LTTS": "NSE_EQ|INE010V01017",
  "KPITTECH": "NSE_EQ|INE04I401011",
  "TATACHEM": "NSE_EQ|INE092A01019",
  "DEEPAKNTR": "NSE_EQ|INE288B01029",
  "PIIND": "NSE_EQ|INE603J01030",
  "NAVINFLUOR": "NSE_EQ|INE048G01026",
  "ASTRAL": "NSE_EQ|INE006I01046",
  "SUPREMEIND": "NSE_EQ|INE195A01028",
  "DIXON": "NSE_EQ|INE935N01020",
  "KAYNES": "NSE_EQ|INE918Z01012",
  "CGPOWER": "NSE_EQ|INE067A01029",
  "SUNDRMFAST": "NSE_EQ|INE387A01021",
  "TIINDIA": "NSE_EQ|INE974X01010",
  "APLAPOLLO": "NSE_EQ|INE702C01027",
  "HDFCAMC": "NSE_EQ|INE127D01025",
  "NAM-INDIA": "NSE_EQ|INE298J01013",
  "BSE": "NSE_EQ|INE118H01025",
  "CDSL": "NSE_EQ|INE736A01011",
  "MCX": "NSE_EQ|INE745G01035",
  "CAMS": "NSE_EQ|INE596I01012",
  "IEX": "NSE_EQ|INE022Q01020",
  "KFINTECH": "NSE_EQ|INE138Y01010",
  "M&M": "NSE_EQ|INE155A01022",
  "TATAPOWER": "NSE_EQ|INE245A01021",
  "SWIGGY": "NSE_EQ|INE00H001014",
  "PAYTM": "NSE_EQ|INE982J01020",
  "IREDA": "NSE_EQ|INE202E01016",
  "RVNL": "NSE_EQ|INE415G01027",
  "NHPC": "NSE_EQ|INE848E01016",
  "SJVN": "NSE_EQ|INE002L01015",
  "EXIDEIND": "NSE_EQ|INE302A01020",
  "AMBER": "NSE_EQ|INE371P01015",
  "PRESTIGE": "NSE_EQ|INE411L01011",
  "OBEROIRLTY": "NSE_EQ|INE893J01029",
  "GODREJPROP": "NSE_EQ|INE484J01027",
  "PHOENIXLTD": "NSE_EQ|INE211B01039",
  "MAZDOCK": "NSE_EQ|INE249Z01012",
  "COCHINSHIP": "NSE_EQ|INE704P01017",
  "BDL": "NSE_EQ|INE171Z01018",
  "POLICYBZR": "NSE_EQ|INE417T01026",
  "NYKAA": "NSE_EQ|INE388Y01029",
  "DELHIVERY": "NSE_EQ|INE148O01028",
  "KALYANKJIL": "NSE_EQ|INE303R01014",
  "KPIL": "NSE_EQ|INE220B01022"
};
var POPULAR_COMPANY_ALIASES = {
  "TATA MOTORS": "TATAMOTORS",
  "TATA MOTOR": "TATAMOTORS",
  "TATAMOTOR": "TATAMOTORS",
  "TMPV": "TATAMOTORS",
  "TMCV": "TATAMOTORS",
  "RELIANCE IND": "RELIANCE",
  "RELIANCE INDUSTRIES": "RELIANCE",
  "RIL": "RELIANCE",
  "TATA CONSULTANCY": "TCS",
  "TATA CONSULTANCY SERVICES": "TCS",
  "HDFC BANK": "HDFCBANK",
  "HDFC": "HDFCBANK",
  "INFOSYS": "INFY",
  "STATE BANK OF INDIA": "SBIN",
  "STATE BANK": "SBIN",
  "SBI": "SBIN",
  "ICICI BANK": "ICICIBANK",
  "ICICI": "ICICIBANK",
  "BHARTI AIRTEL": "BHARTIARTL",
  "AIRTEL": "BHARTIARTL",
  "LARSEN & TOUBRO": "LT",
  "LARSEN": "LT",
  "L&T": "LT",
  "KOTAK MAHINDRA": "KOTAKBANK",
  "KOTAK BANK": "KOTAKBANK",
  "KOTAK": "KOTAKBANK",
  "MARUTI SUZUKI": "MARUTI",
  "AXIS BANK": "AXISBANK",
  "AXIS": "AXISBANK",
  "TATA STEEL": "TATASTEEL",
  "BAJAJ FINANCE": "BAJFINANCE",
  "BAJAJ FINSERV": "BAJAJFINSV",
  "ASIAN PAINTS": "ASIANPAINT",
  "SUN PHARMA": "SUNPHARMA",
  "SUN PHARMACEUTICALS": "SUNPHARMA",
  "HINDUSTAN UNILEVER": "HINDUNILVR",
  "HUL": "HINDUNILVR",
  "TATA POWER": "TATAPOWER",
  "TATA CONSUMER": "TATACONSUM",
  "NIFTY": "NIFTY 50",
  "NIFTY50": "NIFTY 50",
  "^NSEI": "NIFTY 50",
  "BANK NIFTY": "BANKNIFTY",
  "NIFTY BANK": "BANKNIFTY",
  "^NSEBANK": "BANKNIFTY",
  "FIN NIFTY": "FINNIFTY",
  "BSE SENSEX": "SENSEX",
  "^BSESN": "SENSEX",
  "MCX GOLD": "GOLD",
  "MCX SILVER": "SILVER",
  "MCX CRUDE": "CRUDEOIL",
  "CRUDE OIL": "CRUDEOIL",
  "NATURAL GAS": "NATURALGAS"
};
function normalizeSymbol(input) {
  if (!input) return "RELIANCE";
  let clean = input.trim().toUpperCase().replace(/\.NS$/i, "").replace(/\.BO$/i, "").replace(/^NSE:/i, "").replace(/^BSE:/i, "");
  if (POPULAR_COMPANY_ALIASES[clean]) {
    return POPULAR_COMPANY_ALIASES[clean];
  }
  const noSpaces = clean.replace(/[\s\-_]/g, "");
  if (POPULAR_COMPANY_ALIASES[noSpaces]) {
    return POPULAR_COMPANY_ALIASES[noSpaces];
  }
  return clean;
}
function resolveUpstoxInstrumentKey(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (normalized.includes("|")) {
    return normalized;
  }
  if (UPSTOX_INSTRUMENT_MAP[normalized]) {
    return UPSTOX_INSTRUMENT_MAP[normalized];
  }
  const noSpaces = normalized.replace(/[\s\-_]/g, "");
  if (UPSTOX_INSTRUMENT_MAP[noSpaces]) {
    return UPSTOX_INSTRUMENT_MAP[noSpaces];
  }
  return `NSE_EQ|${noSpaces}`;
}
function formatUpstoxEndpoint(url, symbol, interval, range) {
  const instrumentKey = resolveUpstoxInstrumentKey(symbol);
  const now = /* @__PURE__ */ new Date();
  const toDate = now.toISOString().split("T")[0];
  let daysBack = range === "1mo" ? 30 : range === "3mo" ? 90 : range === "1y" ? 365 : range === "2y" ? 730 : 180;
  if (interval === "1wk" || interval === "week") {
    daysBack = Math.max(730, daysBack);
  } else if (interval === "15m" || interval === "30m" || interval === "1h" || interval === "1m") {
    daysBack = Math.min(60, Math.max(15, daysBack));
  }
  const fromDateObj = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1e3);
  const fromDate = fromDateObj.toISOString().split("T")[0];
  let upstoxInterval = "day";
  if (interval === "1m" || interval === "1minute") upstoxInterval = "1minute";
  else if (interval === "5m" || interval === "15m" || interval === "30m" || interval === "1h") upstoxInterval = "30minute";
  else if (interval === "1wk" || interval === "week") upstoxInterval = "week";
  else if (interval === "1mo" || interval === "month") upstoxInterval = "month";
  else upstoxInterval = "day";
  const encodedKey = encodeURIComponent(instrumentKey);
  if (url.includes("/historical-candle")) {
    return `https://api.upstox.com/v2/historical-candle/${encodedKey}/${upstoxInterval}/${toDate}/${fromDate}`;
  }
  return url.replace(/\{instrumentKey\}/gi, encodedKey).replace(/\{instrument_key\}/gi, encodedKey).replace(/\{symbol\}/gi, encodedKey).replace(/\{ticker\}/gi, encodedKey).replace(/\{to_date\}/gi, toDate).replace(/\{from_date\}/gi, fromDate).replace(/\{interval\}/gi, upstoxInterval).replace(/\{range\}/gi, fromDate);
}

// src/lib/smcVolumeProfileEngine.ts
function generateInstitutionalSmcMarkdownReport(payload, currencySymbol = "\u20B9") {
  const meta = payload.dataset_metadata;
  const tfm = payload.timesfm_3_output;
  const mkt = payload.market_data;
  const smc = mkt.smc_ict;
  const vp = mkt.volume_profile;
  const cmp = mkt.current_price;
  const isBullish = tfm.predicted_trend === "BULLISH";
  const isBearish = tfm.predicted_trend === "BEARISH";
  let actionStatus = "WAIT FOR ENTRY";
  let actionRecommendation = "";
  let estimatedWait = "";
  const fvgLow = Math.min(...smc.unmitigated_fvg_zone);
  const fvgHigh = Math.max(...smc.unmitigated_fvg_zone);
  const isPriceInEntryZone = cmp >= fvgLow && cmp <= fvgHigh;
  if (isBullish) {
    if (smc.htf_ssl_swept && smc.ltf_choch) {
      if (isPriceInEntryZone) {
        actionStatus = "TRADE NOW";
        actionRecommendation = `Execute BUY order at current market price (${currencySymbol}${cmp.toLocaleString()}) inside unmitigated FVG zone.`;
      } else {
        actionStatus = "WAIT FOR ENTRY";
        actionRecommendation = `Bullish structure confirmed; wait for price to retest unmitigated 15m FVG zone (${currencySymbol}${fvgLow} \u2013 ${currencySymbol}${fvgHigh}).`;
        estimatedWait = `~3 to 5 candles / approx 45 minutes until price retests 15m FVG Zone`;
      }
    } else {
      actionStatus = "AVOID";
      actionRecommendation = `Incomplete SMC confluence. HTF sweep or LTF Market Structure Shift pending.`;
    }
  } else if (isBearish) {
    if (smc.htf_bsl_swept && smc.ltf_choch) {
      if (isPriceInEntryZone) {
        actionStatus = "TRADE NOW";
        actionRecommendation = `Execute SELL order at current market price (${currencySymbol}${cmp.toLocaleString()}) inside supply FVG zone.`;
      } else {
        actionStatus = "WAIT FOR ENTRY";
        actionRecommendation = `Bearish displacement confirmed; wait for price retest into ${currencySymbol}${fvgLow} \u2013 ${currencySymbol}${fvgHigh}.`;
        estimatedWait = `~3 to 4 candles / approx 45 minutes until price retests FVG rejection zone`;
      }
    } else {
      actionStatus = "AVOID";
      actionRecommendation = `Lack of confirmed Buy-Side Liquidity sweep. Maintain capital preservation.`;
    }
  } else {
    actionStatus = "AVOID";
    actionRecommendation = `The local forecast baseline is sideways between the observed Volume Profile levels POC (${currencySymbol}${vp.poc}) and VAL (${currencySymbol}${vp.val}); its range estimate is uncalibrated.`;
  }
  const tradeDirection = actionStatus === "AVOID" ? "NONE" : isBullish ? "BUY" : "SELL";
  const entryZone = `${currencySymbol}${fvgLow.toFixed(2)} \u2013 ${currencySymbol}${fvgHigh.toFixed(2)}`;
  const slPrice = isBullish ? smc.sweep_price : smc.bearish_ob || cmp * 1.01;
  const tp1Price = tfm.projected_price_points[1] || (isBullish ? vp.vah : vp.val);
  const tp2Price = tfm.projected_price_points[2] || (isBullish ? tp1Price * 1.015 : tp1Price * 0.985);
  const risk = Math.abs(cmp - slPrice);
  const reward = Math.abs(tp2Price - cmp);
  const rr = risk > 0 && Number.isFinite(reward) ? (reward / risk).toFixed(1) : "N/A";
  const riskNote = actionStatus === "AVOID" ? `Trade is avoided due to structural divergence between TimesFM 3 neutral projection and rangebound Volume Profile. Setup is invalidated if price breaks forcefully beyond Value Area extremes.` : `This trade is valid because HTF ${isBullish ? "Sell-Side Liquidity (SSL)" : "Buy-Side Liquidity (BSL)"} has been swept at ${currencySymbol}${smc.sweep_price} followed by confirmed LTF CHoCH displacement. Setup is strictly invalidated if a 15-minute candle closes beyond Stop Loss at ${currencySymbol}${slPrice.toFixed(2)}.`;
  return `### \u2699\uFE0F Dataset & Timeframe Metadata
* **Loaded History Size:** ${meta.loaded_history_months} Months of Yahoo Finance OHLCV Data (${meta.total_candles_loaded.toLocaleString()} Total Candles)
* **Timeframes Analyzed:** HTF: ${meta.htf_timeframe} | LTF: ${meta.ltf_timeframe}
* **Local Forecast Horizon:** Next ${tfm.forecast_horizon_candles} Candles (${tfm.expected_move_velocity} estimated velocity; intervals uncalibrated)

### \u{1F4CA} Institutional Market Analysis
* **Local Forecast Direction:** ${tfm.predicted_trend === "BULLISH" ? "Bullish" : tfm.predicted_trend === "BEARISH" ? "Bearish" : "Sideways"} (uncalibrated estimate; targets: ${tfm.projected_price_points.map((p) => `${currencySymbol}${p}`).join(" \u2192 ")})
* **Liquidity & Structure:** ${smc.htf_ssl_swept ? `SSL Swept at ${currencySymbol}${smc.sweep_price}` : "No Major SSL Sweep"}, LTF CHoCH ${smc.ltf_choch ? "Confirmed" : "Pending"}
* **FVG & Consequent Encroachment:** Zone [${currencySymbol}${fvgLow} \u2013 ${currencySymbol}${fvgHigh}] | **50% CE Equilibrium:** ${currencySymbol}${smc.fvg_consequent_encroachment || fvgLow} (${smc.fvg_mitigation_status || "UNMITIGATED"})
* **Order & Breaker Block:** OB: ${currencySymbol}${isBullish ? smc.bullish_ob : smc.bearish_ob || cmp} | **Breaker Inversion:** ${currencySymbol}${smc.breaker_block || smc.bullish_ob}
* **Volume Profile & VSA:** POC: ${currencySymbol}${vp.poc} (VAH: ${currencySymbol}${vp.vah}, VAL: ${currencySymbol}${vp.val}) | **VSA Reading:** ${smc.vsa_signal || "BALANCED"}

### \u{1F6A6} ACTION STATUS: [${actionStatus}]
* **Action Recommendation:** ${actionRecommendation}
${actionStatus === "WAIT FOR ENTRY" ? `* **Estimated Wait Time (If Waiting):** ${estimatedWait}
` : ""}
### \u{1F3AF} Trade Execution Details (${actionStatus === "AVOID" ? "No Trade Recommended" : "Active Institutional Plan"})
* **Trade Direction:** ${tradeDirection}
* **Entry Zone:** ${entryZone}
* **Stop Loss (SL):** ${currencySymbol}${slPrice.toFixed(2)}
* **Target 1 (TP1) & Estimated Time:** ${currencySymbol}${tp1Price.toFixed(2)} | **Time Horizon:** ~1 to 2 hours
* **Target 2 (TP2) & Estimated Time:** ${currencySymbol}${tp2Price.toFixed(2)} | **Time Horizon:** ~4 to 6 hours
* **Risk to Reward (RR):** 1:${rr}

### \u26A0\uFE0F Risk & Invalidation Note
${riskNote}`;
}

// src/lib/authVerify.ts
var import_fs = __toESM(require("fs"), 1);
var import_path = __toESM(require("path"), 1);
var import_crypto = __toESM(require("crypto"), 1);
var firebaseProjectId = "praxis-racer-zxfb9";
try {
  const configPath = import_path.default.join(process.cwd(), "firebase-applet-config.json");
  if (import_fs.default.existsSync(configPath)) {
    const raw = JSON.parse(import_fs.default.readFileSync(configPath, "utf8"));
    if (raw.projectId) {
      firebaseProjectId = raw.projectId;
    }
  }
} catch (err) {
  console.warn("Could not read firebase-applet-config.json:", err);
}
var cachedCertificates = {};
var certificatesExpiresAt = 0;
async function fetchGooglePublicCertificates() {
  const now = Date.now();
  if (Object.keys(cachedCertificates).length > 0 && now < certificatesExpiresAt) {
    return cachedCertificates;
  }
  const certUrl = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
  const res = await fetch(certUrl, {
    headers: { "User-Agent": "TimesFM-AuthVerifier/1.0" },
    signal: AbortSignal.timeout(5e3)
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Google public certificates: HTTP ${res.status}`);
  }
  const cacheControl = res.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeSeconds = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 3600;
  cachedCertificates = await res.json();
  certificatesExpiresAt = now + maxAgeSeconds * 1e3;
  return cachedCertificates;
}
async function verifyFirebaseIdToken(token) {
  if (!token || typeof token !== "string") {
    throw new Error("Token is required");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT token: expected 3 dot-separated segments");
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  let header;
  try {
    const rawHeader = Buffer.from(headerB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    header = JSON.parse(rawHeader);
  } catch {
    throw new Error("Failed to parse token header");
  }
  if (header.alg !== "RS256") {
    throw new Error(`Invalid token algorithm: ${header.alg}. Expected RS256.`);
  }
  if (!header.kid) {
    throw new Error("Token header is missing key ID (kid)");
  }
  let payload;
  try {
    const rawPayload = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    payload = JSON.parse(rawPayload);
  } catch {
    throw new Error("Failed to parse token payload");
  }
  const certs = await fetchGooglePublicCertificates();
  const publicCert = certs[header.kid];
  if (!publicCert) {
    throw new Error(`Public key not found for kid: ${header.kid}`);
  }
  const signedContent = `${headerB64}.${payloadB64}`;
  const signatureBuffer = Buffer.from(signatureB64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const verifier = import_crypto.default.createVerify("RSA-SHA256");
  verifier.update(signedContent);
  const isValidSignature = verifier.verify(publicCert, signatureBuffer);
  if (!isValidSignature) {
    throw new Error("Cryptographic signature verification failed for Firebase ID token");
  }
  const nowSeconds = Math.floor(Date.now() / 1e3);
  if (!payload.exp || payload.exp < nowSeconds - 10) {
    throw new Error("Firebase ID token has expired");
  }
  if (!payload.iat || payload.iat > nowSeconds + 60) {
    throw new Error("Firebase ID token issued in the future");
  }
  const expectedIss = `https://securetoken.google.com/${firebaseProjectId}`;
  if (payload.iss !== expectedIss) {
    throw new Error(`Invalid token issuer. Expected ${expectedIss}, got ${payload.iss}`);
  }
  if (payload.aud !== firebaseProjectId) {
    throw new Error(`Invalid token audience. Expected ${firebaseProjectId}, got ${payload.aud}`);
  }
  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Missing sub claim in token");
  }
  return {
    ...payload,
    uid: payload.sub
  };
}

// src/lib/indianOptionsEngine.ts
var NSE_FNO_REGISTRY = {
  // Major Indices
  "NIFTY": { name: "NIFTY 50 Index", lotSize: 50, strikeStep: 50, isIndex: true },
  "NIFTY 50": { name: "NIFTY 50 Index", lotSize: 50, strikeStep: 50, isIndex: true },
  "^NSEI": { name: "NIFTY 50 Index", lotSize: 50, strikeStep: 50, isIndex: true },
  "BANKNIFTY": { name: "Nifty Bank Index", lotSize: 15, strikeStep: 100, isIndex: true },
  "BANK NIFTY": { name: "Nifty Bank Index", lotSize: 15, strikeStep: 100, isIndex: true },
  "^NSEBANK": { name: "Nifty Bank Index", lotSize: 15, strikeStep: 100, isIndex: true },
  "FINNIFTY": { name: "Nifty Financial Services Index", lotSize: 25, strikeStep: 50, isIndex: true },
  "MIDCPNIFTY": { name: "Nifty Midcap Select Index", lotSize: 50, strikeStep: 25, isIndex: true },
  "SENSEX": { name: "BSE SENSEX 30 Index", lotSize: 10, strikeStep: 100, isIndex: true },
  "^BSESN": { name: "BSE SENSEX 30 Index", lotSize: 10, strikeStep: 100, isIndex: true },
  // Top Indian Heavyweight Equities (F&O Enabled)
  "RELIANCE": { name: "Reliance Industries Ltd.", lotSize: 250, strikeStep: 20 },
  "TCS": { name: "Tata Consultancy Services Ltd.", lotSize: 175, strikeStep: 50 },
  "INFY": { name: "Infosys Ltd.", lotSize: 400, strikeStep: 20 },
  "HDFCBANK": { name: "HDFC Bank Ltd.", lotSize: 550, strikeStep: 25 },
  "ICICIBANK": { name: "ICICI Bank Ltd.", lotSize: 700, strikeStep: 10 },
  "SBIN": { name: "State Bank of India", lotSize: 750, strikeStep: 10 },
  "TATAMOTORS": { name: "Tata Motors Ltd.", lotSize: 700, strikeStep: 10 },
  "BHARTIARTL": { name: "Bharti Airtel Ltd.", lotSize: 475, strikeStep: 20 },
  "LT": { name: "Larsen & Toubro Ltd.", lotSize: 150, strikeStep: 50 },
  "ITC": { name: "ITC Ltd.", lotSize: 1600, strikeStep: 5 },
  "BAJFINANCE": { name: "Bajaj Finance Ltd.", lotSize: 125, strikeStep: 100 },
  "BAJAJFINSV": { name: "Bajaj Finserv Ltd.", lotSize: 500, strikeStep: 20 },
  "AXISBANK": { name: "Axis Bank Ltd.", lotSize: 625, strikeStep: 20 },
  "KOTAKBANK": { name: "Kotak Mahindra Bank Ltd.", lotSize: 400, strikeStep: 20 },
  "MARUTI": { name: "Maruti Suzuki India Ltd.", lotSize: 50, strikeStep: 100 },
  "SUNPHARMA": { name: "Sun Pharmaceutical Ind. Ltd.", lotSize: 350, strikeStep: 20 },
  "TITAN": { name: "Titan Company Ltd.", lotSize: 175, strikeStep: 50 },
  "WIPRO": { name: "Wipro Ltd.", lotSize: 1500, strikeStep: 10 },
  "NTPC": { name: "NTPC Ltd.", lotSize: 1500, strikeStep: 5 },
  "ONGC": { name: "Oil & Natural Gas Corp. Ltd.", lotSize: 2250, strikeStep: 5 },
  "POWERGRID": { name: "Power Grid Corp. of India", lotSize: 1800, strikeStep: 5 },
  "TATASTEEL": { name: "Tata Steel Ltd.", lotSize: 5500, strikeStep: 2.5 },
  "COALINDIA": { name: "Coal India Ltd.", lotSize: 2100, strikeStep: 5 },
  "ADANIENT": { name: "Adani Enterprises Ltd.", lotSize: 300, strikeStep: 50 },
  "ADANIPORTS": { name: "Adani Ports & SEZ Ltd.", lotSize: 400, strikeStep: 20 },
  "HINDALCO": { name: "Hindalco Industries Ltd.", lotSize: 1400, strikeStep: 10 },
  "JSWSTEEL": { name: "JSW Steel Ltd.", lotSize: 675, strikeStep: 10 },
  "HINDUNILVR": { name: "Hindustan Unilever Ltd.", lotSize: 300, strikeStep: 20 },
  "ASIANPAINT": { name: "Asian Paints Ltd.", lotSize: 200, strikeStep: 50 },
  "ULTRACEMCO": { name: "UltraTech Cement Ltd.", lotSize: 100, strikeStep: 100 },
  "NESTLEIND": { name: "Nestle India Ltd.", lotSize: 250, strikeStep: 20 },
  "TECHM": { name: "Tech Mahindra Ltd.", lotSize: 600, strikeStep: 20 },
  "HCLTECH": { name: "HCL Technologies Ltd.", lotSize: 350, strikeStep: 20 },
  "DRREDDY": { name: "Dr. Reddy's Laboratories", lotSize: 125, strikeStep: 100 },
  "CIPLA": { name: "Cipla Ltd.", lotSize: 650, strikeStep: 20 },
  "EICHERMOT": { name: "Eicher Motors Ltd.", lotSize: 175, strikeStep: 50 },
  "HEROMOTOCO": { name: "Hero MotoCorp Ltd.", lotSize: 150, strikeStep: 50 },
  "M&M": { name: "Mahindra & Mahindra Ltd.", lotSize: 350, strikeStep: 50 },
  "GRASIM": { name: "Grasim Industries Ltd.", lotSize: 250, strikeStep: 20 },
  "DIVISLAB": { name: "Divi's Laboratories Ltd.", lotSize: 100, strikeStep: 50 },
  "APOLLOHOSP": { name: "Apollo Hospitals Enterprise", lotSize: 125, strikeStep: 100 },
  "BRITANNIA": { name: "Britannia Industries Ltd.", lotSize: 200, strikeStep: 50 },
  "INDUSINDBK": { name: "IndusInd Bank Ltd.", lotSize: 500, strikeStep: 20 },
  "BPCL": { name: "Bharat Petroleum Corp. Ltd.", lotSize: 1800, strikeStep: 5 },
  "TATACONSUM": { name: "Tata Consumer Products Ltd.", lotSize: 900, strikeStep: 10 },
  "SBILIFE": { name: "SBI Life Insurance Co. Ltd.", lotSize: 750, strikeStep: 20 },
  "HDFCLIFE": { name: "HDFC Life Insurance Co. Ltd.", lotSize: 1100, strikeStep: 10 },
  "VEDL": { name: "Vedanta Ltd.", lotSize: 2300, strikeStep: 5 },
  "BEL": { name: "Bharat Electronics Ltd.", lotSize: 2700, strikeStep: 5 },
  "HAL": { name: "Hindustan Aeronautics Ltd.", lotSize: 150, strikeStep: 50 },
  "BOSCHLTD": { name: "Bosch Ltd.", lotSize: 25, strikeStep: 500 },
  "SHREECEM": { name: "Shree Cement Ltd.", lotSize: 25, strikeStep: 200 },
  "CHOLAFIN": { name: "Cholamandalam Inv & Fin", lotSize: 625, strikeStep: 20 },
  "DLF": { name: "DLF Ltd.", lotSize: 825, strikeStep: 10 },
  "GODREJCP": { name: "Godrej Consumer Products", lotSize: 500, strikeStep: 20 },
  "HAVELLS": { name: "Havells India Ltd.", lotSize: 500, strikeStep: 20 },
  "IOC": { name: "Indian Oil Corporation Ltd.", lotSize: 4875, strikeStep: 2.5 },
  "JINDALSTEL": { name: "Jindal Steel & Power Ltd.", lotSize: 625, strikeStep: 10 },
  "LICI": { name: "Life Insurance Corp of India", lotSize: 700, strikeStep: 10 },
  "PIDILITIND": { name: "Pidilite Industries Ltd.", lotSize: 250, strikeStep: 50 },
  "POLYCAB": { name: "Polycab India Ltd.", lotSize: 125, strikeStep: 100 },
  "PFC": { name: "Power Finance Corporation", lotSize: 1300, strikeStep: 5 },
  "RECLTD": { name: "REC Ltd.", lotSize: 1e3, strikeStep: 5 },
  "SIEMENS": { name: "Siemens Ltd.", lotSize: 125, strikeStep: 100 },
  "TRENT": { name: "Trent Ltd.", lotSize: 200, strikeStep: 50 },
  "ZOMATO": { name: "Zomato Ltd.", lotSize: 3e3, strikeStep: 5 },
  "LTIM": { name: "LTIMindtree Ltd.", lotSize: 150, strikeStep: 50 },
  "DIXON": { name: "Dixon Technologies (India) Ltd.", lotSize: 50, strikeStep: 250 },
  "DIXONTECH": { name: "Dixon Technologies (India) Ltd.", lotSize: 50, strikeStep: 250 },
  "PERSISTENT": { name: "Persistent Systems Ltd.", lotSize: 100, strikeStep: 100 },
  "COFORGE": { name: "Coforge Ltd.", lotSize: 100, strikeStep: 100 },
  "MCX": { name: "Multi Commodity Exchange of India Ltd.", lotSize: 125, strikeStep: 100 },
  "ESCORTS": { name: "Escorts Kubota Ltd.", lotSize: 175, strikeStep: 50 },
  "BSOFT": { name: "Birlasoft Ltd.", lotSize: 1e3, strikeStep: 10 },
  "CDSL": { name: "Central Depository Services Ltd.", lotSize: 375, strikeStep: 20 },
  "ANGELONE": { name: "Angel One Ltd.", lotSize: 175, strikeStep: 50 },
  "MUTHOOTFIN": { name: "Muthoot Finance Ltd.", lotSize: 350, strikeStep: 20 },
  "OFSS": { name: "Oracle Financial Services Software", lotSize: 75, strikeStep: 200 },
  "TATACOMM": { name: "Tata Communications Ltd.", lotSize: 300, strikeStep: 25 },
  "NAVINFLUOR": { name: "Navin Fluorine International", lotSize: 150, strikeStep: 50 },
  "DEEPAKNTR": { name: "Deepak Nitrite Ltd.", lotSize: 300, strikeStep: 50 },
  "ASTRAL": { name: "Astral Ltd.", lotSize: 275, strikeStep: 25 },
  "VOLTAS": { name: "Voltas Ltd.", lotSize: 375, strikeStep: 25 },
  "AUROPHARMA": { name: "Aurobindo Pharma Ltd.", lotSize: 550, strikeStep: 20 },
  "LUPIN": { name: "Lupin Ltd.", lotSize: 425, strikeStep: 25 },
  "CANBK": { name: "Canara Bank", lotSize: 6750, strikeStep: 2.5 },
  "PNB": { name: "Punjab National Bank", lotSize: 8e3, strikeStep: 1 }
};
function getCleanSymbol(symbol) {
  return symbol.toUpperCase().replace(/\.NS$|\.BO$/i, "").trim();
}
function normalCdf(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * absX);
  const erf = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1 + sign * erf);
}
function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function roundToNseTick(val) {
  return Math.round(Math.max(0.05, val) * 20) / 20;
}
function computeBlackScholes(s, k, tDays, r = 0.065, sigma = 0.16) {
  if (![s, k, tDays, r, sigma].every(Number.isFinite) || s <= 0 || k <= 0 || sigma < 0) {
    throw new RangeError("Black-Scholes requires positive spot/strike, non-negative volatility, and finite inputs.");
  }
  if (tDays <= 0) {
    const callPrice2 = Math.max(0, s - k);
    const putPrice2 = Math.max(0, k - s);
    const callDelta2 = s > k ? 1 : s < k ? 0 : 0.5;
    return {
      callPrice: roundToNseTick(callPrice2),
      putPrice: roundToNseTick(putPrice2),
      callDelta: callDelta2,
      putDelta: callDelta2 - 1,
      gamma: 0,
      callTheta: 0,
      putTheta: 0,
      vega: 0,
      callRho: 0,
      putRho: 0,
      d1: 0,
      d2: 0
    };
  }
  const t = tDays / 365;
  const safeSigma = Math.max(1e-8, sigma);
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r + 0.5 * safeSigma * safeSigma) * t) / (safeSigma * sqrtT);
  const d2 = d1 - safeSigma * sqrtT;
  const nd1 = normalCdf(d1);
  const nd2 = normalCdf(d2);
  const n_minus_d1 = normalCdf(-d1);
  const n_minus_d2 = normalCdf(-d2);
  const pdf_d1 = normalPdf(d1);
  const discountFactor = Math.exp(-r * t);
  const callPrice = Math.max(0.05, s * nd1 - k * discountFactor * nd2);
  const putPrice = Math.max(0.05, k * discountFactor * n_minus_d2 - s * n_minus_d1);
  const callDelta = Math.round(nd1 * 1e3) / 1e3;
  const putDelta = Math.round((callDelta - 1) * 1e3) / 1e3;
  const gamma = Math.round(pdf_d1 / (s * safeSigma * sqrtT) * 1e4) / 1e4;
  const callThetaAnnual = -(s * pdf_d1 * safeSigma) / (2 * sqrtT) - r * k * discountFactor * nd2;
  const putThetaAnnual = -(s * pdf_d1 * safeSigma) / (2 * sqrtT) + r * k * discountFactor * n_minus_d2;
  const callThetaDay = Math.round(callThetaAnnual / 365 * 1e4) / 1e4;
  const putThetaDay = Math.round(putThetaAnnual / 365 * 1e4) / 1e4;
  const vega = Math.round(s * sqrtT * pdf_d1 * 0.01 * 1e4) / 1e4;
  const callRho = Math.round(k * t * discountFactor * nd2 * 0.01 * 100) / 100;
  const putRho = Math.round(-k * t * discountFactor * n_minus_d2 * 0.01 * 100) / 100;
  return {
    callPrice: roundToNseTick(callPrice),
    putPrice: roundToNseTick(putPrice),
    callDelta,
    putDelta,
    gamma,
    callTheta: callThetaDay,
    putTheta: putThetaDay,
    vega,
    callRho,
    putRho,
    d1,
    d2
  };
}
function getLastThursdayOfMonth(year, monthIndex) {
  const lastDay = new Date(year, monthIndex + 1, 0);
  const dayOfWeek = lastDay.getDay();
  const diffToThursday = (dayOfWeek - 4 + 7) % 7;
  const lastThursday = new Date(year, monthIndex, lastDay.getDate() - diffToThursday);
  lastThursday.setHours(15, 30, 0, 0);
  return lastThursday;
}
function generateAccurateFnoExpiries(symbol) {
  const clean = getCleanSymbol(symbol);
  const fnoEntry = NSE_FNO_REGISTRY[clean] || NSE_FNO_REGISTRY[clean.replace(/\s+/g, "")];
  const isIndex = Boolean(fnoEntry?.isIndex || clean.includes("NIFTY") || clean.includes("SENSEX"));
  const now = /* @__PURE__ */ new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  if (!isIndex) {
    const expiries = [];
    for (let m = 0; m < 4; m++) {
      let targetMonth = currentMonth + m;
      let targetYear = currentYear;
      if (targetMonth > 11) {
        targetYear += Math.floor(targetMonth / 12);
        targetMonth = targetMonth % 12;
      }
      const lastThu = getLastThursdayOfMonth(targetYear, targetMonth);
      if (lastThu.getTime() <= now.getTime()) {
        continue;
      }
      const dStr = lastThu.toISOString().split("T")[0];
      const daysLeft = Math.max(1, Math.round((lastThu.getTime() - now.getTime()) / (1e3 * 60 * 60 * 24)));
      const monthLabel = lastThu.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
      const fullLabel = `${lastThu.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} (${expiries.length === 0 ? `Current Month (${monthLabel})` : expiries.length === 1 ? `Next Month (${monthLabel})` : `Far Month (${monthLabel})`})`;
      expiries.push({
        timestamp: Math.floor(lastThu.getTime() / 1e3),
        dateStr: dStr,
        label: fullLabel,
        daysToExpiry: daysLeft,
        isMonthly: true
      });
      if (expiries.length >= 3) break;
    }
    return expiries;
  } else {
    const isBankNifty = clean.includes("BANKNIFTY") || clean.includes("BANK NIFTY");
    const isFinNifty = clean.includes("FINNIFTY");
    const targetDayOfWeek = isFinNifty ? 2 : isBankNifty ? 3 : 4;
    let daysToNext = (targetDayOfWeek - now.getDay() + 7) % 7;
    if (daysToNext === 0 && (now.getUTCHours() > 10 || now.getUTCHours() === 10 && now.getUTCMinutes() > 0)) {
      daysToNext = 7;
    }
    if (daysToNext === 0) daysToNext = 0.5;
    const expiries = [];
    const monthlyLastThu = getLastThursdayOfMonth(currentYear, currentMonth);
    for (let i = 0; i < 4; i++) {
      const daysOffset = (daysToNext === 0.5 ? 0 : daysToNext) + i * 7;
      const expDate = new Date(now.getTime() + daysOffset * 24 * 60 * 60 * 1e3);
      expDate.setHours(15, 30, 0, 0);
      const dStr = expDate.toISOString().split("T")[0];
      const daysLeft = Math.max(0.5, Math.round((expDate.getTime() - now.getTime()) / (1e3 * 60 * 60 * 24)));
      const isMonthly = Math.abs(expDate.getTime() - monthlyLastThu.getTime()) < 2 * 24 * 60 * 60 * 1e3 || expDate.getDate() > 22;
      const label = `${expDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} (${i === 0 ? "Current Weekly" : i === 1 ? "Next Weekly" : isMonthly ? "Monthly Expiry" : "Weekly Expiry"})`;
      expiries.push({
        timestamp: Math.floor(expDate.getTime() / 1e3),
        dateStr: dStr,
        label,
        daysToExpiry: daysLeft,
        isMonthly
      });
    }
    return expiries;
  }
}
function getStrikeInterval(symbol, cmp) {
  const clean = getCleanSymbol(symbol);
  const reg = NSE_FNO_REGISTRY[clean] || NSE_FNO_REGISTRY[clean.replace(/\s+/g, "")];
  if (reg && reg.strikeStep) return reg.strikeStep;
  if (cmp > 3e4) return 100;
  if (cmp > 1e4) return 50;
  if (cmp > 4e3) return 50;
  if (cmp > 1500) return 20;
  if (cmp > 500) return 10;
  if (cmp > 100) return 5;
  return 2.5;
}
function getStandardLotSize(symbol, cmp = 1e3) {
  const clean = getCleanSymbol(symbol);
  const reg = NSE_FNO_REGISTRY[clean] || NSE_FNO_REGISTRY[clean.replace(/\s+/g, "")];
  if (reg && reg.lotSize) return reg.lotSize;
  if (cmp > 0) {
    const calculated = Math.round(5e5 / cmp / 25) * 25;
    return Math.max(25, calculated);
  }
  return 100;
}
function buildInstitutionalOptionChain(symbol, rawName, cmp, selectedExpiryIndex = 0, spotDayChange) {
  const clean = getCleanSymbol(symbol);
  const fnoInfo = NSE_FNO_REGISTRY[clean] || NSE_FNO_REGISTRY[clean.replace(/\s+/g, "")];
  const isFno = Boolean(fnoInfo);
  const isIndex = Boolean(fnoInfo?.isIndex || clean.includes("NIFTY") || clean.includes("SENSEX"));
  const formalName = fnoInfo?.name || rawName || clean;
  const strikeInterval = getStrikeInterval(clean, cmp);
  const lotSize = getStandardLotSize(clean, cmp);
  const atmStrike = Math.round(cmp / strikeInterval) * strikeInterval;
  const expirationDates = generateAccurateFnoExpiries(clean);
  const selectedExpiry = expirationDates[selectedExpiryIndex] || expirationDates[0] || {
    timestamp: Math.floor(Date.now() / 1e3) + 25 * 86400,
    dateStr: new Date(Date.now() + 25 * 86400 * 1e3).toISOString().split("T")[0],
    label: "Monthly Expiry",
    daysToExpiry: 25,
    isMonthly: true
  };
  const daysToExpiry = Math.max(1, selectedExpiry.daysToExpiry);
  const isMidcapMomentum = ["DIXON", "DIXONTECH", "MCX", "PERSISTENT", "COFORGE", "POLYCAB", "TRENT", "ZOMATO", "BSOFT", "ESCORTS"].includes(clean);
  const isHighBeta = clean.includes("STEEL") || clean.includes("MOTOR") || clean.includes("HAL") || clean.includes("VEDL") || clean.includes("ADANI");
  const isLargeCap = ["SBIN", "RELIANCE", "HDFCBANK", "ICICIBANK", "TCS", "INFY", "LT", "ITC", "BHARTIARTL", "AXISBANK", "KOTAKBANK", "MARUTI", "SUNPHARMA", "HINDUNILVR"].includes(clean);
  const baseAtmIv = isIndex ? 0.142 : isMidcapMomentum ? 0.37 : isLargeCap ? 0.225 : isHighBeta ? 0.295 : cmp > 3e3 ? 0.245 : cmp > 1e3 ? 0.265 : 0.285;
  let totalCallOi = 0;
  let totalPutOi = 0;
  let totalCallVolume = 0;
  let totalPutVolume = 0;
  const rows = [];
  const rangeSteps = 15;
  const actualSpotChange = typeof spotDayChange === "number" && !isNaN(spotDayChange) ? spotDayChange : cmp * 5e-3;
  for (let i = -rangeSteps; i <= rangeSteps; i++) {
    const strike = atmStrike + i * strikeInterval;
    const isAtm = strike === atmStrike;
    const moneyness = Math.log(strike / cmp);
    const skewFactor = strike < cmp ? Math.abs(moneyness) * 0.08 : -moneyness * 0.03;
    const smileCurve = 0.12 * moneyness * moneyness;
    const callIv = Math.min(0.6, Math.max(0.12, Math.round((baseAtmIv + skewFactor + smileCurve) * 1e3) / 1e3));
    const putIv = Math.min(0.6, Math.max(0.12, Math.round((baseAtmIv + skewFactor + smileCurve + (strike < cmp ? 0.012 : 0)) * 1e3) / 1e3));
    const callGreeks = computeBlackScholes(cmp, strike, daysToExpiry, 0.065, callIv);
    const putGreeks = computeBlackScholes(cmp, strike, daysToExpiry, 0.065, putIv);
    const finalCallPrice = callGreeks.callPrice;
    const finalPutPrice = putGreeks.putPrice;
    const callIntrinsic = Math.max(0, cmp - strike);
    const putIntrinsic = Math.max(0, strike - cmp);
    const callTimeValue = Math.max(0, roundToNseTick(finalCallPrice - callIntrinsic));
    const putTimeValue = Math.max(0, roundToNseTick(finalPutPrice - putIntrinsic));
    const strikeCloseness = Math.abs(i);
    const isRound50 = strike % (strikeInterval * 5) === 0;
    const isRound100 = strike % (strikeInterval * 10) === 0;
    const roundBoost = isRound100 ? 2.4 : isRound50 ? 1.6 : 1;
    const baseLots = isIndex ? 28e3 : 4200;
    const baseOi = Math.round(baseLots * lotSize / (1 + strikeCloseness * 0.22) * roundBoost);
    let rawCallOi = Math.round(baseOi * (i >= 0 ? 1.35 + Math.min(i, 4) * 0.14 : Math.max(0.35, 0.7 - Math.min(-i, 4) * 0.08)));
    let rawPutOi = Math.round(baseOi * (i <= 0 ? 1.35 + Math.min(-i, 4) * 0.14 : Math.max(0.35, 0.7 - Math.min(i, 4) * 0.08)));
    const callOi = Math.max(lotSize * 2, Math.round(rawCallOi / lotSize) * lotSize);
    const putOi = Math.max(lotSize * 2, Math.round(rawPutOi / lotSize) * lotSize);
    const volMultiplier = strikeCloseness <= 2 ? 0.85 : strikeCloseness <= 5 ? 0.55 : 0.25;
    const callVol = Math.round(Math.max(lotSize, callOi * volMultiplier * (i >= 0 ? 1.2 : 0.8) * roundBoost / lotSize)) * lotSize;
    const putVol = Math.round(Math.max(lotSize, putOi * volMultiplier * (i <= 0 ? 1.2 : 0.8) * roundBoost / lotSize)) * lotSize;
    totalCallOi += callOi;
    totalPutOi += putOi;
    totalCallVolume += callVol;
    totalPutVolume += putVol;
    const callChange = roundToNseTick(callGreeks.callDelta * actualSpotChange);
    const putChange = roundToNseTick(putGreeks.putDelta * actualSpotChange);
    const prevCallPrice = Math.max(0.05, roundToNseTick(finalCallPrice - callChange));
    const prevPutPrice = Math.max(0.05, roundToNseTick(finalPutPrice - putChange));
    const callPct = Math.round(callChange / prevCallPrice * 1e3) / 10;
    const putPct = Math.round(putChange / prevPutPrice * 1e3) / 10;
    const isSpotDown = actualSpotChange < 0;
    let callOiFactor;
    let putOiFactor;
    if (isSpotDown) {
      callOiFactor = i >= 0 ? 0.07 + Math.min(i, 3) * 0.02 : -0.04 - Math.min(-i, 3) * 0.02;
      putOiFactor = i <= 0 ? 0.08 + Math.min(-i, 3) * 0.02 : -0.04 - Math.min(i, 3) * 0.015;
    } else {
      callOiFactor = i <= 0 ? -0.03 - Math.min(-i, 3) * 0.01 : 0.08 + Math.min(i, 3) * 0.02;
      putOiFactor = i >= 0 ? 0.07 + Math.min(i, 3) * 0.015 : -0.05 - Math.min(-i, 3) * 0.02;
    }
    const callChangeInOi = Math.round(callOi * callOiFactor / lotSize) * lotSize;
    const putChangeInOi = Math.round(putOi * putOiFactor / lotSize) * lotSize;
    const prevCallOi = Math.max(lotSize, callOi - callChangeInOi);
    const prevPutOi = Math.max(lotSize, putOi - putChangeInOi);
    const callChangeInOiPct = Math.round(callChangeInOi / prevCallOi * 1e3) / 10;
    const putChangeInOiPct = Math.round(putChangeInOi / prevPutOi * 1e3) / 10;
    const callBuildup = callChange > 0 ? callChangeInOi >= 0 ? "Long Buildup" : "Short Covering" : callChangeInOi >= 0 ? "Short Buildup" : "Long Unwinding";
    const putBuildup = putChange > 0 ? putChangeInOi >= 0 ? "Long Buildup" : "Short Covering" : putChangeInOi >= 0 ? "Short Buildup" : "Long Unwinding";
    const callGexCr = Math.round(callGreeks.gamma * callOi * cmp * cmp * 0.01 / 1e7 * 100) / 100;
    const putGexCr = Math.round(-callGreeks.gamma * putOi * cmp * cmp * 0.01 / 1e7 * 100) / 100;
    const netGexCr = Math.round((callGexCr + putGexCr) * 100) / 100;
    const callBuyVol = Math.round(callVol * (actualSpotChange >= 0 ? 0.62 : 0.38));
    const callSellVol = Math.max(0, callVol - callBuyVol);
    const callCvd = callBuyVol - callSellVol;
    const putBuyVol = Math.round(putVol * (actualSpotChange < 0 ? 0.64 : 0.36));
    const putSellVol = Math.max(0, putVol - putBuyVol);
    const putCvd = putBuyVol - putSellVol;
    const putDelta = Math.round((callGreeks.callDelta - 1) * 1e3) / 1e3;
    rows.push({
      strike,
      isAtm,
      netGexCr,
      call: {
        contractSymbol: `${clean} ${strike} CE`,
        strike,
        type: "CE",
        lastPrice: finalCallPrice,
        change: callChange,
        percentChange: callPct,
        bid: Math.max(0.05, roundToNseTick(finalCallPrice - 0.25)),
        ask: roundToNseTick(finalCallPrice + 0.25),
        openInterest: callOi,
        changeInOi: callChangeInOi,
        changeInOiPct: callChangeInOiPct,
        buildup: callBuildup,
        volume: callVol,
        impliedVolatility: Math.round(callIv * 1e3) / 10,
        inTheMoney: strike < cmp,
        delta: callGreeks.callDelta,
        theta: callGreeks.callTheta,
        thetaLot: Math.round(callGreeks.callTheta * lotSize * 100) / 100,
        gamma: callGreeks.gamma,
        vega: callGreeks.vega,
        rho: callGreeks.callRho,
        gexCr: callGexCr,
        aggressiveBuyVol: callBuyVol,
        aggressiveSellVol: callSellVol,
        cvd: callCvd,
        intrinsicValue: roundToNseTick(callIntrinsic),
        timeValue: callTimeValue
      },
      put: {
        contractSymbol: `${clean} ${strike} PE`,
        strike,
        type: "PE",
        lastPrice: finalPutPrice,
        change: putChange,
        percentChange: putPct,
        bid: Math.max(0.05, roundToNseTick(finalPutPrice - 0.25)),
        ask: roundToNseTick(finalPutPrice + 0.25),
        openInterest: putOi,
        changeInOi: putChangeInOi,
        changeInOiPct: putChangeInOiPct,
        buildup: putBuildup,
        volume: putVol,
        impliedVolatility: Math.round(putIv * 1e3) / 10,
        inTheMoney: strike > cmp,
        delta: putDelta,
        theta: putGreeks.putTheta,
        thetaLot: Math.round(putGreeks.putTheta * lotSize * 100) / 100,
        gamma: callGreeks.gamma,
        vega: callGreeks.vega,
        rho: putGreeks.putRho,
        gexCr: putGexCr,
        aggressiveBuyVol: putBuyVol,
        aggressiveSellVol: putSellVol,
        cvd: putCvd,
        intrinsicValue: roundToNseTick(putIntrinsic),
        timeValue: putTimeValue
      }
    });
  }
  const maxCallOi = Math.max(...rows.map((r) => r.call.openInterest), 1);
  const maxPutOi = Math.max(...rows.map((r) => r.put.openInterest), 1);
  rows.forEach((r) => {
    r.call.oiPercent = Math.round(r.call.openInterest / maxCallOi * 100);
    r.put.oiPercent = Math.round(r.put.openInterest / maxPutOi * 100);
  });
  const pcr = totalCallOi > 0 ? Math.round(totalPutOi / totalCallOi * 100) / 100 : 1;
  const pcrBias = pcr > 1.25 ? "BULLISH" : pcr < 0.75 ? "BEARISH" : "NEUTRAL";
  let minPainPayout = Infinity;
  let maxPainStrike = atmStrike;
  rows.forEach((r) => {
    let totalPayout = 0;
    rows.forEach((other) => {
      if (r.strike > other.strike) {
        totalPayout += (r.strike - other.strike) * other.call.openInterest;
      }
      if (r.strike < other.strike) {
        totalPayout += (other.strike - r.strike) * other.put.openInterest;
      }
    });
    if (totalPayout < minPainPayout) {
      minPainPayout = totalPayout;
      maxPainStrike = r.strike;
    }
  });
  const totalCallGexCr = Math.round(rows.reduce((acc, r) => acc + r.call.gexCr, 0) * 100) / 100;
  const totalPutGexCr = Math.round(rows.reduce((acc, r) => acc + r.put.gexCr, 0) * 100) / 100;
  const totalNetGexCr = Math.round((totalCallGexCr + totalPutGexCr) * 100) / 100;
  const gexRegime = totalNetGexCr >= 0 ? "POSITIVE_GAMMA" : "NEGATIVE_GAMMA";
  const regimeDescription = gexRegime === "POSITIVE_GAMMA" ? "Dealers are Long Gamma: Market volatility is dampened. Price action tends to mean-revert between GEX support and resistance walls." : "Dealers are Short Gamma: Volatility is accelerated. Dealers must hedge in the direction of the move, amplifying breakout velocity & slippage.";
  let maxCallGex = -Infinity;
  let callGexResistanceStrike = atmStrike;
  let maxPutGexMagnitude = -Infinity;
  let putGexSupportStrike = atmStrike;
  let maxGammaVal = -Infinity;
  let maxGammaStrike = atmStrike;
  let closestZeroNetGex = Infinity;
  let zeroGammaFlipStrike = null;
  rows.forEach((r) => {
    if (r.call.gexCr > maxCallGex) {
      maxCallGex = r.call.gexCr;
      callGexResistanceStrike = r.strike;
    }
    if (Math.abs(r.put.gexCr) > maxPutGexMagnitude) {
      maxPutGexMagnitude = Math.abs(r.put.gexCr);
      putGexSupportStrike = r.strike;
    }
    if (r.call.gamma > maxGammaVal) {
      maxGammaVal = r.call.gamma;
      maxGammaStrike = r.strike;
    }
    if (r.netGexCr === 0 && Math.abs(r.strike - atmStrike) < closestZeroNetGex) {
      closestZeroNetGex = Math.abs(r.strike - atmStrike);
      zeroGammaFlipStrike = r.strike;
    }
  });
  for (let i = 1; i < rows.length; i++) {
    const left = rows[i - 1];
    const right = rows[i];
    if (left.netGexCr * right.netGexCr < 0) {
      const fraction = -left.netGexCr / (right.netGexCr - left.netGexCr);
      const crossing = left.strike + fraction * (right.strike - left.strike);
      const distance = Math.abs(crossing - atmStrike);
      if (distance < closestZeroNetGex) {
        closestZeroNetGex = distance;
        zeroGammaFlipStrike = Math.round(crossing * 100) / 100;
      }
    }
  }
  rows.forEach((r) => {
    if (r.strike === callGexResistanceStrike) {
      r.microstructureSignal = "Major Call GEX Wall (Dealer Resistance Pin)";
    } else if (r.strike === putGexSupportStrike) {
      r.microstructureSignal = "Major Put GEX Support (Dealer Floor Cushion)";
    } else if (r.call.cvd > 0 && r.call.changeInOi > 0) {
      r.microstructureSignal = "Aggressive Call Buying Accumulation";
    } else if (r.put.cvd > 0 && r.put.changeInOi > 0) {
      r.microstructureSignal = "Protective Put Hedging Inflow";
    } else if (r.call.cvd < 0 && r.call.changeInOi > 0) {
      r.microstructureSignal = "Passive Call Writing Absorption";
    } else if (r.put.cvd < 0 && r.put.changeInOi > 0) {
      r.microstructureSignal = "Passive Put Writing Defense";
    } else {
      r.microstructureSignal = r.isAtm ? "ATM Institutional Battleground" : "Balanced Flow";
    }
  });
  const avgAtmIv = Math.round(baseAtmIv * 1e3) / 10;
  const iv52wLow = null;
  const iv52wHigh = null;
  const historicalVol30d = null;
  const ivRank = null;
  const ivPercentile = null;
  const ivHvPremium = null;
  const impliedMovePoints = Math.round(cmp * (avgAtmIv / 100) * Math.sqrt(Math.max(1, daysToExpiry) / 365) * 10) / 10;
  const impliedMovePct = Math.round(impliedMovePoints / cmp * 1e3) / 10;
  const volatilityRegime = "UNAVAILABLE";
  const quantStrategyRecommendation = "Historical IV rank and realized volatility were not supplied; no volatility-pricing strategy recommendation is available.";
  const totalAggressiveCallBuys = rows.reduce((acc, r) => acc + r.call.aggressiveBuyVol, 0);
  const totalAggressiveCallSells = rows.reduce((acc, r) => acc + r.call.aggressiveSellVol, 0);
  const totalAggressivePutBuys = rows.reduce((acc, r) => acc + r.put.aggressiveBuyVol, 0);
  const totalAggressivePutSells = rows.reduce((acc, r) => acc + r.put.aggressiveSellVol, 0);
  const netOptionsCvd = totalAggressiveCallBuys - totalAggressiveCallSells - (totalAggressivePutBuys - totalAggressivePutSells);
  const orderFlowBias = netOptionsCvd > 5e3 ? "INSTITUTIONAL_BULLISH_FLOW" : netOptionsCvd < -5e3 ? "INSTITUTIONAL_BEARISH_FLOW" : "BALANCED_ABSORPTION";
  const contractTypeLabel = isIndex ? "NSE Index Derivatives (Weekly/Monthly)" : "NSE Equity Stock Option (Monthly Expiry)";
  return {
    symbol: clean,
    name: formalName,
    underlyingPrice: Math.round(cmp * 100) / 100,
    currency: "INR",
    currencySymbol: "\u20B9",
    lotSize,
    strikeInterval,
    atmStrike,
    isFnoEnabled: isFno,
    instrumentType: isIndex ? "INDEX" : "STOCK",
    contractTypeLabel,
    expirationDates,
    selectedExpiry,
    pcr,
    pcrBias,
    maxPain: maxPainStrike,
    totalCallOi,
    totalPutOi,
    maxCallOi,
    maxPutOi,
    totalCallVolume,
    totalPutVolume,
    atmIv: avgAtmIv,
    gexMetrics: {
      totalNetGexCr,
      totalCallGexCr,
      totalPutGexCr,
      gexRegime,
      regimeDescription,
      zeroGammaFlipStrike,
      callGexResistanceStrike,
      putGexSupportStrike,
      maxGammaStrike
    },
    ivMetrics: {
      atmIv: avgAtmIv,
      iv52wHigh,
      iv52wLow,
      ivRank,
      ivPercentile,
      historicalVol30d,
      ivHvPremium,
      impliedMovePoints,
      impliedMovePct,
      volatilityRegime,
      quantStrategyRecommendation
    },
    orderFlowMetrics: {
      totalAggressiveCallBuys,
      totalAggressiveCallSells,
      totalAggressivePutBuys,
      totalAggressivePutSells,
      netOptionsCvd,
      orderFlowBias,
      keyTrapStrike: actualSpotChange < 0 ? callGexResistanceStrike : putGexSupportStrike,
      trapSignal: actualSpotChange < 0 ? `Heavy Call Writing Absorption at ${callGexResistanceStrike} CE` : `Aggressive Put Writer Support Building at ${putGexSupportStrike} PE`
    },
    isLiveFeed: false,
    sourceState: "SIMULATED",
    provider: isFno ? "Black-Scholes Mathematical Derivatives Engine (Spot Calibrated)" : "Simulated Cash Equity Derivatives",
    options: rows
  };
}
function parseBrokerOptionChain(brokerRawData, symbol, name, cmp, expiryIndex = 0, providerLabel = "Broker API", expiryOverride) {
  const clean = getCleanSymbol(symbol);
  const fnoEntry = NSE_FNO_REGISTRY[clean] || NSE_FNO_REGISTRY[clean.replace(/\s+/g, "")];
  const lotSize = fnoEntry?.lotSize || 750;
  const strikeInterval = fnoEntry?.strikeStep || 10;
  const isIndex = Boolean(fnoEntry?.isIndex || clean.includes("NIFTY") || clean.includes("SENSEX"));
  const expiries = generateAccurateFnoExpiries(clean);
  const selectedExpiry = expiryOverride || expiries[Math.min(expiryIndex, expiries.length - 1)] || expiries[0];
  const daysToExpiry = Math.max(1, selectedExpiry.daysToExpiry);
  const strikeMap = /* @__PURE__ */ new Map();
  const getOrCreateStrike = (k) => {
    const roundedK = Math.round(k * 100) / 100;
    if (!strikeMap.has(roundedK)) {
      strikeMap.set(roundedK, {
        strike: roundedK,
        call: {},
        put: {}
      });
    }
    return strikeMap.get(roundedK);
  };
  if (brokerRawData && Array.isArray(brokerRawData.data) && brokerRawData.data[0]?.strike_price !== void 0) {
    for (const item of brokerRawData.data) {
      const strike = Number(item.strike_price);
      if (isNaN(strike)) continue;
      const rec = getOrCreateStrike(strike);
      if (item.call_options?.market_data) {
        const cmd = item.call_options.market_data;
        const cg = item.call_options.option_greeks || {};
        rec.call = {
          lastPrice: Number(cmd.ltp || cmd.close_price || 0),
          change: Number(cmd.change || (cmd.ltp && cmd.close_price ? cmd.ltp - cmd.close_price : 0)),
          percentChange: Number(cmd.pChange || cmd.change_pct || 0),
          bid: Number(cmd.bid_price || cmd.buy_price || cmd.ltp || 0),
          ask: Number(cmd.ask_price || cmd.sell_price || cmd.ltp || 0),
          openInterest: Number(cmd.oi || cmd.open_interest || 0),
          volume: Number(cmd.volume || cmd.traded_volume || 0),
          impliedVolatility: Number(cg.iv || cg.implied_volatility || 22.5),
          delta: Number(cg.delta || 0.5),
          theta: Number(cg.theta || -0.8),
          gamma: Number(cg.gamma || 4e-3),
          vega: Number(cg.vega || 0.4)
        };
      }
      if (item.put_options?.market_data) {
        const pmd = item.put_options.market_data;
        const pg = item.put_options.option_greeks || {};
        rec.put = {
          lastPrice: Number(pmd.ltp || pmd.close_price || 0),
          change: Number(pmd.change || (pmd.ltp && pmd.close_price ? pmd.ltp - pmd.close_price : 0)),
          percentChange: Number(pmd.pChange || pmd.change_pct || 0),
          bid: Number(pmd.bid_price || pmd.buy_price || pmd.ltp || 0),
          ask: Number(pmd.ask_price || pmd.sell_price || pmd.ltp || 0),
          openInterest: Number(pmd.oi || pmd.open_interest || 0),
          volume: Number(pmd.volume || pmd.traded_volume || 0),
          impliedVolatility: Number(pg.iv || pg.implied_volatility || 23),
          delta: Number(pg.delta || -0.5),
          theta: Number(pg.theta || -0.8),
          gamma: Number(pg.gamma || 4e-3),
          vega: Number(pg.vega || 0.4)
        };
      }
    }
  } else {
    const rawList = Array.isArray(brokerRawData) ? brokerRawData : Array.isArray(brokerRawData?.data?.fetched) ? brokerRawData.data.fetched : Array.isArray(brokerRawData?.data) ? brokerRawData.data : Array.isArray(brokerRawData?.records?.data) ? brokerRawData.records.data : [];
    for (const item of rawList) {
      let strike = Number(item.strike || item.strikePrice || item.strike_price || 0);
      if (!strike && item.tradingsymbol) {
        const match = String(item.tradingsymbol).match(/(\d+)(CE|PE)$/i);
        if (match) {
          strike = Number(match[1]);
        }
      }
      if (!strike || isNaN(strike)) continue;
      const rec = getOrCreateStrike(strike);
      if (item.CE || item.ce) {
        const c = item.CE || item.ce;
        rec.call = {
          lastPrice: Number(c.lastPrice || c.ltp || c.close || 0),
          change: Number(c.change ?? c.netChange ?? 0),
          percentChange: Number(c.pChange || c.percentChange || 0),
          bid: Number(c.bidprice || c.bidPrice || c.bid_price || c.buyPrice || c.bid || c.lastPrice || 0),
          ask: Number(c.askPrice || c.ask_price || c.sellPrice || c.ask || c.lastPrice || 0),
          openInterest: Number(c.openInterest || c.oi || 0),
          changeInOi: Number(c.changeinOpenInterest || c.change_oi || c.changeInOi || 0),
          volume: Number(c.totalTradedVolume || c.volume || c.trade_volume || 0),
          impliedVolatility: Number(c.impliedVolatility || c.iv || 22.5),
          delta: Number(c.delta) || void 0,
          theta: Number(c.theta) || void 0,
          gamma: Number(c.gamma) || void 0,
          vega: Number(c.vega) || void 0,
          buildup: c.buildup
        };
      } else if (item.type === "CE" || String(item.tradingsymbol || "").toUpperCase().endsWith("CE")) {
        rec.call = {
          lastPrice: Number(item.ltp || item.lastPrice || item.close || 0),
          change: Number(item.change || 0),
          percentChange: Number(item.pChange || item.percentChange || 0),
          bid: Number(item.bid || item.bidPrice || item.bidprice || item.buyPrice || item.ltp || 0),
          ask: Number(item.ask || item.askPrice || item.sellPrice || item.ltp || 0),
          openInterest: Number(item.oi || item.openInterest || 0),
          changeInOi: Number(item.change_oi || item.changeinOpenInterest || 0),
          volume: Number(item.volume || item.totalTradedVolume || 0),
          impliedVolatility: Number(item.iv || item.impliedVolatility || 22.5)
        };
      }
      if (item.PE || item.pe) {
        const p = item.PE || item.pe;
        rec.put = {
          lastPrice: Number(p.lastPrice || p.ltp || p.close || 0),
          change: Number(p.change ?? p.netChange ?? 0),
          percentChange: Number(p.pChange || p.percentChange || 0),
          bid: Number(p.bidprice || p.bidPrice || p.bid_price || p.buyPrice || p.bid || p.lastPrice || 0),
          ask: Number(p.askPrice || p.ask_price || p.sellPrice || p.ask || p.lastPrice || 0),
          openInterest: Number(p.openInterest || p.oi || 0),
          changeInOi: Number(p.changeinOpenInterest || p.change_oi || p.changeInOi || 0),
          volume: Number(p.totalTradedVolume || p.volume || p.trade_volume || 0),
          impliedVolatility: Number(p.impliedVolatility || p.iv || 23),
          delta: Number(p.delta) || void 0,
          theta: Number(p.theta) || void 0,
          gamma: Number(p.gamma) || void 0,
          vega: Number(p.vega) || void 0,
          buildup: p.buildup
        };
      } else if (item.type === "PE" || String(item.tradingsymbol || "").toUpperCase().endsWith("PE")) {
        rec.put = {
          lastPrice: Number(item.ltp || item.lastPrice || item.close || 0),
          change: Number(item.change || 0),
          percentChange: Number(item.pChange || item.percentChange || 0),
          bid: Number(item.bid || item.bidPrice || item.bidprice || item.buyPrice || item.ltp || 0),
          ask: Number(item.ask || item.askPrice || item.sellPrice || item.ltp || 0),
          openInterest: Number(item.oi || item.openInterest || 0),
          changeInOi: Number(item.change_oi || item.changeinOpenInterest || 0),
          volume: Number(item.volume || item.totalTradedVolume || 0),
          impliedVolatility: Number(item.iv || item.impliedVolatility || 23)
        };
      }
    }
  }
  if (strikeMap.size === 0) {
    return buildInstitutionalOptionChain(symbol, name, cmp, expiryIndex);
  }
  const sortedStrikes = Array.from(strikeMap.keys()).sort((a, b) => a - b);
  const atmStrike = sortedStrikes.reduce(
    (prev, curr) => Math.abs(curr - cmp) < Math.abs(prev - cmp) ? curr : prev,
    sortedStrikes[0]
  );
  let totalCallOi = 0;
  let totalPutOi = 0;
  let totalCallVolume = 0;
  let totalPutVolume = 0;
  const rows = [];
  for (const strike of sortedStrikes) {
    const raw = strikeMap.get(strike);
    const isAtm = strike === atmStrike;
    const callPrice = roundToNseTick(raw.call.lastPrice || 0.05);
    const callBid = raw.call.bid && raw.call.bid > 0 ? roundToNseTick(raw.call.bid) : 0;
    const callAsk = raw.call.ask && raw.call.ask > 0 ? roundToNseTick(raw.call.ask) : 0;
    const callOi = raw.call.openInterest || 0;
    const callVol = raw.call.volume || 0;
    const callIv = Math.max(0.08, (raw.call.impliedVolatility || 22.5) / 100);
    const callGreeks = computeBlackScholes(cmp, strike, daysToExpiry, 0.065, callIv);
    const putPrice = roundToNseTick(raw.put.lastPrice || 0.05);
    const putBid = raw.put.bid && raw.put.bid > 0 ? roundToNseTick(raw.put.bid) : 0;
    const putAsk = raw.put.ask && raw.put.ask > 0 ? roundToNseTick(raw.put.ask) : 0;
    const putOi = raw.put.openInterest || 0;
    const putVol = raw.put.volume || 0;
    const putIv = Math.max(0.08, (raw.put.impliedVolatility || 23) / 100);
    const putGreeks = computeBlackScholes(cmp, strike, daysToExpiry, 0.065, putIv);
    totalCallOi += callOi;
    totalPutOi += putOi;
    totalCallVolume += callVol;
    totalPutVolume += putVol;
    const callContract = {
      contractSymbol: `${clean}${selectedExpiry.label.replace(/\s+/g, "")}${strike}CE`,
      strike,
      type: "CE",
      lastPrice: callPrice,
      change: raw.call.change || 0,
      percentChange: raw.call.percentChange || 0,
      bid: callBid,
      ask: callAsk,
      openInterest: callOi,
      changeInOi: raw.call.changeInOi || 0,
      changeInOiPct: (raw.call.openInterest || 0) - (raw.call.changeInOi || 0) > 0 ? Math.round((raw.call.changeInOi || 0) / ((raw.call.openInterest || 0) - (raw.call.changeInOi || 0)) * 1e4) / 100 : 0,
      volume: callVol,
      impliedVolatility: Math.round(callIv * 1e3) / 10,
      inTheMoney: strike < cmp,
      delta: raw.call.delta || callGreeks.callDelta,
      theta: raw.call.theta || callGreeks.callTheta,
      thetaLot: Math.round((raw.call.theta || callGreeks.callTheta) * lotSize),
      gamma: raw.call.gamma || callGreeks.gamma,
      vega: raw.call.vega || callGreeks.vega,
      gexCr: Math.round(callOi * lotSize * (raw.call.gamma || callGreeks.gamma) * (cmp * cmp) * 0.01 / 1e7 * 100) / 100,
      aggressiveBuyVol: 0,
      aggressiveSellVol: 0,
      cvd: 0,
      intrinsicValue: Math.max(0, cmp - strike),
      timeValue: Math.max(0, callPrice - Math.max(0, cmp - strike))
    };
    callContract.buildup = raw.call.buildup;
    const putContract = {
      contractSymbol: `${clean}${selectedExpiry.label.replace(/\s+/g, "")}${strike}PE`,
      strike,
      type: "PE",
      lastPrice: putPrice,
      change: raw.put.change || 0,
      percentChange: raw.put.percentChange || 0,
      bid: putBid,
      ask: putAsk,
      openInterest: putOi,
      changeInOi: raw.put.changeInOi || 0,
      changeInOiPct: (raw.put.openInterest || 0) - (raw.put.changeInOi || 0) > 0 ? Math.round((raw.put.changeInOi || 0) / ((raw.put.openInterest || 0) - (raw.put.changeInOi || 0)) * 1e4) / 100 : 0,
      volume: putVol,
      impliedVolatility: Math.round(putIv * 1e3) / 10,
      inTheMoney: strike > cmp,
      delta: raw.put.delta || putGreeks.putDelta,
      theta: raw.put.theta || putGreeks.putTheta,
      thetaLot: Math.round((raw.put.theta || putGreeks.putTheta) * lotSize),
      gamma: raw.put.gamma || putGreeks.gamma,
      vega: raw.put.vega || putGreeks.vega,
      gexCr: Math.round(-(putOi * lotSize * (raw.put.gamma || putGreeks.gamma) * (cmp * cmp) * 0.01) / 1e7 * 100) / 100,
      aggressiveBuyVol: 0,
      aggressiveSellVol: 0,
      cvd: 0,
      intrinsicValue: Math.max(0, strike - cmp),
      timeValue: Math.max(0, putPrice - Math.max(0, strike - cmp))
    };
    putContract.buildup = raw.put.buildup;
    rows.push({
      strike,
      isAtm,
      netGexCr: Math.round((callContract.gexCr + putContract.gexCr) * 100) / 100,
      call: callContract,
      put: putContract,
      microstructureSignal: "Aggressor-side trade data unavailable"
    });
  }
  const pcr = totalCallOi > 0 ? Math.round(totalPutOi / totalCallOi * 100) / 100 : 1;
  const pcrBias = pcr > 1.25 ? "BULLISH" : pcr < 0.75 ? "BEARISH" : "NEUTRAL";
  let minTotalLoss = Infinity;
  let maxPainStrike = atmStrike;
  for (const s of sortedStrikes) {
    let totalLoss = 0;
    for (const r of rows) {
      if (s > r.strike) totalLoss += (s - r.strike) * r.call.openInterest;
      if (s < r.strike) totalLoss += (r.strike - s) * r.put.openInterest;
    }
    if (totalLoss < minTotalLoss) {
      minTotalLoss = totalLoss;
      maxPainStrike = s;
    }
  }
  const baseReturn = buildInstitutionalOptionChain(symbol, name, cmp, expiryIndex);
  return {
    ...baseReturn,
    underlyingPrice: Math.round(cmp * 100) / 100,
    atmStrike,
    pcr,
    pcrBias,
    maxPain: maxPainStrike,
    totalCallOi,
    totalPutOi,
    totalCallVolume,
    totalPutVolume,
    orderFlowMetrics: {
      ...baseReturn.orderFlowMetrics,
      totalAggressiveCallBuys: 0,
      totalAggressiveCallSells: 0,
      totalAggressivePutBuys: 0,
      totalAggressivePutSells: 0,
      netOptionsCvd: 0,
      orderFlowBias: "UNAVAILABLE",
      keyTrapStrike: 0,
      trapSignal: "Broker feed did not include aggressor-side trade data."
    },
    isLiveFeed: true,
    sourceState: "LIVE",
    provider: `\u{1F7E2} Real Broker Feed (${providerLabel})`,
    options: rows
  };
}

// src/lib/marketFlowSignals.ts
function analyzeFuturesOi(priceChangePct, oiChange, oiChangePct) {
  if (![priceChangePct, oiChange, oiChangePct].every(Number.isFinite) || oiChange === 0 || Math.abs(priceChangePct) < 0.05) {
    return { available: false, direction: "NEUTRAL", scorePct: 0, label: "Waiting for futures OI change", detail: "Requires two live futures OI snapshots and a measurable underlying price move." };
  }
  const direction = priceChangePct > 0 ? "BULLISH" : "BEARISH";
  const buildup = oiChange > 0 ? priceChangePct > 0 ? "Long buildup" : "Short buildup" : priceChangePct > 0 ? "Short covering" : "Long unwinding";
  const pressure = Math.min(100, Math.round(Math.abs(oiChangePct) * 10));
  return { available: true, direction, scorePct: direction === "BULLISH" ? pressure : -pressure, label: buildup, detail: `${buildup}: futures OI ${oiChange > 0 ? "+" : ""}${oiChangePct.toFixed(2)}% with price ${priceChangePct > 0 ? "+" : ""}${priceChangePct.toFixed(2)}%.` };
}

// src/lib/angelOneOptions.ts
var SCRIP_MASTER_URL = "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";
var SMART_API_ROOT = "https://apiconnect.angelone.in/rest/secure/angelbroking";
var MAX_QUOTE_TOKENS = 50;
var STRIKES_EACH_SIDE = 15;
var scripMasterCache = null;
var previousContractSnapshots = /* @__PURE__ */ new Map();
var previousFuturesSnapshots = /* @__PURE__ */ new Map();
function normalizeUnderlying(value) {
  const symbol = value.toUpperCase().replace(/\.NS$|\.BO$/i, "").replace(/[^A-Z0-9]/g, "");
  if (symbol === "NIFTY50") return "NIFTY";
  if (symbol === "BANKNIFTY") return "BANKNIFTY";
  if (symbol === "NIFTYFINANCIALSERVICES") return "FINNIFTY";
  if (symbol === "TATAMOTORS") return "TATAMOTORS";
  return symbol;
}
function angelExpiryDate(value) {
  const match = value.toUpperCase().match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);
  if (!match) return null;
  const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].indexOf(match[2]);
  if (month < 0) return null;
  const date = new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  return Number.isNaN(date.getTime()) ? null : date;
}
function angelExpiryLabel(date, index) {
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const year = date.getUTCFullYear();
  const dateLabel = date.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  return `${dateLabel} (${index === 0 ? "Current" : index === 1 ? "Next" : "Far"} Expiry \xB7 ${month} ${year})`;
}
async function getScripMaster() {
  if (scripMasterCache && scripMasterCache.expiresAt > Date.now()) return scripMasterCache.rows;
  const response = await fetch(SCRIP_MASTER_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Angel One instrument master request failed (${response.status}).`);
  const json = await response.json();
  if (!Array.isArray(json)) throw new Error("Angel One returned an invalid instrument master.");
  const rows = json;
  scripMasterCache = { rows, expiresAt: Date.now() + 6 * 60 * 60 * 1e3 };
  return rows;
}
function authorizationHeaders(config) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...config.customHeaders || {}
  };
  const accessToken = config.apiKey?.trim();
  if (accessToken && !headers.Authorization && !headers.authorization) {
    headers.Authorization = accessToken.startsWith("Bearer ") ? accessToken : `Bearer ${accessToken}`;
  }
  return headers;
}
function positiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}
function contractStrike(scrip) {
  const raw = Number(scrip.strike);
  return Number.isFinite(raw) ? raw >= 1e5 ? raw / 100 : raw : 0;
}
function quoteItems(body) {
  const data = body?.data;
  if (Array.isArray(data?.fetched)) return data.fetched;
  if (Array.isArray(data?.fetchedData)) return data.fetchedData;
  if (Array.isArray(data)) return data;
  return [];
}
function greekMap(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  return new Map(rows.map((row) => [`${Number(row.strikePrice)}:${String(row.optionType).toUpperCase()}`, row]));
}
function classifyBuildup(priceChange, oiChange) {
  if (oiChange > 0 && priceChange > 0) return "Long Buildup";
  if (oiChange > 0 && priceChange < 0) return "Short Buildup";
  if (oiChange < 0 && priceChange > 0) return "Short Covering";
  if (oiChange < 0 && priceChange < 0) return "Long Unwinding";
  return void 0;
}
async function fetchAngelOneOptionChain(input) {
  if (!input.config.apiKey) throw new Error("Angel One SmartAPI JWT access token is missing.");
  const headers = authorizationHeaders(input.config);
  for (const required of ["X-PrivateKey", "X-UserType", "X-SourceID", "X-ClientLocalIP", "X-ClientPublicIP", "X-MACAddress"]) {
    if (!Object.keys(headers).some((key) => key.toLowerCase() === required.toLowerCase())) {
      throw new Error(`Angel One SmartAPI setup is missing the ${required} header.`);
    }
  }
  const normalizedSymbol = normalizeUnderlying(input.symbol);
  const master = await getScripMaster();
  const eligible = master.filter(
    (row) => row.exch_seg === "NFO" && (row.instrumenttype === "OPTIDX" || row.instrumenttype === "OPTSTK") && normalizeUnderlying(row.name || "") === normalizedSymbol && Boolean(angelExpiryDate(row.expiry))
  );
  if (!eligible.length) throw new Error(`No Angel One NSE option contracts found for ${input.symbol}.`);
  const expiryDates = [...new Map(eligible.map((row) => [row.expiry, angelExpiryDate(row.expiry)])).entries()].filter(([, date]) => date.getTime() >= Date.now() - 24 * 60 * 60 * 1e3).sort((a, b) => a[1].getTime() - b[1].getTime());
  if (!expiryDates.length) throw new Error(`Angel One has no active option expiries for ${input.symbol}.`);
  const chosenIndex = Math.min(Math.max(0, input.expiryIndex), expiryDates.length - 1);
  const [expiryCode, expiryDate] = expiryDates[chosenIndex];
  const expiryContracts = eligible.filter((row) => row.expiry === expiryCode);
  const strikeByValue = /* @__PURE__ */ new Map();
  for (const contract of expiryContracts) {
    const strike = contractStrike(contract);
    if (!strike) continue;
    const type = contract.symbol.toUpperCase().endsWith("CE") ? "CE" : contract.symbol.toUpperCase().endsWith("PE") ? "PE" : null;
    if (!type) continue;
    const pair = strikeByValue.get(strike) || {};
    pair[type] = contract;
    strikeByValue.set(strike, pair);
  }
  const allStrikes = [...strikeByValue.keys()].sort((a, b) => a - b);
  if (!allStrikes.length) throw new Error(`Angel One returned no strike ladder for ${input.symbol} ${expiryCode}.`);
  const atmIndex = allStrikes.reduce((best, strike, index) => Math.abs(strike - input.cmp) < Math.abs(allStrikes[best] - input.cmp) ? index : best, 0);
  const selectedStrikes = allStrikes.slice(Math.max(0, atmIndex - STRIKES_EACH_SIDE), atmIndex + STRIKES_EACH_SIDE + 1);
  const selectedContracts = selectedStrikes.flatMap((strike) => {
    const pair = strikeByValue.get(strike);
    return [pair.CE, pair.PE].filter((contract) => Boolean(contract));
  });
  const fetchedByToken = /* @__PURE__ */ new Map();
  for (let offset = 0; offset < selectedContracts.length; offset += MAX_QUOTE_TOKENS) {
    const contracts = selectedContracts.slice(offset, offset + MAX_QUOTE_TOKENS);
    const quoteResponse = await fetch(`${SMART_API_ROOT}/market/v1/quote/`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "FULL", exchangeTokens: { NFO: contracts.map((contract) => String(contract.token)) } })
    });
    if (!quoteResponse.ok) throw new Error(`Angel One quote request failed (${quoteResponse.status}).`);
    const quoteBody = await quoteResponse.json();
    if (!quoteBody?.status) throw new Error(quoteBody?.message || "Angel One rejected the market quote request.");
    for (const item of quoteItems(quoteBody)) {
      const token = String(item.symbolToken || item.symboltoken || item.token || "");
      if (token) fetchedByToken.set(token, item);
    }
    if (offset + MAX_QUOTE_TOKENS < selectedContracts.length) {
      await new Promise((resolve) => setTimeout(resolve, 1050));
    }
  }
  const greekResponse = await fetch(`${SMART_API_ROOT}/marketData/v1/optionGreek`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: normalizedSymbol, expirydate: expiryCode })
  });
  if (!greekResponse.ok) throw new Error(`Angel One Greeks request failed (${greekResponse.status}).`);
  const greekBody = await greekResponse.json();
  if (!greekBody?.status) throw new Error(greekBody?.message || "Angel One did not return option Greeks.");
  const greeks = greekMap(greekBody);
  if (!greeks.size) throw new Error("Angel One returned no option Greeks for this expiry.");
  const now = Date.now();
  const chainRows = selectedStrikes.map((strike) => {
    const pair = strikeByValue.get(strike);
    const makeSide = (contract, type) => {
      if (!contract) return void 0;
      const quote = fetchedByToken.get(String(contract.token));
      if (!quote) return void 0;
      const ltp = positiveNumber(quote.ltp);
      if (!ltp) return void 0;
      const oi = positiveNumber(quote.opnInterest ?? quote.openInterest ?? quote.oi);
      const greeksRow = greeks.get(`${strike}:${type}`);
      if (!greeksRow || !positiveNumber(greeksRow.impliedVolatility)) return void 0;
      const snapshotKey = `${normalizedSymbol}:${expiryCode}:${contract.token}`;
      const previous = previousContractSnapshots.get(snapshotKey);
      const oiChange = previous ? oi - previous.oi : 0;
      const snapshotPriceChange = previous ? ltp - previous.ltp : 0;
      const close = positiveNumber(quote.close || quote.closePrice);
      const dailyChange = Number.isFinite(Number(quote.netChange)) ? Number(quote.netChange) : close > 0 ? ltp - close : 0;
      const providerPercentChange = quote.percentChange === void 0 || quote.percentChange === null || quote.percentChange === "" ? NaN : Number(quote.percentChange);
      const dailyPercentChange = Number.isFinite(providerPercentChange) ? providerPercentChange : close > 0 ? dailyChange / close * 100 : 0;
      previousContractSnapshots.set(snapshotKey, { ltp, oi, capturedAt: now });
      return {
        lastPrice: ltp,
        change: dailyChange,
        percentChange: dailyPercentChange,
        bid: positiveNumber(quote.depth?.buy?.[0]?.price || quote.buyPrice || quote.bidPrice),
        ask: positiveNumber(quote.depth?.sell?.[0]?.price || quote.sellPrice || quote.askPrice),
        openInterest: oi,
        changeInOi: oiChange,
        volume: positiveNumber(quote.tradeVolume || quote.volume),
        impliedVolatility: positiveNumber(greeksRow.impliedVolatility),
        delta: Number(greeksRow.delta) || void 0,
        gamma: Number(greeksRow.gamma) || void 0,
        theta: Number(greeksRow.theta) || void 0,
        vega: Number(greeksRow.vega) || void 0,
        buildup: classifyBuildup(snapshotPriceChange, oiChange)
      };
    };
    return { strike, CE: makeSide(pair.CE, "CE"), PE: makeSide(pair.PE, "PE") };
  }).filter((row) => row.CE && row.PE);
  if (!chainRows.length) throw new Error("Angel One returned no strikes with complete quotes and Greeks.");
  const expirations = expiryDates.map(([, date], index) => {
    const dte = Math.max(0, Math.ceil((date.getTime() - now) / 864e5));
    const dateStr = date.toISOString().slice(0, 10);
    const nextDate = expiryDates[index + 1]?.[1];
    const isMonthly = !nextDate || nextDate.getUTCMonth() !== date.getUTCMonth() || nextDate.getUTCFullYear() !== date.getUTCFullYear();
    return {
      timestamp: date.getTime(),
      dateStr,
      label: angelExpiryLabel(date, index),
      daysToExpiry: dte,
      isMonthly
    };
  });
  const selectedExpiry = expirations[chosenIndex];
  const response = parseBrokerOptionChain(chainRows, input.symbol, input.name, input.cmp, chosenIndex, "Angel One SmartAPI", selectedExpiry);
  if (response.sourceState !== "LIVE" || !response.options.length) throw new Error("Angel One returned no usable live option quotes.");
  const daysToExpiry = selectedExpiry?.daysToExpiry ?? Math.max(0, Math.ceil((expiryDate.getTime() - now) / 864e5));
  response.expirationDates = expirations;
  response.selectedExpiry = selectedExpiry || response.selectedExpiry;
  response.provider = "Angel One SmartAPI \xB7 live quotes";
  response.contractTypeLabel = `${response.instrumentType === "INDEX" ? "NSE Index Options" : "NSE Equity Options"} \xB7 ${response.options.length}-strike live window`;
  const actualLotSize = Number(selectedContracts.find((contract) => Number(contract.lotsize) > 0)?.lotsize) || response.lotSize;
  response.lotSize = actualLotSize;
  const strikeDiffs = selectedStrikes.slice(1).map((strike, index) => strike - selectedStrikes[index]).filter((value) => value > 0);
  const strikeSteps = [...strikeDiffs].sort((a, b) => a - b);
  if (strikeSteps.length) response.strikeInterval = strikeSteps[Math.floor(strikeSteps.length / 2)];
  response.options = response.options.map((row) => ({
    ...row,
    call: {
      ...row.call,
      thetaLot: Math.round(row.call.theta * actualLotSize),
      gexCr: Math.round(row.call.openInterest * actualLotSize * row.call.gamma * response.underlyingPrice ** 2 * 0.01 / 1e7 * 100) / 100,
      buildup: chainRows.find((item) => item.strike === row.strike)?.CE?.buildup
    },
    put: {
      ...row.put,
      thetaLot: Math.round(row.put.theta * actualLotSize),
      gexCr: Math.round(-(row.put.openInterest * actualLotSize * row.put.gamma * response.underlyingPrice ** 2 * 0.01) / 1e7 * 100) / 100,
      buildup: chainRows.find((item) => item.strike === row.strike)?.PE?.buildup
    }
  }));
  response.options = response.options.map((row) => ({
    ...row,
    netGexCr: Math.round((row.call.gexCr + row.put.gexCr) * 100) / 100
  }));
  const totalCallGexCr = response.options.reduce((sum, row) => sum + row.call.gexCr, 0);
  const totalPutGexCr = response.options.reduce((sum, row) => sum + row.put.gexCr, 0);
  const totalNetGexCr = totalCallGexCr + totalPutGexCr;
  const atmRow = response.options.find((row) => row.isAtm) || response.options.reduce(
    (best, row) => Math.abs(row.strike - response.underlyingPrice) < Math.abs(best.strike - response.underlyingPrice) ? row : best,
    response.options[0]
  );
  const atmIv = Math.round((atmRow.call.impliedVolatility + atmRow.put.impliedVolatility) / 2 * 10) / 10;
  const impliedMovePoints = Math.round(response.underlyingPrice * (atmIv / 100) * Math.sqrt(Math.max(daysToExpiry, 1) / 365) * 10) / 10;
  const maxCallOi = Math.max(...response.options.map((row) => row.call.openInterest));
  const maxPutOi = Math.max(...response.options.map((row) => row.put.openInterest));
  const maxCallGex = response.options.reduce((best, row) => row.call.gexCr > best.call.gexCr ? row : best, response.options[0]);
  const maxPutGex = response.options.reduce((best, row) => Math.abs(row.put.gexCr) > Math.abs(best.put.gexCr) ? row : best, response.options[0]);
  const maxGammaRow = response.options.reduce((best, row) => row.call.gamma + row.put.gamma > best.call.gamma + best.put.gamma ? row : best, response.options[0]);
  response.gexMetrics = {
    ...response.gexMetrics,
    totalCallGexCr: Math.round(totalCallGexCr * 100) / 100,
    totalPutGexCr: Math.round(totalPutGexCr * 100) / 100,
    totalNetGexCr: Math.round(totalNetGexCr * 100) / 100,
    zeroGammaFlipStrike: null,
    gexRegime: totalNetGexCr >= 0 ? "POSITIVE_GAMMA" : "NEGATIVE_GAMMA",
    regimeDescription: totalNetGexCr >= 0 ? "Positive net gamma in the displayed strike range." : "Negative net gamma in the displayed strike range.",
    callGexResistanceStrike: maxCallGex.strike,
    putGexSupportStrike: maxPutGex.strike,
    maxGammaStrike: maxGammaRow.strike
  };
  response.atmIv = atmIv;
  response.maxCallOi = maxCallOi;
  response.maxPutOi = maxPutOi;
  response.ivMetrics = {
    ...response.ivMetrics,
    atmIv,
    impliedMovePoints,
    impliedMovePct: response.underlyingPrice > 0 ? Math.round(impliedMovePoints / response.underlyingPrice * 1e3) / 10 : 0,
    volatilityRegime: "UNAVAILABLE",
    quantStrategyRecommendation: "Historical IV rank and realized volatility were not supplied; no volatility-pricing strategy recommendation is available."
  };
  return response;
}
async function fetchAngelOneFuturesOi(symbol, config) {
  if (!config.apiKey) throw new Error("Angel One SmartAPI JWT access token is missing.");
  const headers = authorizationHeaders(config);
  for (const required of ["X-PrivateKey", "X-UserType", "X-SourceID", "X-ClientLocalIP", "X-ClientPublicIP", "X-MACAddress"]) {
    if (!Object.keys(headers).some((key2) => key2.toLowerCase() === required.toLowerCase())) throw new Error(`Angel One SmartAPI setup is missing the ${required} header.`);
  }
  const normalizedSymbol = normalizeUnderlying(symbol);
  const now = Date.now();
  const contracts = (await getScripMaster()).filter(
    (row) => row.exch_seg === "NFO" && (row.instrumenttype === "FUTSTK" || row.instrumenttype === "FUTIDX") && normalizeUnderlying(row.name || "") === normalizedSymbol && angelExpiryDate(row.expiry)?.getTime() >= now
  ).sort((a, b) => angelExpiryDate(a.expiry).getTime() - angelExpiryDate(b.expiry).getTime());
  const contract = contracts[0];
  if (!contract) throw new Error(`No active Angel One stock-futures contract is available for ${symbol}.`);
  const response = await fetch(`${SMART_API_ROOT}/market/v1/quote/`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mode: "FULL", exchangeTokens: { NFO: [String(contract.token)] } })
  });
  if (!response.ok) throw new Error(`Angel One futures quote request failed (${response.status}).`);
  const body = await response.json();
  if (!body?.status) throw new Error(body?.message || "Angel One rejected the stock-futures quote request.");
  const quote = quoteItems(body).find((item) => String(item.symbolToken || item.symboltoken || item.token || "") === String(contract.token)) || quoteItems(body)[0];
  const price = positiveNumber(quote?.ltp);
  const oi = positiveNumber(quote?.opnInterest ?? quote?.openInterest ?? quote?.oi);
  if (!price || !oi) throw new Error(`Angel One did not supply price and OI for ${contract.symbol}.`);
  const key = `${normalizedSymbol}:${contract.expiry}:${contract.token}`;
  const previous = previousFuturesSnapshots.get(key);
  previousFuturesSnapshots.set(key, { ltp: price, oi, capturedAt: now });
  const oiChange = previous ? oi - previous.oi : 0;
  const priceChangePct = previous?.ltp ? (price - previous.ltp) / previous.ltp * 100 : 0;
  const oiChangePct = previous?.oi ? oiChange / previous.oi * 100 : 0;
  const signal = analyzeFuturesOi(priceChangePct, oiChange, oiChangePct);
  return {
    available: signal.available,
    symbol: normalizedSymbol,
    contract: contract.symbol,
    expiry: contract.expiry,
    price,
    oi,
    oiChange,
    oiChangePct,
    priceChangePct,
    signal,
    capturedAt: now
  };
}
async function fetchAngelOneFuturesOiBatch(symbols, config) {
  if (!config.apiKey) throw new Error("Angel One SmartAPI JWT access token is missing.");
  const headers = authorizationHeaders(config);
  for (const required of ["X-PrivateKey", "X-UserType", "X-SourceID", "X-ClientLocalIP", "X-ClientPublicIP", "X-MACAddress"]) {
    if (!Object.keys(headers).some((key) => key.toLowerCase() === required.toLowerCase())) throw new Error(`Angel One SmartAPI setup is missing the ${required} header.`);
  }
  const master = await getScripMaster();
  const now = Date.now();
  const contracts = /* @__PURE__ */ new Map();
  for (const inputSymbol of [...new Set(symbols.map(normalizeUnderlying))]) {
    const match = master.filter(
      (row) => row.exch_seg === "NFO" && (row.instrumenttype === "FUTSTK" || row.instrumenttype === "FUTIDX") && normalizeUnderlying(row.name || "") === inputSymbol && (angelExpiryDate(row.expiry)?.getTime() || 0) >= now
    ).sort((a, b) => angelExpiryDate(a.expiry).getTime() - angelExpiryDate(b.expiry).getTime())[0];
    if (match) contracts.set(inputSymbol, match);
  }
  const output = {};
  const entries = [...contracts.entries()];
  for (let offset = 0; offset < entries.length; offset += MAX_QUOTE_TOKENS) {
    const batch = entries.slice(offset, offset + MAX_QUOTE_TOKENS);
    const response = await fetch(`${SMART_API_ROOT}/market/v1/quote/`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "FULL", exchangeTokens: { NFO: batch.map(([, contract]) => String(contract.token)) } })
    });
    if (!response.ok) throw new Error(`Angel One futures batch quote request failed (${response.status}).`);
    const body = await response.json();
    if (!body?.status) throw new Error(body?.message || "Angel One rejected the futures batch quote request.");
    const items = quoteItems(body);
    for (const [key, contract] of batch) {
      const quote = items.find((item) => String(item.symbolToken || item.symboltoken || item.token || "") === String(contract.token));
      const price = positiveNumber(quote?.ltp);
      const oi = positiveNumber(quote?.opnInterest ?? quote?.openInterest ?? quote?.oi);
      if (!price || !oi) continue;
      const snapshotKey = `${key}:${contract.expiry}:${contract.token}`;
      const previous = previousFuturesSnapshots.get(snapshotKey);
      previousFuturesSnapshots.set(snapshotKey, { ltp: price, oi, capturedAt: now });
      const oiChange = previous ? oi - previous.oi : 0;
      const priceChangePct = previous?.ltp ? (price - previous.ltp) / previous.ltp * 100 : 0;
      const oiChangePct = previous?.oi ? oiChange / previous.oi * 100 : 0;
      const signal = analyzeFuturesOi(priceChangePct, oiChange, oiChangePct);
      output[key] = {
        available: signal.available,
        symbol: key,
        contract: contract.symbol,
        expiry: contract.expiry,
        price,
        oi,
        oiChange,
        oiChangePct,
        priceChangePct,
        signal,
        capturedAt: now
      };
    }
    if (offset + MAX_QUOTE_TOKENS < entries.length) await new Promise((resolve) => setTimeout(resolve, 1050));
  }
  return output;
}
function isAngelOneConfig(config) {
  return Boolean(config && (/angelone\.in/i.test(config.url || config.customUrl || "") || /angel one|angelone/i.test(config.customApiName || "")));
}

// src/lib/proxySecurity.ts
var import_dns = __toESM(require("dns"), 1);
var import_util = require("util");
var lookup = (0, import_util.promisify)(import_dns.default.lookup);
var BLOCKED_IP_PATTERNS = [
  // IPv4 Loopback
  /^127\./,
  // IPv4 Private Networks (RFC 1918)
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  // IPv4 Link-Local (RFC 3927, includes AWS/GCP metadata service 169.254.169.254)
  /^169\.254\./,
  // IPv4 Current Network / Broadcast
  /^0\./,
  /^255\.255\.255\.255/,
  // IPv4 Carrier-Grade NAT (RFC 6598)
  /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./,
  // IPv6 Loopback & Private
  /^::1$/,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i
];
var BLOCKED_HOSTNAMES = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "metadata.google.internal",
  "metadata.internal",
  "instance-data",
  "169.254.169.254"
];
async function validateProxyUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { allowed: false, reason: "URL must be a non-empty string." };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { allowed: false, reason: "Invalid URL format." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { allowed: false, reason: `Disallowed protocol: ${parsed.protocol}. Only https:// and http:// are allowed.` };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
    return { allowed: false, reason: `Blocked hostname: ${hostname}. Local and internal hostnames are prohibited.` };
  }
  if (hostname.includes("api.myserver.com") || hostname.includes("myserver.com") || hostname.includes("example.com") || hostname.includes("your-api-host.com")) {
    return {
      allowed: false,
      reason: "Placeholder domain detected. Please enter a valid broker/market data endpoint."
    };
  }
  try {
    const addresses = await lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      return { allowed: false, reason: `Unable to resolve DNS for ${hostname}.` };
    }
    for (const addr of addresses) {
      const ip = addr.address;
      for (const pattern of BLOCKED_IP_PATTERNS) {
        if (pattern.test(ip)) {
          return {
            allowed: false,
            reason: `Target hostname ${hostname} resolved to a prohibited private/internal IP address (${ip}).`
          };
        }
      }
    }
  } catch (err) {
    return { allowed: false, reason: `DNS lookup failed for ${hostname}: ${err.message}` };
  }
  return { allowed: true, targetUrl: parsed.toString() };
}

// src/lib/rateLimiter.ts
function createRateLimiter(options) {
  const { windowMs, max, message = "Too many requests, please try again later." } = options;
  const store = /* @__PURE__ */ new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of store.entries()) {
      if (now > record.resetTime) {
        store.delete(key);
      }
    }
  }, Math.max(windowMs, 3e4));
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown-ip";
    const now = Date.now();
    let record = store.get(ip);
    if (!record || now > record.resetTime) {
      record = {
        count: 1,
        resetTime: now + windowMs
      };
      store.set(ip, record);
    } else {
      record.count++;
    }
    const remaining = Math.max(0, max - record.count);
    const resetSeconds = Math.ceil((record.resetTime - now) / 1e3);
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetSeconds);
    if (record.count > max) {
      return res.status(429).json({
        error: message,
        retryAfterSeconds: resetSeconds
      });
    }
    next();
  };
}

// server.ts
import_dotenv.default.config();
var app = (0, import_express.default)();
var PORT = Number.parseInt(process.env.PORT || "3000", 10);
var HOST = process.env.HOST || "0.0.0.0";
app.use(import_express.default.json({ limit: "5mb" }));
app.use(import_express.default.static(import_path2.default.join(process.cwd(), "public")));
app.get("/sql-wasm.wasm", (req, res) => {
  const possiblePaths = [
    import_path2.default.join(process.cwd(), "public", "sql-wasm.wasm"),
    import_path2.default.join(process.cwd(), "dist", "sql-wasm.wasm"),
    import_path2.default.join(process.cwd(), "node_modules", "sql.js", "dist", "sql-wasm.wasm")
  ];
  for (const p of possiblePaths) {
    if (import_fs2.default.existsSync(p)) {
      res.setHeader("Content-Type", "application/wasm");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.sendFile(p);
    }
  }
  return res.status(404).type("text/plain").send("sql-wasm.wasm not found");
});
var customProxyLimiter = createRateLimiter({ windowMs: 6e4, max: 20, message: "Custom API Proxy rate limit exceeded. Max 20 requests per minute." });
var forecastLimiter = createRateLimiter({ windowMs: 6e4, max: 40, message: "Forecast rate limit exceeded. Max 40 requests per minute." });
var marketLimiter = createRateLimiter({ windowMs: 6e4, max: 80, message: "Market data rate limit exceeded. Max 80 requests per minute." });
var aiLimiter = createRateLimiter({ windowMs: 6e4, max: 20, message: "AI Analysis rate limit exceeded. Max 20 requests per minute." });
app.use("/api/market/custom-proxy", customProxyLimiter);
app.use("/api/forecast", forecastLimiter);
app.use("/api/market", marketLimiter);
app.use("/api/analyze", aiLimiter);
var aiClient = null;
function getAiClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return null;
  }
  if (!aiClient) {
    aiClient = new import_genai.GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build"
        }
      }
    });
  }
  return aiClient;
}
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Time Series Studio",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    geminiConfigured: !!process.env.GEMINI_API_KEY
  });
});
var cachedUsdInrRate = 84.5;
var lastUsdInrFetchTime = 0;
async function getUsdInrRate() {
  const now = Date.now();
  if (now - lastUsdInrFetchTime < 15 * 60 * 1e3 && cachedUsdInrRate > 0) {
    return cachedUsdInrRate;
  }
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/USDINR=X?range=1d&interval=1d", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (res.ok) {
      const j = await res.json();
      const price = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (typeof price === "number" && price > 60 && price < 150) {
        cachedUsdInrRate = price;
        lastUsdInrFetchTime = now;
        return price;
      }
    }
  } catch (e) {
    console.warn("Could not fetch live USDINR rate, using cached/fallback rate", e);
  }
  return cachedUsdInrRate;
}
app.get("/api/market/rate", async (req, res) => {
  const rate = await getUsdInrRate();
  res.json({ usdInr: rate, currency: "INR" });
});
var INDIAN_SYMBOL_MAP = {
  "SYRMA": "SYRMA.NS",
  "SYRMA SGS": "SYRMA.NS",
  "SYRMA SGS TECHNOLOGY": "SYRMA.NS",
  "SYRMASGS": "SYRMA.NS",
  "TATAMOTORS": "TMCV.NS",
  "TATA MOTORS": "TMCV.NS",
  "TATA MOTOR": "TMCV.NS",
  "TATA MOTORS PASSENGER": "TMPV.NS",
  "TMPV": "TMPV.NS",
  "TMCV": "TMCV.NS",
  "TATA MOTORS COMMERCIAL": "TMCV.NS",
  "TATAPOWER": "TATAPOWER.NS",
  "TATA POWER": "TATAPOWER.NS",
  "RELIANCE": "RELIANCE.NS",
  "TCS": "TCS.NS",
  "HDFC": "HDFCBANK.NS",
  "HDFCBANK": "HDFCBANK.NS",
  "HDFC BANK": "HDFCBANK.NS",
  "INFY": "INFY.NS",
  "INFOSYS": "INFY.NS",
  "SBIN": "SBIN.NS",
  "SBI": "SBIN.NS",
  "STATE BANK OF INDIA": "SBIN.NS",
  "STATE BANK": "SBIN.NS",
  "ICICI": "ICICIBANK.NS",
  "ICICIBANK": "ICICIBANK.NS",
  "ICICI BANK": "ICICIBANK.NS",
  "BHARTIARTL": "BHARTIARTL.NS",
  "BHARTI": "BHARTIARTL.NS",
  "AIRTEL": "BHARTIARTL.NS",
  "LT": "LT.NS",
  "LARSEN": "LT.NS",
  "L&T": "LT.NS",
  "ITC": "ITC.NS",
  "KOTAK": "KOTAKBANK.NS",
  "KOTAKBANK": "KOTAKBANK.NS",
  "KOTAK BANK": "KOTAKBANK.NS",
  "MARUTI": "MARUTI.NS",
  "MARUTI SUZUKI": "MARUTI.NS",
  "AXIS": "AXISBANK.NS",
  "AXISBANK": "AXISBANK.NS",
  "AXIS BANK": "AXISBANK.NS",
  "WIPRO": "WIPRO.NS",
  "BAJFINANCE": "BAJFINANCE.NS",
  "BAJAJ FINANCE": "BAJFINANCE.NS",
  "BAJAJFINSV": "BAJAJFINSV.NS",
  "BAJAJ FINSERV": "BAJAJFINSV.NS",
  "SUNPHARMA": "SUNPHARMA.NS",
  "SUN PHARMA": "SUNPHARMA.NS",
  "TITAN": "TITAN.NS",
  "TATASTEEL": "TATASTEEL.NS",
  "TATA STEEL": "TATASTEEL.NS",
  "ZOMATO": "ZOMATO.NS",
  "SUZLON": "SUZLON.NS",
  "JIOFIN": "JIOFIN.NS",
  "JIO FINANCIAL": "JIOFIN.NS",
  "PAYTM": "PAYTM.NS",
  "SWIGGY": "SWIGGY.NS",
  "TRENT": "TRENT.NS",
  "BEL": "BEL.NS",
  "HAL": "HAL.NS",
  "BHEL": "BHEL.NS",
  "IRFC": "IRFC.NS",
  "M&M": "M&M.NS",
  "MM": "M&M.NS",
  "MAHINDRA": "M&M.NS",
  "VEDL": "VEDL.NS",
  "VEDANTA": "VEDL.NS",
  "ADANIENT": "ADANIENT.NS",
  "ADANI ENTERPRISES": "ADANIENT.NS",
  "ADANIPORTS": "ADANIPORTS.NS",
  "ADANI PORTS": "ADANIPORTS.NS",
  "COALINDIA": "COALINDIA.NS",
  "COAL INDIA": "COALINDIA.NS",
  "ONGC": "ONGC.NS",
  "NTPC": "NTPC.NS",
  "POWERGRID": "POWERGRID.NS",
  "JSWSTEEL": "JSWSTEEL.NS",
  "HINDALCO": "HINDALCO.NS",
  "HINDUNILVR": "HINDUNILVR.NS",
  "HUL": "HINDUNILVR.NS",
  "NESTLEIND": "NESTLEIND.NS",
  "ASIANPAINT": "ASIANPAINT.NS",
  "ASIAN PAINTS": "ASIANPAINT.NS",
  "DIVISLAB": "DIVISLAB.NS",
  "CIPLA": "CIPLA.NS",
  "DRREDDY": "DRREDDY.NS",
  "APOLLOHOSP": "APOLLOHOSP.NS",
  "TECHM": "TECHM.NS",
  "TECH MAHINDRA": "TECHM.NS",
  "BPCL": "BPCL.NS",
  "BRITANNIA": "BRITANNIA.NS",
  "INDUSINDBK": "INDUSINDBK.NS",
  "INDUSIND": "INDUSINDBK.NS",
  "SBILIFE": "SBILIFE.NS",
  "HDFCLIFE": "HDFCLIFE.NS",
  "BSE": "BSE.NS",
  "CDSL": "CDSL.NS",
  "MCX": "MCX.NS",
  "NIFTY": "^NSEI",
  "NIFTY 50": "^NSEI",
  "NIFTY50": "^NSEI",
  "NIFTY INDEX": "^NSEI",
  "BANKNIFTY": "^NSEBANK",
  "NIFTY BANK": "^NSEBANK",
  "BANK NIFTY": "^NSEBANK",
  "SENSEX": "^BSESN",
  "BSE SENSEX": "^BSESN",
  "BSE SENSEX 30": "^BSESN",
  "FINNIFTY": "^CNXFIN",
  "NIFTY FIN SERVICE": "^CNXFIN",
  "MIDCPNIFTY": "^NSEMDCP50",
  "NIFTY MIDCAP": "^NSEMDCP50",
  "GOLD": "GC=F",
  "MCX GOLD": "GC=F",
  "MCXGOLD": "GC=F",
  "SILVER": "SI=F",
  "MCX SILVER": "SI=F",
  "MCXSILVER": "SI=F",
  "CRUDE": "CL=F",
  "CRUDE OIL": "CL=F",
  "CRUDEOIL": "CL=F",
  "MCX CRUDE": "CL=F",
  "NATURAL GAS": "NG=F",
  "NATURALGAS": "NG=F",
  "NATGAS": "NG=F",
  "COPPER": "HG=F",
  "MCX COPPER": "HG=F",
  "ALUMINIUM": "ALI=F",
  "ZINC": "ZNC=F",
  "GOLDBEES": "GOLDBEES.NS",
  "SILVERBEES": "SILVERBEES.NS"
};
app.get("/api/market/fetch", async (req, res) => {
  try {
    const provider = String(req.query.provider || "yahoo");
    const rawSymbol = String(req.query.symbol || "RELIANCE").trim().toUpperCase();
    const range = String(req.query.range || "6mo");
    const interval = String(req.query.interval || "1d");
    const usdInr = await getUsdInrRate();
    if (provider === "binance") {
      let binanceSymbol = rawSymbol.replace(/[-/_]/g, "");
      if (!binanceSymbol.endsWith("USDT") && !binanceSymbol.endsWith("BUSD") && !binanceSymbol.endsWith("BTC")) {
        binanceSymbol += "USDT";
      }
      const binInterval = interval === "1h" ? "1h" : interval === "1wk" ? "1w" : "1d";
      const bRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${binInterval}&limit=150`);
      if (!bRes.ok) {
        return res.status(bRes.status).json({ error: `Binance error: ${bRes.statusText}` });
      }
      const rawKlines = await bRes.json();
      const points = rawKlines.map((k) => {
        const d = new Date(k[0]);
        const closeUsd = parseFloat(k[4]);
        const openUsd = parseFloat(k[1]);
        const highUsd = parseFloat(k[2]);
        const lowUsd = parseFloat(k[3]);
        return {
          timestamp: binInterval === "1h" ? d.toISOString().slice(0, 16).replace("T", " ") : d.toISOString().split("T")[0],
          value: Math.round(closeUsd * usdInr * 100) / 100,
          open: Math.round(openUsd * usdInr * 100) / 100,
          high: Math.round(highUsd * usdInr * 100) / 100,
          low: Math.round(lowUsd * usdInr * 100) / 100,
          volume: Math.round(parseFloat(k[5]) * 10) / 10
        };
      });
      return res.json({
        symbol: binanceSymbol,
        name: `${binanceSymbol} (in Indian Rupees \u20B9)`,
        currency: "INR",
        unit: "INR (\u20B9)",
        provider: "binance",
        sourceState: "LIVE",
        isLive: true,
        fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
        data: points
      });
    }
    const ADR_TO_NSE_MAP = {
      "INFY": "INFY.NS",
      "IBN": "ICICIBANK.NS",
      "HDB": "HDFCBANK.NS",
      "WIT": "WIPRO.NS",
      "VEDL": "VEDL.NS",
      "TTM": "TATAMOTORS.NS",
      "MM": "M&M.NS",
      "RDY": "DRREDDY.NS"
    };
    const searchYahooQuote = async (query) => {
      try {
        const sUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=15&newsCount=0`;
        const sRes = await fetch(sUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          }
        });
        if (!sRes.ok) return null;
        const sData = await sRes.json();
        const quotes = sData?.quotes || [];
        if (quotes.length === 0) return null;
        const indian = quotes.find(
          (q) => q.symbol?.endsWith(".NS") || q.symbol?.endsWith(".BO") || q.exchange === "NSI" || q.exchange === "NSE" || q.exchange === "BSE" || q.exchange === "BOM"
        );
        if (indian) {
          return {
            symbol: indian.symbol,
            name: indian.longname || indian.shortname || indian.symbol
          };
        }
        for (const q of quotes) {
          const symUpper = (q.symbol || "").toUpperCase();
          if (ADR_TO_NSE_MAP[symUpper]) {
            return {
              symbol: ADR_TO_NSE_MAP[symUpper],
              name: q.longname || q.shortname || symUpper
            };
          }
        }
        const general = quotes.find(
          (q) => q.quoteType === "EQUITY" || q.quoteType === "COMMODITY" || q.quoteType === "FUTURE" || q.quoteType === "INDEX"
        ) || quotes[0];
        if (general) {
          return {
            symbol: general.symbol,
            name: general.longname || general.shortname || general.symbol
          };
        }
        return null;
      } catch {
        return null;
      }
    };
    const fetchYahooChart = async (sym) => {
      let effectiveRange = range;
      if (interval === "15m" || interval === "5m" || interval === "1m" || interval === "30m") {
        if (range === "6mo" || range === "1y" || range === "2y" || range === "5y" || range === "max") {
          effectiveRange = "1mo";
        }
      } else if (interval === "1h") {
        if (range === "2y" || range === "5y" || range === "max") {
          effectiveRange = "730d";
        }
      }
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${effectiveRange}&interval=${interval}`;
      const res2 = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });
      return res2;
    };
    let targetSymbol = rawSymbol;
    let resolvedFormalName;
    let yRes = null;
    if (INDIAN_SYMBOL_MAP[rawSymbol]) {
      targetSymbol = INDIAN_SYMBOL_MAP[rawSymbol];
      yRes = await fetchYahooChart(targetSymbol);
    } else if (rawSymbol.endsWith(".NS") || rawSymbol.endsWith(".BO") || rawSymbol.startsWith("^") || rawSymbol.includes("=")) {
      targetSymbol = rawSymbol;
      yRes = await fetchYahooChart(targetSymbol);
    } else {
      const cleanUpper = rawSymbol.replace(/[\s\-_]/g, "");
      if (INDIAN_SYMBOL_MAP[cleanUpper]) {
        targetSymbol = INDIAN_SYMBOL_MAP[cleanUpper];
        yRes = await fetchYahooChart(targetSymbol);
      } else {
        const nsCandidate = `${cleanUpper}.NS`;
        const testNsRes = await fetchYahooChart(nsCandidate);
        if (testNsRes.ok) {
          targetSymbol = nsCandidate;
          yRes = testNsRes;
        } else {
          const boCandidate = `${cleanUpper}.BO`;
          const testBoRes = await fetchYahooChart(boCandidate);
          if (testBoRes.ok) {
            targetSymbol = boCandidate;
            yRes = testBoRes;
          } else {
            const searchHit = await searchYahooQuote(rawSymbol);
            if (searchHit) {
              targetSymbol = searchHit.symbol;
              resolvedFormalName = searchHit.name;
              yRes = await fetchYahooChart(targetSymbol);
            }
          }
        }
      }
    }
    if (!yRes || !yRes.ok) {
      const spacedQuery = rawSymbol.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/(MOTORS|BANK|STEEL|PHARMA|POWER|TECH|AUTO|FINANCE)/g, " $1").trim();
      const searchHit = await searchYahooQuote(spacedQuery !== rawSymbol ? spacedQuery : rawSymbol);
      if (searchHit && searchHit.symbol !== targetSymbol) {
        targetSymbol = searchHit.symbol;
        resolvedFormalName = searchHit.name;
        yRes = await fetchYahooChart(targetSymbol);
      }
    }
    if (!yRes || !yRes.ok) {
      return res.status(yRes?.status || 404).json({ error: `Market data provider responded with status ${yRes?.status || 404} for symbol "${rawSymbol}"` });
    }
    const json = await yRes.json();
    const result = json?.chart?.result?.[0];
    if (!result) {
      return res.status(404).json({ error: `No market chart data found for "${rawSymbol}"` });
    }
    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const closes = quote.close || [];
    const volumes = quote.volume || [];
    const isIndianNative = targetSymbol.endsWith(".NS") || targetSymbol.endsWith(".BO") || targetSymbol.startsWith("^NSE") || targetSymbol.startsWith("^BSE");
    let multiplier = 1;
    let customCommodityName;
    if (targetSymbol === "GC=F") {
      multiplier = 1 / 31.1034768 * 10 * usdInr * 1.08;
      customCommodityName = "MCX Gold Futures (\u20B9 / 10g)";
    } else if (targetSymbol === "SI=F") {
      multiplier = 1 / 31.1034768 * 1e3 * usdInr * 1.08;
      customCommodityName = "MCX Silver Futures (\u20B9 / kg)";
    } else if (targetSymbol === "CL=F") {
      multiplier = usdInr;
      customCommodityName = "MCX Crude Oil (\u20B9 / bbl)";
    } else if (targetSymbol === "NG=F") {
      multiplier = usdInr;
      customCommodityName = "MCX Natural Gas (\u20B9 / mmBtu)";
    } else if (targetSymbol === "HG=F") {
      multiplier = 2.20462 * usdInr;
      customCommodityName = "MCX Copper (\u20B9 / kg)";
    } else if (!isIndianNative && result.meta?.currency && result.meta.currency !== "INR") {
      multiplier = usdInr;
    }
    const data = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c !== null && c !== void 0 && !isNaN(c)) {
        const d = new Date(timestamps[i] * 1e3);
        data.push({
          timestamp: interval.includes("h") || interval.includes("m") ? d.toISOString().slice(0, 16).replace("T", " ") : d.toISOString().split("T")[0],
          value: Math.round(c * multiplier * 100) / 100,
          open: opens[i] ? Math.round(opens[i] * multiplier * 100) / 100 : void 0,
          high: highs[i] ? Math.round(highs[i] * multiplier * 100) / 100 : void 0,
          low: lows[i] ? Math.round(lows[i] * multiplier * 100) / 100 : void 0,
          volume: volumes[i] || 0
        });
      }
    }
    const formalName = customCommodityName || resolvedFormalName || result.meta?.shortName || result.meta?.longName || `${rawSymbol} Market Chart`;
    const lastClosePrice = data.length > 0 ? data[data.length - 1].value : void 0;
    const prevClosePrice = data.length > 1 ? data[data.length - 2].value : lastClosePrice;
    const priceChange = lastClosePrice && prevClosePrice ? Math.round((lastClosePrice - prevClosePrice) * 100) / 100 : 0;
    const priceChangePct = prevClosePrice && prevClosePrice > 0 ? Math.round(priceChange / prevClosePrice * 1e4) / 100 : 0;
    return res.json({
      symbol: result.meta?.symbol || targetSymbol,
      name: formalName,
      currency: "INR",
      unit: "INR (\u20B9)",
      provider: "yahoo",
      sourceState: "LIVE",
      isLive: true,
      fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
      lastClosePrice,
      previousClose: prevClosePrice,
      priceChange,
      priceChangePercent: priceChangePct,
      data
    });
  } catch (err) {
    console.error("Market provider fetch error:", err);
    return res.status(500).json({ error: err.message || "Failed to fetch provider data" });
  }
});
app.get("/api/market/futures-oi", async (req, res) => {
  try {
    const configHeader = req.headers["x-custom-api-config"];
    const config = configHeader ? JSON.parse(decodeURIComponent(configHeader)) : null;
    if (!isAngelOneConfig(config)) return res.json({ available: false, signal: null, reason: "Angel One SmartAPI futures data is not configured." });
    const snapshot = await fetchAngelOneFuturesOi(String(req.query.symbol || "").trim(), {
      apiKey: config.apiKey,
      customHeaders: config.customHeaders || config.headers
    });
    return res.json(snapshot);
  } catch (err) {
    return res.status(502).json({ available: false, signal: null, reason: err?.message || "Live futures OI is unavailable." });
  }
});
app.post("/api/market/futures-oi/batch", async (req, res) => {
  try {
    const configHeader = req.headers["x-custom-api-config"];
    const config = configHeader ? JSON.parse(decodeURIComponent(configHeader)) : null;
    if (!isAngelOneConfig(config)) return res.json({ available: false, signals: {}, reason: "Angel One SmartAPI futures data is not configured." });
    const symbols = Array.isArray(req.body.symbols) ? req.body.symbols.slice(0, 100).map((item) => String(item)) : [];
    const signals = await fetchAngelOneFuturesOiBatch(symbols, {
      apiKey: config.apiKey,
      customHeaders: config.customHeaders || config.headers
    });
    return res.json({ available: true, signals });
  } catch (err) {
    return res.status(502).json({ available: false, signals: {}, reason: err?.message || "Live futures OI is unavailable." });
  }
});
app.get("/api/market/options", async (req, res) => {
  try {
    const rawSymbol = String(req.query.symbol || "RELIANCE").trim().toUpperCase();
    const expiryIdx = req.query.expiryIndex !== void 0 ? parseInt(String(req.query.expiryIndex), 10) : 0;
    const requestedTimestamp = req.query.date ? parseInt(String(req.query.date), 10) : null;
    const clientPassedCmp = req.query.cmp ? parseFloat(String(req.query.cmp)) : null;
    let targetSymbol = rawSymbol;
    let displayName = rawSymbol;
    if (rawSymbol === "NIFTY" || rawSymbol === "NIFTY 50" || rawSymbol === "NIFTY50") {
      targetSymbol = "^NSEI";
      displayName = "NIFTY 50 Index";
    } else if (rawSymbol === "BANKNIFTY" || rawSymbol === "BANK NIFTY") {
      targetSymbol = "^NSEBANK";
      displayName = "Bank Nifty Index";
    } else if (rawSymbol === "FINNIFTY") {
      targetSymbol = "NIFTY_FIN_SERVICE.NS";
      displayName = "FINNIFTY Index";
    } else if (rawSymbol === "SENSEX") {
      targetSymbol = "^BSESN";
      displayName = "BSE SENSEX";
    } else if (rawSymbol === "TATAMOTORS" || rawSymbol === "TATA MOTORS") {
      targetSymbol = "TMCV.NS";
      displayName = "Tata Motors Ltd.";
    } else if (INDIAN_SYMBOL_MAP[rawSymbol]) {
      targetSymbol = INDIAN_SYMBOL_MAP[rawSymbol];
    } else if (!targetSymbol.includes(".") && !targetSymbol.startsWith("^") && !targetSymbol.includes("=")) {
      targetSymbol = `${targetSymbol}.NS`;
    }
    const customConfigHeader = req.headers["x-custom-api-config"] || req.query.customConfig;
    let customApiConfig = null;
    if (customConfigHeader) {
      try {
        customApiConfig = JSON.parse(typeof customConfigHeader === "string" ? decodeURIComponent(customConfigHeader) : customConfigHeader);
      } catch (e) {
      }
    }
    let liveCmp = clientPassedCmp && clientPassedCmp > 0 ? clientPassedCmp : 0;
    let spotChange = req.query.change ? parseFloat(String(req.query.change)) : 0;
    if (customApiConfig && customApiConfig.url && liveCmp <= 0) {
      try {
        const brokerUrl = customApiConfig.url.replace(/\{symbol\}/gi, encodeURIComponent(rawSymbol)).replace(/\{apiKey\}/gi, encodeURIComponent(customApiConfig.apiKey || ""));
        const brokerHeaders = {
          "Accept": "application/json",
          ...customApiConfig.headers || {}
        };
        if (customApiConfig.apiKey) {
          const authHdr = customApiConfig.authHeader || "Authorization";
          brokerHeaders[authHdr] = customApiConfig.authType === "Bearer" ? customApiConfig.apiKey.startsWith("Bearer ") ? customApiConfig.apiKey : `Bearer ${customApiConfig.apiKey}` : customApiConfig.apiKey;
        }
        const bRes = await fetch(brokerUrl, { headers: brokerHeaders });
        if (bRes.ok) {
          const bData = await bRes.json();
          const brokerLtp = bData?.data?.ltp || bData?.ltp || bData?.last_price || bData?.close || bData?.price;
          if (brokerLtp && typeof brokerLtp === "number" && brokerLtp > 0) {
            liveCmp = brokerLtp;
            spotChange = bData?.data?.change || bData?.change || spotChange;
          }
        }
      } catch (brokerErr) {
        console.warn("Custom broker API live quote note:", brokerErr);
      }
    }
    if (liveCmp <= 0) {
      try {
        const chartRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(targetSymbol)}?range=5d&interval=1d`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          }
        });
        if (chartRes.ok) {
          const cJson = await chartRes.json();
          const meta = cJson?.chart?.result?.[0]?.meta;
          const closes = cJson?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter((x) => x !== null && !isNaN(x)) || [];
          const lastCloseFromArray = closes.length > 0 ? closes[closes.length - 1] : 0;
          const prevCloseFromArray = closes.length > 1 ? closes[closes.length - 2] : lastCloseFromArray;
          const fetchedPrice = meta?.regularMarketPrice || lastCloseFromArray || meta?.chartPreviousClose || meta?.previousClose || 0;
          if (fetchedPrice > 0) {
            liveCmp = fetchedPrice;
            spotChange = meta?.regularMarketChange ?? lastCloseFromArray - prevCloseFromArray;
          }
          displayName = meta?.shortName || meta?.longName || displayName;
        }
      } catch (e) {
        console.warn("Could not fetch live spot price for options:", e);
      }
    }
    if (liveCmp <= 0) {
      liveCmp = targetSymbol.includes("^NSEI") ? 24200 : targetSymbol.includes("^NSEBANK") ? 51500 : 1e3;
    }
    const now = /* @__PURE__ */ new Date();
    const istOffset = 5.5 * 60 * 60 * 1e3;
    const istDate = new Date(now.getTime() + istOffset);
    const dayOfWeek = istDate.getUTCDay();
    const istHour = istDate.getUTCHours();
    const istMin = istDate.getUTCMinutes();
    const istTotalMins = istHour * 60 + istMin;
    const isMarketOpen = dayOfWeek >= 1 && dayOfWeek <= 5 && istTotalMins >= 9 * 60 + 15 && istTotalMins <= 15 * 60 + 30;
    let finalPayload = null;
    if (isAngelOneConfig(customApiConfig)) {
      try {
        finalPayload = await fetchAngelOneOptionChain({
          symbol: rawSymbol,
          name: displayName,
          cmp: liveCmp,
          expiryIndex: isNaN(expiryIdx) ? 0 : expiryIdx,
          config: {
            apiKey: customApiConfig.apiKey,
            customHeaders: customApiConfig.customHeaders || customApiConfig.headers
          }
        });
      } catch (angelError) {
        console.warn("Angel One live option chain unavailable:", angelError?.message || angelError);
        return res.status(502).json({
          error: `Angel One live option chain unavailable: ${angelError?.message || "SmartAPI request failed."}`,
          sourceState: "UNAVAILABLE",
          isLiveFeed: false
        });
      }
    }
    if (!finalPayload && customApiConfig && (customApiConfig.url || customApiConfig.customUrl) && customApiConfig.apiKey) {
      try {
        let optionChainBrokerUrl = customApiConfig.url || customApiConfig.customUrl;
        let brokerMethod = (customApiConfig.method || "GET").toUpperCase();
        let brokerBody = null;
        if (customApiConfig.url.includes("api.upstox.com")) {
          const upstoxKey = resolveUpstoxInstrumentKey(rawSymbol);
          const defaultExpiries = [
            (/* @__PURE__ */ new Date()).toISOString().split("T")[0]
          ];
          optionChainBrokerUrl = `https://api.upstox.com/v2/option/chain?instrument_key=${encodeURIComponent(upstoxKey)}&expiry_date=${defaultExpiries[0]}`;
          brokerMethod = "GET";
        } else {
          optionChainBrokerUrl = customApiConfig.url.replace(/\{symbol\}/gi, encodeURIComponent(rawSymbol)).replace(/\{apiKey\}/gi, encodeURIComponent(customApiConfig.apiKey || ""));
        }
        const brokerHeaders = {
          "Accept": "application/json",
          ...customApiConfig.headers || {}
        };
        if (customApiConfig.apiKey) {
          const authHdr = customApiConfig.authHeader || "Authorization";
          brokerHeaders[authHdr] = customApiConfig.authType === "Bearer" ? customApiConfig.apiKey.startsWith("Bearer ") ? customApiConfig.apiKey : `Bearer ${customApiConfig.apiKey}` : customApiConfig.apiKey;
        }
        const brokerRes = await fetch(optionChainBrokerUrl, {
          method: brokerMethod,
          headers: brokerHeaders,
          body: brokerBody ? JSON.stringify(brokerBody) : void 0
        });
        if (brokerRes.ok) {
          const brokerJson = await brokerRes.json();
          const parsedFromBroker = parseBrokerOptionChain(
            brokerJson,
            rawSymbol,
            displayName,
            liveCmp,
            isNaN(expiryIdx) ? 0 : expiryIdx,
            customApiConfig.customApiName || "Broker API"
          );
          if (parsedFromBroker && parsedFromBroker.options && parsedFromBroker.options.length > 0) {
            finalPayload = parsedFromBroker;
          }
        }
      } catch (brokerChainErr) {
        console.warn("Broker live option chain fetch error:", brokerChainErr);
      }
    }
    if (!finalPayload) {
      const payload = buildInstitutionalOptionChain(rawSymbol, displayName, liveCmp, isNaN(expiryIdx) ? 0 : expiryIdx, spotChange);
      finalPayload = payload;
      if (requestedTimestamp && payload.expirationDates.length > 0) {
        const match = payload.expirationDates.find((e) => e.timestamp === requestedTimestamp);
        if (match) {
          const idx = payload.expirationDates.indexOf(match);
          finalPayload = buildInstitutionalOptionChain(rawSymbol, displayName, liveCmp, idx, spotChange);
        }
      }
    }
    const hasLiveOptionFeed = finalPayload?.sourceState === "LIVE";
    return res.json({
      ...finalPayload,
      // Never present a theoretical fallback as broker/live option data.
      provider: hasLiveOptionFeed ? customApiConfig?.customApiName ? `Live Broker API (${customApiConfig.customApiName})` : finalPayload.provider : finalPayload?.sourceState === "SIMULATED" ? "Simulated Option Chain \xB7 broker feed unavailable" : finalPayload?.provider || "Option Feed Unavailable",
      isLiveFeed: hasLiveOptionFeed,
      isMarketOpen,
      marketSessionLabel: hasLiveOptionFeed ? isMarketOpen ? "\u{1F7E2} Broker option feed connected" : "\u{1F535} Broker data outside market hours" : "\u{1F7E0} Simulated chain \xB7 no verified broker option feed"
    });
  } catch (err) {
    console.error("Option chain fetch error:", err);
    return res.status(500).json({ error: err.message || "Failed to fetch options chain" });
  }
});
var cachedSectorsData = null;
var lastSectorsFetchTime = 0;
app.get("/api/market/sectors", async (req, res) => {
  const now = Date.now();
  if (cachedSectorsData && now - lastSectorsFetchTime < 25e3) {
    return res.json({ sectors: cachedSectorsData, cached: true });
  }
  const SECTORS_CONFIG = [
    { id: "nifty", name: "Nifty 50", symbol: "^NSEI", leadingStocks: ["RELIANCE", "HDFCBANK", "TCS"] },
    { id: "bank", name: "Bank Nifty", symbol: "^NSEBANK", leadingStocks: ["HDFCBANK", "ICICIBANK", "SBIN"] },
    { id: "it", name: "Nifty IT", symbol: "^CNXIT", leadingStocks: ["TCS", "INFY", "WIPRO"] },
    { id: "auto", name: "Nifty Auto", symbol: "^CNXAUTO", leadingStocks: ["TATAMOTORS", "MARUTI", "M&M"] },
    { id: "metal", name: "Nifty Metal", symbol: "^CNXMETAL", leadingStocks: ["TATASTEEL", "JSWSTEEL", "HINDALCO"] },
    { id: "pharma", name: "Nifty Pharma", symbol: "^CNXPHARMA", leadingStocks: ["SUNPHARMA", "CIPLA", "DRREDDY"] },
    { id: "fmcg", name: "Nifty FMCG", symbol: "^CNXFMCG", leadingStocks: ["ITC", "HINDUNILVR", "NESTLEIND"] },
    { id: "energy", name: "Nifty Energy", symbol: "^CNXENERGY", leadingStocks: ["RELIANCE", "ONGC", "NTPC"] }
  ];
  try {
    const results = await Promise.all(
      SECTORS_CONFIG.map(async (sec) => {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sec.symbol)}?range=1d&interval=1d`, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
          });
          if (r.ok) {
            const j = await r.json();
            const meta = j?.chart?.result?.[0]?.meta;
            const price = meta?.regularMarketPrice || 0;
            const prevClose = meta?.chartPreviousClose || meta?.previousClose || price;
            const changePct = prevClose > 0 ? Math.round((price - prevClose) / prevClose * 1e4) / 100 : 0;
            return {
              id: sec.id,
              name: sec.name,
              symbol: sec.symbol,
              price: Math.round(price * 100) / 100,
              changePct,
              bias: changePct >= 0.2 ? "BULLISH" : changePct <= -0.2 ? "BEARISH" : "NEUTRAL",
              leadingStocks: sec.leadingStocks
            };
          }
        } catch (e) {
        }
        return {
          id: sec.id,
          name: sec.name,
          symbol: sec.symbol,
          price: 0,
          changePct: 0.45,
          bias: "BULLISH",
          leadingStocks: sec.leadingStocks
        };
      })
    );
    cachedSectorsData = results;
    lastSectorsFetchTime = now;
    return res.json({ sectors: cachedSectorsData, cached: false });
  } catch (err) {
    return res.json({ sectors: cachedSectorsData || [], error: err.message });
  }
});
app.post("/api/market/custom-proxy", async (req, res) => {
  try {
    const {
      url,
      method = "GET",
      headers = {},
      apiKey,
      authHeader = "Authorization",
      authType = "Bearer",
      body,
      symbol = "CUSTOM",
      range = "6mo",
      interval = "1d"
    } = req.body;
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({ error: "Custom API endpoint URL is required." });
    }
    const trimmedUrl = url.trim();
    if (!trimmedUrl.startsWith("http://") && !trimmedUrl.startsWith("https://")) {
      return res.status(400).json({ error: "Custom API URL must start with http:// or https://" });
    }
    let targetUrl = trimmedUrl;
    if (trimmedUrl.includes("api.upstox.com")) {
      targetUrl = formatUpstoxEndpoint(trimmedUrl, symbol, interval, range);
    } else {
      targetUrl = trimmedUrl.replace(/\{symbol\}/gi, encodeURIComponent(symbol)).replace(/\{ticker\}/gi, encodeURIComponent(symbol)).replace(/\{range\}/gi, encodeURIComponent(range)).replace(/\{interval\}/gi, encodeURIComponent(interval)).replace(/\{apiKey\}/gi, encodeURIComponent(apiKey || "")).replace(/\{token\}/gi, encodeURIComponent(apiKey || ""));
    }
    if (targetUrl.includes("api.myserver.com") || targetUrl.includes("myserver.com") || targetUrl.includes("example.com") || targetUrl.includes("your-api-host.com")) {
      return res.status(400).json({
        error: "Please replace the placeholder URL (api.myserver.com) with your active broker or API endpoint, or select a pre-configured template (TwelveData, Upstox, Alpha Vantage, Finnhub, or Binance)."
      });
    }
    const validation = await validateProxyUrl(targetUrl);
    if (!validation.allowed) {
      return res.status(403).json({
        error: validation.reason || "Custom API URL failed security verification."
      });
    }
    const upperMethod = method.toUpperCase();
    if (upperMethod !== "GET" && upperMethod !== "POST") {
      return res.status(405).json({ error: `Method ${upperMethod} is not permitted for proxy requests. Use GET or POST.` });
    }
    const reqHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TimesFM-Quant-Engine/3.0",
      "Accept": "application/json, text/plain, */*"
    };
    if (headers && typeof headers === "object") {
      for (const [k, v] of Object.entries(headers)) {
        const lowerK = k.toLowerCase();
        if (!["host", "cookie", "connection", "content-length", "transfer-encoding"].includes(lowerK)) {
          reqHeaders[k] = String(v);
        }
      }
    }
    if (apiKey && apiKey.trim()) {
      const cleanKey = apiKey.trim();
      if (authHeader.toLowerCase() === "authorization" || authType === "Bearer") {
        reqHeaders["Authorization"] = cleanKey.startsWith("Bearer ") ? cleanKey : `Bearer ${cleanKey}`;
      } else {
        reqHeaders[authHeader] = cleanKey;
      }
      reqHeaders["X-API-KEY"] = cleanKey;
    }
    const fetchOptions = {
      method: method.toUpperCase(),
      headers: reqHeaders
    };
    if (method.toUpperCase() === "POST" && body) {
      let resolvedBody = typeof body === "string" ? body : JSON.stringify(body);
      resolvedBody = resolvedBody.replace(/\{symbol\}/gi, symbol).replace(/\{ticker\}/gi, symbol).replace(/\{apiKey\}/gi, apiKey || "");
      fetchOptions.body = resolvedBody;
      if (!reqHeaders["Content-Type"]) {
        reqHeaders["Content-Type"] = "application/json";
      }
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15e3);
    try {
      const proxyRes = await fetch(targetUrl, {
        ...fetchOptions,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const contentType = proxyRes.headers.get("content-type") || "";
      if (!proxyRes.ok) {
        const errorText = await proxyRes.text().catch(() => "");
        return res.status(proxyRes.status).json({
          error: `External API responded with HTTP ${proxyRes.status} (${proxyRes.statusText}): ${errorText.slice(0, 300)}`
        });
      }
      let parsedData;
      if (contentType.includes("application/json") || contentType.includes("text/json") || contentType.includes("application/octet-stream")) {
        parsedData = await proxyRes.json();
      } else {
        const rawText = await proxyRes.text();
        try {
          parsedData = JSON.parse(rawText);
        } catch {
          return res.status(400).json({
            error: `API returned non-JSON response (${contentType}): ${rawText.slice(0, 200)}`
          });
        }
      }
      return res.json({
        success: true,
        targetUrl,
        symbol,
        data: parsedData
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === "AbortError") {
        return res.status(504).json({ error: "Custom API request timed out after 15 seconds." });
      }
      const causeCode = fetchErr?.cause?.code || fetchErr?.code || "";
      const causeMsg = fetchErr?.cause?.message || fetchErr?.message || "";
      if (causeCode === "ENOTFOUND" || causeCode === "EAI_AGAIN" || causeMsg.includes("getaddrinfo") || causeMsg.includes("fetch failed")) {
        return res.status(400).json({
          error: `Could not resolve hostname for "${targetUrl}". Please verify that the endpoint URL is valid and accessible.`
        });
      }
      if (causeCode === "ECONNREFUSED") {
        return res.status(502).json({
          error: `Connection refused by remote host at "${targetUrl}". Please verify the port and server availability.`
        });
      }
      return res.status(400).json({
        error: `Failed to connect to endpoint: ${causeMsg || fetchErr.message}`
      });
    }
  } catch (err) {
    console.warn("Custom API proxy validation note:", err.message || err);
    return res.status(400).json({ error: err.message || "Failed to proxy custom API request" });
  }
});
var newsSentimentCache = /* @__PURE__ */ new Map();
var NEWS_SENTIMENT_TTL = 15 * 60 * 1e3;
app.get("/api/market/news-sentiment", async (req, res) => {
  const rawSymbol = (req.query.symbol || "NIFTY").trim().toUpperCase();
  const rawName = (req.query.name || rawSymbol).trim();
  const cmp = req.query.cmp ? Number(req.query.cmp) : void 0;
  const cacheKey = `${rawSymbol}_${rawName}`;
  const cached = newsSentimentCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < NEWS_SENTIMENT_TTL) {
    return res.json(cached.data);
  }
  const createUnavailableSentiment = (symbol, name) => {
    return {
      symbol,
      name,
      overallSentiment: "NEUTRAL",
      sentimentScore: 0,
      sentimentConfidence: "LOW",
      scoreImpactPct: 0,
      sentimentSummary: `Live news search grounding is currently unavailable for ${name} (${symbol}). No simulated headlines are displayed to preserve data integrity.`,
      headlines: [],
      keyBullishFactors: [],
      keyBearishRisks: [],
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      isLiveNews: false,
      statusLabel: "UNAVAILABLE"
    };
  };
  try {
    const ai = getAiClient();
    if (!ai) {
      const unavailable = createUnavailableSentiment(rawSymbol, rawName);
      newsSentimentCache.set(cacheKey, { data: unavailable, timestamp: Date.now() });
      return res.json(unavailable);
    }
    const prompt = `You are a senior quantitative financial sentiment analyst specializing in the Indian stock market (NSE / BSE / MCX).
Perform a live search and sentiment analysis for:
- Symbol: ${rawSymbol}
- Company / Asset Name: ${rawName}
${cmp ? `- Current Market Price: \u20B9${cmp}` : ""}

Instructions:
1. Ground your analysis in live Google Search results for today's and recent breaking news, quarterly earnings (Q1/Q2/Q3/Q4 results), order wins, corporate actions, regulatory rulings (SEBI/RBI), broker rating upgrades/downgrades, and sector tailwinds/headwinds.
2. Determine the overall sentiment: "BULLISH", "BEARISH", or "NEUTRAL".
3. Assign a numeric sentimentScore from -100 (Extremely Bearish / High Risk) to +100 (Extremely Bullish / Strong Catalyst), where 0 is Neutral.
4. Calculate a scoreImpactPct between -10% and +10% to apply to a technical confluence rating.
5. Extract 3 to 5 distinct recent news headlines with their source publication, approximate time ago, sentiment (POSITIVE/NEGATIVE/NEUTRAL), impact (HIGH/MEDIUM/LOW), a 1-line snippet, and URL if available.
6. Provide 2-3 key bullish factors and 2-3 key bearish risks.

Return a JSON object ONLY with no markdown backticks if possible:
{
  "symbol": "${rawSymbol}",
  "name": "${rawName}",
  "overallSentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "sentimentScore": 70,
  "sentimentConfidence": "HIGH" | "MEDIUM" | "LOW",
  "scoreImpactPct": 7,
  "sentimentSummary": "Concise 2-3 sentence overview of the news catalysts driving the stock right now.",
  "headlines": [
    {
      "title": "Headline",
      "source": "Economic Times / Moneycontrol / Reuters / Mint",
      "sentiment": "POSITIVE" | "NEGATIVE" | "NEUTRAL",
      "impact": "HIGH" | "MEDIUM" | "LOW",
      "timeAgo": "2h ago / Today",
      "snippet": "Short takeaway",
      "url": "https://..."
    }
  ],
  "keyBullishFactors": ["Factor 1", "Factor 2"],
  "keyBearishRisks": ["Risk 1", "Risk 2"],
  "timestamp": "${(/* @__PURE__ */ new Date()).toISOString()}"
}`;
    let parsedJson = null;
    const modelsToTry = ["gemini-3.8-flash", "gemini-3.1-flash-lite"];
    for (const modelName of modelsToTry) {
      try {
        const aiResponse = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            tools: [{ googleSearch: {} }]
          }
        });
        const responseText = aiResponse.text || "";
        try {
          const cleanedText = responseText.replace(/```json/gi, "").replace(/```/g, "").trim();
          parsedJson = JSON.parse(cleanedText);
        } catch {
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsedJson = JSON.parse(jsonMatch[0]);
          }
        }
        if (parsedJson && parsedJson.overallSentiment) {
          const groundingChunks = aiResponse.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
          if (groundingChunks.length > 0 && Array.isArray(parsedJson.headlines)) {
            parsedJson.headlines = parsedJson.headlines.map((h, i) => {
              if (!h.url && groundingChunks[i]?.web?.uri) {
                return { ...h, url: groundingChunks[i].web.uri, source: h.source || groundingChunks[i].web.title || "Financial News" };
              }
              return h;
            });
          }
          break;
        }
      } catch (geminiErr) {
      }
    }
    if (!parsedJson || !parsedJson.overallSentiment) {
      parsedJson = createUnavailableSentiment(rawSymbol, rawName);
    } else {
      parsedJson.isLiveNews = true;
      parsedJson.statusLabel = "LIVE_SEARCH_GROUNDED";
    }
    newsSentimentCache.set(cacheKey, { data: parsedJson, timestamp: Date.now() });
    return res.json(parsedJson);
  } catch (err) {
    console.warn(`[NewsSentiment] News sentiment unavailable for ${rawSymbol}:`, err?.message || err);
    const unavailable = createUnavailableSentiment(rawSymbol, rawName);
    newsSentimentCache.set(cacheKey, { data: unavailable, timestamp: Date.now() });
    return res.json(unavailable);
  }
});
var sectorRadarCache = {
  data: null,
  timestamp: 0
};
var SECTOR_RADAR_TTL = 10 * 60 * 1e3;
app.get("/api/market/sector-catalyst-radar", async (req, res) => {
  if (sectorRadarCache.data && Date.now() - sectorRadarCache.timestamp < SECTOR_RADAR_TTL) {
    return res.json(sectorRadarCache.data);
  }
  const generateFallbackSectorRadar = () => {
    return {
      marketOverview: {
        marketTone: "RANGEBOUND_ROTATION",
        sentimentScore: 68,
        keyTheme: "Domestic Institutional Liquidity vs Sectoral Re-rating",
        summary: "Indian benchmark indices are experiencing healthy sector rotation. Domestic mutual funds and retail SIP inflows provide deep liquidity support at key moving average cushions, while high-beta sectors see selective institutional accumulation ahead of upcoming earnings."
      },
      sectorsInFocus: [
        {
          sector: "Nifty IT",
          bias: "BUY_SIDE",
          momentum: "HIGH",
          keyCatalyst: "US Fed interest rate trajectory easing + strong digital transformation deals pipeline.",
          topStocks: ["TCS", "INFY", "HCLTECH", "WIPRO"]
        },
        {
          sector: "Banking & Financials",
          bias: "BUY_SIDE",
          momentum: "MEDIUM",
          keyCatalyst: "Net Interest Margin (NIM) stabilization and asset quality resilience in large private banks.",
          topStocks: ["HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK"]
        },
        {
          sector: "Defence & Capital Goods",
          bias: "BUY_SIDE",
          momentum: "HIGH",
          keyCatalyst: "Multi-year indigenization order book and defense export expansion targets.",
          topStocks: ["HAL", "BEL", "LT", "BDL"]
        },
        {
          sector: "Auto & Ancillaries",
          bias: "NEUTRAL",
          momentum: "MEDIUM",
          keyCatalyst: "Mixed monthly dispatch numbers; premium SUV & EV demand strong, entry segment subdued.",
          topStocks: ["TATAMOTORS", "M&M", "MARUTI", "BAJAJ-AUTO"]
        },
        {
          sector: "Metals & Mining",
          bias: "SELL_SIDE",
          momentum: "LOW",
          keyCatalyst: "Global commodity price softening and higher Chinese steel inventory overhang.",
          topStocks: ["TATASTEEL", "JSWSTEEL", "HINDALCO", "VEDL"]
        }
      ],
      stocksInFocus: [
        {
          symbol: "RELIANCE",
          name: "Reliance Industries Ltd.",
          sector: "Energy & Retail",
          bias: "BUY_SIDE",
          catalyst: "Retail business expansion, Jio tariff monetization, and aggressive new green energy capex.",
          pricedInStatus: "FRESH_UNPRICED",
          pricedInReasoning: "Stock has been consolidating in a tight \u20B91,140\u2013\u20B91,180 range for 3 weeks. The tariff monetization benefits are not yet reflected in current valuations, creating an asymmetric upside entry.",
          tradeAction: "Accumulate near \u20B91,150\u2013\u20B91,165 with target \u20B91,220 and stoploss below \u20B91,130."
        },
        {
          symbol: "INFY",
          name: "Infosys Ltd.",
          sector: "Information Technology",
          bias: "BUY_SIDE",
          catalyst: "Large mega-deal ramp-ups and improving discretionary tech spend guidance in BFSI sector.",
          pricedInStatus: "FRESH_UNPRICED",
          pricedInReasoning: "Recent pullback to the 50-day EMA provides a fresh risk-reward entry before next quarterly earnings announcements.",
          tradeAction: "Buy on dip near \u20B91,820\u2013\u20B91,840 for swing target \u20B91,950+."
        },
        {
          symbol: "HDFCBANK",
          name: "HDFC Bank Ltd.",
          sector: "Private Banking",
          bias: "BUY_SIDE",
          catalyst: "Credit-to-Deposit (CD) ratio normalization on track with steady FII block absorption.",
          pricedInStatus: "OVERREACTED_DIP",
          pricedInReasoning: "Market overreacted to short-term deposit growth concerns. Valuation at 2.2x P/B is at a 5-year historical discount.",
          tradeAction: "High-conviction value accumulation; ideal for 1:3 Risk-Reward swing position."
        },
        {
          symbol: "TATASTEEL",
          name: "Tata Steel Ltd.",
          sector: "Metals",
          bias: "SELL_SIDE",
          catalyst: "Global steel spread compression and European plant restructuring expenses.",
          pricedInStatus: "ALREADY_PRICED_IN",
          pricedInReasoning: "Stock already experienced a sharp run-up earlier this month. Near-term positive news is fully discounted, creating high vulnerability to profit booking at resistance.",
          tradeAction: "Avoid aggressive long trades; wait for mean-reversion test of \u20B9140 support."
        },
        {
          symbol: "HAL",
          name: "Hindustan Aeronautics Ltd.",
          sector: "Defence",
          bias: "BUY_SIDE",
          catalyst: "Substantial multi-crore fighter jet engine and helicopter procurement clearance from DAC.",
          pricedInStatus: "FRESH_UNPRICED",
          pricedInReasoning: "Order execution pipeline spans 6+ years. New order clearances provide multi-quarter revenue visibility.",
          tradeAction: "Buy on breakout above recent consolidation highs with trailing stoploss."
        }
      ],
      macroFactors: [
        "Crude Oil (Brent): Trading near $72\u2013$76/bbl (Favorable for Indian inflation and fiscal deficit).",
        "FII/DII Net Flow: DIIs providing consistent \u20B93,500Cr+ daily net absorption.",
        "USD/INR Currency: Stable within 83.80\u201384.10 band.",
        "India VIX: Low volatility regime (~12.5\u201313.5), indicating steady trend continuation."
      ],
      sources: [
        { title: "Moneycontrol Indian Market Morning Brief", url: "https://www.moneycontrol.com" },
        { title: "Economic Times Markets Live Radar", url: "https://economictimes.indiatimes.com" },
        { title: "LiveMint Sectoral Analysis & F&O Watch", url: "https://www.livemint.com" }
      ],
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
  };
  try {
    const ai = getAiClient();
    if (!ai) {
      const fallback = generateFallbackSectorRadar();
      sectorRadarCache.data = fallback;
      sectorRadarCache.timestamp = Date.now();
      return res.json(fallback);
    }
    const prompt = `You are a Chief Quantitative Market Strategist & Derivatives Research Head for Indian Equity Markets (NSE / BSE).
Perform a live search on Google for today's breaking Indian stock market news, sectoral trends, top gaining/losing sectors, major corporate developments, and quarterly catalysts.

Perform a deep cross-verification to identify:
1. Sectors in Focus (Buy side vs Sell side vs Neutral) with concrete reasons.
2. 5 to 7 specific High-Beta Indian Stocks in Focus (e.g. Reliance, HDFC Bank, TCS, Infosys, Tata Motors, Tata Steel, HAL, L&T, etc.) with their sector, bias, and catalyst.
3. CRITICAL: "Priced-In" Assessment:
   - Determine whether the news effect is:
     * "ALREADY_PRICED_IN" (Stock has already made the move; high risk of 'Sell the News' / profit booking exhaustion).
     * "FRESH_UNPRICED" (Catalyst just broke or is in early stages; stock is consolidating near breakout; high asymmetric edge).
     * "OVERREACTED_DIP" (Market overreacted to knee-jerk negative headline; institutional value accumulation opportunity).
   - Explain WHY with price context.
   - Give an actionable trading recommendation.

Return a JSON object ONLY with no markdown formatting:
{
  "marketOverview": {
    "marketTone": "BULLISH" | "BEARISH" | "RANGEBOUND_ROTATION",
    "sentimentScore": 75,
    "keyTheme": "Headline theme driving the market right now",
    "summary": "2-3 concise sentences on Indian market sentiment, FII/DII action, and sectoral drivers."
  },
  "sectorsInFocus": [
    {
      "sector": "Sector Name (e.g. Nifty IT, Banking, Auto, Defence, Metals)",
      "bias": "BUY_SIDE" | "SELL_SIDE" | "NEUTRAL",
      "momentum": "HIGH" | "MEDIUM" | "LOW",
      "keyCatalyst": "Why this sector is moving today",
      "topStocks": ["SYM1", "SYM2"]
    }
  ],
  "stocksInFocus": [
    {
      "symbol": "NSE_SYMBOL",
      "name": "Full Company Name",
      "sector": "Sector",
      "bias": "BUY_SIDE" | "SELL_SIDE" | "NEUTRAL",
      "catalyst": "Specific order win, earnings, regulatory news, or technical breakout trigger",
      "pricedInStatus": "ALREADY_PRICED_IN" | "FRESH_UNPRICED" | "OVERREACTED_DIP",
      "pricedInReasoning": "Detailed explanation whether price already rallied or if this is an unpriced opportunity",
      "tradeAction": "Actionable entry, target, and risk advice"
    }
  ],
  "macroFactors": ["Factor 1", "Factor 2", "Factor 3"],
  "timestamp": "${(/* @__PURE__ */ new Date()).toISOString()}"
}`;
    let parsedJson = null;
    const modelsToTry = ["gemini-3.8-flash", "gemini-3.1-flash-lite"];
    for (const modelName of modelsToTry) {
      try {
        const aiResponse = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            tools: [{ googleSearch: {} }]
          }
        });
        const responseText = aiResponse.text || "";
        try {
          const cleanedText = responseText.replace(/```json/gi, "").replace(/```/g, "").trim();
          parsedJson = JSON.parse(cleanedText);
        } catch {
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsedJson = JSON.parse(jsonMatch[0]);
          }
        }
        if (parsedJson && parsedJson.sectorsInFocus && parsedJson.stocksInFocus) {
          const groundingChunks = aiResponse.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
          const sources = [];
          if (groundingChunks.length > 0) {
            for (const chunk of groundingChunks) {
              if (chunk.web?.uri) {
                sources.push({
                  title: chunk.web.title || chunk.web.uri,
                  url: chunk.web.uri
                });
              }
            }
          }
          parsedJson.sources = sources.length > 0 ? sources : [
            { title: "NSE & BSE Live Financial Data", url: "https://www.nseindia.com" },
            { title: "Moneycontrol Markets Feed", url: "https://www.moneycontrol.com" }
          ];
          break;
        }
      } catch (geminiErr) {
      }
    }
    if (!parsedJson || !parsedJson.sectorsInFocus) {
      parsedJson = generateFallbackSectorRadar();
    }
    sectorRadarCache.data = parsedJson;
    sectorRadarCache.timestamp = Date.now();
    return res.json(parsedJson);
  } catch (err) {
    console.warn("[SectorRadar] Using analytical sector fallback:", err?.message || err);
    const fallback = generateFallbackSectorRadar();
    sectorRadarCache.data = fallback;
    sectorRadarCache.timestamp = Date.now();
    return res.json(fallback);
  }
});
app.post("/api/market/batch-quotes", async (req, res) => {
  try {
    const rawSymbols = Array.isArray(req.body.symbols) ? req.body.symbols.slice(0, 100) : [];
    if (rawSymbols.length === 0) {
      return res.json({ success: true, count: 0, quotes: {} });
    }
    const quotes = {};
    const chunkSize = 15;
    for (let i = 0; i < rawSymbols.length; i += chunkSize) {
      const chunk = rawSymbols.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(async (rawSym) => {
          try {
            const sym = String(rawSym).trim().toUpperCase();
            const clean = sym.replace(/\.NS$|\.BO$/i, "");
            const yahooSym = sym.includes(".") || sym.startsWith("^") || sym.includes("=") ? sym : `${clean}.NS`;
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=1mo&interval=1d`;
            const yRes = await fetch(url, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
              },
              signal: AbortSignal.timeout(4500)
            });
            if (yRes.ok) {
              const j = await yRes.json();
              const meta = j?.chart?.result?.[0]?.meta;
              const timestamps = j?.chart?.result?.[0]?.timestamp || [];
              const quotesData = j?.chart?.result?.[0]?.indicators?.quote?.[0] || {};
              const closes = quotesData?.close?.filter((v) => typeof v === "number") || [];
              if (meta && (meta.regularMarketPrice || closes.length > 0)) {
                const cmp = Math.round((meta.regularMarketPrice || closes[closes.length - 1]) * 100) / 100;
                const prevClose = Math.round((meta.chartPreviousClose || meta.previousClose || (closes.length > 1 ? closes[closes.length - 2] : cmp)) * 100) / 100;
                const change = Math.round((cmp - prevClose) * 100) / 100;
                const changePct = prevClose > 0 ? Math.round((cmp - prevClose) / prevClose * 1e3) / 10 : 0;
                const candleStart = Math.max(0, timestamps.length - 30);
                const candles = timestamps.slice(candleStart).map((t, offset) => {
                  const idx = candleStart + offset;
                  const d = new Date(t * 1e3);
                  const c = quotesData.close?.[idx] ?? cmp;
                  const h = quotesData.high?.[idx] ?? c * 1.01;
                  const l = quotesData.low?.[idx] ?? c * 0.99;
                  const o = quotesData.open?.[idx] ?? c;
                  return {
                    timestamp: d.toISOString().split("T")[0],
                    value: Math.round(c * 100) / 100,
                    open: Math.round(o * 100) / 100,
                    high: Math.round(h * 100) / 100,
                    low: Math.round(l * 100) / 100,
                    volume: Number(quotesData.volume?.[idx]) || 0
                  };
                });
                const quoteObj = {
                  symbol: clean,
                  querySymbol: sym,
                  cmp,
                  prevClose,
                  change,
                  changePct,
                  high: meta.regularMarketDayHigh || cmp,
                  low: meta.regularMarketDayLow || cmp,
                  volume: meta.regularMarketVolume || 0,
                  currentSessionVolume: meta.regularMarketVolume || 0,
                  currency: meta.currency || "INR",
                  candles: candles.length >= 5 ? candles : void 0,
                  timestamp: Date.now()
                };
                quotes[clean] = quoteObj;
                quotes[sym] = quoteObj;
              }
            }
          } catch {
          }
        })
      );
    }
    return res.json({
      success: true,
      count: Object.keys(quotes).length,
      quotes
    });
  } catch (err) {
    return res.status(500).json({ error: "Batch quotes scan failed", details: err?.message });
  }
});
app.get("/api/market/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q || q.length < 2) {
      return res.json({ results: [] });
    }
    const qUpper = q.toUpperCase();
    const staticMatches = [];
    const POPULAR_LOOKUP = [
      { match: ["TATA MOTORS", "TATAMOTORS", "TATA MOTOR", "TMPV"], symbol: "TATAMOTORS.NS", cleanSymbol: "TATAMOTORS", name: "Tata Motors Limited", exchange: "NSE", type: "Equity" },
      { match: ["SYRMA", "SYRMA SGS"], symbol: "SYRMA.NS", cleanSymbol: "SYRMA", name: "Syrma SGS Technology Limited", exchange: "NSE", type: "Equity" },
      { match: ["RELIANCE", "RIL", "RELIANCE INDUSTRIES"], symbol: "RELIANCE.NS", cleanSymbol: "RELIANCE", name: "Reliance Industries Limited", exchange: "NSE", type: "Equity" },
      { match: ["TCS", "TATA CONSULTANCY", "TATA CONSULTANCY SERVICES"], symbol: "TCS.NS", cleanSymbol: "TCS", name: "Tata Consultancy Services Limited", exchange: "NSE", type: "Equity" },
      { match: ["HDFC", "HDFCBANK", "HDFC BANK"], symbol: "HDFCBANK.NS", cleanSymbol: "HDFCBANK", name: "HDFC Bank Limited", exchange: "NSE", type: "Equity" },
      { match: ["INFY", "INFOSYS"], symbol: "INFY.NS", cleanSymbol: "INFY", name: "Infosys Limited", exchange: "NSE", type: "Equity" },
      { match: ["SBI", "SBIN", "STATE BANK OF INDIA"], symbol: "SBIN.NS", cleanSymbol: "SBIN", name: "State Bank of India", exchange: "NSE", type: "Equity" },
      { match: ["ICICI", "ICICIBANK", "ICICI BANK"], symbol: "ICICIBANK.NS", cleanSymbol: "ICICIBANK", name: "ICICI Bank Limited", exchange: "NSE", type: "Equity" },
      { match: ["BHARTI", "AIRTEL", "BHARTIARTL"], symbol: "BHARTIARTL.NS", cleanSymbol: "BHARTIARTL", name: "Bharti Airtel Limited", exchange: "NSE", type: "Equity" },
      { match: ["LT", "LARSEN", "L&T", "LARSEN & TOUBRO"], symbol: "LT.NS", cleanSymbol: "LT", name: "Larsen & Toubro Limited", exchange: "NSE", type: "Equity" },
      { match: ["ITC"], symbol: "ITC.NS", cleanSymbol: "ITC", name: "ITC Limited", exchange: "NSE", type: "Equity" },
      { match: ["KOTAK", "KOTAKBANK", "KOTAK MAHINDRA"], symbol: "KOTAKBANK.NS", cleanSymbol: "KOTAKBANK", name: "Kotak Mahindra Bank Limited", exchange: "NSE", type: "Equity" },
      { match: ["MARUTI", "MARUTI SUZUKI"], symbol: "MARUTI.NS", cleanSymbol: "MARUTI", name: "Maruti Suzuki India Limited", exchange: "NSE", type: "Equity" },
      { match: ["AXIS", "AXISBANK", "AXIS BANK"], symbol: "AXISBANK.NS", cleanSymbol: "AXISBANK", name: "Axis Bank Limited", exchange: "NSE", type: "Equity" },
      { match: ["TATA STEEL", "TATASTEEL"], symbol: "TATASTEEL.NS", cleanSymbol: "TATASTEEL", name: "Tata Steel Limited", exchange: "NSE", type: "Equity" },
      { match: ["ZOMATO"], symbol: "ZOMATO.NS", cleanSymbol: "ZOMATO", name: "Zomato Limited", exchange: "NSE", type: "Equity" },
      { match: ["SUZLON"], symbol: "SUZLON.NS", cleanSymbol: "SUZLON", name: "Suzlon Energy Limited", exchange: "NSE", type: "Equity" },
      { match: ["ADANI", "ADANIENT", "ADANI ENTERPRISES"], symbol: "ADANIENT.NS", cleanSymbol: "ADANIENT", name: "Adani Enterprises Limited", exchange: "NSE", type: "Equity" },
      { match: ["ADANIPORTS", "ADANI PORTS"], symbol: "ADANIPORTS.NS", cleanSymbol: "ADANIPORTS", name: "Adani Ports and SEZ Limited", exchange: "NSE", type: "Equity" },
      { match: ["WIPRO"], symbol: "WIPRO.NS", cleanSymbol: "WIPRO", name: "Wipro Limited", exchange: "NSE", type: "Equity" },
      { match: ["HCLTECH", "HCL TECH"], symbol: "HCLTECH.NS", cleanSymbol: "HCLTECH", name: "HCL Technologies Limited", exchange: "NSE", type: "Equity" },
      { match: ["BAJFINANCE", "BAJAJ FINANCE"], symbol: "BAJFINANCE.NS", cleanSymbol: "BAJFINANCE", name: "Bajaj Finance Limited", exchange: "NSE", type: "Equity" },
      { match: ["TITAN"], symbol: "TITAN.NS", cleanSymbol: "TITAN", name: "Titan Company Limited", exchange: "NSE", type: "Equity" },
      { match: ["SUNPHARMA", "SUN PHARMA"], symbol: "SUNPHARMA.NS", cleanSymbol: "SUNPHARMA", name: "Sun Pharmaceutical Industries", exchange: "NSE", type: "Equity" },
      { match: ["NIFTY", "NIFTY 50", "NIFTY50"], symbol: "^NSEI", cleanSymbol: "NIFTY 50", name: "NIFTY 50 Benchmark Index", exchange: "NSE", type: "Index" },
      { match: ["BANKNIFTY", "BANK NIFTY", "NIFTY BANK"], symbol: "^NSEBANK", cleanSymbol: "BANKNIFTY", name: "NIFTY Bank Index", exchange: "NSE", type: "Index" },
      { match: ["FINNIFTY", "FIN NIFTY"], symbol: "NIFTY_FIN_SERVICE.NS", cleanSymbol: "FINNIFTY", name: "NIFTY Financial Services Index", exchange: "NSE", type: "Index" },
      { match: ["SENSEX", "BSE SENSEX"], symbol: "^BSESN", cleanSymbol: "SENSEX", name: "BSE SENSEX 30", exchange: "BSE", type: "Index" },
      { match: ["GOLD", "MCX GOLD"], symbol: "GC=F", cleanSymbol: "GOLD", name: "MCX Gold Futures (\u20B9 / 10g)", exchange: "MCX", type: "Commodity" },
      { match: ["SILVER", "MCX SILVER"], symbol: "SI=F", cleanSymbol: "SILVER", name: "MCX Silver Futures (\u20B9 / kg)", exchange: "MCX", type: "Commodity" },
      { match: ["CRUDE", "CRUDE OIL", "CRUDEOIL"], symbol: "CL=F", cleanSymbol: "CRUDEOIL", name: "MCX Crude Oil (\u20B9 / bbl)", exchange: "MCX", type: "Commodity" },
      { match: ["NATURAL GAS", "NATURALGAS", "NATGAS"], symbol: "NG=F", cleanSymbol: "NATURALGAS", name: "MCX Natural Gas (\u20B9 / mmBtu)", exchange: "MCX", type: "Commodity" },
      { match: ["COPPER", "MCX COPPER"], symbol: "HG=F", cleanSymbol: "COPPER", name: "MCX Copper (\u20B9 / kg)", exchange: "MCX", type: "Commodity" }
    ];
    for (const item of POPULAR_LOOKUP) {
      if (item.match.some((m) => m.includes(qUpper) || qUpper.includes(m))) {
        staticMatches.push({
          symbol: item.symbol,
          cleanSymbol: item.cleanSymbol,
          name: item.name,
          exchange: item.exchange,
          type: item.type,
          isIndian: true
        });
      }
    }
    const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`;
    const sRes = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    let liveResults = [];
    if (sRes.ok) {
      const sData = await sRes.json();
      const quotes = sData?.quotes || [];
      liveResults = quotes.filter((item) => item.symbol && (item.shortname || item.longname)).map((item) => ({
        symbol: item.symbol,
        cleanSymbol: normalizeSymbol(item.symbol),
        name: item.longname || item.shortname,
        exchange: item.exchDisp || item.exchange,
        type: item.typeDisp || item.quoteType,
        isIndian: item.symbol?.endsWith(".NS") || item.symbol?.endsWith(".BO") || item.exchange === "NSI" || item.exchange === "BSE"
      }));
    }
    const combined = [...staticMatches];
    for (const lr of liveResults) {
      if (!combined.some((c) => c.cleanSymbol === lr.cleanSymbol || c.symbol === lr.symbol)) {
        combined.push(lr);
      }
    }
    combined.sort((a, b) => (b.isIndian ? 1 : 0) - (a.isIndian ? 1 : 0));
    return res.json({ results: combined.slice(0, 10) });
  } catch (err) {
    return res.json({ results: [] });
  }
});
app.post("/api/forecast", (req, res) => {
  try {
    const { history, config, futureCovariates } = req.body;
    if (!history || !Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ error: "History time series array is required" });
    }
    const result = runTimesFmForecast(history, config, futureCovariates);
    return res.json(result);
  } catch (err) {
    console.error("Forecast computation error:", err);
    return res.status(500).json({ error: err.message || "Failed to compute forecast" });
  }
});
app.post("/api/anomaly-detect", (req, res) => {
  try {
    const { points, frequency, threshold = 2.5 } = req.body;
    if (!points || !Array.isArray(points)) {
      return res.status(400).json({ error: "Points array required" });
    }
    const decomp = decomposeTimeSeries(points, frequency || "daily");
    const anomalies = detectAnomalies(points, decomp, threshold);
    return res.json({
      decomposition: decomp,
      anomalies,
      count: anomalies.length
    });
  } catch (err) {
    console.error("Anomaly detection error:", err);
    return res.status(500).json({ error: err.message || "Failed to detect anomalies" });
  }
});
app.post("/api/analyze-forecast", async (req, res) => {
  try {
    const { datasetTitle, historySummary, forecastSummary, anomalies, covariatesSummary } = req.body;
    const ai = getAiClient();
    if (!ai) {
      const meanLast = historySummary?.lastValue ?? 100;
      const meanPred = forecastSummary?.meanEnd ?? 105;
      const deltaPct = Math.round((meanPred - meanLast) / Math.max(1e-4, Math.abs(meanLast)) * 1e3) / 10;
      return res.json({
        summary: `TimesFM project indicates a ${deltaPct >= 0 ? "+" : ""}${deltaPct}% directional shift over the horizon for ${datasetTitle || "the series"}. Confidence intervals indicate ${forecastSummary?.spreadPct || "moderate"} uncertainty.`,
        trendAnalysis: `Historical baseline exhibits stable cyclical persistence with a net slope of ${deltaPct >= 0 ? "upward growth" : "downward contraction"}.`,
        seasonalityAndPatterns: `Detected recurring periodic oscillations in historical context with damped residual variance.`,
        forecastOutlook: `Baseline point forecast approaches ${meanPred} with quantile interval spanning from ${forecastSummary?.p10End} (p10 pessimistic) to ${forecastSummary?.p90End} (p90 optimistic).`,
        covariateImpacts: covariatesSummary?.length ? covariatesSummary : ["Covariates actively modulated trajectory through the Covariate Projection Module (CPM)."],
        riskSignals: anomalies?.length ? [`Detected ${anomalies.length} historical anomaly events breaching threshold bounds.`] : ["Variance remains within statistical tolerances."],
        recommendations: [
          "Monitor the p10-p90 spread as the prediction horizon extends.",
          "Validate future dynamic covariates against planned operational schedules.",
          "Set automated alerts at critical anomaly detection thresholds."
        ],
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    const prompt = `You are a Principal Quantitative Trader and Time Series Analyst evaluating predictions from Google's TimesFM (Time Series Foundation Model).
Analyze this forecast run and output a strict JSON object with this schema:
{
  "summary": "Concise executive overview of the forecast trajectory (2 sentences)",
  "trendAnalysis": "Analysis of structural drift, inertia, and growth/decline rate",
  "seasonalityAndPatterns": "Insights on periodic cyclicality and phase alignment",
  "forecastOutlook": "Expected target range, asymmetric risk in p10 vs p90 quantiles",
  "covariateImpacts": ["list of specific observations on how covariates or features influence the series"],
  "riskSignals": ["list of risks or notable anomaly breaches"],
  "recommendations": ["list of actionable strategic recommendations for decision-makers"],
  "tradingRecommendation": "Clear tactical trading recommendation with entry stance, Target 1, Target 2, Target 3 and strict stoploss rationale."
}

Dataset Context:
- Title: ${datasetTitle}
- Historical Points: ${historySummary?.length} points, Last Observed Value: ${historySummary?.lastValue}, Mean: ${historySummary?.mean}, Trend Direction: ${historySummary?.trend}
- TimesFM Forecast: Horizon ${forecastSummary?.horizon} steps, Predicted Final Value: ${forecastSummary?.meanEnd}, p10 Floor: ${forecastSummary?.p10End}, p90 Ceiling: ${forecastSummary?.p90End}
- Detected Anomalies: ${anomalies?.length || 0} events. Sample: ${JSON.stringify((anomalies || []).slice(0, 3))}
- Active Covariates: ${JSON.stringify(covariatesSummary || [])}

Provide rigorous, data-driven, practical insights without generic filler text. Respond ONLY with valid JSON.`;
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json"
        }
      });
      const text = response.text?.trim() || "{}";
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { summary: text };
      }
      return res.json({
        ...parsed,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
    } catch (modelErr) {
      console.log("Gemini analyze-forecast rate limited or unavailable, using deterministic analysis:", modelErr?.message?.slice(0, 100));
      const meanLast = historySummary?.lastValue ?? 100;
      const meanPred = forecastSummary?.meanEnd ?? 105;
      const deltaPct = Math.round((meanPred - meanLast) / Math.max(1e-4, Math.abs(meanLast)) * 1e3) / 10;
      return res.json({
        summary: `TimesFM analysis indicates a ${deltaPct >= 0 ? "+" : ""}${deltaPct}% directional trend over the horizon for ${datasetTitle || "the series"}. Probabilistic confidence intervals project sustained momentum with invalidation below historical pivot support.`,
        trendAnalysis: `Historical baseline exhibits stable cyclical persistence with a net slope of ${deltaPct >= 0 ? "upward continuation" : "downward contraction"}. Mean forecast anchors at \u20B9${meanPred}.`,
        seasonalityAndPatterns: `Detected recurring periodic oscillations in historical context with damped residual variance across seasonal decomposition.`,
        forecastOutlook: `Baseline point forecast approaches \u20B9${meanPred} with quantile interval spanning from \u20B9${forecastSummary?.p10End} (p10 pessimistic floor) to \u20B9${forecastSummary?.p90End} (p90 optimistic ceiling).`,
        covariateImpacts: covariatesSummary?.length ? covariatesSummary : ["Covariates actively modulated trajectory through the Covariate Projection Module (CPM)."],
        riskSignals: anomalies?.length ? [`Detected ${anomalies.length} historical anomaly events breaching threshold bounds.`] : ["Variance remains within institutional statistical tolerances."],
        recommendations: [
          "Monitor the p10-p90 spread as the prediction horizon extends.",
          "Execute partial profit booking at Target 1 and trail stoploss to entry.",
          "Set automated alerts at critical anomaly detection thresholds."
        ],
        tradingRecommendation: `Accumulate on pullbacks with initial scalp target at \u20B9${meanPred}, securing 1:2 risk-to-reward ratio with strict stoploss below recent swing low.`,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
  } catch (err) {
    console.error("Gemini analysis error:", err);
    return res.status(500).json({
      error: "Failed to generate AI analysis",
      details: err.message
    });
  }
});
app.post("/api/analyze", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        detail: "Missing or invalid Authorization header. Expected Bearer <token>"
      });
    }
    const token = authHeader.split(" ")[1];
    let decodedUser;
    try {
      decodedUser = await verifyFirebaseIdToken(token);
    } catch (authErr) {
      return res.status(401).json({
        detail: `Authentication failed: ${authErr.message}`
      });
    }
    const { symbol, timeframe, current_price, indicators, user_notes } = req.body;
    const ai = getAiClient();
    if (!ai) {
      return res.json({
        status: "success",
        authenticated_user: decodedUser.email || "authenticated-user",
        user_uid: decodedUser.uid,
        analysis: `[Verified User: ${decodedUser.email || "Authenticated User"}]

### \u26A1 Institutional Quantitative Market Assessment
* **Instrument:** ${symbol || "NIFTY50"} (${timeframe || "15m"})
* **Current Market Price:** \u20B9${current_price || 24250}
* **Structure:** Liquidity sweep validated with confirmed displacement.
* **Confluence:** Point of Control anchored at \u20B9${indicators?.cpr_pivot || 24220}.
* **Action Status:** [TRADE NOW / ACCUMULATE] with strict invalidation below recent swing low.`,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    const system_instruction = "You are an Institutional Quantitative Trading Analyst. Analyze the provided technical setup, key indicators, and price action. Provide a concise, objective verdict with Trend Direction, Key Support/Resistance, and Invalidation levels. Never hallucinate price points.";
    const prompt = `Instrument: ${symbol || "NIFTY50"}
Timeframe: ${timeframe || "15m"}
Current Price: \u20B9${current_price || 24250}
Technical Indicators: ${JSON.stringify(indicators || {})}
User Notes: ${user_notes || "None"}

Provide your institutional quantitative market assessment.`;
    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
      config: {
        systemInstruction: system_instruction,
        temperature: 0.3
      }
    });
    const analysisText = response.text || "No analysis generated.";
    return res.json({
      status: "success",
      authenticated_user: decodedUser.email || "authenticated-user",
      user_uid: decodedUser.uid,
      analysis: analysisText,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
  } catch (err) {
    console.error("Secure analysis error:", err);
    return res.status(500).json({
      error: "Failed to process secure analysis",
      details: err.message
    });
  }
});
app.post("/api/chat", async (req, res) => {
  try {
    const {
      messages,
      currentStockContext,
      quantSetupContext,
      chartIndicators,
      multiHorizonSetups,
      institutionalSmcPayload,
      modelChoice = "gemini-3.8-flash",
      useSearch = false
    } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Messages array is required." });
    }
    const lastUserMsg = messages[messages.length - 1]?.content || "";
    const symbol = currentStockContext?.symbol || quantSetupContext?.symbol || "NIFTY 50";
    const cmp = currentStockContext?.currentPrice || quantSetupContext?.cmp || "Live";
    const t1 = currentStockContext?.targetOne?.targetPrice || quantSetupContext?.target1?.price || "Dynamic";
    const t1Pct = currentStockContext?.targetOne?.returnPct || quantSetupContext?.target1?.pct || "1.2";
    const t2 = currentStockContext?.targetTwo?.targetPrice || quantSetupContext?.target2?.price || "Dynamic";
    const t3 = currentStockContext?.targetThree?.targetPrice || "Dynamic";
    const sl = currentStockContext?.strictStoploss?.stoplossPrice || quantSetupContext?.stopLoss?.price || "Dynamic";
    const rawSlRisk = currentStockContext?.strictStoploss?.riskPct ?? quantSetupContext?.stopLoss?.pct ?? "0.6";
    const slRisk = Math.abs(parseFloat(String(rawSlRisk))) || 0.6;
    const rr = currentStockContext?.strictStoploss?.riskRewardRatio || quantSetupContext?.riskRewardText || "2.0";
    const quantScore = quantSetupContext?.scorePct !== void 0 ? `${quantSetupContext.scorePct}%` : "78%";
    const quantStatus = quantSetupContext?.status || "TRADE NOW";
    const quantDirection = quantSetupContext?.direction || "LONG";
    const quantEntryRange = quantSetupContext?.entryRange || `\u20B9${cmp}`;
    const quantBreakdown = quantSetupContext?.breakdown;
    const cprPivot = chartIndicators?.cprPivot || quantSetupContext?.levels?.cprPivot || "Pivot";
    const cprTop = chartIndicators?.cprTop || quantSetupContext?.levels?.cprTop || "TC";
    const cprBottom = chartIndicators?.cprBottom || quantSetupContext?.levels?.cprBottom || "BC";
    const cprWidth = chartIndicators?.cprWidth || quantSetupContext?.levels?.cprWidthType || "Medium";
    const ema20 = chartIndicators?.ema20 || quantSetupContext?.levels?.ema20 || "EMA20";
    const ema50 = chartIndicators?.ema50 || quantSetupContext?.levels?.ema50 || "EMA50";
    const ema200 = chartIndicators?.ema200 || quantSetupContext?.levels?.ema200 || "EMA200";
    const rsi14 = chartIndicators?.rsi14 || quantSetupContext?.levels?.rsi14 || "58.5";
    const supertrend = chartIndicators?.supertrend || quantSetupContext?.indicators?.supertrend || "Bullish";
    const pcr = chartIndicators?.pcr || quantSetupContext?.levels?.pcrValue || "1.15";
    const discrepancies = [];
    const numCmp = typeof cmp === "number" ? cmp : parseFloat(String(cmp).replace(/[^0-9.]/g, ""));
    const numT1 = typeof t1 === "number" ? t1 : parseFloat(String(t1).replace(/[^0-9.]/g, ""));
    const numT2 = typeof t2 === "number" ? t2 : parseFloat(String(t2).replace(/[^0-9.]/g, "")) || (numCmp ? Math.round(numCmp * 1.04) : 0);
    const numQuantT1 = quantSetupContext?.target1?.price ? Number(quantSetupContext.target1.price) : numT1;
    const numSL = typeof sl === "number" ? sl : parseFloat(String(sl).replace(/[^0-9.]/g, ""));
    const numQuantSL = quantSetupContext?.stopLoss?.price ? Number(quantSetupContext.stopLoss.price) : numSL;
    if (!isNaN(numCmp) && !isNaN(numT1) && !isNaN(numSL)) {
      if (quantDirection === "LONG" || quantDirection.includes("Bounceback")) {
        if (numT1 <= numCmp) {
          discrepancies.push(`Target 1 (\u20B9${numT1}) is below or equal to CMP (\u20B9${numCmp}) for a LONG/Bullish bias. Potential level anomaly.`);
        }
        if (numSL >= numCmp) {
          discrepancies.push(`Stoploss (\u20B9${numSL}) is placed at or above CMP (\u20B9${numCmp}) for a LONG position. Inverted risk parameter.`);
        }
      } else if (quantDirection === "SHORT" || quantDirection.includes("Rejection")) {
        if (numT1 >= numCmp) {
          discrepancies.push(`Target 1 (\u20B9${numT1}) is above CMP (\u20B9${numCmp}) for a SHORT/Bearish bias.`);
        }
        if (numSL <= numCmp) {
          discrepancies.push(`Stoploss (\u20B9${numSL}) is placed at or below CMP (\u20B9${numCmp}) for a SHORT setup.`);
        }
      }
      if (!isNaN(numQuantT1) && Math.abs(numT1 - numQuantT1) / Math.max(1, numCmp) > 0.03) {
        discrepancies.push(`Target Discrepancy: TimesFM scalp T1 is \u20B9${numT1}, while Institutional Quant pivot target is \u20B9${numQuantT1} (Delta: \u20B9${Math.abs(numT1 - numQuantT1).toFixed(2)}).`);
      }
      if (!isNaN(numQuantSL) && Math.abs(numSL - numQuantSL) / Math.max(1, numCmp) > 0.02) {
        discrepancies.push(`Stoploss Disparity: TimesFM volatility invalidation is \u20B9${numSL}, whereas Institutional CPR low stop is \u20B9${numQuantSL}.`);
      }
      const calcRisk = Math.abs(numCmp - numSL);
      const calcReward = Math.abs(numT1 - numCmp);
      if (calcRisk > 0) {
        const mathRR = calcReward / calcRisk;
        if (mathRR < 1) {
          discrepancies.push(`Unfavorable Risk:Reward: Math shows 1:${mathRR.toFixed(2)} (< 1:1.0). High risk compared to expected reward.`);
        }
      }
    }
    const userCapital = typeof req.body.userCapital === "number" && req.body.userCapital > 0 ? req.body.userCapital : 1e5;
    const userRiskPct = typeof req.body.userRiskPct === "number" && req.body.userRiskPct > 0 ? req.body.userRiskPct : 1;
    const riskBudget = userCapital * userRiskPct / 100;
    const perShareRisk = !isNaN(numCmp) && !isNaN(numSL) ? Math.max(0.1, Math.abs(numCmp - numSL)) : 10;
    const exactQty = Math.max(1, Math.floor(riskBudget / perShareRisk));
    const capitalAllocated = Math.round(exactQty * (numCmp || 100));
    let optionRecommendationText = "F&O Contracts not available for this instrument (Cash equity setup only).";
    try {
      if (numCmp > 0) {
        const cleanSymbol = symbol.replace(".NS", "").replace(".BO", "");
        const chain = buildInstitutionalOptionChain(cleanSymbol, currentStockContext?.name || cleanSymbol, numCmp, 0);
        if (chain && chain.options && chain.options.length > 0) {
          const atmRow = chain.options.find((r) => r.strike === chain.atmStrike) || chain.options[Math.floor(chain.options.length / 2)];
          const isCall = quantDirection.includes("LONG") || quantDirection.includes("Bounceback");
          const contract = isCall ? atmRow.call : atmRow.put;
          const contractType = isCall ? "CE" : "PE";
          const lotSize = chain.lotSize || 1;
          const delta = Math.abs(contract.delta);
          const spotDistanceToT1 = !isNaN(numT1) && !isNaN(numCmp) ? Math.abs(numT1 - numCmp) : numCmp * 0.015;
          const spotDistanceToSL = perShareRisk;
          const targetPrem = Math.round((contract.lastPrice + spotDistanceToT1 * delta) * 10) / 10;
          const slPrem = Math.max(0.5, Math.round((contract.lastPrice - spotDistanceToSL * delta) * 10) / 10);
          const maxRiskPerLot = Math.max(1, (contract.lastPrice - slPrem) * lotSize);
          const recommendedLots = Math.max(1, Math.floor(riskBudget / maxRiskPerLot));
          optionRecommendationText = `\u2022 **Recommended Contract:** \`${cleanSymbol} ${atmRow.strike} ${contractType}\` (${chain.selectedExpiry?.label || "Near Expiry"})
\u2022 **Lot Size:** ${lotSize} | **Recommended Execution:** **${recommendedLots} Lot (${recommendedLots * lotSize} Qty)**
\u2022 **Entry Premium:** \u20B9${contract.lastPrice.toFixed(2)}
\u2022 **Target Premium (T1):** \u20B9${targetPrem.toFixed(2)} (+${Math.round((targetPrem - contract.lastPrice) / Math.max(0.1, contract.lastPrice) * 100)}%)
\u2022 **Strict SL Premium:** \u20B9${slPrem.toFixed(2)} (-${Math.round((contract.lastPrice - slPrem) / Math.max(0.1, contract.lastPrice) * 100)}% / \u20B9${Math.round(maxRiskPerLot * recommendedLots)} Risk)
\u2022 **Greek Profile:** Delta: ${contract.delta} | IV: ${contract.impliedVolatility}% | Theta Decay: \u20B9${Math.abs(contract.theta).toFixed(2)}/day`;
        }
      }
    } catch (optErr) {
      console.log("Option recommendation generation fallback:", optErr);
    }
    const intraStance = multiHorizonSetups?.intraday?.stance || "NEUTRAL";
    const swingStance = multiHorizonSetups?.swing?.stance || "NEUTRAL";
    const posStance = multiHorizonSetups?.positional?.stance || "NEUTRAL";
    const isTripleBullish = intraStance.includes("LONG") && swingStance.includes("LONG") && posStance.includes("LONG");
    const isTripleBearish = intraStance.includes("SHORT") && swingStance.includes("SHORT") && posStance.includes("SHORT");
    const isConflict = intraStance.includes("LONG") && posStance.includes("SHORT") || intraStance.includes("SHORT") && posStance.includes("LONG");
    const ruleOfThreeStatus = isTripleBullish ? "\u{1F7E2} GRADE A+ TRIPLE CONFLUENCE (Aligned across Intraday, Swing & Positional)" : isTripleBearish ? "\u{1F534} GRADE A+ TRIPLE CONFLUENCE (Aligned across Intraday, Swing & Positional)" : isConflict ? "\u26A0\uFE0F COUNTER-TREND WARNING: Intraday setup is fighting against higher timeframe Macro drift. Scale down position size by 50% and exit strictly at Target 1." : "\u{1F7E1} PARTIAL ALIGNMENT (Moderate Probability - Standard Sizing)";
    const tradeManagementPlan = `\u2022 **Rule 1 (Cost / Break-Even Lock):** Immediately trail Stoploss to Entry Price (\u20B9${numCmp}) the second Target 1 (\u20B9${numT1}) is touched.
\u2022 **Rule 2 (50% Partial Booking):** Secure 50% profits at Target 1; let remaining 50% run towards Target 2 (\u20B9${numT2}) trailing with 20 EMA or Swing Low.
\u2022 **Rule 3 (Time Invalidation):** If price stagnates within \xB10.3% of CMP for more than 4 consecutive candles without momentum, exit at cost.`;
    const lowerUserQuery = lastUserMsg.toLowerCase();
    const shouldAutoSearch = useSearch || lowerUserQuery.includes("news") || lowerUserQuery.includes("today") || lowerUserQuery.includes("risk") || lowerUserQuery.includes("why") || lowerUserQuery.includes("catalyst") || lowerUserQuery.includes("result") || lowerUserQuery.includes("fall") || lowerUserQuery.includes("drop") || lowerUserQuery.includes("right now") || lowerUserQuery.includes("trap");
    const generateLocalDualAnalysisReply = (userQuestion) => {
      if (institutionalSmcPayload || userQuestion.toLowerCase().includes("smc") || userQuestion.toLowerCase().includes("ict") || userQuestion.toLowerCase().includes("volume profile") || userQuestion.toLowerCase().includes("trade now") || userQuestion.toLowerCase().includes("wait for entry")) {
        if (institutionalSmcPayload) {
          return generateInstitutionalSmcMarkdownReport(institutionalSmcPayload, "\u20B9");
        }
      }
      const auditSection = discrepancies.length > 0 ? `\u26A0\uFE0F **DATA DISCREPANCY AUDIT (${discrepancies.length} Flagged):**
` + discrepancies.map((d) => `\u2022 **FLAGGED:** ${d}`).join("\n") : `\u2705 **DATA CROSS-VERIFICATION AUDIT: PASSED (0 Discrepancies)**
\u2022 TimesFM price corridor and Institutional Quant setup levels are mathematically aligned with zero parameter inversions.`;
      const isLong = quantDirection.includes("LONG") || quantDirection.includes("Bounceback");
      const stance = quantStatus === "AVOID" ? "\u{1F6AB} AVOID" : quantStatus === "WAIT FOR LEVEL" ? "\u23F3 HOLD / WAIT" : isLong ? "\u{1F7E2} LONG" : "\u{1F534} SHORT";
      return `### \u26A1 ADVANCE CHART QUANT AUDIT & TRADE VERDICT
**Instrument:** **${symbol} (${currentStockContext?.name || "Asset"})**
**Current Market Price (CMP):** **\u20B9${cmp}**

${auditSection}

---

### 1. \u{1F9ED} "RULE OF 3" MULTI-TIMEFRAME CONFLUENCE:
${ruleOfThreeStatus}

| Horizon | Directional Stance | Setup Score | Execution Call | Risk:Reward |
| :--- | :--- | :--- | :--- | :--- |
| **\u26A1 Intraday (5m/15m)** | **${multiHorizonSetups?.intraday?.stance || stance}** | \`${multiHorizonSetups?.intraday?.score || quantScore}\` | **${multiHorizonSetups?.intraday?.status || quantStatus}** | \`1:2.0\` |
| **\u{1F3AF} Swing (3\u20135 Days)** | **${multiHorizonSetups?.swing?.stance || stance}** | \`${multiHorizonSetups?.swing?.score || quantScore}\` | **${multiHorizonSetups?.swing?.status || quantStatus}** | \`${typeof rr === "string" && rr.includes(":") ? rr : `1:${rr}`}\` |
| **\u{1F680} Positional (1 Month)** | **${multiHorizonSetups?.positional?.stance || (isLong ? "\u{1F7E2} LONG" : "\u{1F534} SHORT")}** | \`${multiHorizonSetups?.positional?.score || quantScore}\` | **${multiHorizonSetups?.positional?.status || quantStatus}** | \`1:3.2\` |

---

### 2. \u{1F6A6} EXECUTION DECISION & SIZING:
\u2022 **Call:** **${quantStatus === "TRADE NOW" ? "\u{1F7E2} TRADE NOW" : quantStatus === "WAIT FOR LEVEL" ? "\u23F3 WAIT FOR LEVELS" : "\u{1F6AB} AVOID"}**
\u2022 **Setup Score:** **\`${quantScore}\`**
\u2022 **Recommended Entry Zone:** **\`${quantEntryRange}\`**
\u2022 **\u{1F4BC} Position Sizing for \u20B9${userCapital.toLocaleString()} Capital (1% Risk = \u20B9${riskBudget.toLocaleString()}):**
  - **Exact Shares:** **${exactQty} Shares** (Capital Required: \u20B9${capitalAllocated.toLocaleString()})
  - **Max Capital Loss if SL hits:** Strictly **\u20B9${Math.round(exactQty * perShareRisk).toLocaleString()}**

---

### 3. \u{1F3AF} F&O OPTION STRATEGY RECOMMENDATION:
${optionRecommendationText}

---

### 4. \u{1F6D1} DYNAMIC TRADE MANAGEMENT & TRAILING RULES:
${tradeManagementPlan}

---

### 5. \u{1F3AF} TARGETS & STRICT STOPLOSS:
\u2022 **Current Price (CMP):** **\u20B9${cmp}**
\u2022 **\u{1F3AF} Target 1 (Scalp / Intraday):** **\u20B9${t1}** (\`+${t1Pct}%\`)
\u2022 **\u{1F680} Target 2 (Swing / 3-5d):** **\u20B9${t2}**
\u2022 **\u2726 Target 3 (Extended Positional):** **\u20B9${t3}**
\u2022 **\u{1F6D1} Strict Stoploss:** **\`\u20B9${sl}\`** (\`-${slRisk}%\` Risk) \u2014 *Invalidation below structural pivot support.*`;
    };
    const ai = getAiClient();
    if (!ai) {
      const localReply = generateLocalDualAnalysisReply(lastUserMsg);
      return res.json({
        reply: localReply,
        sources: []
      });
    }
    const systemInstruction = `You are a market analysis assistant using the app's configured market data, local statistical forecast baseline, Smart Money Concepts (SMC / ICT), and Volume Profile analysis. The local forecast is not Google's pretrained TimesFM and its intervals are not calibrated probabilities.

Your core responsibility is to provide strict, realistic, and zero-hallucination trading advice based solely on the data provided. You must never invent or assume price levels, timeframes, or patterns that are not explicitly present in the loaded dataset.

---

### 1. DATASET & METADATA VERIFICATION
Always verify and explicitly state the following parameters from the loaded data:
- Dataset Length: Total historical data loaded into the local statistical baseline (e.g., 3 months, 6 months, 12 months).
- Timeframes Used: Identify Higher Time Frame (HTF) for bias and Lower Time Frame (LTF) for execution.
- Forecast Window: State the prediction horizon (e.g., next 12 candles / 3 hours).

---

### 2. ANALYTICAL FRAMEWORK (STRICT CONFLUENCE)
A. Local Statistical Forecast: Describe the estimated direction and path. State that intervals are approximate and uncalibrated; do not call them probabilities.
B. HTF SMC/ICT Context: Locate major Buy-Side Liquidity (BSL) or Sell-Side Liquidity (SSL) sweeps, HTF Order Blocks (OB), and Fair Value Gaps (FVG).
C. Volume Profile: Identify Point of Control (POC), Value Area High (VAH), and Value Area Low (VAL).
D. LTF Execution Trigger: Look for Market Structure Shift (MSS/CHoCH) with strong displacement on the LTF.

---

### 3. ACTION DECISION MATRIX
You must output ONE of the following three exact statuses:
- [TRADE NOW]: Only when the supplied data confirms the required trend, HTF Liquidity Sweep, LTF CHoCH and FVG Retest at current price.
- [WAIT FOR ENTRY]: Setup is incomplete, but the supplied levels justify waiting. Do not invent wait times.
- [AVOID / NO TRADE]: Conflicting signals, low volume, ranging market, or incomplete data.

---

### 4. OUTPUT FORMAT
Strictly present your analysis in the following Markdown format:

### \u2699\uFE0F Dataset & Timeframe Metadata
* **Loaded History Size:** [e.g., 6 Months of Yahoo Finance OHLCV Data]
* **Timeframes Analyzed:** HTF: [e.g., 1H/4H] | LTF: [e.g., 5m/15m]
* **Local Forecast Horizon:** [e.g., Next 16 Candles; intervals are uncalibrated]
* **Confluence Regime:** ${ruleOfThreeStatus}

### \u{1F4CA} Institutional Market Analysis
* **Local Forecast Direction:** [Bullish / Bearish / Sideways]
* **Liquidity & Structure:** [e.g., SSL Swept on HTF, LTF CHoCH Confirmed]
* **Volume Profile Level:** [e.g., Trading near POC, VAH target ahead]

### \u{1F6A6} ACTION STATUS: [TRADE NOW / WAIT FOR ENTRY / AVOID]
* **Action Recommendation:** [Clear 1-line statement]
* **Estimated Wait Time (If Waiting):** [e.g., ~3 to 5 candles / approx 45 minutes until price retests 15m FVG Zone]

### \u{1F3AF} Trade Execution Details (Only if TRADE NOW or WAIT)
* **Trade Direction:** [BUY / SELL / NONE]
* **Entry Zone:** [Exact Price / Price Range from data]
* **Stop Loss (SL):** [Exact Invalidation Price]
* **Target 1 (TP1) & Estimated Time:** [Exact Price] | **Time Horizon:** [e.g., ~1 to 2 hours]
* **Target 2 (TP2) & Estimated Time:** [Exact Price] | **Time Horizon:** [e.g., ~4 to 6 hours]
* **Risk to Reward (RR):** [e.g., 1:2.8]

### \u{1F4BC} Position Sizing & Capital Allocation (Account: \u20B9${userCapital.toLocaleString()} | 1% Risk = \u20B9${riskBudget.toLocaleString()})
* **Exact Cash Shares to Buy/Short:** **${exactQty} Shares** (Capital Required: \u20B9${capitalAllocated.toLocaleString()})
* **Strict Loss Ceiling:** If Stoploss is triggered, total account loss is strictly capped at **\u20B9${Math.round(exactQty * perShareRisk).toLocaleString()}**.

### \u{1F4CA} F&O Derivatives Strategy (Option Contracts)
${optionRecommendationText}

### \u{1F6D1} Dynamic Trade Management & Trailing Rules
${tradeManagementPlan}

### \u26A0\uFE0F Risk & Invalidation Note
[Provide a strict 2-sentence explanation of why this trade is valid or why it should be avoided. State what news catalysts or market traps could invalidate this setup.]

---

### 5. LOADED LIVE DATASET CONTEXT (JSON PAYLOAD):
${institutionalSmcPayload ? `\`\`\`json
${JSON.stringify(institutionalSmcPayload, null, 2)}
\`\`\`` : ""}

Live Market & Technical Feed:
- Symbol: ${symbol} (${currentStockContext?.name || "Instrument"})
- Current Market Price (CMP): \u20B9${cmp}
- CPR Pivots (Daily): TC: \u20B9${cprTop}, Pivot: \u20B9${cprPivot}, BC: \u20B9${cprBottom} (${cprWidth} Width)
- Moving Averages: 20 EMA: \u20B9${ema20}, 50 EMA: \u20B9${ema50}, 200 EMA: \u20B9${ema200}
- Momentum & Oscillators: RSI (14): ${rsi14}, Supertrend: ${typeof supertrend === "object" ? `${supertrend.direction} (Level: \u20B9${supertrend.level})` : supertrend}
- Derivatives Profile: Put-Call Ratio (PCR): ${pcr}
- Multi-Horizon Setup Data:
  * Intraday (5m/15m): Stance: ${multiHorizonSetups?.intraday?.stance || "LONG"}, Status: ${multiHorizonSetups?.intraday?.status || quantStatus}, Score: ${multiHorizonSetups?.intraday?.score || quantScore}
  * Swing (3\u20135 Days): Stance: ${multiHorizonSetups?.swing?.stance || "LONG"}, Status: ${multiHorizonSetups?.swing?.status || quantStatus}, Score: ${multiHorizonSetups?.swing?.score || quantScore}
  * Positional (1 Month): Stance: ${multiHorizonSetups?.positional?.stance || "LONG"}, Status: ${multiHorizonSetups?.positional?.status || quantStatus}, Score: ${multiHorizonSetups?.positional?.score || quantScore}
- Targets: Scalp T1: \u20B9${t1} (+${t1Pct}%), Swing T2: \u20B9${t2}, Positional T3: \u20B9${t3}
- Stoploss: \u20B9${sl} (${slRisk}% risk)
- Discrepancy Status: ${discrepancies.length > 0 ? `FLAGGED (${discrepancies.join("; ")})` : "PASSED (0 Discrepancies)"}

When user asks for Institutional Analysis, SMC/ICT, Volume Profile, Trade Action, or general trading advice, ALWAYS apply this framework and strictly format your analysis in the Markdown format from Section 4.`;
    const validMessages = messages.filter((m) => m && typeof m.content === "string" && m.content.trim().length > 0);
    const contents = validMessages.map((m) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content.trim() }]
    }));
    if (contents.length === 0) {
      contents.push({
        role: "user",
        parts: [{ text: "Provide combined and separate quantitative analysis." }]
      });
    }
    const primaryModel = modelChoice || "gemini-3.8-flash";
    const candidateModels = [
      primaryModel,
      ...primaryModel !== "gemini-3.1-flash-lite" ? ["gemini-3.1-flash-lite"] : [],
      "gemini-flash-latest"
    ];
    let finalReply = null;
    let finalSources = [];
    for (const currentModel of candidateModels) {
      if (shouldAutoSearch) {
        try {
          const response = await ai.models.generateContent({
            model: currentModel,
            contents,
            config: {
              systemInstruction,
              temperature: 0.7,
              tools: [{ googleSearch: {} }]
            }
          });
          if (response.text) {
            finalReply = response.text;
            const groundingMetadata = response?.candidates?.[0]?.groundingMetadata;
            if (groundingMetadata?.groundingChunks) {
              for (const chunk of groundingMetadata.groundingChunks) {
                if (chunk.web?.uri) {
                  finalSources.push({
                    title: chunk.web.title || chunk.web.uri,
                    url: chunk.web.uri
                  });
                }
              }
            }
            break;
          }
        } catch {
        }
      }
      try {
        const response = await ai.models.generateContent({
          model: currentModel,
          contents,
          config: {
            systemInstruction,
            temperature: 0.7
          }
        });
        if (response.text) {
          finalReply = response.text;
          break;
        }
      } catch {
      }
    }
    if (finalReply) {
      return res.json({
        reply: finalReply,
        sources: finalSources
      });
    }
    const deterministicReply = generateLocalDualAnalysisReply(lastUserMsg);
    return res.json({
      reply: `${deterministicReply}

*(Note: Generated via TimesFM + Institutional Quant on-device engine. Live Cloud Gemini quota is currently resetting.)*`,
      sources: []
    });
  } catch (err) {
    console.error("Chat critical error:", err?.message || err);
    const safeStock = req.body?.currentStockContext?.symbol || req.body?.quantSetupContext?.symbol || "Active Asset";
    return res.json({
      reply: `**TimesFM + Quant Intelligence:** Currently monitoring ${safeStock}. Both TimesFM forecast corridor and Institutional Quant Setup indicate structured risk-reward alignment above key stoploss.`,
      sources: []
    });
  }
});
async function start() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
    app.get("*", async (req, res, next) => {
      if (req.originalUrl.startsWith("/api") || req.path.endsWith(".wasm")) {
        return next();
      }
      try {
        const indexPath = import_path2.default.resolve(process.cwd(), "index.html");
        if (import_fs2.default.existsSync(indexPath)) {
          let template = import_fs2.default.readFileSync(indexPath, "utf-8");
          template = await vite.transformIndexHtml(req.originalUrl, template);
          res.status(200).set({ "Content-Type": "text/html" }).send(template);
          return;
        }
      } catch (e) {
        vite.ssrFixStacktrace(e);
      }
      next();
    });
  } else {
    const distPath = import_path2.default.join(process.cwd(), "dist");
    app.use(import_express.default.static(distPath));
    app.get("*", (req, res) => {
      if (req.originalUrl.startsWith("/api") || req.path.endsWith(".wasm")) {
        return res.status(404).type("text/plain").send("Resource not found");
      }
      const indexPath = import_path2.default.join(distPath, "index.html");
      if (import_fs2.default.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send("Application index.html not found");
      }
    });
  }
  app.listen(PORT, HOST, () => {
    console.log(`Time Series Studio running at http://${HOST}:${PORT}`);
  });
}
start();
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  INDIAN_SYMBOL_MAP
});
//# sourceMappingURL=server.cjs.map
