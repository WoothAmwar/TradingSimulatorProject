"""Build a lobby's public dataset locally.

uv run python -m scripts.make_dataset --seed 12345 --ticks 10000 --out out/demo
uv run python -m scripts.make_dataset --config lobby.json --out out/demo   # random seed
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from market_core.config import LobbyConfig, default_lobby_config
from market_core.dataset import build_dataset
from market_core.rng import new_seed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, help="lobby seed (default: fresh 128-bit seed)")
    parser.add_argument("--config", type=Path, help="lobby config JSON (default: built-in presets)")
    parser.add_argument(
        "--ticks", type=int, help="dataset length K (default: config.dataset_ticks)"
    )
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    config = (
        LobbyConfig.from_dict(json.loads(args.config.read_text()))
        if args.config
        else default_lobby_config()
    )
    seed = args.seed if args.seed is not None else new_seed()
    manifest = build_dataset(config, seed, args.out, args.ticks)
    print(f"wrote {manifest['ticks']} ticks to {args.out} (seed {seed})")


if __name__ == "__main__":
    main()
