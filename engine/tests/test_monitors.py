"""A monitor whose socket can't take a message is dropped instead of slowing every tick."""

import asyncio

from server.bots import BotPool


class FakeSocket:
    def __init__(self, broken: bool = False) -> None:
        self.broken, self.sent = broken, []

    async def send_json(self, msg: dict) -> None:
        if self.broken:
            raise RuntimeError("send failed")
        self.sent.append(msg)


def test_broken_monitor_is_dropped_and_others_still_receive():
    pool = BotPool(runner=None, store=None, factory=None)
    gb = pool.group("g1")
    good, bad = FakeSocket(), FakeSocket(broken=True)
    gb.monitors = {good, bad}

    asyncio.run(pool._push(gb, {"n": 1}))

    assert good.sent == [{"n": 1}]
    assert gb.monitors == {good}
