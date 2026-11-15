import asyncio
import sys
import unittest
from pathlib import Path

from fastapi import HTTPException
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bankconnect


class FakeCursor:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class FakeDB:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, query, params=()):
        # No verified email profile exists in this isolated test database.
        return FakeCursor(None)

    def commit(self):
        return None


class BankConnectEmailTests(unittest.TestCase):
    def setUp(self):
        self.user = {"id": "bankconnect-user-test", "wallet_id": "wallet-test"}

    def router(self, user=None):
        return bankconnect.build_bankconnect_router(
            db_factory=FakeDB,
            current_user_dependency=lambda: user or self.user,
        )

    def test_expected_account_access_and_email_routes_are_registered(self):
        paths = {route.path for route in self.router().routes}
        self.assertIn("/api/v1/bankconnect/email/settings", paths)
        self.assertIn("/api/v1/bankconnect/email/request-code", paths)
        self.assertIn("/api/v1/bankconnect/email/verify-code", paths)
        self.assertIn("/api/v1/bankconnect/link-token", paths)
        self.assertIn("/api/v1/bankconnect/accounts", paths)

    def test_code_request_requires_six_digits(self):
        with self.assertRaises(ValidationError):
            bankconnect.BankEmailCodeRequest(code="12345")
        with self.assertRaises(ValidationError):
            bankconnect.BankEmailCodeRequest(code="12AB56")
        self.assertEqual(bankconnect.BankEmailCodeRequest(code="123456").code, "123456")

    def test_bank_link_token_is_blocked_until_email_destination_is_verified(self):
        route = next(
            route for route in self.router().routes
            if route.path == "/api/v1/bankconnect/link-token"
        )
        request = bankconnect.LinkTokenRequest(android_package_name="com.balmz.aptido")
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(route.endpoint(request=request, user=self.user))
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("account holder Gmail", raised.exception.detail)

    def test_email_settings_requires_an_active_wallet(self):
        route = next(
            route for route in self.router(user={"id": "bankconnect-user-test", "wallet_id": ""}).routes
            if route.path == "/api/v1/bankconnect/email/settings"
        )
        with self.assertRaises(HTTPException) as raised:
            route.endpoint(user={"id": "bankconnect-user-test", "wallet_id": ""})
        self.assertEqual(raised.exception.status_code, 409)

    def test_email_code_request_requires_an_active_wallet(self):
        route = next(
            route for route in self.router(user={"id": "bankconnect-user-test", "wallet_id": ""}).routes
            if route.path == "/api/v1/bankconnect/email/request-code"
        )
        request = bankconnect.BankEmailRequest(
            owner_email="owner@example.com",
            otp_email="new.address@example.com",
        )
        with self.assertRaises(HTTPException) as raised:
            route.endpoint(request=request, user={"id": "bankconnect-user-test", "wallet_id": ""})
        self.assertEqual(raised.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
