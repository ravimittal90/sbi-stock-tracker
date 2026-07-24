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

// Set to your site origin(s). "*" is acceptable for a public read-only proxy.
const ALLOWED_ORIGINS = ["*"];

const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,20}$/;
const INTERVALS = new Set(["1d", "1wk", "1mo"]);

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

// Only these hosts may be proxied as PDFs, and only .pdf paths. This keeps the
// endpoint from becoming an open proxy / SSRF vector.
const PDF_HOSTS = new Set([
  "raw.githubusercontent.com",
  "sbi.bank.in",
  "www.sbi.co.in",
]);

async function handlePdf(pdfParam, origin) {
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

  const allow = ALLOWED_ORIGINS.includes("*") ? "*" : origin;
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline",
      "Access-Control-Allow-Origin": allow,
      "Cache-Control": "public, max-age=86400",
    },
  });
}

export default {
  async fetch(request) {
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
      return handlePdf(pdfParam, origin);
    }

    const symbol = (url.searchParams.get("symbol") || "").trim();
    if (!SYMBOL_RE.test(symbol)) {
      return json({ error: "Invalid symbol" }, 400, origin);
    }

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
  },
};
