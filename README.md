# Nordic Global Equity portfolio

A mock, long-only Nordic equity portfolio dashboard — built as a portfolio piece,
not a trading product. Seeded with **1,000,000 kr**, it holds six Nordic large-caps
plus cash, tracks daily-refreshed prices, and computes its own risk statistics
(expected return, volatility, correlation, and a headline **Sharpe ratio**) client-side.

**Live site:** https://teoswim.github.io/nordic-global-equity-portfolio/

> Mock portfolio for demonstration purposes only. Not investment advice.

## What it does

- **Holdings**: Nordic Semiconductor, Evolution AB, Novo Nordisk, Investor AB, DNB
  Bank and Equinor, spanning Norway/Sweden/Denmark and semiconductors, iGaming,
  healthcare, diversified holdings, financials and energy — plus a cash buffer.
  Each position's size comes with a one-line sizing rationale (see the Holdings
  table) rather than an equal-weight default.
- **Position-limit guardrail**: any position exceeding 25% of NAV turns red (a hard
  concentration-risk cap); 20% shows an amber warning. See `renderAlertBanner` in
  `app.js`.
- **Risk panel**: annualized expected return, volatility, a full correlation
  matrix, and portfolio-level Sharpe ratio — all computed in the browser from
  `data/history.json`, not pre-baked.
- **Performance chart**: today's exact holdings, held constant across the trailing
  ~1-year window and rebased to 100, plotted against the OSEBX benchmark. It's a
  hypothetical backtest of the *current* book (labeled as such on the page) —
  the fund only started on the inception date, so there's no real multi-year
  track record to show yet. Buying or selling updates it immediately.
- **Buy / Sell**: every row has working trade buttons. Trades are kr-denominated,
  update cash and share counts, and persist in this browser's `localStorage` —
  there's no backend, login, or shared state across devices. "Reset to inception
  allocation" undoes everything.

## Two data-freshness problems, two different solutions

**Prices** need to be close to live. **Valuation multiples** (P/E, etc.) don't —
they only actually change when a company reports, roughly quarterly. Treating both
the same way would mean either re-scraping fundamentals nightly for no reason, or
leaving prices stale for months. So the site treats them differently:

- `data/prices.json` and `data/history.json` are refreshed **automatically**, daily
  on weekdays, by `.github/workflows/update-prices.yml` running
  `scripts/update-prices.mjs` on GitHub's runners. It calls Yahoo Finance's public
  chart endpoint server-side (no API key needed, no browser CORS issue) for each
  ticker + the OSEBX benchmark + SEK/DKK→NOK FX rates, and commits the result back
  to the repo. If any single symbol fails to fetch, that symbol's last-known-good
  data is kept and the run still succeeds — a flaky ticker can't brick the page.
  This is an unofficial endpoint, which is an accepted trade-off for a demo where
  a day or two of price lag is explicitly fine.
- `data/fundamentals.json` (P/E-style multiples, thesis, sizing rationale) is
  **hand-maintained**, roughly four times a year after each earnings season, with
  an `asOf` label shown on the page so the freshness of that data is always
  visible rather than silently implied to be live.

## Stack

Plain HTML/CSS/vanilla JS, no framework and no build step — it runs by opening
`index.html` or via GitHub Pages. The only external dependency is Chart.js, loaded
from a CDN. Historical/correlation math (mean, stdev, covariance, correlation) is
a few dozen lines of vanilla JS in `app.js`, not a stats library.

## Running it locally

No build step — but the page loads its data via `fetch()`, and browsers block
`fetch()` against `file://` URLs, so double-clicking `index.html` won't load the
data (you'll see a "couldn't load portfolio data" message). Serve the folder with
any static file server instead, for example (pick whichever you have installed):

```
npx serve .              # if you have Node
python -m http.server    # if you have Python
```

...or the VS Code "Live Server" extension. GitHub Pages (the live deployment)
serves it correctly with no extra steps.

To refresh prices manually (requires Node 18+ for global `fetch`):

```
node scripts/update-prices.mjs
```

## Repo layout

```
index.html / styles.css / app.js   — the whole frontend
data/portfolio.json                — fund config: inception, holdings, cash, limits
data/prices.json                   — latest quotes + FX (auto-refreshed)
data/history.json                  — ~1y daily closes per ticker/benchmark/FX (auto-refreshed)
data/fundamentals.json             — valuation multiples, thesis, sizing rationale (manual, quarterly)
scripts/update-prices.mjs          — the price-refresh script the workflow runs
.github/workflows/update-prices.yml — daily scheduled refresh + manual trigger
```
