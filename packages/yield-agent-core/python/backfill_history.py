#!/usr/bin/env python3
"""
backfill_history.py — 30-day token price history via DeFiLlama coins API.

Uses https://coins.llama.fi/chart/arbitrum:{address}
Same source as the LVR Screener runtime — proven to work for all Arbitrum tokens.

Reads token addresses dynamically from data/universe.json so it always covers
exactly the tokens the engine is using.

Usage:
    python3 backfill_history.py [--chain arbitrum] [--days 30]
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

RATE_LIMIT_WAIT = 0.3
STABLECOINS = {
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1",
    "0x0000000000000000000000000000000000000000",
}

# ── Discover tokens from universe.json ────────────────────────────────────────

def discover_tokens(universe_path: Path) -> dict[str, str]:
    if not universe_path.exists():
        print(f"[WARN] {universe_path} not found — run warm-intelligence.ts first", file=sys.stderr)
        return {}
    with open(universe_path) as f:
        data = json.load(f)
    tokens: dict[str, str] = {}
    for opp in data.get("opportunities", []):
        for key in ["base", "quote"]:
            t    = opp.get("tokens", {}).get(key) or {}
            addr = t.get("address", "").lower()
            sym  = t.get("symbol", "?")
            if addr and addr not in STABLECOINS and addr != "0x0" and len(addr) == 42:
                tokens[addr] = sym
    print(f"Discovered {len(tokens)} unique non-stable tokens from universe.json")
    return tokens

# ── DeFiLlama coins API ───────────────────────────────────────────────────────

def fetch_defillama(address: str, chain: str, days: int) -> list[dict]:
    start = int((datetime.now(tz=timezone.utc) - timedelta(days=days + 1)).timestamp())
    url   = f"https://coins.llama.fi/chart/{chain}:{address}?start={start}&span={days}&period=1d"
    for attempt in range(3):
        try:
            resp = requests.get(url, timeout=20)
            if resp.status_code == 429:
                time.sleep(2 ** attempt * 2)
                continue
            if not resp.ok:
                return []
            data  = resp.json()
            coins = data.get("coins", {})
            key   = f"{chain}:{address}"
            pts   = coins.get(key, {}).get("prices", [])
            return pts   # [{ timestamp: int, price: float }, ...]
        except Exception as e:
            if attempt < 2:
                time.sleep(1)
    return []


def stable_series(days: int) -> list[dict]:
    now = datetime.now(tz=timezone.utc)
    return [
        {"timestamp": int((now - timedelta(days=days - i)).timestamp() * 1000), "close": 1.0}
        for i in range(days)
    ]

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chain",    default="arbitrum")
    parser.add_argument("--days",     type=int, default=30)
    parser.add_argument("--out",      default="../data/history/arbitrum.json")
    parser.add_argument("--universe", default="../data/universe.json")
    args = parser.parse_args()

    out_path      = Path(args.out)
    universe_path = Path(args.universe)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Load existing (incremental)
    existing: dict = {}
    if out_path.exists():
        try:
            existing = json.load(open(out_path))
            print(f"Loaded {len(existing)} existing histories")
        except Exception:
            pass

    tokens = discover_tokens(universe_path)
    if not tokens:
        print("No tokens found — exiting")
        return

    print(f"\nFetching {args.days}-day prices via DeFiLlama coins API")
    print(f"Chain: {args.chain} | Tokens: {len(tokens)}\n")

    results = dict(existing)

    for addr, symbol in sorted(tokens.items(), key=lambda x: x[1]):
        print(f"  {symbol.ljust(12)} {addr[:12]}…", end="  ", flush=True)
        pts = fetch_defillama(addr, args.chain, args.days)
        if not pts:
            print("no data")
            results.setdefault(addr, [])
            continue
        # Normalize to { timestamp (ms), close }
        normalized = sorted(
            [{"timestamp": int(p["timestamp"]) * 1000, "close": float(p["price"])} for p in pts],
            key=lambda x: x["timestamp"],
        )
        results[addr] = normalized
        latest = normalized[-1]["close"] if normalized else 0
        print(f"{len(normalized)} points  latest=${latest:.4f}")
        time.sleep(RATE_LIMIT_WAIT)

    # Stablecoin series (flat $1)
    for addr in STABLECOINS:
        if addr != "0x0000000000000000000000000000000000000000":
            results[addr] = stable_series(args.days)

    with open(out_path, "w") as f:
        json.dump(results, f)

    filled = sum(1 for v in results.values() if v)
    print(f"\n✅  {filled} token histories saved → {out_path}")

if __name__ == "__main__":
    main()
