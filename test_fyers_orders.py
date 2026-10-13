import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fyers_orders import OptionTrader, place_live_order


class FakeFyers:
    def __init__(self, positions=None):
        self.position_rows = positions or []
        self.order_requests = []
        self.orders = {}

    def place_order(self, data):
        self.order_requests.append(dict(data))
        order_id = f"fyers-order-{len(self.order_requests)}"
        self.orders[order_id] = {
            **data,
            "id": order_id,
            "status": 2,
            "tradedPrice": 101.5,
            "filledQty": data["qty"],
        }
        return {"s": "ok", "id": order_id}

    def orderbook(self, data):
        return {"s": "ok", "orderBook": [self.orders[data["id"]]]}

    def positions(self):
        return {"s": "ok", "netPositions": self.position_rows}


class FyersOrderTrackingTests(unittest.TestCase):
    def test_order_id_is_saved_at_acknowledgement(self):
        captured_ids = []
        order_id, fill = place_live_order(
            FakeFyers(), "NSE:NIFTY2611545000CE", 65, 1, captured_ids.append
        )

        self.assertEqual(order_id, "fyers-order-1")
        self.assertEqual(fill, 101.5)
        self.assertEqual(captured_ids, ["fyers-order-1"])

    def test_complete_entry_and_exit_use_saved_position_only(self):
        symbol = "NSE:NIFTY2611545000CE"
        fyers = FakeFyers([{
            "symbol": symbol,
            "productType": "INTRADAY",
            "netQty": 65,
        }])
        trader = object.__new__(OptionTrader)
        trader.rest = fyers
        trader.settings = {"live": True, "lots": 1, "daily_loss_limit": 1000}
        trader.mode = "LIVE"
        trader.position = None
        trader.closed_keys = set()
        trader.day_pnl = 0
        trader.halted_reason = None
        trader.notify = lambda *args: None
        trader.pick_option = lambda *args: {"symbol": symbol, "lot_size": 65}
        trader._has_live_entry_funds = lambda opt: True
        trader._log = Mock()
        saved_states = []
        trader._write_position_state = lambda: saved_states.append(
            dict(trader.position) if trader.position else None
        )

        with tempfile.TemporaryDirectory() as directory:
            with patch("fyers_orders.STOP_FILE", Path(directory) / "STOP_TRADING"):
                trader._enter("CALL", 25000, 25050, 24950, key="CALL|09:30")
                trader._exit("target", 25050)

        self.assertEqual(len(fyers.order_requests), 2)
        buy, sell = fyers.order_requests
        self.assertEqual((buy["symbol"], buy["qty"], buy["side"]), (symbol, 65, 1))
        self.assertEqual((sell["symbol"], sell["qty"], sell["side"]), (symbol, 65, -1))
        self.assertEqual(sell["productType"], "INTRADAY")
        self.assertTrue(any(
            state and state.get("entry_order_id") == "fyers-order-1"
            and state.get("entry_order_status") == "accepted"
            for state in saved_states
        ))
        self.assertTrue(any(
            state and state.get("exit_order_id") == "fyers-order-2"
            and state.get("exit_order_status") == "accepted"
            for state in saved_states
        ))
        self.assertIsNone(trader.position)

    def test_partial_fill_is_not_reported_as_fully_filled(self):
        fyers = FakeFyers()
        original_orderbook = fyers.orderbook

        def partial_orderbook(data):
            response = original_orderbook(data)
            response["orderBook"][0]["filledQty"] = 64
            return response

        fyers.orderbook = partial_orderbook

        with self.assertRaisesRegex(RuntimeError, "filled 64 of 65"):
            place_live_order(fyers, "NSE:NIFTY2611545000CE", 65, 1)

    def test_orderbook_must_return_the_acknowledged_order(self):
        fyers = FakeFyers()
        fyers.orderbook = lambda data: {
            "s": "ok",
            "orderBook": [{"id": "different-order", "status": 2, "tradedPrice": 101.5}],
        }

        with self.assertRaisesRegex(RuntimeError, "no matching order"):
            place_live_order(fyers, "NSE:NIFTY2611545000CE", 65, 1)

    def test_exit_is_blocked_when_broker_quantity_differs(self):
        trader = object.__new__(OptionTrader)
        trader.settings = {"live": True}
        trader.rest = FakeFyers([{
            "symbol": "NSE:NIFTY2611545000CE",
            "productType": "INTRADAY",
            "netQty": 65,
        }])
        trader.position = {
            "symbol": "NSE:NIFTY2611545000CE",
            "product_type": "INTRADAY",
            "qty": 130,
            "entry_fill": 100,
        }
        trader._halt = Mock()
        trader._order = Mock()

        trader._exit("target")

        trader._halt.assert_called_once()
        trader._order.assert_not_called()
        self.assertEqual(trader.position["qty"], 130)

    def test_restart_preserves_pending_order_when_broker_is_flat(self):
        with tempfile.TemporaryDirectory() as directory:
            state_file = Path(directory) / "position.json"
            state = {
                "symbol": "NSE:NIFTY2611545000CE",
                "entry_pending": True,
                "entry_order_id": "fyers-order-123",
            }
            state_file.write_text(json.dumps(state), encoding="utf-8")
            trader = object.__new__(OptionTrader)
            trader.settings = {"live": True}
            trader.rest = FakeFyers()
            trader.position_state_file = state_file
            trader._halt = Mock()

            trader._reconcile_position()

            trader._halt.assert_called_once()
            self.assertTrue(state_file.exists())
            self.assertEqual(json.loads(state_file.read_text(encoding="utf-8"))["entry_order_id"], "fyers-order-123")


if __name__ == "__main__":
    unittest.main()