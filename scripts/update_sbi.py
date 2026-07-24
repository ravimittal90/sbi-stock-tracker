"""Fetch today's SBI FOREX CARD RATES PDF, store it, and append TT BUY rates.

Run daily (see .github/workflows/update-sbi.yml). Idempotent: re-running on the
same day overwrites that day's snapshot but produces no spurious history.

Usage:
    python scripts/update_sbi.py
"""
from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sbi_common import (  # noqa: E402
    load_store,
    parse_pdf_bytes,
    save_store,
    upsert,
)

# Primary + fallback SBI endpoints (same document, different hosts).
SBI_URLS = [
    "https://sbi.bank.in/documents/16012/1400784/FOREX_CARD_RATES.pdf",
    "https://www.sbi.co.in/documents/16012/1400784/FOREX_CARD_RATES.pdf",
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    )
}

ROOT = Path(__file__).resolve().parent.parent
PDF_DIR = ROOT / "data" / "pdf"


def fetch_pdf() -> bytes:
    last_err: Exception | None = None
    for url in SBI_URLS:
        try:
            resp = requests.get(url, headers=HEADERS, timeout=45)
            resp.raise_for_status()
            if resp.content[:4] == b"%PDF":
                return resp.content
            last_err = ValueError(f"Not a PDF from {url}")
        except Exception as exc:  # noqa: BLE001
            last_err = exc
    raise SystemExit(f"Could not fetch SBI PDF: {last_err}")


def main() -> int:
    today = dt.date.today()
    date_str = today.isoformat()

    pdf_bytes = fetch_pdf()
    rates = parse_pdf_bytes(pdf_bytes)
    if not rates:
        raise SystemExit("Parsed zero rates - PDF layout may have changed.")

    # Persist the raw PDF for user cross-verification.
    rel = f"data/pdf/{today:%Y}/{today:%m}/{date_str}.pdf"
    out = ROOT / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(pdf_bytes)

    store = load_store()
    changed = upsert(store, date_str, rates, rel)
    save_store(store)

    print(f"{date_str}: {len(rates)} currencies, changed={changed}")
    print("  USD TT BUY =", rates.get("USD"), " JPY =", rates.get("JPY"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
