import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class Result:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class Connection:
    def __init__(self, owner=True, attached=True):
        self.owner = owner
        self.attached = attached
        self.statements = []
        self.params = []

    def execute(self, sql, params=None):
        normalized = " ".join(sql.split()).lower()
        self.statements.append(normalized)
        self.params.append(params)
        if normalized.startswith("select id from wallets where id=%s and owner_id=%s"):
            return Result(("wallet_test",) if self.owner else None)
        if normalized.startswith("select 1 from wallet_addresses"):
            return Result((1,) if self.attached else None)
        if normalized.startswith("insert into wallet_address_challenges"):
            return Result()
        if normalized.startswith("insert into wallet_audit_events"):
            return Result()
        raise AssertionError("Unexpected SQL: " + normalized)

    def commit(self):
        pass


class Database:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, exc_type, exc, tb):
        return False


class WalletAddressChallengeTests(unittest.TestCase):
    def setUp(self):
        self.request = main.WalletAddressChallengeRequest(
            network="ethereum",
            address="0x1111111111111111111111111111111111111111",
        )
        self.user = {"id": "user_test", "email": "member@example.com"}

    def test_challenge_is_issued_only_for_an_attached_address_of_the_owner(self):
        connection = Connection(owner=True, attached=True)
        with (
            patch.object(main, "db", return_value=Database(connection)),
            patch.object(main, "valid_evm_address", return_value=True),
        ):
            result = main.create_wallet_address_challenge("wallet_test", self.request, self.user)

        self.assertTrue(result["challenge_id"].startswith("wac_"))
        self.assertEqual(result["expires_in_seconds"], 600)
        self.assertIn("Network: ethereum", result["message"])
        self.assertIn("does not authorize a transaction", result["message"])
        self.assertTrue(any(sql.startswith("insert into wallet_address_challenges") for sql in connection.statements))

    def test_foreign_wallet_cannot_issue_address_challenge(self):
        from fastapi import HTTPException

        connection = Connection(owner=False, attached=True)
        with (
            patch.object(main, "db", return_value=Database(connection)),
            patch.object(main, "valid_evm_address", return_value=True),
        ):
            with self.assertRaises(HTTPException) as caught:
                main.create_wallet_address_challenge("wallet_foreign", self.request, self.user)

        self.assertEqual(caught.exception.status_code, 404)
        self.assertFalse(any(sql.startswith("insert into wallet_address_challenges") for sql in connection.statements))
        self.assertFalse(any(sql.startswith("select 1 from wallet_addresses") for sql in connection.statements))

    def test_unattached_address_cannot_receive_ownership_challenge(self):
        from fastapi import HTTPException

        connection = Connection(owner=True, attached=False)
        with (
            patch.object(main, "db", return_value=Database(connection)),
            patch.object(main, "valid_evm_address", return_value=True),
        ):
            with self.assertRaises(HTTPException) as caught:
                main.create_wallet_address_challenge("wallet_test", self.request, self.user)

        self.assertEqual(caught.exception.status_code, 404)
        self.assertIn("Attach this address", caught.exception.detail)
        self.assertFalse(any(sql.startswith("insert into wallet_address_challenges") for sql in connection.statements))


if __name__ == "__main__":
    unittest.main()
