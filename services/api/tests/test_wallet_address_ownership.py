import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class Result:
    def __init__(self, row=None, rowcount=0):
        self.row = row
        self.rowcount = rowcount

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self, challenge):
        self.challenge = list(challenge)
        self.statements = []

    def execute(self, sql, params=None):
        self.statements.append(sql)
        normalized = " ".join(sql.split()).lower()
        if normalized.startswith("select network,address,message,expires_at,used_at"):
            return Result(tuple(self.challenge))
        if normalized.startswith("update wallet_addresses set ownership_verified=true"):
            return Result(rowcount=1)
        if normalized.startswith("update wallet_address_challenges set used_at=now()"):
            if self.challenge[4] is not None:
                return Result(rowcount=0)
            self.challenge[4] = datetime.now(timezone.utc)
            return Result(rowcount=1)
        if normalized.startswith("select ownership_verified from wallet_addresses"):
            return Result((False,))
        raise AssertionError("Unexpected SQL: " + normalized)

    def commit(self):
        pass


class FakeDatabaseContext:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, exc_type, exc, tb):
        return False


class WalletAddressOwnershipTests(unittest.TestCase):
    def test_valid_signature_verifies_attached_address_and_locks_challenge(self):
        from eth_account import Account
        from eth_account.messages import encode_defunct

        account = Account.create()
        message = "World Wallet AI ownership challenge\nWallet: wallet_test"
        challenge = (
            "ethereum",
            account.address,
            message,
            datetime.now(timezone.utc) + timedelta(minutes=5),
            None,
        )
        connection = FakeConnection(challenge)
        signature = Account.sign_message(
            encode_defunct(text=message), private_key=account.key
        ).signature.hex()
        request = main.WalletAddressVerifyRequest(
            challenge_id="wac_test_challenge_1234",
            signature=signature,
        )
        with patch.object(main, "db", return_value=FakeDatabaseContext(connection)):
            result = main.verify_wallet_address(
                "wallet_test", request, {"id": "user_test"}
            )

        self.assertEqual(result["status"], "verified")
        self.assertTrue(result["ownership_verified"])
        self.assertTrue(any("FOR UPDATE" in sql.upper() for sql in connection.statements))
        self.assertIsNotNone(connection.challenge[4])

    def test_used_challenge_cannot_be_replayed(self):
        from eth_account import Account
        from eth_account.messages import encode_defunct
        from fastapi import HTTPException

        account = Account.create()
        message = "World Wallet AI ownership challenge"
        challenge = (
            "ethereum",
            account.address,
            message,
            datetime.now(timezone.utc) + timedelta(minutes=5),
            datetime.now(timezone.utc),
        )
        connection = FakeConnection(challenge)
        signature = Account.sign_message(
            encode_defunct(text=message), private_key=account.key
        ).signature.hex()
        request = main.WalletAddressVerifyRequest(
            challenge_id="wac_test_challenge_1234",
            signature=signature,
        )
        with patch.object(main, "db", return_value=FakeDatabaseContext(connection)):
            with self.assertRaises(HTTPException) as caught:
                main.verify_wallet_address(
                    "wallet_test", request, {"id": "user_test"}
                )
        self.assertEqual(caught.exception.status_code, 409)

    def test_unverified_evm_source_cannot_create_withdrawal(self):
        from decimal import Decimal
        from fastapi import HTTPException

        source = "0x" + "1" * 40
        connection = FakeConnection((False,))
        request = main.WithdrawalRequest(
            idempotency_key="withdraw_test_01",
            asset="ETH",
            amount=Decimal("0.01"),
            destination="0x" + "2" * 40,
            network="ethereum",
            source_address=source,
        )
        user = {"id": "user_test", "wallet_id": "wallet_test"}
        with patch.object(main, "db", return_value=FakeDatabaseContext(connection)):
            with self.assertRaises(HTTPException) as caught:
                main.withdrawal(request, user)
        self.assertEqual(caught.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
