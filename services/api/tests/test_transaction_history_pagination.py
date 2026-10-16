import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class TransactionHistoryPaginationTests(unittest.TestCase):
    def test_history_page_is_scoped_and_returns_pagination_metadata(self):
        now = datetime(2026, 10, 16, tzinfo=timezone.utc)
        row = ("tx-1", "received", "ETH", "Ethereum transaction", "1.25",
               "confirmed", "0xabc", 12, 123, "ethereum", "0xblock", None, now)

        class Cursor:
            def __init__(self, row=None, rows=None):
                self.row, self.rows = row, rows or []
            def fetchone(self):
                return self.row
            def fetchall(self):
                return self.rows

        class Connection:
            def __init__(self):
                self.calls = []
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def execute(self, query, params):
                self.calls.append((query, params))
                if "COUNT(*)" in query:
                    return Cursor(row=(3,))
                return Cursor(rows=[row])

        conn = Connection()
        user = {"id": "user-a", "wallet_id": "wallet-a"}
        with patch.object(main, "db", return_value=conn):
            result = main.transactions(user, limit=1, offset=1)

        self.assertEqual(result["transactions"][0]["id"], "tx-1")
        self.assertEqual(result["transactions"][0]["amount"], 1.25)
        self.assertEqual(result["pagination"], {
            "limit": 1, "offset": 1, "total": 3, "has_more": True, "next_offset": 2,
        })
        self.assertEqual(conn.calls[0][1], ("wallet-a",))
        self.assertEqual(conn.calls[1][1], ("wallet-a", 1, 1))
        self.assertIn("WHERE wallet_id=%s", conn.calls[1][0])

    def test_history_page_rejects_out_of_range_limit_without_database_access(self):
        with patch.object(main, "db") as mocked_db:
            with self.assertRaises(main.HTTPException) as caught:
                main.transactions({"wallet_id": "wallet-a"}, limit=101, offset=0)
        self.assertEqual(caught.exception.status_code, 400)
        mocked_db.assert_not_called()

    def test_history_page_rejects_negative_offset_without_database_access(self):
        with patch.object(main, "db") as mocked_db:
            with self.assertRaises(main.HTTPException) as caught:
                main.transactions({"wallet_id": "wallet-a"}, limit=50, offset=-1)
        self.assertEqual(caught.exception.status_code, 400)
        mocked_db.assert_not_called()

    def test_last_history_page_has_no_next_offset(self):
        class Cursor:
            def __init__(self, row=None, rows=None):
                self.row, self.rows = row, rows or []
            def fetchone(self):
                return self.row
            def fetchall(self):
                return self.rows
        class Connection:
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def execute(self, query, params):
                return Cursor(row=(2,)) if "COUNT(*)" in query else Cursor(rows=[])
        with patch.object(main, "db", return_value=Connection()):
            result = main.transactions({"wallet_id": "wallet-a"}, limit=50, offset=2)
        self.assertFalse(result["pagination"]["has_more"])
        self.assertIsNone(result["pagination"]["next_offset"])


if __name__ == "__main__":
    unittest.main()
