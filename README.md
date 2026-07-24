# SBI TT &amp; Stock Value Tracker

A tiny, dependency-light website that helps with **Indian tax filing for foreign
shares (RSU / ESPP)**. For any stock you get:

- **Peak value** in a chosen calendar year (highest price that year)
- **Year-end closing value** — price on 31 December, or the last trading day of
  the year (for the current/incomplete year, the most recent trading day)
- **Value on a specific date** you enter (nearest trading day on/before it)
- The matching **SBI TT buying rate** for each of those dates, in the stock's
  currency, **hyperlinked to that day's official SBI PDF** for cross-verification
- The **INR equivalent** (price × SBI TT buy)

Works for common US / UK / Europe / Australia / Japan stocks out of the box, and
with **any Yahoo symbol** you type (pick the country + symbol).

No login. No tracking. No personal data stored.

---

## How it works

```
 ┌──────────────┐    parsed daily    ┌───────────────────┐
 │ SBI FOREX    │ ─────────────────▶ │ data/sbi-tt.json  │  (+ archived PDFs)
 │ CARD RATES   │   update_sbi.py    └───────────────────┘
 │ (PDF)        │                              │  read by browser
 └──────────────┘                              ▼
                                        ┌──────────────┐
 ┌──────────────┐   CORS-safe proxy    │ Static site  │
 │ Yahoo v8     │ ◀─── Cloudflare ──── │ (index.html) │
 │ chart API    │      Worker          └──────────────┘
 └──────────────┘
```

- **SBI rates** are produced entirely by us (no third-party dependency at
  runtime). `scripts/update_sbi.py` downloads SBI's official
  `FOREX_CARD_RATES.pdf`, parses the **TT BUY** column per currency, stores the
  raw PDF under `data/pdf/YYYY/MM/`, and appends to `data/sbi-tt.json`.
- **Stock prices** come from Yahoo Finance's free v8 chart endpoint. Browsers
  can't call it directly (no CORS + bot filtering), so a tiny **Cloudflare
  Worker** proxies it. This is the only piece needed for live arbitrary symbols.

### Data format (`data/sbi-tt.json`)

```json
{
  "2025-01-03": {
    "rates": { "USD": 85.38, "EUR": 86.93, "JPY": 0.5391, "GBP": 104.7 },
    "pdf": "data/pdf/2025/01/2025-01-03.pdf"
  }
}
```

TT BUY is stored as **INR per single unit**. JPY/THB/KRW (quoted per 100 on the
card) are normalised automatically.

---

## Setup

### 1. Seed historical SBI data (one time)

```bash
pip install -r scripts/requirements.txt

# Pull historical rates. Default links PDFs to the public archive (small repo);
# add --copy-pdfs to vendor every PDF locally instead.
python scripts/backfill_from_reference.py --since 2020
```

### 2. Deploy the price proxy (Cloudflare Worker — free)

```bash
cd worker
npm i -g wrangler        # or: npx wrangler ...
wrangler login
wrangler deploy
```

Copy the printed `https://sbi-stock-tracker-proxy.<you>.workers.dev` URL into
`assets/config.js` → `PROXY_URL`.

### 3. Host the static site (free options)

The site is pure static files — host `index.html`, `assets/`, and `data/`
anywhere:

- **GitHub Pages** (recommended): push the repo, enable Pages → *Deploy from
  branch* → `main` / root. The included Action keeps SBI data fresh.
- **Netlify / Vercel**: drag-and-drop or connect the repo. No build step.
- **GoDaddy / any web host**: upload the folder via FTP. (For a purely static
  host, run the SBI updater on your own machine/cron and re-upload `data/`.)

### 4. Keep SBI data updated automatically

`.github/workflows/update-sbi.yml` runs `update_sbi.py` twice daily and commits
any change. On GitHub, just ensure Actions are enabled (`contents: write`
permission is already set). To run manually:

```bash
python scripts/update_sbi.py
```

---

## Security

This is a static, read-only site with no backend and no user accounts.

- **Strict Content-Security-Policy** (`index.html`): `default-src 'none'`; only
  self-hosted scripts/styles and the Cloudflare proxy over HTTPS are allowed.
- **No inline scripts/styles**, no `eval`, no third-party JS/CDN.
- **All dynamic values rendered via `textContent`** — no HTML injection / XSS.
- **Symbol input is strictly validated** (`^[A-Za-z0-9.\-^=]{1,20}$`) both in the
  browser and again in the Worker, preventing SSRF / open-proxy abuse. The Worker
  only ever contacts the fixed Yahoo host.
- **No cookies, no localStorage, no analytics, no PII** — nothing about the user
  is stored or transmitted anywhere except the anonymous price lookup.
- `referrer` set to `no-referrer`; PDF links open with `rel="noopener noreferrer"`.

---

## Project layout

```
index.html                     # UI (with CSP)
assets/
  config.js                    # PROXY_URL + data path (edit after deploy)
  stocks.js                    # quick-pick list + country→currency map
  app.js                       # all client logic
  style.css                    # modern, responsive styling
data/
  sbi-tt.json                  # parsed TT BUY rates (the "backend")
  pdf/YYYY/MM/*.pdf            # archived SBI PDFs for verification
scripts/
  sbi_common.py                # PDF parsing helpers
  update_sbi.py                # daily fetch + parse + store
  backfill_from_reference.py   # one-time historical seed
  requirements.txt
worker/
  yahoo-proxy.js               # Cloudflare Worker (price proxy)
  wrangler.toml
.github/workflows/update-sbi.yml
```

## Notes &amp; caveats

- Yahoo data is unofficial; occasional gaps/holidays are handled by falling back
  to the nearest earlier trading day.
- London (LSE) stocks quoting in pence (`GBp`) are auto-converted to GBP.
- SBI publishes rates only for major currencies; if a stock's currency isn't on
  the SBI card, the price still shows but the INR conversion is omitted.
