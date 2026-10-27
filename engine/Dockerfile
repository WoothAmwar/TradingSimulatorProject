FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_NO_DEV=1 PYTHONUNBUFFERED=1

# Dependencies first so code changes don't invalidate the layer (NumPy is pinned in uv.lock).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

COPY market_core ./market_core
COPY server ./server

RUN useradd --create-home engine
USER engine

# Render injects PORT; one worker so a single process owns every lobby's tick loop.
CMD ["sh", "-c", "exec /app/.venv/bin/uvicorn server.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --proxy-headers --forwarded-allow-ips='*'"]
