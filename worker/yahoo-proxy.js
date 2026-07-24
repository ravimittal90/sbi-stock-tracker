/**
 * Cloudflare Worker: minimal, hardened proxy for the Yahoo Finance v8 chart API.
 *
 * Browsers cannot call query1.finance.yahoo.com directly (no CORS headers, and
 * Yahoo blocks blank User-Agents). This worker fetches server-side and returns
 * JSON with permissive CORS so the static site can consume it.
 *
 * Security measures:
 *   - Only GET is allowed.
 *   - Symbol is strictly validated (letters/digits/.-^ up to 20 chars) to stop
 *     SSRF / path traversal / open-proxy abuse.
 *   - period1/period2 must be integers; interval is whitelisted.
 *   - We ONLY ever hit the fixed Yahoo chart host; the client cannot pick a URL.
 *   - Small in-worker cache + CORS restricted to configured origins.
 *
 * Deploy: `npx wrangler deploy` (see README). Free plan is sufficient.
 */

const YAHOO_HOST = "https://query1.finance.yahoo.com/v8/finance/chart/";
const YAHOO_QS = "https://query2.finance.yahoo.com/v10/finance/quoteSummary/";
const YAHOO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Set to your site origin(s). "*" is acceptable for a public read-only proxy.
const ALLOWED_ORIGINS = ["*"];

const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,20}$/;
const INTERVALS = new Set(["1d", "1wk", "1mo"]);

// Cached Yahoo crumb+cookie (module scope; refreshed periodically).
let CRUMB_CACHE = { cookie: "", crumb: "", ts: 0 };
const CRUMB_TTL_MS = 30 * 60 * 1000;

async function getCrumb(force) {
  const now = Date.now();
  if (!force && CRUMB_CACHE.crumb && now - CRUMB_CACHE.ts < CRUMB_TTL_MS) {
    return CRUMB_CACHE;
  }
  // 1) Obtain a session cookie.
  const cookieResp = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": YAHOO_UA },
  });
  let cookie = "";
  const setCookie =
    (cookieResp.headers.getSetCookie && cookieResp.headers.getSetCookie()[0]) ||
    cookieResp.headers.get("set-cookie") ||
    "";
  if (setCookie) cookie = setCookie.split(";")[0];

  // 2) Exchange the cookie for a crumb.
  const crumbResp = await fetch(
    "https://query2.finance.yahoo.com/v1/test/getcrumb",
    { headers: { "User-Agent": YAHOO_UA, Cookie: cookie } }
  );
  const crumb = (await crumbResp.text()).trim();
  CRUMB_CACHE = { cookie, crumb, ts: now };
  return CRUMB_CACHE;
}

// Fetch and slim down the company profile (address + business nature).
async function handleProfile(symbol, origin) {
  async function attempt(force) {
    const { cookie, crumb } = await getCrumb(force);
    const url =
      `${YAHOO_QS}${encodeURIComponent(symbol)}` +
      `?modules=assetProfile%2Cprice&crumb=${encodeURIComponent(crumb)}`;
    return fetch(url, {
      headers: { "User-Agent": YAHOO_UA, Cookie: cookie, Accept: "application/json" },
    });
  }

  let resp = await attempt(false);
  if (resp.status === 401 || resp.status === 403) {
    resp = await attempt(true); // stale crumb -> refresh once
  }
  if (!resp.ok) {
    return json({ error: `Profile upstream ${resp.status}` }, 502, origin);
  }
  const data = await resp.json();
  const res =
    data && data.quoteSummary && data.quoteSummary.result &&
    data.quoteSummary.result[0];
  if (!res) return json({ error: "No profile data" }, 404, origin);

  const ap = res.assetProfile || {};
  const pr = res.price || {};
  const slim = {
    name: (pr.longName || pr.shortName || symbol) + "",
    address1: ap.address1 || "",
    address2: ap.address2 || "",
    city: ap.city || "",
    state: ap.state || "",
    zip: ap.zip || "",
    country: ap.country || "",
    sector: ap.sector || "",
    industry: ap.industry || "",
    website: ap.website || "",
    summary: ap.longBusinessSummary || "",
  };
  return json({ profile: slim }, 200, origin);
}

function corsHeaders(origin) {
  const allow =
    ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)
      ? ALLOWED_ORIGINS.includes("*")
        ? "*"
        : origin
      : "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=3600",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin),
  });
}

// Edge-cache successful JSON responses keyed by the incoming request URL, so a
// burst of identical lookups (e.g. 500 users all querying MSFT) results in just
// ONE upstream Yahoo call per TTL instead of 500. CORS is "*" so a single cached
// entry is valid for every origin.
async function cached(request, ctx, producer) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) {
    const h = new Headers(hit.headers);
    h.set("X-Cache", "HIT");
    return new Response(hit.body, { status: hit.status, headers: h });
  }
  const resp = await producer();
  if (resp.status === 200 && ctx && ctx.waitUntil) {
    ctx.waitUntil(cache.put(key, resp.clone()));
  }
  const h = new Headers(resp.headers);
  h.set("X-Cache", "MISS");
  return new Response(resp.body, { status: resp.status, headers: h });
}

// Only these hosts may be proxied as PDFs, and only .pdf paths. This keeps the
// endpoint from becoming an open proxy / SSRF vector.
const PDF_HOSTS = new Set([
  "raw.githubusercontent.com",
  "sbi.bank.in",
  "www.sbi.co.in",
]);

async function handlePdf(pdfParam, origin, download, dlName) {
  let target;
  try {
    target = new URL(pdfParam);
  } catch {
    return json({ error: "Invalid pdf url" }, 400, origin);
  }
  if (
    target.protocol !== "https:" ||
    !PDF_HOSTS.has(target.hostname) ||
    !target.pathname.toLowerCase().endsWith(".pdf")
  ) {
    return json({ error: "PDF source not allowed" }, 403, origin);
  }

  const upstream = await fetch(target.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "application/pdf",
    },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (!upstream.ok) {
    return json({ error: `PDF upstream ${upstream.status}` }, 502, origin);
  }

  // Sanitise the download filename (defence-in-depth against header injection).
  const safeName = (dlName || "SBI-FOREX-CARD-RATES.pdf")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 60);
  const disposition = download
    ? `attachment; filename="${safeName}"`
    : "inline";

  const allow = ALLOWED_ORIGINS.includes("*") ? "*" : origin;
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": disposition,
      "Access-Control-Allow-Origin": allow,
      "Cache-Control": "public, max-age=86400",
    },
  });
}

async function handleChart(url, symbol, origin) {
  const p1 = url.searchParams.get("period1");
  const p2 = url.searchParams.get("period2");
  const interval = url.searchParams.get("interval") || "1d";
  if (!INTERVALS.has(interval)) {
    return json({ error: "Invalid interval" }, 400, origin);
  }

  const qs = new URLSearchParams({ interval, events: "div,splits" });
  if (p1 && p2) {
    if (!/^\d{1,15}$/.test(p1) || !/^\d{1,15}$/.test(p2)) {
      return json({ error: "Invalid period" }, 400, origin);
    }
    qs.set("period1", p1);
    qs.set("period2", p2);
  } else {
    qs.set("range", "max");
  }

  const target = `${YAHOO_HOST}${encodeURIComponent(symbol)}?${qs}`;

  const upstream = await fetch(target, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "application/json",
    },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });

  if (!upstream.ok) {
    return json(
      { error: `Upstream ${upstream.status}` },
      upstream.status === 404 ? 404 : 502,
      origin
    );
  }

  const data = await upstream.json();
  return json(data, 200, origin);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, origin);
    }

    const url = new URL(request.url);

    // --- PDF proxy: re-serve whitelisted SBI PDFs as application/pdf so they
    // render inline instead of downloading (GitHub raw sends octet-stream). ---
    const pdfParam = url.searchParams.get("pdf");
    if (pdfParam) {
      const download = url.searchParams.get("dl") === "1";
      const dlName = url.searchParams.get("name") || "";
      return handlePdf(pdfParam, origin, download, dlName);
    }

    const symbol = (url.searchParams.get("symbol") || "").trim();
    if (!SYMBOL_RE.test(symbol)) {
      return json({ error: "Invalid symbol" }, 400, origin);
    }

    // --- Company profile: registered address + business nature. ---
    if (url.searchParams.get("profile") === "1") {
      return cached(request, ctx, () => handleProfile(symbol, origin));
    }

    // --- Historical price series. ---
    return cached(request, ctx, () => handleChart(url, symbol, origin));
  },
};
