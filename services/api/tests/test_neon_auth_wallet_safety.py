import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class FakeResult:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, rows):
        self.rows = rows
        self.queries = []
        self.committed = False

    def execute(self, query, params=None):
        self.queries.append((query, params))
        return FakeResult(self.rows)

    def commit(self):
        self.committed = True


class FakeDatabaseContext:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, *_args):
        return False


class FakeSigningKey:
    key = object()
    algorithm_name = "EdDSA"


class FakeJwksClient:
    def get_signing_key_from_jwt(self, _token):
        return FakeSigningKey()


class NeonAuthWalletSafetyTests(unittest.TestCase):
    def test_solana_public_address_validation(self):
        self.assertTrue(main.valid_solana_address("11111111111111111111111111111111"))
        self.assertFalse(main.valid_solana_address("not-a-solana-address"))
        self.assertFalse(main.valid_solana_address("0x" + "a" * 40))

    def test_solana_balance_uses_read_only_confirmed_rpc(self):
        class FakeSolanaResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {"result": {"context": {"slot": 123}, "value": 2500000000}}

        with patch.object(main.httpx, "post", return_value=FakeSolanaResponse()) as request:
            balance = main.solana_balance("11111111111111111111111111111111", "https://solana-rpc.invalid")

        self.assertEqual(balance, 2.5)
        request.assert_called_once_with(
            "https://solana-rpc.invalid",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getBalance",
                "params": ["11111111111111111111111111111111", {"commitment": "confirmed"}],
            },
            timeout=12,
        )

    def test_configured_addresses_is_read_only_and_uses_saved_wallet_rows(self):
        saved_address = "0x" + "a" * 40
        connection = FakeConnection([("ethereum", saved_address, "primary")])
        with (
            patch.object(main, "db", return_value=FakeDatabaseContext(connection)),
            patch.object(main, "EVM_WALLET_ADDRESS", "0x" + "b" * 40),
            patch.object(main, "BTC_ADDRESS", "bc1q" + "q" * 30),
        ):
            addresses = main.configured_addresses({"wallet_id": "wallet_profile_123"})

        self.assertEqual(addresses, [{"network": "ethereum", "address": saved_address, "label": "primary"}])
        self.assertEqual(len(connection.queries), 1)
        self.assertIn("SELECT network,address,label FROM wallet_addresses", connection.queries[0][0])
        self.assertFalse(connection.committed)

    def test_wallet_sync_uses_separate_saved_addresses_for_each_evm_network(self):
        ethereum_address = "0x" + "1" * 40
        bnb_address = "0x" + "2" * 40
        connection = FakeConnection([])
        user = {"wallet_id": "wallet_profile_123", "id": "user_123"}
        with (
            patch.object(main, "wallet_network_address", side_effect=lambda _user, network: {
                "ethereum": ethereum_address,
                "bnb": bnb_address,
                "bitcoin": None,
            }.get(network)),
            patch.object(main, "ETH_RPC_URL", "https://ethereum-rpc.invalid"),
            patch.object(main, "BSC_RPC_URL", "https://bnb-rpc.invalid"),
            patch.object(main, "USDT_ETH_CONTRACT", ""),
            patch.object(main, "USDT_BSC_CONTRACT", ""),
            patch.object(main, "db", return_value=FakeDatabaseContext(connection)),
            patch.object(main, "evm_balance", side_effect=[1.25, 2.5]) as evm_balance,
            patch.object(main, "sync_bitcoin_transactions", return_value=[]),
            patch.object(main, "sync_evm_native_transactions", return_value=([], None)) as sync_native,
            patch.object(main, "wallet_snapshot", return_value=([], [], {})),
            patch.object(main, "_network_sync_status", return_value={}),
        ):
            result = main.sync_wallet(user)

        self.assertEqual(
            [call.args for call in evm_balance.call_args_list],
            [
                ("https://ethereum-rpc.invalid", ethereum_address),
                ("https://bnb-rpc.invalid", bnb_address),
            ],
        )
        self.assertEqual(
            [call.args for call in sync_native.call_args_list],
            [
                (user, "https://ethereum-rpc.invalid", "ethereum", ethereum_address),
                (user, "https://bnb-rpc.invalid", "bnb", bnb_address),
            ],
        )
        self.assertEqual(
            [(item["network"], item["asset"], item["balance"]) for item in result["updates"]],
            [("ethereum", "ETH", 1.25), ("bnb", "BNB", 2.5)],
        )

    def test_wallet_sync_post_route_has_one_authenticated_handler(self):
        routes = [
            route for route in main.app.routes
            if getattr(route, "path", None) == "/api/v1/wallet/sync"
            and "POST" in (getattr(route, "methods", set()) or set())
        ]
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0].endpoint.__name__, "sync_wallet")

    def test_chain_heights_is_a_separate_get_route(self):
        routes = [
            route for route in main.app.routes
            if getattr(route, "path", None) == "/api/v1/chains/heights"
            and "GET" in (getattr(route, "methods", set()) or set())
        ]
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0].endpoint.__name__, "_chain_heights")

    def test_neon_jwt_audience_is_verified_when_expected_audience_is_configured(self):
        decoded_claims = {
            "sub": "neon-user-123",
            "email": "test@example.invalid",
            "iss": "https://auth.example.invalid",
        }
        with (
            patch.object(main, "NEON_JWKS_CLIENT", FakeJwksClient()),
            patch.object(main, "NEON_AUTH_EXPECTED_AUDIENCE", "world-wallet-api"),
            patch.object(main.jwt, "get_unverified_header", return_value={"alg": "EdDSA"}),
            patch.object(main.jwt, "decode", return_value=decoded_claims) as decode,
            patch.object(main, "NEON_AUTH_BASE_URL", ""),
            patch.object(main, "get_user", return_value={"id": "local-user", "email": "test@example.invalid"}),
        ):
            user = main.neon_auth_user("header.payload.signature")

        self.assertEqual(user["id"], "local-user")
        self.assertEqual(decode.call_args.kwargs["audience"], "world-wallet-api")
        self.assertTrue(decode.call_args.kwargs["options"]["verify_aud"])

    def test_neon_jwt_audience_check_remains_optional_until_configured(self):
        decoded_claims = {
            "sub": "neon-user-123",
            "email": "test@example.invalid",
            "iss": "https://auth.example.invalid",
        }
        with (
            patch.object(main, "NEON_JWKS_CLIENT", FakeJwksClient()),
            patch.object(main, "NEON_AUTH_EXPECTED_AUDIENCE", ""),
            patch.object(main.jwt, "get_unverified_header", return_value={"alg": "EdDSA"}),
            patch.object(main.jwt, "decode", return_value=decoded_claims) as decode,
            patch.object(main, "NEON_AUTH_BASE_URL", ""),
            patch.object(main, "get_user", return_value={"id": "local-user", "email": "test@example.invalid"}),
        ):
            user = main.neon_auth_user("header.payload.signature")

        self.assertEqual(user["id"], "local-user")
        self.assertIsNone(decode.call_args.kwargs["audience"])
        self.assertFalse(decode.call_args.kwargs["options"]["verify_aud"])


    def test_neon_jwt_accepts_configured_auth_url_as_issuer(self):
        decoded_claims = {
            "sub": "neon-user-123",
            "email": "test@example.invalid",
            "iss": "https://auth.example.invalid/neondb/auth",
        }
        with (
            patch.object(main, "NEON_JWKS_CLIENT", FakeJwksClient()),
            patch.object(main, "NEON_AUTH_EXPECTED_AUDIENCE", ""),
            patch.object(main.jwt, "get_unverified_header", return_value={"alg": "EdDSA"}),
            patch.object(main.jwt, "decode", return_value=decoded_claims),
            patch.object(main, "NEON_AUTH_BASE_URL", "https://auth.example.invalid/neondb/auth"),
            patch.object(main, "get_user", return_value={"id": "local-user", "email": "test@example.invalid"}) as get_user,
        ):
            user = main.neon_auth_user("header.payload.signature")

        self.assertEqual(user["id"], "local-user")
        get_user.assert_called_once_with("test@example.invalid")

    def test_neon_jwt_rejects_wrong_issuer_before_local_user_lookup(self):
        decoded_claims = {
            "sub": "neon-user-123",
            "email": "test@example.invalid",
            "iss": "https://untrusted.example.invalid",
        }
        with (
            patch.object(main, "NEON_JWKS_CLIENT", FakeJwksClient()),
            patch.object(main, "NEON_AUTH_EXPECTED_AUDIENCE", ""),
            patch.object(main.jwt, "get_unverified_header", return_value={"alg": "EdDSA"}),
            patch.object(main.jwt, "decode", return_value=decoded_claims),
            patch.object(main, "NEON_AUTH_BASE_URL", "https://auth.example.invalid/neondb/auth"),
            patch.object(main, "get_user") as get_user,
        ):
            with self.assertRaises(main.HTTPException) as raised:
                main.neon_auth_user("header.payload.signature")

        self.assertEqual(raised.exception.status_code, 401)
        get_user.assert_not_called()


    def test_neon_jwt_rejects_unapproved_signing_algorithm(self):
        with (
            patch.object(main, "NEON_JWKS_CLIENT", FakeJwksClient()),
            patch.object(main, "jwt.get_unverified_header", return_value={"alg": "HS256"}),
            patch.object(main, "jwt.decode") as decode,
        ):
            with self.assertRaises(main.HTTPException) as raised:
                main.neon_auth_user("header.payload.signature")

        self.assertEqual(raised.exception.status_code, 401)
        decode.assert_not_called()

    def test_neon_jwt_rejects_algorithm_mismatch_with_jwks_key(self):
        class MismatchedSigningKey:
            key = object()
            algorithm_name = "RS256"

        class MismatchedJwksClient:
            def get_signing_key_from_jwt(self, _token):
                return MismatchedSigningKey()

        with (
            patch.object(main, "NEON_JWKS_CLIENT", MismatchedJwksClient()),
            patch.object(main, "jwt.get_unverified_header", return_value={"alg": "EdDSA"}),
            patch.object(main, "jwt.decode") as decode,
        ):
            with self.assertRaises(main.HTTPException) as raised:
                main.neon_auth_user("header.payload.signature")

        self.assertEqual(raised.exception.status_code, 401)
        decode.assert_not_called()


    def test_coingecko_demo_key_uses_server_side_header(self):
        with (
            patch.object(main, "COINGECKO_API_KEY", "demo-test-key"),
            patch.object(main, "COINGECKO_API_BASE_URL", "https://api.coingecko.com/api/v3"),
        ):
            headers = main.coingecko_headers()

        self.assertEqual(headers, {"x-cg-demo-api-key": "demo-test-key"})

    def test_coingecko_pro_key_uses_server_side_header(self):
        with (
            patch.object(main, "COINGECKO_API_KEY", "pro-test-key"),
            patch.object(main, "COINGECKO_API_BASE_URL", "https://pro-api.coingecko.com/api/v3"),
        ):
            headers = main.coingecko_headers()

        self.assertEqual(headers, {"x-cg-pro-api-key": "pro-test-key"})

    def test_market_prices_uses_coingecko_and_never_returns_api_key(self):
        class FakePriceResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return {
                    "bitcoin": {"usd": 65000, "usd_24h_change": 1.25},
                    "ethereum": {"usd": 3200, "usd_24h_change": -0.5},
                    "tether": {"usd": 1},
                }

        with (
            patch.object(main, "COINGECKO_API_KEY", "server-only-test-key"),
            patch.object(main, "COINGECKO_API_BASE_URL", "https://api.coingecko.com/api/v3"),
            patch.object(main, "_coingecko_market_cache", None),
            patch.object(main, "_coingecko_market_cache_at", 0.0),
            patch.object(main.httpx, "get", return_value=FakePriceResponse()) as request,
        ):
            result = main.market_prices()

        request.assert_called_once()
        args, kwargs = request.call_args
        self.assertEqual(args[0], "https://api.coingecko.com/api/v3/simple/price")
        self.assertEqual(kwargs["headers"], {"x-cg-demo-api-key": "server-only-test-key"})
        self.assertEqual(result["source"], "CoinGecko")
        self.assertEqual(result["prices"]["BTC"]["usd"], 65000.0)
        self.assertEqual(result["prices"]["ETH"]["usd_24h_change"], -0.5)
        self.assertFalse(result["prices"]["BALMZ"]["listed"])
        self.assertNotIn("server-only-test-key", repr(result))


    def test_market_prices_uses_fresh_cache_without_another_upstream_request(self):
        cached = {
            "source": "CoinGecko",
            "updated_at": "2026-10-11T00:00:00+00:00",
            "prices": {"BTC": {"usd": 65000.0, "usd_24h_change": 1.25, "listed": True}},
            "stale": False,
        }
        with (
            patch.object(main, "_coingecko_market_cache", cached),
            patch.object(main, "_coingecko_market_cache_at", __import__("time").monotonic()),
            patch.object(main, "COINGECKO_PRICE_CACHE_TTL_SECONDS", 45),
            patch.object(main.httpx, "get") as request,
        ):
            result = main.market_prices()

        self.assertEqual(result, cached)
        request.assert_not_called()

    def test_market_prices_returns_marked_stale_cache_if_upstream_fails(self):
        cached = {
            "source": "CoinGecko",
            "updated_at": "2026-10-11T00:00:00+00:00",
            "prices": {"BTC": {"usd": 65000.0, "usd_24h_change": 1.25, "listed": True}},
            "stale": False,
        }
        with (
            patch.object(main, "_coingecko_market_cache", cached),
            patch.object(main, "_coingecko_market_cache_at", 0.0),
            patch.object(main.time, "monotonic", return_value=1000.0),
            patch.object(main.httpx, "get", side_effect=RuntimeError("upstream unavailable")),
        ):
            result = main.market_prices()

        self.assertTrue(result["stale"])
        self.assertEqual(result["updated_at"], cached["updated_at"])
        self.assertEqual(result["prices"], cached["prices"])


if __name__ == "__main__":
    unittest.main()
