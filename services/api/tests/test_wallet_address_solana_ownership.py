import base64
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import HTTPException


def base58_encode(data):
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    number = int.from_bytes(data, "big")
    encoded = ""
    while number:
        number, remainder = divmod(number, 58)
        encoded = alphabet[remainder] + encoded
    leading = len(data) - len(data.lstrip(b"\x00"))
    return "1" * leading + (encoded or ("" if leading else "1"))


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
        normalized = " ".join(sql.split()).lower()
        self.statements.append(normalized)
        if normalized.startswith("select network,address,message,expires_at,used_at"):
            return Result(tuple(self.challenge))
        if normalized.startswith("update wallet_addresses set ownership_verified=true"):
            return Result(rowcount=1)
        if normalized.startswith("update wallet_address_challenges set used_at=now()"):
            if self.challenge[4] is not None:
                return Result(rowcount=0)
            self.challenge[4] = datetime.now(timezone.utc)
            return Result(rowcount=1)
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


class SolanaWalletAddressOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.private_key = Ed25519PrivateKey.generate()
        public_key = self.private_key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        self.address = base58_encode(public_key)
        self.message = "World Wallet AI address ownership verification\nWallet: wallet_test\nNetwork: solana_mainnet\nAddress: " + self.address + "\nChallenge: wac_test"
        self.challenge = (
            "solana_mainnet",
            self.address,
            self.message,
            datetime.now(timezone.utc) + timedelta(minutes=5),
            None,
        )
        self.connection = FakeConnection(self.challenge)

    def request(self, signature):
        return main.WalletAddressVerifyRequest(
            challenge_id="wac_test_challenge_1234",
            signature=signature,
        )

    def test_valid_ed25519_signature_verifies_solana_address(self):
        signature = base64.b64encode(self.private_key.sign(self.message.encode())).decode()
        with patch.object(main, "db", return_value=FakeDatabaseContext(self.connection)):
            result = main.verify_wallet_address("wallet_test", self.request(signature), {"id": "user_test"})
        self.assertEqual(result["status"], "verified")
        self.assertTrue(result["ownership_verified"])
        self.assertTrue(any("for update" in sql for sql in self.connection.statements))
        self.assertIsNotNone(self.connection.challenge[4])

    def test_invalid_signature_is_rejected(self):
        wrong_key = Ed25519PrivateKey.generate()
        signature = base64.b64encode(wrong_key.sign(self.message.encode())).decode()
        with patch.object(main, "db", return_value=FakeDatabaseContext(self.connection)):
            with self.assertRaises(HTTPException) as caught:
                main.verify_wallet_address("wallet_test", self.request(signature), {"id": "user_test"})
        self.assertEqual(caught.exception.status_code, 400)

    def test_expired_challenge_is_rejected(self):
        self.connection.challenge[3] = datetime.now(timezone.utc) - timedelta(seconds=1)
        signature = base64.b64encode(self.private_key.sign(self.message.encode())).decode()
        with patch.object(main, "db", return_value=FakeDatabaseContext(self.connection)):
            with self.assertRaises(HTTPException) as caught:
                main.verify_wallet_address("wallet_test", self.request(signature), {"id": "user_test"})
        self.assertEqual(caught.exception.status_code, 410)


if __name__ == "__main__":
    unittest.main()
