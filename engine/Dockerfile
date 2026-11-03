FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_NO_DEV=1 PYTHONUNBUFFERED=1

# Dependencies first so code changes don't invalidate the layer (NumPy is pinned in uv.lock).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

# CPython for WASI runs Python bots (server/sandbox.py). Downloading it needs only the standard
# library, so it gets its own cached layer; compiling it needs the engine's wasmtime settings.
COPY server/__init__.py server/wasi_python.py ./server/
RUN .venv/bin/python -m server.wasi_python download /app/wasi-python

COPY market_core ./market_core
COPY bot_sdk ./bot_sdk
COPY server ./server
RUN .venv/bin/python -m server.wasi_python compile /app/wasi-python

RUN useradd --create-home engine
USER engine

# Render injects PORT; one worker so a single process owns every lobby's tick loop.
# --ws-max-size: a monitor only sends keep-alives; uvicorn's 16 MB default lets one client stall
# the 0.1-CPU tick loop parsing a single message.
CMD ["sh", "-c", "exec /app/.venv/bin/uvicorn server.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --proxy-headers --forwarded-allow-ips='*' --ws-max-size 262144"]
