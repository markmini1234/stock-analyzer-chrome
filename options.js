const DEFAULTS = {
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
  autoFetchTokens: true,
  cacheTtlMs: 300000,
};
const PREFETCH_ERROR_LOG_KEY = "prefetchErrorLogsV1";

const qs = (selector) => document.querySelector(selector);

function setValue(id, value) {
  const el = qs(`#${id}`);
  if (el) el.value = value ?? "";
}

function getValue(id) {
  const el = qs(`#${id}`);
  return el ? el.value.trim() : "";
}

function stringifyModelProviders(providers) {
  if (!Array.isArray(providers)) return "";
  return providers
    .map((item) => {
      const name = String(item?.name || "").trim();
      const baseUrl = String(item?.baseUrl || item?.api_base_url || "").trim();
      const apiKey = String(item?.apiKey || item?.openai_api_key || "").trim();
      const model = String(item?.model || item?.prefer_model || "").trim();
      if (!baseUrl || !apiKey || !model) return "";
      return `${name || "provider"}|${baseUrl}|${apiKey}|${model}`;
    })
    .filter(Boolean)
    .join("\n");
}

function parseModelProviders(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (!lines.length) return [];

  const providers = [];
  const invalidLines = [];
  lines.forEach((line, idx) => {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length < 4 || !parts[1] || !parts[2] || !parts[3]) {
      invalidLines.push(idx + 1);
      return;
    }
    providers.push({
      name: parts[0] || `provider-${idx + 1}`,
      baseUrl: parts[1].replace(/\/$/, ""),
      apiKey: parts[2],
      model: parts[3],
    });
  });

  if (invalidLines.length) {
    throw new Error(`模型轮动列表格式错误，请检查第 ${invalidLines.join(", ")} 行`);
  }
  return providers;
}

function setStatus(message, color = "#475569") {
  const el = qs("#status");
  if (!el) return;
  el.textContent = message;
  el.style.color = color;
}

function setBacktestReport(text) {
  const el = qs("#backtestReport");
  if (!el) return;
  el.textContent = text || "暂无报告";
}

function getProviderSummary(rawProviders) {
  const lines = String(rawProviders || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!lines.length) return { primary: "未设置", backup: "未设置" };

  try {
    const providers = parseModelProviders(lines.join("\n"));
    const names = providers.map((item) => item.model || item.name || "未命名").filter(Boolean);
    return {
      primary: names[0] || "未设置",
      backup: names[1] || "未设置",
    };
  } catch {
    return { primary: "格式错误", backup: "请检查配置" };
  }
}

function updateQuickStatus() {
  const el = qs("#quickStatus");
  if (!el) return;
  const preferModel = getValue("prefer_model") || "未设置";
  const parsed = getProviderSummary(getValue("modelProviders"));
  const primary = parsed.primary === "未设置" ? preferModel : parsed.primary;
  const backup = parsed.backup;
  const cache = Math.max(30000, Number(getValue("cacheTtlMs") || DEFAULTS.cacheTtlMs));
  el.textContent = `当前节点: ${primary} ｜ 备用: ${backup} ｜ 缓存: ${cache}ms`;
}

function sendMessage(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve({ ok: false, error: err.message || String(err) });
        return;
      }
      resolve(res);
    });
  });
}

function collectPayload() {
  const modelProviders = parseModelProviders(getValue("modelProviders"));
  return {
    xq_a_token: getValue("xq_a_token"),
    xq_r_token: getValue("xq_r_token"),
    device_id: getValue("device_id"),
    openai_api_key: getValue("openai_api_key"),
    api_base_url: getValue("api_base_url") || DEFAULTS.api_base_url,
    prefer_model: getValue("prefer_model") || DEFAULTS.prefer_model,
    modelProviders,
    autoFetchTokens: !!qs("#autoFetchTokens")?.checked,
    cacheTtlMs: Math.max(30000, Number(getValue("cacheTtlMs") || DEFAULTS.cacheTtlMs)),
  };
}

async function loadSettings() {
  const items = await chrome.storage.local.get(DEFAULTS);
  setValue("xq_a_token", items.xq_a_token);
  setValue("xq_r_token", items.xq_r_token);
  setValue("device_id", items.device_id);
  setValue("openai_api_key", items.openai_api_key);
  setValue("api_base_url", items.api_base_url);
  setValue("prefer_model", items.prefer_model);
  setValue(
    "modelProviders",
    stringifyModelProviders(items.modelProviders || DEFAULTS.modelProviders)
  );
  setValue("cacheTtlMs", items.cacheTtlMs);
  qs("#autoFetchTokens").checked = !!items.autoFetchTokens;
  updateQuickStatus();
}

async function saveSettings() {
  const payload = collectPayload();
  await chrome.storage.local.set(payload);
  updateQuickStatus();
  setStatus("设置已保存", "#166534");
}

async function refreshTokens() {
  const button = qs("#refreshTokens");
  button.disabled = true;
  setStatus("正在读取雪球 cookies...", "#1155cc");

  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "refreshTokens" }, (res) => resolve(res));
    });

    if (!response?.ok) {
      throw new Error(response?.error || "获取失败");
    }

    const tokens = response.tokens || {};
    setValue("xq_a_token", tokens.xq_a_token || "");
    setValue("xq_r_token", tokens.xq_r_token || "");
    setValue("device_id", tokens.device_id || "");

    await saveSettings();
    setStatus(
      `Token 刷新完成：xq_a_token ${tokens.xq_a_token ? "已获取" : "未获取"}`,
      "#166534"
    );
  } catch (error) {
    setStatus(`Token 刷新失败：${error.message || String(error)}`, "#b91c1c");
  } finally {
    button.disabled = false;
  }
}

function renderBacktestReport(report) {
  const lines = [
    `生成时间: ${new Date(report.generatedAt).toLocaleString()}`,
    `回测范围: 最近 ${report.lookbackDays} 天`,
    `记忆样本: ${report.memorySummary.totalEntries} 条，覆盖股票: ${report.memorySummary.totalSymbols} 只`,
    `触发买点样本: ${report.signalEntries} 条`,
    `有效回测样本: ${report.evaluatedEntries} 条`,
    "",
    "[窗口统计]",
  ];

  const byWindow = report.byWindow || {};
  for (const w of ["5", "10", "20"]) {
    const item = byWindow[w] || {};
    lines.push(
      `T+${w}: 样本 ${item.samples || 0}，命中 ${item.hits || 0}，命中率 ${item.hitRate || "0.00%"}，平均收益 ${item.avgReturnPct || "0.00%"}`
    );
  }

  const topSymbols = Array.isArray(report.topSymbols) ? report.topSymbols : [];
  if (topSymbols.length) {
    lines.push("", "[股票维度Top]");
    topSymbols.slice(0, 8).forEach((item) => {
      lines.push(
        `${item.symbol}: 触发${item.signals}次，T+10命中率${item.t10HitRate}，T+10均收益${item.t10AvgReturnPct}`
      );
    });
  }

  if (report.aiSummary) {
    lines.push("", "[AI周末复盘]", report.aiSummary);
  }

  return lines.join("\n");
}

function renderTriggeredBuyList(payload) {
  const total = Number(payload?.total || 0);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const lines = [`触发购买股票数: ${total}`, ""];

  if (!items.length) {
    lines.push("暂无触发购买名单");
    return lines.join("\n");
  }

  lines.push("[触发购买名单]");
  items.forEach((item, idx) => {
    lines.push(
      `${idx + 1}. ${item.symbol} ${item.name || ""} | 总触发${item.triggerCount || 0}次(趋势${item.trendTriggerCount || 0}/价值${item.valueTriggerCount || 0}) | 最近${item.latestDate || "N/A"} | 预分析${item.prefetchCount || 0} 手动${item.interactiveCount || 0}`
    );
  });

  return lines.join("\n");
}

async function queryRecentErrors() {
  setStatus("正在读取最近错误...", "#1155cc");
  const items = await chrome.storage.local.get([PREFETCH_ERROR_LOG_KEY]);
  const logs = Array.isArray(items?.[PREFETCH_ERROR_LOG_KEY]) ? items[PREFETCH_ERROR_LOG_KEY] : [];
  const lines = [`最近错误条数: ${logs.length}`, ""];
  if (!logs.length) {
    lines.push("暂无错误记录");
  } else {
    lines.push("[最近错误]");
    logs.forEach((item, idx) => {
      const time = item?.ts ? new Date(item.ts).toLocaleString() : "N/A";
      const page = item?.page || "N/A";
      const msg = item?.message || "unknown_error";
      lines.push(`${idx + 1}. ${time} | ${msg}`);
      lines.push(`   页面: ${page}`);
    });
  }
  setBacktestReport(lines.join("\n"));
  setStatus("最近错误已更新", "#166534");
}

async function queryMemoryStats() {
  setStatus("正在读取记忆统计...", "#1155cc");
  const response = await sendMessage({ type: "getMemoryStats" });
  if (!response?.ok) {
    throw new Error(response?.error || "记忆统计失败");
  }
  const data = response.data || {};
  const text = [
    `记忆总条数: ${data.totalEntries || 0}`,
    `覆盖股票数: ${data.totalSymbols || 0}`,
    `分析缓存条数: ${data.cacheEntries || 0}`,
    `手动分析条数: ${data.interactiveCount || 0}`,
    `手动覆盖股票数: ${data.interactiveSymbols || 0}`,
    `预分析条数: ${data.prefetchCount || 0}`,
    `预分析覆盖股票数: ${data.prefetchSymbols || 0}`,
    `触发买点条数: ${data.signalCount || 0}`,
    `最新记录日期: ${data.latestDate || "N/A"}`,
  ].join("\n");
  setBacktestReport(text);
  setStatus("记忆统计已更新", "#166534");
}

async function runBacktest() {
  const btn = qs("#runBacktest");
  const days = Math.max(7, Number(getValue("backtestLookbackDays") || 30));
  btn.disabled = true;
  setStatus("正在生成周末回测报告...", "#1155cc");

  try {
    const response = await sendMessage({
      type: "runWeekendBacktest",
      lookbackDays: days,
      withAiSummary: true,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "回测失败");
    }
    setBacktestReport(renderBacktestReport(response.data || {}));
    setStatus("周末回测报告已生成", "#166534");
  } finally {
    btn.disabled = false;
  }
}

async function queryTriggeredBuyList() {
  setStatus("正在读取触发购买名单...", "#1155cc");
  const response = await sendMessage({ type: "getTriggeredBuyList" });
  if (!response?.ok) {
    throw new Error(
      response?.error ||
      "读取触发购买名单失败（可能是扩展未重载，后台尚未加载新接口）"
    );
  }
  setBacktestReport(renderTriggeredBuyList(response.data || {}));
  setStatus("触发购买名单已更新", "#166534");
}

async function exportMemory() {
  setStatus("正在导出记忆数据...", "#1155cc");
  const response = await sendMessage({ type: "exportMemory" });
  if (!response?.ok) {
    throw new Error(response?.error || "导出失败");
  }
  const store = response?.data;
  const data = {
    version: Number(store?.version || 1),
    updatedAt: Number(store?.updatedAt || 0),
    entries: Array.isArray(store?.entries) ? store.entries : [],
  };

  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `stock_memory_backup_${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`记忆数据已导出（${data.entries.length} 条）`, "#166534");
}

async function importMemory(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("文件解析失败，请选择有效的 JSON 备份文件");
  }
  setStatus("正在导入记忆数据...", "#1155cc");
  const response = await sendMessage({ type: "importMemory", data });
  if (!response?.ok) {
    throw new Error(response?.error || "导入失败");
  }
  setStatus(`记忆数据导入完成，当前共 ${response.count} 条`, "#166534");
}

async function clearMemory() {
  if (!window.confirm("确认清空所有短期记忆数据吗？此操作不可恢复。")) return;
  setStatus("正在清空记忆...", "#8a4b00");
  const response = await sendMessage({ type: "clearMemoryStore" });
  if (!response?.ok) {
    throw new Error(response?.error || "清空失败");
  }
  setBacktestReport("暂无报告");
  setStatus("短期记忆已清空", "#166534");
}

/* ===== 投研看板函数 ===== */
let dashData = null;

async function loadDashboard(view) {
  const container = document.getElementById("dash-container");
  if (!container) return;
  container.innerHTML = '<div class="dash-loading">正在加载投研看板数据...</div>';

  try {
    if (!dashData) {
      dashData = await fetchDashboardData();
    }
    renderDashboardView(container, dashData, view);
  } catch (error) {
    container.innerHTML = `<div class="dash-loading" style="color:var(--bad);">加载失败: ${escapeHtml(error?.message || String(error))}</div>`;
  }
}

function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmt(value, suffix = "") {
  if (value === null || value === undefined) return "N/A";
  const num = Number(value);
  if (isNaN(num)) return String(value);
  return num.toFixed(2) + suffix;
}

function scoreColor(score) {
  if (score >= 7) return "dash-score-good";
  if (score >= 4) return "dash-score-warn";
  return "dash-score-bad";
}

async function fetchDashboardData() {
  const response = await sendMessage({ type: "getDashboardData" });
  if (!response?.ok) throw new Error(response?.error || "获取看板数据失败");
  return response.data;
}

function renderDashboardView(container, data, view) {
  if (!data) {
    container.innerHTML = '<div class="dash-loading">暂无数据，请先运行全量预分析</div>';
    return;
  }

  switch (view) {
    case "overview": renderOverview(container, data); break;
    case "roe": renderRankingTable(container, data, "roe", "高ROE排行", "roe"); break;
    case "value": renderRankingTable(container, data, "value", "低估值排行", "pe"); break;
    case "dividend": renderRankingTable(container, data, "dividend", "高股息排行", "dividendYield"); break;
    case "industry": renderIndustryDistribution(container, data); break;
    case "memory": renderMemoryStats(container, data); break;
    default: renderOverview(container, data);
  }
}

function renderOverview(container, data) {
  const stats = data.stats || {};
  const stocks = data.stocks || [];

  const highRoe = stocks.filter(s => s.roe !== null && s.roe >= 15).length;
  const lowPe = stocks.filter(s => s.pe !== null && s.pe > 0 && s.pe <= 15).length;
  const highDiv = stocks.filter(s => s.dividendYield !== null && s.dividendYield >= 3).length;
  const fcfPositive = stocks.filter(s => s.fcfYield !== null && s.fcfYield > 0).length;
  const triggeredSignals = stocks.filter(s => s.signalTriggered).length;

  container.innerHTML = `
    <div class="dash-grid">
      <div class="dash-stat"><div class="dash-num">${stats.totalStocks || 0}</div><div class="dash-label">预分析覆盖股票</div></div>
      <div class="dash-stat good"><div class="dash-num">${highRoe}</div><div class="dash-label">ROE≥15% 优质股</div></div>
      <div class="dash-stat good"><div class="dash-num">${lowPe}</div><div class="dash-label">PE≤15 低估值</div></div>
      <div class="dash-stat good"><div class="dash-num">${highDiv}</div><div class="dash-label">股息率≥3%</div></div>
      <div class="dash-stat ${fcfPositive >= stats.totalStocks / 2 ? "good" : "warn"}"><div class="dash-num">${fcfPositive}</div><div class="dash-label">FCF正值</div></div>
      <div class="dash-stat ${triggeredSignals > 0 ? "good" : "warn"}"><div class="dash-num">${triggeredSignals}</div><div class="dash-label">触发买点信号</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <div>
        <div style="font-size:11px;font-weight:700;margin-bottom:4px;">🏆 综合评分 Top 10（巴菲特六维）</div>
        ${buildTop10Table(stocks, "totalScore")}
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;margin-bottom:4px;">🔄 最近触发买点</div>
        ${buildRecentSignals(stocks)}
      </div>
    </div>
  `;
}

function buildTop10Table(stocks, sortKey) {
  const sorted = [...stocks].filter(s => s[sortKey] !== null && s[sortKey] !== undefined).sort((a, b) => b[sortKey] - a[sortKey]).slice(0, 10);
  if (!sorted.length) return '<div style="color:var(--muted);font-size:11px;padding:8px;">暂无评分数据</div>';
  return `<table class="dash-table">
    <thead><tr><th>#</th><th>代码</th><th>名称</th><th>评分</th><th>ROE</th><th>PE</th></tr></thead>
    <tbody>${sorted.map((s, i) => `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(s.symbol)}</td>
      <td>${escapeHtml(s.name)}</td>
      <td class="${scoreColor(s.totalScore)}">${fmt(s.totalScore)}</td>
      <td>${fmt(s.roe, "%")}</td>
      <td>${fmt(s.pe)}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

function buildRecentSignals(stocks) {
  const triggered = stocks.filter(s => s.signalTriggered).sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0)).slice(0, 10);
  if (!triggered.length) return '<div style="color:var(--muted);font-size:11px;padding:8px;">暂无触发信号</div>';
  return `<table class="dash-table">
    <thead><tr><th>代码</th><th>名称</th><th>评分</th><th>趋势分</th><th>价值覆盖</th></tr></thead>
    <tbody>${triggered.map(s => `<tr>
      <td>${escapeHtml(s.symbol)}</td>
      <td>${escapeHtml(s.name)}</td>
      <td class="${scoreColor(s.totalScore)}">${fmt(s.totalScore)}</td>
      <td>${fmt(s.trendScore)}</td>
      <td>${s.valueCoverage || "-"}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

function renderRankingTable(container, data, rankType, title, metricKey) {
  const stocks = data.stocks || [];
  let sorted, headerCols, rowFn;

  if (rankType === "roe") {
    sorted = stocks.filter(s => s.roe !== null && s.roe !== undefined).sort((a, b) => b.roe - a.roe).slice(0, 30);
    headerCols = ["代码", "名称", "ROE", "PE", "净利增速", "营收CAGR", "资产负债率", "评分"];
    rowFn = (s) => [s.symbol, s.name, fmt(s.roe, "%"), fmt(s.pe), fmt(s.netProfitGrowth, "%"), fmt(s.revenueCagr, "%"), fmt(s.debtAssetRatio, "%"), fmt(s.totalScore)];
  } else if (rankType === "value") {
    sorted = stocks.filter(s => s.pe !== null && s.pe > 0).sort((a, b) => a.pe - b.pe).slice(0, 30);
    headerCols = ["代码", "名称", "PE", "PB", "ROE", "FCF Yield", "股息率", "评分"];
    rowFn = (s) => [s.symbol, s.name, fmt(s.pe), fmt(s.pb), fmt(s.roe, "%"), fmt(s.fcfYield, "%"), fmt(s.dividendYield, "%"), fmt(s.totalScore)];
  } else if (rankType === "dividend") {
    sorted = stocks.filter(s => s.dividendYield !== null && s.dividendYield > 0).sort((a, b) => b.dividendYield - a.dividendYield).slice(0, 30);
    headerCols = ["代码", "名称", "股息率", "PE", "ROE", "FCF Yield", "净利增速", "评分"];
    rowFn = (s) => [s.symbol, s.name, fmt(s.dividendYield, "%"), fmt(s.pe), fmt(s.roe, "%"), fmt(s.fcfYield, "%"), fmt(s.netProfitGrowth, "%"), fmt(s.totalScore)];
  }

  container.innerHTML = `
    <div style="font-size:12px;font-weight:700;margin-bottom:6px;color:var(--hero-a);">${title}（共${sorted.length}只）</div>
    <table class="dash-table">
      <thead><tr>${headerCols.map(h => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${sorted.map((s, i) => `<tr>
        ${rowFn(s).map((v, j) => {
          if (j === headerCols.length - 1) return `<td class="${scoreColor(Number(v))}">${v}</td>`;
          if (j === 2 && rankType === "roe") return `<td class="${Number(v) >= 15 ? 'dash-score-good' : Number(v) >= 10 ? 'dash-score-warn' : 'dash-score-bad'}">${v}</td>`;
          if (j === 3 && rankType === "value") return `<td class="${Number(v) <= 15 ? 'dash-score-good' : Number(v) <= 25 ? 'dash-score-warn' : 'dash-score-bad'}">${v}</td>`;
          return `<td>${v}</td>`;
        }).join("")}
      </tr>`).join("")}</tbody>
    </table>`;
}

function renderIndustryDistribution(container, data) {
  const industries = data.industries || [];
  const stocks = data.stocks || [];

  // 行业分布统计
  const industryMap = {};
  stocks.forEach(s => {
    const ind = s.industry || "未知";
    if (!industryMap[ind]) industryMap[ind] = { count: 0, avgRoe: 0, avgPe: 0, totalRoe: 0, totalPe: 0 };
    const entry = industryMap[ind];
    entry.count += 1;
    if (s.roe !== null && s.roe !== undefined) { entry.totalRoe += s.roe; }
    if (s.pe !== null && s.pe !== undefined && s.pe > 0) { entry.totalPe += s.pe; }
  });
  Object.values(industryMap).forEach(e => {
    e.avgRoe = e.totalRoe / e.count;
    e.avgPe = e.totalPe / e.count;
  });
  const sortedIndustries = Object.entries(industryMap).sort((a, b) => b[1].count - a[1].count);

  container.innerHTML = `
    <div style="font-size:12px;font-weight:700;margin-bottom:6px;color:var(--hero-a);">行业分布（${sortedIndustries.length}个行业，${stocks.length}只股票）</div>
    <table class="dash-table">
      <thead><tr><th>行业</th><th>股票数</th><th>占比</th><th>平均ROE</th><th>平均PE</th><th>分布条</th></tr></thead>
      <tbody>${sortedIndustries.map(([ind, e]) => {
        const pct = e.count / stocks.length * 100;
        return `<tr>
          <td>${escapeHtml(ind)}</td>
          <td><strong>${e.count}</strong></td>
          <td>${pct.toFixed(1)}%</td>
          <td class="${e.avgRoe >= 15 ? 'dash-score-good' : e.avgRoe >= 8 ? 'dash-score-warn' : 'dash-score-bad'}">${fmt(e.avgRoe, "%")}</td>
          <td>${fmt(e.avgPe)}</td>
          <td><div class="dash-bar-wrap"><div class="dash-bar-fill" style="width:${pct}%;background:var(--hero-a);"></div></div></td>
        </tr>`;
      }).join("")}</tbody>
    </table>`;
}

function renderMemoryStats(container, data) {
  const stats = data.stats || {};
  container.innerHTML = `
    <div class="dash-grid">
      <div class="dash-stat"><div class="dash-num">${stats.totalStocks || 0}</div><div class="dash-label">预分析覆盖股票</div></div>
      <div class="dash-stat"><div class="dash-num">${stats.totalEntries || 0}</div><div class="dash-label">记忆总条数</div></div>
      <div class="dash-stat"><div class="dash-num">${stats.cacheEntries || 0}</div><div class="dash-label">分析缓存条数</div></div>
      <div class="dash-stat"><div class="dash-num">${stats.prefetchCount || 0}</div><div class="dash-label">预分析生成条数</div></div>
      <div class="dash-stat"><div class="dash-num">${stats.interactiveCount || 0}</div><div class="dash-label">手动分析条数</div></div>
      <div class="dash-stat"><div class="dash-num">${stats.signalCount || 0}</div><div class="dash-label">触发买点条数</div></div>
    </div>
    <div style="margin-top:8px;">
      <div style="font-size:11px;font-weight:700;margin-bottom:4px;">📋 详细统计</div>
      <pre style="font-size:11px;background:#f4f9fe;padding:10px;border-radius:8px;line-height:1.6;">${JSON.stringify(stats, null, 2)}</pre>
    </div>`;
}

document.addEventListener("DOMContentLoaded", () => {
  loadSettings().catch((error) => {
    setStatus(`加载设置失败：${error.message || String(error)}`, "#b91c1c");
  });

  // 看板Tab事件
  const dashTabs = document.getElementById("dashTabs");
  if (dashTabs) {
    dashTabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".dash-tab");
      if (!btn) return;
      dashTabs.querySelectorAll(".dash-tab").forEach(t => t.classList.remove("active"));
      btn.classList.add("active");
      loadDashboard(btn.dataset.view);
    });
  }
  // 默认加载概览
  loadDashboard("overview");

  qs("#save").addEventListener("click", () => {
    saveSettings().catch((error) => {
      setStatus(`保存失败：${error.message || String(error)}`, "#b91c1c");
    });
  });

  ["prefer_model", "modelProviders", "cacheTtlMs"].forEach((id) => {
    const el = qs(`#${id}`);
    if (!el) return;
    const eventName = id === "modelProviders" ? "input" : "change";
    el.addEventListener(eventName, updateQuickStatus);
  });

  qs("#refreshTokens").addEventListener("click", () => {
    refreshTokens();
  });

  qs("#memoryStats").addEventListener("click", () => {
    queryMemoryStats().catch((error) => {
      setStatus(`记忆统计失败：${error.message || String(error)}`, "#b91c1c");
    });
  });

  qs("#runBacktest").addEventListener("click", () => {
    runBacktest().catch((error) => {
      setStatus(`回测失败：${error.message || String(error)}`, "#b91c1c");
    });
  });

  qs("#buyList").addEventListener("click", () => {
    queryTriggeredBuyList().catch((error) => {
      setStatus(`读取名单失败：${error.message || String(error)}`, "#b91c1c");
    });
  });

  qs("#recentErrors").addEventListener("click", () => {
    queryRecentErrors().catch((error) => {
      setStatus(`读取错误失败：${error.message || String(error)}`, "#b91c1c");
    });
  });

  qs("#exportMemory").addEventListener("click", () => {
    exportMemory().catch((error) => {
      setStatus(`导出失败：${error.message || String(error)}`, "#b91c1c");
    });
  });

  qs("#importMemory").addEventListener("click", () => {
    qs("#importMemoryFile").click();
  });

  qs("#importMemoryFile").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    importMemory(file).catch((error) => {
      setStatus(`导入失败：${error.message || String(error)}`, "#b91c1c");
    });
    e.target.value = "";
  });

  qs("#clearMemory").addEventListener("click", () => {
    clearMemory().catch((error) => {
      setStatus(`清空失败：${error.message || String(error)}`, "#b91c1c");
    });
  });
});
