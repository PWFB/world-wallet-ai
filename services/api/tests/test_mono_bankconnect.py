import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mono_bankconnect


class Cursor:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class FakeDB:
    sessions = {}

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
        if "INSERT INTO balmz_mono_bank_link_sessions" in sql:
            reference, owner_id, institution_id, institution_name, auth_method = params
            self.sessions[reference] = {
                "owner_id": owner_id,
                "institution_id": institution_id,
                "institution_name": institution_name,
                "auth_method": auth_method,
                "status": "initiating",
            }
            return Cursor()
        if "UPDATE balmz_mono_bank_link_sessions" in sql:
            status = "pending_provider_auth" if "pending_provider_auth" in sql else "failed"
            if "WHERE reference=%s AND owner_id=%s" in sql:
                reference, owner_id = params
                item = self.sessions.get(reference)
                if item and item["owner_id"] == owner_id:
                    item["status"] = status
            return Cursor()
        if "SELECT institution_name,status,created_at" in sql:
            reference, owner_id = params
            item = self.sessions.get(reference)
            if not item or item["owner_id"] != owner_id:
                return Cursor(None)
            return Cursor((item["institution_name"], item["status"], "2026-11-17T00:00:00Z"))
        return Cursor()


class MonoBankConnectTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        FakeDB.sessions = {}
        self.user = {"id": "bank-user", "email": "customer@gmail.com", "name": "Bank Customer"}
        self.router = mono_bankconnect.build_mono_bankconnect_router(
            db_factory=FakeDB,
            current_user_dependency=lambda: self.user,
        )

    def route(self, path):
        return next(route for route in self.router.routes if route.path == path)

    def sample_directory(self):
        return {
            "status": "successful",
            "data": [
                {
                    "_id": "nigerian-bank-001",
                    "name": "Example Nigerian Bank",
                    "country": "ng",
                    "type": "PERSONAL_BANKING",
                    "icon": "https://connect.withmono.com/build/img/example.png",
                    "auth_methods": [
                        {"type": "internet_banking", "ui": {"form": [{"name": "password", "contentType": "password"}]}},
                        {"type": "mobile_banking"},
                    ],
                },
                {
                    "_id": "foreign-bank-001",
                    "name": "Foreign Bank",
                    "country": "us",
                    "auth_methods": [{"type": "internet_banking"}],
                },
                {
                    "_id": "bad-icon-001",
                    "name": "Unknown Icon Bank",
                    "country": "ng",
                    "icon": "https://attacker.example/phish.png",
                    "auth_methods": [{"type": "internet_banking"}],
                },
            ],
        }

    def test_bank_routes_are_registered(self):
        paths = {route.path for route in self.router.routes}
        self.assertIn("/api/v1/mono-bankconnect/institutions", paths)
        self.assertIn("/api/v1/mono-bankconnect/initiate", paths)
        self.assertIn("/api/v1/mono-bankconnect/link-status/{reference}", paths)
        self.assertIn("/api/v1/mono-bankconnect/webhook", paths)

    def test_directory_returns_live_nigerian_institutions_and_no_credential_schema(self):
        result = mono_bankconnect._normalize_institutions(self.sample_directory())
        self.assertEqual([item["name"] for item in result], ["Example Nigerian Bank", "Unknown Icon Bank"])
        self.assertEqual(result[0]["auth_methods"], ["internet_banking", "mobile_banking"])
        self.assertNotIn("ui", result[0])
        self.assertNotIn("password", result[0])
        self.assertIsNone(result[1]["icon"])

    async def test_initiation_uses_the_provider_hosted_url_and_live_institution(self):
        async def list_banks(*args, **kwargs):
            return self.sample_directory()

        async def initiate(path, payload):
            self.assertEqual(path, "/v2/accounts/initiate")
            self.assertEqual(payload["scope"], "auth")
            self.assertEqual(payload["institution"], {
                "id": "nigerian-bank-001",
                "auth_method": "internet_banking",
            })
            self.assertEqual(payload["customer"]["email"], "customer@gmail.com")
            self.assertIn("bank_ref=", payload["redirect_url"])
            return {"status": "successful", "data": {"mono_url": "https://link.mono.co/ABC123"}}

        with patch.object(mono_bankconnect, "_mono_get", side_effect=list_banks), patch.object(mono_bankconnect, "_mono_post", side_effect=initiate):
            route = self.route("/api/v1/mono-bankconnect/initiate")
            result = await route.endpoint(
                request=mono_bankconnect.MonoBankLinkRequest(
                    institution_id="nigerian-bank-001",
                    auth_method="internet_banking",
                ),
                user=self.user,
            )
        self.assertEqual(result["redirect_url"], "https://link.mono.co/ABC123")
        self.assertEqual(result["provider"], "Mono")
        self.assertTrue(result["reference"].startswith("balmz_"))

    async def test_initiation_rejects_bank_or_auth_method_not_in_live_directory(self):
        with patch.object(mono_bankconnect, "_mono_get", new=AsyncMock(return_value=self.sample_directory())):
            with self.assertRaises(HTTPException) as raised:
                await self.route("/api/v1/mono-bankconnect/initiate").endpoint(
                    request=mono_bankconnect.MonoBankLinkRequest(
                        institution_id="foreign-bank-001",
                        auth_method="internet_banking",
                    ),
                    user=self.user,
                )
        self.assertEqual(raised.exception.status_code, 400)

    async def test_hosted_redirect_rejects_non_mono_urls(self):
        async def list_banks(*args, **kwargs):
            return self.sample_directory()

        async def malicious_redirect(path, payload):
            return {"status": "successful", "data": {"mono_url": "https://attacker.example/login"}}

        with patch.object(mono_bankconnect, "_mono_get", side_effect=list_banks), patch.object(mono_bankconnect, "_mono_post", side_effect=malicious_redirect):
            with self.assertRaises(HTTPException) as raised:
                await self.route("/api/v1/mono-bankconnect/initiate").endpoint(
                    request=mono_bankconnect.MonoBankLinkRequest(
                        institution_id="nigerian-bank-001",
                        auth_method="internet_banking",
                    ),
                    user=self.user,
                )
        self.assertEqual(raised.exception.status_code, 502)


if __name__ == "__main__":
    unittest.main()
