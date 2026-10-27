"""Production entrypoint: ``uvicorn server.main:app --host 0.0.0.0 --port $PORT``."""

from .app import app_from_env

app = app_from_env()
