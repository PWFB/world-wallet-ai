import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from decimal import Decimal

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


OWNER = "0x1111111111111111111111111111111111111111"


class FakeResult:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return list(self.rows)


class FakeConnection:
    def __init__(self, addresses, assets):
        self.addresses = addresses
        self.assets = assets

    def execute(self, query, params=None):
        if "FROM wallet_addresses" in query:
            return FakeResult(self.addresses)
        if "FROM assets" in query:
            return FakeResult(self.assets)
        if "FROM token_registry" in query:
            return FakeResult([])
        raise AssertionError("Unexpected query: " + query)


class FakeDB:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, exc_type, exc, tb):
        return False


class WalletBalanceVerificationTests(unittest.TestCase):
    def test_sums_verified_attached_eth_balance_and_subtracts_reservations(self):
        connection = FakeConnection(
            [("ethereum", OWNER, True)],
            [("ETH", Decimal("2.5"), Decimal("0.5"))],
        )
        user = {"id": "user-test", "wallet_id": "wallet-test", "wallet_number": "12345678901"}
        with (
            patch.object(main, "db", return_value=FakeDB(connection)),
            patch.object(main, "ETH_RPC_URL", "https://eth-rpc.invalid"),
            patch.object(main, "require_ethereum_mainnet_rpc", return_value=1),
            patch.object(main, "rpc_call", return_value="0x" + format(int(Decimal("2.5") * (Decimal(10) ** 18)), "064x")),
            patch.object(main, "wallet_sync_token_rows", return_value=[]),
        ):
            result = main.wallet_balance_verification_snapshot(user)

        eth = next(item for item in result["assets"] if item["asset"] == "ETH")
        self.assertTrue(eth["verified"])
        self.assertEqual(eth["chain_balance"], 2.5)
        self.assertEqual(eth["reserved_balance"], 0.5)
        self.assertEqual(eth["available_balance"], 2.0)
        self.assertEqual(eth["ledger_available_balance"], 2.0)
        self.assertTrue(eth["matches_ledger"])
        self.assertEqual(eth["addresses_checked"], 1)
        self.assertTrue(result["read_only"])
        self.assertTrue(result["mainnet_only"])

    def test_sums_all_owned_addresses_and_excludes_unverified_addresses(self):
        second_owner = "0x2222222222222222222222222222222222222222"
        unverified_owner = "0x3333333333333333333333333333333333333333"
        connection = FakeConnection(
            [
                ("ethereum", OWNER, True),
                ("ethereum", second_owner, True),
                ("ethereum", unverified_owner, False),
            ],
            [("ETH", Decimal("3"), Decimal("0.5"))],
        )
        user = {"id": "user-test", "wallet_id": "wallet-test"}
        raw_by_address = {
            OWNER.lower(): "0x" + format(1 * (10 ** 18), "064x"),
            second_owner.lower(): "0x" + format(2 * (10 ** 18), "064x"),
            unverified_owner.lower(): "0x" + format(9 * (10 ** 18), "064x"),
        }

        def fake_rpc(_url, method, params):
            self.assertEqual(method, "eth_getBalance")
            return raw_by_address[params[0].lower()]

        with (
            patch.object(main, "db", return_value=FakeDB(connection)),
            patch.object(main, "ETH_RPC_URL", "https://eth-rpc.invalid"),
            patch.object(main, "require_ethereum_mainnet_rpc", return_value=1),
            patch.object(main, "rpc_call", side_effect=fake_rpc),
            patch.object(main, "wallet_sync_token_rows", return_value=[]),
        ):
            result = main.wallet_balance_verification_snapshot(user)

        eth = next(item for item in result["assets"] if item["asset"] == "ETH")
        self.assertEqual(eth["chain_balance"], 3.0)
        self.assertEqual(eth["available_balance"], 2.5)
        self.assertEqual(eth["ledger_available_balance"], 2.5)
        self.assertTrue(eth["matches_ledger"])
        self.assertEqual(eth["addresses_checked"], 2)

    def test_unverified_evm_address_is_not_counted_as_owned_balance(self):
        connection = FakeConnection(
            [("ethereum", OWNER, False)],
            [("ETH", Decimal("1"), Decimal("0"))],
        )
        user = {"id": "user-test", "wallet_id": "wallet-test"}
        with (
            patch.object(main, "db", return_value=FakeDB(connection)),
            patch.object(main, "ETH_RPC_URL", "https://eth-rpc.invalid"),
            patch.object(main, "evm_balance") as balance_reader,
            patch.object(main, "wallet_sync_token_rows", return_value=[]),
        ):
            result = main.wallet_balance_verification_snapshot(user)

        eth = next(item for item in result["assets"] if item["asset"] == "ETH")
        self.assertFalse(eth["verified"])
        self.assertEqual(eth["status"], "no_verified_address")
        self.assertIsNone(eth["available_balance"])
        balance_reader.assert_not_called()

    def test_rpc_identity_failure_does_not_promote_ledger_value_as_verified(self):
        connection = FakeConnection(
            [("ethereum", OWNER, True)],
            [("ETH", Decimal("4"), Decimal("0"))],
        )
        user = {"id": "user-test", "wallet_id": "wallet-test"}
        with (
            patch.object(main, "db", return_value=FakeDB(connection)),
            patch.object(main, "ETH_RPC_URL", "https://eth-rpc.invalid"),
            patch.object(main, "require_ethereum_mainnet_rpc", side_effect=ValueError("wrong chain")),
            patch.object(main, "wallet_sync_token_rows", return_value=[]),
        ):
            result = main.wallet_balance_verification_snapshot(user)

        eth = next(item for item in result["assets"] if item["asset"] == "ETH")
        self.assertFalse(eth["verified"])
        self.assertEqual(eth["status"], "rpc_verification_failed")
        self.assertIsNone(eth["available_balance"])
        self.assertIsNone(eth["ledger_available_balance"])
        self.assertIn("Ethereum Mainnet balance verification failed", result["warnings"])

    def test_sol_devnet_and_sepolia_rows_are_never_returned_as_mainnet_assets(self):
        connection = FakeConnection(
            [
                ("ethereum", OWNER, True),
                ("solana_devnet", "7FNyayYwgfrGb3mCsRttuJUkFQgsgDtrYBhhddKS6iVN", True),
                ("sepolia", OWNER, True),
            ],
            [],
        )
        user = {"id": "user-test", "wallet_id": "wallet-test"}
        with (
            patch.object(main, "db", return_value=FakeDB(connection)),
            patch.object(main, "ETH_RPC_URL", ""),
            patch.object(main, "wallet_sync_token_rows", return_value=[]),
        ):
            result = main.wallet_balance_verification_snapshot(user)

        self.assertNotIn("sepolia", {item["network"] for item in result["assets"]})
        self.assertNotIn("solana_devnet", {item["network"] for item in result["assets"]})
