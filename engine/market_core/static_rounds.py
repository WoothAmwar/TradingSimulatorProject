"""Static rounds: markets generated once and published in full. Server-only.

A static round has no live part. Its whole dataset is public, every group runs its code against
it in the browser, and that run's score is the group's result for the round. Presets:

  BEST_TIME  one price per tick for a single good. Own at most one unit and never owe one, but buy
             and sell as often as you like (LeetCode 122), so the best score is the sum of every
             rise from one tick to the next. Replayed by ``series.SeriesBacktest``.
  FLAT_MEAN  an order book around a constant mean. The bot market maker quotes wide and noise
             traders buy and sell around the mean, so quoting inside the spread earns it. Scored
             with positions marked at the mean. Replayed by ``backtest.Backtest``.
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
from pathlib import Path

from .config import GoodConfig, InformedParams, LobbyConfig, MakerParams, NoiseParams
from .dataset import FORMAT_VERSION, build_dataset
from .rng import stream

STATIC_PRESETS = {
    "BEST_TIME": {"good": "STOCK", "ticks": 500},
    "FLAT_MEAN": {"good": "FLAT", "ticks": 2000},
}
PREVIEW_POINTS = 600  # chart points per good stored in the round's public config


def build_static_dataset(
    preset: str, ticks: int, seed: int, out_dir: Path
) -> tuple[dict, dict[str, list[list[float]]]]:
    """Writes the round's files to ``out_dir``; returns the manifest and a chart preview."""
    if preset not in STATIC_PRESETS:
        raise ValueError(f"unknown static round preset {preset!r}")
    if not 10 <= ticks <= 20_000:
        raise ValueError("a static round needs between 10 and 20000 ticks")
    out_dir.mkdir(parents=True, exist_ok=True)
    if preset == "BEST_TIME":
        return _best_time(ticks, seed, out_dir)
    return _flat_mean(ticks, seed, out_dir)


def _best_time(ticks: int, seed: int, out_dir: Path) -> tuple[dict, dict]:
    good = STATIC_PRESETS["BEST_TIME"]["good"]
    rng = stream(seed, 0, "fair_value")
    level, prices = 100.0, []
    for _ in range(ticks):
        prices.append(max(1, round(level)))
        step = rng.normal(0.0, 1.5)
        if rng.random() < 0.02:  # occasional news moves
            step += rng.normal(0.0, 6.0)
        level = max(1.0, level + step)

    events = io.BytesIO()
    with gzip.GzipFile(fileobj=events, mode="wb", mtime=0) as f:
        for t, p in enumerate(prices):
            line = json.dumps({"t": t, "prices": {good: p}}, separators=(",", ":"))
            f.write((line + "\n").encode())
    table = io.StringIO()
    writer = csv.writer(table, lineterminator="\n")
    writer.writerow(["tick", "good", "price"])
    writer.writerows([t, good, p] for t, p in enumerate(prices))

    files = {"events.jsonl.gz": events.getvalue(), "prices.csv": table.getvalue().encode()}
    for name, data in files.items():
        (out_dir / name).write_bytes(data)
    manifest = {
        "format": FORMAT_VERSION,
        "kind": "series",
        "ticks": ticks,
        "rules": {
            "goods": [good],
            "position_limits": {good: 1},
            "min_positions": {good: 0},
        },
        "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest, {good: _downsample(list(enumerate(prices)))}


def _flat_mean(ticks: int, seed: int, out_dir: Path) -> tuple[dict, dict]:
    name = STATIC_PRESETS["FLAT_MEAN"]["good"]
    mean = int(stream(seed, 1, "fair_value").integers(800, 1201))
    good = GoodConfig(
        name=name,
        model="ou",
        model_params={"mu": float(mean), "kappa": 1.0, "sigma": 0.0},  # constant fair value
        position_limit=20,
        maker=MakerParams(base_half_spread=4.0, vol_spread_mult=0.0, quote_noise=0.0),
        noise=NoiseParams(rate=2.0, take_prob=0.6, take_reach=0.0),
        informed=InformedParams(prob=0.0),
    )
    manifest = build_dataset(LobbyConfig(goods=(good,), dataset_ticks=ticks), seed, out_dir)
    manifest = {**manifest, "kind": "orderbook", "marks": {name: mean}}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    mids = []
    with (out_dir / "prices.csv").open() as f:
        for row in csv.DictReader(f):
            if row["mid_price"]:
                mids.append((int(row["tick"]), float(row["mid_price"])))
    return manifest, {name: _downsample(mids)}


def _downsample(points: list[tuple[int, float]]) -> list[list[float]]:
    stride = max(1, -(-len(points) // PREVIEW_POINTS))
    return [[t, v] for t, v in points[::stride]]
