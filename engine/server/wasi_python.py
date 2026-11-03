"""Installs CPython for WASI, which runs Python bots on the engine (see server/sandbox.py).

    python -m server.wasi_python install [dir]    # download, then compile
    python -m server.wasi_python download [dir]   # the Dockerfile caches this step on its own
    python -m server.wasi_python compile [dir]

``download`` fetches the pinned build, checks its SHA-256 and unpacks python.wasm and the standard
library. ``compile`` writes the library's bytecode (bots see it read-only, so they can't) and
python.cwasm, wasmtime's machine code for python.wasm, so a bot starts in milliseconds instead of
compiling 30 MB of WebAssembly on 0.1 CPU. ``dir`` defaults to engine/wasi-python.
"""

from __future__ import annotations

import hashlib
import io
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

# Same minor version as the browser's Pyodide, so bots behave alike in backtests and live.
VERSION = "3.14.9"
URL = (
    "https://github.com/brettcannon/cpython-wasi-build/releases/download/"
    f"v{VERSION}/python-{VERSION}-wasi_sdk-24.zip"
)
SHA256 = "8de7834105edef8db8a13299e2587cf8945021dd8764f2691d83bbc25129dfa2"
DEFAULT_DIR = Path(__file__).resolve().parents[1] / "wasi-python"


def download(dest: Path) -> None:
    with urllib.request.urlopen(URL, timeout=120) as res:
        data = res.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != SHA256:
        raise SystemExit(f"{URL} has SHA-256 {digest}, expected {SHA256}")
    shutil.rmtree(dest, ignore_errors=True)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for name in zf.namelist():
            if name in ("python.wasm", "LICENSE") or name.startswith("lib/"):
                zf.extract(name, dest)
    print(f"unpacked CPython {VERSION} for WASI into {dest}")


def compile_(dest: Path) -> None:
    # Imported here so `download` needs only the standard library (a separate Docker layer).
    from wasmtime import ExitTrap, Linker, Module, Store, WasiConfig

    from .sandbox import make_engine

    engine = make_engine()
    module = Module.from_file(engine, str(dest / "python.wasm"))
    (dest / "python.cwasm").write_bytes(module.serialize())

    linker = Linker(engine)
    linker.define_wasi()
    store = Store(engine)
    store.set_epoch_deadline(1)  # nothing advances the epoch here
    wasi = WasiConfig()
    wasi.argv = ["python", "-I", "-S", "-m", "compileall", "-q", f"/lib/python{VERSION[:4]}"]
    wasi.preopen_dir(str(dest / "lib"), "/lib", True)
    wasi.inherit_stdout()
    wasi.inherit_stderr()
    store.set_wasi(wasi)
    try:
        linker.instantiate(store, module).exports(store)["_start"](store)
    except ExitTrap as exc:
        if exc.code:
            raise SystemExit(f"compileall failed with exit code {exc.code}") from exc
    print(f"compiled python.cwasm and the standard library's bytecode in {dest}")


def main(argv: list[str]) -> None:
    if len(argv) not in (2, 3) or argv[1] not in ("install", "download", "compile"):
        raise SystemExit(__doc__)
    dest = Path(argv[2]).resolve() if len(argv) == 3 else DEFAULT_DIR
    if argv[1] in ("install", "download"):
        download(dest)
    if argv[1] in ("install", "compile"):
        compile_(dest)


if __name__ == "__main__":
    main(sys.argv)
