"""Entry point of one Python bot in the engine's sandbox (CPython for WASI under wasmtime).

The engine preopens the standard library at /lib, this folder at /sdk and the bot's code at
/bot/trader.py, all read-only, with no network and no environment. It writes one state per line
to stdin; every reply is one JSON line on the real stdout. print() output is captured per call and
returned with the reply, so it can't be mistaken for one.
"""

import io
import json
import sys
import traceback

sys.path.insert(0, "/sdk")
import bot_runner  # noqa: E402

MAX_LOG_CHARS = 20_000  # print() output kept per call
MAX_ERROR_CHARS = 3_000

_out = sys.__stdout__


def _call(fn):
    """Runs fn with print() captured. Returns (result, error, output)."""
    buf = io.StringIO()
    sys.stdout = sys.stderr = buf
    try:
        return fn(), None, buf.getvalue()
    except BaseException as exc:  # sys.exit() in a bot reports an error instead of stopping it
        tb = exc.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != "trader.py":
            tb = tb.tb_next  # start the traceback in the bot's own code
        error = "".join(traceback.format_exception(type(exc), exc, tb))
        return None, error[-MAX_ERROR_CHARS:], buf.getvalue()
    finally:
        sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__


def _reply(msg, output):
    if len(output) > MAX_LOG_CHARS:
        output = output[:MAX_LOG_CHARS] + "\n... output cut short"
    msg["logs"] = output.splitlines()
    _out.write(json.dumps(msg) + "\n")
    _out.flush()


def main():
    with open("/bot/trader.py", encoding="utf-8") as f:
        source = f.read()
    bot, error, output = _call(lambda: bot_runner.Bot(source))
    if error:
        _reply({"error": error}, output)
        return
    _reply({"ready": True}, output)
    for line in sys.stdin.buffer:  # ends when the engine closes the pipe
        state = json.loads(line)
        response, error, output = _call(lambda: bot.tick(state))  # noqa: B023 (called at once)
        _reply({"error": error} if error else {"response": response}, output)


main()
