import unittest
from unittest.mock import patch

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


if __name__ == "__main__":
    unittest.main()
