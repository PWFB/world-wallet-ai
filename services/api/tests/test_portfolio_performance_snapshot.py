import unittest
from datetime import datetime, timezone
from unittest.mock import patch

try:
    from services.api import main
except ModuleNotFoundError:
    import main


class FakeResult:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self, rows):
        self.rows = iter(rows)
        self.statements = []

    def execute(self, query, params=None):
        self.statements.append((query, params))
        try:
            row = next(self.rows)
        except StopIteration as exc:
            raise AssertionError("Unexpected database query") from exc
        return FakeResult(row)


class FakeDatabaseContext:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, exc_type, exc, traceback):
        return False


class PortfolioPerformanceSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.user = {"id": "user-test", "wallet_id": "wallet-test"}
        self.timestamp = datetime(2026, 11, 9, 13, 0, tzinfo=timezone.utc)

    def _summary(self):
        return {"available_balance_usd": 123.45, "valuation_complete": True}

    def test_new_snapshot_serializes_inserted_timestamp_row(self):
        connection = FakeConnection([(self.timestamp,)])
        with (
            patch.object(main, "wallet_snapshot", return_value=([], [], self._summary())),
            patch.object(main, "db", return_value=FakeDatabaseContext(connection)),
        ):
            result = main.record_portfolio_performance_snapshot(self.user)

        self.assertTrue(result["recorded"])
        self.assertEqual(result["timestamp"], self.timestamp.isoformat())
        self.assertEqual(result["value_usd"], 123.45)
        self.assertEqual(len(connection.statements), 1)

    def test_recent_snapshot_serializes_fetched_timestamp_row_without_inserting(self):
        connection = FakeConnection([None, (self.timestamp,)])
        with (
            patch.object(main, "wallet_snapshot", return_value=([], [], self._summary())),
            patch.object(main, "db", return_value=FakeDatabaseContext(connection)),
        ):
            result = main.record_portfolio_performance_snapshot(self.user)

        self.assertFalse(result["recorded"])
        self.assertEqual(result["timestamp"], self.timestamp.isoformat())
        self.assertEqual(result["value_usd"], 123.45)
        self.assertEqual(len(connection.statements), 2)

    def test_incomplete_valuation_does_not_query_database(self):
        with (
            patch.object(main, "wallet_snapshot", return_value=([], [], {
                "available_balance_usd": None,
                "valuation_complete": False,
            })),
            patch.object(main, "db") as database,
        ):
            result = main.record_portfolio_performance_snapshot(self.user)

        database.assert_not_called()
        self.assertFalse(result["recorded"])
        self.assertIn("complete verified USD valuation", result["reason"])


if __name__ == "__main__":
    unittest.main()
