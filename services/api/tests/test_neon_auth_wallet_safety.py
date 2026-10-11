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


if __name__ == "__main__":
    unittest.main()
