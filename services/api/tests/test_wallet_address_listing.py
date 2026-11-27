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


class Connection:
    def __init__(self, owner=True):
        self.owner = owner
        self.statements = []
        self.params = []

    def execute(self, sql, params=None):
        normalized = " ".join(sql.split()).lower()
        self.statements.append(normalized)
        self.params.append(params)
        if normalized.startswith("select id,name from wallets where id=%s and owner_id=%s"):
            return Result(("wallet_test", "Personal Wallet") if self.owner else None)
        if normalized.startswith("select network,address,label,created_at,ownership_verified from wallet_addresses"):
            return Result(rows=[
                ("ethereum", "0x1111111111111111111111111111111111111111", "primary",
                 datetime.now(timezone.utc), False),
                ("bnb", "0x2222222222222222222222222222222222222222", "secondary",
                 datetime.now(timezone.utc), True),
            ])
        raise AssertionError("Unexpected SQL: " + normalized)


class Database:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, exc_type, exc, tb):
        return False


class WalletAddressListingTests(unittest.TestCase):
    def test_address_listing_is_owner_scoped_and_preserves_verification_state(self):
        connection = Connection(owner=True)
        with patch.object(main, "db", return_value=Database(connection)):
            result = main.list_wallet_addresses("wallet_test", {"id": "user_test"})

        self.assertEqual(result["wallet_id"], "wallet_test")
        self.assertEqual(len(result["addresses"]), 2)
        self.assertFalse(result["addresses"][0]["ownership_verified"])
        self.assertTrue(result["addresses"][1]["ownership_verified"])
        owner_query = next(
            (sql, params) for sql, params in zip(connection.statements, connection.params)
            if sql.startswith("select id,name from wallets")
        )
        self.assertIn("owner_id=%s", owner_query[0])
        self.assertEqual(owner_query[1], ("wallet_test", "user_test"))

    def test_foreign_wallet_address_listing_returns_not_found_before_reading_addresses(self):
        from fastapi import HTTPException

        connection = Connection(owner=False)
        with patch.object(main, "db", return_value=Database(connection)):
            with self.assertRaises(HTTPException) as caught:
                main.list_wallet_addresses("wallet_foreign", {"id": "user_test"})

        self.assertEqual(caught.exception.status_code, 404)
        self.assertFalse(any(sql.startswith("select network,address,label,created_at,ownership_verified") for sql in connection.statements))


if __name__ == "__main__":
    unittest.main()
