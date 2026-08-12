#!/usr/bin/env node
// Refreshes data/prices.json and data/history.json from Yahoo Finance's public
// (unofficial, key-less) chart endpoint. Runs server-side in GitHub Actions, so
// there's no CORS concern and no API key to manage — see README.md for why this
// approach was chosen over a browser-side fetch or a paid API.
//
// Design goal: never leave the site worse off than before a run. If a symbol
// fails to fetch, we keep its last-known-good data and log a warning instead of
// throwing, so a single flaky ticker (or a temporary Yahoo block) can't brick
// the whole dashboard.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const PRICES_PATH = path.join(DATA_DIR, "prices.json");
const HISTORY_PATH = path.join(DATA_DIR, "history.json");

const EQUITY_TICKERS = [
  "NOD.OL",
  "EVO.ST",
  "NOVO-B.CO",
  "INVE-B.ST",
  "DNB.OL",
  "EQNR.OL",
  "OSEBX.OL",
];
const FX_TICKERS = ["SEKNOK=X", "DKKNOK=X"];
const ALL_TICKERS = [...EQUITY_TICKERS, ...FX_TICKERS];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
};

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

/** Fetches ~1 trading year of daily closes for one Yahoo symbol. */
async function fetchDailySeries(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=1d&range=1y`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const error = json?.chart?.error;
  if (error) throw new Error(error.description || "Yahoo chart error");
  if (!result) throw new Error("empty chart result");

  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const series = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null) continue;
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    series.push({ date, close: Math.round(close * 10000) / 10000 });
  }
  if (series.length === 0) throw new Error("no daily closes returned");
  return series;
}

async function main() {
  const existingHistory = await readJson(HISTORY_PATH, {});
  const existingPrices = await readJson(PRICES_PATH, { quotes: {}, fx: {} });

  const history = { ...existingHistory };
  const failures = [];

  for (const symbol of ALL_TICKERS) {
    try {
      const series = await fetchDailySeries(symbol);
      history[symbol] = series;
      console.log(`ok   ${symbol.padEnd(12)} ${series.length} points, latest ${series.at(-1).date} = ${series.at(-1).close}`);
    } catch (err) {
      failures.push(symbol);
      console.warn(`FAIL ${symbol.padEnd(12)} ${err.message} — keeping last-known data`);
    }
  }

  // Derive prices.json (latest + previous close) from whatever history we have,
  // fresh or carried-over.
  const quotes = { ...existingPrices.quotes };
  for (const symbol of EQUITY_TICKERS) {
    const series = history[symbol];
    if (!series || series.length === 0) continue;
    const latest = series.at(-1);
    const prev = series.length > 1 ? series.at(-2) : latest;
    quotes[symbol] = { price: latest.close, previousClose: prev.close };
  }

  const fx = { ...existingPrices.fx };
  const sekSeries = history["SEKNOK=X"];
  const dkkSeries = history["DKKNOK=X"];
  if (sekSeries?.length) fx.SEKNOK = sekSeries.at(-1).close;
  if (dkkSeries?.length) fx.DKKNOK = dkkSeries.at(-1).close;

  const prices = {
    lastUpdated: new Date().toISOString(),
    source: "Yahoo Finance chart API (unofficial, fetched server-side in GitHub Actions)",
    ...(failures.length ? { failedSymbols: failures } : {}),
    fx,
    quotes,
  };

  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
  await writeFile(PRICES_PATH, JSON.stringify(prices, null, 2) + "\n");

  console.log(`\nDone. ${ALL_TICKERS.length - failures.length}/${ALL_TICKERS.length} symbols refreshed.`);
  if (failures.length) {
    console.warn(`Symbols kept on last-known data: ${failures.join(", ")}`);
  }
}

main().catch((err) => {
  console.error("update-prices.mjs failed:", err);
  process.exit(1);
});
