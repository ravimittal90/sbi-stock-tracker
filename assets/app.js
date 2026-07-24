"use strict";

// ---------------------------------------------------------------------------
// SBI TT & Stock Value Tracker — client logic (no framework, no dependencies).
// All dynamic values are written via textContent to prevent XSS.
// ---------------------------------------------------------------------------

const CFG = window.APP_CONFIG || {};
const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,20}$/;

// SBI store: { "YYYY-MM-DD": { rates: {USD: 96.1, ...}, pdf: "url|path" } }
let SBI = {};
let SBI_DATES = []; // sorted ascending

const el = (id) => document.getElementById(id);
const statusEl = () => el("status");

function setStatus(msg, isError) {
  const s = statusEl();
  s.textContent = msg || "";
  s.classList.toggle("error", !!isError);
}

// --- number / currency formatting -----------------------------------------
function fmt(n, currency) {
  if (n == null || Number.isNaN(n)) return "—";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}
function fmtINR(n) {
  return fmt(n, "INR");
}

// --- SBI lookups -----------------------------------------------------------
// Find the SBI snapshot on-or-before `dateStr` and return its TT BUY for `ccy`.
function sbiOnOrBefore(dateStr, ccy) {
  if (!SBI_DATES.length) return null;
  let lo = 0,
    hi = SBI_DATES.length - 1,
    idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (SBI_DATES[mid] <= dateStr) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  while (idx >= 0) {
    const d = SBI_DATES[idx];
    const entry = SBI[d];
    const rate = entry && entry.rates ? entry.rates[ccy] : undefined;
    if (rate != null) return { date: d, rate, pdf: entry.pdf || null };
    idx--;
  }
  return null;
}

// --- Yahoo proxy fetch -----------------------------------------------------
async function fetchSeries(symbol) {
  if (!CFG.PROXY_URL || CFG.PROXY_URL.includes("example.workers.dev")) {
    throw new Error(
      "Price proxy not configured. Set PROXY_URL in assets/config.js."
    );
  }
  const url = `${CFG.PROXY_URL.replace(/\/$/, "")}/?symbol=${encodeURIComponent(
    symbol
  )}&interval=1d`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `Lookup failed (${resp.status}).`);
  }
  const data = await resp.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result || !result.timestamp) {
    throw new Error("No price data for that symbol.");
  }
  const meta = result.meta || {};
  const q = (result.indicators.quote && result.indicators.quote[0]) || {};
  const rows = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const close = q.close ? q.close[i] : null;
    const high = q.high ? q.high[i] : null;
    const low = q.low ? q.low[i] : null;
    if (close == null && high == null) continue;
    const d = new Date(result.timestamp[i] * 1000);
    const iso = d.toISOString().slice(0, 10);
    rows.push({ date: iso, close, high, low });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { meta, rows };
}

// London stocks quote in pence (GBp). Normalise to GBP for display + SBI.
function normaliseCurrency(meta) {
  let ccy = meta.currency || "USD";
  let factor = 1;
  if (ccy === "GBp") {
    ccy = "GBP";
    factor = 0.01;
  } else if (ccy === "ZAc") {
    ccy = "ZAR";
    factor = 0.01;
  }
  return { ccy, factor };
}

// --- core computations -----------------------------------------------------
function peakForYear(rows, year, factor) {
  let best = null;
  for (const r of rows) {
    if (!r.date.startsWith(String(year))) continue;
    const val = r.high != null ? r.high : r.close;
    if (val == null) continue;
    if (!best || val > best.value) best = { value: val * factor, date: r.date };
  }
  return best;
}

function closingForYear(rows, year, factor) {
  const target = `${year}-12-31`;
  let last = null;
  for (const r of rows) {
    if (!r.date.startsWith(String(year))) continue;
    if (r.date <= target && r.close != null) last = r;
  }
  if (!last) return null;
  return { value: last.close * factor, date: last.date };
}

function valueOnDate(rows, dateStr, factor) {
  let chosen = null;
  for (const r of rows) {
    if (r.date <= dateStr && r.close != null) chosen = r;
    else if (r.date > dateStr) break;
  }
  if (!chosen) return null;
  return { value: chosen.close * factor, date: chosen.date };
}

// --- rendering -------------------------------------------------------------
function metricCard(kind, title, priceObj, ccy) {
  const card = document.createElement("div");
  card.className = `metric ${kind}`;

  const h3 = document.createElement("h3");
  h3.textContent = title;
  card.appendChild(h3);

  if (!priceObj) {
    const p = document.createElement("p");
    p.className = "sub";
    p.textContent = "No data available.";
    card.appendChild(p);
    return card;
  }

  const big = document.createElement("p");
  big.className = "big";
  big.textContent = fmt(priceObj.value, ccy);
  card.appendChild(big);

  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = `as on ${priceObj.date}`;
  card.appendChild(sub);

  // SBI TT BUY for this date + INR conversion.
  const sbi = sbiOnOrBefore(priceObj.date, ccy);
  const rateLine = document.createElement("p");
  rateLine.className = "sub";
  if (sbi) {
    rateLine.appendChild(document.createTextNode("SBI TT buy: "));
    if (sbi.pdf) {
      const a = document.createElement("a");
      a.href = sbi.pdf;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = `₹${sbi.rate} / ${ccy} (${sbi.date})`;
      rateLine.appendChild(a);
    } else {
      rateLine.appendChild(
        document.createTextNode(`₹${sbi.rate} / ${ccy} (${sbi.date})`)
      );
    }
    card.appendChild(rateLine);

    const inr = document.createElement("p");
    inr.className = "inr";
    inr.textContent = `≈ ${fmtINR(priceObj.value * sbi.rate)}`;
    card.appendChild(inr);
  } else {
    rateLine.textContent = `No SBI TT rate for ${ccy} near this date.`;
    card.appendChild(rateLine);
  }
  return card;
}

function render(symbol, ccy, factor, series, year, onDate) {
  const results = el("results");
  const cards = el("result-cards");
  cards.textContent = "";
  el("result-title").textContent = `${symbol} — priced in ${ccy}`;

  if (year) {
    cards.appendChild(
      metricCard("peak", `Peak in ${year}`, peakForYear(series.rows, year, factor), ccy)
    );
    cards.appendChild(
      metricCard(
        "close",
        `Year-end close ${year}`,
        closingForYear(series.rows, year, factor),
        ccy
      )
    );
  }
  if (onDate) {
    cards.appendChild(
      metricCard(
        "ondate",
        `Value on ${onDate}`,
        valueOnDate(series.rows, onDate, factor),
        ccy
      )
    );
  }

  const note = el("currency-note");
  note.textContent =
    factor !== 1
      ? `Note: ${symbol} is quoted in minor units on its exchange; values shown are converted to ${ccy}.`
      : "";
  results.hidden = false;
}

// --- form handling ---------------------------------------------------------
async function onSubmit(ev) {
  ev.preventDefault();
  const symbol = el("symbol").value.trim();
  const year = el("year").value ? parseInt(el("year").value, 10) : null;
  const onDate = el("on-date").value || null;

  if (!SYMBOL_RE.test(symbol)) {
    setStatus("Please enter a valid Yahoo symbol (letters, digits, . - ^ =).", true);
    return;
  }
  if (!year && !onDate) {
    setStatus("Enter a calendar year and/or a specific date.", true);
    return;
  }
  if (year && (year < 1990 || year > 2100)) {
    setStatus("Year looks out of range.", true);
    return;
  }

  el("go").disabled = true;
  el("results").hidden = true;
  setStatus("Fetching prices…");
  try {
    const series = await fetchSeries(symbol);
    const { ccy, factor } = normaliseCurrency(series.meta);
    setStatus(`Loaded ${series.rows.length} trading days.`);
    render(symbol, ccy, factor, series, year, onDate);
  } catch (err) {
    setStatus(err.message || "Something went wrong.", true);
  } finally {
    el("go").disabled = false;
  }
}

// --- init ------------------------------------------------------------------
function populateCountries() {
  const sel = el("country");
  const map = window.COUNTRY_CURRENCY || {};
  Object.keys(map).forEach((code) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${code} (${map[code]})`;
    sel.appendChild(opt);
  });
}

function populateQuickPick() {
  const sel = el("quick-pick");
  (window.STOCKS || []).forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.symbol;
    opt.dataset.country = s.country;
    opt.textContent = `${s.name} — ${s.symbol}`;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", () => {
    const opt = sel.options[sel.selectedIndex];
    if (!opt.value) return;
    el("symbol").value = opt.value;
    if (opt.dataset.country) el("country").value = opt.dataset.country;
  });
}

async function loadSbi() {
  try {
    const resp = await fetch(CFG.SBI_DATA_URL || "data/sbi-tt.json");
    if (!resp.ok) throw new Error();
    SBI = await resp.json();
    SBI_DATES = Object.keys(SBI).sort();
  } catch {
    setStatus("Warning: SBI rate data could not be loaded.", true);
  }
}

function init() {
  populateCountries();
  populateQuickPick();
  loadSbi();
  el("lookup-form").addEventListener("submit", onSubmit);
}

document.addEventListener("DOMContentLoaded", init);
