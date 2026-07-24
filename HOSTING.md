# Hosting Guide — SBI TT &amp; Stock Value Tracker

Complete, ordered steps to take this project live for free. Two things get
deployed: (1) the **Cloudflare Worker** price proxy, and (2) the **static site**
(GitHub Pages recommended).

---

## Step 1 — Deploy the price proxy (Cloudflare Worker, free)

The site cannot fetch live stock prices without this proxy.

```powershell
cd C:\Users\ravi.mittal\sbi-stock-tracker\worker
npm install -g wrangler
wrangler login          # opens a browser; create a free Cloudflare account if needed
wrangler deploy
```

### First-time only: register your workers.dev subdomain

If you see:

```
[WARNING] You need to register a workers.dev subdomain before publishing to workers.dev
```

do this once:

1. Open the Cloudflare dashboard: <https://dash.cloudflare.com>
2. Go to **Workers &amp; Pages → Overview**.
3. You'll be prompted to **register a subdomain** — pick any available name,
   e.g. `ravmittal`. This becomes `*.ravmittal.workers.dev`.
4. Click **Set up / Register** (takes a few seconds to propagate).
   - Direct link if the prompt doesn't appear:
     <https://dash.cloudflare.com/?to=/:account/workers/onboarding>
5. Re-run `wrangler deploy`.

Your worker publishes at:
`https://sbi-stock-tracker-proxy.<your-subdomain>.workers.dev`

### Wire the proxy into the site

Edit `assets/config.js` and set `PROXY_URL` to that full URL:

```js
window.APP_CONFIG = {
  PROXY_URL: "https://sbi-stock-tracker-proxy.<your-subdomain>.workers.dev",
  SBI_DATA_URL: "data/sbi-tt.json",
};
```

---

## Step 2 — Push the project to GitHub

```powershell
cd C:\Users\ravi.mittal\sbi-stock-tracker
git init
git add .
git commit -m "Initial commit"
# Create an EMPTY repo on github.com first (no README), then:
git remote add origin https://github.com/<you>/sbi-stock-tracker.git
git branch -M main
git push -u origin main
```

---

## Step 3 — Enable GitHub Pages (free hosting + auto-updates)

1. On GitHub: **Settings → Pages**.
2. **Build and deployment → Source: Deploy from a branch**.
3. Branch: **`main`**, folder: **`/ (root)`** → **Save**.
4. Wait ~1 minute. Your site goes live at:
   `https://<you>.github.io/sbi-stock-tracker/`

### Allow the daily updater to commit

So the twice-daily SBI rate job can push new data:

- **Settings → Actions → General → Workflow permissions →
  "Read and write permissions"** → Save.

The workflow `.github/workflows/update-sbi.yml` then runs automatically (09:15 &amp;
14:15 IST) and commits any new rates. Run it manually anytime from the
**Actions** tab → *Update SBI TT rates* → **Run workflow**.

---

## Optional — nicer URLs

- **Shorter GitHub URL:** rename the repo to `<you>.github.io` →
  site becomes `https://<you>.github.io/` (no `/sbi-stock-tracker` subpath).
- **Custom domain** (e.g. from GoDaddy): **Settings → Pages → Custom domain**,
  then add the DNS records GitHub shows (a `CNAME`, or `A` records for an apex
  domain) at your registrar. Free hosting; you only pay for the domain.
- **Custom proxy domain:** in Cloudflare, Workers → your worker → **Triggers →
  Custom Domains**. If you do this, also update `PROXY_URL` in
  `assets/config.js` and the `connect-src` in `index.html`'s CSP.

---

## Alternative hosts

### Netlify / Vercel (free)
Drag-and-drop the folder or connect the GitHub repo. No build step needed.
You still need the Cloudflare Worker (Step 1) for live prices, **or** you can
port `worker/yahoo-proxy.js` to a Netlify/Vercel serverless function.

### GoDaddy / any classic web host (FTP)
Upload `index.html`, `assets/`, and `data/` via FTP. Works fine, **but** a
static host can't run the Python updater. Keep SBI data fresh by running the
updater on your own machine and re-uploading `data/`:

```powershell
cd C:\Users\ravi.mittal\sbi-stock-tracker
python scripts\update_sbi.py
# then re-upload the data/ folder
```

---

## Post-deploy checklist

- [ ] Worker deployed; `PROXY_URL` set in `assets/config.js`.
- [ ] Repo pushed to GitHub.
- [ ] Pages enabled; site loads.
- [ ] Actions workflow permissions set to read/write.
- [ ] Test a lookup (e.g. `MSFT`, year `2024`) — peak/close/on-date + SBI TT
      rate and INR value all appear.
- [ ] Click an SBI TT rate link — the source PDF opens.

---

## Update / redeploy later

- **Site or data change:** `git add . ; git commit -m "update" ; git push`
  (GitHub Pages redeploys automatically).
- **Proxy change:** edit `worker/yahoo-proxy.js`, then
  `cd worker ; wrangler deploy`.
