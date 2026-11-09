import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class Result:
    def __init__(self, row=None, rows=None):
        self.row = row
        self.rows = list(rows or [])

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self):
        self.statements = []

    def execute(self, sql, params=None):
        self.statements.append((sql, params))
        normalized = " ".join(sql.split()).lower()
        if normalized.startswith("insert into wallets"):
            return Result(row=(12345678901,))
        if normalized.startswith("select id,name,created_at,wallet_number from wallets"):
            return Result(rows=[("wallet_test", "Personal Wallet", datetime.now(timezone.utc), 12345678901)])
        if normalized.startswith("select id,name,wallet_number from wallets"):
            return Result(row=("wallet_test", "Personal Wallet", 12345678901))
        return Result()

    def commit(self):
        pass


class FakeDatabaseContext:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, exc_type, exc, tb):
        return False


class WalletPublicIdTests(unittest.TestCase):
    def setUp(self):
        self.connection = FakeConnection()
        self.database = FakeDatabaseContext(self.connection)

    def test_create_wallet_returns_database_assigned_11_digit_id(self):
        request = main.WalletCreateRequest(name="Personal Wallet")
        with patch.object(main, "db", return_value=self.database):
            result = main.create_wallet(request, {"id": "user_test", "wallet_id": "wallet_old"})
        self.assertEqual(result["wallet"]["wallet_number"], "12345678901")
        self.assertRegex(result["wallet"]["wallet_number"], r"^\d{11}$")
        insert = next(sql for sql, _ in self.connection.statements if "INSERT INTO wallets" in sql)
        self.assertIn("RETURNING WALLET_NUMBER", insert.upper())

    def test_wallet_list_returns_stable_11_digit_id(self):
        with patch.object(main, "db", return_value=self.database):
            result = main.list_wallets({"id": "user_test", "wallet_id": "wallet_test"})
        self.assertEqual(result["wallets"][0]["wallet_number"], "12345678901")

    def test_active_wallet_response_includes_public_id(self):
        request = main.WalletActivateRequest(wallet_id="wallet_test")
        with patch.object(main, "db", return_value=self.database):
            result = main.activate_wallet(request, {"id": "user_test", "wallet_id": "wallet_old"})
        self.assertEqual(result["wallet"]["wallet_number"], "12345678901")

    def test_schema_adds_unique_range_checked_number_without_replacing_wallet_rows(self):
        with patch.object(main, "DATABASE_URL", "postgresql://test"), patch.object(main, "db", return_value=self.database):
            main.init_db()
        ddl = "\n".join(sql for sql, _ in self.connection.statements)
        self.assertIn("CREATE SEQUENCE IF NOT EXISTS wallets_wallet_number_seq", ddl)
        self.assertIn("ALTER TABLE wallets ADD COLUMN IF NOT EXISTS wallet_number BIGINT", ddl)
        self.assertIn("UPDATE wallets SET wallet_number=nextval('wallets_wallet_number_seq') WHERE wallet_number IS NULL", ddl)
        self.assertIn("wallets_wallet_number_unique", ddl)
        self.assertIn("wallet_number_11_digits", ddl)
        self.assertNotIn("DELETE FROM wallets", ddl.upper())


if __name__ == "__main__":
    unittest.main()
