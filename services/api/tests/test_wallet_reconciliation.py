import sys
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class FakeResult:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, reservations, missing_hashes):
        self.reservations = reservations
        self.missing_hashes = missing_hashes
        self.queries = []

    def execute(self, query, params=None):
        self.queries.append(query)
        if "SELECT a.symbol" in query:
            return FakeResult(self.reservations)
        if "SELECT status,COUNT(*)" in query:
            return FakeResult([("pending", 1), ("settled", 2)])
        if "SELECT id,reference,type,asset,network,status" in query:
            return FakeResult(self.missing_hashes)
        if "SELECT source,last_block,updated_at" in query:
            return FakeResult([("ethereum:native", 123, datetime.now(timezone.utc))])
        raise AssertionError("Unexpected SQL in read-only reconciliation test: " + query)


class FakeDB:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, exc_type, exc, tb):
        return False


class WalletReconciliationTests(unittest.TestCase):
    def test_clear_when_reservations_match_and_no_confirmed_hashes_are_missing(self):
        connection = FakeConnection(
            reservations=[("ETH", Decimal("0.5"), Decimal("0.5"))],
            missing_hashes=[],
        )
        with patch.object(main, "db", return_value=FakeDB(connection)):
            result = main.wallet_reconciliation_snapshot({
                "id": "user-1", "wallet_id": "wallet-1", "wallet_number": "12345678901",
            })

        self.assertEqual(result["status"], "CLEAR")
        self.assertEqual(result["wallet_number"], "12345678901")
        self.assertFalse(result["chain_rpc_requeried"])
        self.assertTrue(result["asset_checks"][0]["matches"])
        self.assertEqual(result["transaction_status_counts"][1]["count"], 2)
        self.assertEqual(len(result["chain_sync_cursors"]), 1)
        self.assertTrue(all(query.lstrip().upper().startswith("SELECT") for query in connection.queries))

    def test_review_required_for_reservation_mismatch_and_confirmed_row_without_hash(self):
        connection = FakeConnection(
            reservations=[("USDT", Decimal("1.2"), Decimal("1.0"))],
            missing_hashes=[("tx-2", "WWTX-ABC", "received", "USDT", "bnb", "confirmed")],
        )
        with patch.object(main, "db", return_value=FakeDB(connection)):
            result = main.wallet_reconciliation_snapshot({
                "id": "user-1", "wallet_id": "wallet-1", "wallet_number": "12345678901",
            })

        self.assertEqual(result["status"], "REVIEW_REQUIRED")
        self.assertEqual(
            [item["type"] for item in result["exceptions"]],
            ["reservation_mismatch", "confirmed_transaction_missing_chain_hash"],
        )
        self.assertTrue(all(query.lstrip().upper().startswith("SELECT") for query in connection.queries))


if __name__ == "__main__":
    unittest.main()
