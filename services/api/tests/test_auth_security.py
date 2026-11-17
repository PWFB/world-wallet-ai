import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import auth_security


class Cursor:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class FakeDB:
    profile = None
    challenges = []
    grants = []
    next_id = 1

    @classmethod
    def reset(cls):
        cls.profile = None
        cls.challenges = []
        cls.grants = []
        cls.next_id = 1

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def commit(self):
        return None

    def execute(self, query, params=()):
        sql = " ".join(str(query).split())
        if sql.startswith("CREATE TABLE") or sql.startswith("CREATE INDEX"):
            return Cursor()
        if "SELECT receiver_email,account_email,verified_at" in sql:
            return Cursor(self.profile)
        if "SELECT COUNT(*) FROM world_wallet_auth_recovery_challenges" in sql:
            owner_id, purpose = params
            count = sum(1 for item in self.challenges if item["owner_id"] == owner_id and item["purpose"] == purpose)
            return Cursor((count,))
        if "INSERT INTO world_wallet_auth_recovery_emails" in sql:
            owner_id, account_email, receiver_email = params
            self.__class__.profile = (receiver_email, account_email, None)
            return Cursor()
        if "INSERT INTO world_wallet_auth_recovery_challenges" in sql:
            owner_id, purpose, receiver_email, code_hash = params
            item_id = self.__class__.next_id
            self.__class__.next_id += 1
            self.challenges.append({
                "id": item_id, "owner_id": owner_id, "purpose": purpose,
                "receiver_email": receiver_email, "code_hash": code_hash,
                "attempts": 0, "used": False,
            })
            return Cursor()
        if "SELECT id,receiver_email,code_hash,attempts" in sql:
            owner_id, purpose = params
            active = [
                item for item in self.challenges
                if item["owner_id"] == owner_id and item["purpose"] == purpose and not item["used"]
            ]
            if not active:
                return Cursor(None)
            item = max(active, key=lambda value: value["id"])
            return Cursor((item["id"], item["receiver_email"], item["code_hash"], item["attempts"]))
        if "UPDATE world_wallet_auth_recovery_challenges SET used_at=NOW() WHERE id=%s" in sql:
            item_id = params[0]
            for item in self.challenges:
                if item["id"] == item_id:
                    item["used"] = True
            return Cursor()
        if "UPDATE world_wallet_auth_recovery_challenges SET attempts=attempts+1" in sql:
            item_id = params[0]
            for item in self.challenges:
                if item["id"] == item_id:
                    item["attempts"] += 1
            return Cursor()
        if "UPDATE world_wallet_auth_recovery_challenges SET used_at=NOW()" in sql and "WHERE owner_id=%s AND purpose=%s" in sql:
            owner_id, purpose = params
            for item in self.challenges:
                if item["owner_id"] == owner_id and item["purpose"] == purpose:
                    item["used"] = True
            return Cursor()
        if "UPDATE world_wallet_auth_recovery_emails" in sql and "SET verified_at=NOW()" in sql:
            owner_id, receiver_email, account_email = params
            if self.profile and self.profile[0] == receiver_email and self.profile[1] == account_email:
                self.__class__.profile = (receiver_email, account_email, "verified")
            return Cursor()
        if "INSERT INTO world_wallet_auth_password_grants" in sql:
            owner_id, token_hash = params
            item_id = self.__class__.next_id
            self.__class__.next_id += 1
            self.grants.append({"id": item_id, "owner_id": owner_id, "token_hash": token_hash, "used": False})
            return Cursor()
        if "UPDATE world_wallet_auth_password_grants SET used_at=NOW()" in sql and "RETURNING id" in sql:
            owner_id, token_hash = params
            for item in self.grants:
                if item["owner_id"] == owner_id and item["token_hash"] == token_hash and not item["used"]:
                    item["used"] = True
                    return Cursor((item["id"],))
            return Cursor(None)
        if "UPDATE world_wallet_auth_password_grants SET used_at=NOW()" in sql:
            owner_id = params[0]
            for item in self.grants:
                if item["owner_id"] == owner_id:
                    item["used"] = True
            return Cursor()
        return Cursor()


class AuthSecurityTests(unittest.TestCase):
    def setUp(self):
        FakeDB.reset()
        self.user = {"id": "account-123", "email": "login@gmail.com"}
        self.router = auth_security.build_auth_security_router(
            db_factory=FakeDB,
            current_user_dependency=lambda: self.user,
        )

    def route(self, path):
        full_path = path if path.startswith("/api/") else "/api/v1/auth/neon/account-security" + path
        return next(route for route in self.router.routes if route.path == full_path)

    def test_account_security_routes_are_registered(self):
        paths = {route.path for route in self.router.routes}
        self.assertIn("/api/v1/auth/neon/account-security/receiver-email/status", paths)
        self.assertIn("/api/v1/auth/neon/account-security/receiver-email/request", paths)
        self.assertIn("/api/v1/auth/neon/account-security/receiver-email/verify", paths)
        self.assertIn("/api/v1/auth/neon/account-security/password-change/request", paths)
        self.assertIn("/api/v1/auth/neon/account-security/password-change/verify", paths)
        self.assertIn("/api/v1/auth/neon/account-security/password-change/complete", paths)

    def test_receiver_gmail_is_normalized_and_non_gmail_is_rejected(self):
        self.assertEqual(auth_security.normalize_gmail("Codes+balmz@Gmail.com"), "codes+balmz@gmail.com")
        with self.assertRaises(HTTPException) as raised:
            auth_security.normalize_gmail("not-gmail@example.com")
        self.assertEqual(raised.exception.status_code, 400)

    def test_receiver_must_be_different_from_login_email(self):
        with patch.dict(os.environ, {"WORLD_WALLET_SECRET_ENCRYPTION_KEY": "unit-test-key"}):
            with self.assertRaises(HTTPException) as raised:
                self.route("/receiver-email/request").endpoint(
                    request=auth_security.ReceiverEmailRequest(receiver_email="login@gmail.com"),
                    user=self.user,
                )
        self.assertEqual(raised.exception.status_code, 400)

    def test_code_hash_is_bound_to_account_purpose_and_receiver(self):
        with patch.dict(os.environ, {"WORLD_WALLET_SECRET_ENCRYPTION_KEY": "unit-test-key"}):
            base = auth_security._code_hash("user-a", "receiver_verify", "receiver@gmail.com", "123456")
            self.assertEqual(base, auth_security._code_hash("user-a", "receiver_verify", "receiver@gmail.com", "123456"))
            self.assertNotEqual(base, auth_security._code_hash("user-b", "receiver_verify", "receiver@gmail.com", "123456"))
            self.assertNotEqual(base, auth_security._code_hash("user-a", "password_change", "receiver@gmail.com", "123456"))
            self.assertNotEqual(base, auth_security._code_hash("user-a", "receiver_verify", "other@gmail.com", "123456"))

    def test_two_distinct_codes_go_to_the_same_receiver_and_grant_is_single_use(self):
        sent = []
        env = {
            "WORLD_WALLET_SECRET_ENCRYPTION_KEY": "unit-test-key",
            "BANKCONNECT_SMTP_USERNAME": "sender@gmail.com",
            "BANKCONNECT_SMTP_APP_PASSWORD": "test-app-password",
            "BANKCONNECT_SMTP_FROM_EMAIL": "sender@gmail.com",
        }
        with patch.dict(os.environ, env), patch.object(auth_security, "_send_security_code", side_effect=lambda address, code, purpose: sent.append((address, code, purpose))), patch.object(auth_security.secrets, "randbelow", side_effect=[0, 1]):
            self.route("/receiver-email/request").endpoint(
                request=auth_security.ReceiverEmailRequest(receiver_email="receiver@gmail.com"),
                user=self.user,
            )
            self.route("/receiver-email/verify").endpoint(
                request=auth_security.EmailCodeRequest(code="100000"),
                user=self.user,
            )
            self.route("/password-change/request").endpoint(user=self.user)
            grant = self.route("/password-change/verify").endpoint(
                request=auth_security.EmailCodeRequest(code="100000"),
                user=self.user,
            )
            self.assertTrue(grant["verified"])
            self.assertEqual([item[0] for item in sent], ["receiver@gmail.com", "receiver@gmail.com"])
            self.assertEqual([item[2] for item in sent], ["receiver_verify", "password_change"])
            self.assertNotEqual(sent[0][1], sent[1][1])
            request = auth_security.PasswordChangeGrantRequest(grant_token=grant["grant_token"])
            self.assertTrue(self.route("/password-change/complete").endpoint(request=request, user=self.user)["authorized"])
            with self.assertRaises(HTTPException) as raised:
                self.route("/password-change/complete").endpoint(request=request, user=self.user)
            self.assertEqual(raised.exception.status_code, 403)

    def test_password_change_code_requires_verified_receiver(self):
        with patch.dict(os.environ, {
            "WORLD_WALLET_SECRET_ENCRYPTION_KEY": "unit-test-key",
            "BANKCONNECT_SMTP_USERNAME": "sender@gmail.com",
            "BANKCONNECT_SMTP_APP_PASSWORD": "test-app-password",
            "BANKCONNECT_SMTP_FROM_EMAIL": "sender@gmail.com",
        }):
            with self.assertRaises(HTTPException) as raised:
                self.route("/password-change/request").endpoint(user=self.user)
        self.assertEqual(raised.exception.status_code, 409)

    def test_smtp_delivery_targets_the_receiver_mailbox(self):
        smtp = MagicMock()
        smtp.__enter__.return_value = smtp
        with patch.dict(os.environ, {
            "BANKCONNECT_SMTP_HOST": "smtp.gmail.com",
            "BANKCONNECT_SMTP_PORT": "465",
            "BANKCONNECT_SMTP_USERNAME": "sender@gmail.com",
            "BANKCONNECT_SMTP_APP_PASSWORD": "test-app-password",
            "BANKCONNECT_SMTP_FROM_EMAIL": "sender@gmail.com",
        }), patch("auth_security.smtplib.SMTP_SSL", return_value=smtp):
            auth_security._send_security_code("receiver@gmail.com", "123456", "password_change")
        self.assertEqual(smtp.send_message.call_args.kwargs["to_addrs"], ["receiver@gmail.com"])
        self.assertIn("123456", smtp.send_message.call_args.args[0].get_content())


if __name__ == "__main__":
    unittest.main()
