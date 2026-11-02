"""A trader whose socket can't take a message is dropped instead of slowing every tick."""

import asyncio

from market_core.types import CancelAll
from server.runner import LobbyRunner, Trader


class FakeSocket:
    def __init__(self, broken: bool = False) -> None:
        self.broken, self.sent, self.closed = broken, [], None

    async def send_json(self, msg: dict) -> None:
        if self.broken:
            raise RuntimeError("send failed")
        self.sent.append(msg)

    async def close(self, code: int, reason: str) -> None:
        self.closed = code


def test_broken_trader_is_dropped_and_others_still_receive():
    runner = object.__new__(LobbyRunner)
    runner.status, runner._accepting, runner._pending, runner._carry = "running", None, {}, {}
    good, bad = FakeSocket(), FakeSocket(broken=True)
    runner.traders = {"g1": Trader("g1", "u1", good), "g2": Trader("g2", "u2", bad)}

    asyncio.run(runner._send_traders({"g1": {"n": 1}, "g2": {"n": 2}}))

    assert good.sent == [{"n": 1}]
    assert list(runner.traders) == ["g1"]
    assert bad.closed == 1011
    assert runner._carry == {"g2": [CancelAll("g2")]}  # cancel-on-disconnect, as on a disconnect
