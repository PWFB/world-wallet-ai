import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

RAW = "-1:e56754f83426f69b09267bd876ac97c44821345b7e266bd956a7bfbfb98df35c"
FRIENDLY = "Ef_lZ1T4NCb2mwkme9h2rJfESCE0W34ma9lWp7-_uY3zXDvq"


class Result:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class Connection:
    def execute(self, sql, _params=None):
        normalized = " ".join(sql.split()).lower()
        if "from wallets" in normalized:
            return Result(("wallet-ton",))
        if "from wallet_addresses" in normalized:
            return Result((False,))
        raise AssertionError("Unexpected query: " + normalized)


class Database:
    def __enter__(self):
        return Connection()

    def __exit__(self, exc_type, exc, tb):
        return False


class TonWalletSupportTests(unittest.TestCase):
    def test_validates_raw_and_checksummed_friendly_addresses(self):
        self.assertTrue(main.valid_ton_address(RAW))
        self.assertTrue(main.valid_ton_address(FRIENDLY))
        self.assertFalse(main.valid_ton_address(FRIENDLY[:-1] + "A"))
        self.assertFalse(main.valid_ton_address("not-a-ton-address"))

    def test_network_aliases_keep_mainnet_and_testnet_separate(self):
        self.assertEqual(main.normalize_wallet_network("ton"), "ton_mainnet")
        self.assertEqual(main.normalize_wallet_network("TON Mainnet"), "ton_mainnet")
        self.assertEqual(main.normalize_wallet_network("ton-testnet"), "ton_testnet")

    def test_jetton_amount_is_not_formatted_without_metadata_decimals(self):
        self.assertEqual(main._ton_decimal_amount("1234567", 6), "1.234567")
        self.assertIsNone(main._ton_decimal_amount("1234567", None))

    def test_ton_balance_route_allows_public_read_without_claiming_ownership(self):
        user = {"id": "user-ton", "wallet_id": "wallet-ton"}
        snapshot = {
            "balance": 1.25,
            "jettons": [{"master_address": RAW, "symbol": "TEST", "decimals": 6, "balance": "1.5", "amount_raw": "1500000"}],
            "jettons_available": True,
            "jettons_warning": None,
            "source": "TonAPI",
            "metadata_standard": "TEP-64 indexed metadata",
        }
        with (
            patch.object(main, "db", return_value=Database()),
            patch.object(main, "valid_ton_address", return_value=True),
            patch.object(main, "ton_account_snapshot", return_value=snapshot) as read_snapshot,
        ):
            result = main.read_wallet_address_balance("wallet-ton", "ton_mainnet", RAW, user)

        self.assertEqual(result["asset"], "TON")
        self.assertEqual(result["balance"], 1.25)
        self.assertEqual(result["jettons"][0]["balance"], "1.5")
        self.assertFalse(result["ownership_verified"])
        self.assertTrue(result["read_only"])
        read_snapshot.assert_called_once_with("ton_mainnet", RAW)

    def test_ton_mainnet_and_testnet_use_different_tonapi_hosts(self):
        responses = [
            {"balance": "1000000000"},
            {"balances": []},
            {"balance": "2000000000"},
            {"balances": []},
        ]
        with (
            patch.object(main, "_tonapi_get", side_effect=responses) as get,
            patch.object(main, "TONAPI_MAINNET_BASE_URL", "https://main.example/v2"),
            patch.object(main, "TONAPI_TESTNET_BASE_URL", "https://test.example/v2"),
        ):
            main.ton_account_snapshot("ton_mainnet", RAW)
            main.ton_account_snapshot("ton_testnet", RAW)

        self.assertEqual(get.call_args_list[0].args[0], "https://main.example/v2")
        self.assertEqual(get.call_args_list[2].args[0], "https://test.example/v2")


if __name__ == "__main__":
    unittest.main()
