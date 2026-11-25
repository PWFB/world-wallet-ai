import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

try:
    from services.api import main
except ModuleNotFoundError:
    import main


class WalletPinSessionTests(unittest.TestCase):
    def test_pin_session_is_separate_from_device_session(self):
        pin_conn = MagicMock()
        device_conn = MagicMock()
        with patch.object(main.secrets, "token_urlsafe", side_effect=["pin-value", "pin-id"]):
            pin_token = main._create_pin_session(pin_conn, "user-1")
        with patch.object(main.secrets, "token_urlsafe", side_effect=["device-value", "device-id"]):
            device_token = main._create_pin_device_session(device_conn, "user-1")

        self.assertTrue(pin_token.startswith("wwpin_"))
        self.assertTrue(device_token.startswith("wwpd_"))
        self.assertNotEqual(pin_token, device_token)

        pin_sql = pin_conn.execute.call_args.args[0]
        device_sql = device_conn.execute.call_args.args[0]
        self.assertIn("session_type", pin_sql)
        self.assertIn("'pin'", pin_sql)
        self.assertIn("session_type", device_sql)
        self.assertIn("'device'", device_sql)

    def test_device_credential_cannot_authorize_wallet_api(self):
        with patch.object(main, "SESSION_TOKEN", ""), patch.object(main, "DATABASE_URL", "postgresql://test"):
            with self.assertRaises(HTTPException) as raised:
                main.current_user("Bearer wwpd_test-device-token")

        self.assertEqual(raised.exception.status_code, 403)
        self.assertEqual(raised.exception.detail, "SECURITY_PIN_REQUIRED")

    def test_pin_identity_dependency_uses_device_cookie_without_bearer(self):
        expected_user = {"id": "user-1", "email": "owner@example.com"}
        with patch.object(main, "_pin_device_user", return_value=expected_user) as lookup:
            result = main.current_user_for_pin(None, "wwpd_test-device-token")

        self.assertEqual(result, expected_user)
        lookup.assert_called_once_with("wwpd_test-device-token")

    def test_device_lookup_requires_device_session_type(self):
        connection = MagicMock()
        connection.execute.return_value.fetchone.return_value = (
            "user-1", "owner@example.com", "Owner", None, None, None, None
        )
        context = MagicMock()
        context.__enter__.return_value = connection
        with patch.object(main, "DATABASE_URL", "postgresql://test"), patch.object(main, "db", return_value=context):
            result = main._pin_device_user("wwpd_test-device-token")

        self.assertEqual(result["id"], "user-1")
        sql = connection.execute.call_args.args[0]
        self.assertIn("session_type='device'", sql)
        self.assertIn("revoked_at IS NULL", sql)
        self.assertIn("expires_at>NOW()", sql)


if __name__ == "__main__":
    unittest.main()
