import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


USER = {"id": "user-test", "wallet_id": "wallet-test", "email": "owner@example.test"}


class FakeResponse:
    is_error = False

    def json(self):
        return {"candidates": [{"content": {"parts": [{"text": "Evidence-based answer."}]}}]}


class FakeGeminiClient:
    def __init__(self, *args, **kwargs):
        self.payload = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, headers=None, json=None):
        self.payload = json
        return FakeResponse()


class FakeDB:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class BalmzAIAssistantTests(unittest.IsolatedAsyncioTestCase):
    async def test_assistant_requires_backend_gemini_key(self):
        with patch.object(main, "GEMINI_API_KEY", ""):
            with self.assertRaises(HTTPException) as context:
                await main.balmz_ai_ask(main.BalmzAIAskRequest(question="Explain this token"), USER)
        self.assertEqual(context.exception.status_code, 503)

    async def test_wallet_context_is_not_read_or_shared_without_explicit_opt_in(self):
        client = FakeGeminiClient()
        with (
            patch.object(main, "GEMINI_API_KEY", "test-key"),
            patch.object(main.httpx, "AsyncClient", return_value=client),
            patch.object(main, "wallet_balance_verification_snapshot") as balance_reader,
            patch.object(main, "db", return_value=FakeDB()),
            patch.object(main, "record_wallet_audit_event"),
        ):
            result = await main.balmz_ai_ask(
                main.BalmzAIAskRequest(
                    question="Explain this token",
                    include_wallet_context=False,
                    market_context={"token_symbol": "BALMZ", "unapproved_field": "must not pass"},
                ),
                USER,
            )

        self.assertTrue(result["success"])
        self.assertEqual(result["answer"], "Evidence-based answer.")
        self.assertFalse(result["wallet_context_included"])
        balance_reader.assert_not_called()
        prompt = client.payload["contents"][0]["parts"][0]["text"]
        self.assertIn("BALMZ", prompt)
        self.assertNotIn("must not pass", prompt)

    async def test_opted_in_context_contains_verified_amounts_but_no_wallet_addresses(self):
        client = FakeGeminiClient()
        snapshot = {
            "assets": [{
                "asset": "ETH",
                "network": "ethereum",
                "verified": True,
                "status": "verified",
                "chain_balance": 2.5,
                "reserved_balance": 0.5,
                "available_balance": 2.0,
                "matches_ledger": True,
                "address": "0xSECRETADDRESS",
            }]
        }
        with (
            patch.object(main, "GEMINI_API_KEY", "test-key"),
            patch.object(main.httpx, "AsyncClient", return_value=client),
            patch.object(main, "wallet_balance_verification_snapshot", return_value=snapshot),
            patch.object(main, "db", return_value=FakeDB()),
            patch.object(main, "record_wallet_audit_event"),
        ):
            result = await main.balmz_ai_ask(
                main.BalmzAIAskRequest(question="Summarize my verified balance", include_wallet_context=True),
                USER,
            )

        self.assertTrue(result["wallet_context_included"])
        prompt = client.payload["contents"][0]["parts"][0]["text"]
        self.assertIn('"available_balance":2.0', prompt)
        self.assertNotIn("0xSECRETADDRESS", prompt)
        self.assertNotIn("private_key", prompt.lower())


if __name__ == "__main__":
    unittest.main()
