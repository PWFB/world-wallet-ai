import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bankconnect


class _Cursor:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class _DB:
    owned_address = True

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, query, params=()):
        if "FROM wallet_addresses wa" in query:
            return _Cursor((1,) if self.owned_address else None)
        raise AssertionError("Unexpected SQL in crypto purchase test")


class _Response:
    is_success = True
    status_code = 200

    def json(self):
        return {"token": "coinbase-session-token-" + ("x" * 40)}


class _AsyncClient:
    captured = None

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, json, headers):
        _AsyncClient.captured = {"url": url, "json": json, "headers": headers}
        return _Response()


class CoinbaseOnrampTests(unittest.TestCase):
    def setUp(self):
        _DB.owned_address = True
        _AsyncClient.captured = None
        self.user = {"id": "crypto-test-owner", "wallet_id": "crypto-test-wallet"}
        self.router = bankconnect.build_bankconnect_router(
            db_factory=_DB,
            current_user_dependency=lambda: self.user,
        )

    def route(self, path):
        return next(route for route in self.router.routes if route.path == path)

    def private_key_pem(self):
        key = ec.generate_private_key(ec.SECP256R1(), default_backend())
        return key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode("utf-8")

    def test_crypto_routes_are_registered(self):
        paths = {route.path for route in self.router.routes}
        self.assertIn("/api/v1/bankconnect/crypto/status", paths)
        self.assertIn("/api/v1/bankconnect/crypto/buy-session", paths)
        self.assertIn("/api/v1/bankconnect/transfers/status", paths)

    def test_supported_address_formats_are_validated(self):
        self.assertTrue(bankconnect._valid_onramp_destination("ethereum", "0x" + "a" * 40))
        self.assertTrue(bankconnect._valid_onramp_destination("bitcoin", "bc1q" + "a" * 38))
        self.assertTrue(bankconnect._valid_onramp_destination("solana_mainnet", "1" * 32))
        self.assertFalse(bankconnect._valid_onramp_destination("ethereum", "0x1234"))
        self.assertFalse(bankconnect._valid_onramp_destination("bitcoin", "not-a-bitcoin-address"))

    def test_purchase_requires_supported_asset_and_network_pair(self):
        route = self.route("/api/v1/bankconnect/crypto/buy-session")
        request = bankconnect.CoinbaseOnrampSessionRequest(
            asset="BTC", network="ethereum", address="0x" + "a" * 40
        )
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(route.endpoint(request=request, user=self.user))
        self.assertEqual(caught.exception.status_code, 400)

    def test_purchase_requires_active_wallet_address_with_verified_ownership(self):
        route = self.route("/api/v1/bankconnect/crypto/buy-session")
        request = bankconnect.CoinbaseOnrampSessionRequest(
            asset="BTC", network="bitcoin", address="bc1q" + "a" * 38
        )
        _DB.owned_address = False
        with patch.dict(os.environ, {"COINBASE_ONRAMP_ENABLED": "true"}):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(route.endpoint(request=request, user=self.user))
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("Verify ownership", caught.exception.detail)

    def test_purchase_stays_disabled_without_explicit_backend_enablement(self):
        route = self.route("/api/v1/bankconnect/crypto/buy-session")
        request = bankconnect.CoinbaseOnrampSessionRequest(
            asset="BTC", network="bitcoin", address="bc1q" + "a" * 38
        )
        env = {
            "COINBASE_ONRAMP_ENABLED": "false",
            "COINBASE_CDP_API_KEY_NAME": "test-key",
            "COINBASE_CDP_API_KEY_SECRET": self.private_key_pem(),
            "COINBASE_ONRAMP_ENV": "sandbox",
        }
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(route.endpoint(request=request, user=self.user))
        self.assertEqual(caught.exception.status_code, 503)

    def test_purchase_creates_server_side_session_and_returns_coinbase_checkout_url(self):
        route = self.route("/api/v1/bankconnect/crypto/buy-session")
        address = "0x" + "a" * 40
        request = bankconnect.CoinbaseOnrampSessionRequest(
            asset="ETH", network="ethereum", address=address
        )
        env = {
            "COINBASE_ONRAMP_ENABLED": "true",
            "COINBASE_CDP_API_KEY_NAME": "organizations/test/apiKeys/test-key",
            "COINBASE_CDP_API_KEY_SECRET": self.private_key_pem(),
            "COINBASE_ONRAMP_ENV": "sandbox",
        }
        with (
            patch.dict(os.environ, env, clear=True),
            patch.object(bankconnect.httpx, "AsyncClient", _AsyncClient),
        ):
            result = asyncio.run(route.endpoint(request=request, user=self.user))

        self.assertEqual(result["provider"], "Coinbase Onramp")
        self.assertEqual(result["asset"], "ETH")
        self.assertEqual(result["network"], "ethereum")
        self.assertTrue(result["single_use"])
        self.assertTrue(result["checkout_url"].startswith("https://pay-sandbox.coinbase.com/"))
        self.assertNotIn("organizations/test/apiKeys/test-key", result["checkout_url"])
        self.assertEqual(_AsyncClient.captured["json"]["addresses"][0]["address"], address)
        self.assertEqual(_AsyncClient.captured["json"]["addresses"][0]["blockchains"], ["ethereum"])
        self.assertEqual(_AsyncClient.captured["json"]["assets"], ["ETH"])
        self.assertTrue(_AsyncClient.captured["headers"]["Authorization"].startswith("Bearer "))

    def test_transfer_status_is_never_marked_enabled_before_provider_approval(self):
        route = self.route("/api/v1/bankconnect/transfers/status")
        with patch.dict(os.environ, {
            "NIUM_CLIENT_HASH_ID": "client",
            "NIUM_API_KEY": "key",
            "NIUM_CLIENT_SECRET": "secret",
        }):
            result = route.endpoint(user=self.user)
        self.assertFalse(result["enabled"])
        self.assertEqual(result["provider"], "Nium")


if __name__ == "__main__":
    unittest.main()
