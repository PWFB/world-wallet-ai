import sys
import unittest
from pathlib import Path
from unittest.mock import call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class Rows:
    def fetchall(self):
        return []


class Connection:
    def execute(self, _sql, _params=None):
        return Rows()


class Database:
    def __enter__(self):
        return Connection()

    def __exit__(self, exc_type, exc, tb):
        return False


class VerifiedAddressHistoryTests(unittest.TestCase):
    def test_history_sync_visits_all_owned_addresses_and_skips_unverified(self):
        eth_a = "0x1111111111111111111111111111111111111111"
        eth_b = "0x2222222222222222222222222222222222222222"
        bnb_a = "0x3333333333333333333333333333333333333333"
        not_owned = "0x4444444444444444444444444444444444444444"
        btc_a = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT"
        addresses = [
            {"network": "ethereum", "address": eth_a, "ownership_verified": True},
            {"network": "ethereum", "address": eth_b, "ownership_verified": True},
            {"network": "ethereum", "address": not_owned, "ownership_verified": False},
            {"network": "bnb", "address": bnb_a, "ownership_verified": True},
            {"network": "bitcoin", "address": btc_a, "ownership_verified": True},
        ]
        user = {"id": "test-user", "wallet_id": "test-wallet"}
        with (
            patch.object(main, "configured_addresses", return_value=addresses),
            patch.object(main, "db", return_value=Database()),
            patch.object(main, "ETH_RPC_URL", "https://eth.invalid"),
            patch.object(main, "BSC_RPC_URL", "https://bnb.invalid"),
            patch.object(main, "SEPOLIA_RPC_URL", ""),
            patch.object(main, "require_ethereum_mainnet_rpc"),
            patch.object(main, "require_bnb_rpc"),
            patch.object(main, "sync_bitcoin_transactions", return_value=[]) as bitcoin_sync,
            patch.object(main, "sync_evm_native_transactions", return_value=([], None)) as native_sync,
            patch.object(main, "wallet_sync_token_rows", return_value=[]),
            patch.object(main, "wallet_snapshot", return_value=([], [], {})),
        ):
            result = main.sync_transactions(user)

        self.assertEqual(result["status"], "synced")
        bitcoin_sync.assert_called_once_with(user, btc_a)
        self.assertEqual(
            native_sync.call_args_list,
            [
                call(user, "https://eth.invalid", "ethereum", eth_a),
                call(user, "https://eth.invalid", "ethereum", eth_b),
                call(user, "https://bnb.invalid", "bnb", bnb_a),
            ],
        )
        self.assertNotIn(not_owned, [entry.args[3] for entry in native_sync.call_args_list])


if __name__ == "__main__":
    unittest.main()
