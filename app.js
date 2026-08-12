/* Nordic Global Equity portfolio — client-side app.
 * No build step, no framework: fetches the JSON data files, computes
 * portfolio/risk metrics in the browser, and renders the page. Mock buy/sell
 * state lives in localStorage only (there's no backend or login).
 */

const STATE_KEY = "nordic-portfolio-state-v1";
const TRADING_DAYS = 252;

const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7"];

let CONFIG, PRICES, FUNDAMENTALS, HISTORY;
let holdingsState; // { [ticker]: shares }
let cashState;
let chart;

init();

async function init() {
  bindThemeToggle();
  bindResetButton();
  bindModal();

  try {
    [CONFIG, PRICES, FUNDAMENTALS, HISTORY] = await Promise.all([
      fetchJson("data/portfolio.json"),
      fetchJson("data/prices.json"),
      fetchJson("data/fundamentals.json"),
      fetchJson("data/history.json"),
    ]);
  } catch (err) {
    document.querySelector("main").innerHTML =
      `<p style="padding:2rem;color:var(--status-critical)">Couldn't load portfolio data: ${err.message}</p>`;
    return;
  }

  loadState();
  renderAll();
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/* ---------------------------------------------------------------------
   State: holdings shares + cash, persisted per-browser in localStorage
------------------------------------------------------------------------ */

function loadState() {
  const saved = safeParse(localStorage.getItem(STATE_KEY));
  if (saved && saved.holdings && typeof saved.cash === "number") {
    holdingsState = saved.holdings;
    cashState = saved.cash;
  } else {
    resetState(false);
  }
}

function resetState(persist = true) {
  holdingsState = {};
  for (const h of CONFIG.holdings) holdingsState[h.ticker] = h.shares;
  cashState = CONFIG.cash;
  if (persist) saveState();
}

function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify({ holdings: holdingsState, cash: cashState }));
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------
   Core snapshot: current market values, weights, P&L, limit breaches
------------------------------------------------------------------------ */

function fxToNok(currency) {
  if (currency === "NOK") return 1;
  if (currency === "SEK") return PRICES.fx.SEKNOK;
  if (currency === "DKK") return PRICES.fx.DKKNOK;
  throw new Error(`unknown currency ${currency}`);
}

function computeSnapshot() {
  const rows = CONFIG.holdings.map((h) => {
    const quote = PRICES.quotes[h.ticker] || { price: h.costBasis, previousClose: h.costBasis };
    const shares = holdingsState[h.ticker] ?? 0;
    const fx = fxToNok(h.currency);
    const marketValueNok = shares * quote.price * fx;
    const dayChangePct = quote.previousClose ? (quote.price - quote.previousClose) / quote.previousClose : 0;
    const costNok = shares * h.costBasis * fx;
    const plNok = marketValueNok - costNok;
    return { ...h, quote, shares, fx, marketValueNok, dayChangePct, plNok };
  });

  const investedNok = rows.reduce((s, r) => s + r.marketValueNok, 0);
  const nav = investedNok + cashState;

  for (const r of rows) {
    r.weight = nav > 0 ? r.marketValueNok / nav : 0;
    r.limitStatus =
      r.weight > CONFIG.maxPositionWeight ? "critical" : r.weight > CONFIG.warnPositionWeight ? "warning" : null;
  }

  return { rows, nav, cash: cashState, investedNok };
}

/* ---------------------------------------------------------------------
   Rendering
------------------------------------------------------------------------ */

function renderAll() {
  const snap = computeSnapshot();
  renderAlertBanner(snap);
  renderHeroStats(snap);
  renderHoldingsTable(snap);
  const riskModel = buildRiskModel(snap);
  renderRiskPanel(riskModel, snap);
  renderChart(riskModel);
  renderDataNote();
}

function fmtNOK(n) {
  return n.toLocaleString("nb-NO", { style: "currency", currency: "NOK", maximumFractionDigits: 0 });
}
function fmtPct(n, digits = 1) {
  return `${(n * 100).toFixed(digits)}%`;
}
function fmtSignedPct(n, digits = 1) {
  const s = (n * 100).toFixed(digits);
  return `${n >= 0 ? "+" : ""}${s}%`;
}

function renderAlertBanner(snap) {
  const el = document.getElementById("alert-banner");
  const breaches = snap.rows.filter((r) => r.limitStatus === "critical");
  const warns = snap.rows.filter((r) => r.limitStatus === "warning");
  if (breaches.length === 0 && warns.length === 0) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  const parts = [];
  if (breaches.length) {
    parts.push(
      `<div><strong>Position limit breached (&gt;${fmtPct(CONFIG.maxPositionWeight, 0)} of NAV):</strong> ${breaches
        .map((r) => `${r.name} at ${fmtPct(r.weight)}`)
        .join(", ")}</div>`
    );
  }
  if (warns.length) {
    parts.push(
      `<div>Approaching limit (&gt;${fmtPct(CONFIG.warnPositionWeight, 0)}): ${warns
        .map((r) => `${r.name} at ${fmtPct(r.weight)}`)
        .join(", ")}</div>`
    );
  }
  el.innerHTML = parts.join("");
}

function renderHeroStats(snap) {
  document.getElementById("nav-value").textContent = fmtNOK(snap.nav);
  const totalReturn = (snap.nav - CONFIG.inceptionNav) / CONFIG.inceptionNav;
  const deltaEl = document.getElementById("nav-delta");
  deltaEl.textContent = `${fmtSignedPct(totalReturn, 2)} since inception (${CONFIG.inceptionDate})`;
  deltaEl.className = "stat-delta " + (totalReturn > 0 ? "pos" : totalReturn < 0 ? "neg" : "");

  document.getElementById("cash-value").textContent = fmtNOK(snap.cash);
}

function renderHoldingsTable(snap) {
  const tbody = document.getElementById("holdings-body");
  tbody.innerHTML = "";
  for (const r of snap.rows) {
    const fund = FUNDAMENTALS.stocks[r.ticker] || {};
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="name-cell">
        <div class="ticker-name">${r.name}</div>
        <div class="ticker-sub">${r.ticker} · ${r.country}</div>
      </td>
      <td>${r.sector}</td>
      <td class="num">${r.shares.toLocaleString("nb-NO", { maximumFractionDigits: 2 })}</td>
      <td class="num">${r.quote.price.toFixed(2)} ${r.currency}
        <div class="ticker-sub ${r.dayChangePct >= 0 ? "pos" : "neg"}">${fmtSignedPct(r.dayChangePct)}</div>
      </td>
      <td class="num">${fmtNOK(r.marketValueNok)}</td>
      <td class="num">
        ${fmtPct(r.weight)}
        ${r.limitStatus ? `<span class="limit-badge ${r.limitStatus}">${r.limitStatus === "critical" ? "OVER LIMIT" : "NEAR LIMIT"}</span>` : ""}
      </td>
      <td class="num ${r.plNok >= 0 ? "pos" : "neg"}">${r.plNok >= 0 ? "+" : ""}${fmtNOK(r.plNok)}</td>
      <td class="thesis-note">
        <div>${fund.multiple || "—"}</div>
        <div style="margin-top:0.3rem">${fund.sizingRationale || ""}</div>
      </td>
      <td>
        <div class="trade-actions">
          <button class="btn-buy" data-action="buy" data-ticker="${r.ticker}">Buy</button>
          <button class="btn-sell" data-action="sell" data-ticker="${r.ticker}">Sell</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => openTradeModal(btn.dataset.ticker, btn.dataset.action));
  });
}

function renderDataNote() {
  const el = document.getElementById("prices-updated");
  const dt = new Date(PRICES.lastUpdated);
  const label = isNaN(dt) ? PRICES.lastUpdated : dt.toLocaleString("nb-NO", { dateStyle: "medium", timeStyle: "short" });
  el.textContent = `Prices last refreshed ${label} · source: ${PRICES.source || "Yahoo Finance"}. Valuation figures as of ${FUNDAMENTALS.asOf}.`;
}

/* ---------------------------------------------------------------------
   Risk model: date-aligned NOK price series -> returns, vol, correlation,
   portfolio Sharpe, and a hypothetical backtest of *today's* holdings
   across the trailing history window.
------------------------------------------------------------------------ */

function buildRiskModel(snap) {
  const tickers = CONFIG.holdings.map((h) => h.ticker);
  const benchTicker = CONFIG.benchmark.ticker;
  const required = [...tickers, benchTicker, "SEKNOK=X", "DKKNOK=X"];

  if (!HISTORY || required.some((k) => !HISTORY[k] || HISTORY[k].length < 20)) {
    return { ready: false };
  }

  const maps = {};
  for (const k of required) {
    maps[k] = new Map(HISTORY[k].map((p) => [p.date, p.close]));
  }

  // Common trading dates present in every required series.
  let dates = [...maps[tickers[0]].keys()];
  for (const k of required) dates = dates.filter((d) => maps[k].has(d));
  dates.sort();

  if (dates.length < 20) return { ready: false };

  const currencyByTicker = Object.fromEntries(CONFIG.holdings.map((h) => [h.ticker, h.currency]));

  // NOK-denominated close series per ticker, and raw index series for benchmark.
  const nokClose = {};
  for (const t of tickers) {
    const cur = currencyByTicker[t];
    nokClose[t] = dates.map((d) => {
      const px = maps[t].get(d);
      if (cur === "NOK") return px;
      if (cur === "SEK") return px * maps["SEKNOK=X"].get(d);
      return px * maps["DKKNOK=X"].get(d);
    });
  }
  const benchClose = dates.map((d) => maps[benchTicker].get(d));

  const returns = {};
  for (const t of tickers) returns[t] = toReturns(nokClose[t]);
  const benchReturns = toReturns(benchClose);

  const expReturn = {};
  const vol = {};
  for (const t of tickers) {
    expReturn[t] = mean(returns[t]) * TRADING_DAYS;
    vol[t] = stdev(returns[t]) * Math.sqrt(TRADING_DAYS);
  }

  const corr = {};
  for (const a of tickers) {
    corr[a] = {};
    for (const b of tickers) corr[a][b] = correlation(returns[a], returns[b]);
  }

  // Portfolio expected return / vol from current weights (cash contributes 0/0).
  const weight = Object.fromEntries(snap.rows.map((r) => [r.ticker, r.weight]));
  const portReturn = tickers.reduce((s, t) => s + weight[t] * expReturn[t], 0);
  let portVarianceAnnual = 0;
  for (const a of tickers) {
    for (const b of tickers) {
      const covAnnual = corr[a][b] * vol[a] * vol[b];
      portVarianceAnnual += weight[a] * weight[b] * covAnnual;
    }
  }
  const portVol = Math.sqrt(Math.max(portVarianceAnnual, 0));
  const sharpe = portVol > 0 ? (portReturn - CONFIG.riskFreeRate) / portVol : null;

  // Hypothetical backtest: hold TODAY's share counts + cash across the whole
  // window, rebased to 100. Shows what the current book's risk/return has
  // looked like historically — it is not realized live P&L (the fund only
  // started today).
  const backtestNav = dates.map((_, i) => {
    const invested = tickers.reduce((s, t) => s + (holdingsState[t] ?? 0) * nokClose[t][i], 0);
    return invested + cashState;
  });
  const portfolioIndex = rebaseTo100(backtestNav);
  const benchIndex = rebaseTo100(benchClose);

  // Beta vs. the benchmark, from the same backtested holdings.
  const portfolioReturns = toReturns(backtestNav);
  const benchVariance = stdev(benchReturns) ** 2;
  const beta = benchVariance > 0 ? covariance(portfolioReturns, benchReturns) / benchVariance : null;

  return {
    ready: true,
    dates,
    tickers,
    expReturn,
    vol,
    corr,
    portReturn,
    portVol,
    sharpe,
    beta,
    portfolioIndex,
    benchIndex,
  };
}

function toReturns(series) {
  const out = [];
  for (let i = 1; i < series.length; i++) out.push(series[i] / series[i - 1] - 1);
  return out;
}
function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function stdev(arr) {
  const m = mean(arr);
  const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}
function covariance(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (a.length - 1);
}
function correlation(a, b) {
  const denom = stdev(a) * stdev(b);
  return denom === 0 ? 0 : covariance(a, b) / denom;
}
function rebaseTo100(series) {
  const base = series[0];
  return series.map((v) => (v / base) * 100);
}

/* ---------------------------------------------------------------------
   Risk panel: headline stats + correlation heatmap
------------------------------------------------------------------------ */

function renderRiskPanel(model, snap) {
  const sharpeEl = document.getElementById("sharpe-value");
  const returnEl = document.getElementById("return-value");
  const volEl = document.getElementById("vol-value");

  if (!model.ready) {
    sharpeEl.textContent = "—";
    returnEl.textContent = "—";
    volEl.textContent = "—";
    const betaElEmpty = document.getElementById("beta-value");
    if (betaElEmpty) betaElEmpty.textContent = "—";
    document.getElementById("risk-body").innerHTML =
      `<tr><td colspan="4" class="thesis-note">Trailing price history hasn't been populated yet — it fills in after the first automated GitHub Actions refresh (or run the workflow manually). See README.</td></tr>`;
    document.getElementById("corr-matrix").innerHTML = "";
    return;
  }

  sharpeEl.textContent = model.sharpe.toFixed(2);
  returnEl.textContent = fmtSignedPct(model.portReturn);
  volEl.textContent = fmtPct(model.portVol);

  const betaEl = document.getElementById("beta-value");
  if (betaEl) betaEl.textContent = model.beta == null ? "—" : model.beta.toFixed(2);

  const riskBody = document.getElementById("risk-body");
  riskBody.innerHTML = model.tickers
    .map((t) => {
      const h = CONFIG.holdings.find((x) => x.ticker === t);
      const snapRow = snap.rows.find((x) => x.ticker === t);
      return `<tr>
        <td>${h.name}</td>
        <td class="num">${fmtSignedPct(model.expReturn[t])}</td>
        <td class="num">${fmtPct(model.vol[t])}</td>
        <td class="num">${fmtPct(snapRow.weight)}</td>
      </tr>`;
    })
    .join("");

  renderCorrelationMatrix(model);
}

function renderCorrelationMatrix(model) {
  const el = document.getElementById("corr-matrix");
  const n = model.tickers.length;
  el.style.gridTemplateColumns = `auto repeat(${n}, 1fr)`;
  const shortLabel = (t) => t.split(/[.\-]/)[0];

  // Read the diverging pair + neutral midpoint from the active theme so the
  // heatmap adapts in dark mode instead of hardcoding the light-mode values.
  const styles = getComputedStyle(document.body);
  const pos = hexToRgb(styles.getPropertyValue("--diverging-pos").trim());
  const neg = hexToRgb(styles.getPropertyValue("--diverging-neg").trim());
  const mid = hexToRgb(styles.getPropertyValue("--diverging-mid").trim());

  let html = `<div></div>`;
  for (const t of model.tickers) html += `<div class="corr-head">${shortLabel(t)}</div>`;

  for (const a of model.tickers) {
    html += `<div class="corr-head" style="justify-content:flex-end;padding-right:6px">${shortLabel(a)}</div>`;
    for (const b of model.tickers) {
      const v = model.corr[a][b];
      const bg = correlationColor(v, pos, neg, mid);
      const textColor = Math.abs(v) > 0.55 ? "#fff" : "var(--text-primary)";
      html += `<div class="corr-cell" style="background:${bg};color:${textColor}" title="${shortLabel(a)} vs ${shortLabel(b)}: ${v.toFixed(2)}">${v.toFixed(2)}</div>`;
    }
  }
  el.innerHTML = html;
}

function hexToRgb(hex) {
  const m = hex.replace("#", "").match(/.{1,2}/g);
  return m.map((h) => parseInt(h, 16));
}

function correlationColor(v, pos, neg, mid) {
  // Diverging blue (positive) <-> red (negative), gray at 0. RGB lerp is a
  // pragmatic approximation of the palette's diverging pair for a continuous fill.
  const t = Math.max(-1, Math.min(1, v));
  const target = t >= 0 ? pos : neg;
  const k = Math.abs(t);
  const rgb = mid.map((m, i) => Math.round(m + (target[i] - m) * k));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

/* ---------------------------------------------------------------------
   Performance chart (Chart.js): portfolio backtest vs OSEBX, rebased to 100
------------------------------------------------------------------------ */

function renderChart(model) {
  const canvas = document.getElementById("perf-chart");
  const legend = document.getElementById("chart-legend");

  if (!model.ready) {
    legend.innerHTML = "";
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  legend.innerHTML = `
    <span class="legend-item"><span class="legend-swatch" style="background:${SERIES_COLORS[0]}"></span>Portfolio (current holdings)</span>
    <span class="legend-item"><span class="legend-swatch" style="background:${SERIES_COLORS[1]}"></span>${CONFIG.benchmark.name}</span>
  `;

  const labels = model.dates;
  const data = {
    labels,
    datasets: [
      {
        label: "Portfolio (current holdings, indexed)",
        data: model.portfolioIndex,
        borderColor: SERIES_COLORS[0],
        backgroundColor: "transparent",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.15,
      },
      {
        label: CONFIG.benchmark.name,
        data: model.benchIndex,
        borderColor: SERIES_COLORS[1],
        backgroundColor: "transparent",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.15,
      },
    ],
  };

  const styles = getComputedStyle(document.body);
  const gridColor = styles.getPropertyValue("--gridline").trim();
  const textColor = styles.getPropertyValue("--text-secondary").trim();

  if (chart) chart.destroy();
  chart = new Chart(canvas, {
    type: "line",
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: textColor, maxTicksLimit: 8 },
          grid: { color: gridColor },
        },
        y: {
          ticks: { color: textColor },
          grid: { color: gridColor },
          title: { display: true, text: "Indexed to 100 at window start", color: textColor },
        },
      },
    },
  });
}

/* ---------------------------------------------------------------------
   Theme toggle
------------------------------------------------------------------------ */

function bindThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  const saved = localStorage.getItem("nordic-portfolio-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  btn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("nordic-portfolio-theme", next);
    if (chart) renderAll(); // re-render chart with new axis colors
  });
}

/* ---------------------------------------------------------------------
   Reset button
------------------------------------------------------------------------ */

function bindResetButton() {
  document.getElementById("reset-btn").addEventListener("click", () => {
    if (!confirm("Reset all holdings and cash back to the inception allocation?")) return;
    resetState();
    renderAll();
  });
}

/* ---------------------------------------------------------------------
   Trade modal (buy/sell by kr amount, client-side only)
------------------------------------------------------------------------ */

let tradeContext = null;

function bindModal() {
  const modal = document.getElementById("trade-modal");
  const amountInput = document.getElementById("trade-amount");
  document.getElementById("trade-cancel").addEventListener("click", closeTradeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeTradeModal();
  });
  amountInput.addEventListener("input", updateTradePreview);
  document.getElementById("trade-confirm").addEventListener("click", submitTrade);
}

function openTradeModal(ticker, action) {
  const holding = CONFIG.holdings.find((h) => h.ticker === ticker);
  const quote = PRICES.quotes[ticker];
  const shares = holdingsState[ticker] ?? 0;
  const fx = fxToNok(holding.currency);
  const positionValueNok = shares * quote.price * fx;

  tradeContext = { ticker, action, holding, quote, fx, positionValueNok };

  document.getElementById("trade-title").textContent = `${action === "buy" ? "Buy" : "Sell"} ${holding.name}`;
  document.getElementById("trade-sub").textContent =
    action === "buy"
      ? `Price ${quote.price.toFixed(2)} ${holding.currency} · Cash available: ${fmtNOK(cashState)}`
      : `Price ${quote.price.toFixed(2)} ${holding.currency} · Position value: ${fmtNOK(positionValueNok)}`;
  document.getElementById("trade-amount").value = "";
  document.getElementById("trade-preview").textContent = "";
  document.getElementById("trade-error").textContent = "";
  document.getElementById("trade-confirm").textContent = action === "buy" ? "Buy" : "Sell";
  document.getElementById("trade-modal").classList.remove("hidden");
  document.getElementById("trade-amount").focus();
}

function closeTradeModal() {
  document.getElementById("trade-modal").classList.add("hidden");
  tradeContext = null;
}

function updateTradePreview() {
  const preview = document.getElementById("trade-preview");
  const amount = parseFloat(document.getElementById("trade-amount").value);
  if (!tradeContext || !amount || amount <= 0) {
    preview.textContent = "";
    return;
  }
  const { quote, fx } = tradeContext;
  const priceNok = quote.price * fx;
  const shares = amount / priceNok;
  preview.textContent = `≈ ${shares.toLocaleString("nb-NO", { maximumFractionDigits: 3 })} shares at ${priceNok.toFixed(2)} kr`;
}

function submitTrade() {
  const errorEl = document.getElementById("trade-error");
  const amount = parseFloat(document.getElementById("trade-amount").value);
  if (!tradeContext || !amount || amount <= 0) {
    errorEl.textContent = "Enter a kr amount greater than zero.";
    return;
  }
  const { ticker, action, quote, fx, positionValueNok } = tradeContext;
  const priceNok = quote.price * fx;
  const shareDelta = amount / priceNok;

  if (action === "buy") {
    if (amount > cashState + 1e-6) {
      errorEl.textContent = `Not enough cash — only ${fmtNOK(cashState)} available.`;
      return;
    }
    cashState -= amount;
    holdingsState[ticker] = (holdingsState[ticker] ?? 0) + shareDelta;
  } else {
    if (amount > positionValueNok + 1e-6) {
      errorEl.textContent = `Can't sell more than the position is worth (${fmtNOK(positionValueNok)}).`;
      return;
    }
    cashState += amount;
    holdingsState[ticker] = Math.max(0, (holdingsState[ticker] ?? 0) - shareDelta);
  }

  saveState();
  closeTradeModal();
  renderAll();
}
