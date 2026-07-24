"""One-time backfill of historical SBI TT rates from the reference archive.

The public archive https://github.com/skbly7/sbi-tt-rates-historical stores two
PDF snapshots per day at ``YYYY/MM/YYYY-MM-DD-HH:MM.pdf``. We take one snapshot
per calendar day, parse the TT BUY rates, and seed ``data/sbi-tt.json``.

By default the stored ``pdf`` link points at the reference repo's raw URL (keeps
our repo small). Pass ``--copy-pdfs`` to vendor the PDFs into ``data/pdf/``.

Usage:
    python scripts/backfill_from_reference.py                # all years
    python scripts/backfill_from_reference.py --since 2022   # from 2022 on
    python scripts/backfill_from_reference.py --copy-pdfs
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sbi_common import (  # noqa: E402
    load_store,
    parse_pdf_bytes,
    save_store,
    upsert,
)

REPO = "skbly7/sbi-tt-rates-historical"
TREE_URL = f"https://api.github.com/repos/{REPO}/git/trees/master?recursive=1"
RAW_BASE = f"https://raw.githubusercontent.com/{REPO}/master/"

ROOT = Path(__file__).resolve().parent.parent
HEADERS = {"User-Agent": "sbi-stock-tracker-backfill"}
DATE_RE = re.compile(r"^(\d{4})/(\d{2})/(\d{4}-\d{2}-\d{2})-\d{2}:\d{2}\.pdf$")


def list_daily_pdfs(since_year: int) -> dict[str, str]:
    """Return {date_str: repo_path} choosing the first snapshot per day."""
    resp = requests.get(TREE_URL, headers=HEADERS, timeout=60)
    resp.raise_for_status()
    tree = resp.json().get("tree", [])
    by_day: dict[str, str] = {}
    for node in tree:
        path = node.get("path", "")
        m = DATE_RE.match(path)
        if not m:
            continue
        if int(m.group(1)) < since_year:
            continue
        date_str = m.group(3)
        by_day.setdefault(date_str, path)  # first (earliest) snapshot wins
    return dict(sorted(by_day.items()))


def raw_url(repo_path: str) -> str:
    # Encode each path segment (filenames contain ':').
    return RAW_BASE + "/".join(quote(p) for p in repo_path.split("/"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=2020, help="start year")
    ap.add_argument("--copy-pdfs", action="store_true", help="vendor PDFs locally")
    ap.add_argument("--sleep", type=float, default=0.4, help="delay between fetches")
    ap.add_argument("--limit", type=int, default=0, help="max days (0 = all)")
    args = ap.parse_args()

    daily = list_daily_pdfs(args.since)
    if args.limit:
        daily = dict(list(daily.items())[: args.limit])
    print(f"Found {len(daily)} distinct days (since {args.since}).")

    store = load_store()
    added = failed = 0
    for i, (date_str, repo_path) in enumerate(daily.items(), 1):
        if date_str in store:
            continue
        url = raw_url(repo_path)
        try:
            r = requests.get(url, headers=HEADERS, timeout=60)
            r.raise_for_status()
            rates = parse_pdf_bytes(r.content)
            if not rates:
                raise ValueError("no rates parsed")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"  [{i}/{len(daily)}] {date_str} FAILED: {exc}")
            continue

        if args.copy_pdfs:
            y, m, _ = date_str.split("-")
            rel = f"data/pdf/{y}/{m}/{date_str}.pdf"
            out = ROOT / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(r.content)
            pdf_link = rel
        else:
            pdf_link = url

        if upsert(store, date_str, rates, pdf_link):
            added += 1
        if i % 25 == 0:
            save_store(store)
            print(f"  [{i}/{len(daily)}] checkpoint saved ({added} added)")
        time.sleep(args.sleep)

    save_store(store)
    print(f"Done. Added {added} days, {failed} failures. Total: {len(store)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
