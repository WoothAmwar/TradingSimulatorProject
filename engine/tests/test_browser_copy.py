"""The in-browser backtester runs copies of the browser-safe modules; keep them identical."""

import ast
import json
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1] / "market_core"
COPY = Path(__file__).resolve().parents[2] / "web" / "public" / "py" / "market_core"


def test_browser_copies_match_engine():
    files = json.loads((COPY / "files.json").read_text())
    for name in files:
        assert (COPY / name).read_bytes() == (ENGINE / name).read_bytes(), (
            f"{name} drifted; run `npm run sync:engine` in web/"
        )


def test_browser_modules_use_only_the_standard_library():
    files = json.loads((COPY / "files.json").read_text())
    local = {Path(f).stem for f in files}
    for name in files:
        tree = ast.parse((ENGINE / name).read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level == 0:
                assert node.module.split(".")[0] in {
                    "__future__",
                    "collections",
                    "dataclasses",
                    "typing",
                    "bisect",
                    "hashlib",
                    "json",
                }, name
            if isinstance(node, ast.ImportFrom) and node.level == 1:
                assert node.module in local, f"{name} imports server-only module {node.module}"
            if isinstance(node, ast.Import):
                assert all(a.name in {"json", "hashlib"} for a in node.names), name
