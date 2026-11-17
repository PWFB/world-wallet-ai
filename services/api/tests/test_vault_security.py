import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vault_security


class Cursor:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class FakeDB:
    profile = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, query, params=()):
        if "SELECT receiver_email,verified_at" in query:
            return Cursor(self.profile)
        if "SELECT COUNT(*)" in query:
            return Cursor((0,))
        return Cursor(None)

    def commit(self):
        return None


class VaultSecurityTests(unittest.TestCase):
    def setUp(self):
        FakeDB.profile = None
        self.router = vault_security.build_vault_security_router(
            db_factory=FakeDB,
            current_user_dependency=lambda: {"id": "vault-user", "email": "owner@example.com"},
        )

    def route(self, path):
        return next(route for route in self.router.routes if route.path == path)

    def test_secret_room_routes_are_registered(self):
        paths = {route.path for route in self.router.routes}
        self.assertIn("/api/v1/vault-security/email/status", paths)
        self.assertIn("/api/v1/vault-security/email/enroll", paths)
        self.assertIn("/api/v1/vault-security/email/verify", paths)
        self.assertIn("/api/v1/vault-security/access/request", paths)
        self.assertIn("/api/v1/vault-security/access/verify", paths)
        self.assertIn("/api/v1/vault-security/access/consume", paths)

    def test_receiver_address_must_be_gmail(self):
        self.assertEqual(
            vault_security.normalize_gmail("Wallet.Access+codes@gmail.com"),
            "wallet.access+codes@gmail.com",
        )
        with self.assertRaises(HTTPException) as raised:
            vault_security.normalize_gmail("not-a-gmail@example.com")
        self.assertEqual(raised.exception.status_code, 400)

    def test_code_hash_is_bound_to_account_purpose_and_receiver(self):
        with patch.dict("os.environ", {"WORLD_WALLET_SECRET_ENCRYPTION_KEY": "test-only-secret"}):
            first = vault_security._code_hash("user-a", "access", "receiver@gmail.com", "123456")
            self.assertEqual(first, vault_security._code_hash("user-a", "access", "receiver@gmail.com", "123456"))
            self.assertNotEqual(first, vault_security._code_hash("user-b", "access", "receiver@gmail.com", "123456"))
            self.assertNotEqual(first, vault_security._code_hash("user-a", "enroll", "receiver@gmail.com", "123456"))
            self.assertNotEqual(first, vault_security._code_hash("user-a", "access", "other@gmail.com", "123456"))

    def test_verified_receiver_cannot_be_replaced_from_login_flow(self):
        FakeDB.profile = ("already-verified@gmail.com", datetime.now(timezone.utc))
        with patch.dict("os.environ", {
            "WORLD_WALLET_SECRET_ENCRYPTION_KEY": "test-only-secret",
            "BANKCONNECT_SMTP_USERNAME": "sender@gmail.com",
            "BANKCONNECT_SMTP_APP_PASSWORD": "test-app-password",
            "BANKCONNECT_SMTP_FROM_EMAIL": "sender@gmail.com",
        }):
            with self.assertRaises(HTTPException) as raised:
                self.route("/api/v1/vault-security/email/enroll").endpoint(
                    request=vault_security.ReceiverEmailRequest(receiver_email="attacker@gmail.com"),
                    user={"id": "vault-user", "email": "owner@example.com"},
                )
        self.assertEqual(raised.exception.status_code, 409)

    def test_access_code_requires_a_verified_receiver(self):
        with patch.dict("os.environ", {
            "WORLD_WALLET_SECRET_ENCRYPTION_KEY": "test-only-secret",
            "BANKCONNECT_SMTP_USERNAME": "sender@gmail.com",
            "BANKCONNECT_SMTP_APP_PASSWORD": "test-app-password",
            "BANKCONNECT_SMTP_FROM_EMAIL": "sender@gmail.com",
        }):
            with self.assertRaises(HTTPException) as raised:
                self.route("/api/v1/vault-security/access/request").endpoint(
                    user={"id": "vault-user", "email": "owner@example.com"},
                )
        self.assertEqual(raised.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
