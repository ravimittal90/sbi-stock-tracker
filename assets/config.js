// Runtime configuration. Edit PROXY_URL after deploying the Cloudflare Worker.
// Example: "https://sbi-stock-tracker-proxy.<your-subdomain>.workers.dev"
window.APP_CONFIG = {
  // Cloudflare Worker that proxies Yahoo Finance (required for live lookups).
    PROXY_URL: "https://sbi-stock-tracker-proxy.ravimittal.workers.dev",
  // Relative path to parsed SBI TT rate data.
  SBI_DATA_URL: "data/sbi-tt.json",
};
