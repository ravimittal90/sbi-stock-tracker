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

// Local calendar date as YYYY-MM-DD — used to cap date pickers to "today" so
// no future date can be requested for prices or SBI rate cards.
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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
// Find the SBI snapshot on-or-before `dateStr` that has a PDF, and return
// { date, pdf }. Used by the standalone "PDF for any date" feature.
function sbiPdfOnOrBefore(dateStr) {
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
    if (entry && entry.pdf) return { date: d, pdf: entry.pdf };
    idx--;
  }
  return null;
}

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
// Fetch DAILY data for a bounded window. A bounded period1/period2 is required:
// with range=max Yahoo silently returns 3-month bars, breaking every date/price.
// Fetch with exponential backoff + jitter. Retries on transient upstream errors
// (429 rate-limit, 502/503/504) and network failures, so short Yahoo throttling
// during traffic bursts recovers automatically instead of failing the lookup.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
async function fetchWithRetry(url, opts, tries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) {
      const base = 400 * 2 ** (attempt - 1); // 400ms, 800ms, ...
      const wait = base + Math.floor(Math.random() * 250); // jitter
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const resp = await fetch(url, opts);
      if (RETRY_STATUSES.has(resp.status) && attempt < tries - 1) {
        lastErr = new Error(
          resp.status === 429
            ? "Data provider is busy (rate-limited). Retrying…"
            : `Upstream ${resp.status}. Retrying…`
        );
        continue;
      }
      return resp;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Network error.");
}

async function fetchSeries(symbol, fromDate, toDate, onDate) {
  if (!CFG.PROXY_URL || CFG.PROXY_URL.includes("example.workers.dev")) {
    throw new Error(
      "Price proxy not configured. Set PROXY_URL in assets/config.js."
    );
  }

  // Determine the date window we need (UTC), padded so nearest-prior-trading-day
  // lookups near the range start / the chosen date still have earlier rows to
  // fall back to.
  const DAY = 86400;
  const needStarts = [];
  const needEnds = [];
  if (fromDate && toDate) {
    needStarts.push(Date.parse(fromDate + "T00:00:00Z") / 1000);
    needEnds.push(Date.parse(toDate + "T00:00:00Z") / 1000);
  }
  if (onDate) {
    const t = Date.parse(onDate + "T00:00:00Z") / 1000;
    needStarts.push(t);
    needEnds.push(t);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  let period1 = Math.floor(Math.min(...needStarts) - 10 * DAY);
  let period2 = Math.floor(Math.min(Math.max(...needEnds) + 5 * DAY, nowSec + DAY));
  if (period1 < 0) period1 = 0;

  const url = `${CFG.PROXY_URL.replace(/\/$/, "")}/?symbol=${encodeURIComponent(
    symbol
  )}&interval=1d&period1=${period1}&period2=${period2}`;
  const resp = await fetchWithRetry(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    if (resp.status === 429) {
      throw new Error(
        "The data provider is temporarily rate-limited. Please wait a few seconds and try again."
      );
    }
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

// Fetch the company profile (registered address + business nature). Best-effort:
// resolves to null on any failure so the price results still render.
async function fetchProfile(symbol) {
  try {
    const base = (CFG.PROXY_URL || "").replace(/\/$/, "");
    const resp = await fetchWithRetry(
      `${base}/?symbol=${encodeURIComponent(symbol)}&profile=1`,
      { headers: { Accept: "application/json" } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data && data.profile ? data.profile : null;
  } catch {
    return null;
  }
}

// --- symbol autocomplete ---------------------------------------------------
// Query Yahoo (via the Worker) for company-name / symbol matches. Best-effort.
async function searchSymbols(query, signal) {
  const base = (CFG.PROXY_URL || "").replace(/\/$/, "");
  if (!base) return [];
  const resp = await fetch(
    `${base}/?search=${encodeURIComponent(query)}`,
    { headers: { Accept: "application/json" }, signal }
  );
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data && data.results) || [];
}

// ITR Schedule FA uses the ISD dialling code as the "Country Code".
// Yahoo returns the full country name, so map name -> { iso2, isd }.
const COUNTRY_CODES = {
  "United States": { iso2: "US", isd: "1" },
  "United States of America": { iso2: "US", isd: "1" },
  Canada: { iso2: "CA", isd: "1" },
  "United Kingdom": { iso2: "GB", isd: "44" },
  Ireland: { iso2: "IE", isd: "353" },
  Germany: { iso2: "DE", isd: "49" },
  France: { iso2: "FR", isd: "33" },
  Netherlands: { iso2: "NL", isd: "31" },
  Switzerland: { iso2: "CH", isd: "41" },
  Spain: { iso2: "ES", isd: "34" },
  Italy: { iso2: "IT", isd: "39" },
  Sweden: { iso2: "SE", isd: "46" },
  Denmark: { iso2: "DK", isd: "45" },
  Norway: { iso2: "NO", isd: "47" },
  Finland: { iso2: "FI", isd: "358" },
  Belgium: { iso2: "BE", isd: "32" },
  Luxembourg: { iso2: "LU", isd: "352" },
  Austria: { iso2: "AT", isd: "43" },
  Portugal: { iso2: "PT", isd: "351" },
  Australia: { iso2: "AU", isd: "61" },
  "New Zealand": { iso2: "NZ", isd: "64" },
  Japan: { iso2: "JP", isd: "81" },
  China: { iso2: "CN", isd: "86" },
  "Hong Kong": { iso2: "HK", isd: "852" },
  Singapore: { iso2: "SG", isd: "65" },
  "South Korea": { iso2: "KR", isd: "82" },
  Taiwan: { iso2: "TW", isd: "886" },
  India: { iso2: "IN", isd: "91" },
  Israel: { iso2: "IL", isd: "972" },
  Brazil: { iso2: "BR", isd: "55" },
  "South Africa": { iso2: "ZA", isd: "27" },
};

function countryCodeInfo(name) {
  if (!name) return null;
  const c = COUNTRY_CODES[name.trim()];
  if (!c) return null;
  return `${name} — ${c.isd} (ISO ${c.iso2})`;
}

function formatAddress(p) {
  const parts = [];
  if (p.address1) parts.push(p.address1);
  if (p.address2) parts.push(p.address2);
  const cityLine = [p.city, p.state, p.zip].filter(Boolean).join(" ");
  if (cityLine) parts.push(cityLine);
  if (p.country) parts.push(p.country);
  return parts.join(", ");
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
function peakForRange(rows, fromDate, toDate, factor) {
  let best = null;
  for (const r of rows) {
    if (r.date < fromDate || r.date > toDate) continue;
    const val = r.high != null ? r.high : r.close;
    if (val == null) continue;
    if (!best || val > best.value) best = { value: val * factor, date: r.date };
  }
  return best;
}

function closingForRange(rows, fromDate, toDate, factor) {
  let last = null;
  for (const r of rows) {
    if (r.date < fromDate || r.date > toDate) continue;
    if (r.close != null) last = r;
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
function yahooHistoryUrl(symbol) {
  // Yahoo's history page no longer accepts period1/period2 query params (its SPA
  // 404s on them); the canonical history path is the reliable link.
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/history`;
}

function metricCard(kind, title, priceObj, ccy, symbol) {
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
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        openPdf(sbi.pdf, sbi.date);
      });
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

  // Let the user cross-check the share price on Yahoo Finance for that date.
  if (symbol) {
    const verify = document.createElement("a");
    verify.className = "verify-link";
    verify.href = yahooHistoryUrl(symbol);
    verify.target = "_blank";
    verify.rel = "noopener noreferrer";
    verify.textContent = "Verify on Yahoo ↗";
    card.appendChild(verify);
  }
  return card;
}

function render(symbol, ccy, factor, series, fromDate, toDate, onDate) {
  const results = el("results");
  const cards = el("result-cards");
  cards.textContent = "";
  el("result-title").textContent = `${symbol} — priced in ${ccy}`;

  if (fromDate && toDate) {
    cards.appendChild(
      metricCard(
        "peak",
        `Peak (${fromDate} → ${toDate})`,
        peakForRange(series.rows, fromDate, toDate, factor),
        ccy,
        symbol
      )
    );
    cards.appendChild(
      metricCard(
        "close",
        `Closing (as of ${toDate})`,
        closingForRange(series.rows, fromDate, toDate, factor),
        ccy,
        symbol
      )
    );
  }
  if (onDate) {
    cards.appendChild(
      metricCard(
        "ondate",
        `Value on ${onDate}`,
        valueOnDate(series.rows, onDate, factor),
        ccy,
        symbol
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

// Render the company profile card (for ITR Schedule FA: name, registered
// address, nature of business). Clears itself while a fresh lookup is pending.
function renderProfile(profile) {
  const box = el("company-info");
  box.textContent = "";
  if (!profile) {
    box.hidden = true;
    return;
  }

  const h3 = document.createElement("h3");
  h3.textContent = profile.name || "Company details";
  box.appendChild(h3);

  const grid = document.createElement("div");
  grid.className = "company-grid";

  const addRow = (label, value, isLink) => {
    if (!value) return;
    const row = document.createElement("div");
    row.className = "company-row";
    const k = document.createElement("span");
    k.className = "company-k";
    k.textContent = label;
    const v = document.createElement("span");
    v.className = "company-v";
    if (isLink) {
      const a = document.createElement("a");
      a.href = value;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = value;
      v.appendChild(a);
    } else {
      v.textContent = value;
    }
    row.appendChild(k);
    row.appendChild(v);
    grid.appendChild(row);
  };

  addRow("Registered address", formatAddress(profile));
  addRow("ZIP / Postal code", profile.zip);
  addRow("Country code (Schedule FA)", countryCodeInfo(profile.country));
  const business = [profile.sector, profile.industry].filter(Boolean).join(" · ");
  addRow("Nature of business", business);
  addRow("Website", profile.website, true);
  box.appendChild(grid);

  // Schedule FA helper (RSU/ESPP guidance).
  const fa = document.createElement("p");
  fa.className = "fa-note";
  fa.textContent =
    "Schedule FA (ITR) tip: for vested RSUs/ESPP of a listed foreign company, " +
    "the “Nature of entity” is usually “Listed Equity Shares — Foreign”. Use the " +
    "registered address, ZIP and country code above (the country code is the " +
    "country’s ISD dialling code), and the SBI TT buy rate for INR conversion. " +
    "This is general information, not tax advice.";
  box.appendChild(fa);

  box.hidden = false;
}

// --- form handling ---------------------------------------------------------
async function onSubmit(ev) {
  ev.preventDefault();
  let symbol = el("symbol").value.trim();
  const fromDate = el("from-date").value || null;
  const toDate = el("to-date").value || null;
  const onDate = el("on-date").value || null;

  // If the user typed a company name (not a valid ticker) and didn't pick a
  // suggestion, resolve it to the best-matching symbol via Yahoo search.
  if (!SYMBOL_RE.test(symbol)) {
    if (symbol.length < 2) {
      setStatus("Type a company name or stock symbol.", true);
      return;
    }
    setStatus("Finding matching stock…");
    let matches = [];
    try {
      matches = await searchSymbols(symbol);
    } catch {
      /* fall through to error below */
    }
    if (!matches.length) {
      setStatus(
        "No matching stock found. Try a different name, or type the exact symbol.",
        true
      );
      return;
    }
    symbol = matches[0].symbol;
    el("symbol").value = symbol;
  }

  if ((fromDate || toDate) && !(fromDate && toDate)) {
    setStatus("Enter both a From date and a To date for the range.", true);
    return;
  }
  if (!fromDate && !onDate) {
    setStatus("Pick a date range and/or a specific date.", true);
    return;
  }
  const today = todayStr();
  if ((fromDate && fromDate > today) || (toDate && toDate > today) || (onDate && onDate > today)) {
    setStatus("Dates can't be in the future.", true);
    return;
  }
  if (fromDate && toDate && fromDate > toDate) {
    setStatus("The From date must be on or before the To date.", true);
    return;
  }

  el("go").disabled = true;
  el("results").hidden = true;
  el("company-info").hidden = true;
  setStatus("Fetching prices…");
  try {
    const [series, profile] = await Promise.all([
      fetchSeries(symbol, fromDate, toDate, onDate),
      fetchProfile(symbol),
    ]);
    const { ccy, factor } = normaliseCurrency(series.meta);
    setStatus(`Loaded ${series.rows.length} trading days.`);
    render(symbol, ccy, factor, series, fromDate, toDate, onDate);
    renderProfile(profile);
  } catch (err) {
    setStatus(err.message || "Something went wrong.", true);
  } finally {
    el("go").disabled = false;
  }
}

// --- PDF viewer (in-page modal) --------------------------------------------
// Local (same-origin) PDFs render inline directly. External SBI PDFs are
// served by GitHub raw as octet-stream (forces download), so we route them
// through the Worker which re-serves them as application/pdf.
function pdfViewerSrc(pdf) {
  if (/^https?:\/\//i.test(pdf)) {
    const base = (CFG.PROXY_URL || "").replace(/\/$/, "");
    return `${base}/?pdf=${encodeURIComponent(pdf)}`;
  }
  return pdf; // relative local path
}

// Download URL. Local PDFs use the anchor's `download` attribute directly;
// external PDFs go through the Worker with dl=1 so it sends an attachment
// disposition (the `download` attribute is ignored cross-origin).
function pdfDownloadSrc(pdf, date) {
  if (/^https?:\/\//i.test(pdf)) {
    const base = (CFG.PROXY_URL || "").replace(/\/$/, "");
    const name = `SBI-FOREX-CARD-RATES-${date}.pdf`;
    return `${base}/?pdf=${encodeURIComponent(pdf)}&dl=1&name=${encodeURIComponent(
      name
    )}`;
  }
  return pdf;
}

function openPdf(pdf, date) {
  const modal = el("pdf-modal");
  const frame = el("pdf-frame");
  const openTab = el("pdf-open-tab");
  const dl = el("pdf-download");
  el("pdf-title").textContent = `SBI FOREX CARD RATES — ${date}`;
  const src = pdfViewerSrc(pdf);
  frame.src = src;
  openTab.href = src;
  dl.href = pdfDownloadSrc(pdf, date);
  dl.setAttribute("download", `SBI-FOREX-CARD-RATES-${date}.pdf`);
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closePdf() {
  const modal = el("pdf-modal");
  if (modal.hidden) return;
  modal.hidden = true;
  el("pdf-frame").src = "about:blank";
  document.body.style.overflow = "";
}

// --- Standalone: SBI TT rate PDF for any picked date -----------------------
function onSbiPdfSubmit(ev) {
  ev.preventDefault();
  const status = el("sbi-pdf-status");
  const dl = el("sbi-download");
  dl.hidden = true;
  const picked = el("sbi-date").value;
  if (!picked) {
    status.textContent = "Please pick a date.";
    status.classList.add("error");
    return;
  }
  if (picked > todayStr()) {
    status.classList.add("error");
    status.textContent = "Dates can't be in the future.";
    return;
  }
  const hit = sbiPdfOnOrBefore(picked);
  if (!hit) {
    status.classList.add("error");
    status.textContent =
      "No SBI rate card is available on or before that date in our records.";
    return;
  }
  status.classList.remove("error");
  const exact = hit.date === picked;
  status.textContent = exact
    ? `Showing the SBI rate card published on ${hit.date}.`
    : `No card published exactly on ${picked}; showing the applicable card from ${hit.date}.`;

  // Wire the download button (works for both local + proxied external PDFs).
  dl.href = pdfDownloadSrc(hit.pdf, hit.date);
  dl.setAttribute("download", `SBI-FOREX-CARD-RATES-${hit.date}.pdf`);
  dl.hidden = false;

  openPdf(hit.pdf, hit.date);
}

// --- Feedback: open the visitor's email app with a prefilled message -------
// Fully dependency-free: no backend, no third-party mail service. Just a
// mailto: link with the message pre-filled as the body.
function onFeedbackSubmit(ev) {
  ev.preventDefault();
  const msg = el("fb-message").value.trim();
  const subject = "SBI TT & Stock Tracker — feedback";
  const body = msg || "";
  const href = `mailto:ravi7680@gmail.com?subject=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(body)}`;
  window.location.href = href;
}

// --- init ------------------------------------------------------------------
function populateCountries() {
  const sel = el("country");
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "— optional —";
  sel.appendChild(blank);
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

// Wire the company/symbol autocomplete dropdown onto the #symbol input.
function setupAutocomplete() {
  const input = el("symbol");
  const box = el("symbol-suggest");
  if (!input || !box) return;

  const cache = new Map(); // query -> results (per-browser, instant re-type)
  let items = [];
  let active = -1;
  let timer = null;
  let controller = null;
  let lastQuery = "";

  const close = () => {
    box.hidden = true;
    box.textContent = "";
    input.setAttribute("aria-expanded", "false");
    active = -1;
    items = [];
  };

  const choose = (it) => {
    if (!it) return;
    input.value = it.symbol;
    input.dataset.resolved = it.symbol;
    el("quick-pick").value = ""; // typed/searched stock ≠ a quick-pick entry
    close();
  };

  const render = (results) => {
    box.textContent = "";
    items = results;
    active = -1;
    if (!results.length) {
      close();
      return;
    }
    results.forEach((it, i) => {
      const li = document.createElement("li");
      li.className = "suggest-item";
      li.setAttribute("role", "option");
      li.id = `sugg-${i}`;
      const name = document.createElement("span");
      name.className = "sugg-name";
      name.textContent = it.name;
      const meta = document.createElement("span");
      meta.className = "sugg-meta";
      meta.textContent = `${it.symbol}${it.exchange ? " · " + it.exchange : ""}`;
      li.appendChild(name);
      li.appendChild(meta);
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault(); // keep focus; fire before blur
        choose(it);
      });
      box.appendChild(li);
    });
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  const run = async (q) => {
    if (cache.has(q)) {
      render(cache.get(q));
      return;
    }
    if (controller) controller.abort();
    controller = new AbortController();
    try {
      const results = await searchSymbols(q, controller.signal);
      cache.set(q, results);
      if (input.value.trim() === q) render(results); // ignore stale
    } catch {
      /* aborted or network error: leave dropdown as-is */
    }
  };

  const setActive = (i) => {
    const lis = box.querySelectorAll(".suggest-item");
    lis.forEach((li) => li.classList.remove("active"));
    active = i;
    if (i >= 0 && lis[i]) {
      lis[i].classList.add("active");
      input.setAttribute("aria-activedescendant", lis[i].id);
    }
  };

  input.addEventListener("input", () => {
    input.dataset.resolved = ""; // typing invalidates a prior pick
    el("quick-pick").value = ""; // clear the common-stock selection to avoid confusion
    const q = input.value.trim();
    lastQuery = q;
    if (timer) clearTimeout(timer);
    if (q.length < 2) {
      close();
      return;
    }
    timer = setTimeout(() => {
      if (input.value.trim() === q) run(q);
    }, 250);
  });

  input.addEventListener("keydown", (ev) => {
    if (box.hidden) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setActive(Math.min(active + 1, items.length - 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActive(Math.max(active - 1, 0));
    } else if (ev.key === "Enter") {
      if (active >= 0 && items[active]) {
        ev.preventDefault();
        choose(items[active]);
      }
    } else if (ev.key === "Escape") {
      close();
    }
  });

  input.addEventListener("blur", () => setTimeout(close, 120));
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

// --- Custom date-range picker ----------------------------------------------
// Dependency-free dual-calendar range popover (strict CSP: no libraries). Writes
// the chosen range into the hidden #from-date / #to-date inputs that onSubmit
// reads, and shows "YYYY-MM-DD ~ YYYY-MM-DD" in the visible readonly box.
const DR = { from: null, to: null, viewFrom: null, viewTo: null };
const DR_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DR_DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const pad2 = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`; // m is 0-based
function parseIso(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
const firstOfMonth = (iso) => {
  const d = parseIso(iso);
  return new Date(d.getFullYear(), d.getMonth(), 1);
};

function drUpdateInput() {
  const inp = el("daterange-input");
  if (DR.from && DR.to) inp.value = `${DR.from} ~ ${DR.to}`;
  else if (DR.from) inp.value = `${DR.from} ~ …`;
  else inp.value = "";
}

// Commit the current from/to into the hidden inputs consumed by onSubmit.
function drSyncInputs() {
  el("from-date").value = DR.from || "";
  el("to-date").value = DR.to || "";
  drUpdateInput();
}

function drSetRange(from, to) {
  DR.from = from;
  DR.to = to;
  drSyncInputs();
}

function drRenderCal(container, which) {
  const view = which === "from" ? DR.viewFrom : DR.viewTo;
  const y = view.getFullYear();
  const m = view.getMonth();
  const today = todayStr();
  container.textContent = "";

  const head = document.createElement("div");
  head.className = "dr-cal-head";
  head.textContent = which === "from" ? "From" : "To";
  container.appendChild(head);

  const titleRow = document.createElement("div");
  titleRow.className = "dr-title-row";
  const mkNav = (label, step) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dr-nav";
    b.textContent = label;
    b.dataset.nav = which;
    b.dataset.step = String(step);
    return b;
  };
  const navL = document.createElement("div");
  navL.className = "dr-navs";
  navL.appendChild(mkNav("«", -12));
  navL.appendChild(mkNav("‹", -1));
  const navR = document.createElement("div");
  navR.className = "dr-navs";
  navR.appendChild(mkNav("›", 1));
  navR.appendChild(mkNav("»", 12));
  const title = document.createElement("span");
  title.textContent = `${DR_MONTHS[m]} ${y}`;
  titleRow.appendChild(navL);
  titleRow.appendChild(title);
  titleRow.appendChild(navR);
  container.appendChild(titleRow);

  const grid = document.createElement("div");
  grid.className = "dr-grid";
  DR_DOW.forEach((d) => {
    const c = document.createElement("div");
    c.className = "dr-dow";
    c.textContent = d;
    grid.appendChild(c);
  });

  const startDow = new Date(y, m, 1).getDay();
  for (let i = 0; i < 42; i++) {
    const cell = new Date(y, m, i - startDow + 1); // JS normalises overflow
    const inMonth = cell.getMonth() === m;
    const iso = isoOf(cell.getFullYear(), cell.getMonth(), cell.getDate());
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dr-day";
    b.textContent = String(cell.getDate());
    b.dataset.date = iso;
    b.dataset.which = which;

    let disabled = false;
    if (!inMonth) {
      b.classList.add("dr-muted");
      disabled = true;
    }
    if (iso > today) disabled = true; // no future dates
    if (which === "to" && DR.from && iso < DR.from) disabled = true;
    if (disabled) b.disabled = true;

    if (iso === DR.from || iso === DR.to) b.classList.add("dr-sel");
    else if (DR.from && DR.to && iso > DR.from && iso < DR.to && inMonth)
      b.classList.add("dr-in-range");

    grid.appendChild(b);
  }
  container.appendChild(grid);
}

function drRender() {
  drRenderCal(el("dr-cal-from"), "from");
  drRenderCal(el("dr-cal-to"), "to");
}

function drOpen() {
  const pop = el("daterange-pop");
  if (!pop.hidden) return;
  const base = DR.from ? firstOfMonth(DR.from) : firstOfMonth(todayStr());
  DR.viewFrom = base;
  DR.viewTo = DR.to ? firstOfMonth(DR.to) : base;
  drRender();
  pop.hidden = false;
  el("daterange-input").setAttribute("aria-expanded", "true");
}

function drClose() {
  const pop = el("daterange-pop");
  if (pop.hidden) return;
  pop.hidden = true;
  el("daterange-input").setAttribute("aria-expanded", "false");
}

// Quick-pick chips: the current year + the 3 previous years. The current year
// fills 1 Jan → today; past years fill the full 1 Jan – 31 Dec.
function drRenderQuick() {
  const wrap = el("dr-quick");
  wrap.textContent = "";
  const cur = new Date().getFullYear();
  [cur, cur - 1, cur - 2, cur - 3].forEach((yv, idx) => {
    if (idx > 0) {
      const s = document.createElement("span");
      s.className = "dr-sep";
      s.textContent = "|";
      wrap.appendChild(s);
    }
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = String(yv);
    b.dataset.year = String(yv);
    wrap.appendChild(b);
  });
}

function drApplyYear(yv) {
  const from = `${yv}-01-01`;
  const to = yv === new Date().getFullYear() ? todayStr() : `${yv}-12-31`;
  drSetRange(from, to);
  DR.viewFrom = firstOfMonth(from);
  DR.viewTo = firstOfMonth(to);
  drRender();
}

function setupDateRange() {
  drRenderQuick();
  const input = el("daterange-input");
  const pop = el("daterange-pop");

  const toggle = () => (pop.hidden ? drOpen() : drClose());
  input.addEventListener("click", toggle);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      toggle();
    }
  });

  pop.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.dataset && t.dataset.year) {
      drApplyYear(parseInt(t.dataset.year, 10));
      drClose();
      return;
    }
    if (t.dataset && t.dataset.nav) {
      const which = t.dataset.nav;
      const step = parseInt(t.dataset.step, 10);
      const v = which === "from" ? DR.viewFrom : DR.viewTo;
      const nv = new Date(v.getFullYear(), v.getMonth() + step, 1);
      if (which === "from") DR.viewFrom = nv;
      else DR.viewTo = nv;
      drRender();
      return;
    }
    if (t.classList.contains("dr-day") && !t.disabled) {
      const iso = t.dataset.date;
      if (t.dataset.which === "from") {
        DR.from = iso;
        if (DR.to && DR.from > DR.to) DR.to = null;
        DR.viewFrom = firstOfMonth(iso);
        if (!DR.to) DR.viewTo = firstOfMonth(iso);
      } else {
        if (DR.from && iso < DR.from) return;
        DR.to = iso;
        DR.viewTo = firstOfMonth(iso);
      }
      drSyncInputs();
      drRender();
    }
  });

  document.addEventListener("click", (ev) => {
    if (pop.hidden) return;
    if (!el("daterange").contains(ev.target)) drClose();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") drClose();
  });
}

function init() {
  populateCountries();
  populateQuickPick();
  setupAutocomplete();
  setupDateRange();

  // Cap the remaining native date pickers to today — no future dates.
  const today = todayStr();
  ["on-date", "sbi-date"].forEach((id) => {
    const input = el(id);
    if (input) input.max = today;
  });

  el("lookup-form").addEventListener("submit", onSubmit);
  el("sbi-pdf-form").addEventListener("submit", onSbiPdfSubmit);
  el("feedback-form").addEventListener("submit", onFeedbackSubmit);

  // PDF modal close handlers.
  el("pdf-close").addEventListener("click", closePdf);
  el("pdf-modal").addEventListener("click", (ev) => {
    if (ev.target.dataset.close) closePdf();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closePdf();
  });

  // Prefill a sensible default (Microsoft, previous calendar year range) and run
  // the lookup once SBI rate data is loaded so the INR conversion also shows.
  const prevYear = new Date().getFullYear() - 1;
  el("symbol").value = "MSFT";
  el("quick-pick").value = "MSFT";
  el("country").value = "US";
  drSetRange(`${prevYear}-01-01`, `${prevYear}-12-31`);
  loadSbi().then(() => {
    el("lookup-form").requestSubmit();
  });
}

document.addEventListener("DOMContentLoaded", init);
