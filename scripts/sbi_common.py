"""Shared helpers for parsing SBI FOREX CARD RATES PDFs into TT BUY rates.

The SBI "FOREX CARD RATES" PDF lists, per currency, a row like:

    UNITED STATES DOLLAR USD/INR 96.1 96.95 96.03 97.12 96.03 97.12 94.9 97.5

The first numeric column after ``<CCY>/INR`` is the TT BUY rate (INR per unit
of foreign currency). JPY, THB and KRW are quoted per 100 foreign-currency
units, so we record a ``unit`` factor for correct conversion.
"""
from __future__ import annotations

import io
import json
import re
from pathlib import Path

import pdfplumber

# Currencies quoted per 100 foreign-currency units on the SBI card.
PER_100 = {"JPY", "THB", "KRW", "IDR", "VND"}

# Matches "<WORDS> XXX/INR <num> <num> ..." capturing the 3-letter code and the
# first (TT BUY) number.
_ROW_RE = re.compile(
    r"([A-Z]{3})\s*/\s*INR\s+([0-9]+(?:\.[0-9]+)?)",
    re.IGNORECASE,
)

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "sbi-tt.json"


def parse_pdf_bytes(pdf_bytes: bytes) -> dict[str, float]:
    """Return {currency_code: tt_buy_per_single_unit} from a SBI PDF."""
    rates: dict[str, float] = {}
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            for line in text.splitlines():
                m = _ROW_RE.search(line)
                if not m:
                    continue
                code = m.group(1).upper()
                tt_buy = float(m.group(2))
                if code in rates:
                    continue
                # Normalise to INR per single foreign unit.
                if code in PER_100:
                    tt_buy = tt_buy / 100.0
                rates[code] = round(tt_buy, 6)
    return rates


def load_store() -> dict:
    if DATA_FILE.exists():
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    return {}


def save_store(store: dict) -> None:
    # Sort by date so diffs are clean and git history is readable.
    ordered = {k: store[k] for k in sorted(store)}
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(
        json.dumps(ordered, indent=1, sort_keys=False) + "\n", encoding="utf-8"
    )


def upsert(
    store: dict, date_str: str, rates: dict[str, float], pdf_rel: str | None = None
) -> bool:
    """Add rates + pdf link for a date if not already present.

    Each entry is ``{"rates": {...}, "pdf": "data/pdf/YYYY/MM/YYYY-MM-DD.pdf"}``.
    Returns True if the store changed.
    """
    if not rates:
        return False
    entry = {"rates": rates}
    if pdf_rel:
        entry["pdf"] = pdf_rel
    if store.get(date_str) == entry:
        return False
    store[date_str] = entry
    return True
