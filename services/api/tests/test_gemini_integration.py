import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class FakeGeminiResponse:
    def __init__(self, payload=None, status_code=200):
        self.payload = payload or {}
        self.status_code = status_code
        self.is_error = status_code >= 400

    def json(self):
        return self.payload


class FakeAsyncGeminiClient:
    response = None
    calls = []

    def __init__(self, *args, **kwargs):
        self.timeout = kwargs.get("timeout")

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, headers=None, json=None):
        self.__class__.calls.append({"url": url, "headers": headers, "json": json})
        return self.__class__.response


class GeminiIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        FakeAsyncGeminiClient.calls = []
        FakeAsyncGeminiClient.response = FakeGeminiResponse({
            "candidates": [{
                "content": {"parts": [{"text": "World Wallet AI Gemini connection OK"}]}
            }]
        })

    def test_status_reports_presence_and_model_without_key_value(self):
        user = {"id": "owner", "email": "owner@example.com"}
        with patch.object(main, "GEMINI_ADMIN_EMAIL", "owner@example.com"):
            with patch.object(main, "GEMINI_API_KEY", "private-gemini-test-key"):
                with patch.object(main, "GEMINI_MODEL", "gemini-3.8-flash"):
                    result = main.gemini_status(user)
        self.assertTrue(result["configured"])
        self.assertTrue(result["key_present"])
        self.assertEqual(result["model"], "gemini-3.8-flash")
        self.assertNotIn("private-gemini-test-key", str(result))

    def test_status_rejects_non_admin(self):
        with patch.object(main, "GEMINI_ADMIN_EMAIL", "owner@example.com"):
            with self.assertRaises(main.HTTPException) as denied:
                main.gemini_status({"id": "other", "email": "other@example.com"})
        self.assertEqual(denied.exception.status_code, 403)

    async def test_connection_test_uses_x_goog_api_key_header_and_returns_safe_preview(self):
        user = {"id": "owner", "email": "owner@example.com"}
        with patch.object(main, "GEMINI_ADMIN_EMAIL", "owner@example.com"):
            with patch.object(main, "GEMINI_API_KEY", "private-gemini-test-key"):
                with patch.object(main, "GEMINI_MODEL", "gemini-3.8-flash"):
                    with patch.object(main.httpx, "AsyncClient", FakeAsyncGeminiClient):
                        result = await main.gemini_connection_test(user)
        self.assertTrue(result["success"])
        self.assertEqual(result["model"], "gemini-3.8-flash")
        self.assertEqual(len(FakeAsyncGeminiClient.calls), 1)
        call = FakeAsyncGeminiClient.calls[0]
        self.assertEqual(call["url"], "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent")
        self.assertEqual(call["headers"]["x-goog-api-key"], "private-gemini-test-key")
        self.assertIn("Reply with exactly:", call["json"]["contents"][0]["parts"][0]["text"])
        self.assertNotIn("private-gemini-test-key", str(result))

    async def test_missing_key_fails_without_provider_request(self):
        with patch.object(main, "GEMINI_ADMIN_EMAIL", "owner@example.com"):
            with patch.object(main, "GEMINI_API_KEY", ""):
                with patch.object(main.httpx, "AsyncClient", FakeAsyncGeminiClient):
                    with self.assertRaises(main.HTTPException) as missing:
                        await main.gemini_connection_test({"id": "owner", "email": "owner@example.com"})
        self.assertEqual(missing.exception.status_code, 503)
        self.assertEqual(FakeAsyncGeminiClient.calls, [])

    async def test_rejected_key_does_not_echo_provider_response_body_or_secret(self):
        FakeAsyncGeminiClient.response = FakeGeminiResponse(
            {"error": {"message": "private provider details"}}, status_code=401
        )
        with patch.object(main, "GEMINI_ADMIN_EMAIL", "owner@example.com"):
            with patch.object(main, "GEMINI_API_KEY", "private-gemini-test-key"):
                with patch.object(main.httpx, "AsyncClient", FakeAsyncGeminiClient):
                    with self.assertRaises(main.HTTPException) as rejected:
                        await main.gemini_connection_test({"id": "owner", "email": "owner@example.com"})
        self.assertEqual(rejected.exception.status_code, 502)
        self.assertNotIn("private provider details", rejected.exception.detail)
        self.assertNotIn("private-gemini-test-key", rejected.exception.detail)

    async def test_quota_response_is_reported_as_rate_limit(self):
        FakeAsyncGeminiClient.response = FakeGeminiResponse({}, status_code=429)
        with patch.object(main, "GEMINI_ADMIN_EMAIL", "owner@example.com"):
            with patch.object(main, "GEMINI_API_KEY", "private-gemini-test-key"):
                with patch.object(main.httpx, "AsyncClient", FakeAsyncGeminiClient):
                    with self.assertRaises(main.HTTPException) as limited:
                        await main.gemini_connection_test({"id": "owner", "email": "owner@example.com"})
        self.assertEqual(limited.exception.status_code, 429)
        self.assertIn("quota", limited.exception.detail.lower())


if __name__ == "__main__":
    unittest.main()
