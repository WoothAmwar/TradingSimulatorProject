from market_core.protocol import parse_bot_response
from market_core.types import BUY, SELL, Cancel, CancelAll, NewOrder


def test_parse_orders_and_cancels_in_order():
    actions, rejects = parse_bot_response(
        "g",
        {
            "orders": [
                {"good": "X", "price": 99, "qty": 3},
                {"good": "X", "price": 101, "qty": -2, "tif": "ioc", "client_id": 7},
            ],
            "cancel": [4],
            "cancel_all": ["X"],
        },
    )
    assert rejects == []
    assert actions == [
        CancelAll("g", "X"),
        Cancel("g", 4),
        NewOrder("g", "X", BUY, 99, 3),
        NewOrder("g", "X", SELL, 101, 2, "IOC", client_id="7"),
    ]


def test_parse_rejects_malformed_entries():
    actions, rejects = parse_bot_response(
        "g",
        {
            "orders": [
                {"good": "X", "price": 99, "qty": 0},
                "nope",
                {"good": "X", "price": 1, "qty": True},
            ],
            "cancel": ["a"],
            "cancel_all": "yes",
        },
    )
    assert actions == []
    assert len(rejects) == 5
    assert parse_bot_response("g", None) == ([], [])
    assert parse_bot_response("g", [1, 2])[1][0].reason == "response must be an object"
