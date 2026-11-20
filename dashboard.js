/* ===== Palantir 投研看板 - 数据引擎 ===== */
/* 本体论：股票本体 → 六维评分 → 行业板块 → 决策信号 */

(function () {
  'use strict';

  /* ---- 工具 ---- */
  function fmt(v, suffix) {
    if (v === null || v === undefined || v === 'N/A') return 'N/A';
    const n = Number(v);
    if (isNaN(n)) return String(v);
    return (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)) + (suffix || '');
  }
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function pct(v) { return v !== null && v !== undefined ? fmt(v, '%') : 'N/A'; }
  function cls(score, thrGood, thrWarn) {
    if (score === null || score === undefined) return '';
    return score >= (thrGood || 7) ? 's-good' : score >= (thrWarn || 4) ? 's-warn' : 's-bad';
  }
  function pctCls(v, goodDir) {
    if (v === null || v === undefined) return '';
    if (goodDir === 'low') return v <= 15 ? 'down' : v <= 30 ? '' : 'up';
    return v >= 15 ? 'up' : v >= 0 ? '' : 'down';
  }

  /* ---- 全局状态 ---- */
  let DASH = null;

  /* ---- 直读 IndexedDB（扩展页面同源，绕过后台） ---- */
  function idbGetAllFromPage(storeName) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('stockAnalyzerLocalDB', 1);
      req.onupgradeneeded = () => { /* 存不存在无所谓，只读 */ };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const getReq = store.getAll();
        getReq.onsuccess = () => resolve(getReq.result || []);
        getReq.onerror = () => reject(getReq.error);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }

  /* ---- 从缓存条目计算评分（与 background.js 一致） ---- */
  function calcScoreFromEntry(entry) {
    if (!entry?.value?.snapshot) return null;
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

    // ===== 好公司（巴菲特六维）=====
    const roeScore = prof.roe >= 20 ? 10 : prof.roe >= 15 ? 7 : prof.roe >= 10 ? 4 : 0;
    const peScore = val.peTtm > 0 && val.peTtm < 10 ? 10 : val.peTtm < 15 ? 8 : val.peTtm < 25 ? 6 : val.peTtm < 40 ? 4 : 2;
    const debtScore = bs.debtAssetRatio < 30 ? 5 : bs.debtAssetRatio < 50 ? 4 : bs.debtAssetRatio < 65 ? 3 : 2;
    const fScore = qual.piotroskiFScore >= 7 ? 5 : qual.piotroskiFScore >= 5 ? 3 : 0;
    const healthScore = Math.min(10, Math.round((debtScore + fScore) * 10 / 9 * 10) / 10);
    const cashScore = cf.fcfYield >= 5 ? 8 : cf.fcfYield >= 2 ? 6 : cf.fcfYield >= 0 ? 4 : 0;
    const growthScore = Math.min(10,
      (prof.netProfitGrowth >= 15 ? 5 : prof.netProfitGrowth >= 5 ? 3 : 0) +
      (prof.revenueCagr3y >= 10 ? 5 : prof.revenueCagr3y >= 5 ? 3 : 0)
    );
    const yieldScore = val.dividendYield >= 4 ? 10 : val.dividendYield >= 3 ? 7 : val.dividendYield >= 2 ? 5 : 0;
    const totalScore = Math.round((roeScore + peScore + healthScore + cashScore + growthScore + yieldScore) / 6 * 10) / 10;

    // ===== 好未来（宏观顺风 × 行业空间 × 公司动能）=====
    // 1️⃣ 宏观顺风 (30%)：市场环境 + 板块趋势
    const macroScore = (() => {
      let score = 5; // 中性基准
      // 市场偏向
      const bias = String(market.bias || 'neutral');
      if (bias === 'supportive') score += 2;
      else if (bias === 'risk_off') score -= 1.5;
      // 板块趋势强度
      const sectorLevel = Number(sector.trend?.trendLevel) || 0;
      if (sectorLevel > 0) score += Math.min(1.5, sectorLevel / 50);
      else if (sectorLevel < 0) score += Math.max(-1.5, sectorLevel / 50);
      // 周线趋势确认
      const weeklyTrend = s.weeklyTrend || {};
      const weeklyScore = Number(weeklyTrend.trendScore) || 0;
      if (weeklyScore > 0) score += Math.min(1, weeklyScore / 100);
      // 大盘趋势（通过个股趋势评分间接反映）
      const trendScore = Number(sig.trendScore) || 0;
      if (trendScore > 60) score += 0.5;
      return Math.max(0, Math.min(10, score));
    })();

    // 2️⃣ 行业空间 (35%)：行业景气度 + 成长空间
    const industryScore = (() => {
      let score = 5;
      // 行业相对强弱
      const relStr = Number(sector.relativeStrength20d) || 0;
      if (relStr > 5) score += 2;
      else if (relStr > 0) score += 1;
      else if (relStr < -5) score -= 1.5;
      else if (relStr < 0) score -= 0.5;
      // 营收增速 -> 行业空间代理
      const revGrowth = Number(prof.revenueCagr3y) || 0;
      if (revGrowth > 20) score += 2;
      else if (revGrowth > 10) score += 1.5;
      else if (revGrowth > 5) score += 0.5;
      else if (revGrowth < 0) score -= 1;
      // 全球化/新业务拓展
      const overseasRatio = Number(s.business?.overseasOrNewRevenueRatio) || 0;
      if (overseasRatio > 30) score += 1.5;
      else if (overseasRatio > 15) score += 0.8;
      else if (overseasRatio > 5) score += 0.3;
      return Math.max(0, Math.min(10, score));
    })();

    // 3️⃣ 公司动能 (35%)：自身增长动能
    const momentumScore = (() => {
      let score = 5;
      // 净利润增速
      const npGrowth = Number(prof.netProfitGrowth) || 0;
      if (npGrowth > 30) score += 2;
      else if (npGrowth > 15) score += 1.5;
      else if (npGrowth > 5) score += 0.5;
      else if (npGrowth < -10) score -= 1.5;
      else if (npGrowth < 0) score -= 0.5;
      // FCF 质量
      const fcfY = Number(cf.fcfYield) || 0;
      if (fcfY > 5) score += 1.5;
      else if (fcfY > 2) score += 0.5;
      else if (fcfY < -2) score -= 1;
      // Piotroski F-Score 趋势
      const pScore = Number(qual.piotroskiFScore) || 0;
      if (pScore >= 7) score += 1.5;
      else if (pScore >= 5) score += 0.5;
      else if (pScore < 3) score -= 1;
      // 技术动能（趋势评分）
      const tScore = Number(sig.trendScore) || 0;
      if (tScore > 70) score += 1;
      else if (tScore > 60) score += 0.5;
      else if (tScore < 40) score -= 0.5;
      return Math.max(0, Math.min(10, score));
    })();

    // 综合：好未来 = 宏观顺风(30%) + 行业空间(35%) + 公司动能(35%)
    const futureScore = Math.round((macroScore * 0.30 + industryScore * 0.35 + momentumScore * 0.35) * 10) / 10;

    // 宏观/行业/公司 三个维度的明细分（用于展示）
    const macroDetail = Math.round(macroScore * 10) / 10;
    const industryDetail = Math.round(industryScore * 10) / 10;
    const momentumDetail = Math.round(momentumScore * 10) / 10;

    return {
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
      trendScore: Number(sig.trendScore) || 0,
      signalTriggered: !!(sig.triggered || sig.trendTriggered || sig.valueTriggered),
      valueCoverage: vc.passCount ? `${vc.passCount}/${vc.availableCount}` : null,
      /* 好未来三维 */
      futureScore,
      macroScore: macroDetail,
      industryScore: industryDetail,
      momentumScore: momentumDetail,
      fetchedAt: v.fetchedAt || entry.expiresAt,
    };
  }

  /* ---- 获取预分析数据 ---- */
  async function fetchDashboardData() {
    const errors = [];

    // 方案A：chrome.runtime.sendMessage（后台活跃时最快）
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      try {
        const data = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('后台超时')), 5000);
          chrome.runtime.sendMessage({ type: 'getDashboardData' }, (res) => {
            clearTimeout(timer);
            const err = chrome.runtime.lastError;
            if (err) { reject(new Error(err.message)); return; }
            if (!res || !res.ok) reject(new Error((res && res.error) || '获取失败'));
            else resolve(res.data);
          });
        });
        return data;
      } catch (e) {
        errors.push('sendMessage: ' + e.message);
      }
    }

    // 方案B：从 IndexedDB 直接读（扩展页面同源，不用后台）
    try {
      const entries = await idbGetAllFromPage('analysis_cache_v1');
      if (!entries || !entries.length) {
        throw new Error('缓存为空，请先运行"预分"全量分析');
      }
      const seen = new Set();
      const stocks = [];
      for (const entry of entries) {
        if (!entry?.symbol || seen.has(entry.symbol)) continue;
        seen.add(entry.symbol);
        const sc = calcScoreFromEntry(entry);
        if (sc) stocks.push(sc);
      }
      const indMap = {};
      stocks.forEach(s => { const k = s.industry || '未知'; indMap[k] = (indMap[k] || 0) + 1; });
      const industries = Object.entries(indMap).map(([n, c]) => ({ name: n, count: c }));
      const stats = {
        totalStocks: stocks.length,
        cacheEntries: entries.length,
        latestDate: stocks.length > 0
          ? new Date(Math.max(...stocks.map(s => Number(s.fetchedAt || 0)))).toISOString().slice(0, 10)
          : null,
      };
      return { stats, stocks, industries, generatedAt: Date.now() };
    } catch (e) {
      errors.push('IndexedDB: ' + e.message);
    }

    throw new Error('无法连接预分析引擎。\n' + errors.map(e => '  · ' + e).join('\n') +
      '\n\n请确保：\n① 扩展已加载（chrome://extensions）\n② 已运行"预分"全量分析\n③ 在扩展页面中打开');
  }

  /* ---- 渲染：核心指标卡片 ---- */
  function renderStats(data) {
    const { stats, stocks } = data;
    const highRoe = stocks.filter(s => s.roe !== null && s.roe >= 15).length;
    const lowPe = stocks.filter(s => s.pe !== null && s.pe > 0 && s.pe <= 15).length;
    const highDiv = stocks.filter(s => s.dividendYield !== null && s.dividendYield >= 3).length;
    const fcfPos = stocks.filter(s => s.fcfYield !== null && s.fcfYield > 0).length;
    const signals = stocks.filter(s => s.signalTriggered).length;
    const industries = data.industries.length;
    const futureHigh = stocks.filter(s => s.futureScore !== null && s.futureScore >= 7).length;
    const futureMid = stocks.filter(s => s.futureScore !== null && s.futureScore >= 5).length;

    document.getElementById('statGrid').innerHTML = `
      <div class="stat-card"><div class="num accent">${stats.totalStocks}</div><div class="label">预分析覆盖</div></div>
      <div class="stat-card"><div class="num good">${highRoe}</div><div class="label">ROE≥15% 优质股</div></div>
      <div class="stat-card"><div class="num good">${lowPe}</div><div class="label">PE≤15 低估值</div></div>
      <div class="stat-card"><div class="num accent2">${highDiv}</div><div class="label">股息率≥3%</div></div>
      <div class="stat-card"><div class="num ${fcfPos >= stats.totalStocks/3 ? 'good' : 'warn'}">${fcfPos}</div><div class="label">FCF 正值</div></div>
      <div class="stat-card"><div class="num ${signals > 0 ? 'good' : 'warn'}">${signals}</div><div class="label">触发买点</div></div>
      <div class="stat-card"><div class="num accent">${industries}</div><div class="label">行业覆盖</div></div>
      <div class="stat-card"><div class="num">${stats.cacheEntries || 0}</div><div class="label">缓存条目</div></div>
      <div class="stat-card"><div class="num good">${futureHigh}</div><div class="label">好未来≥7分</div></div>
      <div class="stat-card"><div class="num">${futureMid}</div><div class="label">好未来≥5分</div></div>
    `;

    document.getElementById('headerStockCount').textContent = stats.totalStocks;
    document.getElementById('headerUpdatedAt').textContent = stats.latestDate || '--';
    document.getElementById('footerStockCount').textContent = stats.totalStocks;
    document.getElementById('footerUpdatedAt').textContent = stats.latestDate || '--';
  }

  /* ---- 渲染：行情跑马灯 ---- */
  function renderTicker(stocks) {
    const top10 = stocks.filter(s => s.totalScore !== null && s.totalScore > 0)
      .sort((a,b) => b.totalScore - a.totalScore).slice(0, 15);
    const inner = document.getElementById('tickerInner');
    if (!top10.length) { inner.innerHTML = '<div class="ticker-item"><span class="name">暂无行情数据</span></div>'; return; }
    inner.innerHTML = top10.map(s => `
      <div class="ticker-item">
        <span class="name">${esc(s.name)}</span>
        <span class="val">${esc(s.symbol)}</span>
        <span class="chg ${pctCls(s.roe)}" style="color:${s.totalScore>=7?'var(--good)':s.totalScore>=4?'var(--warn)':'var(--bad)'}">${fmt(s.totalScore)}分</span>
      </div>
    `).join('');
  }

  /* ---- 渲染：市场全景 ---- */
  function renderOverview(data) {
    const { stocks, stats } = data;
    const topScore = stocks.filter(s => s.totalScore !== null && s.totalScore > 0)
      .sort((a,b) => b.totalScore - a.totalScore).slice(0, 8);
    const topFuture = stocks.filter(s => s.futureScore !== null && s.futureScore > 0)
      .sort((a,b) => b.futureScore - a.futureScore).slice(0, 8);
    const topRoe = stocks.filter(s => s.roe !== null && s.roe > 0)
      .sort((a,b) => b.roe - a.roe).slice(0, 8);

    document.getElementById('overviewContent').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
        <div class="card">
          <div class="card-header"><div class="card-title">🏆 综合评分 Top 8</div><span class="card-badge">巴菲特六维</span></div>
          ${buildTable(topScore, ['名称', '评分', 'ROE', 'PE'], s => [
            `<span class="stock-link" onclick="openXueqiu('${esc(s.symbol)}')">${esc(s.name)}</span>`,
            `<span class="score-badge ${cls(s.totalScore)}">${fmt(s.totalScore)}</span>`,
            `<span class="${pctCls(s.roe)}">${pct(s.roe)}</span>`,
            fmt(s.pe)
          ])}
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">🚀 好未来 Top 8</div><span class="card-badge">宏观+行业+动能</span></div>
          ${buildTable(topFuture, ['名称', '好未来', '宏观', '行业', '动能'], s => [
            `<span class="stock-link" onclick="openXueqiu('${esc(s.symbol)}')">${esc(s.name)}</span>`,
            `<span class="score-badge ${cls(s.futureScore)}" style="font-size:12px;">${fmt(s.futureScore)}</span>`,
            `<span class="score-badge ${cls(s.macroScore)}">${fmt(s.macroScore)}</span>`,
            `<span class="score-badge ${cls(s.industryScore)}">${fmt(s.industryScore)}</span>`,
            `<span class="score-badge ${cls(s.momentumScore)}">${fmt(s.momentumScore)}</span>`,
          ])}
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">📈 高 ROE Top 8</div><span class="card-badge good">盈利能力</span></div>
          ${buildTable(topRoe, ['名称', 'ROE', 'PE', '评分'], s => [
            `<span class="stock-link" onclick="openXueqiu('${esc(s.symbol)}')">${esc(s.name)}</span>`,
            `<span class="${pctCls(s.roe)} fw-700">${pct(s.roe)}</span>`,
            fmt(s.pe),
            `<span class="score-badge ${cls(s.totalScore)}">${fmt(s.totalScore)}</span>`
          ])}
        </div>
      </div>
      <div class="card" style="margin-top:10px;">
        <div class="card-header"><div class="card-title">📊 行业覆盖概览</div><span class="card-badge">${data.industries.length} 个行业</span></div>
        ${renderIndustryBars(data.industries)}
      </div>
    `;
  }

  function buildTable(items, headers, rowFn) {
    if (!items || !items.length) return '<div class="empty-state">暂无数据</div>';
    return `<table class="dash-table">
      <thead><tr><th style="width:20px;">#</th>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${items.map((s, i) => {
        const cls2 = i === 0 ? 'pos1' : i === 1 ? 'pos2' : i === 2 ? 'pos3' : '';
        return `<tr><td style="width:20px;font-weight:700;color:var(--text-muted);font-size:10px;" class="${cls2}">${i + 1}</td>${rowFn(s).map(c => `<td>${c}</td>`).join('')}</tr>`;
      }).join('')}</tbody>
    </table>`;
  }

  function renderIndustryBars(industries) {
    if (!industries || !industries.length) return '<div class="empty-state">暂无行业数据</div>';
    const maxCount = Math.max(...industries.map(i => i.count));
    const colors = ['#1e7bf2','#16b9b3','#0f9d6e','#d97706','#ef4444','#8b5cf6','#ec4899','#14b8a6'];
    return `<div class="bar-chart">${industries.slice(0, 20).map((ind, i) => `
      <div class="bar-row">
        <div class="bar-label" title="${esc(ind.name)}">${esc(ind.name)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(ind.count / maxCount) * 100}%;background:${colors[i % colors.length]};"></div></div>
        <div class="bar-count">${ind.count}</div>
      </div>
    `).join('')}</div>`;
  }

  /* ---- 渲染：价值排行 ---- */
  function renderRanking(data, sortBy) {
    const { stocks } = data;
    const valid = stocks.filter(s => {
      if (sortBy === 'totalScore') return s.totalScore !== null && s.totalScore > 0;
      if (sortBy === 'roe') return s.roe !== null && s.roe > 0;
      if (sortBy === 'dividendYield') return s.dividendYield !== null && s.dividendYield > 0;
      if (sortBy === 'pe') return s.pe !== null && s.pe > 0;
      return true;
    });

    let sorted, headers, rowFn, title, badge;
    if (sortBy === 'totalScore') {
      sorted = valid.sort((a,b) => b.totalScore - a.totalScore).slice(0, 50);
      headers = ['名称', '总分', 'ROE', 'PE', '股息率', 'FCF Yield', '信号', '行业'];
      badge = '巴菲特六维综合评分';
      rowFn = s => [
        `<span class="stock-link" onclick="openXueqiu('${esc(s.symbol)}')">${esc(s.name)}</span>`,
        `<span class="score-badge ${cls(s.totalScore)}">${fmt(s.totalScore)}</span>`,
        `<span class="${pctCls(s.roe)}">${pct(s.roe)}</span>`,
        fmt(s.pe),
        pct(s.dividendYield),
        pct(s.fcfYield),
        `<span class="signal-badge ${s.signalTriggered ? 'triggered' : 'none'}">${s.signalTriggered ? '已触发' : '-'}</span>`,
        `<span class="text-muted text-sm">${esc(s.industry || '')}</span>`
      ];
    } else if (sortBy === 'roe') {
      sorted = valid.sort((a,b) => b.roe - a.roe).slice(0, 50);
      headers = ['名称', 'ROE', '净利增速', '营收CAGR', 'PE', '负债率', '评分'];
      badge = '净资产收益率';
      rowFn = s => [
        `<span class="stock-link" onclick="openXueqiu('${esc(s.symbol)}')">${esc(s.name)}</span>`,
        `<span class="fw-700 ${pctCls(s.roe)}">${pct(s.roe)}</span>`,
        pct(s.netProfitGrowth),
        pct(s.revenueCagr),
        fmt(s.pe),
        pct(s.debtAssetRatio),
        `<span class="score-badge ${cls(s.totalScore)}">${fmt(s.totalScore)}</span>`
      ];
    } else if (sortBy === 'dividendYield') {
      sorted = valid.sort((a,b) => b.dividendYield - a.dividendYield).slice(0, 50);
      headers = ['名称', '股息率', 'PE', 'ROE', 'FCF Yield', '信号', '评分'];
      badge = '现金分红回报';
      rowFn = s => [
        `<span class="stock-link" onclick="openXueqiu('${esc(s.symbol)}')">${esc(s.name)}</span>`,
        `<span class="fw-700" style="color:${s.dividendYield>=5?'var(--good)':s.dividendYield>=3?'var(--warn)':'var(--text)'}">${pct(s.dividendYield)}</span>`,
        fmt(s.pe),
        pct(s.roe),
        pct(s.fcfYield),
        `<span class="signal-badge ${s.signalTriggered ? 'triggered' : 'none'}">${s.signalTriggered ? '已触发' : '-'}</span>`,
        `<span class="score-badge ${cls(s.totalScore)}">${fmt(s.totalScore)}</span>`
      ];
    } else if (sortBy === 'pe') {
      sorted = valid.filter(s => s.pe > 0).sort((a,b) => a.pe - b.pe).slice(0, 50);
      headers = ['名称', 'PE', 'PB', 'ROE', '股息率', '信号', '评分'];
      badge = '低估值（PE升序）';
      rowFn = s => [
        `<span class="stock-link" onclick="openXueqiu('${esc(s.symbol)}')">${esc(s.name)}</span>`,
        `<span class="fw-700" style="color:${s.pe<=10?'var(--good)':s.pe<=20?'var(--warn)':'var(--bad)'}">${fmt(s.pe)}</span>`,
        fmt(s.pb),
        pct(s.roe),
        pct(s.dividendYield),
        `<span class="signal-badge ${s.signalTriggered ? 'triggered' : 'none'}">${s.signalTriggered ? '已触发' : '-'}</span>`,
        `<span class="score-badge ${cls(s.totalScore)}">${fmt(s.totalScore)}</span>`
      ];
    } else if (sortBy === 'future') {
      sorted = valid.filter(s => s.futureScore !== null && s.futureScore > 0)
        .sort((a,b) => b.futureScore - a.futureScore).slice(0, 50);
      headers = ['名称', '好未来', '宏观', '行业', '动能', 'ROE', '营收CAGR', '评分', ''];
      badge = '好未来三维评分：宏观顺风 + 行业空间 + 公司动能';
      rowFn = s => [
        `<span class="stock-link" onclick="openXueqiu('${esc(s.symbol)}')">${esc(s.name)}</span>`,
        `<span class="score-badge ${cls(s.futureScore)}" style="font-size:12px;">${fmt(s.futureScore)}</span>`,
        `<span class="score-badge ${cls(s.macroScore)}">${fmt(s.macroScore)}</span>`,
        `<span class="score-badge ${cls(s.industryScore)}">${fmt(s.industryScore)}</span>`,
        `<span class="score-badge ${cls(s.momentumScore)}">${fmt(s.momentumScore)}</span>`,
        pct(s.roe),
        pct(s.revenueCagr),
        `<span class="score-badge ${cls(s.totalScore)}">${fmt(s.totalScore)}</span>`,
        `<button onclick="analyzeFuture('${esc(s.symbol)}')" style="background:var(--gradient);border:none;color:#fff;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700;cursor:pointer;">AI</button>`
      ];
    }

    const subTabs = [
      { id: 'totalScore', label: '综合评分' },
      { id: 'future', label: '好未来' },
      { id: 'roe', label: '高ROE' },
      { id: 'dividendYield', label: '高股息' },
      { id: 'pe', label: '低估值' },
    ];

    document.getElementById('rankingContent').innerHTML = `
      <div class="card">
        <div class="card-header">
          <div class="card-title">🏆 ${badge}</div>
          <div style="display:flex;gap:4px;">
            ${subTabs.map(t => `<button class="tab-btn" style="font-size:9px;padding:3px 8px;${t.id===sortBy?'background:var(--gradient);color:#fff;':''}" onclick="switchRanking('${t.id}')">${t.label}</button>`).join('')}
          </div>
        </div>
        ${buildTable(sorted, headers, rowFn)}
      </div>
    `;
  }

  window.switchRanking = function(sortBy) {
    renderRanking(DASH, sortBy);
  };

  /* ---- 渲染：行业透视 ---- */
  function renderIndustry(data) {
    const { stocks, industries } = data;
    const industryMap = {};
    stocks.forEach(s => {
      const ind = s.industry || '未知';
      if (!industryMap[ind]) industryMap[ind] = { count:0, roeSum:0, peSum:0, yieldSum:0, scoreSum:0, roeN:0, peN:0, yieldN:0, scoreN:0 };
      const e = industryMap[ind];
      e.count++;
      if (s.roe !== null) { e.roeSum += s.roe; e.roeN++; }
      if (s.pe !== null && s.pe > 0) { e.peSum += s.pe; e.peN++; }
      if (s.dividendYield !== null) { e.yieldSum += s.dividendYield; e.yieldN++; }
      if (s.totalScore !== null) { e.scoreSum += s.totalScore; e.scoreN++; }
    });

    const enriched = Object.entries(industryMap).map(([name, e]) => ({
      name, count: e.count,
      avgRoe: e.roeN ? (e.roeSum / e.roeN) : null,
      avgPe: e.peN ? (e.peSum / e.peN) : null,
      avgYield: e.yieldN ? (e.yieldSum / e.yieldN) : null,
      avgScore: e.scoreN ? (e.scoreSum / e.scoreN) : null,
    })).sort((a, b) => b.count - a.count);

    const maxCount = Math.max(...enriched.map(e => e.count));
    const colors = ['#1e7bf2','#16b9b3','#0f9d6e','#d97706','#ef4444','#8b5cf6','#ec4899','#14b8a6'];

    document.getElementById('industryContent').innerHTML = `
      <div class="card">
        <div class="card-header"><div class="card-title">🏭 行业分布（${industries.length}个）</div><span class="card-badge good">${stocks.length}只股票</span></div>
        ${enriched.map((ind, i) => `
          <div class="flex-between" style="margin-bottom:4px;font-size:11px;">
            <div style="display:flex;align-items:center;gap:6px;flex:1;">
              <span style="width:60px;font-weight:700;color:var(--text-muted);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(ind.name)}</span>
              <div class="bar-track" style="flex:1;height:12px;"><div class="bar-fill" style="width:${(ind.count/maxCount)*100}%;background:${colors[i%colors.length]};"></div></div>
              <span style="width:24px;text-align:right;font-weight:600;">${ind.count}</span>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">📊 行业质量矩阵</div><span class="card-badge">ROE / PE / 评分</span></div>
        <table class="dash-table">
          <thead><tr><th>行业</th><th>数量</th><th>平均ROE</th><th>平均PE</th><th>平均股息率</th><th>平均评分</th></tr></thead>
          <tbody>${enriched.map(ind => `
            <tr>
              <td><span class="fw-700">${esc(ind.name)}</span></td>
              <td>${ind.count}</td>
              <td class="${pctCls(ind.avgRoe)}">${pct(ind.avgRoe)}</td>
              <td>${fmt(ind.avgPe)}</td>
              <td>${pct(ind.avgYield)}</td>
              <td><span class="score-badge ${cls(ind.avgScore)}">${fmt(ind.avgScore)}</span></td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>
    `;
  }

  /* ---- 渲染：信号监控 ---- */
  function renderSignal(data) {
    const { stocks } = data;
    const triggered = stocks.filter(s => s.signalTriggered)
      .sort((a,b) => (b.totalScore||0) - (a.totalScore||0));
    const pending = stocks.filter(s => !s.signalTriggered && s.totalScore !== null && s.totalScore >= 6)
      .sort((a,b) => (b.totalScore||0) - (a.totalScore||0)).slice(0, 20);

    document.getElementById('signalContent').innerHTML = `
      <div class="card">
        <div class="card-header">
          <div class="card-title">📡 信号触发 · 已触发（${triggered.length}只）</div>
          <span class="card-badge good">买点信号</span>
        </div>
        ${triggered.length ? buildTable(triggered, ['名称', '评分', '趋势分', '价值覆盖', 'ROE', 'PE', '行业'], s => [
          `<span class="stock-link" onclick="openXueqiu('${esc(s.symbol)}')">${esc(s.name)}</span>`,
          `<span class="score-badge ${cls(s.totalScore)}">${fmt(s.totalScore)}</span>`,
          fmt(s.trendScore),
          s.valueCoverage || '-',
          pct(s.roe),
          fmt(s.pe),
          `<span class="text-muted text-sm">${esc(s.industry||'')}</span>`
        ]) : '<div class="empty-state">暂无触发信号</div>'}
      </div>
      <div class="card" style="margin-top:10px;">
        <div class="card-header">
          <div class="card-title">👀 重点关注 · 高评分未触发（${pending.length}只）</div>
          <span class="card-badge warn">潜在机会</span>
        </div>
        ${pending.length ? buildTable(pending, ['名称', '评分', '趋势分', '价值覆盖', 'ROE', 'PE', '行业'], s => [
          `<span class="stock-link" onclick="openXueqiu('${esc(s.symbol)}')">${esc(s.name)}</span>`,
          `<span class="score-badge ${cls(s.totalScore)}">${fmt(s.totalScore)}</span>`,
          fmt(s.trendScore),
          s.valueCoverage || '-',
          pct(s.roe),
          fmt(s.pe),
          `<span class="text-muted text-sm">${esc(s.industry||'')}</span>`
        ]) : '<div class="empty-state">暂无高评分待触发股票</div>'}
      </div>
    `;
  }

  /* ---- 打开雪球 ---- */
  window.openXueqiu = function(symbol) {
    const url = `https://xueqiu.com/S/${symbol}`;
    window.open(url, '_blank');
  };

  /* ---- AI 好未来分析 ---- */
  window.analyzeFuture = async function(symbol) {
    // 找到对应股票数据
    const stock = DASH?.stocks?.find(s => s.symbol === symbol);
    if (!stock) return;

    // 创建或获取模态框
    let modal = document.getElementById('xq-future-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'xq-future-modal';
      modal.innerHTML = `<div style="
        position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;
        background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;
        padding:20px;backdrop-filter:blur(4px);
      "><div style="
        background:var(--bg-card);border:1px solid var(--border);border-radius:16px;
        max-width:620px;width:100%;max-height:80vh;overflow-y:auto;padding:20px;
        box-shadow:0 20px 60px rgba(0,0,0,.5);
      "><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div style="font-size:15px;font-weight:700;" id="xq-future-title">AI 好未来分析</div>
        <button onclick="document.getElementById('xq-future-modal').remove()" style="
          background:rgba(255,255,255,.08);border:none;color:var(--text-muted);font-size:18px;
          width:30px;height:30px;border-radius:8px;cursor:pointer;
        ">✕</button>
      </div>
      <div id="xq-future-body" style="font-size:12px;line-height:1.7;color:var(--text);white-space:pre-wrap;"></div></div></div>`;
      document.body.appendChild(modal);
    }
    modal.style.display = 'flex';
    const body = document.getElementById('xq-future-body');
    const title = document.getElementById('xq-future-title');
    title.textContent = `🤖 AI 好未来分析 · ${symbol} ${stock.name || ''}`;
    body.textContent = '正在调用 AI 分析中...\n\n（请确保已在设置页配置了 LLM API Key）';

    // 调用后台 AI 分析
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
      try {
        const data = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: 'getFutureAnalysis', symbol }, (res) => {
            const err = chrome.runtime.lastError;
            if (err) { reject(new Error(err.message)); return; }
            if (!res || !res.ok) reject(new Error((res && res.error) || '分析失败'));
            else resolve(res.data);
          });
        });
        body.textContent = data.analysis + '\n\n—— ' + (data.usedProvider || 'AI');
      } catch (e) {
        body.textContent = `AI 分析调用失败：${e.message}\n\n请确保：\n① 设置页已配置 LLM API Key\n② 扩展已加载\n③ 稍后重试`;
      }
    } else {
      body.textContent = '请在扩展环境中使用此功能';
    }
  };

  /* ---- Tab 切换 ---- */
  function initTabs() {
    const bar = document.getElementById('tabBar');
    if (!bar) return;
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) return;
      const tab = btn.dataset.tab;
      // 切换高亮
      bar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // 切换内容
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      const target = document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1));
      if (target) target.classList.add('active');
      // 触发渲染
      if (tab === 'ranking' && DASH) renderRanking(DASH, 'totalScore');
      else if (tab === 'industry' && DASH) renderIndustry(DASH);
      else if (tab === 'signal' && DASH) renderSignal(DASH);
    });
  }

  /* ---- 初始化和错误处理 ---- */
  function showError(err) {
    const msg = err.message || String(err);
    const lines = msg.split('\n');
    const isConnectionError = msg.includes('无法连接预分析引擎');
    document.querySelectorAll('.tab-content').forEach(el => {
      el.innerHTML = `<div class="empty-state" style="padding:40px 20px;">
        <div style="font-size:36px;margin-bottom:10px;">${isConnectionError ? '🔌' : '⚠️'}</div>
        <div style="font-size:15px;font-weight:700;margin-bottom:6px;">
          ${isConnectionError ? '无法加载投研看板' : '看板加载异常'}
        </div>
        <div style="font-size:11px;color:var(--text-muted);line-height:1.6;text-align:left;display:inline-block;">
          ${lines.map(l => l.trim() ? esc(l) : '<br>').join('<br>')}
        </div>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:center;">
          <button onclick="location.reload()" style="
            background:var(--gradient);border:none;color:#fff;padding:8px 20px;
            border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;
          ">🔄 重试</button>
          <a href="options.html" style="
            background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--text);
            padding:8px 20px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;text-decoration:none;
          ">⚙️ 前往设置页</a>
        </div>
      </div>`;
    });
  }

  async function init() {
    initTabs();

    // CSV 导出按钮绑定
    const csvBtn = document.getElementById('btnExportCSV');
    if (csvBtn) {
      csvBtn.addEventListener('click', function() {
        if (!DASH || !DASH.stocks || !DASH.stocks.length) {
          alert('暂无数据可导出，请先加载看板');
          return;
        }
        const h = ['代码','名称','行业','巴菲特评分','好未来评分','宏观顺风','行业空间','公司动能','ROE(%)','PE','PB','股息率(%)','FCF Yield(%)','净利增速(%)','营收CAGR(%)','资产负债率(%)','趋势分','触发信号'];
        const rows = DASH.stocks.map(s => [s.symbol, s.name, s.industry||'', s.totalScore??'', s.futureScore??'', s.macroScore??'', s.industryScore??'', s.momentumScore??'', s.roe??'', s.pe??'', s.pb??'', s.dividendYield??'', s.fcfYield??'', s.netProfitGrowth??'', s.revenueCagr??'', s.debtAssetRatio??'', s.trendScore??'', s.signalTriggered?'是':'否']);
        const csv = [h.join(','), ...rows.map(r => r.map(v => { const s=String(v??''); return s.includes(',')||s.includes('"')? '"'+s.replace(/"/g,'""')+'"' : s; }).join(','))].join('\n');
        const blob = new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8;'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'palantir_看板数据_'+new Date().toISOString().slice(0,10)+'.csv';
        a.click();
        URL.revokeObjectURL(a.href);
      });
    }

    try {
      DASH = await fetchDashboardData();
      if (!DASH.stocks || !DASH.stocks.length) {
        throw new Error('预分析缓存为空。请先在雪球股票页面点击"预分"按钮运行全量分析。');
      }
      renderStats(DASH);
      renderTicker(DASH.stocks);
      renderOverview(DASH);
      renderRanking(DASH, 'totalScore');
      renderIndustry(DASH);
      renderSignal(DASH);
    } catch (err) {
      showError(err);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
