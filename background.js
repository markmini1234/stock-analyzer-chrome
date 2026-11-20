const CACHE_TTL_MS = 1000 * 60 * 5;
const XUEQIU_BASE = "https://stock.xueqiu.com/v5";
const MEMORY_KEEP_DAYS = 120;
const MEMORY_MAX_ENTRIES = 8000;
const BACKTEST_WINDOWS = [5, 10, 20, 30];
const PREFETCH_MAX_SYMBOLS = 60;
const PREFETCH_CONCURRENCY = 2;
const TREND_MIN_SCORE = 8;
const BREAKOUT_VOLUME_THRESHOLD = 1.2;
const MATERIAL_SEARCH_QUERY_LIMIT = 10;
const MATERIAL_RESULTS_PER_QUERY = 12;
const MATERIAL_TOP_N = 12;
const MATERIAL_PROMPT_TOP_N = 10;
const MATERIAL_PREVIEW_FETCH_LIMIT = 12;
const MATERIAL_PREVIEW_CHAR_LIMIT = 1800;
const MATERIAL_LOCAL_TEXT_CHAR_LIMIT = 12000;
const MATERIAL_READ_CONCURRENCY = 2;
const MATERIAL_AI_READ_MAX_TOKENS = 380;
const MATERIAL_MIN_RELEVANCE_SCORE = 2;
const MATERIAL_RECENT_DAYS = 92;
const MATERIAL_STRICT_FIXED_MODE = true;
const ANALYSIS_MODE_MATERIAL = "material_valuation_v1";
const ANALYSIS_PROMPT_STACK = [
  {
    id: "p1_fixed_search_mode",
    text:
      "固定搜索模式（提示词1）：只检索“股票名称 + 最近3个月 + 研报/研究报告/调研报告/调研纪要/年报/半年报/季报”等材料；必须注明来源地址；宁可少报也不误报。",
  },
];

const DEFAULT_CONFIG = {
  xq_a_token: "",
  xq_r_token: "",
  device_id: "",
  openai_api_key: "",
  api_base_url: "https://api.deepseek.com/v1",
  prefer_model: "deepseek-chat",
  modelProviders: [
    {
      name: "deepseek",
      baseUrl: "http://127.0.0.1:3021/v1",
      apiKey: "daodao123",
      model: "deepseek-r1",
    },
    {
      name: "gemini",
      baseUrl: "http://127.0.0.1:8090/v1",
      apiKey: "daodao123",
      model: "gemini-3.1-pro",
    },
  ],
  cacheTtlMs: CACHE_TTL_MS,
  autoFetchTokens: true,
};

const PERIOD_ORDER = ["q1", "h1", "q3", "q4", "annual"];
const DISPLAY_PERIOD_ORDER = ["q1", "h1", "q3", "annual"];
const CAPEX_METRIC_KEYS = [
  // 购建固定资产、无形资产和其他长期资产支付的现金（不同接口版本字段别名）
  "c_pay_acq_const_fiolta",
  "cash_paid_for_assets",
];
const PROVIDER_RATE_LIMIT_COOLDOWN_MS = 1000 * 60 * 2;
const PROVIDER_BAD_RESPONSE_COOLDOWN_MS = 1000 * 45;
const MODEL_PROVIDER_CURSOR_KEY = "modelProviderRotationCursorV1";
let modelProviderRotationCursor = 0;
let modelProviderCursorLoaded = false;
const providerCooldownUntilMap = new Map();

const LOCAL_DB_NAME = "stockAnalyzerLocalDB";
const LOCAL_DB_VERSION = 1;
const CACHE_STORE_NAME = "analysis_cache_v1";
const MEMORY_ENTRY_STORE_NAME = "memory_entries_v1";
const LEGACY_CLEANUP_MARKER_KEY = "legacyLocalCacheMigratedV2";
let localDbPromise = null;
let memoryWriteSincePrune = 0;
let lastMemoryPruneAt = 0;

function openLocalDb() {
  if (localDbPromise) return localDbPromise;
  localDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
        const cacheStore = db.createObjectStore(CACHE_STORE_NAME, { keyPath: "symbol" });
        cacheStore.createIndex("expiresAt", "expiresAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(MEMORY_ENTRY_STORE_NAME)) {
        const memoryStore = db.createObjectStore(MEMORY_ENTRY_STORE_NAME, { keyPath: "id" });
        memoryStore.createIndex("fetchedAt", "fetchedAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
  return localDbPromise;
}

function idbRequestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
  });
}

async function idbGet(storeName, key) {
  const db = await openLocalDb();
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  return idbRequestToPromise(store.get(key));
}

async function idbGetAll(storeName) {
  const db = await openLocalDb();
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  return idbRequestToPromise(store.getAll());
}

async function idbPut(storeName, value) {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    store.put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB put failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB put aborted"));
  });
}

async function idbDelete(storeName, key) {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB delete failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB delete aborted"));
  });
}

async function idbDeleteMany(storeName, keys = []) {
  if (!Array.isArray(keys) || !keys.length) return;
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    keys.forEach((key) => store.delete(key));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB deleteMany failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB deleteMany aborted"));
  });
}

async function idbClear(storeName) {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB clear failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB clear aborted"));
  });
}

async function idbCount(storeName) {
  const db = await openLocalDb();
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  return idbRequestToPromise(store.count());
}

async function evictExpiredCacheInDb(now = Date.now()) {
  const db = await openLocalDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE_NAME, "readwrite");
    const store = tx.objectStore(CACHE_STORE_NAME);
    const req = store.openCursor();
    let removed = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const item = cursor.value || {};
      const expiresAt = Number(item.expiresAt || 0);
      if (expiresAt > 0 && expiresAt <= now) {
        cursor.delete();
        removed += 1;
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error || new Error("IndexedDB cursor failed"));
    tx.oncomplete = () => resolve(removed);
    tx.onerror = () => reject(tx.error || new Error("IndexedDB evict failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB evict aborted"));
  });
}

async function cleanupLegacyStorageIfNeeded() {
  try {
    const marker = await chrome.storage.local.get([LEGACY_CLEANUP_MARKER_KEY]);
    if (marker?.[LEGACY_CLEANUP_MARKER_KEY]) return;
    const all = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(all).filter(
      (key) => key === "stockMemoryStoreV1" || key.startsWith("stockAnalysis_")
    );
    if (keysToRemove.length) {
      await chrome.storage.local.remove(keysToRemove);
    }
    await chrome.storage.local.set({ [LEGACY_CLEANUP_MARKER_KEY]: Date.now() });
  } catch (error) {
    console.warn("清理旧缓存失败:", error);
  }
}

function normalizeRotationCursor(cursor, total) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const normalized = Number.isFinite(cursor) ? Math.floor(cursor) : 0;
  return ((normalized % total) + total) % total;
}

async function ensureModelProviderCursorLoaded() {
  if (modelProviderCursorLoaded) return;
  try {
    const items = await chrome.storage.local.get([MODEL_PROVIDER_CURSOR_KEY]);
    const stored = Number(items?.[MODEL_PROVIDER_CURSOR_KEY]);
    modelProviderRotationCursor = Number.isFinite(stored) ? stored : 0;
  } catch {
    modelProviderRotationCursor = 0;
  } finally {
    modelProviderCursorLoaded = true;
  }
}

async function persistModelProviderCursor(nextCursor) {
  modelProviderRotationCursor = Number.isFinite(nextCursor) ? Math.floor(nextCursor) : 0;
  modelProviderCursorLoaded = true;
  try {
    await chrome.storage.local.set({ [MODEL_PROVIDER_CURSOR_KEY]: modelProviderRotationCursor });
  } catch {
    // ignore persistence failure; fallback to in-memory cursor
  }
}

async function reserveModelProviderStart(total) {
  await ensureModelProviderCursorLoaded();
  const start = normalizeRotationCursor(modelProviderRotationCursor, total);
  const reservedNext = normalizeRotationCursor(start + 1, total);
  await persistModelProviderCursor(reservedNext);
  return start;
}

function cacheKeyForSymbol(symbol) {
  return `stockAnalysis_${symbol}`;
}

function normalizeSymbol(raw) {
  const text = String(raw || "").toUpperCase().trim();
  const full = text.match(/^([A-Z]{2}\d{5,6})$/);
  if (full) return full[1];
  const short = text.match(/^(\d{6})$/);
  if (short) {
    const code = short[1];
    const market = code.startsWith("6") ? "SH" : "SZ";
    return `${market}${code}`;
  }
  return "";
}

function toTdxSymbol(raw) {
  const normalized = normalizeSymbol(raw);
  if (!normalized) return String(raw || "").trim();
  const market = normalized.slice(0, 2).toLowerCase();
  const code = normalized.slice(2);
  return `${code}.${market}`;
}

function dateKeyFromTimestamp(timestamp) {
  const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" });
  return formatter.format(new Date(timestamp));
}

function timestampToDateKeyFromMs(ts) {
  if (!Number.isFinite(ts)) return null;
  return dateKeyFromTimestamp(ts);
}

function parseDateKeyToNumber(dateKey) {
  if (!dateKey || typeof dateKey !== "string") return null;
  const n = Number(dateKey.replace(/-/g, ""));
  return Number.isFinite(n) ? n : null;
}

function safeGet(obj, path, fallback = null) {
  try {
    return path.split(".").reduce((acc, key) => acc?.[key], obj) ?? fallback;
  } catch {
    return fallback;
  }
}

function firstFiniteNumber(values = []) {
  for (const item of values) {
    const n = toNumber(item);
    if (n !== null) return n;
  }
  return null;
}

function firstNonEmpty(values = []) {
  for (const item of values) {
    if (item === null || item === undefined) continue;
    const s = String(item).trim();
    if (s) return s;
  }
  return null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNumberFromMaybeArray(value) {
  if (Array.isArray(value)) {
    return toNumber(value[0]);
  }
  return toNumber(value);
}

function normalizePercent(value) {
  const n = toNumber(value);
  return n === null ? null : Number(n.toFixed(2));
}

function round(value, digits = 2) {
  const n = toNumber(value);
  if (n === null) return null;
  return Number(n.toFixed(digits));
}

function toYiYuan(value, digits = 2) {
  const n = toNumber(value);
  if (n === null) return null;
  return round(n / 100000000, digits);
}

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  const slice = values.slice(values.length - period);
  const sum = slice.reduce((acc, cur) => acc + cur, 0);
  return sum / period;
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length === 0 || period <= 0) return [];
  const k = 2 / (period + 1);
  const result = [];
  let prev = values[0];
  result.push(prev);
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function computeMacd(values, shortPeriod = 12, longPeriod = 26, signalPeriod = 9) {
  if (!Array.isArray(values) || values.length < longPeriod + signalPeriod) {
    return { dif: null, dea: null, hist: null };
  }
  const emaShort = emaSeries(values, shortPeriod);
  const emaLong = emaSeries(values, longPeriod);
  const difSeries = values.map((_, i) => emaShort[i] - emaLong[i]);
  const deaSeries = emaSeries(difSeries, signalPeriod);
  const dif = difSeries[difSeries.length - 1];
  const dea = deaSeries[deaSeries.length - 1];
  const hist = (dif - dea) * 2;
  return { dif: round(dif, 4), dea: round(dea, 4), hist: round(hist, 4) };
}

function computeMacdSeries(values, shortPeriod = 12, longPeriod = 26, signalPeriod = 9) {
  if (!Array.isArray(values) || values.length < longPeriod + signalPeriod) {
    return { dif: [], dea: [], hist: [] };
  }
  const emaShort = emaSeries(values, shortPeriod);
  const emaLong = emaSeries(values, longPeriod);
  const difSeries = values.map((_, i) => emaShort[i] - emaLong[i]);
  const deaSeries = emaSeries(difSeries, signalPeriod);
  const histSeries = difSeries.map((dif, i) => (dif - deaSeries[i]) * 2);
  return {
    dif: difSeries,
    dea: deaSeries,
    hist: histSeries,
  };
}

function computeRsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return round(100 - 100 / (1 + rs), 2);
}

function computeRsiSeries(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return [];
  const series = [];
  for (let i = 0; i < values.length; i += 1) {
    if (i < period) {
      series.push(null);
      continue;
    }
    let gain = 0;
    let loss = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const diff = values[j] - values[j - 1];
      if (diff >= 0) gain += diff;
      else loss -= diff;
    }
    if (loss === 0) {
      series.push(100);
      continue;
    }
    const rs = gain / loss;
    series.push(100 - 100 / (1 + rs));
  }
  return series;
}

function stdDev(values) {
  if (!Array.isArray(values) || !values.length) return null;
  const avg = values.reduce((acc, cur) => acc + cur, 0) / values.length;
  const variance = values.reduce((acc, cur) => acc + (cur - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function collectCloseSeriesFromRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) =>
    toNumber(row?.close ?? row?.current ?? row?.price)
  );
}

function collectLowSeriesFromRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) =>
    toNumber(row?.low ?? row?.close ?? row?.current ?? row?.price)
  );
}

function collectHighSeriesFromRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) =>
    toNumber(row?.high ?? row?.close ?? row?.current ?? row?.price)
  );
}

function findRecentLocalLows(values, lookback = 90) {
  if (!Array.isArray(values) || values.length < 7) return [];
  const start = Math.max(2, values.length - lookback);
  const lows = [];
  for (let i = start; i <= values.length - 3; i += 1) {
    const cur = values[i];
    if (cur === null || cur === undefined) continue;
    const prev1 = values[i - 1];
    const prev2 = values[i - 2];
    const next1 = values[i + 1];
    const next2 = values[i + 2];
    if ([prev1, prev2, next1, next2].some((x) => x === null || x === undefined)) continue;
    if (cur <= prev1 && cur <= prev2 && cur <= next1 && cur <= next2) {
      lows.push({ idx: i, value: cur });
    }
  }
  return lows.slice(-6);
}

function computeBollingerState(closes, period = 20) {
  if (!Array.isArray(closes) || closes.length < period + 1) {
    return {
      upper: null,
      middle: null,
      lower: null,
      positionPct: null,
      squeeze: false,
      breakoutUp: false,
      breakoutDown: false,
      widening: false,
      bandwidthNow: null,
      bandwidthPrev: null,
    };
  }
  const sliceNow = closes.slice(-period);
  const slicePrev = closes.slice(-(period + 1), -1);
  const maNow = sma(sliceNow, period);
  const maPrev = sma(slicePrev, period);
  const sdNow = stdDev(sliceNow);
  const sdPrev = stdDev(slicePrev);
  if (maNow === null || maPrev === null || sdNow === null || sdPrev === null || maNow === 0 || maPrev === 0) {
    return {
      upper: null,
      middle: null,
      lower: null,
      positionPct: null,
      squeeze: false,
      breakoutUp: false,
      breakoutDown: false,
      widening: false,
      bandwidthNow: null,
      bandwidthPrev: null,
    };
  }
  const bandwidthNow = (4 * sdNow) / maNow;
  const bandwidthPrev = (4 * sdPrev) / maPrev;
  const upperNow = maNow + 2 * sdNow;
  const lowerNow = maNow - 2 * sdNow;
  const lastClose = closes[closes.length - 1];
  const bandRange = upperNow - lowerNow;
  const positionPct =
    bandRange > 0 && Number.isFinite(lastClose) ? ((lastClose - lowerNow) / bandRange) * 100 : null;
  const squeeze = bandwidthNow < 0.12;
  const breakoutUp = closes[closes.length - 1] > upperNow && bandwidthNow > bandwidthPrev;
  const breakoutDown = closes[closes.length - 1] < lowerNow && bandwidthNow > bandwidthPrev;
  const widening = bandwidthNow > bandwidthPrev * 1.05;
  return {
    upper: round(upperNow),
    middle: round(maNow),
    lower: round(lowerNow),
    positionPct: round(positionPct, 2),
    squeeze,
    breakoutUp,
    breakoutDown,
    widening,
    bandwidthNow: round(bandwidthNow, 4),
    bandwidthPrev: round(bandwidthPrev, 4),
  };
}

function computeKdjState(rows, period = 9) {
  const closes = collectCloseSeriesFromRows(rows);
  const highs = collectHighSeriesFromRows(rows);
  const lows = collectLowSeriesFromRows(rows);
  if (
    !Array.isArray(closes) ||
    !Array.isArray(highs) ||
    !Array.isArray(lows) ||
    closes.length < period + 2 ||
    highs.length < period + 2 ||
    lows.length < period + 2
  ) {
    return {
      k: null,
      d: null,
      j: null,
      kPrev: null,
      dPrev: null,
      jPrev: null,
      cross: "none",
      overbought: false,
      oversold: false,
    };
  }

  const kSeries = [];
  const dSeries = [];
  const jSeries = [];
  let prevK = 50;
  let prevD = 50;

  for (let i = 0; i < closes.length; i += 1) {
    const close = closes[i];
    if (close === null || i < period - 1) {
      kSeries.push(null);
      dSeries.push(null);
      jSeries.push(null);
      continue;
    }
    const highWindow = highs.slice(i - period + 1, i + 1).filter((v) => v !== null);
    const lowWindow = lows.slice(i - period + 1, i + 1).filter((v) => v !== null);
    if (!highWindow.length || !lowWindow.length) {
      kSeries.push(null);
      dSeries.push(null);
      jSeries.push(null);
      continue;
    }
    const highest = Math.max(...highWindow);
    const lowest = Math.min(...lowWindow);
    const rsv = highest === lowest ? 50 : ((close - lowest) / (highest - lowest)) * 100;

    const k = (2 / 3) * prevK + (1 / 3) * rsv;
    const d = (2 / 3) * prevD + (1 / 3) * k;
    const j = 3 * k - 2 * d;
    prevK = k;
    prevD = d;
    kSeries.push(k);
    dSeries.push(d);
    jSeries.push(j);
  }

  const k = kSeries[kSeries.length - 1];
  const d = dSeries[dSeries.length - 1];
  const j = jSeries[jSeries.length - 1];
  const kPrev = kSeries.length >= 2 ? kSeries[kSeries.length - 2] : null;
  const dPrev = dSeries.length >= 2 ? dSeries[dSeries.length - 2] : null;
  const jPrev = jSeries.length >= 2 ? jSeries[jSeries.length - 2] : null;

  let cross = "none";
  if (kPrev !== null && dPrev !== null && k !== null && d !== null) {
    if (kPrev < dPrev && k >= d) cross = "golden";
    else if (kPrev > dPrev && k <= d) cross = "dead";
  }

  return {
    k: round(k, 2),
    d: round(d, 2),
    j: round(j, 2),
    kPrev: round(kPrev, 2),
    dPrev: round(dPrev, 2),
    jPrev: round(jPrev, 2),
    cross,
    overbought: !!(k !== null && d !== null && k >= 80 && d >= 80),
    oversold: !!(k !== null && d !== null && k <= 20 && d <= 20),
  };
}

function normalizeKlineRows(klinePayload) {
  const columns = safeGet(klinePayload, "data.column", []);
  const items = safeGet(klinePayload, "data.item", []);
  if (!Array.isArray(columns) || !Array.isArray(items)) return [];
  const rows = [];
  for (const item of items) {
    if (!Array.isArray(item)) continue;
    const row = {};
    columns.forEach((col, idx) => {
      row[col] = item[idx];
    });
    rows.push(row);
  }
  return rows;
}

function buildTrendSnapshot(klinePayload) {
  const rows = normalizeKlineRows(klinePayload);
  const closes = rows
    .map((r) => toNumber(r.close ?? r.current ?? r.price))
    .filter((v) => v !== null);
  const volumes = rows
    .map((r) => toNumber(r.volume))
    .filter((v) => v !== null);

  if (closes.length < 30) {
    return {
      rows: [],
      close: null,
      ma5: null,
      ma10: null,
      ma20: null,
      ma60: null,
      ma120: null,
      ma250: null,
      maCross: "none",
      ma20Slope: null,
      ma60Slope: null,
      ma120Slope: null,
      ma250Slope: null,
      priceDepartureMa20Pct: null,
      priceDepartureMa60Pct: null,
      rsi14: null,
      rsi14Prev: null,
      macd: { dif: null, dea: null, hist: null },
      macdCross: "none",
      macdHistPrev: null,
      boll: {
        upper: null,
        middle: null,
        lower: null,
        positionPct: null,
        squeeze: false,
        breakoutUp: false,
        breakoutDown: false,
        widening: false,
        bandwidthNow: null,
        bandwidthPrev: null,
      },
      kdj: {
        k: null,
        d: null,
        j: null,
        kPrev: null,
        dPrev: null,
        jPrev: null,
        cross: "none",
        overbought: false,
        oversold: false,
      },
      volumeRatio5_20: null,
      volumeRatio5_10: null,
      volumeRatio10_20: null,
      volumeRatio1_20: null,
      breakout20: { high: null, low: null },
      breakout60: { high: null, low: null },
      breakout20PrevHigh: null,
      breakout20Confirmed: false,
      pullbackSupportReady: false,
      return20d: null,
      return60d: null,
      trendBias: "insufficient_data",
    };
  }

  const closesExToday = closes.slice(0, -1);
  const volumesExToday = volumes.slice(0, -1);
  const close = closes[closes.length - 1];
  const lastVolume = volumes.length ? volumes[volumes.length - 1] : null;
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma10Prev = closes.length >= 11 ? sma(closes.slice(0, -1), 10) : null;
  const ma20 = sma(closes, 20);
  const ma20Prev = closes.length >= 21 ? sma(closes.slice(0, -1), 20) : null;
  const ma60 = closes.length >= 60 ? sma(closes, 60) : null;
  const ma120 = closes.length >= 120 ? sma(closes, 120) : null;
  const ma250 = closes.length >= 250 ? sma(closes, 250) : null;
  const ma60Prev = closes.length >= 61 ? sma(closes.slice(0, -1), 60) : null;
  const ma120Prev = closes.length >= 121 ? sma(closes.slice(0, -1), 120) : null;
  const ma250Prev = closes.length >= 251 ? sma(closes.slice(0, -1), 250) : null;
  const rsi14 = computeRsi(closes, 14);
  const rsi14Prev = closes.length >= 16 ? computeRsi(closes.slice(0, -1), 14) : null;
  const macd = computeMacd(closes, 12, 26, 9);
  const macdSeries = computeMacdSeries(closes, 12, 26, 9);
  const macdDifSeries = macdSeries.dif || [];
  const macdDeaSeries = macdSeries.dea || [];
  const macdHistSeries = macdSeries.hist || [];
  const macdDifPrev = macdDifSeries.length >= 2 ? macdDifSeries[macdDifSeries.length - 2] : null;
  const macdDeaPrev = macdDeaSeries.length >= 2 ? macdDeaSeries[macdDeaSeries.length - 2] : null;
  const macdDifNow = macdDifSeries.length ? macdDifSeries[macdDifSeries.length - 1] : null;
  const macdDeaNow = macdDeaSeries.length ? macdDeaSeries[macdDeaSeries.length - 1] : null;
  let macdCross = "none";
  if (
    macdDifPrev !== null &&
    macdDeaPrev !== null &&
    macdDifNow !== null &&
    macdDeaNow !== null
  ) {
    if (macdDifPrev < macdDeaPrev && macdDifNow >= macdDeaNow) macdCross = "golden";
    else if (macdDifPrev > macdDeaPrev && macdDifNow <= macdDeaNow) macdCross = "dead";
  }
  const macdHistPrev =
    macdHistSeries.length >= 2 ? round(macdHistSeries[macdHistSeries.length - 2], 4) : null;
  let maCross = "none";
  if (ma10Prev !== null && ma20Prev !== null && ma10 !== null && ma20 !== null) {
    if (ma10Prev < ma20Prev && ma10 >= ma20) maCross = "golden";
    else if (ma10Prev > ma20Prev && ma10 <= ma20) maCross = "dead";
  }
  const boll = computeBollingerState(closes, 20);
  const kdj = computeKdjState(rows, 9);

  const recent20 = closes.slice(-20);
  const recent60 = closes.slice(-60);
  const high20 = recent20.length ? Math.max(...recent20) : null;
  const low20 = recent20.length ? Math.min(...recent20) : null;
  const high60 = recent60.length ? Math.max(...recent60) : null;
  const low60 = recent60.length ? Math.min(...recent60) : null;

  const vma5 = volumes.length >= 5 ? sma(volumes, 5) : null;
  const vma10 = volumes.length >= 10 ? sma(volumes, 10) : null;
  const vma20 = volumes.length >= 20 ? sma(volumes, 20) : null;
  const volumeRatio5_20 =
    vma5 !== null && vma20 !== null && vma20 !== 0 ? round(vma5 / vma20, 2) : null;
  const volumeRatio5_10 =
    vma5 !== null && vma10 !== null && vma10 !== 0 ? round(vma5 / vma10, 2) : null;
  const volumeRatio10_20 =
    vma10 !== null && vma20 !== null && vma20 !== 0 ? round(vma10 / vma20, 2) : null;
  const volumeRatio1_20 =
    lastVolume !== null && vma20 !== null && vma20 !== 0 ? round(lastVolume / vma20, 2) : null;

  const recent20Prev = closesExToday.slice(-20);
  const breakout20PrevHigh = recent20Prev.length ? Math.max(...recent20Prev) : null;
  const breakout20Confirmed =
    breakout20PrevHigh !== null &&
    close > breakout20PrevHigh &&
    volumeRatio1_20 !== null &&
    volumeRatio1_20 >= BREAKOUT_VOLUME_THRESHOLD;

  const last5Rows = rows.slice(-5);
  const pullbackSupportReady =
    last5Rows.length >= 3 &&
    ma20 !== null &&
    last5Rows.some((item) => toNumber(item.low) !== null && toNumber(item.low) <= ma20 * 1.01) &&
    close >= ma20;

  let trendBias = "neutral";
  if (ma20 !== null && ma60 !== null) {
    if (
      close > ma20 &&
      ma20 > ma60 &&
      (ma120 === null || ma60 > ma120) &&
      macd.hist !== null &&
      macd.hist > 0
    ) trendBias = "bullish";
    if (close < ma20 && ma20 < ma60 && macd.hist !== null && macd.hist < 0) trendBias = "bearish";
  }
  const close20Ago = closes.length > 20 ? closes[closes.length - 21] : null;
  const close60Ago = closes.length > 60 ? closes[closes.length - 61] : null;
  const return20d =
    close20Ago !== null && close20Ago !== 0 ? round(((close - close20Ago) / close20Ago) * 100, 2) : null;
  const return60d =
    close60Ago !== null && close60Ago !== 0 ? round(((close - close60Ago) / close60Ago) * 100, 2) : null;
  const priceDepartureMa20Pct =
    close !== null && ma20 !== null && ma20 !== 0 ? round(((close - ma20) / ma20) * 100, 2) : null;
  const priceDepartureMa60Pct =
    close !== null && ma60 !== null && ma60 !== 0 ? round(((close - ma60) / ma60) * 100, 2) : null;

  return {
    rows,
    close: round(close),
    ma5: round(ma5),
    ma10: round(ma10),
    ma20: round(ma20),
    ma60: round(ma60),
    ma120: round(ma120),
    ma250: round(ma250),
    ma20Slope: ma20 !== null && ma20Prev !== null ? round(ma20 - ma20Prev, 4) : null,
    ma60Slope: ma60 !== null && ma60Prev !== null ? round(ma60 - ma60Prev, 4) : null,
    ma120Slope: ma120 !== null && ma120Prev !== null ? round(ma120 - ma120Prev, 4) : null,
    ma250Slope: ma250 !== null && ma250Prev !== null ? round(ma250 - ma250Prev, 4) : null,
    maCross,
    priceDepartureMa20Pct,
    priceDepartureMa60Pct,
    rsi14,
    rsi14Prev: round(rsi14Prev, 2),
    macd,
    macdCross,
    macdHistPrev,
    boll,
    kdj,
    volumeRatio5_20,
    volumeRatio5_10,
    volumeRatio10_20,
    volumeRatio1_20,
    breakout20: { high: round(high20), low: round(low20) },
    breakout60: { high: round(high60), low: round(low60) },
    breakout20PrevHigh: round(breakout20PrevHigh),
    breakout20Confirmed,
    pullbackSupportReady,
    return20d,
    return60d,
    trendBias,
  };
}

function buildMarketContext(payload) {
  const main = buildTrendSnapshot(safeGet(payload, "marketMain", null));
  const broad = buildTrendSnapshot(safeGet(payload, "marketBroad", null));
  const flags = [];
  if (main.trendBias === "bullish") flags.push("main_bullish");
  if (broad.trendBias === "bullish") flags.push("broad_bullish");
  if (main.close !== null && main.ma20 !== null && main.close > main.ma20) flags.push("main_above_ma20");
  if (broad.close !== null && broad.ma20 !== null && broad.close > broad.ma20) flags.push("broad_above_ma20");
  const score = flags.length;
  const riskOff = main.trendBias === "bearish" && broad.trendBias === "bearish";
  return {
    score,
    flags,
    riskOff,
    bias: riskOff ? "risk_off" : score >= 2 ? "supportive" : "neutral",
    main: {
      close: main.close,
      ma20: main.ma20,
      return20d: main.return20d,
      trendBias: main.trendBias,
    },
    broad: {
      close: broad.close,
      ma20: broad.ma20,
      return20d: broad.return20d,
      trendBias: broad.trendBias,
    },
  };
}

function normalizeMarketLikeSymbol(raw) {
  const value = String(raw || "").toUpperCase().trim();
  if (!value) return "";
  if (/^(SH|SZ|BJ)\d{6}$/.test(value)) return value;
  if (/^(BK|CI|CSI|SW)\d{4,8}$/.test(value)) return value;
  return "";
}

function deepCollectByKeys(input, wantedKeys, output, depth = 0) {
  if (!input || depth > 4) return;
  if (Array.isArray(input)) {
    input.forEach((item) => deepCollectByKeys(item, wantedKeys, output, depth + 1));
    return;
  }
  if (typeof input !== "object") return;

  for (const [key, value] of Object.entries(input)) {
    if (wantedKeys.has(key) && typeof value === "string") {
      output.push(value);
    }
    deepCollectByKeys(value, wantedKeys, output, depth + 1);
  }
}

function rankSectorSymbolCandidate(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (/^(BK|CI|CSI|SW)\d{4,8}$/.test(s)) return 0;
  if (/^(SH000|SZ399)\d{3}$/.test(s)) return 1;
  if (/^(SH|SZ|BJ)\d{6}$/.test(s)) return 3;
  return 2;
}

function extractSectorNameMap(input, output = {}, depth = 0) {
  if (!input || depth > 6) return output;
  if (Array.isArray(input)) {
    input.forEach((item) => extractSectorNameMap(item, output, depth + 1));
    return output;
  }
  if (typeof input !== "object") return output;

  const nameKeys = [
    "name",
    "industry_name",
    "ind_name",
    "plate_name",
    "sector_name",
    "index_name",
    "display_name",
    "title",
  ];
  const symbolKeys = [
    "industry_symbol",
    "industry_code",
    "sector_symbol",
    "sector_code",
    "plate_symbol",
    "plate_code",
    "symbol",
    "index_symbol",
    "index_code",
    "ind_code",
  ];

  const name = firstNonEmpty(nameKeys.map((key) => input[key]));
  const symbols = symbolKeys
    .map((key) => normalizeMarketLikeSymbol(input[key]))
    .filter(Boolean);
  if (name && symbols.length) {
    symbols.forEach((sym) => {
      if (!output[sym]) output[sym] = name;
    });
  }

  // 兼容 {"BK0021":"通用设备"} 这种字典结构
  for (const [key, value] of Object.entries(input)) {
    const symFromKey = normalizeMarketLikeSymbol(key);
    if (symFromKey && typeof value === "string" && value.trim()) {
      if (!output[symFromKey]) output[symFromKey] = value.trim();
    }
    const symFromVal = normalizeMarketLikeSymbol(value);
    if (symFromVal && typeof key === "string" && key.trim()) {
      if (!output[symFromVal]) output[symFromVal] = key.trim();
    }
  }

  for (const value of Object.values(input)) {
    extractSectorNameMap(value, output, depth + 1);
  }
  return output;
}

function extractIndustryContext(payload, symbol) {
  const detailQuote = safeGet(payload, "detail.data.quote", {});
  const industryPayload = safeGet(payload, "industry", null);
  const industryData = safeGet(industryPayload, "data", {});
  const candidateNames = [
    safeGet(industryData, "industry_name", null),
    safeGet(detailQuote, "industry_name", null),
    safeGet(detailQuote, "first_industry_name", null),
    safeGet(detailQuote, "second_industry_name", null),
    safeGet(detailQuote, "industry", null),
  ].filter(Boolean);

  const rawCandidates = [];
  const wantedKeys = new Set([
    "industry_symbol",
    "industry_code",
    "sector_symbol",
    "sector_code",
    "plate_symbol",
    "plate_code",
    "symbol",
    "index_symbol",
    "index_code",
    "ind_code",
  ]);
  deepCollectByKeys(industryData, wantedKeys, rawCandidates, 0);
  deepCollectByKeys(detailQuote, wantedKeys, rawCandidates, 0);

  const normalizedSymbol = normalizeSymbol(symbol);
  const sectorSymbols = Array.from(
    new Set(
      rawCandidates
        .map((item) => normalizeMarketLikeSymbol(item))
        .filter((item) => item && item !== normalizedSymbol)
    )
  ).sort((a, b) => rankSectorSymbolCandidate(a) - rankSectorSymbolCandidate(b));
  const sectorNameMap = extractSectorNameMap(industryData, {});
  // 明细页 quote 也可能带板块名称
  extractSectorNameMap(detailQuote, sectorNameMap);

  const industryCode =
    safeGet(industryData, "industry_code", null) ||
    safeGet(industryData, "ind_code", null) ||
    safeGet(detailQuote, "industry_code", null) ||
    null;

  return {
    industryName: candidateNames[0] || null,
    industryCode: industryCode ? String(industryCode) : null,
    sectorSymbols,
    sectorNameMap,
  };
}

function buildSectorTrendContext(payload, symbol) {
  const industryCtx = extractIndustryContext(payload, symbol);
  const sectorTrend = buildTrendSnapshot(safeGet(payload, "sectorKline", null));
  const marketBroad = buildTrendSnapshot(safeGet(payload, "marketBroad", null));
  const relativeStrength20d =
    sectorTrend.return20d !== null && marketBroad.return20d !== null
      ? round(sectorTrend.return20d - marketBroad.return20d, 2)
      : null;

  return {
    industryName: industryCtx.industryName || safeGet(payload, "sectorNameResolved", null) || null,
    industryCode: industryCtx.industryCode,
    sectorSymbol: safeGet(payload, "sectorSymbolResolved", null),
    sectorSymbols: industryCtx.sectorSymbols,
    trend: sectorTrend,
    relativeStrength20d,
  };
}

function createNullPeriodSeries() {
  return {
    q1: null,
    h1: null,
    q3: null,
    q4: null,
    annual: null,
  };
}

function getNumberByKeysAtIndex(record, keys, index) {
  if (!record || typeof record !== "object") return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (Array.isArray(value)) {
      const n = toNumber(value[index]);
      if (n !== null) {
        return n;
      }
      continue;
    }
    if (index === 0) {
      const n = toNumber(value);
      if (n !== null) {
        return n;
      }
    }
  }
  return null;
}

function setPeriodValue(series, period, value) {
  if (!period || value === null) return;
  if (series[period] === null) {
    series[period] = value;
  }
}

function createNullPeriodTsMap() {
  return {
    q1: null,
    h1: null,
    q3: null,
    q4: null,
    annual: null,
  };
}

function parsePeriodTimestamp(...rawValues) {
  for (const raw of rawValues) {
    if (raw === null || raw === undefined || raw === "") continue;
    if (Array.isArray(raw)) continue;
    const s = String(raw).trim();
    if (!s) continue;

    if (/^\d{13}$/.test(s)) {
      const ts = Number(s);
      if (Number.isFinite(ts)) return ts;
    }
    if (/^\d{10}$/.test(s)) {
      const ts = Number(s) * 1000;
      if (Number.isFinite(ts)) return ts;
    }
    if (/^\d{8}$/.test(s)) {
      const normalized = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
      const ts = Date.parse(`${normalized}T00:00:00+08:00`);
      if (Number.isFinite(ts)) return ts;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const ts = Date.parse(`${s.slice(0, 10)}T00:00:00+08:00`);
      if (Number.isFinite(ts)) return ts;
    }
  }
  return null;
}

function setPeriodValueWithTs(series, periodTsMap, period, value, timestamp) {
  if (!period || value === null || value === undefined) return;
  const currentTs = periodTsMap?.[period] ?? null;
  if (series[period] === null || series[period] === undefined) {
    series[period] = value;
    if (periodTsMap) periodTsMap[period] = timestamp ?? currentTs;
    return;
  }
  if (timestamp !== null && timestamp !== undefined) {
    if (currentTs === null || currentTs === undefined || timestamp >= currentTs) {
      series[period] = value;
      if (periodTsMap) periodTsMap[period] = timestamp;
    }
  }
}

function detectPeriodKey(...rawValues) {
  const hints = [];
  for (const raw of rawValues) {
    if (raw === null || raw === undefined) continue;

    const s = String(raw).trim();
    if (!s) continue;
    hints.push(s.toUpperCase());

    if (/^\d{13}$/.test(s) || /^\d{10}$/.test(s)) {
      const ts = /^\d{10}$/.test(s) ? Number(s) * 1000 : Number(s);
      const d = new Date(ts);
      if (!Number.isNaN(d.getTime())) {
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        hints.push(`${mm}-${dd}`);
        hints.push(`${mm}${dd}`);
      }
    } else if (/^\d{8}$/.test(s)) {
      const mm = s.slice(4, 6);
      const dd = s.slice(6, 8);
      hints.push(`${mm}-${dd}`);
      hints.push(`${mm}${dd}`);
    }
  }

  const text = hints.join(" ");

  if (!text) return null;

  if (/(年报|年度|ANNUAL|FY)/.test(text)) return "annual";
  if (/(四季报|四季度|四季|Q4)/.test(text)) return "q4";
  if (/(三季报|三季度|三季|Q3)/.test(text)) return "q3";
  if (/(中报|半年报|半年度|H1|Q2)/.test(text)) return "h1";
  if (/(一季报|一季度|一季|Q1)/.test(text)) return "q1";

  if (/(03-31|0331)/.test(text)) return "q1";
  if (/(06-30|0630)/.test(text)) return "h1";
  if (/(09-30|0930)/.test(text)) return "q3";
  if (/(12-31|1231)/.test(text)) return "annual";

  return null;
}

function extractMetricSeriesFromList(list, metricKeys) {
  const series = createNullPeriodSeries();
  const periodTsMap = createNullPeriodTsMap();
  const records = Array.isArray(list) ? list : [];

  for (const record of records) {
    if (!record || typeof record !== "object") continue;

    const directPeriod = detectPeriodKey(
      record.report_name,
      record.report_name_cn,
      record.report_type,
      record.report_date,
      record.report_date_str
    );
    // 雪球财务字段通常是 [当期值, 同比]，这里直接取当期值映射到当前 report_period
    const directValue = getNumberByKeys(record, metricKeys);
    const directTs = parsePeriodTimestamp(
      record.report_date,
      record.report_date_str,
      record.report_name,
      record.report_name_cn
    );
    setPeriodValueWithTs(series, periodTsMap, directPeriod, directValue, directTs);

    const metaArrays = [
      record.report_name,
      record.report_name_cn,
      record.report_type,
      record.report_date,
      record.report_date_str,
    ].filter(Array.isArray);
    const metricArrays = metricKeys
      .map((k) => record[k])
      .filter(Array.isArray);
    const maxLength = Math.max(
      0,
      ...metaArrays.map((arr) => arr.length),
      ...metricArrays.map((arr) => arr.length)
    );

    for (let i = 0; i < maxLength; i += 1) {
      const period = detectPeriodKey(
        Array.isArray(record.report_name) ? record.report_name[i] : null,
        Array.isArray(record.report_name_cn) ? record.report_name_cn[i] : null,
        Array.isArray(record.report_type) ? record.report_type[i] : null,
        Array.isArray(record.report_date) ? record.report_date[i] : null,
        Array.isArray(record.report_date_str) ? record.report_date_str[i] : null
      );
      const value = getNumberByKeysAtIndex(record, metricKeys, i);
      const ts = parsePeriodTimestamp(
        Array.isArray(record.report_date) ? record.report_date[i] : null,
        Array.isArray(record.report_date_str) ? record.report_date_str[i] : null,
        Array.isArray(record.report_name) ? record.report_name[i] : null,
        Array.isArray(record.report_name_cn) ? record.report_name_cn[i] : null
      );
      setPeriodValueWithTs(series, periodTsMap, period, value, ts);
    }
  }

  Object.defineProperty(series, "__periodTs", {
    value: periodTsMap,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return series;
}

function mergePeriodSeries(primarySeries, fallbackSeries) {
  const merged = createNullPeriodSeries();
  const mergedTs = createNullPeriodTsMap();
  const primaryTs = primarySeries?.__periodTs || null;
  const fallbackTs = fallbackSeries?.__periodTs || null;
  for (const key of PERIOD_ORDER) {
    const primaryVal = primarySeries?.[key];
    const fallbackVal = fallbackSeries?.[key];
    if (primaryVal !== null && primaryVal !== undefined) {
      merged[key] = primaryVal;
      mergedTs[key] = primaryTs?.[key] ?? null;
    } else {
      merged[key] = fallbackVal ?? null;
      mergedTs[key] = fallbackTs?.[key] ?? null;
    }
  }
  Object.defineProperty(merged, "__periodTs", {
    value: mergedTs,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return merged;
}

function subtractPeriodSeries(leftSeries, rightSeries) {
  const result = createNullPeriodSeries();
  const resultTs = createNullPeriodTsMap();
  const leftTs = leftSeries?.__periodTs || null;
  const rightTs = rightSeries?.__periodTs || null;
  for (const key of PERIOD_ORDER) {
    const left = leftSeries?.[key];
    const right = rightSeries?.[key];
    if (left !== null && left !== undefined && right !== null && right !== undefined) {
      result[key] = left - right;
      resultTs[key] = leftTs?.[key] ?? rightTs?.[key] ?? null;
    }
  }
  Object.defineProperty(result, "__periodTs", {
    value: resultTs,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return result;
}

function calculateRatioSeries(numeratorSeries, denominatorSeries, multiplier = 1) {
  const result = createNullPeriodSeries();
  const resultTs = createNullPeriodTsMap();
  const numeratorTs = numeratorSeries?.__periodTs || null;
  const denominatorTs = denominatorSeries?.__periodTs || null;
  for (const key of PERIOD_ORDER) {
    const numerator = numeratorSeries?.[key];
    const denominator = denominatorSeries?.[key];
    if (
      numerator !== null &&
      numerator !== undefined &&
      denominator !== null &&
      denominator !== undefined &&
      denominator !== 0
    ) {
      result[key] = Number(((numerator / denominator) * multiplier).toFixed(2));
      resultTs[key] = numeratorTs?.[key] ?? denominatorTs?.[key] ?? null;
    }
  }
  Object.defineProperty(result, "__periodTs", {
    value: resultTs,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return result;
}

function pickPreferredPeriodEntry(series) {
  const periodTs = series?.__periodTs || null;
  const priority = ["annual", "q4", "q3", "h1", "q1"];
  if (periodTs) {
    let best = null;
    for (const key of PERIOD_ORDER) {
      const value = series?.[key];
      if (value === null || value === undefined) continue;
      const ts = Number(periodTs[key]);
      if (best === null) {
        best = { key, value, ts: Number.isFinite(ts) ? ts : null };
        continue;
      }
      const bestTs = Number(best.ts);
      if (Number.isFinite(ts) && (!Number.isFinite(bestTs) || ts > bestTs)) {
        best = { key, value, ts };
        continue;
      }
      if (Number.isFinite(ts) && Number.isFinite(bestTs) && ts === bestTs) {
        if (priority.indexOf(key) < priority.indexOf(best.key)) {
          best = { key, value, ts };
        }
      }
    }
    if (best) return best;
  }

  for (const key of priority) {
    const value = series?.[key];
    if (value !== null && value !== undefined) {
      return { key, value };
    }
  }
  return null;
}

function pickPreferredPeriodValue(series) {
  const entry = pickPreferredPeriodEntry(series);
  return entry ? entry.value : null;
}

function formatPeriodSeriesForPrompt(series, suffix = "") {
  return DISPLAY_PERIOD_ORDER.map((key) => {
    const value = series?.[key];
    return value === null || value === undefined ? "NULL" : `${value}${suffix}`;
  }).join(" | ");
}

function getNumberByKeys(record, keys) {
  if (!record || typeof record !== "object") return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      const n = toNumberFromMaybeArray(record[key]);
      if (n !== null) {
        return n;
      }
    }
  }
  return null;
}

function parseYearFromRawValues(...rawValues) {
  for (const raw of rawValues) {
    if (raw === null || raw === undefined || raw === "") continue;
    if (Array.isArray(raw)) continue;
    const s = String(raw).trim();
    if (!s) continue;
    if (/^\d{13}$/.test(s) || /^\d{10}$/.test(s)) {
      const ts = /^\d{10}$/.test(s) ? Number(s) * 1000 : Number(s);
      if (Number.isFinite(ts)) {
        const year = new Date(ts).getFullYear();
        if (year >= 1990 && year <= 2100) return year;
      }
      continue;
    }
    if (/^\d{8}$/.test(s)) {
      const year = Number(s.slice(0, 4));
      if (Number.isFinite(year)) return year;
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const year = Number(s.slice(0, 4));
      if (Number.isFinite(year)) return year;
      continue;
    }
    const m = s.match(/(19|20)\d{2}/);
    if (m) {
      const year = Number(m[0]);
      if (Number.isFinite(year)) return year;
    }
  }
  return null;
}

function extractAnnualMetricHistory(list, metricKeys) {
  const records = Array.isArray(list) ? list : [];
  const byYear = new Map();

  function putValue(period, year, value, ts) {
    if ((period !== "annual" && period !== "q4") || year === null || value === null) return;
    const safeTs =
      Number.isFinite(ts) && ts !== null ? ts : Date.parse(`${year}-12-31T00:00:00+08:00`) || 0;
    const existing = byYear.get(year);
    if (!existing || safeTs >= existing.ts) {
      byYear.set(year, { year, value, ts: safeTs });
    }
  }

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const period = detectPeriodKey(
      record.report_name,
      record.report_name_cn,
      record.report_type,
      record.report_date,
      record.report_date_str
    );
    const value = getNumberByKeys(record, metricKeys);
    const ts = parsePeriodTimestamp(
      record.report_date,
      record.report_date_str,
      record.report_name,
      record.report_name_cn
    );
    const year = parseYearFromRawValues(
      record.report_date,
      record.report_date_str,
      record.report_name,
      record.report_name_cn
    );
    putValue(period, year, value, ts);

    const metaArrays = [
      record.report_name,
      record.report_name_cn,
      record.report_type,
      record.report_date,
      record.report_date_str,
    ].filter(Array.isArray);
    const metricArrays = metricKeys.map((k) => record[k]).filter(Array.isArray);
    const maxLength = Math.max(
      0,
      ...metaArrays.map((arr) => arr.length),
      ...metricArrays.map((arr) => arr.length)
    );

    for (let i = 0; i < maxLength; i += 1) {
      const itemPeriod = detectPeriodKey(
        Array.isArray(record.report_name) ? record.report_name[i] : null,
        Array.isArray(record.report_name_cn) ? record.report_name_cn[i] : null,
        Array.isArray(record.report_type) ? record.report_type[i] : null,
        Array.isArray(record.report_date) ? record.report_date[i] : null,
        Array.isArray(record.report_date_str) ? record.report_date_str[i] : null
      );
      const itemValue = getNumberByKeysAtIndex(record, metricKeys, i);
      const itemTs = parsePeriodTimestamp(
        Array.isArray(record.report_date) ? record.report_date[i] : null,
        Array.isArray(record.report_date_str) ? record.report_date_str[i] : null,
        Array.isArray(record.report_name) ? record.report_name[i] : null,
        Array.isArray(record.report_name_cn) ? record.report_name_cn[i] : null
      );
      const itemYear = parseYearFromRawValues(
        Array.isArray(record.report_date) ? record.report_date[i] : null,
        Array.isArray(record.report_date_str) ? record.report_date_str[i] : null,
        Array.isArray(record.report_name) ? record.report_name[i] : null,
        Array.isArray(record.report_name_cn) ? record.report_name_cn[i] : null
      );
      putValue(itemPeriod, itemYear, itemValue, itemTs);
    }
  }

  return Array.from(byYear.values()).sort((a, b) => b.year - a.year);
}

function getHistoryValueByYear(history, year) {
  const list = Array.isArray(history) ? history : [];
  const hit = list.find((item) => item?.year === year);
  return hit ? toNumber(hit.value) : null;
}

function computeRevenueCagr3yFromIncome(incomeList) {
  const revenueHistory = extractAnnualMetricHistory(incomeList, [
    "total_revenue",
    "operating_revenue",
    "revenue",
    "total_operating_revenue",
    "oper_rev",
  ]);
  if (!revenueHistory.length) return null;
  const latest = revenueHistory[0];
  // 3年CAGR按严格口径：取 latestYear 与 latestYear-3 的年报营收
  const base = revenueHistory.find((item) => item.year === latest.year - 3) || null;
  if (!base) return null;
  if (latest.value === null || base.value === null || latest.value <= 0 || base.value <= 0) return null;
  return round((Math.pow(latest.value / base.value, 1 / 3) - 1) * 100, 2);
}

function computePiotroskiFScore(payload) {
  const indicatorList = Array.isArray(payload?.indicatorList) ? payload.indicatorList : [];
  const incomeList = Array.isArray(payload?.incomeList) ? payload.incomeList : [];
  const balanceList = Array.isArray(payload?.balanceList) ? payload.balanceList : [];
  const cashFlowList = Array.isArray(payload?.cashFlowList) ? payload.cashFlowList : [];

  const netProfitHistory = extractAnnualMetricHistory(incomeList, [
    "net_profit",
    "net_profit_atsopc",
    "parent_net_profit",
    "np_atsopc",
    "net_profit_parent_company",
    "n_income",
  ]);
  const totalAssetsHistory = extractAnnualMetricHistory(balanceList, ["total_assets"]);
  const operatingCfHistory = extractAnnualMetricHistory(cashFlowList, [
    "ncf_from_oa",
    "ncf_operate_a",
    "ncf_from_operate_a",
    "net_cf_operate_a",
  ]);
  const debtRatioHistory = extractAnnualMetricHistory(balanceList, ["asset_liab_ratio"]).map((item) => ({
    ...item,
    value: normalizePercentLike(item?.value),
  }));
  const currentRatioHistory = extractAnnualMetricHistory(balanceList, ["current_ratio"]);
  const grossMarginHistory = extractAnnualMetricHistory(indicatorList, [
    "gross_selling_rate",
    "gross_margin",
    "gross_profit_margin",
  ]);
  const revenueHistory = extractAnnualMetricHistory(incomeList, [
    "total_revenue",
    "operating_revenue",
    "revenue",
    "total_operating_revenue",
    "oper_rev",
  ]);
  const totalSharesHistory = extractAnnualMetricHistory(balanceList, [
    "total_share_capital",
    "total_shares",
    "share_capital",
    "capital_stock",
    "total_share",
  ]);

  const yearSet = new Set();
  [netProfitHistory, totalAssetsHistory, operatingCfHistory, debtRatioHistory, currentRatioHistory, grossMarginHistory, revenueHistory].forEach(
    (list) => list.forEach((item) => yearSet.add(item.year))
  );
  const years = Array.from(yearSet).sort((a, b) => b - a);
  const latestYear = years[0] || null;
  const prevYear = latestYear ? years.find((y) => y < latestYear) || null : null;
  if (!latestYear || !prevYear) {
    return {
      score: null,
      rawScore: 0,
      evaluatedCount: 0,
      latestYear: latestYear || null,
      prevYear: prevYear || null,
      details: [],
    };
  }

  const netProfitNow = getHistoryValueByYear(netProfitHistory, latestYear);
  const netProfitPrev = getHistoryValueByYear(netProfitHistory, prevYear);
  const assetsNow = getHistoryValueByYear(totalAssetsHistory, latestYear);
  const assetsPrev = getHistoryValueByYear(totalAssetsHistory, prevYear);
  const ocfNow = getHistoryValueByYear(operatingCfHistory, latestYear);
  const debtNow = getHistoryValueByYear(debtRatioHistory, latestYear);
  const debtPrev = getHistoryValueByYear(debtRatioHistory, prevYear);
  const currentRatioNow = getHistoryValueByYear(currentRatioHistory, latestYear);
  const currentRatioPrev = getHistoryValueByYear(currentRatioHistory, prevYear);
  const grossMarginNow = getHistoryValueByYear(grossMarginHistory, latestYear);
  const grossMarginPrev = getHistoryValueByYear(grossMarginHistory, prevYear);
  const revenueNow = getHistoryValueByYear(revenueHistory, latestYear);
  const revenuePrev = getHistoryValueByYear(revenueHistory, prevYear);
  const sharesNow = getHistoryValueByYear(totalSharesHistory, latestYear);
  const sharesPrev = getHistoryValueByYear(totalSharesHistory, prevYear);

  const roaNow = netProfitNow !== null && assetsNow !== null && assetsNow !== 0 ? netProfitNow / assetsNow : null;
  const roaPrev = netProfitPrev !== null && assetsPrev !== null && assetsPrev !== 0 ? netProfitPrev / assetsPrev : null;
  const assetTurnNow =
    revenueNow !== null && assetsNow !== null && assetsNow !== 0 ? revenueNow / assetsNow : null;
  const assetTurnPrev =
    revenuePrev !== null && assetsPrev !== null && assetsPrev !== 0 ? revenuePrev / assetsPrev : null;

  const details = [];
  function addCriterion(key, pass, ready) {
    if (!ready) return;
    details.push({ key, pass: !!pass });
  }

  addCriterion("roa_positive", roaNow !== null && roaNow > 0, roaNow !== null);
  addCriterion("cfo_positive", ocfNow !== null && ocfNow > 0, ocfNow !== null);
  addCriterion("roa_improving", roaNow !== null && roaPrev !== null && roaNow > roaPrev, roaNow !== null && roaPrev !== null);
  addCriterion("cfo_gt_net_profit", ocfNow !== null && netProfitNow !== null && ocfNow > netProfitNow, ocfNow !== null && netProfitNow !== null);
  addCriterion("lower_leverage", debtNow !== null && debtPrev !== null && debtNow < debtPrev, debtNow !== null && debtPrev !== null);
  addCriterion(
    "higher_current_ratio",
    currentRatioNow !== null && currentRatioPrev !== null && currentRatioNow > currentRatioPrev,
    currentRatioNow !== null && currentRatioPrev !== null
  );
  addCriterion("no_new_shares", sharesNow !== null && sharesPrev !== null && sharesNow <= sharesPrev, sharesNow !== null && sharesPrev !== null);
  addCriterion(
    "higher_gross_margin",
    grossMarginNow !== null && grossMarginPrev !== null && grossMarginNow > grossMarginPrev,
    grossMarginNow !== null && grossMarginPrev !== null
  );
  addCriterion(
    "higher_asset_turnover",
    assetTurnNow !== null && assetTurnPrev !== null && assetTurnNow > assetTurnPrev,
    assetTurnNow !== null && assetTurnPrev !== null
  );

  const evaluatedCount = details.length;
  const rawScore = details.filter((item) => item.pass).length;
  const scaledScore = evaluatedCount
    ? Math.max(0, Math.min(9, Math.round((rawScore / evaluatedCount) * 9)))
    : null;

  return {
    score: scaledScore,
    rawScore,
    evaluatedCount,
    latestYear,
    prevYear,
    details,
  };
}

function buildValueCoverageModel(metrics) {
  const peTtm = toNumber(metrics?.peTtm);
  const pb = toNumber(metrics?.pb);
  const dividendYield = toNumber(metrics?.dividendYield);
  const fcfYield = toNumber(metrics?.fcfYield);
  const roe = toNumber(metrics?.roe);
  const cashToProfitRatio = toNumber(metrics?.cashToProfitRatio);
  const debtAssetRatio = toNumber(metrics?.debtAssetRatio);
  const revenueCagr3y = toNumber(metrics?.revenueCagr3y);
  const overseasOrNewRevenueRatio = toNumber(metrics?.overseasOrNewRevenueRatio);
  const piotroskiFScore = toNumber(metrics?.piotroskiFScore);
  const sectorTrendLevel = String(metrics?.sectorTrendLevel || "");
  const targetDiscountPctToRef = toNumber(metrics?.targetDiscountPctToRef);

  const checks = [
    { key: "pe_ttm", label: "PE(TTM)<=22", value: peTtm, pass: peTtm !== null ? peTtm <= 22 : null },
    { key: "pb", label: "PB<=3.5", value: pb, pass: pb !== null ? pb <= 3.5 : null },
    {
      key: "dividend_yield",
      label: "股息率>=1.5%",
      value: dividendYield,
      pass: dividendYield !== null ? dividendYield >= 1.5 : null,
    },
    { key: "fcf_yield", label: "FCF Yield>=5%", value: fcfYield, pass: fcfYield !== null ? fcfYield >= 5 : null },
    { key: "roe", label: "ROE>=12%", value: roe, pass: roe !== null ? roe >= 12 : null },
    {
      key: "cash_to_profit",
      label: "净现比>=1.0",
      value: cashToProfitRatio,
      pass: cashToProfitRatio !== null ? cashToProfitRatio >= 1 : null,
    },
    {
      key: "debt_asset",
      label: "资产负债率<50%",
      value: debtAssetRatio,
      pass: debtAssetRatio !== null ? debtAssetRatio < 50 : null,
    },
    {
      key: "revenue_cagr_3y",
      label: "过去3年营收CAGR>5%",
      value: revenueCagr3y,
      pass: revenueCagr3y !== null ? revenueCagr3y > 5 : null,
    },
    {
      key: "overseas_or_new_ratio",
      label: "海外/新兴业务占比>10%",
      value: overseasOrNewRevenueRatio,
      pass: overseasOrNewRevenueRatio !== null ? overseasOrNewRevenueRatio > 10 : null,
    },
    {
      key: "piotroski_f_score",
      label: "Piotroski F-Score>7",
      value: piotroskiFScore,
      pass: piotroskiFScore !== null ? piotroskiFScore > 7 : null,
    },
    {
      key: "sector_trend",
      label: "板块趋势（bearish可接受，bullish优先）",
      value: sectorTrendLevel || null,
      pass: sectorTrendLevel ? true : null,
    },
    {
      key: "target_discount",
      label: "目标价折扣<=80%",
      value: targetDiscountPctToRef,
      pass: targetDiscountPctToRef !== null ? targetDiscountPctToRef <= 80 : null,
    },
  ];

  const readyChecks = checks.filter((item) => item.pass !== null);
  const passChecks = readyChecks.filter((item) => item.pass === true);
  const normalizedScore10 = readyChecks.length
    ? round((passChecks.length / readyChecks.length) * 10, 2)
    : null;

  return {
    checks,
    availableCount: readyChecks.length,
    passCount: passChecks.length,
    normalizedScore10,
    level:
      normalizedScore10 === null ? "unknown" : normalizedScore10 >= 7 ? "strong" : normalizedScore10 >= 4.5 ? "medium" : "weak",
  };
}

function normalizePercentLike(value) {
  const n = toNumber(value);
  if (n === null) return null;
  if (n >= 0 && n <= 1) return round(n * 100, 2);
  if (n >= 0 && n <= 100) return round(n, 2);
  return null;
}

function normalizeCapex(value) {
  const n = toNumber(value);
  if (n === null) return null;
  return round(Math.abs(n), 2);
}

function resolveCapexSeries(cashFlowList) {
  for (const key of CAPEX_METRIC_KEYS) {
    const series = extractMetricSeriesFromList(cashFlowList, [key]);
    if (pickPreferredPeriodEntry(series)) {
      return { series, source: `direct.${key}` };
    }
  }
  return { series: createNullPeriodSeries(), source: null };
}

function summarizeRawValue(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, 3)
      .map((item) => (item === null || item === undefined ? "null" : String(item)))
      .join(" | ");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .slice(0, 6)
      .map(([k, v]) => `${k}:${v === null || v === undefined ? "null" : String(v)}`);
    return entries.join(", ");
  }
  return String(value);
}

function collectObjectsDeep(input, output, depth = 0) {
  if (!input || depth > 6) return;
  if (Array.isArray(input)) {
    input.forEach((item) => collectObjectsDeep(item, output, depth + 1));
    return;
  }
  if (typeof input !== "object") return;
  output.push(input);
  Object.values(input).forEach((value) => collectObjectsDeep(value, output, depth + 1));
}

function collectArraysDeep(input, output, depth = 0) {
  if (!input || depth > 6) return;
  if (Array.isArray(input)) {
    output.push(input);
    input.forEach((item) => collectArraysDeep(item, output, depth + 1));
    return;
  }
  if (typeof input !== "object") return;
  Object.values(input).forEach((value) => collectArraysDeep(value, output, depth + 1));
}

function firstStringByKeys(record, keys) {
  if (!record || typeof record !== "object") return null;
  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function firstNumberByKeyRegex(record, regex) {
  if (!record || typeof record !== "object") return null;
  for (const [key, value] of Object.entries(record)) {
    if (!regex.test(String(key))) continue;
    const n = toNumber(value);
    if (n !== null) return n;
  }
  return null;
}

function extractOverseasOrNewRevenueRatio(payloads = []) {
  const objects = [];
  const arrays = [];
  payloads.forEach((item) => {
    collectObjectsDeep(item, objects, 0);
    collectArraysDeep(item, arrays, 0);
  });

  const labelKeys = [
    "name",
    "title",
    "item",
    "item_name",
    "business_name",
    "class_name",
    "industry_name",
    "area",
    "region",
    "type",
    "category",
    "desc",
  ];
  const overseasLabelRe = /(海外|境外|国外|国际|出口|global|overseas|abroad|新兴|新能源|航空|高端|新业务|新产品|新兴业务)/i;
  const ratioKeyRe = /(占比|比重|比例|ratio|rate|pct|percent)/i;
  const amountKeyRe = /(收入|营收|主营|revenue|income|amount|value|money|sales)/i;
  const ignoreAmountKeyRe = /(同比|yoy|增速|增长|growth|margin|profit|毛利|净利|成本|cost)/i;

  const ratioCandidates = [];
  for (const obj of objects) {
    const label = firstStringByKeys(obj, labelKeys);
    if (!label || !overseasLabelRe.test(label)) continue;
    for (const [key, value] of Object.entries(obj)) {
      if (!ratioKeyRe.test(String(key))) continue;
      const ratio = normalizePercentLike(value);
      if (ratio !== null) ratioCandidates.push(ratio);
    }
  }
  if (ratioCandidates.length) {
    return { ratio: round(ratioCandidates[0], 2), source: "business.direct_ratio" };
  }

  for (const arr of arrays) {
    if (!Array.isArray(arr) || arr.length < 2) continue;
    const records = arr.filter((item) => item && typeof item === "object");
    if (records.length < 2) continue;
    let totalAmount = 0;
    let matchedAmount = 0;
    let matchedCount = 0;
    for (const row of records) {
      const label = firstStringByKeys(row, labelKeys);
      if (!label) continue;
      const amount = firstNumberByKeyRegex(row, amountKeyRe);
      const hitIgnoreKey = Object.keys(row).some(
        (key) => amountKeyRe.test(String(key)) && ignoreAmountKeyRe.test(String(key))
      );
      if (amount === null || hitIgnoreKey) continue;
      if (amount > 0) totalAmount += amount;
      if (overseasLabelRe.test(label) && amount > 0) {
        matchedAmount += amount;
        matchedCount += 1;
      }
    }
    if (totalAmount > 0 && matchedAmount > 0 && matchedCount > 0) {
      return { ratio: round((matchedAmount / totalAmount) * 100, 2), source: "business.derived_amount_ratio" };
    }
  }

  return { ratio: null, source: null };
}

function extractTargetPriceConsensusFromObjects(objects = [], sourceName = "unknown") {
  const allTargetValues = [];
  const avgTargetValues = [];
  const highTargetValues = [];
  const lowTargetValues = [];
  const targetKeyRe = /(target|tp|aim|goal|目标价|预期价)/i;
  const avgKeyRe = /(avg|mean|consensus|一致)/i;
  const highKeyRe = /(high|max|up|上限)/i;
  const lowKeyRe = /(low|min|down|下限)/i;

  for (const obj of objects) {
    if (!obj || typeof obj !== "object") continue;
    for (const [key, raw] of Object.entries(obj)) {
      const k = String(key);
      if (!targetKeyRe.test(k)) continue;
      const n = toNumber(raw);
      if (n === null || n <= 0 || n > 10000) continue;
      allTargetValues.push(n);
      if (avgKeyRe.test(k)) avgTargetValues.push(n);
      if (highKeyRe.test(k)) highTargetValues.push(n);
      if (lowKeyRe.test(k)) lowTargetValues.push(n);
    }
  }

  if (!allTargetValues.length) {
    return { targetPrice: null, targetPriceLow: null, targetPriceHigh: null, source: null };
  }
  const avg =
    avgTargetValues.length > 0
      ? avgTargetValues.reduce((acc, cur) => acc + cur, 0) / avgTargetValues.length
      : allTargetValues.reduce((acc, cur) => acc + cur, 0) / allTargetValues.length;
  const low =
    lowTargetValues.length > 0 ? Math.min(...lowTargetValues) : Math.min(...allTargetValues);
  const high =
    highTargetValues.length > 0 ? Math.max(...highTargetValues) : Math.max(...allTargetValues);
  return {
    targetPrice: round(avg, 2),
    targetPriceLow: round(low, 2),
    targetPriceHigh: round(high, 2),
    source: sourceName,
  };
}

function mergeTargetPriceCandidates(candidates = []) {
  const valid = candidates.filter((item) => item && item.targetPrice !== null);
  if (!valid.length) {
    return {
      targetPrice: null,
      targetPriceLow: null,
      targetPriceHigh: null,
      source: null,
    };
  }
  const prices = valid.map((item) => Number(item.targetPrice)).filter((n) => Number.isFinite(n));
  const lows = valid.map((item) => toNumber(item.targetPriceLow)).filter((n) => n !== null);
  const highs = valid.map((item) => toNumber(item.targetPriceHigh)).filter((n) => n !== null);
  const targetPrice = prices.length ? round(prices.reduce((a, b) => a + b, 0) / prices.length, 2) : null;
  const targetPriceLow = lows.length ? round(Math.min(...lows), 2) : null;
  const targetPriceHigh = highs.length ? round(Math.max(...highs), 2) : null;
  const source = valid.map((item) => item.source).filter(Boolean).join(" + ") || null;
  return { targetPrice, targetPriceLow, targetPriceHigh, source };
}

function buildTargetDiscountPct(currentPrice, targetPrice) {
  const current = toNumber(currentPrice);
  const target = toNumber(targetPrice);
  if (current === null || target === null || target <= 0) return null;
  return round((current / target) * 100, 2);
}

async function fetchXueqiuEarningForecast(symbol) {
  const candidates = [
    `https://stock.xueqiu.com/stock/report/earningforecast.json?symbol=${encodeURIComponent(symbol)}`,
    `https://stock.xueqiu.com/v5/stock/report/earningforecast.json?symbol=${encodeURIComponent(symbol)}`,
  ];
  let lastError = null;
  for (const url of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2200);
    try {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "application/json, text/plain, */*",
          Referer: "https://xueqiu.com/",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("xueqiu_earning_forecast_unavailable");
}

async function fetchEastmoneyTargetConsensus(symbol) {
  const normalized = normalizeSymbol(symbol);
  const code = normalized ? normalized.slice(2) : String(symbol || "").trim();
  if (!/^\d{6}$/.test(code)) throw new Error("eastmoney_invalid_code");
  const url = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
  url.searchParams.set("reportName", "RPT_WEB_RESPREDICT");
  url.searchParams.set("columns", "ALL");
  url.searchParams.set("source", "WEB");
  url.searchParams.set("client", "WEB");
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", "50");
  url.searchParams.set("sortColumns", "RATING_ORG_NUM");
  url.searchParams.set("sortTypes", "-1");
  url.searchParams.set("filter", `(SECURITY_CODE="${code}")`);
  return fetchJsonWithTimeout(url.toString(), 2400);
}

async function getXueqiuTokensFromCookies() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "xueqiu.com" });
    const tokenNames = new Set([
      "xq_a_token",
      "xq_r_token",
      "xq_token",
      "device_id",
      "u",
      "s",
    ]);

    const result = {};
    for (const cookie of cookies) {
      if (tokenNames.has(cookie.name)) {
        result[cookie.name] = cookie.value;
      }
    }

    return result;
  } catch (error) {
    console.error("获取雪球 cookies 失败:", error);
    return {};
  }
}

function mergeCookieTokens(config, cookieTokens) {
  return {
    ...config,
    xq_a_token: config.xq_a_token || cookieTokens.xq_a_token || "",
    xq_r_token: config.xq_r_token || cookieTokens.xq_r_token || "",
    device_id: config.device_id || cookieTokens.device_id || "",
  };
}

async function fetchJsonWithTimeout(url, timeoutMs = 1800) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(300, Number(timeoutMs) || 1800));
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 180)}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithTimeout(url, timeoutMs = 2200, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(400, Number(timeoutMs) || 2200));
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml,text/plain,*/*",
        ...headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 180)}`);
    }
    return {
      text: await response.text(),
      contentType: String(response.headers.get("content-type") || "").toLowerCase(),
      finalUrl: response.url || url,
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getConfig() {
  const config = await chrome.storage.local.get(DEFAULT_CONFIG);
  if (!config.autoFetchTokens) {
    return config;
  }

  const cookieTokens = await getXueqiuTokensFromCookies();
  return mergeCookieTokens(config, cookieTokens);
}

class XueqiuApiClient {
  constructor(config) {
    this.config = config;
  }

  async request(endpoint, params = {}) {
    const base = XUEQIU_BASE.replace(/\/$/, "");
    const normalizedEndpoint = String(endpoint || "").replace(/^\/+/, "");
    const url = new URL(`${base}/${normalizedEndpoint}`);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });

    const headers = {
      Accept: "application/json, text/plain, */*",
      Referer: "https://xueqiu.com/",
    };

    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      credentials: "include",
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`雪球接口失败 ${response.status}: ${body.slice(0, 200)}`);
    }

    return response.json();
  }

  async getAnalysisBundle(symbol) {
    const tasks = {
      realtime: this.request("/stock/realtime/quotec.json", { symbol }),
      detail: this.request("/stock/quote.json", { symbol, extend: "detail" }),
      indicator: this.request("/stock/finance/cn/indicator.json", {
        symbol,
        type: "all",
        is_detail: true,
        count: 6,
      }),
      income: this.request("/stock/finance/cn/income.json", {
        symbol,
        type: "all",
        is_detail: true,
        count: 16,
      }),
      balance: this.request("/stock/finance/cn/balance.json", {
        symbol,
        type: "all",
        is_detail: true,
        count: 6,
      }),
      cashFlow: this.request("/stock/finance/cn/cash_flow.json", {
        symbol,
        type: "all",
        is_detail: true,
        count: 6,
      }),
      business: this.request("/stock/finance/cn/business.json", {
        symbol,
        type: "all",
        is_detail: true,
        count: 8,
      }),
      businessAnalysis: this.request("/stock/f10/cn/business_analysis.json", { symbol }),
      earningForecast: fetchXueqiuEarningForecast(symbol),
      eastmoneyConsensus: fetchEastmoneyTargetConsensus(symbol),
      marketMain: this.request("/stock/chart/kline.json", {
        symbol: "SH000001",
        begin: Date.now(),
        period: "day",
        type: "before",
        count: -320,
        indicator: "kline",
      }),
      marketBroad: this.request("/stock/chart/kline.json", {
        symbol: "SH000300",
        begin: Date.now(),
        period: "day",
        type: "before",
        count: -320,
        indicator: "kline",
      }),
      industry: this.request("/stock/f10/cn/industry/compare.json", {
        symbol,
        type: "single",
      }),
      shareholders: this.request("/stock/f10/cn/skholder.json", { symbol }),
      bonus: this.request("/stock/f10/cn/bonus.json", { symbol, page: 1, size: 5 }),
      kline: this.request("/stock/chart/kline.json", {
        symbol,
        begin: Date.now(),
        period: "day",
        type: "before",
        count: -320,
        indicator: "kline",
      }),
      weeklyKline: this.request("/stock/chart/kline.json", {
        symbol,
        begin: Date.now(),
        period: "week",
        type: "before",
        count: -260,
        indicator: "kline",
      }),
    };

    const entries = Object.entries(tasks);
    const settled = await Promise.allSettled(entries.map(([, promise]) => promise));

    const data = {};
    const errors = {};

    settled.forEach((item, index) => {
      const key = entries[index][0];
      if (item.status === "fulfilled") {
        data[key] = item.value;
      } else {
        errors[key] = item.reason?.message || "unknown_error";
      }
    });

    if (data.kline && !data.klineSource) data.klineSource = "xueqiu_day";
    if (data.weeklyKline && !data.weeklyKlineSource) data.weeklyKlineSource = "xueqiu_week";

    const industryContext = extractIndustryContext(data, symbol);
    const candidateSectorSymbol = industryContext.sectorSymbols[0];
    if (candidateSectorSymbol) {
      data.sectorNameResolved =
        industryContext?.sectorNameMap?.[candidateSectorSymbol] || null;
      try {
        data.sectorKline = await this.request("/stock/chart/kline.json", {
          symbol: candidateSectorSymbol,
          begin: Date.now(),
          period: "day",
          type: "before",
          count: -320,
          indicator: "kline",
        });
        data.sectorSymbolResolved = candidateSectorSymbol;
      } catch (error) {
        errors.sectorKline = error?.message || "unknown_error";
      }
      try {
        data.sectorQuote = await this.request("/stock/realtime/quotec.json", {
          symbol: candidateSectorSymbol,
        });
        data.sectorNameResolved = data.sectorNameResolved ||
          safeGet(data, "sectorQuote.data.0.name", null) ||
          safeGet(data, "sectorQuote.data.0.industry_name", null) ||
          null;
      } catch (error) {
        errors.sectorQuote = error?.message || "unknown_error";
      }
    }

    // 回落雪球K线，保证结果可用。
    if (!data.kline) {
      const startedAt = Date.now();
      try {
        data.kline = await this.request("/stock/chart/kline.json", {
          symbol,
          begin: Date.now(),
          period: "day",
          type: "before",
          count: -320,
          indicator: "kline",
        });
        data.klineSource = "xueqiu_day_retry";
        data.klineFallbackLatencyMs = Date.now() - startedAt;
      } catch (error) {
        errors.kline = error?.message || "unknown_error";
      }
    }

    if (!data.weeklyKline) {
      const startedAt = Date.now();
      try {
        data.weeklyKline = await this.request("/stock/chart/kline.json", {
          symbol,
          begin: Date.now(),
          period: "week",
          type: "before",
          count: -260,
          indicator: "kline",
        });
        data.weeklyKlineSource = "xueqiu_week_retry";
        data.weeklyKlineFallbackLatencyMs = Date.now() - startedAt;
      } catch (error) {
        errors.weeklyKline = error?.message || "unknown_error";
      }
    }

    return { data, errors };
  }
}

function normalizeSnapshot(symbol, payload) {
  const realtimeQuote = safeGet(payload, "realtime.data.0", {});
  const detailQuote = safeGet(payload, "detail.data.quote", {});
  const indicatorList = safeGet(payload, "indicator.data.list", []);
  const incomeList = safeGet(payload, "income.data.list", []);
  const balanceList = safeGet(payload, "balance.data.list", []);
  const cashFlowList = safeGet(payload, "cashFlow.data.list", []);
  const businessPayload = safeGet(payload, "business", null);
  const businessAnalysisPayload = safeGet(payload, "businessAnalysis", null);
  const earningForecastPayload = safeGet(payload, "earningForecast", null);
  const eastmoneyConsensusPayload = safeGet(payload, "eastmoneyConsensus", null);
  const klinePayload = safeGet(payload, "kline", null);
  const weeklyKlinePayload = safeGet(payload, "weeklyKline", null);
  const shareholderList = safeGet(payload, "shareholders.data.items", []);
  const bonusList = safeGet(payload, "bonus.data.items", []);

  const latestIndicator = indicatorList[0] || {};
  const latestIncome = incomeList[0] || {};
  const latestBalance = balanceList[0] || {};
  const latestCashFlow = cashFlowList[0] || {};
  const topHolder = shareholderList[0] || {};
  const latestBonus = bonusList[0] || {};

  const name =
    safeGet(realtimeQuote, "name") ||
    safeGet(detailQuote, "name") ||
    safeGet(latestIndicator, "company_name") ||
    symbol;

  const netProfitGrowth = toNumber(safeGet(latestIndicator, "net_profit_atsopc_yoy.0"));
  const peTtm = toNumber(safeGet(detailQuote, "pe_ttm"));
  const directRoe = normalizePercent(safeGet(detailQuote, "roe"));
  const roeDirectSeries = extractMetricSeriesFromList(indicatorList, [
    "roe",
    "avg_roe",
    "weighted_roe",
    "roe_weighted",
  ]);
  const roeProfitSeries = extractMetricSeriesFromList(incomeList, [
    "net_profit_atsopc",
    "parent_net_profit",
    "net_profit",
    "np_atsopc",
    "net_profit_parent_company",
    "n_income",
  ]);
  const equitySeriesDirect = extractMetricSeriesFromList(balanceList, [
    "total_holders_equity_atsopc",
    "total_holders_equity_exc_min_int",
    "total_holders_equity",
    "equity_atsopc",
    "owner_equities_atsopc",
    "equities_parent_company_owners",
    "total_owner_equities",
    "tot_equity",
  ]);
  const totalAssetsSeries = extractMetricSeriesFromList(balanceList, ["total_assets"]);
  const totalLiabSeries = extractMetricSeriesFromList(balanceList, ["total_liab"]);
  const equitySeriesFallback = subtractPeriodSeries(totalAssetsSeries, totalLiabSeries);
  const roeEquitySeries = mergePeriodSeries(equitySeriesDirect, equitySeriesFallback);
  const roeCalculatedSeries = calculateRatioSeries(roeProfitSeries, roeEquitySeries, 100);
  const roeDirectPreferred = pickPreferredPeriodEntry(roeDirectSeries);
  const roeCalculatedPreferred = pickPreferredPeriodEntry(roeCalculatedSeries);
  // 口径对齐雪球 App：优先 quote.roe，其次指标接口直接 ROE，最后才使用公式重算
  const finalRoe =
    directRoe ??
    (roeDirectPreferred ? roeDirectPreferred.value : null) ??
    (roeCalculatedPreferred ? roeCalculatedPreferred.value : null);
  const finalRoePeriod =
    directRoe !== null ? null : roeDirectPreferred?.key || roeCalculatedPreferred?.key || null;
  const roeSeries = mergePeriodSeries(roeDirectSeries, roeCalculatedSeries);
  const roeSource =
    directRoe !== null
      ? "quote.roe"
      : roeDirectPreferred
        ? "series.direct(indicator)"
        : roeCalculatedPreferred
          ? "series.calculated(net_profit_atsopc/equity)"
          : null;
  const roeNumeratorNetProfit = roeCalculatedPreferred
    ? roeProfitSeries[roeCalculatedPreferred.key]
    : pickPreferredPeriodValue(roeProfitSeries);
  const roeDenominatorEquity = roeCalculatedPreferred
    ? roeEquitySeries[roeCalculatedPreferred.key]
    : pickPreferredPeriodValue(roeEquitySeries);

  const operatingCashFlowSeries = extractMetricSeriesFromList(cashFlowList, [
    "ncf_from_oa",
    "ncf_operate_a",
    "ncf_from_operate_a",
    "net_cf_operate_a",
  ]);
  const capexResolved = resolveCapexSeries(cashFlowList);
  const capitalExpenditureSeries = capexResolved.series;
  const capitalExpenditureSeriesSource = capexResolved.source;
  const netProfitSeries = extractMetricSeriesFromList(incomeList, [
    "net_profit",
    "net_profit_atsopc",
    "parent_net_profit",
    "np_atsopc",
    "net_profit_parent_company",
    "n_income",
  ]);
  const cashToProfitRatioSeries = calculateRatioSeries(
    operatingCashFlowSeries,
    netProfitSeries,
    1
  );
  const cashToProfitPreferred = pickPreferredPeriodEntry(cashToProfitRatioSeries);
  const cashFlowPeriodKey =
    cashToProfitPreferred?.key ||
    pickPreferredPeriodEntry(operatingCashFlowSeries)?.key ||
    pickPreferredPeriodEntry(capitalExpenditureSeries)?.key ||
    null;
  const operatingCashFlowFromSeries = cashFlowPeriodKey
    ? operatingCashFlowSeries[cashFlowPeriodKey]
    : pickPreferredPeriodValue(operatingCashFlowSeries);
  const operatingCashFlowFromLatest = toNumberFromMaybeArray(safeGet(latestCashFlow, "ncf_from_oa"));
  const operatingCashFlow = operatingCashFlowFromSeries ?? operatingCashFlowFromLatest;
  const netProfit = cashFlowPeriodKey
    ? netProfitSeries[cashFlowPeriodKey]
    : pickPreferredPeriodValue(netProfitSeries);
  const capitalExpenditureFromSeriesRaw = cashFlowPeriodKey
    ? capitalExpenditureSeries[cashFlowPeriodKey]
    : pickPreferredPeriodValue(capitalExpenditureSeries);
  const capitalExpenditureFromLatestRaw = firstFiniteNumber(
    CAPEX_METRIC_KEYS.map((key) => toNumberFromMaybeArray(safeGet(latestCashFlow, key)))
  );
  const capitalExpenditureRaw = capitalExpenditureFromSeriesRaw ?? capitalExpenditureFromLatestRaw;
  const cashToProfitRatio = cashFlowPeriodKey
    ? (cashToProfitRatioSeries[cashFlowPeriodKey] ?? null)
    : cashToProfitPreferred
      ? cashToProfitPreferred.value
      : null;
  const cashToProfitRatioSource =
    cashToProfitRatio !== null ? "series.calculated(ncf_from_oa/net_profit)" : null;
  const investingCashFlow = toNumber(safeGet(latestCashFlow, "ncf_from_ia.0"));
  const financingCashFlow = toNumber(safeGet(latestCashFlow, "ncf_from_fa.0"));
  const capitalExpenditure = normalizeCapex(capitalExpenditureRaw);
  const capitalExpenditureSource =
    capitalExpenditureFromSeriesRaw !== null
      ? capitalExpenditureSeriesSource
      : capitalExpenditureFromLatestRaw !== null
        ? "direct.capex_alias.latest"
      : null;
  const capexFieldRawText = summarizeRawValue(
    safeGet(latestCashFlow, "c_pay_acq_const_fiolta", null) ?? safeGet(latestCashFlow, "cash_paid_for_assets", null)
  );
  const cashFlowKeyHints = Object.keys(latestCashFlow || {})
    .filter((key) => /(acq|const|fiolta|fix|intang|asset|ncf_from_oa|ncf_from_ia)/i.test(String(key)))
    .slice(0, 20)
    .join(", ");

  const quoteCurrent = toNumber(safeGet(realtimeQuote, "current"));
  const quotePercent = normalizePercent(safeGet(realtimeQuote, "percent"));
  const quoteVolume = toNumber(safeGet(realtimeQuote, "volume"));
  const quoteAmount = toNumber(safeGet(realtimeQuote, "amount"));
  const quoteMarketCap = toNumber(safeGet(detailQuote, "market_capital"));

  const fcfRaw = operatingCashFlow !== null && capitalExpenditure !== null
    ? round(operatingCashFlow - capitalExpenditure, 2)
    : null;
  const fcf = toYiYuan(fcfRaw, 2);
  const fcfYield = fcfRaw !== null && quoteMarketCap !== null && quoteMarketCap !== 0
    ? round((fcfRaw / quoteMarketCap) * 100, 2)
    : null;
  const revenueCagr3y = computeRevenueCagr3yFromIncome(incomeList);
  const piotroski = computePiotroskiFScore({
    indicatorList,
    incomeList,
    balanceList,
    cashFlowList,
  });

  const overseasRatioResult = extractOverseasOrNewRevenueRatio([
    businessPayload,
    businessAnalysisPayload,
    detailQuote,
  ]);

  const xqForecastObjects = [];
  const eastmoneyObjects = [];
  collectObjectsDeep(earningForecastPayload, xqForecastObjects, 0);
  collectObjectsDeep(eastmoneyConsensusPayload, eastmoneyObjects, 0);
  const xqTargetConsensus = extractTargetPriceConsensusFromObjects(
    xqForecastObjects,
    "xueqiu.earning_forecast"
  );
  const eastmoneyTargetConsensus = extractTargetPriceConsensusFromObjects(
    eastmoneyObjects,
    "eastmoney.respredict"
  );
  const mergedTargetConsensus = mergeTargetPriceCandidates([
    xqTargetConsensus,
    eastmoneyTargetConsensus,
  ]);
  const targetDiscountPctToRef = buildTargetDiscountPct(
    quoteCurrent,
    mergedTargetConsensus.targetPrice
  );

  const trend = buildTrendSnapshot(klinePayload);
  const weeklyTrend = buildTrendSnapshot(weeklyKlinePayload);
  const market = buildMarketContext(payload);
  const sectorTrendRaw = buildSectorTrendContext(payload, symbol);
  const sectorTrend = {
    ...sectorTrendRaw,
    industryName: sectorTrendRaw?.industryName || null,
  };
  const sectorTrendSignal = deriveSectorTrendSignal({ sectorTrend });
  const valueCoverage = buildValueCoverageModel({
    peTtm,
    pb: toNumber(safeGet(detailQuote, "pb")),
    dividendYield: normalizePercent(safeGet(detailQuote, "dividend_yield")),
    fcfYield,
    roe: finalRoe,
    cashToProfitRatio,
    debtAssetRatio: normalizePercentLike(safeGet(latestBalance, "asset_liab_ratio.0")),
    revenueCagr3y,
    overseasOrNewRevenueRatio: overseasRatioResult.ratio,
    piotroskiFScore: piotroski.score,
    sectorTrendLevel: sectorTrendSignal.level,
    targetDiscountPctToRef,
  });

  const result = {
    symbol,
    name,
    quote: {
      current: quoteCurrent,
      percent: quotePercent,
      volume: quoteVolume,
      amount: quoteAmount,
      marketCap: quoteMarketCap,
    },
    valuation: {
      peTtm,
      pb: toNumber(safeGet(detailQuote, "pb")),
      psTtm: toNumber(safeGet(detailQuote, "ps_ttm")),
      dividendYield: normalizePercent(safeGet(detailQuote, "dividend_yield")),
      targetPriceConsensus: mergedTargetConsensus.targetPrice,
      targetPriceLow: mergedTargetConsensus.targetPriceLow,
      targetPriceHigh: mergedTargetConsensus.targetPriceHigh,
      targetPriceSource: mergedTargetConsensus.source,
      targetDiscountPctToRef,
      peg:
        peTtm !== null && netProfitGrowth !== null && netProfitGrowth > 0
          ? Number((peTtm / netProfitGrowth).toFixed(2))
          : null,
      payoutRatio: (() => {
        const dps = toNumber(safeGet(latestBonus, "dividend_per_share"));
        const epsVal = toNumber(safeGet(latestIndicator, "basic_eps.0"));
        return dps !== null && epsVal !== null && epsVal !== 0
          ? round((dps / epsVal) * 100, 2)
          : null;
      })(),
    },
    profitability: {
      roe: finalRoe,
      roePeriod: finalRoePeriod,
      roeSeries,
      roeSource,
      roeNumeratorNetProfit,
      roeDenominatorEquity,
      grossMargin: normalizePercent(safeGet(latestIndicator, "gross_selling_rate.0")),
      netMargin: normalizePercent(safeGet(latestIndicator, "net_profit_margin.0")),
      eps: toNumber(safeGet(latestIndicator, "basic_eps.0")),
      netProfitGrowth: normalizePercent(netProfitGrowth),
      revenueGrowth: normalizePercent(safeGet(latestIndicator, "total_revenue_yoy.0")),
      revenueCagr3y,
    },
    balanceSheet: {
      debtAssetRatio: normalizePercentLike(safeGet(latestBalance, "asset_liab_ratio.0")),
      currentRatio: toNumber(safeGet(latestBalance, "current_ratio.0")),
      quickRatio: toNumber(safeGet(latestBalance, "quick_ratio.0")),
      inventory: toNumberFromMaybeArray(safeGet(latestBalance, "inventory")),
      accountsReceivable: toNumberFromMaybeArray(
        safeGet(latestBalance, "account_receivable")
        ?? safeGet(latestBalance, "accounts_receivable")
      ),
      operatingCost: (() => {
        const cost = pickPreferredPeriodValue(
          extractMetricSeriesFromList(incomeList, [
            "total_operating_cost",
            "operating_cost",
            "oper_cost",
            "cost_of_goods_sold",
          ])
        ) ?? toNumberFromMaybeArray(safeGet(latestIncome, "total_operating_cost"));
        return cost;
      })(),
      inventoryTurnover: null,
      dso: null,
    },
    evData: {
      totalLiab: pickPreferredPeriodValue(totalLiabSeries)
        ?? toNumberFromMaybeArray(safeGet(latestBalance, "total_liab")),
      totalAssets: pickPreferredPeriodValue(totalAssetsSeries)
        ?? toNumberFromMaybeArray(safeGet(latestBalance, "total_assets")),
      operatingProfit: pickPreferredPeriodValue(
        extractMetricSeriesFromList(incomeList, [
          "operating_profit",
          "operate_profit",
          "biz_profit",
          "business_profit",
        ])
      ) ?? toNumberFromMaybeArray(safeGet(latestIncome, "operating_profit")),
      revenue: pickPreferredPeriodValue(
        extractMetricSeriesFromList(incomeList, [
          "total_revenue",
          "operating_revenue",
          "revenue",
          "total_operating_revenue",
          "oper_rev",
        ])
      ) ?? toNumberFromMaybeArray(safeGet(latestIncome, "total_revenue")),
      depreciationAmortization: pickPreferredPeriodValue(
        extractMetricSeriesFromList(cashFlowList, [
          "depreciation_and_amortization",
          "fix_asset_depreci",
          "intang_asset_amort",
          "depreciation",
          "amortization",
        ])
      ),
      totalCurrentAssets: pickPreferredPeriodValue(
        extractMetricSeriesFromList(balanceList, [
          "total_current_assets", "current_assets", "total_current_asset"
        ])
      ) ?? toNumberFromMaybeArray(safeGet(latestBalance, "total_current_assets")),
    },
    cashFlow: {
      operatingCashFlow,
      netProfit,
      cashToProfitRatio,
      cashToProfitRatioPeriod: cashFlowPeriodKey,
      cashToProfitRatioSeries,
      cashToProfitRatioSource,
      capitalExpenditure,
      capitalExpenditureSource,
      capexFieldRawText,
      cashFlowKeyHints: cashFlowKeyHints || null,
      investingCashFlow,
      financingCashFlow,
      fcf,
      fcfYield,
    },
    quality: {
      piotroskiFScore: piotroski.score,
      piotroskiRawScore: piotroski.rawScore,
      piotroskiEvaluatedCount: piotroski.evaluatedCount,
      piotroskiLatestYear: piotroski.latestYear,
      piotroskiPrevYear: piotroski.prevYear,
    },
    business: {
      overseasOrNewRevenueRatio: overseasRatioResult.ratio,
      overseasRatioSource: overseasRatioResult.source,
    },
    valueCoverage,
    trend,
    weeklyTrend,
    market,
    sectorTrend,
    shareholder: {
      topHolderName: safeGet(topHolder, "name", null),
      topHolderRatio: normalizePercent(safeGet(topHolder, "held_ratio")),
      latestDividendPerShare: toNumber(safeGet(latestBonus, "dividend_per_share")),
    },
    rawPreview: {
      indicatorPeriods: indicatorList.length,
      incomePeriods: incomeList.length,
      balancePeriods: balanceList.length,
      cashFlowPeriods: cashFlowList.length,
      businessRecords: Array.isArray(safeGet(businessPayload, "data.list", []))
        ? safeGet(businessPayload, "data.list", []).length
        : 0,
      hasKline: !!klinePayload,
      klineSource: safeGet(payload, "klineSource", "xueqiu"),
      weeklyKlineSource: safeGet(payload, "weeklyKlineSource", "xueqiu"),
      klineFallbackLatencyMs: toNumber(safeGet(payload, "klineFallbackLatencyMs", null)),
      weeklyKlineFallbackLatencyMs: toNumber(safeGet(payload, "weeklyKlineFallbackLatencyMs", null)),
      klineDecision: safeGet(payload, "klineDecision", null),
      shareholderRecords: shareholderList.length,
      bonusRecords: bonusList.length,
    },
  };

  // 计算存货周转率和DSO(需年度历史数据)
  const inventoryHistory = extractAnnualMetricHistory(balanceList, ["inventory"]);
  const arHistory = extractAnnualMetricHistory(balanceList, [
    "account_receivable", "accounts_receivable",
  ]);
  const costHistory = extractAnnualMetricHistory(incomeList, [
    "total_operating_cost", "operating_cost", "oper_cost",
  ]);
  const revHistory = extractAnnualMetricHistory(incomeList, [
    "total_revenue", "operating_revenue", "revenue",
  ]);
  if (inventoryHistory.length >= 2 && costHistory.length >= 1) {
    const years = inventoryHistory.map((h) => h.year).sort((a, b) => b - a);
    const invNow = inventoryHistory.find((h) => h.year === years[0]);
    const invPrev = inventoryHistory.find((h) => h.year === years[1]);
    const costNow = costHistory.find((h) => h.year === years[0]);
    if (invNow && invPrev && costNow && costNow.value && invNow.value !== null && invPrev.value !== null) {
      const avgInv = (invNow.value + invPrev.value) / 2;
      if (avgInv > 0) {
        result.balanceSheet.inventoryTurnover = round(costNow.value / avgInv, 2);
      }
    }
  }
  if (arHistory.length >= 1 && revHistory.length >= 1) {
    const arNow = arHistory[0];
    const revNow = revHistory[0];
    if (arNow && revNow && revNow.value && revNow.value !== 0) {
      result.balanceSheet.dso = round((arNow.value / revNow.value) * 365, 1);
    }
  }

  return result;
}

function compactSnapshotText(snapshot) {
  const advancedTrend = deriveAdvancedTrendMetrics(snapshot || {});
  const lines = [
    `股票: ${snapshot.name} (${snapshot.symbol})`,
    `现价: ${snapshot.quote.current ?? "N/A"}`,
    `涨跌幅: ${snapshot.quote.percent ?? "N/A"}%`,
    `PE(TTM): ${snapshot.valuation.peTtm ?? "N/A"}`,
    `PB: ${snapshot.valuation.pb ?? "N/A"}`,
    `PEG: ${snapshot.valuation.peg ?? "N/A"}`,
    `股息支付率: ${snapshot.valuation?.payoutRatio ?? "N/A"}%`,
    `ROE(最新期 ${snapshot.profitability.roePeriod || "N/A"}): ${snapshot.profitability.roe ?? "N/A"}%`,
    `ROE来源: ${snapshot.profitability.roeSource ?? "N/A"}`,
    `净利增速: ${snapshot.profitability.netProfitGrowth ?? "N/A"}%`,
    `营收增速: ${snapshot.profitability.revenueGrowth ?? "N/A"}%`,
    `营收3年CAGR: ${snapshot.profitability.revenueCagr3y ?? "N/A"}%`,
    `资产负债率: ${snapshot.balanceSheet.debtAssetRatio ?? "N/A"}%`,
    `存货周转率: ${snapshot.balanceSheet.inventoryTurnover ?? "N/A"}`,
    `DSO(天): ${snapshot.balanceSheet.dso ?? "N/A"}`,
    `经营现金流: ${snapshot.cashFlow.operatingCashFlow ?? "N/A"}`,
    `资本开支: ${snapshot.cashFlow.capitalExpenditure ?? "N/A"}`,
    `资本开支来源: ${snapshot.cashFlow.capitalExpenditureSource ?? "N/A"}`,
    `投资现金流: ${snapshot.cashFlow.investingCashFlow ?? "N/A"}`,
    `FCF(亿元): ${snapshot.cashFlow.fcf ?? "N/A"}`,
    `FCF Yield: ${snapshot.cashFlow.fcfYield ?? "N/A"}%`,
    `净利润: ${snapshot.cashFlow.netProfit ?? "N/A"}`,
    `净现比(最新期 ${snapshot.cashFlow.cashToProfitRatioPeriod || "N/A"}): ${snapshot.cashFlow.cashToProfitRatio ?? "N/A"}`,
    `海外/新兴业务占比: ${snapshot.business?.overseasOrNewRevenueRatio ?? "N/A"}%`,
    `Piotroski F-Score: ${snapshot.quality?.piotroskiFScore ?? "N/A"} (raw ${
      snapshot.quality?.piotroskiRawScore ?? "N/A"
    }/${snapshot.quality?.piotroskiEvaluatedCount ?? "N/A"})`,
    `机构目标价(均值/区间): ${snapshot.valuation?.targetPriceConsensus ?? "N/A"} / ${
      snapshot.valuation?.targetPriceLow ?? "N/A"
    }-${snapshot.valuation?.targetPriceHigh ?? "N/A"}`,
    `目标价折扣(现价/目标价): ${snapshot.valuation?.targetDiscountPctToRef ?? "N/A"}%`,
    `价值覆盖评分: ${snapshot.valueCoverage?.normalizedScore10 ?? "N/A"} (通过 ${
      snapshot.valueCoverage?.passCount ?? "N/A"
    }/${snapshot.valueCoverage?.availableCount ?? "N/A"})`,
    `趋势偏向: ${snapshot.trend.trendBias ?? "N/A"}`,
    `MA5/MA10/MA20/MA60: ${snapshot.trend.ma5 ?? "N/A"} / ${snapshot.trend.ma10 ?? "N/A"} / ${snapshot.trend.ma20 ?? "N/A"} / ${snapshot.trend.ma60 ?? "N/A"}`,
    `MA120/MA250: ${snapshot.trend.ma120 ?? "N/A"} / ${snapshot.trend.ma250 ?? "N/A"}`,
    `MA120斜率/MA250斜率: ${snapshot.trend.ma120Slope ?? "N/A"} / ${snapshot.trend.ma250Slope ?? "N/A"}`,
    `个股20日涨幅: ${snapshot.trend.return20d ?? "N/A"}%`,
    `RSI14: ${snapshot.trend.rsi14 ?? "N/A"}`,
    `RSI14(前值): ${snapshot.trend.rsi14Prev ?? "N/A"}`,
    `MACD(DIF/DEA/HIST): ${snapshot.trend.macd.dif ?? "N/A"} / ${snapshot.trend.macd.dea ?? "N/A"} / ${snapshot.trend.macd.hist ?? "N/A"}`,
    `MA金叉状态(10/20): ${snapshot.trend.maCross ?? "N/A"}`,
    `MACD金叉状态: ${snapshot.trend.macdCross ?? "N/A"}`,
    `BOLL(上/中/下): ${snapshot.trend?.boll?.upper ?? "N/A"} / ${snapshot.trend?.boll?.middle ?? "N/A"} / ${snapshot.trend?.boll?.lower ?? "N/A"}`,
    `BOLL带宽(今/昨): ${snapshot.trend?.boll?.bandwidthNow ?? "N/A"} / ${snapshot.trend?.boll?.bandwidthPrev ?? "N/A"}`,
    `BOLL收窄: ${snapshot.trend?.boll?.squeeze ? "是" : "否"}`,
    `BOLL上轨突破: ${snapshot.trend?.boll?.breakoutUp ? "是" : "否"}`,
    `KDJ(K/D/J): ${snapshot.trend?.kdj?.k ?? "N/A"} / ${snapshot.trend?.kdj?.d ?? "N/A"} / ${snapshot.trend?.kdj?.j ?? "N/A"}`,
    `KDJ金叉状态: ${snapshot.trend?.kdj?.cross ?? "N/A"}`,
    `价离MA20: ${snapshot.trend?.priceDepartureMa20Pct ?? "N/A"}%`,
    `量能比(5日/20日): ${snapshot.trend.volumeRatio5_20 ?? "N/A"}`,
    `量能比(5日/10日): ${snapshot.trend.volumeRatio5_10 ?? "N/A"}`,
    `量能比(10日/20日): ${snapshot.trend.volumeRatio10_20 ?? "N/A"}`,
    `20日区间高低: ${snapshot.trend.breakout20.high ?? "N/A"} / ${snapshot.trend.breakout20.low ?? "N/A"}`,
    `前20日高点(不含当日): ${snapshot.trend.breakout20PrevHigh ?? "N/A"}`,
    `突破+放量确认: ${snapshot.trend.breakout20Confirmed ? "是" : "否"}`,
    `回踩支撑形态: ${snapshot.trend.pullbackSupportReady ? "是" : "否"}`,
    `60日区间高低: ${snapshot.trend.breakout60.high ?? "N/A"} / ${snapshot.trend.breakout60.low ?? "N/A"}`,
    `底部形态评分(合并): ${Math.max(
      Number(advancedTrend.patternDoubleBottomScore || 0),
      Number(advancedTrend.patternRoundBottomScore || 0),
      advancedTrend.patternVBottomFlag ? 1 : 0
    )}`,
    `MACD底背离: ${advancedTrend.macdBullishDivergenceFlag ? "是" : "否"}`,
    `周线趋势确认评分: ${advancedTrend.weeklyTrendConfirmScore ?? "N/A"}`,
    `回踩不破评分: ${advancedTrend.retestHoldScore ?? "N/A"}`,
    `市场环境评分: ${snapshot.market?.score ?? "N/A"} (bias=${snapshot.market?.bias ?? "N/A"})`,
    `所属行业: ${snapshot.sectorTrend?.industryName ?? "N/A"} (${snapshot.sectorTrend?.industryCode ?? "N/A"})`,
    `板块指数: ${snapshot.sectorTrend?.sectorSymbol ?? "N/A"}`,
    `板块趋势偏向: ${snapshot.sectorTrend?.trend?.trendBias ?? "N/A"}`,
    `板块MA20/MA60: ${snapshot.sectorTrend?.trend?.ma20 ?? "N/A"} / ${snapshot.sectorTrend?.trend?.ma60 ?? "N/A"}`,
    `板块20日涨幅: ${snapshot.sectorTrend?.trend?.return20d ?? "N/A"}%`,
    `板块相对强弱(20日,vs沪深300): ${snapshot.sectorTrend?.relativeStrength20d ?? "N/A"}%`,
    `股息率: ${snapshot.valuation.dividendYield ?? "N/A"}%`,
    `第一大股东: ${snapshot.shareholder.topHolderName || "N/A"} (${snapshot.shareholder.topHolderRatio ?? "N/A"}%)`,
  ];
  return lines.join("\n");
}

function clamp(value, min, max) {
  const n = toNumber(value);
  if (n === null) return min;
  return Math.max(min, Math.min(max, n));
}

function formatYmdInChina(ts = Date.now()) {
  const formatted = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
  return formatted.replace(/\//g, "-");
}

function buildPromptStackText(stack = ANALYSIS_PROMPT_STACK) {
  const items = Array.isArray(stack) ? stack : [];
  if (!items.length) return "（空）";
  return items
    .map((item, idx) => {
      const text = String(item?.text || "").trim();
      const id = String(item?.id || `p${idx + 1}`).trim();
      return `${idx + 1}. [${id}] ${text}`;
    })
    .join("\n");
}

function decodeHtmlEntities(text) {
  if (!text) return "";
  let out = String(text);
  const named = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&#39;": "'",
    "&nbsp;": " ",
  };
  Object.entries(named).forEach(([k, v]) => {
    out = out.split(k).join(v);
  });
  out = out.replace(/&#(\d+);/g, (_m, code) => {
    const n = Number(code);
    if (!Number.isFinite(n)) return "";
    try {
      return String.fromCharCode(n);
    } catch {
      return "";
    }
  });
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
    const n = Number.parseInt(hex, 16);
    if (!Number.isFinite(n)) return "";
    try {
      return String.fromCharCode(n);
    } catch {
      return "";
    }
  });
  return out;
}

function stripHtmlTags(text) {
  if (!text) return "";
  return String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[ \f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(text, maxChars = 600) {
  const normalized = String(text || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function normalizeMaterialUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = normalizedPath || "/";
    return parsed.toString();
  } catch {
    return "";
  }
}

function decodeBase64UrlLike(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let payload = raw;
  if (payload.startsWith("a1")) payload = payload.slice(2);
  payload = payload.replace(/-/g, "+").replace(/_/g, "/");
  while (payload.length % 4 !== 0) payload += "=";
  try {
    const decoded = atob(payload);
    return decoded || "";
  } catch {
    return "";
  }
}

function extractFirstHttpUrl(text) {
  const raw = String(text || "");
  if (!raw) return "";
  const match = raw.match(/https?:\/\/[^\s<>"')\]]+/i);
  return match ? normalizeMaterialUrl(match[0]) : "";
}

function unwrapSearchEngineRedirectUrl(rawUrl, hintText = "") {
  const normalized = normalizeMaterialUrl(rawUrl);
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    const isSearchHost =
      host.includes("bing.com") ||
      host.includes("msn.com") ||
      host.includes("yahoo.com") ||
      host.includes("google.com");
    if (!isSearchHost) return normalized;

    const keys = ["url", "u", "r", "ru", "target"];
    for (const key of keys) {
      const value = parsed.searchParams.get(key);
      if (!value) continue;
      const direct = normalizeMaterialUrl(decodeURIComponent(value));
      if (direct && !/bing\.com|msn\.com|google\.com|yahoo\.com/i.test(extractDomain(direct))) {
        return direct;
      }
      const decodedB64 = normalizeMaterialUrl(decodeBase64UrlLike(value));
      if (decodedB64 && !/bing\.com|msn\.com|google\.com|yahoo\.com/i.test(extractDomain(decodedB64))) {
        return decodedB64;
      }
    }

    const fromHint = extractFirstHttpUrl(hintText);
    if (fromHint && !/bing\.com|msn\.com|google\.com|yahoo\.com/i.test(extractDomain(fromHint))) {
      return fromHint;
    }
  } catch {
    // ignore and return normalized
  }
  return normalized;
}

function extractDomain(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function parseDateHintFromText(text) {
  const raw = String(text || "");
  if (!raw) return null;
  const ymd = raw.match(/(20\d{2})[./-](0?[1-9]|1[0-2])[./-](0?[1-9]|[12]\d|3[01])/);
  if (ymd) {
    const y = ymd[1];
    const m = ymd[2].padStart(2, "0");
    const d = ymd[3].padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const ym = raw.match(/(20\d{2})[./-](0?[1-9]|1[0-2])/);
  if (ym) {
    const y = ym[1];
    const m = ym[2].padStart(2, "0");
    return `${y}-${m}`;
  }
  const yearOnly = raw.match(/\b(20\d{2})\b/);
  if (yearOnly) return yearOnly[1];
  return null;
}

function parseDateHintToTimestamp(dateHint) {
  const raw = String(dateHint || "").trim();
  if (!raw) return null;
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const ts = Date.parse(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00+08:00`);
    return Number.isFinite(ts) ? ts : null;
  }
  const monthOnly = raw.match(/^(\d{4})-(\d{2})$/);
  if (monthOnly) {
    const ts = Date.parse(`${monthOnly[1]}-${monthOnly[2]}-01T00:00:00+08:00`);
    return Number.isFinite(ts) ? ts : null;
  }
  const yearOnly = raw.match(/^(\d{4})$/);
  if (yearOnly) {
    const ts = Date.parse(`${yearOnly[1]}-01-01T00:00:00+08:00`);
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

function parsePubDateToTimestamp(pubDateRaw) {
  const raw = String(pubDateRaw || "").trim();
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function classifyMaterialType(payload = "") {
  const text = String(payload || "").toLowerCase();
  if (!text) return "other";
  if (/(annual report|10-k|20-f|年报|年度报告|annual filing|form 10-k|form 20-f)/.test(text)) {
    return "annual_report";
  }
  if (/(quarterly report|10-q|季报|季度报告|q1|q2|q3|q4)/.test(text)) {
    return "quarterly_report";
  }
  if (/(interim report|half[- ]?year|half year|半年报|中报|semi[- ]?annual)/.test(text)) {
    return "semi_annual_report";
  }
  if (/(research report|equity research|initiation|coverage report|研报|券商报告|投研报告)/.test(text)) {
    return "research_report";
  }
  if (/(investor day|investor presentation|earnings call|conference call|调研|调研纪要|业绩会|投资者交流)/.test(text)) {
    return "investor_research";
  }
  return "other";
}

function materialTypeLabel(type) {
  const key = String(type || "");
  if (key === "annual_report") return "年报/年度材料";
  if (key === "quarterly_report") return "季报材料";
  if (key === "semi_annual_report") return "半年报材料";
  if (key === "research_report") return "研报";
  if (key === "investor_research") return "调研/交流纪要";
  return "其他材料";
}

function extractXmlTag(block, tagName) {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = String(block || "").match(pattern);
  return match ? decodeHtmlEntities(match[1]) : "";
}

function parseBingRssItems(xmlText) {
  const text = String(xmlText || "");
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  const items = [];
  let match = itemPattern.exec(text);
  while (match) {
    const block = match[1] || "";
    const title = normalizeWhitespace(stripHtmlTags(extractXmlTag(block, "title")));
    const url = normalizeMaterialUrl(extractXmlTag(block, "link"));
    const snippet = normalizeWhitespace(stripHtmlTags(extractXmlTag(block, "description")));
    const pubDate = normalizeWhitespace(stripHtmlTags(extractXmlTag(block, "pubDate")));
    if (title && url) {
      items.push({
        title,
        url,
        snippet,
        pubDate: pubDate || null,
      });
    }
    match = itemPattern.exec(text);
  }
  return items;
}

function buildResearchSearchQueries(snapshot) {
  const symbol = String(snapshot?.symbol || "").trim();
  const code = symbol.slice(2);
  const name = String(snapshot?.name || "").trim();
  const corp = firstNonEmpty([name, "股票"]) || "股票";
  const codeToken = code ? ` ${code}` : "";

  const queries = [
    `${corp}${codeToken} 最近3个月 研报`,
    `${corp}${codeToken} 最近3个月 研究报告`,
    `${corp}${codeToken} 最近3个月 调研报告`,
    `${corp}${codeToken} 最近3个月 调研纪要`,
    `${corp}${codeToken} 最近3个月 年报`,
    `${corp}${codeToken} 最近3个月 半年报`,
    `${corp}${codeToken} 最近3个月 季报`,
    `${corp}${codeToken} 最近3个月 机构调研`,
    `${corp}${codeToken} 最近3个月 研报 site:eastmoney.com`,
    `${corp}${codeToken} 最近3个月 公告 年报 site:cninfo.com.cn`,
    `${corp}${codeToken} 最近3个月 调研 site:xueqiu.com`,
  ];

  return Array.from(new Set(queries.map((item) => item.trim()).filter(Boolean)));
}

function stripCompanySuffix(name) {
  return String(name || "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[\s·\-_/]/g, "")
    .replace(/(股份有限公司|有限责任公司|集团股份有限公司|集团有限公司|集团公司|集团|控股|公司)$/g, "")
    .trim();
}

function buildCompanyAliases(snapshot) {
  const name = String(snapshot?.name || "").trim();
  const aliases = new Set();
  if (name) aliases.add(name);
  const stripped = stripCompanySuffix(name);
  if (stripped && stripped.length >= 2) aliases.add(stripped);
  return Array.from(aliases).filter(Boolean);
}

function evaluateMaterialRelevance(item, snapshot) {
  const title = String(item?.title || "");
  const snippet = String(item?.snippet || "");
  const sourceQuery = String(item?.sourceQuery || "");
  const titleText = title.toLowerCase();
  const aliases = buildCompanyAliases(snapshot)
    .map((token) => String(token || "").toLowerCase())
    .filter(Boolean);
  const hasNameInTitle = aliases.some((token) => token.length >= 2 && titleText.includes(token));
  const hasKeywordInTitle = /(年报|研究报告|调研报告|调研纪要|调研|半年报|季报|研报|投资)/i.test(title);
  const queryHasReportIntent = /研报|研究报告|调研报告|调研纪要|年报|半年报|季报|投资/.test(sourceQuery);

  const publishedHint = firstNonEmpty([item?.publishedHint, parseDateHintFromText(`${title} ${snippet}`)]);
  const publishedAtTs = parseDateHintToTimestamp(publishedHint) || parsePubDateToTimestamp(item?.pubDate || "");
  const minRecentTs = Date.now() - MATERIAL_RECENT_DAYS * 24 * 60 * 60 * 1000;
  const isRecent = publishedAtTs !== null ? publishedAtTs >= minRecentTs : null;
  const withinRecentWindow = isRecent !== false;

  let relevanceScore = 0;
  if (hasNameInTitle) relevanceScore += 6;
  if (hasKeywordInTitle) relevanceScore += 4;
  if (queryHasReportIntent) relevanceScore += 1;
  if (isRecent === true) relevanceScore += 2;
  if (isRecent === false) relevanceScore -= 1;

  const strictRelevant =
    hasNameInTitle &&
    hasKeywordInTitle &&
    withinRecentWindow &&
    relevanceScore >= MATERIAL_MIN_RELEVANCE_SCORE;
  const looseRelevant =
    hasNameInTitle &&
    (hasKeywordInTitle || queryHasReportIntent) &&
    withinRecentWindow &&
    relevanceScore >= MATERIAL_MIN_RELEVANCE_SCORE;
  const isRelevant = MATERIAL_STRICT_FIXED_MODE ? strictRelevant : looseRelevant;

  return {
    isRelevant,
    relevanceScore,
    publishedAtTs,
    isRecent,
    relevanceFlags: {
      hasNameInTitle,
      hasKeywordInTitle,
      withinRecentWindow,
      isRecent,
      queryHasReportIntent,
      strictRelevant,
    },
  };
}

function scoreMaterialCandidate(item, snapshot) {
  const title = String(item?.title || "");
  const snippet = String(item?.snippet || "");
  const url = String(item?.url || "");
  const domain = extractDomain(url);
  const text = `${title}\n${snippet}\n${url}`.toLowerCase();
  const symbol = String(snapshot?.symbol || "").toLowerCase();
  const code = symbol.slice(2);
  const name = String(snapshot?.name || "").toLowerCase();

  let score = 0;
  if (name && text.includes(name)) score += 4;
  if (code && text.includes(code)) score += 3;
  if (symbol && text.includes(symbol)) score += 2;
  if (/\.(pdf)(\?|$)/i.test(url)) score += 3;
  if (/research|report|annual|quarter|10-k|10-q|研报|年报|季报|调研/.test(text)) score += 2;
  if (/sec\.gov|annualreports\.com|edgar|ir\.|investor/.test(domain)) score += 2;
  if (parseDateHintFromText(`${title} ${snippet}`)) score += 1;
  return score;
}

async function fetchBingRssSearch(query, limit = MATERIAL_RESULTS_PER_QUERY) {
  const safeLimit = Math.max(3, Math.min(20, Number(limit) || MATERIAL_RESULTS_PER_QUERY));
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${safeLimit}`;
  const resp = await fetchTextWithTimeout(url, 3800, {
    "User-Agent": "Mozilla/5.0",
  });
  return parseBingRssItems(resp.text || "").slice(0, safeLimit);
}

function extractReadableTextFromHtml(html) {
  const normalized = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return normalizeWhitespace(decodeHtmlEntities(normalized));
}

async function fetchMaterialPreview(material) {
  const url = normalizeMaterialUrl(material?.url || "");
  if (!url) {
    return { previewText: "", localText: "", previewStatus: "invalid_url", finalUrl: "", contentType: "" };
  }
  if (/\.pdf(\?|$)/i.test(url)) {
    try {
      const proxyUrl = `https://r.jina.ai/http://${url.replace(/^https?:\/\//i, "")}`;
      const resp = await fetchTextWithTimeout(proxyUrl, 5200, {
        "User-Agent": "Mozilla/5.0",
      });
      const text = normalizeWhitespace(decodeHtmlEntities(stripHtmlTags(resp.text || "")));
      if (text) {
        return {
          previewText: truncateText(text, MATERIAL_PREVIEW_CHAR_LIMIT),
          localText: truncateText(text, MATERIAL_LOCAL_TEXT_CHAR_LIMIT),
          previewStatus: "pdf_text_proxy_ok",
          finalUrl: url,
          contentType: "application/pdf",
        };
      }
    } catch {
      // fallback below
    }
    return {
      previewText: "",
      localText: "",
      previewStatus: "pdf_not_parsed",
      finalUrl: url,
      contentType: "application/pdf",
    };
  }
  try {
    const resp = await fetchTextWithTimeout(url, 4200, {
      "User-Agent": "Mozilla/5.0",
    });
    const contentType = String(resp.contentType || "").toLowerCase();
    if (contentType.includes("pdf")) {
      return {
        previewText: "",
        localText: "",
        previewStatus: "pdf_not_parsed",
        finalUrl: resp.finalUrl || url,
        contentType,
      };
    }
    const text = contentType.includes("html")
      ? extractReadableTextFromHtml(resp.text || "")
      : normalizeWhitespace(decodeHtmlEntities(stripHtmlTags(resp.text || "")));
    return {
      previewText: truncateText(text, MATERIAL_PREVIEW_CHAR_LIMIT),
      localText: truncateText(text, MATERIAL_LOCAL_TEXT_CHAR_LIMIT),
      previewStatus: text ? "ok" : "empty",
      finalUrl: resp.finalUrl || url,
      contentType,
    };
  } catch (error) {
    return {
      previewText: "",
      localText: "",
      previewStatus: `fetch_error:${truncateText(error?.message || String(error), 120)}`,
      finalUrl: url,
      contentType: "",
    };
  }
}

async function enrichMaterialsForDeepRead(materials = [], options = {}) {
  const maxToFetch = Math.max(0, Number(options.maxToFetch) || MATERIAL_PREVIEW_FETCH_LIMIT);
  const concurrency = Math.max(1, Math.min(4, Number(options.concurrency) || 3));
  const list = Array.isArray(materials) ? materials : [];
  const enriched = list.map((item) => ({ ...item }));
  const targets = enriched
    .map((item, idx) => ({ idx, item }))
    .filter(({ item }) => !!item?.url)
    .slice(0, maxToFetch);

  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const current = targets[cursor];
      cursor += 1;
      const preview = await fetchMaterialPreview(current.item);
      const idx = current.idx;
      enriched[idx] = {
        ...enriched[idx],
        previewText: preview.previewText || "",
        localText: preview.localText || "",
        previewStatus: preview.previewStatus || "unknown",
        finalUrl: preview.finalUrl || enriched[idx].url,
        contentType: preview.contentType || null,
        downloadedAt: Date.now(),
      };
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, targets.length || 1) }, () => worker());
  await Promise.all(workers);
  return enriched;
}

function createEmptyResearchMaterials(extra = {}) {
  return {
    fetchedAt: Date.now(),
    total: 0,
    rawTotal: 0,
    relevantCount: 0,
    filteredOut: 0,
    usedCount: 0,
    queryCount: 0,
    queries: [],
    items: [],
    searchErrors: {},
    ...extra,
  };
}

function hasUsableResearchMaterials(materials) {
  if (!materials || typeof materials !== "object") return false;
  const total = Number(materials.total || 0);
  if (total > 0) return true;
  return Array.isArray(materials.items) && materials.items.length > 0;
}

function hasAiReadCoverage(materials) {
  const compact = compactResearchMaterials(materials);
  if (!compact.items.length) return false;
  return compact.items.every((item) => {
    const hasNote = !!String(item?.aiReadNote || "").trim();
    const status = String(item?.aiReadStatus || "").toLowerCase();
    return hasNote || status.startsWith("ai_error") || status === "insufficient_content";
  });
}

async function collectResearchMaterials(snapshot, options = {}) {
  const queryLimit = Math.max(1, Math.min(8, Number(options.queryLimit) || MATERIAL_SEARCH_QUERY_LIMIT));
  const resultPerQuery = Math.max(3, Math.min(20, Number(options.resultPerQuery) || MATERIAL_RESULTS_PER_QUERY));
  const topN = Math.max(8, Math.min(50, Number(options.topN) || MATERIAL_TOP_N));
  const doDeepRead = options.deepRead !== false;

  const queries = buildResearchSearchQueries(snapshot).slice(0, queryLimit);
  if (!queries.length) return createEmptyResearchMaterials({ reason: "empty_queries" });

  const searchErrors = {};
  let allItems = [];

  for (const query of queries) {
    try {
      const rawItems = await fetchBingRssSearch(query, resultPerQuery);
      const normalized = rawItems.map((item) => {
        const resolvedUrl = unwrapSearchEngineRedirectUrl(
          item.url || "",
          `${item.title || ""}\n${item.snippet || ""}`
        );
        const mergedText = `${item.title || ""}\n${item.snippet || ""}\n${resolvedUrl || item.url || ""}`;
        const type = classifyMaterialType(mergedText);
        return {
          title: item.title || "",
          url: normalizeMaterialUrl(resolvedUrl || item.url || ""),
          rawUrl: normalizeMaterialUrl(item.url || ""),
          snippet: truncateText(item.snippet || "", 480),
          materialType: type,
          materialTypeLabel: materialTypeLabel(type),
          pubDate: item.pubDate || null,
          publishedHint: parseDateHintFromText(`${item.pubDate || ""} ${item.title || ""} ${item.snippet || ""}`),
          sourceEngine: "bing_rss",
          sourceQuery: query,
        };
      }).filter((item) => !!item.url && !!item.title);
      allItems = allItems.concat(normalized);
    } catch (error) {
      searchErrors[query] = truncateText(error?.message || String(error), 180);
    }
  }

  if (!allItems.length) {
    return createEmptyResearchMaterials({
      queryCount: queries.length,
      queries,
      searchErrors,
      reason: "search_no_result",
    });
  }

  const dedupeMap = new Map();
  for (const item of allItems) {
    const key = normalizeMaterialUrl(item.url);
    if (!key) continue;
    const existing = dedupeMap.get(key);
    const score = scoreMaterialCandidate(item, snapshot);
    const candidate = {
      ...item,
      domain: extractDomain(item.url),
      score,
    };
    if (!existing || score > Number(existing.score || 0)) {
      dedupeMap.set(key, candidate);
    }
  }

  const rankedAll = Array.from(dedupeMap.values())
    .map((item) => {
      const relevance = evaluateMaterialRelevance(item, snapshot);
      return {
        ...item,
        isRelevant: relevance.isRelevant,
        relevanceScore: relevance.relevanceScore,
        publishedAtTs: relevance.publishedAtTs,
        isRecent: relevance.isRecent,
        relevanceFlags: relevance.relevanceFlags,
      };
    })
    .sort((a, b) => {
      const relDiff = Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0);
      if (relDiff !== 0) return relDiff;
      return Number(b.score || 0) - Number(a.score || 0);
    });

  const relevantOnly = rankedAll.filter((item) => item.isRelevant);
  const recentRelevant = relevantOnly.filter((item) => item?.relevanceFlags?.withinRecentWindow !== false);
  const strictRecent = relevantOnly.filter((item) => item.isRecent === true);
  const fallbackRelevant = rankedAll.filter(
    (item) =>
      Number(item.relevanceScore || 0) >= MATERIAL_MIN_RELEVANCE_SCORE &&
      item?.relevanceFlags?.hasNameInTitle &&
      item?.relevanceFlags?.hasKeywordInTitle &&
      item?.relevanceFlags?.withinRecentWindow !== false
  );
  const nameOnlyFallback = rankedAll.filter(
    (item) =>
      item?.relevanceFlags?.hasNameInTitle &&
      item?.relevanceFlags?.withinRecentWindow !== false
  );
  const selectedBase = (
    strictRecent.length >= 3
      ? strictRecent
      : recentRelevant.length
        ? recentRelevant
        : relevantOnly.length
          ? relevantOnly
          : MATERIAL_STRICT_FIXED_MODE
            ? []
            : (fallbackRelevant.length ? fallbackRelevant : nameOnlyFallback)
  ).slice(0, topN);
  const ranked = selectedBase;

  const filterStats = {
    totalCandidates: rankedAll.length,
    kept: ranked.length,
    titleNoStockName: 0,
    titleNoReportKeyword: 0,
    notRecent: 0,
  };
  rankedAll.forEach((item) => {
    if (item.isRelevant) return;
    const flags = item?.relevanceFlags || {};
    if (!flags.hasNameInTitle) filterStats.titleNoStockName += 1;
    if (!flags.hasKeywordInTitle) filterStats.titleNoReportKeyword += 1;
    if (flags.isRecent === false) filterStats.notRecent += 1;
  });

  const enriched = doDeepRead
    ? await enrichMaterialsForDeepRead(ranked, {
        maxToFetch: Math.min(MATERIAL_PREVIEW_FETCH_LIMIT, ranked.length),
        concurrency: 3,
      })
    : ranked.map((item) => ({
        ...item,
        previewText: "",
        previewStatus: "deep_read_skipped",
      }));

  return {
    fetchedAt: Date.now(),
    total: enriched.length,
    rawTotal: rankedAll.length,
    relevantCount: relevantOnly.length,
    filteredOut: Math.max(0, rankedAll.length - enriched.length),
    usedCount: Math.min(MATERIAL_PROMPT_TOP_N, enriched.length),
    queryCount: queries.length,
    queries,
    items: enriched,
    searchErrors,
    filterStats,
  };
}

function buildSingleMaterialReadPrompt(snapshot, material) {
  const stockLabel = `${snapshot?.name || "个股"} (${snapshot?.symbol || "UNKNOWN"})`;
  const content = truncateText(material?.localText || material?.previewText || material?.snippet || "", 9000);
  return `你是一名股票研究员，请阅读一份单独材料并提炼要点。\n\n` +
    `【标的】${stockLabel}\n` +
    `【材料类型】${material?.materialTypeLabel || material?.materialType || "未知"}\n` +
    `【材料标题】${material?.title || "N/A"}\n` +
    `【来源URL】${material?.finalUrl || material?.url || "N/A"}\n` +
    `【时间提示】${material?.publishedHint || "N/A"}\n` +
    `【材料正文/摘录】\n${content}\n\n` +
    `请输出4行：\n` +
    `1) 核心结论（1行）\n` +
    `2) 关键数据点（至少2个，尽量含数值）\n` +
    `3) 对估值的影响（偏多/中性/偏空 + 理由）\n` +
    `4) 证据来源URL（原样输出）`;
}

async function summarizeSingleMaterialWithAi(material, snapshot, config) {
  const hasReadableContent = !!String(material?.localText || material?.previewText || material?.snippet || "").trim();
  if (!hasReadableContent) {
    return {
      ...material,
      aiReadStatus: "insufficient_content",
      aiReadNote: `核心结论: 内容不足，无法可靠提炼。\n证据来源URL: ${material?.finalUrl || material?.url || "N/A"}`,
      aiReadLlm: null,
    };
  }
  const messages = [
    {
      role: "system",
      content: "你是严谨的证券研究员。只能基于输入材料事实，禁止编造。",
    },
    {
      role: "user",
      content: buildSingleMaterialReadPrompt(snapshot, material),
    },
  ];

  try {
    const aiReadResult = await callOpenAICompatibleMessagesWithMeta(messages, config, {
      temperature: 0.1,
      maxTokens: MATERIAL_AI_READ_MAX_TOKENS,
    });
    return {
      ...material,
      aiReadStatus: "ok",
      aiReadNote: truncateText(String(aiReadResult.content || "").trim(), 2200),
      aiReadLlm: aiReadResult.provider || null,
    };
  } catch (error) {
    return {
      ...material,
      aiReadStatus: `ai_error:${truncateText(error?.message || String(error), 120)}`,
      aiReadNote: `核心结论: AI阅读失败，已回退到文本摘录。\n摘录: ${truncateText(material?.previewText || material?.snippet || "", 260)}\n证据来源URL: ${material?.finalUrl || material?.url || "N/A"}`,
      aiReadLlm: null,
    };
  }
}

async function enrichMaterialsWithAiRead(materials, snapshot, config, options = {}) {
  const list = Array.isArray(materials?.items) ? materials.items : [];
  if (!list.length) return compactResearchMaterials(materials);
  const concurrency = Math.max(1, Math.min(3, Number(options.concurrency) || MATERIAL_READ_CONCURRENCY));
  const enrichedItems = list.map((item) => ({ ...item }));

  let cursor = 0;
  async function worker() {
    while (cursor < enrichedItems.length) {
      const index = cursor;
      cursor += 1;
      const item = enrichedItems[index];
      enrichedItems[index] = await summarizeSingleMaterialWithAi(item, snapshot, config);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, enrichedItems.length) }, () => worker());
  await Promise.all(workers);

  return compactResearchMaterials({
    ...materials,
    items: enrichedItems,
    usedCount: enrichedItems.length,
  });
}

function compactResearchMaterials(materials) {
  if (!materials || typeof materials !== "object") {
    return createEmptyResearchMaterials();
  }
  const items = Array.isArray(materials.items) ? materials.items : [];
  return {
    fetchedAt: Number(materials.fetchedAt || Date.now()),
    total: Number(materials.total || items.length || 0),
    rawTotal: Number(materials.rawTotal || items.length || 0),
    relevantCount: Number(materials.relevantCount || 0),
    filteredOut: Number(materials.filteredOut || 0),
    usedCount: Number(materials.usedCount || Math.min(MATERIAL_PROMPT_TOP_N, items.length)),
    queryCount: Number(materials.queryCount || (Array.isArray(materials.queries) ? materials.queries.length : 0)),
    queries: Array.isArray(materials.queries) ? materials.queries.slice(0, 8) : [],
    searchErrors: materials.searchErrors && typeof materials.searchErrors === "object" ? materials.searchErrors : {},
    filterStats: materials.filterStats && typeof materials.filterStats === "object" ? materials.filterStats : null,
    items: items.slice(0, MATERIAL_TOP_N).map((item) => ({
      title: truncateText(item?.title || "", 220),
      url: normalizeMaterialUrl(item?.url || ""),
      rawUrl: normalizeMaterialUrl(item?.rawUrl || ""),
      finalUrl: normalizeMaterialUrl(item?.finalUrl || item?.url || ""),
      snippet: truncateText(item?.snippet || "", 420),
      previewText: truncateText(item?.previewText || "", 900),
      localText: truncateText(item?.localText || "", 3000),
      previewStatus: truncateText(item?.previewStatus || "", 80),
      materialType: item?.materialType || "other",
      materialTypeLabel: item?.materialTypeLabel || materialTypeLabel(item?.materialType || "other"),
      publishedHint: item?.publishedHint || null,
      publishedAtTs: Number(item?.publishedAtTs || 0) || null,
      isRecent: typeof item?.isRecent === "boolean" ? item.isRecent : null,
      pubDate: item?.pubDate || null,
      sourceEngine: item?.sourceEngine || "bing_rss",
      sourceQuery: truncateText(item?.sourceQuery || "", 180),
      domain: item?.domain || extractDomain(item?.url || ""),
      score: Number(item?.score || 0),
      isRelevant: !!item?.isRelevant,
      relevanceScore: Number(item?.relevanceScore || 0),
      relevanceFlags: item?.relevanceFlags || null,
      contentType: item?.contentType || null,
      downloadedAt: Number(item?.downloadedAt || 0) || null,
      aiReadStatus: truncateText(item?.aiReadStatus || "", 120),
      aiReadNote: truncateText(item?.aiReadNote || "", 2200),
      aiReadLlm: item?.aiReadLlm || null,
    })),
  };
}

function buildResearchMaterialsPromptText(materials, maxItems = MATERIAL_PROMPT_TOP_N) {
  const compact = compactResearchMaterials(materials);
  const requested = Math.max(1, Number(maxItems) || MATERIAL_PROMPT_TOP_N);
  const topItems = compact.items.slice(0, Math.min(requested, compact.items.length));
  if (!topItems.length) {
    return `材料检索结果：0份。请明确写出"外部材料覆盖不足"，并降低结论置信度。`;
  }

  const lines = [];
  lines.push(
    `材料检索总数: ${compact.total}（条件：最近${MATERIAL_RECENT_DAYS}天；原始候选=${compact.rawTotal}，有效关联=${compact.relevantCount}，过滤干扰=${compact.filteredOut}），本次用于深读: ${topItems.length}`
  );
  topItems.forEach((item, idx) => {
    lines.push(
      `[材料${idx + 1}] 类型=${item.materialTypeLabel || item.materialType}, 标题=${item.title}, 域名=${item.domain || "unknown"}, 时间提示=${item.publishedHint || "N/A"}, 最近3个月判定=${item.isRecent === true ? "是" : item.isRecent === false ? "否" : "未知"}`
    );
    lines.push(`来源URL: ${item.finalUrl || item.url}`);
    if (item.aiReadNote) lines.push(`AI逐份阅读摘要: ${truncateText(item.aiReadNote, 700)}`);
    if (item.snippet) lines.push(`搜索摘要: ${truncateText(item.snippet, 260)}`);
    if (item.localText) lines.push(`本地下载摘录: ${truncateText(item.localText, 680)}`);
    else if (item.previewText) lines.push(`页面摘录: ${truncateText(item.previewText, 520)}`);
  });
  return lines.join("\n");
}

function buildResearchMaterialsChatSummary(materials) {
  const compact = compactResearchMaterials(materials);
  if (!compact.total) return "材料检索：暂无";
  const domains = Array.from(new Set(compact.items.map((item) => item.domain).filter(Boolean))).slice(0, 5);
  return `材料检索：共${compact.total}份（有效关联${compact.relevantCount}，过滤干扰${compact.filteredOut}），已深读${compact.usedCount}份，来源域名示例：${domains.join(" / ") || "N/A"}`;
}

function extractUrlsFromText(text, maxCount = 30) {
  const raw = String(text || "");
  if (!raw) return [];
  const matches = raw.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  const unique = [];
  const set = new Set();
  for (const value of matches) {
    const normalized = normalizeMaterialUrl(value);
    if (!normalized || set.has(normalized)) continue;
    set.add(normalized);
    unique.push(normalized);
    if (unique.length >= maxCount) break;
  }
  return unique;
}

function buildModelWebSearchPrompt(snapshot) {
  const name = String(snapshot?.name || "").trim() || "目标股票";
  const symbol = String(snapshot?.symbol || "").trim();
  const code = symbol.slice(2);
  const end = formatYmdInChina(Date.now());
  const start = formatYmdInChina(Date.now() - MATERIAL_RECENT_DAYS * 24 * 60 * 60 * 1000);
  return `请你联网搜索并汇总 ${name}${code ? `(${code})` : ""} 最近3个月（${start}~${end}）的材料，重点仅限：年报、半年报、季报、研报、研究报告、调研报告、调研纪要、投资者交流。\n` +
    `要求：\n` +
    `1) 输出每条材料的标题、日期（若有）、来源URL。\n` +
    `2) 只要与该股票直接相关的材料，不要泛行业或同名无关内容。\n` +
    `3) 至少输出5条，若不足则输出实际条数并说明原因。\n` +
    `4) 不要编造URL。`;
}

async function collectResearchMaterialsByModelWebSearch(snapshot, config) {
  const prompt = buildModelWebSearchPrompt(snapshot);
  const messages = [
    {
      role: "system",
      content: "你是证券研究助手。必须只返回可追溯来源URL，不得编造。",
    },
    {
      role: "user",
      content: prompt,
    },
  ];

  const toolCandidates = [
    { tools: [{ type: "web_search" }], tool_choice: "auto" },
    { tools: [{ type: "web_search_preview" }], tool_choice: "auto" },
    { web_search_options: { search_context_size: "medium" } },
  ];

  let lastError = null;
  for (const extraBody of toolCandidates) {
    try {
      const result = await callOpenAICompatibleMessagesWithMeta(messages, config, {
        temperature: 0.1,
        maxTokens: 1400,
        extraBody,
      });
      const text = String(result?.content || "").trim();
      const urls = extractUrlsFromText(text, MATERIAL_TOP_N);
      if (!urls.length) continue;
      const items = urls.map((url, idx) => {
        const titleLine = String(text.split(/\r?\n/).find((line) => line.includes(url)) || "").trim();
        const title = titleLine.replace(url, "").replace(/^[\-\*\d\.\)\s]+/, "").trim() || `材料${idx + 1}`;
        const merged = `${title}\n${titleLine}\n${url}`;
        const materialType = classifyMaterialType(merged);
        return {
          title: truncateText(title, 220),
          url: normalizeMaterialUrl(url),
          finalUrl: normalizeMaterialUrl(url),
          rawUrl: normalizeMaterialUrl(url),
          snippet: truncateText(titleLine, 420),
          materialType,
          materialTypeLabel: materialTypeLabel(materialType),
          publishedHint: parseDateHintFromText(titleLine),
          sourceEngine: "model_web_search",
          sourceQuery: prompt,
          domain: extractDomain(url),
          isRelevant: true,
          relevanceScore: 100,
          relevanceFlags: {
            hasNameInTitle: true,
            hasKeywordInTitle: true,
            withinRecentWindow: true,
            isRecent: true,
            queryHasReportIntent: true,
            strictRelevant: true,
          },
        };
      });
      const enriched = await enrichMaterialsForDeepRead(items, {
        maxToFetch: Math.min(MATERIAL_PREVIEW_FETCH_LIMIT, items.length),
        concurrency: 3,
      });
      return compactResearchMaterials({
        fetchedAt: Date.now(),
        total: enriched.length,
        rawTotal: enriched.length,
        relevantCount: enriched.length,
        filteredOut: 0,
        usedCount: enriched.length,
        queryCount: 1,
        queries: [prompt],
        items: enriched,
        searchErrors: {},
        filterStats: {
          totalCandidates: enriched.length,
          kept: enriched.length,
          titleNoStockName: 0,
          titleNoReportKeyword: 0,
          notRecent: 0,
        },
      });
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return createEmptyResearchMaterials({ reason: "model_web_search_no_url" });
}

function deriveMacroCycleProfile(snapshot) {
  const marketBias = String(snapshot?.market?.bias || "neutral");
  const sectorSignal = deriveSectorTrendSignal(snapshot);
  let phase = "中性震荡期";
  let weights = {
    quality: 0.28,
    cashDividend: 0.2,
    leverage: 0.16,
    valuation: 0.2,
    growth: 0.16,
  };

  if (marketBias === "risk_off" || sectorSignal.level === "weak") {
    phase = "需求偏弱/防御期";
    weights = {
      quality: 0.3,
      cashDividend: 0.24,
      leverage: 0.2,
      valuation: 0.18,
      growth: 0.08,
    };
  } else if (marketBias === "supportive" && sectorSignal.level === "strong") {
    phase = "复苏扩张期";
    weights = {
      quality: 0.24,
      cashDividend: 0.12,
      leverage: 0.1,
      valuation: 0.2,
      growth: 0.34,
    };
  } else if (sectorSignal.level !== "weak") {
    phase = "修复观察期";
    weights = {
      quality: 0.27,
      cashDividend: 0.17,
      leverage: 0.15,
      valuation: 0.2,
      growth: 0.21,
    };
  }

  return {
    phase,
    marketBias,
    sectorLevel: sectorSignal.level,
    weights,
    sectorScore: sectorSignal.score,
  };
}

function deriveCashFlowForwardProfile(snapshot) {
  const operatingCashFlow = toNumber(snapshot?.cashFlow?.operatingCashFlow);
  const investingCashFlow = toNumber(snapshot?.cashFlow?.investingCashFlow);
  const capitalExpenditure = normalizeCapex(snapshot?.cashFlow?.capitalExpenditure);
  const netProfit = toNumber(snapshot?.cashFlow?.netProfit);
  const marketCap = toNumber(snapshot?.quote?.marketCap);
  const cashToProfitRatio = toNumber(snapshot?.cashFlow?.cashToProfitRatio);
  const dividendYield = toNumber(snapshot?.valuation?.dividendYield);
  const debtAssetRatio = toNumber(snapshot?.balanceSheet?.debtAssetRatio);

  const fcfRaw = operatingCashFlow !== null && capitalExpenditure !== null
    ? round(operatingCashFlow - capitalExpenditure, 2)
    : null;
  const fcf = toYiYuan(fcfRaw, 2);
  const fcfYield = fcfRaw !== null && marketCap !== null && marketCap !== 0
    ? round((fcfRaw / marketCap) * 100, 2)
    : null;
  const fcfToProfitRatio = fcfRaw !== null && netProfit !== null && netProfit !== 0
    ? round(fcfRaw / netProfit, 2)
    : null;

  let dividendSustainability = "待确认";
  if (cashToProfitRatio !== null && debtAssetRatio !== null) {
    if (cashToProfitRatio >= 1 && debtAssetRatio <= 65) dividendSustainability = "较高";
    else if (cashToProfitRatio >= 0.8 && debtAssetRatio <= 70) dividendSustainability = "中等";
    else dividendSustainability = "偏弱";
  }

  return {
    operatingCashFlow,
    capitalExpenditure,
    investingCashFlow,
    fcf,
    fcfYield,
    fcfToProfitRatio,
    cashToProfitRatio,
    dividendYield,
    dividendSustainability,
  };
}

function deriveQuadrantAxes(snapshot) {
  const revenueGrowth = toNumber(snapshot?.profitability?.revenueGrowth);
  const netProfitGrowth = toNumber(snapshot?.profitability?.netProfitGrowth);
  const sectorRelStrength20d = toNumber(snapshot?.sectorTrend?.relativeStrength20d);
  const trend60d = toNumber(snapshot?.trend?.return60d);
  const peTtm = toNumber(snapshot?.valuation?.peTtm);
  const pb = toNumber(snapshot?.valuation?.pb);
  const cashToProfitRatio = toNumber(snapshot?.cashFlow?.cashToProfitRatio);
  const debtAssetRatio = toNumber(snapshot?.balanceSheet?.debtAssetRatio);
  const dividendYield = toNumber(snapshot?.valuation?.dividendYield);
  const inventoryTurnover = toNumber(snapshot?.balanceSheet?.inventoryTurnover);
  const dso = toNumber(snapshot?.balanceSheet?.dso);

  let growthScore = 50;
  if (revenueGrowth !== null) growthScore += revenueGrowth >= 10 ? 15 : revenueGrowth >= 0 ? 6 : -8;
  if (netProfitGrowth !== null) growthScore += netProfitGrowth >= 10 ? 18 : netProfitGrowth >= 0 ? 8 : -15;
  if (sectorRelStrength20d !== null) growthScore += sectorRelStrength20d > 0 ? 10 : sectorRelStrength20d < -5 ? -10 : -3;
  if (trend60d !== null) growthScore += trend60d > 0 ? 8 : trend60d < -10 ? -8 : -3;
  growthScore = clamp(Math.round(growthScore), 0, 100);

  let safetyScore = 50;
  if (peTtm !== null) safetyScore += peTtm > 0 && peTtm <= 20 ? 12 : peTtm > 35 ? -12 : 0;
  if (pb !== null) safetyScore += pb > 0 && pb <= 2 ? 10 : pb > 5 ? -10 : 0;
  if (cashToProfitRatio !== null) safetyScore += cashToProfitRatio >= 0.9 ? 12 : cashToProfitRatio < 0.6 ? -10 : 0;
  if (debtAssetRatio !== null) safetyScore += debtAssetRatio <= 60 ? 10 : debtAssetRatio > 75 ? -10 : 0;
  if (dividendYield !== null) safetyScore += dividendYield >= 1.5 ? 6 : 0;
  // 存货周转率低→减值风险高；DSO高→回款效率差
  if (inventoryTurnover !== null) safetyScore += inventoryTurnover >= 3 ? 5 : inventoryTurnover < 1.5 ? -8 : 0;
  if (dso !== null) safetyScore += dso <= 30 ? 4 : dso > 90 ? -6 : 0;
  safetyScore = clamp(Math.round(safetyScore), 0, 100);

  let quadrant = "弱成长+弱安全边际（回避区间）";
  if (growthScore >= 60 && safetyScore >= 60) quadrant = "强成长+高安全边际（进攻型成长）";
  else if (growthScore < 60 && safetyScore >= 60) quadrant = "成长偏弱+安全边际较高（防御型价值+潜在复苏）";
  else if (growthScore >= 60 && safetyScore < 60) quadrant = "高成长+低安全边际（高风险成长）";

  const warnings = [];
  if (inventoryTurnover !== null && inventoryTurnover < 1.5) {
    warnings.push("存货周转率偏低(<" + 1.5 + ")，关注减值风险");
  }
  if (dso !== null && dso > 90) {
    warnings.push("DSO偏高(>" + 90 + "天)，回款效率需关注");
  }

  return {
    growthScore,
    safetyScore,
    quadrant,
    warnings,
  };
}

function deriveScenarioAnchors(snapshot) {
  const eps = toNumber(snapshot?.profitability?.eps);
  const peTtm = toNumber(snapshot?.valuation?.peTtm);
  const baselinePe = peTtm !== null && peTtm > 0 ? peTtm : 20;
  const optimisticPe = round(baselinePe * 1.2, 1);
  const pessimisticPe = round(Math.max(8, baselinePe * 0.85), 1);

  const baselinePrice = eps !== null ? round(eps * baselinePe, 2) : null;
  const optimisticPrice = eps !== null ? round(eps * optimisticPe, 2) : null;
  const pessimisticPrice = eps !== null ? round(eps * pessimisticPe, 2) : null;

  return {
    eps,
    baselinePe,
    optimisticPe,
    pessimisticPe,
    baselinePrice,
    optimisticPrice,
    pessimisticPrice,
    sensitivityHint: "增长率±2%或折现率±1%通常会带来约10%-15%的估值波动（经验值，需用DCF复核）",
  };
}

// ═══════════════════════════════════════════════════════════════
// 估值计算模块：DCF 绝对估值 + 相对估值
// ═══════════════════════════════════════════════════════════════
// 行业对比分析模块
// ═══════════════════════════════════════════════════════════════

// 申万一级行业别名表：雪球 industryName 可能返回的名称 -> 标准申万一级行业名
const SW_L1_ALIAS_MAP = {
  "银行": "银行", "商业银行": "银行",
  "证券": "非银金融", "券商": "非银金融", "保险": "非银金融", "信托": "非银金融", "多元金融": "非银金融",
  "电力设备": "电力设备", "电气设备": "电力设备", "电源设备": "电力设备",
  "食品饮料": "食品饮料", "白酒": "食品饮料",
  "医药生物": "医药生物", "医药": "医药生物", "医疗": "医药生物", "生物科技": "医药生物",
  "电子": "电子", "半导体": "电子", "消费电子": "电子", "元器件": "电子",
  "计算机": "计算机", "软件": "计算机", "信息技术": "计算机",
  "传媒": "传媒", "互联网": "传媒", "游戏": "传媒",
  "通信": "通信", "5G": "通信",
  "家用电器": "家用电器", "家电": "家用电器",
  "纺织服饰": "纺织服饰", "服装": "纺织服饰", "纺织": "纺织服饰",
  "轻工制造": "轻工制造", "造纸": "轻工制造", "包装": "轻工制造",
  "钢铁": "钢铁",
  "有色金属": "有色金属", "有色": "有色金属",
  "基础化工": "基础化工", "化工": "基础化工", "化学": "基础化工",
  "煤炭": "煤炭",
  "石油石化": "石油石化", "石油": "石油石化", "石化": "石油石化",
  "公用事业": "公用事业", "水务": "公用事业", "燃气": "公用事业", "供热": "公用事业",
  "环保": "环保",
  "交通运输": "交通运输", "交运": "交通运输", "航空": "交通运输", "物流": "交通运输", "港口": "交通运输", "航运": "交通运输",
  "房地产": "房地产", "地产": "房地产",
  "建筑装饰": "建筑装饰", "建筑": "建筑装饰", "工程": "建筑装饰", "基建": "建筑装饰",
  "商贸零售": "商贸零售", "零售": "商贸零售",
  "社会服务": "社会服务", "餐饮": "社会服务", "旅游": "社会服务", "酒店": "社会服务", "教育": "社会服务",
  "机械设备": "机械设备", "机械": "机械设备", "设备": "机械设备", "自动化": "机械设备",
  "国防军工": "国防军工", "军工": "国防军工", "航天": "国防军工",
  "汽车": "汽车", "整车": "汽车", "新能源车": "汽车",
  "建筑材料": "建筑材料", "建材": "建筑材料", "水泥": "建筑材料", "玻璃": "建筑材料",
  "农林牧渔": "农林牧渔", "农业": "农林牧渔", "养殖": "农林牧渔", "种业": "农林牧渔",
  "美容护理": "美容护理", "化妆品": "美容护理", "医美": "美容护理",
  "非银金融": "非银金融",
  "综合": "综合",
  "银行/金融": "银行",
};

function normalizeToSwL1(industryName) {
  if (!industryName) return null;
  const name = String(industryName).trim();
  // 精确匹配
  if (SW_L1_ALIAS_MAP[name]) return SW_L1_ALIAS_MAP[name];
  // 模糊匹配：行业名包含别名key
  for (const [alias, sw] of Object.entries(SW_L1_ALIAS_MAP)) {
    if (name.includes(alias) || alias.includes(name)) return sw;
  }
  return name;
}

function isSameIndustryGroup(a, b) {
  if (!a || !b) return false;
  // 先精确匹配
  if (String(a).trim() === String(b).trim()) return true;
  // 再归一化到申万一级行业
  const swA = normalizeToSwL1(a);
  const swB = normalizeToSwL1(b);
  return swA && swB && swA === swB;
}

function extractComparisonMetrics(result) {
  const s = result?.snapshot || result?.value?.snapshot || {};
  const vt = result?.valuationTables || result?.value?.valuationTables || {};
  const sig = result?.signal || result?.value?.signal || {};

  const relMetrics = {};
  if (vt?.relative?.available && Array.isArray(vt.relative.metrics)) {
    vt.relative.metrics.forEach((m) => {
      relMetrics[m.name] = { value: m.value, interpretation: m.interpretation };
    });
  }

  const dcfBase = vt?.dcf?.available
    ? (vt.dcf.scenarios || []).find((sc) => sc.name === "基准") || vt.dcf.scenarios?.[0]
    : null;
  const mmModels = vt?.multiModel?.available ? (vt.multiModel.models || []) : [];
  const graham = mmModels.find((m) => m.name === "Graham Number");
  const lynch = mmModels.find((m) => m.name === "Peter Lynch");

  return {
    currentPrice: toNumber(s?.quote?.current),
    marketCap: toNumber(s?.quote?.marketCap),
    pe: toNumber(s?.valuation?.peTtm),
    pb: toNumber(s?.valuation?.pb),
    roe: toNumber(s?.profitability?.roe),
    eps: toNumber(s?.profitability?.eps),
    netProfitGrowth: toNumber(s?.profitability?.netProfitGrowth),
    revenueGrowth: toNumber(s?.profitability?.revenueGrowth),
    grossMargin: toNumber(s?.profitability?.grossMargin),
    netMargin: toNumber(s?.profitability?.netMargin),
    psTtm: toNumber(s?.valuation?.psTtm),
    evEbitda: relMetrics["EV/EBITDA"]?.value ?? null,
    evEbitdaVerdict: relMetrics["EV/EBITDA"]?.interpretation ?? null,
    dividendYield: toNumber(s?.valuation?.dividendYield),
    fcfYield: toNumber(s?.cashFlow?.fcfYield),
    dcfVerdict: dcfBase?.verdict ?? null,
    dcfSafetyMargin: dcfBase?.safetyMargin ?? null,
    grahamValue: graham?.fairValue ?? null,
    lynchValue: lynch?.fairValue ?? null,
    rsi14: toNumber(s?.trend?.rsi14),
    trendBias: s?.trend?.trendBias || null,
    volumeRatio: toNumber(s?.trend?.volumeRatio5_20),
    sectorRelStrength: toNumber(s?.sectorTrend?.relativeStrength20d),
    signalTriggered: !!sig?.triggered,
    piotroskiScore: toNumber(s?.quality?.piotroskiFScore),
    debtAssetRatio: toNumber(s?.balanceSheet?.debtAssetRatio),
  };
}

function buildIndustryComparison(cacheEntries, currentSymbol) {
  const allEntries = (cacheEntries || []).filter(
    (e) => e && e.value && e.value.snapshot
  );
  if (!allEntries.length) {
    return { currentSymbol, industryName: null, stockData: [] };
  }

  const currentEntry = allEntries.find((e) => e.symbol === currentSymbol);
  const currentIndustry = currentEntry?.value?.snapshot?.sectorTrend?.industryName || null;

  let sameIndustry;
  if (currentIndustry) {
    sameIndustry = allEntries.filter((e) => {
      const ind = e.value?.snapshot?.sectorTrend?.industryName;
      return ind && isSameIndustryGroup(ind, currentIndustry);
    });
  } else {
    sameIndustry = allEntries;
  }

  const stockData = sameIndustry
    .map((e) => ({
      symbol: e.symbol,
      name: e.value?.name || e.symbol,
      isCurrent: e.symbol === currentSymbol,
      fetchedAt: e.ts,
      metrics: extractComparisonMetrics(e.value),
    }))
    .sort((a, b) => {
      if (a.isCurrent) return -1;
      if (b.isCurrent) return 1;
      const mcA = a.metrics.marketCap || 0;
      const mcB = b.metrics.marketCap || 0;
      return mcB - mcA;
    })
    .slice(0, 10);

  return { currentSymbol, industryName: currentIndustry, stockData };
}

function buildIndustryComparisonMessages(comparisonData) {
  const { industryName, stockData } = comparisonData;
  const stockCount = stockData.length;

  const systemPrompt = `你是专业的行业对比分析师。根据提供的同行业股票对比数据，进行横向分析。

要求：
1. 一句话概括该行业整体的估值和景气度
2. 按估值吸引力排名（最被低估到最高估）
3. 基本面最优标的（综合ROE、增长、利润率）
4. 市场趋势最强标的（RSI、趋势方向、成交量）
5. 综合推荐：最值得关注的前2只标的及理由
6. 风险提示
语言简洁专业，中文，400-600字`;

  const dataLines = [
    `行业: ${industryName || "未知"} | 共${stockCount}只股票对比`,
    "",
  ];

  const metricRows = [
    ["现价", "currentPrice", "元"],
    ["市值(亿)", "marketCap", ""],
    ["PE(TTM)", "pe", ""],
    ["PB", "pb", ""],
    ["ROE(%)", "roe", ""],
    ["EPS", "eps", ""],
    ["净利润增长(%)", "netProfitGrowth", ""],
    ["营收增长(%)", "revenueGrowth", ""],
    ["毛利率(%)", "grossMargin", ""],
    ["净利率(%)", "netMargin", ""],
    ["EV/EBITDA", "evEbitda", ""],
    ["股息率(%)", "dividendYield", ""],
    ["FCF Yield(%)", "fcfYield", ""],
    ["DCF判定", "dcfVerdict", ""],
    ["安全边际(%)", "dcfSafetyMargin", ""],
    ["Graham(元)", "grahamValue", ""],
    ["Lynch(元)", "lynchValue", ""],
    ["RSI14", "rsi14", ""],
    ["趋势", "trendBias", ""],
    ["量比5/20", "volumeRatio", ""],
    ["板块相对强弱(%)", "sectorRelStrength", ""],
    ["Piotroski", "piotroskiScore", ""],
    ["负债率(%)", "debtAssetRatio", ""],
    ["信号", "signalTriggered", ""],
  ];

  const header = ["指标", ...stockData.map((s) => `${s.name}(${s.symbol})`)].join(" | ");
  dataLines.push(header);
  dataLines.push("-".repeat(header.length));

  for (const [label, key, unit] of metricRows) {
    const row = stockData.map((s) => {
      const v = s.metrics[key];
      if (v === null || v === undefined) return "N/A";
      if (typeof v === "boolean") return v ? "已触发" : "未触发";
      return String(v) + unit;
    });
    dataLines.push([label, ...row].join(" | "));
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: dataLines.join("\n") },
  ];
}

// ═══════════════════════════════════════════════════════════════
// 估值计算模块：DCF 绝对估值 + 相对估值
// ═══════════════════════════════════════════════════════════════

function normalizeCapex(raw) {
  const n = toNumber(raw);
  return n !== null ? Math.abs(n) : null;
}

function getIndustryBenchmarks(industryName) {
  const name = String(industryName || "").toLowerCase();
  if (/银行|金融|证券|保险/.test(name)) {
    return { peRange: [4, 7, 12], pbRange: [0.4, 0.7, 1.2], psRange: [1, 2.5, 5], evEbitdaRange: [5, 10, 18], evEbitRange: [6, 11, 20], evRevenueRange: [2, 4, 7], priceFcfRange: [5, 10, 18] };
  }
  if (/科技|互联网|软件|电子|半导体|芯片|计算机|通信/.test(name)) {
    return { peRange: [20, 40, 80], pbRange: [2, 4, 8], psRange: [3, 6, 15], evEbitdaRange: [12, 22, 40], evEbitRange: [15, 25, 45], evRevenueRange: [3, 7, 18], priceFcfRange: [15, 25, 50] };
  }
  if (/消费|食品|饮料|白酒|家电|医药|医疗|服装|零售/.test(name)) {
    return { peRange: [15, 25, 50], pbRange: [2, 4, 8], psRange: [1.5, 3, 7], evEbitdaRange: [8, 15, 28], evEbitRange: [10, 18, 30], evRevenueRange: [1.5, 3, 7], priceFcfRange: [10, 18, 35] };
  }
  if (/制造|机械|设备|工程|建筑|钢铁|煤炭|化工|有色|建材/.test(name)) {
    return { peRange: [8, 15, 30], pbRange: [0.8, 1.5, 3], psRange: [0.5, 1.2, 3], evEbitdaRange: [6, 10, 18], evEbitRange: [7, 12, 22], evRevenueRange: [0.8, 1.5, 3.5], priceFcfRange: [7, 12, 25] };
  }
  if (/地产|房地产|物业/.test(name)) {
    return { peRange: [5, 10, 20], pbRange: [0.3, 0.8, 1.5], psRange: [0.3, 0.8, 2], evEbitdaRange: [6, 12, 22], evEbitRange: [8, 14, 25], evRevenueRange: [0.5, 1.2, 3], priceFcfRange: [5, 10, 20] };
  }
  if (/新能源|光伏|风电|锂电|储能|环保/.test(name)) {
    return { peRange: [15, 30, 60], pbRange: [1.5, 3, 6], psRange: [1, 2.5, 5], evEbitdaRange: [10, 18, 30], evEbitRange: [12, 20, 35], evRevenueRange: [1, 2.5, 6], priceFcfRange: [12, 22, 40] };
  }
  if (/汽车|交运|运输|航空|物流|港口/.test(name)) {
    return { peRange: [8, 16, 30], pbRange: [0.8, 1.8, 3.5], psRange: [0.5, 1.2, 3], evEbitdaRange: [6, 11, 20], evEbitRange: [7, 13, 24], evRevenueRange: [0.5, 1.2, 3], priceFcfRange: [7, 13, 25] };
  }
  return { peRange: [10, 20, 40], pbRange: [1, 2, 4], psRange: [1, 2.5, 5], evEbitdaRange: [8, 14, 25], evEbitRange: [8, 15, 28], evRevenueRange: [1, 2.5, 6], priceFcfRange: [8, 15, 30] };
}

function computeDcfScenario(baseFcfRaw, gRate, r, g, n, ctx) {
  const { marketCap, totalLiab, currentPrice, netProfit } = ctx;

  let forecastFcf = baseFcfRaw;
  const fcfIsNegative = baseFcfRaw !== null && baseFcfRaw <= 0;
  if (fcfIsNegative && netProfit !== null && netProfit > 0) {
    forecastFcf = netProfit * 0.5;
  }

  let pvSum = 0;
  let lastFcf = forecastFcf;
  for (let t = 1; t <= n; t++) {
    lastFcf = lastFcf * (1 + gRate);
    pvSum += lastFcf / Math.pow(1 + r, t);
  }

  const terminalValue = lastFcf * (1 + g) / Math.max(0.001, r - g);
  const pvTerminal = terminalValue / Math.pow(1 + r, n);
  const enterpriseValue = pvSum + pvTerminal;

  const netDebt = totalLiab !== null ? totalLiab * 0.7 : 0;
  const equityValue = enterpriseValue - netDebt;

  let intrinsicPerShare = null;
  let safetyMargin = null;
  if (marketCap !== null && marketCap > 0 && currentPrice !== null) {
    intrinsicPerShare = round(currentPrice * (equityValue / marketCap), 2);
    if (intrinsicPerShare !== null && currentPrice > 0) {
      safetyMargin = round((intrinsicPerShare - currentPrice) / currentPrice * 100, 2);
    }
  }

  const verdict = safetyMargin !== null
    ? (safetyMargin > 20 ? "低估" : safetyMargin > 0 ? "合理偏低" : safetyMargin > -20 ? "合理偏高" : "高估")
    : "数据不足";

  return {
    growthRate: round(gRate * 100, 2),
    wacc: round(r * 100, 2),
    terminalGrowthRate: round(g * 100, 2),
    enterpriseValueYi: toYiYuan(enterpriseValue, 2),
    equityValueYi: toYiYuan(equityValue, 2),
    intrinsicPerShare,
    currentPrice,
    safetyMargin,
    verdict,
  };
}

function computeDcfValuation(snapshot) {
  const operatingCashFlow = toNumber(snapshot?.cashFlow?.operatingCashFlow);
  const capitalExpenditure = normalizeCapex(snapshot?.cashFlow?.capitalExpenditure);
  const netProfit = toNumber(snapshot?.cashFlow?.netProfit);
  const marketCap = toNumber(snapshot?.quote?.marketCap);
  const currentPrice = toNumber(snapshot?.quote?.current);
  const debtAssetRatio = toNumber(snapshot?.balanceSheet?.debtAssetRatio);
  const revenueGrowth = toNumber(snapshot?.profitability?.revenueGrowth);
  const netProfitGrowth = toNumber(snapshot?.profitability?.netProfitGrowth);
  const revenueCagr3y = toNumber(snapshot?.profitability?.revenueCagr3y);
  const totalLiab = toNumber(snapshot?.evData?.totalLiab);

  const baseFcfRaw = (operatingCashFlow !== null && capitalExpenditure !== null)
    ? operatingCashFlow - capitalExpenditure
    : null;

  if (baseFcfRaw === null) {
    return {
      available: false,
      reason: "数据不足：缺少经营现金流或资本开支数据，无法计算自由现金流。",
    };
  }

  const fcfIsNegative = baseFcfRaw <= 0;

  // WACC 估算：risk-free + beta * ERP
  const riskFreeRate = 0.025;
  const equityRiskPremium = 0.055;
  let betaProxy = 1.0;
  if (debtAssetRatio !== null) {
    if (debtAssetRatio <= 30) betaProxy = 0.8;
    else if (debtAssetRatio <= 50) betaProxy = 0.95;
    else if (debtAssetRatio <= 65) betaProxy = 1.1;
    else betaProxy = 1.3;
  }
  const costOfEquity = riskFreeRate + betaProxy * equityRiskPremium;
  const baselineWacc = round(costOfEquity, 4);

  // 增长率估算
  const growthCandidates = [revenueGrowth, netProfitGrowth, revenueCagr3y].filter(
    (v) => v !== null && Number.isFinite(v)
  );
  let baselineGrowthRate = 5;
  if (growthCandidates.length > 0) {
    const avg = growthCandidates.reduce((a, b) => a + b, 0) / growthCandidates.length;
    baselineGrowthRate = Math.max(-5, Math.min(30, avg));
  }

  const n = 5;
  const ctx = { marketCap, totalLiab, currentPrice, netProfit };

  // 三种情景
  const scenarioConfigs = [
    { name: "保守", growthAdj: -4, waccAdj: 0.02, tgAdj: -0.5 },
    { name: "基准", growthAdj: 0, waccAdj: 0, tgAdj: 0 },
    { name: "乐观", growthAdj: 4, waccAdj: -0.015, tgAdj: 0.5 },
  ];

  const scenarios = scenarioConfigs.map((cfg) => {
    const gRate = Math.max(-0.02, (baselineGrowthRate + cfg.growthAdj) / 100);
    const r = Math.max(0.04, baselineWacc + cfg.waccAdj);
    const g = Math.max(0.005, (2.5 + cfg.tgAdj) / 100);
    return { name: cfg.name, ...computeDcfScenario(baseFcfRaw, gRate, r, g, n, ctx) };
  });

  // 敏感性分析
  const sensitivity = buildDcfSensitivity(baseFcfRaw, baselineWacc, baselineGrowthRate, ctx);

  return {
    available: true,
    baseFcfYiYuan: toYiYuan(baseFcfRaw, 2),
    baseFcfRaw,
    fcfIsNegative,
    wacc: round(baselineWacc * 100, 2),
    estimatedGrowthRate: round(baselineGrowthRate, 2),
    scenarios,
    sensitivity,
    assumptions: {
      riskFreeRate: round(riskFreeRate * 100, 2),
      equityRiskPremium: round(equityRiskPremium * 100, 2),
      betaProxy,
      costOfEquity: round(costOfEquity * 100, 2),
      perpetuityGrowthRate: 2.5,
      forecastYears: n,
    },
  };
}

function buildDcfSensitivity(baseFcfRaw, baselineWacc, baselineGrowthRate, ctx) {
  if (ctx.marketCap === null || ctx.currentPrice === null) return null;

  const growthDeltas = [-4, -2, 0, 2, 4];
  const waccDeltas = [-0.02, -0.01, 0, 0.01, 0.02];

  const grid = [];
  for (const gd of growthDeltas) {
    const gRate = Math.max(-0.02, (baselineGrowthRate + gd) / 100);
    const row = [];
    for (const wd of waccDeltas) {
      const r = Math.max(0.04, baselineWacc + wd);
      const g = 0.025;
      const n = 5;

      let forecastFcf = baseFcfRaw;
      if (baseFcfRaw <= 0 && ctx.netProfit !== null && ctx.netProfit > 0) {
        forecastFcf = ctx.netProfit * 0.5;
      }

      let pvSum = 0;
      let lastFcf = forecastFcf;
      for (let t = 1; t <= n; t++) {
        lastFcf = lastFcf * (1 + gRate);
        pvSum += lastFcf / Math.pow(1 + r, t);
      }
      const tv = lastFcf * (1 + g) / Math.max(0.001, r - g);
      const pvTv = tv / Math.pow(1 + r, n);
      const ev = pvSum + pvTv;
      const netDebt = ctx.totalLiab !== null ? ctx.totalLiab * 0.7 : 0;
      const equityValue = ev - netDebt;
      const intrinsicPerShare = ctx.currentPrice * (equityValue / ctx.marketCap);
      const safetyMargin = round((intrinsicPerShare - ctx.currentPrice) / ctx.currentPrice * 100, 1);
      row.push(safetyMargin);
    }
    grid.push({ growthLabel: `${round(baselineGrowthRate + gd, 1)}%`, values: row });
  }

  return {
    colLabels: waccDeltas.map((d) => `${round((baselineWacc + d) * 100, 1)}%`),
    grid,
  };
}

function buildRelativeMetric(name, value, range, interpretation) {
  const badgeClass =
    /低估|偏低估|破净|高股息|低估值/.test(interpretation) ? "good"
    : /合理|尚可|匹配/.test(interpretation) ? "warn"
    : "bad";
  return { name, value, range, interpretation, badgeClass };
}

function computeRelativeValuation(snapshot) {
  const peTtm = toNumber(snapshot?.valuation?.peTtm);
  const pb = toNumber(snapshot?.valuation?.pb);
  const psTtmDirect = toNumber(snapshot?.valuation?.psTtm);
  const psTtm = psTtmDirect !== null
    ? psTtmDirect
    : (() => {
        const mc = toNumber(snapshot?.quote?.marketCap);
        const rev = toNumber(snapshot?.evData?.revenue);
        return (mc !== null && rev !== null && rev > 0) ? round(mc / rev, 2) : null;
      })();
  const peg = toNumber(snapshot?.valuation?.peg);
  const dividendYield = toNumber(snapshot?.valuation?.dividendYield);
  const marketCap = toNumber(snapshot?.quote?.marketCap);
  const totalLiab = toNumber(snapshot?.evData?.totalLiab);
  const operatingProfit = toNumber(snapshot?.evData?.operatingProfit);
  const industryName = snapshot?.sectorTrend?.industryName || null;

  const benchmarks = getIndustryBenchmarks(industryName);
  const metrics = [];

  // PE
  metrics.push(buildRelativeMetric(
    "PE(TTM)", peTtm, benchmarks.peRange,
    peTtm === null ? "无数据"
      : peTtm <= 0 ? "亏损或无效"
      : peTtm < benchmarks.peRange[0] * 0.8 ? "显著低估"
      : peTtm < benchmarks.peRange[0] ? "偏低估"
      : peTtm <= benchmarks.peRange[1] ? "合理"
      : peTtm <= benchmarks.peRange[2] ? "偏高"
      : "高估"
  ));

  // PB
  metrics.push(buildRelativeMetric(
    "PB", pb, benchmarks.pbRange,
    pb === null ? "无数据"
      : pb < 1 ? "破净"
      : pb < benchmarks.pbRange[0] ? "低估"
      : pb <= benchmarks.pbRange[1] ? "合理"
      : pb <= benchmarks.pbRange[2] ? "偏高"
      : "高估"
  ));

  // PS
  metrics.push(buildRelativeMetric(
    "PS(TTM)", psTtm, benchmarks.psRange,
    psTtm === null ? "无数据"
      : psTtm < benchmarks.psRange[0] ? "低估"
      : psTtm <= benchmarks.psRange[1] ? "合理"
      : psTtm <= benchmarks.psRange[2] ? "偏高"
      : "高估"
  ));

  // PEG (防御型股票自动降权提示)
  const quadrantAxes = deriveQuadrantAxes(snapshot);
  const isDefensiveValue = quadrantAxes.growthScore < 60 && quadrantAxes.safetyScore >= 60;
  const pegHighDueToLowGrowth = peg !== null && peg > 10 && isDefensiveValue;
  metrics.push(buildRelativeMetric(
    "PEG", peg, [0.5, 1.0, 2.0],
    peg === null ? "无数据"
      : peg < 0 ? "负增长，PEG无效"
      : pegHighDueToLowGrowth ? "增速极低致PEG失真(防御型参考股息率)"
      : peg < 0.8 ? "低估值+高增长"
      : peg <= 1.2 ? "增长匹配估值"
      : peg <= 2.0 ? "增长放缓或估值偏高"
      : "估值偏高或增长不足"
  ));

  // 股息支付率(防御型核心指标)
  const payoutRatio = toNumber(snapshot?.valuation?.payoutRatio);
  metrics.push(buildRelativeMetric(
    "股息支付率(%)", payoutRatio, [20, 50, 80],
    payoutRatio === null ? "无数据"
      : payoutRatio < 0 ? "亏损，支付率无效"
      : payoutRatio < 20 ? "分红极少，利润留存比例高"
      : payoutRatio <= 50 ? "分红合理，兼顾再投资"
      : payoutRatio <= 80 ? "高分红，成熟期企业特征"
      : payoutRatio <= 100 ? "近乎全部分红，关注可持续性"
      : "分红超过净利润，不可持续"
  ));

  // EV/EBITDA
  let evEbitda = null;
  const evProfit = operatingProfit !== null && operatingProfit > 0
    ? operatingProfit
    : toNumber(snapshot?.cashFlow?.netProfit);
  if (marketCap !== null && evProfit !== null && evProfit > 0) {
    const ev = marketCap + (totalLiab || 0);
    const da = toNumber(snapshot?.evData?.depreciationAmortization);
    const ebitda = (da !== null && da > 0) ? evProfit + da : evProfit * 1.15;
    evEbitda = round(ev / ebitda, 2);
  }
  metrics.push(buildRelativeMetric(
    "EV/EBITDA", evEbitda, benchmarks.evEbitdaRange,
    evEbitda === null ? "无数据"
      : evEbitda < benchmarks.evEbitdaRange[0] ? "低估"
      : evEbitda <= benchmarks.evEbitdaRange[1] ? "合理"
      : evEbitda <= benchmarks.evEbitdaRange[2] ? "偏高"
      : "高估"
  ));

  // 股息率
  metrics.push(buildRelativeMetric(
    "股息率(%)", dividendYield, [1.5, 2.5, 4.0],
    dividendYield === null ? "无数据"
      : dividendYield >= 4.0 ? "高股息"
      : dividendYield >= 2.5 ? "股息吸引力尚可"
      : dividendYield >= 1.5 ? "股息偏低"
      : "几乎不分红"
  ));

  const revenue = toNumber(snapshot?.evData?.revenue);

  // EV/EBIT
  let evEbit = null;
  if (marketCap !== null && totalLiab !== null && operatingProfit !== null && operatingProfit > 0) {
    const ev = marketCap + (totalLiab || 0);
    evEbit = round(ev / operatingProfit, 2);
  }
  metrics.push(buildRelativeMetric(
    "EV/EBIT", evEbit, benchmarks.evEbitRange,
    evEbit === null ? "无数据"
      : evEbit < benchmarks.evEbitRange[0] ? "低估"
      : evEbit <= benchmarks.evEbitRange[1] ? "合理"
      : evEbit <= benchmarks.evEbitRange[2] ? "偏高"
      : "高估"
  ));

  // EV/Revenue
  let evRevenue = null;
  if (marketCap !== null && totalLiab !== null && revenue !== null && revenue > 0) {
    const ev = marketCap + (totalLiab || 0);
    evRevenue = round(ev / revenue, 2);
  }
  metrics.push(buildRelativeMetric(
    "EV/Revenue", evRevenue, benchmarks.evRevenueRange,
    evRevenue === null ? "无数据"
      : evRevenue < benchmarks.evRevenueRange[0] ? "低估"
      : evRevenue <= benchmarks.evRevenueRange[1] ? "合理"
      : evRevenue <= benchmarks.evRevenueRange[2] ? "偏高"
      : "高估"
  ));

  // Price/FCF
  let priceFcf = null;
  const ocf = toNumber(snapshot?.cashFlow?.operatingCashFlow);
  const capex = toNumber(snapshot?.cashFlow?.capitalExpenditure);
  const fcfRaw = (ocf !== null && capex !== null) ? ocf - Math.abs(capex) : null;
  if (marketCap !== null && fcfRaw !== null && fcfRaw > 0) {
    priceFcf = round(marketCap / fcfRaw, 2);
  }
  metrics.push(buildRelativeMetric(
    "P/FCF", priceFcf, benchmarks.priceFcfRange,
    priceFcf === null ? "无数据"
      : priceFcf < benchmarks.priceFcfRange[0] ? "低估"
      : priceFcf <= benchmarks.priceFcfRange[1] ? "合理"
      : priceFcf <= benchmarks.priceFcfRange[2] ? "偏高"
      : "高估"
  ));

  return {
    available: true,
    industryName,
    metrics,
    note: "行业基准为A股全市场经验分位（非精确行业数据），仅供参考。",
  };
}

function buildValuationSummary(snapshot, valuationTables) {
  const lines = [];
  const name = snapshot?.name || "该股";
  const currentPrice = toNumber(snapshot?.quote?.current);
  const peTtm = toNumber(snapshot?.valuation?.peTtm);
  const pb = toNumber(snapshot?.valuation?.pb);
  const roe = toNumber(snapshot?.profitability?.roe);

  // ── 1. 总体定调 ──
  const verdicts = [];
  const cheapCount = { value: 0, total: 0 };

  // DCF verdicts
  const dcf = valuationTables?.dcf;
  if (dcf?.available && Array.isArray(dcf.scenarios)) {
    dcf.scenarios.forEach((s) => {
      if (s.verdict && s.verdict !== "数据不足") verdicts.push(`DCF(${s.name}): ${s.verdict}`);
      if (s.safetyMargin !== null) {
        cheapCount.total++;
        if (s.safetyMargin > 0) cheapCount.value++;
      }
    });
  }

  // Multi-model verdicts
  const mm = valuationTables?.multiModel;
  if (mm?.available && Array.isArray(mm.models)) {
    mm.models.forEach((m) => {
      if (m.verdict && m.verdict !== "不适用") verdicts.push(`${m.name}: ${m.verdict}`);
      if (m.upsidePct !== null) {
        cheapCount.total++;
        if (m.upsidePct > 0) cheapCount.value++;
      }
    });
  }

  // Relative verdicts
  const rel = valuationTables?.relative;
  if (rel?.available && Array.isArray(rel.metrics)) {
    rel.metrics.forEach((m) => {
      if (m.interpretation && m.interpretation !== "无数据") {
        verdicts.push(`${m.name}: ${m.interpretation}`);
        cheapCount.total++;
        if (/低估|偏低估|破净|高股息|低估值/.test(m.interpretation)) cheapCount.value++;
      }
    });
  }

  // Asset verdict
  const asset = valuationTables?.asset;
  if (asset?.available && asset.navVerdict) {
    verdicts.push(`资产估值: ${asset.navVerdict}`);
    cheapCount.total++;
    if (/破净/.test(asset.navVerdict)) cheapCount.value++;
  }

  const ratio = cheapCount.total > 0 ? cheapCount.value / cheapCount.total : 0;
  let overallVerdict;
  if (ratio >= 0.6) overallVerdict = "整体偏低估";
  else if (ratio >= 0.35) overallVerdict = "估值中性偏合理";
  else if (ratio >= 0.15) overallVerdict = "估值中性偏高";
  else overallVerdict = "整体偏高估";

  lines.push(`=== 估值分析汇总 ===`);
  lines.push(`${name} 现价 ${currentPrice ?? "N/A"} 元 | 综合判定: ${overallVerdict}`);
  lines.push(`${cheapCount.value}/${cheapCount.total} 项指标指向低估`);
  lines.push("");

  // ── 2. DCF 摘要 ──
  if (dcf?.available && Array.isArray(dcf.scenarios)) {
    lines.push("[DCF 绝对估值]");
    const base = dcf.scenarios.find((s) => s.name === "基准") || dcf.scenarios[0];
    if (base) {
      lines.push(`  基准内在价值: ${base.intrinsicPerShare ?? "N/A"} 元 (安全边际 ${base.safetyMargin ?? "N/A"}%)`);
    }
    const con = dcf.scenarios.find((s) => s.name === "保守");
    const opt = dcf.scenarios.find((s) => s.name === "乐观");
    if (con) lines.push(`  保守: ${con.intrinsicPerShare ?? "N/A"} 元 (${con.verdict})`);
    if (opt) lines.push(`  乐观: ${opt.intrinsicPerShare ?? "N/A"} 元 (${opt.verdict})`);
    lines.push(`  假设: FCF=${dcf.baseFcfYiYuan ?? "N/A"}亿 增长率=${dcf.estimatedGrowthRate ?? "N/A"}% WACC=${dcf.wacc ?? "N/A"}%`);
    lines.push("");
  }

  // ── 3. 多模型摘要 ──
  if (mm?.available && Array.isArray(mm.models)) {
    lines.push("[多模型绝对估值]");
    mm.models.forEach((m) => {
      if (m.fairValue !== null) {
        lines.push(`  ${m.name}: 公允 ${m.fairValue} 元 (上行 ${m.upsidePct}%) ${m.verdict}`);
      } else {
        lines.push(`  ${m.name}: ${m.reason || m.verdict}`);
      }
    });
    if (mm.averageUpside !== null) {
      lines.push(`  三模型平均上行空间: ${mm.averageUpside}%`);
    }
    lines.push("");
  }

  // ── 4. 相对估值摘要 ──
  if (rel?.available && Array.isArray(rel.metrics)) {
    lines.push(`[相对估值${rel.industryName ? "(" + rel.industryName + ")" : ""}]`);
    const cheap = rel.metrics.filter((m) => /低估|偏低估|破净|高股息|低估值/.test(m.interpretation || ""));
    const fair = rel.metrics.filter((m) => /合理|尚可|匹配/.test(m.interpretation || ""));
    const expensive = rel.metrics.filter((m) => /偏高|高估/.test(m.interpretation || ""));
    if (cheap.length) lines.push(`  低估指标(${cheap.length}): ${cheap.map((m) => `${m.name}=${m.value ?? "N/A"}`).join(", ")}`);
    if (fair.length) lines.push(`  合理指标(${fair.length}): ${fair.map((m) => `${m.name}=${m.value ?? "N/A"}`).join(", ")}`);
    if (expensive.length) lines.push(`  偏高指标(${expensive.length}): ${expensive.map((m) => `${m.name}=${m.value ?? "N/A"}`).join(", ")}`);
    lines.push("");
  }

  // ── 5. 资产估值摘要 ──
  if (asset?.available) {
    lines.push("[资产估值]");
    if (asset.navPerShare !== null) lines.push(`  每股净资产: ${asset.navPerShare} 元 (Price/NAV=${asset.priceToNav ?? "N/A"})`);
    if (asset.ncavPerShare !== null && asset.ncavPerShare > 0) lines.push(`  每股NCAV: ${asset.ncavPerShare} 元 (Price/NCAV=${asset.priceToNcav ?? "N/A"})`);
    lines.push(`  判定: ${asset.navVerdict || "N/A"}`);
    lines.push("");
  }

  // ── 6. 投资策略建议 ──
  lines.push("[策略参考]");
  const strategies = [];
  if (pb !== null && pb < 1.0 && roe !== null && roe > 8) {
    strategies.push("破净+ROE合理 -> 适合价值投资(Deep Value)");
  }
  if (peTtm !== null && peTtm > 0 && peTtm < 15 && roe !== null && roe > 12) {
    strategies.push("低PE+高ROE -> 巴菲特式价值投资标的");
  }
  const peg = toNumber(snapshot?.valuation?.peg);
  if (peg !== null && peg > 0 && peg < 1.0) {
    strategies.push("PEG<1 -> Peter Lynch成长价值标的");
  }
  const dividendYield = toNumber(snapshot?.valuation?.dividendYield);
  if (dividendYield !== null && dividendYield >= 3.0) {
    strategies.push("高股息 -> 适合收息策略");
  }
  // 防御型价值策略：低增速+高安全边际时，PEG失真，改用股息支付率+现金流评估
  const payoutRatio = toNumber(snapshot?.valuation?.payoutRatio);
  const quadrantAxes = deriveQuadrantAxes(snapshot);
  if (quadrantAxes.growthScore < 60 && quadrantAxes.safetyScore >= 60) {
    if (payoutRatio !== null && payoutRatio >= 30 && payoutRatio <= 80) {
      strategies.push("防御型价值(支付率" + payoutRatio.toFixed(0) + "%) -> 分红稳定，适合底仓配置");
    }
    if (peg !== null && peg > 10) {
      strategies.push("PEG(" + peg.toFixed(1) + ")因增速极低失真 -> 应以股息率/现金流而非PEG评估");
    }
  }
  if (asset?.ncavPerShare !== null && asset.ncavPerShare > 0 && currentPrice !== null && currentPrice < asset.ncavPerShare) {
    strategies.push("股价低于NCAV -> Graham Net-Net深度价值信号");
  }
  if (strategies.length === 0) {
    strategies.push("未匹配到经典投资策略模式");
  }
  strategies.forEach((s) => lines.push(`  - ${s}`));
  lines.push("");
  lines.push("注: 以上为基于多模型交叉验证的量化总结，不构成投资建议。");

  return lines.join("\n");
}

function buildValuationSummaryMessages(snapshot, valuationTables, ruleSummary) {
  const name = snapshot?.name || "该股";
  const symbol = snapshot?.symbol || "";
  const currentPrice = toNumber(snapshot?.quote?.current);
  const marketCap = toNumber(snapshot?.quote?.marketCap);
  const industryName = snapshot?.sectorTrend?.industryName || "未知";

  const systemPrompt = `你是专业的价值投资分析师。根据提供的多模型估值数据，写一段结构清晰的估值分析总结。

要求：
1. 开头一句话总结整体估值水平（偏低估/合理/偏高估）
2. 分别简要点评DCF、多模型（DDM/Graham/Lynch）、相对估值、资产估值的结论
3. 指出各模型之间是否存在分歧，并解释可能原因
4. 根据数据自动判断适合哪种投资策略（价值/成长/收息/Deep Value等）
5. 给出具体的风险提示
6. 语言简洁专业，使用中文，总字数300-500字
7. 不要重复罗列数字，要分析解读`;

  const dataBlock = [
    `股票: ${name}(${symbol})`,
    `现价: ${currentPrice ?? "N/A"} 元 | 市值: ${marketCap ?? "N/A"} 亿 | 行业: ${industryName}`,
    "",
    "=== DCF绝对估值 ===",
  ];

  const dcf = valuationTables?.dcf;
  if (dcf?.available && Array.isArray(dcf.scenarios)) {
    dcf.scenarios.forEach((s) => {
      dataBlock.push(`  ${s.name}: 内在价值${s.intrinsicPerShare ?? "N/A"}元 安全边际${s.safetyMargin ?? "N/A"}% ${s.verdict}`);
    });
    dataBlock.push(`  基础FCF=${dcf.baseFcfYiYuan ?? "N/A"}亿 增长率=${dcf.estimatedGrowthRate ?? "N/A"}% WACC=${dcf.wacc ?? "N/A"}%`);
  } else {
    dataBlock.push(`  不可用: ${dcf?.reason || "数据不足"}`);
  }

  dataBlock.push("", "=== 多模型绝对估值 ===");
  const mm = valuationTables?.multiModel;
  if (mm?.available && Array.isArray(mm.models)) {
    mm.models.forEach((m) => {
      dataBlock.push(`  ${m.name}: 公允${m.fairValue ?? "N/A"}元 上行${m.upsidePct ?? "N/A"}% ${m.verdict} (${m.reason || ""})`);
    });
    if (mm.averageUpside !== null) dataBlock.push(`  平均上行空间: ${mm.averageUpside}%`);
  }

  dataBlock.push("", "=== 相对估值 ===");
  const rel = valuationTables?.relative;
  if (rel?.available && Array.isArray(rel.metrics)) {
    rel.metrics.forEach((m) => {
      dataBlock.push(`  ${m.name} = ${m.value ?? "N/A"} (参考${m.range ? m.range.join("/") : "N/A"}) -> ${m.interpretation}`);
    });
  }

  dataBlock.push("", "=== 资产估值 ===");
  const asset = valuationTables?.asset;
  if (asset?.available) {
    dataBlock.push(`  每股NAV: ${asset.navPerShare ?? "N/A"}元 Price/NAV=${asset.priceToNav ?? "N/A"}`);
    if (asset.ncavPerShare !== null) dataBlock.push(`  每股NCAV: ${asset.ncavPerShare}元 Price/NCAV=${asset.priceToNcav ?? "N/A"}`);
    dataBlock.push(`  判定: ${asset.navVerdict || "N/A"}`);
  }

  dataBlock.push("", "=== 量化摘要 ===");
  dataBlock.push(ruleSummary || "");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: dataBlock.join("\n") },
  ];
}

function computeMultiModelValuation(snapshot) {
  const eps = toNumber(snapshot?.profitability?.eps);
  const netProfitGrowth = toNumber(snapshot?.profitability?.netProfitGrowth);
  const marketCap = toNumber(snapshot?.quote?.marketCap);
  const currentPrice = toNumber(snapshot?.quote?.current);
  const totalAssets = toNumber(snapshot?.evData?.totalAssets);
  const totalLiab = toNumber(snapshot?.evData?.totalLiab);
  const dividendPerShare = toNumber(snapshot?.shareholder?.latestDividendPerShare);
  const debtAssetRatio = toNumber(snapshot?.balanceSheet?.debtAssetRatio);

  const sharesOutstanding = (marketCap !== null && currentPrice !== null && currentPrice > 0)
    ? marketCap * 100000000 / currentPrice
    : null;

  // WACC components (reuse DCF logic)
  const riskFreeRate = 0.025;
  const equityRiskPremium = 0.055;
  let betaProxy = 1.0;
  if (debtAssetRatio !== null) {
    if (debtAssetRatio <= 30) betaProxy = 0.8;
    else if (debtAssetRatio <= 50) betaProxy = 0.95;
    else if (debtAssetRatio <= 65) betaProxy = 1.1;
    else betaProxy = 1.3;
  }
  const costOfEquity = riskFreeRate + betaProxy * equityRiskPremium;

  const models = [];
  const upsideValues = [];

  // DDM (Gordon Growth Model)
  if (dividendPerShare !== null && dividendPerShare > 0 && currentPrice !== null) {
    const growthRate = Math.max(0, Math.min(8, (netProfitGrowth !== null ? netProfitGrowth : 5) * 0.5)) / 100;
    const r = Math.max(costOfEquity, growthRate + 0.01);
    const fairValue = round(dividendPerShare * (1 + growthRate) / (r - growthRate), 2);
    const upsidePct = round((fairValue - currentPrice) / currentPrice * 100, 1);
    const verdict = upsidePct > 20 ? "低估" : upsidePct > 0 ? "合理偏低" : upsidePct > -20 ? "合理偏高" : "高估";
    models.push({
      name: "DDM（股息折现）",
      fairValue,
      currentPrice,
      upsidePct,
      verdict,
      reason: `每股分红${dividendPerShare}元，增长率${round(growthRate * 100, 1)}%，折现率${round(r * 100, 1)}%`,
    });
    upsideValues.push(upsidePct);
  } else {
    models.push({
      name: "DDM（股息折现）",
      fairValue: null,
      currentPrice,
      upsidePct: null,
      verdict: "不适用",
      reason: dividendPerShare === null || dividendPerShare <= 0 ? "无分红数据" : "缺少股价数据",
    });
  }

  // Graham Number
  if (eps !== null && eps > 0 && totalAssets !== null && totalLiab !== null && sharesOutstanding !== null) {
    const bvps = (totalAssets - totalLiab) * 100000000 / sharesOutstanding;
    if (bvps > 0) {
      const grahamNumber = round(Math.sqrt(22.5 * eps * bvps), 2);
      const upsidePct = round((grahamNumber - currentPrice) / currentPrice * 100, 1);
      const verdict = upsidePct > 20 ? "低估" : upsidePct > 0 ? "合理偏低" : upsidePct > -20 ? "合理偏高" : "高估";
      models.push({
        name: "Graham Number",
        fairValue: grahamNumber,
        currentPrice,
        upsidePct,
        verdict,
        reason: `EPS=${eps}, BVPS=${round(bvps, 2)}, 公式=√(22.5×EPS×BVPS)`,
      });
      upsideValues.push(upsidePct);
    }
  }
  if (models.length < 2) {
    models.push({
      name: "Graham Number",
      fairValue: null,
      currentPrice,
      upsidePct: null,
      verdict: "不适用",
      reason: "缺少EPS或净资产数据",
    });
  }

  // Peter Lynch Fair Value
  if (eps !== null && eps > 0 && currentPrice !== null) {
    const growthRate = Math.max(0, Math.min(30, netProfitGrowth !== null ? netProfitGrowth : 0));
    if (growthRate > 0) {
      const fairPE = growthRate;
      const fairValue = round(eps * fairPE, 2);
      const upsidePct = round((fairValue - currentPrice) / currentPrice * 100, 1);
      const verdict = upsidePct > 20 ? "低估" : upsidePct > 0 ? "合理偏低" : upsidePct > -20 ? "合理偏高" : "高估";
      models.push({
        name: "Peter Lynch",
        fairValue,
        currentPrice,
        upsidePct,
        verdict,
        reason: `EPS=${eps}, 增长率=${round(growthRate, 1)}%, 合理PE=增长率=${fairPE}`,
      });
      upsideValues.push(upsidePct);
    } else {
      models.push({
        name: "Peter Lynch",
        fairValue: null,
        currentPrice,
        upsidePct: null,
        verdict: "不适用",
        reason: "增长率为零或负，Lynch模型不适用",
      });
    }
  } else {
    models.push({
      name: "Peter Lynch",
      fairValue: null,
      currentPrice,
      upsidePct: null,
      verdict: "不适用",
      reason: "缺少EPS数据",
    });
  }

  const averageUpside = upsideValues.length > 0
    ? round(upsideValues.reduce((a, b) => a + b, 0) / upsideValues.length, 1)
    : null;

  return {
    available: models.some((m) => m.fairValue !== null),
    models,
    averageUpside,
  };
}

function computeAssetValuation(snapshot) {
  const marketCap = toNumber(snapshot?.quote?.marketCap);
  const currentPrice = toNumber(snapshot?.quote?.current);
  const totalAssets = toNumber(snapshot?.evData?.totalAssets);
  const totalLiab = toNumber(snapshot?.evData?.totalLiab);
  const totalCurrentAssets = toNumber(snapshot?.evData?.totalCurrentAssets);

  if (marketCap === null || currentPrice === null || currentPrice <= 0 ||
      totalAssets === null || totalLiab === null) {
    return { available: false };
  }

  const sharesOutstanding = marketCap * 100000000 / currentPrice;

  // NAV per share
  const navPerShare = round((totalAssets - totalLiab) * 100000000 / sharesOutstanding, 2);
  const priceToNav = navPerShare > 0 ? round(currentPrice / navPerShare, 2) : null;

  // NCAV per share (Graham Net-Net)
  let ncavPerShare = null;
  let priceToNcav = null;
  if (totalCurrentAssets !== null && totalCurrentAssets > 0) {
    ncavPerShare = round((totalCurrentAssets - totalLiab) * 100000000 / sharesOutstanding, 2);
    if (ncavPerShare > 0) {
      priceToNcav = round(currentPrice / ncavPerShare, 2);
    }
  }

  const navVerdict = priceToNav !== null
    ? (priceToNav < 0.8 ? "显著破净" : priceToNav < 1.0 ? "破净" : priceToNav <= 1.5 ? "合理" : priceToNav <= 3.0 ? "溢价" : "高溢价")
    : "数据不足";

  return {
    available: true,
    navPerShare,
    priceToNav,
    ncavPerShare,
    priceToNcav,
    navVerdict,
  };
}

function deriveExecutionDiscipline(snapshot) {
  const peTtm = toNumber(snapshot?.valuation?.peTtm);
  const pb = toNumber(snapshot?.valuation?.pb);
  const cashToProfitRatio = toNumber(snapshot?.cashFlow?.cashToProfitRatio);
  const sectorRelStrength20d = toNumber(snapshot?.sectorTrend?.relativeStrength20d);
  const trendSignal = deriveTrendSignal(snapshot);

  const conditions = [
    {
      label: "估值不高（PE<=22）",
      pass: peTtm !== null && peTtm <= 22,
      current: peTtm,
    },
    {
      label: "估值安全边际（PB<=2.5）",
      pass: pb !== null && pb <= 2.5,
      current: pb,
    },
    {
      label: "现金流健康（净现比>=0.9）",
      pass: cashToProfitRatio !== null && cashToProfitRatio >= 0.9,
      current: cashToProfitRatio,
    },
    {
      label: "板块不再显著跑输（20D相对强弱>-2%）",
      pass: sectorRelStrength20d !== null && sectorRelStrength20d > -2,
      current: sectorRelStrength20d,
    },
    {
      label: "技术面过滤（趋势评分达到阈值）",
      pass: Number(trendSignal?.score || 0) >= Number(trendSignal?.threshold || TREND_MIN_SCORE),
      current: Number(round(trendSignal?.score, 2)),
    },
  ];

  const passCount = conditions.filter((item) => item.pass).length;
  return {
    conditions,
    passCount,
    totalCount: conditions.length,
    trendScore: Number(round(trendSignal?.score, 2) || 0),
    trendThreshold: Number(trendSignal?.threshold || TREND_MIN_SCORE),
  };
}

function deriveRiskFactorScores(snapshot) {
  const sectorWeak = String(snapshot?.sectorTrend?.trend?.trendBias || "").toLowerCase().includes("bear");
  const marketRiskOff = String(snapshot?.market?.bias || "") === "risk_off";
  const netProfitGrowth = toNumber(snapshot?.profitability?.netProfitGrowth);
  const sectorRelStrength20d = toNumber(snapshot?.sectorTrend?.relativeStrength20d);

  let demandRisk = 5;
  if (sectorWeak) demandRisk += 2;
  if (marketRiskOff) demandRisk += 1;

  let trendInertiaRisk = 5;
  if (sectorRelStrength20d !== null && sectorRelStrength20d < -5) trendInertiaRisk += 2;
  else if (sectorRelStrength20d !== null && sectorRelStrength20d < 0) trendInertiaRisk += 1;

  let competitionRisk = 5;
  if (netProfitGrowth !== null && netProfitGrowth < 0) competitionRisk += 2;

  const companySpecificRisk = clamp((demandRisk + competitionRisk) / 2, 1, 10);

  return {
    demandRisk: clamp(demandRisk, 1, 10),
    trendInertiaRisk: clamp(trendInertiaRisk, 1, 10),
    competitionRisk: clamp(competitionRisk, 1, 10),
    companySpecificRisk: clamp(companySpecificRisk, 1, 10),
  };
}



async function callOpenAICompatibleMessages(messages, config, options = {}) {
  const result = await callOpenAICompatibleMessagesWithMeta(messages, config, options);
  return result.content;
}

async function callOpenAICompatibleMessagesWithMeta(messages, config, options = {}) {
  const temperature = Number.isFinite(options.temperature) ? options.temperature : 0.4;
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 1800;
  const fixedProvider = sanitizeProvider(options.provider, 0);
  const providers = fixedProvider ? [fixedProvider] : buildModelProviders(config);
  if (!providers.length) {
    throw new Error("未配置可用的大模型节点，请先在插件设置中填写。");
  }

  const shouldRotateProviders = !fixedProvider;
  const start = shouldRotateProviders ? await reserveModelProviderStart(providers.length) : 0;
  const triedErrors = [];

  for (let offset = 0; offset < providers.length; offset += 1) {
    const providerIndex = (start + offset) % providers.length;
    const provider = providers[providerIndex];
    const providerId = buildProviderId(provider);
    const cooldownUntil = providerCooldownUntilMap.get(providerId) || 0;
    if (cooldownUntil > Date.now()) {
      triedErrors.push(
        `${provider.name}: 冷却中，${Math.ceil((cooldownUntil - Date.now()) / 1000)}秒后重试`
      );
      continue;
    }

    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
          ...(options?.extraBody && typeof options.extraBody === "object" ? options.extraBody : {}),
        }),
      });

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      const responseBody = await response.text();

      if (!response.ok) {
        if (response.status === 429 || isLikelyRateLimitMessage(responseBody)) {
          markProviderCooldown(provider);
        }
        if (isLikelyHtmlResponseBody(responseBody)) {
          markProviderCooldown(provider, PROVIDER_BAD_RESPONSE_COOLDOWN_MS);
          throw new Error(
            `HTTP ${response.status}: 节点返回HTML页面，疑似Base URL不兼容（需OpenAI /v1接口）`
          );
        }
        throw new Error(`HTTP ${response.status}: ${summarizeResponseBody(responseBody, 220)}`);
      }

      if (isLikelyHtmlResponseBody(responseBody)) {
        markProviderCooldown(provider, PROVIDER_BAD_RESPONSE_COOLDOWN_MS);
        throw new Error("返回HTML而非JSON，疑似Base URL或网关配置错误");
      }

      let content = "";
      try {
        content = extractOpenAICompatibleContent(responseBody, contentType);
      } catch (error) {
        const message = error?.message || String(error);
        if (message.startsWith("PARSE_FAILURE:")) {
          markProviderCooldown(provider, PROVIDER_BAD_RESPONSE_COOLDOWN_MS);
          throw new Error(message.replace(/^PARSE_FAILURE:/, ""));
        }
        throw error;
      }
      if (!content.trim()) {
        throw new Error("返回为空");
      }
      if (isLikelyRateLimitMessage(content)) {
        markProviderCooldown(provider);
        throw new Error(`触发限流: ${content.slice(0, 120)}`);
      }

      if (shouldRotateProviders) {
        await persistModelProviderCursor(normalizeRotationCursor(providerIndex + 1, providers.length));
      }
      return {
        content: content.trim(),
        provider: {
          name: provider.name || "provider",
          model: provider.model || "",
          baseUrl: provider.baseUrl || "",
        },
      };
    } catch (error) {
      const msg = error?.message || String(error);
      if (isLikelyRateLimitMessage(msg)) {
        markProviderCooldown(provider);
      }
      triedErrors.push(`${provider.name}: ${msg}`);
    }
  }

  const networkHint = triedErrors.some((item) => isLikelyNetworkError(item))
    ? " 检查本地代理服务是否已启动、端口是否可访问。"
    : "";
  throw new Error(`所有模型节点均调用失败：${triedErrors.join(" | ")}。${networkHint}`);
}

function sanitizeProvider(raw, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || `provider-${index + 1}`).trim();
  const baseUrl = String(raw.baseUrl || raw.api_base_url || "").trim().replace(/\/$/, "");
  const apiKey = String(raw.apiKey || raw.openai_api_key || "").trim();
  const model = String(raw.model || raw.prefer_model || "").trim();
  if (!baseUrl || !apiKey || !model) return null;
  return { name, baseUrl, apiKey, model };
}

function buildModelProviders(config) {
  const fromList = Array.isArray(config?.modelProviders)
    ? config.modelProviders.map((item, idx) => sanitizeProvider(item, idx)).filter(Boolean)
    : [];
  if (fromList.length) return fromList;

  const legacy = sanitizeProvider(
    {
      name: "primary",
      baseUrl: config?.api_base_url || DEFAULT_CONFIG.api_base_url,
      apiKey: config?.openai_api_key || "",
      model: config?.prefer_model || DEFAULT_CONFIG.prefer_model,
    },
    0
  );
  return legacy ? [legacy] : [];
}

function isLikelyNetworkError(message) {
  const msg = String(message || "");
  return /Failed to fetch|NetworkError|fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ERR_CONNECTION/i.test(
    msg
  );
}

function isLikelyRateLimitMessage(message) {
  const msg = String(message || "");
  return /Messages too frequent|Too many requests|rate limit|请求过于频繁|访问过于频繁|限流|429/i.test(
    msg
  );
}

function isLikelyHtmlResponseBody(body) {
  const text = String(body || "").trim().toLowerCase();
  return text.startsWith("<!doctype html") || text.startsWith("<html");
}

function summarizeResponseBody(body, maxLen = 180) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function extractOpenAICompatibleContent(responseBody, contentType = "") {
  if (isLikelySseResponseBody(responseBody, contentType)) {
    const streamedContent = parseSseCompletionContent(responseBody);
    if (streamedContent.trim()) return streamedContent;
    throw new Error("PARSE_FAILURE:SSE流返回为空");
  }

  let json = null;
  try {
    json = JSON.parse(responseBody);
  } catch {
    throw new Error(
      `PARSE_FAILURE:返回内容无法解析为JSON（content-type=${contentType || "unknown"}）: ${summarizeResponseBody(
        responseBody
      )}`
    );
  }
  return extractCompletionContentFromJson(json);
}

function isLikelySseResponseBody(body, contentType = "") {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("text/event-stream")) return true;
  const text = String(body || "").trim();
  return /^data:\s*/i.test(text);
}

function parseSseCompletionContent(body) {
  const text = String(body || "");
  const lines = text.split(/\r?\n/);
  const answerParts = [];
  const reasoningParts = [];
  let streamErrorMessage = "";

  for (const lineRaw of lines) {
    const line = String(lineRaw || "").trim();
    if (!line || !line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    let event = null;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }

    const eventError = event?.error?.message || event?.error;
    if (eventError) {
      streamErrorMessage =
        typeof eventError === "string" ? eventError : summarizeResponseBody(JSON.stringify(eventError), 180);
      continue;
    }

    const delta = safeGet(event, "choices.0.delta", null);
    const message = safeGet(event, "choices.0.message", null);
    const textFallback = safeGet(event, "choices.0.text", "");

    if (delta && typeof delta === "object") {
      const deltaContent = normalizeContentField(delta.content);
      if (deltaContent) answerParts.push(deltaContent);
      const deltaReasoning = normalizeContentField(delta.reasoning_content);
      if (deltaReasoning) reasoningParts.push(deltaReasoning);
      continue;
    }

    if (message && typeof message === "object") {
      const msgContent = normalizeContentField(message.content);
      if (msgContent) answerParts.push(msgContent);
      continue;
    }

    if (typeof textFallback === "string" && textFallback) {
      answerParts.push(textFallback);
    }
  }

  if (streamErrorMessage) {
    throw new Error(`SSE返回错误: ${streamErrorMessage}`);
  }

  const content = answerParts.join("").trim();
  if (content) return content;
  return reasoningParts.join("").trim();
}

function extractCompletionContentFromJson(json) {
  const messageContent = normalizeContentField(safeGet(json, "choices.0.message.content", ""));
  if (messageContent) return messageContent;
  const deltaContent = normalizeContentField(safeGet(json, "choices.0.delta.content", ""));
  if (deltaContent) return deltaContent;
  const textContent = String(safeGet(json, "choices.0.text", "") || "").trim();
  if (textContent) return textContent;
  return "";
}

function normalizeContentField(rawContent) {
  if (typeof rawContent === "string") return rawContent;
  if (Array.isArray(rawContent)) {
    return rawContent
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

function buildProviderId(provider) {
  return `${provider.baseUrl}|${provider.model}|${provider.name}`;
}

function markProviderCooldown(provider, cooldownMs = PROVIDER_RATE_LIMIT_COOLDOWN_MS) {
  const providerId = buildProviderId(provider);
  providerCooldownUntilMap.set(providerId, Date.now() + Math.max(1000, Number(cooldownMs) || 0));
}

async function callOpenAICompatible(prompt, config) {
  const result = await callOpenAICompatibleWithMeta(prompt, config);
  return result.content;
}

async function callOpenAICompatibleWithMeta(prompt, config) {
  return callOpenAICompatibleMessagesWithMeta(
    [
      {
        role: "system",
        content:
          "你是严谨的股票研究员，擅长价值投资与趋势投资。必须基于输入数据推理，不得编造事实。",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    config
  );
}

function buildStockChatMessages(payload) {
  const context = payload?.context || {};
  const snapshot = context.snapshot || null;
  const symbol = context.symbol || "UNKNOWN";
  const name = context.name || symbol;
  const contextSnapshotText = snapshot ? compactSnapshotText(snapshot) : "暂无结构化快照数据";
  const analysisText = context.analysis ? String(context.analysis).slice(0, 3000) : "暂无已生成分析";
  const materialSummary = buildResearchMaterialsChatSummary(context.researchMaterials);
  const promptStackText = buildPromptStackText();

  const messages = [
    {
      role: "system",
      content:
        "你是雪球股票助手。回答必须简洁、可执行、基于用户提供的股票上下文，不能编造未提供的数据；若上下文不足，先明确缺失项再给建议。\n" +
        `提示词栈（首条必须优先遵循）：\n${promptStackText}`,
    },
    {
      role: "system",
      content:
        `当前股票上下文：\n` +
        `标的：${name} (${symbol})\n` +
        `${materialSummary}\n` +
        `快照数据：\n${contextSnapshotText}\n\n` +
        `已生成分析（可能为摘要）：\n${analysisText}`,
    },
  ];

  const history = Array.isArray(payload?.history) ? payload.history : [];
  history.slice(-8).forEach((item) => {
    const role = item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : null;
    const content = typeof item?.content === "string" ? item.content.trim() : "";
    if (!role || !content) return;
    messages.push({ role, content: content.slice(0, 2000) });
  });

  messages.push({
    role: "user",
    content: String(payload?.userMessage || "").trim(),
  });

  return messages;
}

async function readCache(symbol) {
  const entry = await idbGet(CACHE_STORE_NAME, symbol);
  if (!entry) return null;
  const now = Date.now();
  const expiresAt = Number(entry.expiresAt || 0);
  if (expiresAt > 0 && expiresAt <= now) {
    try {
      await idbDelete(CACHE_STORE_NAME, symbol);
    } catch {
      // ignore cleanup error
    }
    return null;
  }
  return entry.value;
}

async function evictExpiredCache() {
  await evictExpiredCacheInDb(Date.now());
}

function compactCachedResult(value) {
  if (!value || typeof value !== "object") return value;
  const cloned = { ...value };
  delete cloned.rawData;
  if (typeof cloned.analysis === "string" && cloned.analysis.length > 20000) {
    cloned.analysis = cloned.analysis.slice(0, 20000);
  }
  if (cloned.researchMaterials) {
    cloned.researchMaterials = compactResearchMaterials(cloned.researchMaterials);
  }
  return cloned;
}

async function writeCache(symbol, value, ttlMs = CACHE_TTL_MS) {
  const now = Date.now();
  const ttl = Math.max(30000, Number(ttlMs) || CACHE_TTL_MS);
  const payload = {
    symbol,
    key: cacheKeyForSymbol(symbol),
    ts: now,
    ttl,
    expiresAt: now + ttl,
    value: compactCachedResult(value),
  };
  try {
    await idbPut(CACHE_STORE_NAME, payload);
  } catch (err) {
    if (String(err).includes("QuotaBytes") || String(err).includes("quota") || String(err).includes("AbortError")) {
      await evictExpiredCache();
      await idbPut(CACHE_STORE_NAME, payload);
    } else {
      throw err;
    }
  }
}

async function pruneMemoryStore() {
  const allEntries = await idbGetAll(MEMORY_ENTRY_STORE_NAME);
  const nextEntries = pruneMemoryEntries(Array.isArray(allEntries) ? allEntries : []);
  const keepIds = new Set(
    nextEntries.map((entry) => String(entry?.id || entry?.dedupeKey || "")).filter(Boolean)
  );
  const staleIds = [];
  for (const item of allEntries || []) {
    const id = String(item?.id || item?.dedupeKey || "");
    if (!id) continue;
    if (!keepIds.has(id)) staleIds.push(id);
  }
  if (staleIds.length) {
    await idbDeleteMany(MEMORY_ENTRY_STORE_NAME, staleIds);
  }
  return nextEntries;
}

async function readMemoryStore() {
  const entries = await pruneMemoryStore();
  let updatedAt = 0;
  for (const entry of entries) {
    const ts = Number(entry?.fetchedAt || 0);
    if (ts > updatedAt) updatedAt = ts;
  }
  return {
    version: 1,
    updatedAt,
    entries,
  };
}

function deriveTrendSignal(snapshot) {
  const close = toNumber(snapshot?.quote?.current);
  const trendBias = String(snapshot?.trend?.trendBias || "neutral").toLowerCase();
  const ma10 = toNumber(snapshot?.trend?.ma10);
  const ma20 = toNumber(snapshot?.trend?.ma20);
  const ma60 = toNumber(snapshot?.trend?.ma60);
  const ma120 = toNumber(snapshot?.trend?.ma120);
  const ma250 = toNumber(snapshot?.trend?.ma250);
  const maCross = String(snapshot?.trend?.maCross || "none");
  const ma120Slope = toNumber(snapshot?.trend?.ma120Slope);
  const ma250Slope = toNumber(snapshot?.trend?.ma250Slope);
  const priceDepartureMa20Pct = toNumber(snapshot?.trend?.priceDepartureMa20Pct);
  const rsi14 = toNumber(snapshot?.trend?.rsi14);
  const rsi14Prev = toNumber(snapshot?.trend?.rsi14Prev);
  const macdCross = String(snapshot?.trend?.macdCross || "none");
  const macdHist = toNumber(snapshot?.trend?.macd?.hist);
  const macdHistPrev = toNumber(snapshot?.trend?.macdHistPrev);
  const boll = snapshot?.trend?.boll || {};
  const bollSqueeze = !!boll.squeeze;
  const bollBreakoutUp = !!boll.breakoutUp;
  const bollBandwidthNow = toNumber(boll.bandwidthNow);
  const kdj = snapshot?.trend?.kdj || {};
  const kdjCross = String(kdj.cross || "none");
  const kdjK = toNumber(kdj.k);
  const kdjD = toNumber(kdj.d);
  const kdjJ = toNumber(kdj.j);
  const volumeRatio = toNumber(snapshot?.trend?.volumeRatio5_20);
  const volumeRatio10_20 = toNumber(snapshot?.trend?.volumeRatio10_20);
  const volumeRatio1_20 = toNumber(snapshot?.trend?.volumeRatio1_20);
  const breakoutConfirmed = !!snapshot?.trend?.breakout20Confirmed;
  const pullbackSupportReady = !!snapshot?.trend?.pullbackSupportReady;
  const marketScore = Number(snapshot?.market?.score || 0);
  const marketRiskOff = !!snapshot?.market?.riskOff;
  const advanced = deriveAdvancedTrendMetrics(snapshot);
  const bottomPatternScore = Math.max(
    Number(advanced.patternDoubleBottomScore || 0),
    Number(advanced.patternRoundBottomScore || 0),
    advanced.patternVBottomFlag ? 1 : 0
  );
  const flags = [];
  const neutralFocusNotes = [];
  let score = 0;

  // Core 1: MA trend skeleton
  if (ma10 !== null && ma20 !== null && ma10 > ma20) {
    flags.push("ma10_above_ma20");
    score += 1;
  }
  if (ma20 !== null && ma60 !== null && ma20 > ma60) {
    flags.push("ma20_above_ma60");
    score += 2;
  }
  if (ma120 !== null && ma250 !== null && ma120 > ma250) {
    flags.push("ma120_above_ma250");
    score += 1;
  }
  if (close !== null && ma60 !== null && close > ma60) {
    flags.push("close_above_ma60");
    score += 2;
  }
  if (close !== null && ma120 !== null && close > ma120) {
    flags.push("close_above_ma120");
    score += 1;
  }
  if (close !== null && ma250 !== null && close > ma250) {
    flags.push("close_above_ma250");
    score += 1;
  }
  if (ma120Slope !== null && ma120Slope > 0) {
    flags.push("ma120_slope_up");
    score += 1;
  }
  if (ma250Slope !== null && ma250Slope > 0) {
    flags.push("ma250_slope_up");
    score += 1;
  }
  if (maCross === "golden") {
    flags.push("ma_golden_cross");
    score += 1;
  } else if (maCross === "dead") {
    flags.push("ma_dead_cross");
    score -= 0.5;
  }

  // Core 2: MACD momentum
  if (macdCross === "golden") {
    flags.push("macd_golden_cross");
    score += 2;
  }
  if (macdHist !== null && macdHist > 0) {
    flags.push("macd_hist_positive");
    score += 1;
  }
  if (macdHist !== null && macdHistPrev !== null && macdHist > macdHistPrev) {
    flags.push("macd_hist_expanding");
    score += 1;
  }
  if (advanced.macdBullishDivergenceFlag) {
    flags.push("macd_bullish_divergence");
    score += 1;
  }
  if (bollSqueeze) {
    flags.push("boll_squeeze");
    score += 0.5;
  }
  if (bollBreakoutUp) {
    flags.push("boll_breakout_up");
    score += 1;
  }
  if (advanced.bollSqueezeBreakoutScore >= 2) {
    flags.push("boll_squeeze_breakout_confirmed");
    score += 0.5;
  }
  if (kdjCross === "golden") {
    flags.push("kdj_golden_cross");
    score += 1;
  } else if (kdjCross === "dead") {
    flags.push("kdj_dead_cross");
    score -= 0.5;
  }
  if (kdjK !== null && kdjD !== null && kdjK <= 20 && kdjD <= 20) {
    flags.push("kdj_oversold_zone");
    score += 0.5;
  }

  // Core 3: volume structure
  if (volumeRatio !== null && volumeRatio >= 1) {
    flags.push("volume_ratio5_20_ge_1");
    score += 1;
  }
  if (volumeRatio10_20 !== null && volumeRatio10_20 >= 1) {
    flags.push("volume_ratio10_20_ge_1");
    score += 1;
  }
  if (volumeRatio1_20 !== null && volumeRatio1_20 >= BREAKOUT_VOLUME_THRESHOLD) {
    flags.push("volume_ratio1_20_ge_1_2");
    score += 1;
  }
  if (breakoutConfirmed) {
    flags.push("breakout20_confirmed");
    score += 2;
  }
  if (pullbackSupportReady && volumeRatio !== null && volumeRatio <= 1.1) {
    flags.push("pullback_low_volume_support");
    score += 1;
  }

  // Core 4: RSI timing
  if (rsi14 !== null && rsi14 >= 50 && rsi14 <= 75) {
    flags.push("rsi_in_50_75");
    score += 1;
  } else if (rsi14 !== null && rsi14 >= 45 && rsi14 < 50) {
    flags.push("rsi_recovering_below_50");
    score += 0.5;
  }
  if (rsi14 !== null && rsi14Prev !== null && rsi14Prev < 50 && rsi14 >= 50) {
    flags.push("rsi_cross_50_up");
    score += 1;
  }

  const lowVolumeSidewaysRisk =
    rsi14 !== null &&
    rsi14 < 40 &&
    volumeRatio1_20 !== null &&
    volumeRatio1_20 < 0.9;
  if (lowVolumeSidewaysRisk) {
    flags.push("rsi_low_with_low_volume_sideways_risk");
    score -= 1.5;
  }

  let trendStrengthScore = 0;
  if (priceDepartureMa20Pct !== null) {
    if (priceDepartureMa20Pct >= 6) trendStrengthScore = 3;
    else if (priceDepartureMa20Pct >= 3) trendStrengthScore = 2;
    else if (priceDepartureMa20Pct >= 1) trendStrengthScore = 1;
  }
  const trendStrengthLevel =
    trendStrengthScore >= 3 ? "strong" :
    trendStrengthScore >= 2 ? "medium" :
    trendStrengthScore >= 1 ? "weak" : "flat";
  const tripleGoldenBreakout =
    maCross === "golden" &&
    macdCross === "golden" &&
    bollBreakoutUp;
  if (tripleGoldenBreakout) {
    flags.push("triple_golden_breakout");
    score += 2;
    if (trendStrengthScore >= 2) {
      flags.push("triple_breakout_strength_confirmed");
      score += 1;
    } else {
      flags.push("triple_breakout_strength_pending");
    }
  }

  // Core 5: market regime filter
  if (marketScore >= 2) {
    flags.push("market_supportive");
    score += 1;
  }
  if (marketRiskOff) {
    flags.push("market_risk_off");
    score -= 2;
  }

  // Core 6: weekly confirmation
  if (advanced.weeklyTrendConfirmScore >= 2) {
    flags.push("weekly_trend_confirmed");
    score += 1;
  }
  if (advanced.weeklyTrendConfirmScore >= 3) {
    flags.push("weekly_trend_strong");
    score += 0.5;
  }

  // Optional: bottom pattern merged score
  if (bottomPatternScore >= 1) {
    flags.push("bottom_pattern_detected");
    score += 0.5;
  }
  if (bottomPatternScore >= 2) {
    flags.push("bottom_pattern_confirmed");
    score += 1;
  }

  if (advanced.retestHoldScore >= 2) {
    flags.push("retest_hold_confirmed");
    score += 0.5;
  }

  const longTrendFilterPass =
    close !== null &&
    ma120 !== null &&
    ma250 !== null &&
    close > ma120 &&
    close > ma250 &&
    ma120Slope !== null &&
    ma120Slope > 0;
  if (longTrendFilterPass) flags.push("long_trend_filter_pass");

  if (trendBias === "neutral") {
    if (bollSqueeze) {
      neutralFocusNotes.push("布林带收窄，关注方向突破信号");
    }
    if (lowVolumeSidewaysRisk) {
      neutralFocusNotes.push("RSI14<40 且量比偏低，震荡概率高，避免重仓");
    }
    if (tripleGoldenBreakout) {
      if (trendStrengthScore >= 2) {
        neutralFocusNotes.push(
          `MA+MACD金叉并上轨突破，价离MA20约${round(priceDepartureMa20Pct, 2)}%，强度偏强`
        );
      } else {
        neutralFocusNotes.push("MA+MACD金叉并上轨突破，但价离MA20有限，强度仍需确认");
      }
    }
  }

  const triggered = score >= TREND_MIN_SCORE && !marketRiskOff;

  return {
    triggered,
    flags,
    score: Number(round(score, 2)),
    threshold: TREND_MIN_SCORE,
    longTrendFilterPass,
    ma120: round(ma120),
    ma250: round(ma250),
    ma120Slope: round(ma120Slope, 4),
    ma250Slope: round(ma250Slope, 4),
    maCross,
    macdCross,
    kdjCross,
    kdjK: round(kdjK, 2),
    kdjD: round(kdjD, 2),
    kdjJ: round(kdjJ, 2),
    bollSqueeze,
    bollBreakoutUp,
    bollBandwidthNow: round(bollBandwidthNow, 4),
    priceDepartureMa20Pct: round(priceDepartureMa20Pct, 2),
    trendStrengthScore,
    trendStrengthLevel,
    lowVolumeSidewaysRisk,
    tripleGoldenBreakout,
    neutralFocusNotes,
    bottomPatternScore: Number(round(bottomPatternScore, 2)),
    patternDoubleBottomScore: advanced.patternDoubleBottomScore,
    patternRoundBottomScore: advanced.patternRoundBottomScore,
    patternVBottomFlag: advanced.patternVBottomFlag,
    macdBullishDivergenceFlag: advanced.macdBullishDivergenceFlag,
    weeklyTrendConfirmScore: advanced.weeklyTrendConfirmScore,
    retestHoldScore: advanced.retestHoldScore,
    ruleVersion: "trend_v6",
  };
}

function deriveAdvancedTrendMetrics(snapshot) {
  const rows = Array.isArray(snapshot?.trend?.rows) ? snapshot.trend.rows : [];
  const closes = collectCloseSeriesFromRows(rows);
  const lows = collectLowSeriesFromRows(rows);
  const ma20 = toNumber(snapshot?.trend?.ma20);
  const close = toNumber(snapshot?.quote?.current);
  const volumeRatio5_20 = toNumber(snapshot?.trend?.volumeRatio5_20);
  const pullbackSupportReady = !!snapshot?.trend?.pullbackSupportReady;

  const fallback = {
    patternDoubleBottomScore: 0,
    patternRoundBottomScore: 0,
    patternVBottomFlag: false,
    macdBullishDivergenceFlag: false,
    rsiBullishDivergenceFlag: false,
    bollSqueezeBreakoutScore: 0,
    weeklyTrendConfirmScore: 0,
    retestHoldScore: 0,
  };

  if (closes.length < 40 || lows.length < 40) return fallback;
  if (closes.some((v) => v === null) || lows.some((v) => v === null)) return fallback;

  const swingLows = findRecentLocalLows(lows, 100);
  let patternDoubleBottomScore = 0;
  if (swingLows.length >= 2) {
    const l1 = swingLows[swingLows.length - 2];
    const l2 = swingLows[swingLows.length - 1];
    const span = l2.idx - l1.idx;
    if (span >= 8 && span <= 80) {
      const base = (l1.value + l2.value) / 2;
      const diffRatio = base !== 0 ? Math.abs(l2.value - l1.value) / base : 1;
      const midRange = closes.slice(l1.idx + 1, l2.idx);
      const neckline = midRange.length ? Math.max(...midRange) : null;
      if (diffRatio <= 0.08) patternDoubleBottomScore = 1;
      if (patternDoubleBottomScore >= 1 && neckline !== null && close !== null && close > neckline * 1.01) {
        patternDoubleBottomScore = 2;
      }
    }
  }

  let patternRoundBottomScore = 0;
  const lookback = closes.slice(-60);
  if (lookback.length >= 45) {
    const a = lookback.slice(0, 20);
    const b = lookback.slice(20, 40);
    const c = lookback.slice(40);
    const avgA = a.reduce((acc, cur) => acc + cur, 0) / a.length;
    const avgB = b.reduce((acc, cur) => acc + cur, 0) / b.length;
    const avgC = c.reduce((acc, cur) => acc + cur, 0) / c.length;
    const minVal = Math.min(...lookback);
    const minIdx = lookback.findIndex((v) => v === minVal);
    if (avgB <= avgA && avgC > avgB && minIdx >= 15 && minIdx <= 45) {
      patternRoundBottomScore = 1;
      if (close !== null && ma20 !== null && close > ma20 && volumeRatio5_20 !== null && volumeRatio5_20 >= 1) {
        patternRoundBottomScore = 2;
      }
    }
  }

  let patternVBottomFlag = false;
  const recent30 = closes.slice(-30);
  if (recent30.length >= 20) {
    const minVal = Math.min(...recent30);
    const minIdx = recent30.findIndex((v) => v === minVal);
    const leftHigh = Math.max(...recent30.slice(0, Math.max(1, minIdx)));
    const rightHigh = Math.max(...recent30.slice(minIdx + 1));
    const drawdown = leftHigh > 0 ? (leftHigh - minVal) / leftHigh : 0;
    const rebound = minVal > 0 ? (rightHigh - minVal) / minVal : 0;
    patternVBottomFlag = minIdx >= 4 && minIdx <= 18 && drawdown >= 0.12 && rebound >= 0.08;
  }

  const macdSeries = computeMacdSeries(closes, 12, 26, 9).hist;
  const rsiSeries = computeRsiSeries(closes, 14);
  let macdBullishDivergenceFlag = false;
  let rsiBullishDivergenceFlag = false;
  if (swingLows.length >= 2 && macdSeries.length === closes.length && rsiSeries.length === closes.length) {
    const l1 = swingLows[swingLows.length - 2];
    const l2 = swingLows[swingLows.length - 1];
    const p1 = lows[l1.idx];
    const p2 = lows[l2.idx];
    const m1 = toNumber(macdSeries[l1.idx]);
    const m2 = toNumber(macdSeries[l2.idx]);
    const r1 = toNumber(rsiSeries[l1.idx]);
    const r2 = toNumber(rsiSeries[l2.idx]);
    const priceNewLow = p1 !== null && p2 !== null && p2 <= p1 * 1.01;
    macdBullishDivergenceFlag = !!(priceNewLow && m1 !== null && m2 !== null && m2 > m1);
    rsiBullishDivergenceFlag = !!(priceNewLow && r1 !== null && r2 !== null && r2 > r1);
  }

  const boll = computeBollingerState(closes, 20);
  let bollSqueezeBreakoutScore = 0;
  if (boll.squeeze) bollSqueezeBreakoutScore = 1;
  if (boll.squeeze && boll.breakoutUp) bollSqueezeBreakoutScore = 2;

  const weekly = snapshot?.weeklyTrend || {};
  const weeklyClose = toNumber(weekly.close);
  const weeklyMa20 = toNumber(weekly.ma20);
  const weeklyMa60 = toNumber(weekly.ma60);
  const weeklyMacdHist = toNumber(weekly?.macd?.hist);
  const weeklyRsi14 = toNumber(weekly.rsi14);
  let weeklyTrendConfirmScore = 0;
  if (weeklyClose !== null && weeklyMa20 !== null && weeklyClose > weeklyMa20) weeklyTrendConfirmScore += 1;
  if (weeklyMa20 !== null && weeklyMa60 !== null && weeklyMa20 > weeklyMa60) weeklyTrendConfirmScore += 1;
  if (weeklyMacdHist !== null && weeklyMacdHist > 0) weeklyTrendConfirmScore += 1;
  if (weeklyRsi14 !== null && weeklyRsi14 >= 45 && weeklyRsi14 <= 75) weeklyTrendConfirmScore += 1;
  weeklyTrendConfirmScore = Math.min(3, weeklyTrendConfirmScore);

  let retestHoldScore = 0;
  if (pullbackSupportReady && close !== null && ma20 !== null && close >= ma20) {
    retestHoldScore = 2;
  } else if (close !== null && ma20 !== null && close >= ma20 * 0.99) {
    const last5Lows = lows.slice(-5);
    if (last5Lows.length >= 3 && last5Lows.every((v) => v >= ma20 * 0.985)) {
      retestHoldScore = 1;
    }
  }

  return {
    patternDoubleBottomScore,
    patternRoundBottomScore,
    patternVBottomFlag,
    macdBullishDivergenceFlag,
    rsiBullishDivergenceFlag,
    bollSqueezeBreakoutScore,
    weeklyTrendConfirmScore,
    retestHoldScore,
  };
}

function deriveSectorTrendSignal(snapshot) {
  const sector = snapshot?.sectorTrend?.trend || {};
  const close = toNumber(sector.close);
  const ma20 = toNumber(sector.ma20);
  const ma60 = toNumber(sector.ma60);
  const macdHist = toNumber(sector?.macd?.hist);
  const rsi14 = toNumber(sector.rsi14);
  const volumeRatio5_20 = toNumber(sector.volumeRatio5_20);
  const breakoutConfirmed = !!sector.breakout20Confirmed;
  const relStrength20d = toNumber(snapshot?.sectorTrend?.relativeStrength20d);
  const flags = [];
  let score = 0;

  if (close !== null && ma20 !== null && close > ma20) {
    flags.push("sector_close_above_ma20");
    score += 1;
  }
  if (ma20 !== null && ma60 !== null && ma20 > ma60) {
    flags.push("sector_ma20_above_ma60");
    score += 1;
  }
  if (macdHist !== null && macdHist > 0) {
    flags.push("sector_macd_hist_positive");
    score += 1;
  }
  if (rsi14 !== null && rsi14 >= 45 && rsi14 <= 75) {
    flags.push("sector_rsi_in_45_75");
    score += 1;
  }
  if (volumeRatio5_20 !== null && volumeRatio5_20 >= 1) {
    flags.push("sector_volume_ratio5_20_ge_1");
    score += 1;
  }
  if (breakoutConfirmed) {
    flags.push("sector_breakout20_confirmed");
    score += 2;
  }
  if (relStrength20d !== null && relStrength20d > 0) {
    flags.push("sector_rel_strength_positive");
    score += 1;
  }

  let level = "neutral";
  if (score >= 5 && String(sector.trendBias || "").toLowerCase().includes("bull")) level = "strong";
  else if (score <= 1 || String(sector.trendBias || "").toLowerCase().includes("bear")) level = "weak";
  else if (String(sector.trendBias || "").toLowerCase().includes("insufficient")) level = "neutral";

  return {
    score,
    flags,
    level,
    ruleVersion: "sector_trend_v1",
  };
}

function deriveFundamentalStrength(snapshot) {
  const coverage = snapshot?.valueCoverage || {};
  const coverageChecks = Array.isArray(coverage?.checks) ? coverage.checks : [];
  const coverageReady = coverageChecks.filter((item) => item?.pass !== null);
  if (coverageReady.length >= 6) {
    const flags = coverageReady.filter((item) => item.pass === true).map((item) => item.key);
    const score = toNumber(coverage?.normalizedScore10);
    const level = coverage?.level || "medium";
    return {
      score: score !== null ? score : Number(round((flags.length / coverageReady.length) * 10, 2)),
      flags,
      level,
      availableCount: Number(coverage?.availableCount || coverageReady.length),
      passCount: Number(coverage?.passCount || flags.length),
      ruleVersion: "fundamental_strength_v2",
    };
  }

  const roe = toNumber(snapshot?.profitability?.roe);
  const netProfitGrowth = toNumber(snapshot?.profitability?.netProfitGrowth);
  const cashToProfitRatio = toNumber(snapshot?.cashFlow?.cashToProfitRatio);
  const debtAssetRatio = toNumber(snapshot?.balanceSheet?.debtAssetRatio);
  const peTtm = toNumber(snapshot?.valuation?.peTtm);
  const flags = [];
  let score = 0;

  if (roe !== null && roe >= 10) {
    flags.push("roe_ge_10");
    score += 1;
  }
  if (netProfitGrowth !== null && netProfitGrowth >= 8) {
    flags.push("profit_growth_ge_8");
    score += 1;
  }
  if (cashToProfitRatio !== null && cashToProfitRatio >= 0.9) {
    flags.push("cash_profit_ratio_ge_0_9");
    score += 1;
  }
  if (debtAssetRatio !== null && debtAssetRatio <= 65) {
    flags.push("debt_asset_ratio_le_65");
    score += 1;
  }
  if (peTtm !== null && peTtm > 0 && peTtm <= 35) {
    flags.push("pe_ttm_in_reasonable_range");
    score += 1;
  }

  if (netProfitGrowth !== null && netProfitGrowth < 0) score -= 1;
  if (cashToProfitRatio !== null && cashToProfitRatio < 0.6) score -= 1;
  if (debtAssetRatio !== null && debtAssetRatio > 75) score -= 1;

  let level = "medium";
  if (score >= 3) level = "strong";
  if (score <= 1) level = "weak";

  return {
    score,
    flags,
    level,
    ruleVersion: "fundamental_strength_v1",
  };
}

function deriveOpportunityProfile(snapshot) {
  const fundamental = deriveFundamentalStrength(snapshot);
  const sector = deriveSectorTrendSignal(snapshot);
  const fundamentalStrong = fundamental.level === "strong";
  const sectorStrong = sector.level === "strong";
  let type = "avoid";
  let positionGuidance = "暂不建议介入";
  let sectorResonance = "none";

  if (fundamentalStrong && sectorStrong) {
    type = "best_value_opportunity";
    positionGuidance = "基本面+板块共振，可积极配置";
    sectorResonance = "aligned";
  } else if (fundamentalStrong && !sectorStrong) {
    type = "defensive_value";
    sectorResonance = "divergent";
    if (sector.level === "weak") {
      positionGuidance = "基本面强但板块极弱，底部分批建仓(防范Beta拖累)";
    } else {
      positionGuidance = "基本面强但板块中性，可适度配置(控制仓位)";
    }
  } else if (!fundamentalStrong && sectorStrong) {
    type = "high_risk_growth";
    positionGuidance = "板块强但基本面弱，轻仓跟随(趋势为主)";
    sectorResonance = "sector_led";
  } else {
    type = "avoid";
    positionGuidance = "基本面+板块均弱，暂不介入";
    sectorResonance = "none";
  }

  return {
    type,
    fundamentalStrong,
    sectorStrong,
    fundamental,
    sector,
    sectorResonance,
    positionGuidance,
    ruleVersion: "opportunity_quadrant_v2",
  };
}

function deriveValueSignal(snapshot) {
  const peTtm = toNumber(snapshot?.valuation?.peTtm);
  const pb = toNumber(snapshot?.valuation?.pb);
  const roe = toNumber(snapshot?.profitability?.roe);
  const revenueCagr3y = toNumber(snapshot?.profitability?.revenueCagr3y);
  const cashToProfitRatio = toNumber(snapshot?.cashFlow?.cashToProfitRatio);
  const debtAssetRatio = toNumber(snapshot?.balanceSheet?.debtAssetRatio);
  const dividendYield = toNumber(snapshot?.valuation?.dividendYield);
  const fcfYield = toNumber(snapshot?.cashFlow?.fcfYield);
  const piotroskiFScore = toNumber(snapshot?.quality?.piotroskiFScore);
  const overseasRatio = toNumber(snapshot?.business?.overseasOrNewRevenueRatio);
  const targetDiscountPctToRef = toNumber(snapshot?.valuation?.targetDiscountPctToRef);
  const sectorTrend = deriveSectorTrendSignal(snapshot);
  const coverage = snapshot?.valueCoverage || {};
  const flags = [];

  if (pb !== null && pb > 0 && pb <= 3.5) flags.push("pb_le_3_5");
  if (peTtm !== null && peTtm > 0 && peTtm <= 22) flags.push("pe_le_22");
  if (roe !== null && roe >= 12) flags.push("roe_ge_12");
  if (cashToProfitRatio !== null && cashToProfitRatio >= 1) flags.push("cash_profit_ratio_ge_1");
  if (debtAssetRatio !== null && debtAssetRatio < 50) flags.push("debt_asset_ratio_lt_50");
  if (dividendYield !== null && dividendYield >= 1.5) flags.push("dividend_yield_ge_1_5");
  if (fcfYield !== null && fcfYield >= 5) flags.push("fcf_yield_ge_5");
  if (revenueCagr3y !== null && revenueCagr3y > 5) flags.push("revenue_cagr3y_gt_5");
  if (overseasRatio !== null && overseasRatio > 10) flags.push("overseas_or_new_ratio_gt_10");
  if (piotroskiFScore !== null && piotroskiFScore > 7) flags.push("piotroski_gt_7");
  if (targetDiscountPctToRef !== null && targetDiscountPctToRef <= 80) flags.push("target_discount_le_80");
  if (sectorTrend.level !== "weak") flags.push("sector_trend_not_weak");

  const valuationCheap =
    flags.includes("pb_le_3_5") ||
    flags.includes("pe_le_22") ||
    flags.includes("target_discount_le_80");
  const qualityPass =
    flags.includes("roe_ge_12") &&
    flags.includes("cash_profit_ratio_ge_1") &&
    flags.includes("debt_asset_ratio_lt_50") &&
    (flags.includes("fcf_yield_ge_5") || flags.includes("piotroski_gt_7"));
  const growthOrStoryPass =
    flags.includes("revenue_cagr3y_gt_5") ||
    flags.includes("overseas_or_new_ratio_gt_10") ||
    flags.includes("sector_trend_not_weak");
  const coveragePass = toNumber(coverage?.normalizedScore10) !== null
    ? Number(coverage.normalizedScore10) >= 6
    : true;
  const triggered = valuationCheap && qualityPass && growthOrStoryPass && coveragePass;

  return {
    triggered,
    flags,
    coverageScore10: toNumber(coverage?.normalizedScore10),
    coveragePassCount: Number(coverage?.passCount || 0),
    coverageAvailableCount: Number(coverage?.availableCount || 0),
    ruleVersion: "value_v3",
  };
}

function deriveBuySignal(snapshot) {
  const trendSignal = deriveTrendSignal(snapshot);
  const valueSignal = deriveValueSignal(snapshot);
  const opportunity = deriveOpportunityProfile(snapshot);
  const triggered =
    opportunity.type === "best_value_opportunity" ||
    (opportunity.type === "defensive_value" && !!valueSignal.triggered);

  return {
    triggered,
    trendTriggered: !!trendSignal.triggered,
    valueTriggered: !!valueSignal.triggered,
    trendFlags: trendSignal.flags || [],
    trendScore: Number(trendSignal.score || 0),
    trendThreshold: Number(trendSignal.threshold || TREND_MIN_SCORE),
    longTrendFilterPass: !!trendSignal.longTrendFilterPass,
    maCross: trendSignal.maCross || "none",
    macdCross: trendSignal.macdCross || "none",
    kdjCross: trendSignal.kdjCross || "none",
    kdjK: toNumber(trendSignal.kdjK),
    kdjD: toNumber(trendSignal.kdjD),
    kdjJ: toNumber(trendSignal.kdjJ),
    bollSqueeze: !!trendSignal.bollSqueeze,
    bollBreakoutUp: !!trendSignal.bollBreakoutUp,
    bollBandwidthNow: toNumber(trendSignal.bollBandwidthNow),
    priceDepartureMa20Pct: toNumber(trendSignal.priceDepartureMa20Pct),
    trendStrengthScore: Number(trendSignal.trendStrengthScore || 0),
    trendStrengthLevel: trendSignal.trendStrengthLevel || "flat",
    sidewaysRiskHigh: !!trendSignal.lowVolumeSidewaysRisk,
    tripleGoldenBreakout: !!trendSignal.tripleGoldenBreakout,
    neutralFocusNotes: Array.isArray(trendSignal.neutralFocusNotes) ? trendSignal.neutralFocusNotes : [],
    ma120: toNumber(trendSignal.ma120),
    ma250: toNumber(trendSignal.ma250),
    ma120Slope: toNumber(trendSignal.ma120Slope),
    ma250Slope: toNumber(trendSignal.ma250Slope),
    bottomPatternScore: Number(trendSignal.bottomPatternScore || 0),
    patternDoubleBottomScore: Number(trendSignal.patternDoubleBottomScore || 0),
    patternRoundBottomScore: Number(trendSignal.patternRoundBottomScore || 0),
    patternVBottomFlag: !!trendSignal.patternVBottomFlag,
    macdBullishDivergenceFlag: !!trendSignal.macdBullishDivergenceFlag,
    weeklyTrendConfirmScore: Number(trendSignal.weeklyTrendConfirmScore || 0),
    valueFlags: valueSignal.flags || [],
    valueCoverageScore10: toNumber(snapshot?.valueCoverage?.normalizedScore10),
    valueCoveragePassCount: Number(snapshot?.valueCoverage?.passCount || 0),
    valueCoverageAvailableCount: Number(snapshot?.valueCoverage?.availableCount || 0),
    sectorTrendScore: Number(opportunity?.sector?.score || 0),
    sectorTrendLevel: opportunity?.sector?.level || "neutral",
    sectorTrendFlags: opportunity?.sector?.flags || [],
    fundamentalStrengthScore: Number(opportunity?.fundamental?.score || 0),
    fundamentalStrengthLevel: opportunity?.fundamental?.level || "medium",
    opportunityType: opportunity.type,
    sectorResonance: opportunity.sectorResonance || "none",
    positionGuidance: opportunity.positionGuidance || "",
    trendRuleVersion: trendSignal.ruleVersion || "trend_v1",
    valueRuleVersion: valueSignal.ruleVersion || "value_v1",
    sectorRuleVersion: opportunity?.sector?.ruleVersion || "sector_trend_v1",
    fundamentalRuleVersion: opportunity?.fundamental?.ruleVersion || "fundamental_strength_v1",
    opportunityRuleVersion: opportunity?.ruleVersion || "opportunity_quadrant_v1",
    ruleVersion: "buy_or_v3",
  };
}

function ensureResultSignal(result) {
  if (!result || typeof result !== "object") return result;
  if (result.signal && typeof result.signal === "object") return result;
  const snapshot = result.snapshot || {};
  return {
    ...result,
    signal: deriveBuySignal(snapshot),
  };
}

function buildPrefetchAnalysisSummary(snapshot, signal, researchMaterials = null) {
  const stockLabel = `${snapshot?.name || "个股"}(${snapshot?.symbol || "UNKNOWN"})`;
  const trendScore = Number(signal?.trendScore || 0);
  const trendThreshold = Number(signal?.trendThreshold || TREND_MIN_SCORE);
  const valueScore = signal?.valueCoverageScore10;
  const sectorLevel = String(signal?.sectorTrendLevel || "neutral");
  const triggered = signal?.triggered ? "是" : "否";
  const trendTriggered = signal?.trendTriggered ? "是" : "否";
  const valueTriggered = signal?.valueTriggered ? "是" : "否";
  const marketBias = snapshot?.market?.bias || "neutral";
  const close = snapshot?.quote?.current ?? "N/A";
  const neutralFocus = Array.isArray(signal?.neutralFocusNotes)
    ? signal.neutralFocusNotes.join("；")
    : "";
  const materials = compactResearchMaterials(researchMaterials);
  const materialStatus =
    Number(materials.total || 0) > 0
      ? `已检索材料: ${materials.total} 份（来源URL已缓存）`
      : "外部材料检索: 未执行";

  const sectorResonance = String(signal?.sectorResonance || "none");
  const positionGuidance = String(signal?.positionGuidance || "");
  const payoutRatio = snapshot?.valuation?.payoutRatio;
  const inventoryTurnover = snapshot?.balanceSheet?.inventoryTurnover;
  const dso = snapshot?.balanceSheet?.dso;

  return [
    "【分析摘要】",
    `标的: ${stockLabel}`,
    materialStatus,
    `现价: ${close}`,
    `市场环境: ${marketBias}`,
    `趋势评分: ${trendScore}/${trendThreshold}`,
    `价值覆盖评分(10分): ${valueScore ?? "N/A"}`,
    `板块趋势等级: ${sectorLevel}`,
    `板块共振: ${sectorResonance}`,
    positionGuidance ? `仓位建议: ${positionGuidance}` : "",
    payoutRatio != null ? `股息支付率: ${payoutRatio}%` : "",
    inventoryTurnover != null ? `存货周转率: ${inventoryTurnover}` : "",
    dso != null ? `DSO: ${dso}天` : "",
    neutralFocus ? `中性观察要点: ${neutralFocus}` : "",
    `信号触发: ${triggered} (趋势触发=${trendTriggered}, 价值触发=${valueTriggered})`,
  ].filter(Boolean).join("\n");
}

function buildMemoryEntry(result, meta = {}) {
  const eventAt = Number(meta?.eventAt || Date.now());
  const fetchedAt = Number(result?.fetchedAt || eventAt);
  const dateKey = dateKeyFromTimestamp(eventAt);
  const snapshot = result?.snapshot || {};
  const signal = deriveBuySignal(snapshot);
  const researchMaterials = compactResearchMaterials(result?.researchMaterials);
  const source = meta?.source === "prefetch" ? "prefetch" : "interactive";
  const dedupeKey = `${result.symbol}_${dateKey}_${source}`;

  return {
    id: dedupeKey,
    dedupeKey,
    dateKey,
    fetchedAt: eventAt,
    snapshotFetchedAt: fetchedAt,
    source,
    symbol: result.symbol,
    name: result.name,
    close: toNumber(snapshot?.quote?.current),
    trendBias: snapshot?.trend?.trendBias || "unknown",
    ma20: toNumber(snapshot?.trend?.ma20),
    ma60: toNumber(snapshot?.trend?.ma60),
    rsi14: toNumber(snapshot?.trend?.rsi14),
    macdHist: toNumber(snapshot?.trend?.macd?.hist),
    volumeRatio5_20: toNumber(snapshot?.trend?.volumeRatio5_20),
    researchMaterialCount: Number(researchMaterials.total || 0),
    researchMaterialUsedCount: Number(researchMaterials.usedCount || 0),
    signal,
    analysisSummary: String(result.analysis || "").slice(0, 600),
  };
}

function pruneMemoryEntries(entries) {
  const now = Date.now();
  const minTs = now - MEMORY_KEEP_DAYS * 24 * 60 * 60 * 1000;
  const map = new Map();

  for (const entry of entries) {
    if (!entry || !entry.symbol || !entry.dateKey) continue;
    if (Number(entry.fetchedAt || 0) < minTs) continue;
    const dedupeId = entry.dedupeKey || entry.id;
    if (!dedupeId) continue;

    const existing = map.get(dedupeId);
    if (!existing || Number(entry.fetchedAt || 0) > Number(existing.fetchedAt || 0)) {
      map.set(dedupeId, entry);
    }
  }

  return Array.from(map.values())
    .sort((a, b) => Number(b.fetchedAt || 0) - Number(a.fetchedAt || 0))
    .slice(0, MEMORY_MAX_ENTRIES);
}

async function saveMemoryEntry(result, meta = {}) {
  const entry = buildMemoryEntry(result, meta);
  await idbPut(MEMORY_ENTRY_STORE_NAME, entry);
  memoryWriteSincePrune += 1;
  const now = Date.now();
  if (memoryWriteSincePrune >= 20 || now - lastMemoryPruneAt > 60 * 1000) {
    await pruneMemoryStore();
    memoryWriteSincePrune = 0;
    lastMemoryPruneAt = now;
  }
}

function summarizeMemory(entries) {
  const symbols = new Set();
  const prefetchSymbols = new Set();
  const interactiveSymbols = new Set();
  let signalCount = 0;
  let latestDate = null;
  let interactiveCount = 0;
  let prefetchCount = 0;

  for (const entry of entries) {
    symbols.add(entry.symbol);
    if (entry?.signal?.triggered) signalCount += 1;
    if (entry?.source === "prefetch") {
      prefetchCount += 1;
      prefetchSymbols.add(entry.symbol);
    } else {
      interactiveCount += 1;
      interactiveSymbols.add(entry.symbol);
    }
    if (!latestDate || entry.dateKey > latestDate) {
      latestDate = entry.dateKey;
    }
  }

  return {
    totalEntries: entries.length,
    totalSymbols: symbols.size,
    signalCount,
    latestDate,
    interactiveCount,
    prefetchCount,
    prefetchSymbols: prefetchSymbols.size,
    interactiveSymbols: interactiveSymbols.size,
  };
}

async function countAnalysisCacheEntries() {
  await evictExpiredCache();
  return idbCount(CACHE_STORE_NAME);
}

function listTriggeredBuyStocks(entries) {
  const map = new Map();

  for (const entry of entries) {
    if (!entry?.signal?.triggered) continue;
    const symbol = String(entry.symbol || "").trim();
    if (!symbol) continue;

    const existing = map.get(symbol) || {
      symbol,
      name: entry.name || symbol,
      triggerCount: 0,
      trendTriggerCount: 0,
      valueTriggerCount: 0,
      latestDate: entry.dateKey || null,
      latestTs: Number(entry.fetchedAt || 0),
      prefetchCount: 0,
      interactiveCount: 0,
    };

    existing.triggerCount += 1;
    const signal = entry?.signal || {};
    const hasNewSplit =
      typeof signal.trendTriggered === "boolean" || typeof signal.valueTriggered === "boolean";
    const trendTriggered = hasNewSplit
      ? !!signal.trendTriggered
      : !!(
          Array.isArray(signal.flags) &&
          signal.flags.length &&
          String(signal.ruleVersion || "").startsWith("trend_")
        );
    const valueTriggered = hasNewSplit ? !!signal.valueTriggered : false;
    const legacyTriggeredWithoutSplit =
      !!signal.triggered && !trendTriggered && !valueTriggered;
    const finalTrendTriggered = trendTriggered || legacyTriggeredWithoutSplit;
    if (finalTrendTriggered) existing.trendTriggerCount += 1;
    if (valueTriggered) existing.valueTriggerCount += 1;
    if (entry?.source === "prefetch") existing.prefetchCount += 1;
    else existing.interactiveCount += 1;

    const ts = Number(entry.fetchedAt || 0);
    const dateKey = entry.dateKey || null;
    if (ts > existing.latestTs) {
      existing.latestTs = ts;
      existing.latestDate = dateKey;
      if (entry.name) existing.name = entry.name;
    }

    map.set(symbol, existing);
  }

  return Array.from(map.values())
    .sort((a, b) => {
      if (b.triggerCount !== a.triggerCount) return b.triggerCount - a.triggerCount;
      return Number(b.latestTs || 0) - Number(a.latestTs || 0);
    })
    .map((item) => ({
      symbol: item.symbol,
      name: item.name,
      triggerCount: item.triggerCount,
      trendTriggerCount: item.trendTriggerCount,
      valueTriggerCount: item.valueTriggerCount,
      latestDate: item.latestDate,
      prefetchCount: item.prefetchCount,
      interactiveCount: item.interactiveCount,
    }));
}

function normalizeKlineTimeline(klinePayload) {
  return normalizeKlineRows(klinePayload)
    .map((row) => {
      const close = toNumber(row.close ?? row.current ?? row.price);
      const rawTs = toNumber(row.timestamp ?? row.time ?? row.ts);
      const dateKey = timestampToDateKeyFromMs(rawTs);
      if (close === null || !dateKey) return null;
      return {
        dateKey,
        dateNum: parseDateKeyToNumber(dateKey),
        close,
      };
    })
    .filter(Boolean);
}

function findEntryIndexOnOrBeforeDate(series, dateNum) {
  if (!Array.isArray(series) || !series.length || !Number.isFinite(dateNum)) return -1;
  let idx = -1;
  for (let i = 0; i < series.length; i += 1) {
    if (series[i].dateNum <= dateNum) idx = i;
    else break;
  }
  return idx;
}

function buildBacktestPrompt(report) {
  const lines = [
    `记忆样本数: ${report.memorySummary.totalEntries}`,
    `覆盖股票数: ${report.memorySummary.totalSymbols}`,
    `触发买点样本数: ${report.signalEntries}`,
    `回测有效样本数: ${report.evaluatedEntries}`,
    `回测范围: 最近 ${report.lookbackDays} 天`,
  ];

  for (const w of BACKTEST_WINDOWS) {
    const bucket = report.byWindow[String(w)] || {};
    lines.push(
      `T+${w}: 样本${bucket.samples || 0} 命中${bucket.hits || 0} 命中率${bucket.hitRate || "0.00%"} 平均收益${bucket.avgReturnPct || "0.00%"}`
    );
  }

  if (Array.isArray(report.topSymbols) && report.topSymbols.length) {
    lines.push("股票维度样本（按触发次数排序）:");
    for (const item of report.topSymbols.slice(0, 10)) {
      lines.push(
        `${item.symbol}: 触发${item.signals}次, T+10命中率${item.t10HitRate}, T+10均收益${item.t10AvgReturnPct}`
      );
    }
  }

  return (
    "你是量化复盘助手。基于下列回测指标给出本周末复盘：\n" +
    lines.join("\n") +
    "\n\n请按结构输出：\n【策略有效性】\n【最值得跟踪的信号】\n【下周执行建议】\n【风险与改进】"
  );
}

async function runWeekendBacktest({ lookbackDays = 30, withAiSummary = true } = {}) {
  const days = Math.max(7, Number(lookbackDays) || 30);
  const now = Date.now();
  const minTs = now - days * 24 * 60 * 60 * 1000;
  const store = await readMemoryStore();
  const allEntries = pruneMemoryEntries(store.entries);
  const recentEntries = allEntries.filter((item) => Number(item.fetchedAt || 0) >= minTs);
  const signalEntries = recentEntries.filter((item) => item?.signal?.triggered);

  const perSymbol = new Map();
  for (const entry of signalEntries) {
    if (!perSymbol.has(entry.symbol)) perSymbol.set(entry.symbol, []);
    perSymbol.get(entry.symbol).push(entry);
  }

  const symbolList = Array.from(perSymbol.keys());
  const config = await getConfig();
  const client = new XueqiuApiClient(config);
  const byWindowRaw = {};
  BACKTEST_WINDOWS.forEach((w) => {
    byWindowRaw[w] = { samples: 0, hits: 0, returnSum: 0 };
  });
  const symbolStats = {};

  for (const symbol of symbolList) {
    const kline = await client.request("/stock/chart/kline.json", {
      symbol,
      begin: Date.now(),
      period: "day",
      type: "before",
      count: -400,
      indicator: "kline",
    });
    const timeline = normalizeKlineTimeline(kline);
    if (!timeline.length) continue;
    const entries = perSymbol.get(symbol);
    for (const memory of entries) {
      const baseDateNum = parseDateKeyToNumber(memory.dateKey);
      const baseIdx = findEntryIndexOnOrBeforeDate(timeline, baseDateNum);
      if (baseIdx < 0) continue;
      const baseClose = timeline[baseIdx].close;
      if (baseClose === null || baseClose === 0) continue;

      if (!symbolStats[symbol]) {
        symbolStats[symbol] = { signals: 0, t10Samples: 0, t10Hits: 0, t10ReturnSum: 0 };
      }
      symbolStats[symbol].signals += 1;

      for (const w of BACKTEST_WINDOWS) {
        const futureIdx = baseIdx + w;
        if (futureIdx >= timeline.length) continue;
        const futureClose = timeline[futureIdx].close;
        if (futureClose === null) continue;
        const ret = (futureClose - baseClose) / baseClose;
        byWindowRaw[w].samples += 1;
        byWindowRaw[w].returnSum += ret;
        if (ret > 0) byWindowRaw[w].hits += 1;

        if (w === 10) {
          symbolStats[symbol].t10Samples += 1;
          symbolStats[symbol].t10ReturnSum += ret;
          if (ret > 0) symbolStats[symbol].t10Hits += 1;
        }
      }
    }
  }

  const byWindow = {};
  let evaluatedEntries = 0;
  for (const w of BACKTEST_WINDOWS) {
    const bucket = byWindowRaw[w];
    if (bucket.samples > evaluatedEntries) evaluatedEntries = bucket.samples;
    const hitRate = bucket.samples ? bucket.hits / bucket.samples : 0;
    const avgRet = bucket.samples ? bucket.returnSum / bucket.samples : 0;
    byWindow[String(w)] = {
      samples: bucket.samples,
      hits: bucket.hits,
      hitRate: `${(hitRate * 100).toFixed(2)}%`,
      avgReturnPct: `${(avgRet * 100).toFixed(2)}%`,
    };
  }

  const topSymbols = Object.entries(symbolStats)
    .map(([symbol, stat]) => {
      const avg = stat.t10Samples ? stat.t10ReturnSum / stat.t10Samples : 0;
      const hit = stat.t10Samples ? stat.t10Hits / stat.t10Samples : 0;
      return {
        symbol,
        signals: stat.signals,
        t10HitRate: `${(hit * 100).toFixed(2)}%`,
        t10AvgReturnPct: `${(avg * 100).toFixed(2)}%`,
      };
    })
    .sort((a, b) => b.signals - a.signals);

  const report = {
    generatedAt: Date.now(),
    lookbackDays: days,
    memorySummary: summarizeMemory(allEntries),
    signalEntries: signalEntries.length,
    evaluatedEntries,
    byWindow,
    topSymbols,
    aiSummary: "",
  };

  if (withAiSummary && signalEntries.length > 0) {
    try {
      const prompt = buildBacktestPrompt(report);
      report.aiSummary = await callOpenAICompatible(
        prompt,
        config
      );
    } catch (error) {
      report.aiSummary = `AI复盘生成失败：${error.message || String(error)}`;
    }
  }

  return report;
}

function hasUsableBundleData(data) {
  return !!(data?.realtime || data?.detail || data?.indicator || data?.kline);
}

async function analyzeSymbol(symbol, forceRefresh = false, prefetchedBundle = null, meta = {}) {
  const config = await getConfig();
  const source = meta?.source === "prefetch" ? "prefetch" : "interactive";
  const eventAt = Number(meta?.eventAt || Date.now());
  const skipLlm = meta?.skipLlm === true || source === "prefetch";
  const materialSearch = meta?.materialSearch === true;
  const skipMaterialSearch = source === "prefetch" || !materialSearch;

  const loadResearchMaterials = async (snapshot, needAiRead) => {
    if (skipMaterialSearch) {
      return createEmptyResearchMaterials({ reason: materialSearch ? "prefetch_skip_search" : "await_ai_button" });
    }
    let materials;
    try {
      materials = await collectResearchMaterialsByModelWebSearch(snapshot, config);
      if (!hasUsableResearchMaterials(materials)) {
        materials = await collectResearchMaterials(snapshot, {
          queryLimit: MATERIAL_SEARCH_QUERY_LIMIT,
          resultPerQuery: MATERIAL_RESULTS_PER_QUERY,
          topN: MATERIAL_TOP_N,
          deepRead: true,
        });
      }
    } catch (error) {
      try {
        materials = await collectResearchMaterials(snapshot, {
          queryLimit: MATERIAL_SEARCH_QUERY_LIMIT,
          resultPerQuery: MATERIAL_RESULTS_PER_QUERY,
          topN: MATERIAL_TOP_N,
          deepRead: true,
        });
      } catch (fallbackError) {
        materials = createEmptyResearchMaterials({
          reason: "search_failed",
          searchErrors: {
            model_web_search: truncateText(error?.message || String(error), 180),
            local_search: truncateText(fallbackError?.message || String(fallbackError), 180),
          },
        });
      }
    }
    if (needAiRead && hasUsableResearchMaterials(materials)) {
      materials = await enrichMaterialsWithAiRead(materials, snapshot, config, {
        concurrency: MATERIAL_READ_CONCURRENCY,
      });
    }
    return compactResearchMaterials(materials);
  };

  if (!forceRefresh) {
    const cached = await readCache(symbol);
    if (cached) {
      const enrichedCached = ensureResultSignal(cached);

      // 缓存直接命中，回填估值表（兼容旧缓存）
      if (!enrichedCached.valuationTables && enrichedCached.snapshot) {
        enrichedCached.valuationTables = {
          dcf: computeDcfValuation(enrichedCached.snapshot),
          relative: computeRelativeValuation(enrichedCached.snapshot),
          multiModel: computeMultiModelValuation(enrichedCached.snapshot),
          asset: computeAssetValuation(enrichedCached.snapshot),
        };
      }
      await saveMemoryEntry(enrichedCached, { source, eventAt });
      return enrichedCached;
    }
  }

  let bundle = prefetchedBundle;
  if (!bundle || !hasUsableBundleData(bundle.data)) {
    const client = new XueqiuApiClient(config);
    bundle = await client.getAnalysisBundle(symbol);
  }

  if (!bundle.data.realtime && !bundle.data.detail && !bundle.data.indicator && !bundle.data.kline) {
    const detail = bundle.errors ? ` 失败详情: ${JSON.stringify(bundle.errors)}` : "";
    throw new Error(`无法获取雪球数据，请确认已登录雪球并刷新页面后重试。${detail}`);
  }

  const snapshot = normalizeSnapshot(symbol, bundle.data);
  const signal = deriveBuySignal(snapshot);

  // 估值计算（本地，始终执行，不依赖LLM）
  const valuationTables = {
    dcf: computeDcfValuation(snapshot),
    relative: computeRelativeValuation(snapshot),
    multiModel: computeMultiModelValuation(snapshot),
    asset: computeAssetValuation(snapshot),
  };

  let researchMaterials;
  try {
    researchMaterials = await loadResearchMaterials(snapshot, false);
  } catch (materialError) {
    researchMaterials = createEmptyResearchMaterials({
      reason: "material_search_failed",
      searchErrors: { detail: truncateText(materialError?.message || String(materialError), 180) },
    });
  }
  const analysis = buildPrefetchAnalysisSummary(snapshot, signal, researchMaterials);
  const valuationSummary = buildValuationSummary(snapshot, valuationTables);
  const llmPending = false;

  const result = {
    fetchedAt: Date.now(),
    symbol,
    name: snapshot.name,
    snapshot,
    signal,
    valuationTables,
    valuationSummary,
    analysis,
    researchMaterials,
    analysisMode: ANALYSIS_MODE_MATERIAL,
    sourceErrors: bundle.errors,
  };

  await writeCache(symbol, result, config.cacheTtlMs || CACHE_TTL_MS);
  await saveMemoryEntry(result, { source, eventAt });
  return result;
}

async function prefetchSymbolsInBackground(symbols = [], options = {}) {
  const maxSymbols = Math.max(1, Number(options.maxSymbols) || PREFETCH_MAX_SYMBOLS);
  const concurrency = Math.max(1, Number(options.concurrency) || PREFETCH_CONCURRENCY);

  const normalized = Array.from(
    new Set(
      (Array.isArray(symbols) ? symbols : [])
        .map((item) => normalizeSymbol(item))
        .filter(Boolean)
    )
  ).slice(0, maxSymbols);

  if (!normalized.length) {
    return { requested: 0, queued: 0, processed: 0, cachedHits: 0, generated: 0, failed: 0, errors: {} };
  }

  let cursor = 0;
  let processed = 0;
  let cachedHits = 0;
  let generated = 0;
  let failed = 0;
  const errors = {};

  async function worker() {
    while (cursor < normalized.length) {
      const index = cursor;
      cursor += 1;
      const symbol = normalized[index];
      try {
        const cached = await readCache(symbol);
        await analyzeSymbol(symbol, false, null, {
          source: "prefetch",
          eventAt: Date.now(),
          skipLlm: true,
        });
        if (cached) cachedHits += 1;
        else generated += 1;
        processed += 1;
      } catch (error) {
        failed += 1;
        processed += 1;
        errors[symbol] = error?.message || String(error);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, normalized.length) }, () => worker());
  await Promise.all(workers);

  return {
    requested: Array.isArray(symbols) ? symbols.length : 0,
    queued: normalized.length,
    processed,
    cachedHits,
    generated,
    failed,
    errors,
  };
}

cleanupLegacyStorageIfNeeded();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "refreshTokens") {
    (async () => {
      try {
        const tokens = await getXueqiuTokensFromCookies();
        sendResponse({ ok: true, tokens });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "getStockAnalysis") {
    (async () => {
      try {
        const symbol = normalizeSymbol(message.symbol);
        if (!symbol) {
          throw new Error("未识别到股票代码");
        }

        const prefetchedBundle =
          message.prefetchedBundle && typeof message.prefetchedBundle === "object"
            ? message.prefetchedBundle
            : null;

        const result = await analyzeSymbol(symbol, !!message.forceRefresh, prefetchedBundle, {
          source: "interactive",
          eventAt: Date.now(),
          skipLlm: message.skipLlm === true,
          materialSearch: message.materialSearch === true,
        });
        sendResponse({ ok: true, data: result });
      } catch (error) {
        console.error("分析失败:", error);
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();

    return true;
  }

  if (message?.type === "prefetchStockAnalyses") {
    (async () => {
      try {
        const stats = await prefetchSymbolsInBackground(message.symbols, {
          maxSymbols: message.maxSymbols,
          concurrency: message.concurrency,
        });
        sendResponse({ ok: true, data: stats });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "chatWithStockAssistant") {
    (async () => {
      try {
        const userMessage = String(message.userMessage || "").trim();
        if (!userMessage) {
          throw new Error("请输入对话内容");
        }

        const config = await getConfig();
        const messages = buildStockChatMessages({
          userMessage,
          history: message.history,
          context: message.context,
        });
        const meta = await callOpenAICompatibleMessagesWithMeta(messages, config, {
          temperature: 0.3,
          maxTokens: 1000,
        });
        sendResponse({ ok: true, data: { answer: meta.content, usedProvider: meta.provider } });
      } catch (error) {
        console.error("对话失败:", error);
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "getValuationSummaryLLM") {
    (async () => {
      try {
        const snapshot = message.snapshot;
        const valuationTables = message.valuationTables;
        const ruleSummary = message.ruleSummary || "";
        if (!snapshot || !valuationTables) {
          throw new Error("缺少估值数据");
        }
        const config = await getConfig();
        const messages = buildValuationSummaryMessages(snapshot, valuationTables, ruleSummary);
        const meta = await callOpenAICompatibleMessagesWithMeta(messages, config, {
          temperature: 0.3,
          maxTokens: 800,
        });
        sendResponse({ ok: true, data: { summary: meta.content, usedProvider: meta.provider } });
      } catch (error) {
        console.error("估值汇总LLM失败:", error);
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "getIndustryComparison") {
    (async () => {
      try {
        const currentSymbol = normalizeSymbol(message.currentSymbol || "");
        if (!currentSymbol) {
          throw new Error("缺少股票代码");
        }
        const allCache = await idbGetAll(CACHE_STORE_NAME);
        const comparisonData = buildIndustryComparison(allCache, currentSymbol);
        if (!comparisonData.stockData.length) {
          sendResponse({
            ok: true,
            data: {
              comparisonData,
              aiAnalysis: "当前缓存中无同行业股票数据。请点击面板“预分”按钮，系统会自动翻页预分析并缓存。",
            },
          });
          return;
        }
        let aiAnalysis = "";
        let usedProvider = null;
        try {
          const config = await getConfig();
          const messages = buildIndustryComparisonMessages(comparisonData);
          const meta = await callOpenAICompatibleMessagesWithMeta(messages, config, {
            temperature: 0.3,
            maxTokens: 1000,
          });
          aiAnalysis = meta.content;
          usedProvider = meta.provider;
        } catch (llmError) {
          console.error("行业对比LLM失败:", llmError);
          aiAnalysis = "AI分析生成失败（" + (llmError.message || String(llmError)) + "）。请检查LLM配置。";
        }
        sendResponse({ ok: true, data: { comparisonData, aiAnalysis, usedProvider } });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "testTdxConnection") {
    (async () => {
      try {
        const config = await getConfig();
        const symbol = normalizeSymbol(message.symbol || "SH600000") || "SH600000";
        const result = await fetchTdxSnapshot(config, symbol);
        if (!result.data) {
          throw new Error(result.error || "TDX无响应");
        }
        const normalized = normalizeTdxSnapshot(result.data);
        sendResponse({
          ok: true,
          data: {
            symbol,
            connected: true,
            normalized,
          },
        });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "getMemoryStats") {
    (async () => {
      try {
        const store = await readMemoryStore();
        const entries = pruneMemoryEntries(store.entries);
        const summary = summarizeMemory(entries);
        const cacheEntries = await countAnalysisCacheEntries();
        sendResponse({
          ok: true,
          data: {
            ...summary,
            cacheEntries,
          },
        });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "getTriggeredBuyList") {
    (async () => {
      try {
        const store = await readMemoryStore();
        const entries = pruneMemoryEntries(store.entries);
        const items = listTriggeredBuyStocks(entries);
        sendResponse({
          ok: true,
          data: {
            total: items.length,
            items,
          },
        });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "runWeekendBacktest") {
    (async () => {
      try {
        const report = await runWeekendBacktest({
          lookbackDays: message.lookbackDays,
          withAiSummary: message.withAiSummary !== false,
        });
        sendResponse({ ok: true, data: report });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "clearMemoryStore") {
    (async () => {
      try {
        await idbClear(MEMORY_ENTRY_STORE_NAME);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "exportMemory") {
    (async () => {
      try {
        const store = await readMemoryStore();
        sendResponse({ ok: true, data: store });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "importMemory") {
    (async () => {
      try {
        const incoming = message.data;
        if (!incoming || !Array.isArray(incoming.entries)) {
          sendResponse({ ok: false, error: "无效的记忆数据格式" });
          return;
        }
        const store = await readMemoryStore();
        const merged = pruneMemoryEntries([...incoming.entries, ...store.entries]);
        await idbClear(MEMORY_ENTRY_STORE_NAME);
        for (const entry of merged) {
          await idbPut(MEMORY_ENTRY_STORE_NAME, entry);
        }
        memoryWriteSincePrune = 0;
        lastMemoryPruneAt = Date.now();
        sendResponse({ ok: true, count: merged.length });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  /* ===== 🎯 投研看板数据聚合 ===== */
  if (message?.type === "getDashboardData") {
    (async () => {
      try {
        const cacheEntries = await idbGetAll(CACHE_STORE_NAME) || [];

        const stocks = [];
        const seenSymbols = new Set();

        for (const entry of cacheEntries) {
          if (!entry?.symbol || !entry?.value?.snapshot) continue;
          if (seenSymbols.has(entry.symbol)) continue;
          seenSymbols.add(entry.symbol);

          const s = entry.value.snapshot;
          const v = entry.value;
          const sig = v.signal || {};
          const val = s.valuation || {};
          const prof = s.profitability || {};
          const bs = s.balanceSheet || {};
          const cf = s.cashFlow || {};
          const qual = s.quality || {};
          const sector = s.sectorTrend || {};
          const vc = s.valueCoverage || {};

          const market = s.market || {};
          const trend = s.trend || {};

          const roeScore = prof.roe >= 20 ? 10 : prof.roe >= 15 ? 7 : prof.roe >= 10 ? 4 : prof.roe >= 5 ? 2 : 0;
          const peScore = val.peTtm > 0 && val.peTtm < 10 ? 10 : val.peTtm < 15 ? 8 : val.peTtm < 25 ? 6 : val.peTtm < 40 ? 4 : 2;
          const debtScore = bs.debtAssetRatio < 30 ? 5 : bs.debtAssetRatio < 50 ? 4 : bs.debtAssetRatio < 65 ? 3 : 2;
          const fScore = qual.piotroskiFScore >= 7 ? 5 : qual.piotroskiFScore >= 5 ? 3 : 0;
          const healthScore = Math.min(10, Math.round((debtScore + fScore) * 10 / 9 * 10) / 10);
          const cashScore = cf.fcfYield >= 5 ? 8 : cf.fcfYield >= 2 ? 6 : cf.fcfYield >= 0 ? 4 : 0;
          const growthScore = Math.min(10,
            (prof.netProfitGrowth >= 15 ? 5 : prof.netProfitGrowth >= 5 ? 3 : 0) +
            (prof.revenueCagr3y >= 10 ? 5 : prof.revenueCagr3y >= 5 ? 3 : 0)
          );
          const yieldScore = val.dividendYield >= 4 ? 10 : val.dividendYield >= 3 ? 7 : val.dividendYield >= 2 ? 5 : val.dividendYield >= 1 ? 3 : 0;
          const totalScore = Math.round((roeScore + peScore + healthScore + cashScore + growthScore + yieldScore) / 6 * 10) / 10;

          // ===== 好未来三维评分 =====
          const _macroScore = (() => {
            let s2 = 5;
            const bias = String(market.bias || 'neutral');
            if (bias === 'supportive') s2 += 2; else if (bias === 'risk_off') s2 -= 1.5;
            const sl = Number(sector.trend?.trendLevel) || 0;
            if (sl > 0) s2 += Math.min(1.5, sl / 50); else if (sl < 0) s2 += Math.max(-1.5, sl / 50);
            return Math.max(0, Math.min(10, s2));
          })();
          const _industryScore = (() => {
            let s2 = 5;
            const rs = Number(sector.relativeStrength20d) || 0;
            if (rs > 5) s2 += 2; else if (rs > 0) s2 += 1; else if (rs < -5) s2 -= 1.5; else if (rs < 0) s2 -= 0.5;
            const rc = Number(prof.revenueCagr3y) || 0;
            if (rc > 20) s2 += 2; else if (rc > 10) s2 += 1.5; else if (rc > 5) s2 += 0.5; else if (rc < 0) s2 -= 1;
            const or = Number(s.business?.overseasOrNewRevenueRatio) || 0;
            if (or > 30) s2 += 1.5; else if (or > 15) s2 += 0.8; else if (or > 5) s2 += 0.3;
            return Math.max(0, Math.min(10, s2));
          })();
          const _momentumScore = (() => {
            let s2 = 5;
            const ng = Number(prof.netProfitGrowth) || 0;
            if (ng > 30) s2 += 2; else if (ng > 15) s2 += 1.5; else if (ng > 5) s2 += 0.5; else if (ng < -10) s2 -= 1.5; else if (ng < 0) s2 -= 0.5;
            const fy = Number(cf.fcfYield) || 0;
            if (fy > 5) s2 += 1.5; else if (fy > 2) s2 += 0.5; else if (fy < -2) s2 -= 1;
            const pf = Number(qual.piotroskiFScore) || 0;
            if (pf >= 7) s2 += 1.5; else if (pf >= 5) s2 += 0.5; else if (pf < 3) s2 -= 1;
            const ts = Number(sig.trendScore) || 0;
            if (ts > 70) s2 += 1; else if (ts > 60) s2 += 0.5; else if (ts < 40) s2 -= 0.5;
            return Math.max(0, Math.min(10, s2));
          })();
          const futureScore = Math.round((_macroScore * 0.30 + _industryScore * 0.35 + _momentumScore * 0.35) * 10) / 10;

          stocks.push({
            symbol: entry.symbol,
            name: v.name || entry.symbol,
            industry: sector.industryName || null,
            roe: prof.roe,
            pe: val.peTtm,
            pb: val.pb,
            dividendYield: val.dividendYield,
            fcfYield: cf.fcfYield,
            netProfitGrowth: prof.netProfitGrowth,
            revenueCagr: prof.revenueCagr3y,
            debtAssetRatio: bs.debtAssetRatio,
            overseasRatio: Number(s.business?.overseasOrNewRevenueRatio) || null,
            piotroskiScore: qual.piotroskiFScore,
            totalScore,
            trendScore: sig.trendScore || 0,
            signalTriggered: !!(sig.triggered || sig.trendTriggered || sig.valueTriggered),
            valueCoverage: vc.passCount ? `${vc.passCount}/${vc.availableCount}` : null,
            futureScore,
            macroScore: Math.round(_macroScore * 10) / 10,
            industryScore: Math.round(_industryScore * 10) / 10,
            momentumScore: Math.round(_momentumScore * 10) / 10,
            fetchedAt: v.fetchedAt || entry.expiresAt,
          });
        }

        const industryMap = {};
        stocks.forEach(s => {
          const ind = s.industry || "未知";
          if (!industryMap[ind]) industryMap[ind] = 0;
          industryMap[ind]++;
        });
        const industries = Object.entries(industryMap).map(([name, count]) => ({ name, count }));

        const stats = {
          totalStocks: stocks.length,
          cacheEntries: cacheEntries.length,
          latestDate: stocks.length > 0
            ? new Date(Math.max(...stocks.map(s => Number(s.fetchedAt || 0)))).toISOString().slice(0, 10)
            : null,
        };

        sendResponse({ ok: true, data: { stats, stocks, industries, generatedAt: Date.now() } });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  /* ===== 🤖 AI 好未来分析 ===== */
  if (message?.type === "getFutureAnalysis") {
    (async () => {
      try {
        const symbol = String(message.symbol || "").trim();
        if (!symbol) throw new Error("缺少股票代码");

        // 从缓存读取股票完整数据
        const cached = await readCache(symbol);
        const s = cached?.snapshot;
        if (!s) throw new Error("未找到该股票的预分析数据，请先运行预分");

        const val = s.valuation || {};
        const prof = s.profitability || {};
        const cf = s.cashFlow || {};
        const sector = s.sectorTrend || {};
        const market = s.market || {};
        const qual = s.quality || {};
        const vc = s.valueCoverage || {};

        const config = await getConfig();
        const prompt = `你是一位专业投研分析师。请对以下A股标的做"好未来"分析——即未来3-5年的成长前景判断。

请从三个维度展开分析（各100-150字）：

## 1️⃣ 宏观顺风
分析该股所处的宏观经济和产业政策环境。当前市场偏向: ${String(market.bias || "neutral")}。
该股板块相对强弱(20日): ${String(sector.relativeStrength20d || "N/A")}%。

## 2️⃣ 行业空间
判断行业天花板、竞争格局和公司的行业地位。行业名称: ${String(sector.industryName || "未知")}。
板块趋势评级: ${String(sector.trend?.trendLevel || "N/A")}。
海外/新业务收入占比: ${String(s.business?.overseasOrNewRevenueRatio || "N/A")}%。

## 3️⃣ 公司动能
分析公司自身增长动能和执行力。营收CAGR(3年): ${String(prof.revenueCagr3y || "N/A")}%。
净利增速: ${String(prof.netProfitGrowth || "N/A")}%。ROE: ${String(prof.roe || "N/A")}%。
FCF Yield: ${String(cf.fcfYield || "N/A")}%。Piotroski F-Score: ${String(qual.piotroskiFScore || "N/A")}。

## 综合结论
给出该股好未来的综合判断（好/一般/差）及核心理由（100字以内）。
最后用一句话总结该股"好未来"的核心逻辑。`;

        const meta = await callOpenAICompatibleMessagesWithMeta(
          [{ role: "user", content: prompt }],
          config,
          { temperature: 0.3, maxTokens: 1200 }
        );

        sendResponse({ ok: true, data: { analysis: meta.content, usedProvider: meta.provider } });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }
});
