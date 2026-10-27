"""Seeded market simulator shared by the live engine, the dataset builder and the backtester.

Two layers:

* Browser-safe (standard library only, also shipped to Pyodide for in-browser backtests):
  ``types``, ``book``, ``exchange``, ``driver``, ``protocol``, ``config``, ``backtest``.
* Server-only (needs NumPy and the secret lobby seed, never shipped to clients):
  ``rng``, ``models``, ``flow``, ``simulator``.
"""
