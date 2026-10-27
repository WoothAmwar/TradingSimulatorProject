"""Build the public dataset: ticks 0..K-1 of a lobby's bot-only market. Server-only.

Files (all byte-for-byte reproducible from the same config and seed):
  events.jsonl.gz  one line per tick: {"t", "pre", "post"} bot actions, replayed by the backtester
  prices.csv       the book each bot sees when a tick opens (top 3 levels + mid)
  trades.csv       every trade, anonymised
  manifest.json    exchange rules, tick count and file hashes (no seed, no model parameters)
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
from pathlib import Path

from .config import LobbyConfig
from .simulator import MarketSimulator
from .types import action_to_dict

FORMAT_VERSION = 1
PRICE_LEVELS = 3


def _price_header() -> list[str]:
    cols = ["tick", "good"]
    for side in ("bid", "ask"):
        for i in range(1, PRICE_LEVELS + 1):
            cols += [f"{side}_price_{i}", f"{side}_volume_{i}"]
    return [*cols, "mid_price"]


def build_dataset(config: LobbyConfig, seed: int, out_dir: Path, ticks: int | None = None) -> dict:
    ticks = config.dataset_ticks if ticks is None else ticks
    out_dir.mkdir(parents=True, exist_ok=True)
    sim = MarketSimulator(config, seed)

    events_buf = io.BytesIO()
    prices_buf = io.StringIO()
    trades_buf = io.StringIO()
    prices = csv.writer(prices_buf, lineterminator="\n")
    trades = csv.writer(trades_buf, lineterminator="\n")
    prices.writerow(_price_header())
    trades.writerow(["tick", "good", "price", "quantity", "aggressor"])

    with gzip.GzipFile(fileobj=events_buf, mode="wb", mtime=0) as events:
        for t in range(ticks):
            open_log = sim.open_tick()
            assert sim.current is not None
            line = {
                "t": t,
                "pre": [action_to_dict(a) for a in sim.current.pre],
                "post": [action_to_dict(a) for a in sim.current.post],
            }
            events.write((json.dumps(line, separators=(",", ":")) + "\n").encode())

            for good, book in sim.driver.exchange.books.items():
                bids, asks = book.depth(PRICE_LEVELS)
                row: list = [t, good]
                for levels in (bids, asks):
                    for i in range(PRICE_LEVELS):
                        row += levels[i] if i < len(levels) else ["", ""]
                mid = book.mid()
                row.append("" if mid is None else mid)
                prices.writerow(row)

            close_log = sim.close_tick()
            for fill in open_log.fills + close_log.fills:
                side = "BUY" if fill.aggressor > 0 else "SELL"
                trades.writerow([t, fill.good, fill.price, fill.qty, side])

    files = {
        "events.jsonl.gz": events_buf.getvalue(),
        "prices.csv": prices_buf.getvalue().encode(),
        "trades.csv": trades_buf.getvalue().encode(),
    }
    for name, data in files.items():
        (out_dir / name).write_bytes(data)

    manifest = {
        "format": FORMAT_VERSION,
        "ticks": ticks,
        "tick_ms": config.tick_ms,
        "depth_levels": config.depth_levels,
        "rules": config.rules().to_dict(),
        "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def read_events(path: Path):
    with gzip.open(path, "rt") as f:
        for line in f:
            yield json.loads(line)
