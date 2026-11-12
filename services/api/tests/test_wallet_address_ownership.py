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
        if normalized.startswith("insert into wallet_audit_events"):
            return Result()
        raise AssertionError("Unexpected SQL: " + normalized)

    def commit(self):
        pass


class AdminAddressConnection:
    def __init__(self, existing=None):
        self.existing = existing
        self.inserted = False
        self.statements = []

    def execute(self, sql, params=None):
        normalized = " ".join(sql.split()).lower()
        self.statements.append(normalized)
        if normalized.startswith("select id from wallets where id=%s and owner_id=%s"):
            return Result(("wallet_test",))
        if normalized.startswith("select wallet_id,ownership_verified from wallet_addresses"):
            return Result(self.existing)
        if normalized.startswith("insert into wallet_addresses"):
            self.inserted = True
            return Result()
        if normalized.startswith("select ownership_verified from wallet_addresses"):
            return Result((False,))
        if normalized.startswith("insert into wallet_audit_events"):
            return Result()
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

    def test_erc1271_smart_wallet_signature_verifies_with_read_only_mainnet_call(self):
        from eth_account import Account
        from eth_account.messages import encode_defunct

        owner = "0x1111111111111111111111111111111111111111"
        signer = Account.create()
        message = "World Wallet AI ownership challenge\nWallet: wallet_test"
        challenge = (
            "ethereum",
            owner,
            message,
            datetime.now(timezone.utc) + timedelta(minutes=5),
            None,
        )
        connection = FakeConnection(challenge)
        signature = Account.sign_message(
            encode_defunct(text=message), private_key=signer.key
        ).signature.hex()
        request = main.WalletAddressVerifyRequest(
            challenge_id="wac_test_smart_wallet_1234",
            signature=signature,
        )
        with (
            patch.object(main, "db", return_value=FakeDatabaseContext(connection)),
            patch.object(main, "ETH_RPC_URL", "https://ethereum.example"),
            patch.object(main, "require_ethereum_mainnet_rpc") as chain_check,
            patch.object(main, "rpc_call", return_value="0x1626ba7e" + "0" * 56) as rpc,
        ):
            result = main.verify_wallet_address(
                "wallet_test", request, {"id": "user_test"}
            )

        self.assertEqual(result["status"], "verified")
        self.assertTrue(result["ownership_verified"])
        chain_check.assert_called_once_with("https://ethereum.example")
        rpc.assert_called_once()
        self.assertEqual(rpc.call_args.args[1], "eth_call")
        self.assertTrue(rpc.call_args.args[2][0]["data"].startswith("0x"))
        self.assertIsNotNone(connection.challenge[4])

    def test_erc1271_invalid_magic_value_does_not_verify_smart_wallet(self):
        from eth_account import Account
        from eth_account.messages import encode_defunct
        from fastapi import HTTPException

        owner = "0x1111111111111111111111111111111111111111"
        signer = Account.create()
        message = "World Wallet AI ownership challenge"
        challenge = (
            "ethereum",
            owner,
            message,
            datetime.now(timezone.utc) + timedelta(minutes=5),
            None,
        )
        connection = FakeConnection(challenge)
        signature = Account.sign_message(
            encode_defunct(text=message), private_key=signer.key
        ).signature.hex()
        request = main.WalletAddressVerifyRequest(
            challenge_id="wac_test_smart_wallet_5678",
            signature=signature,
        )
        with (
            patch.object(main, "db", return_value=FakeDatabaseContext(connection)),
            patch.object(main, "ETH_RPC_URL", "https://ethereum.example"),
            patch.object(main, "require_ethereum_mainnet_rpc"),
            patch.object(main, "rpc_call", return_value="0xffffffff" + "0" * 56),
        ):
            with self.assertRaises(HTTPException) as caught:
                main.verify_wallet_address(
                    "wallet_test", request, {"id": "user_test"}
                )

        self.assertEqual(caught.exception.status_code, 400)
        self.assertIsNone(connection.challenge[4])

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

    def test_admin_default_okx_address_attaches_as_unverified_to_active_wallet(self):
        from fastapi import HTTPException

        address = "0xBbDb482aE0895e496676eC84501d2945a404FF2C"
        connection = AdminAddressConnection()
        user = {"id": "user_test", "email": "admin@example.com"}
        with (
            patch.object(main, "db", return_value=FakeDatabaseContext(connection)),
            patch.object(main, "WORLD_WALLET_ADMIN_EMAIL", "admin@example.com"),
            patch.object(main, "WORLD_WALLET_ADMIN_EVM_ADDRESS", address),
        ):
            result = main.attach_admin_default_evm_address("wallet_test", user)

        self.assertEqual(result["status"], "attached")
        self.assertEqual(result["address"]["network"], "ethereum")
        self.assertEqual(result["address"]["address"], address)
        self.assertFalse(result["address"]["ownership_verified"])
        self.assertTrue(connection.inserted)

    def test_admin_default_okx_address_is_not_available_to_non_admin(self):
        from fastapi import HTTPException

        user = {"id": "user_test", "email": "member@example.com"}
        with (
            patch.object(main, "WORLD_WALLET_ADMIN_EMAIL", "admin@example.com"),
            patch.object(main, "db") as database,
        ):
            with self.assertRaises(HTTPException) as caught:
                main.attach_admin_default_evm_address(
                    "wallet_test", user
                )

        self.assertEqual(caught.exception.status_code, 403)
        database.assert_not_called()

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
