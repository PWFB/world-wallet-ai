import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


OWNER = "0x1111111111111111111111111111111111111111"


class Result:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class Connection:
    def execute(self, sql, _params=None):
        normalized = " ".join(sql.split()).lower()
        if "from wallets" in normalized:
            return Result(("wallet-test",))
        if "from wallet_addresses" in normalized:
            return Result((False,))
        raise AssertionError("Unexpected query: " + normalized)


class Database:
    def __enter__(self):
        return Connection()

    def __exit__(self, exc_type, exc, tb):
        return False


class WalletAddressBalanceOwnershipTests(unittest.TestCase):
    def test_unverified_attached_address_can_be_read_but_is_not_spend_eligible(self):
        user = {"id": "user-test", "wallet_id": "wallet-test"}
        with (
            patch.object(main, "db", return_value=Database()),
            patch.object(main, "valid_evm_address", return_value=True),
            patch.object(main, "ETH_RPC_URL", "https://ethereum.example"),
            patch.object(main, "require_ethereum_mainnet_rpc", return_value=1),
            patch.object(main, "evm_balance", return_value=0.125) as balance_reader,
        ):
            result = main.read_wallet_address_balance("wallet-test", "ethereum", OWNER, user)

        self.assertEqual(result["balance"], 0.125)
        self.assertTrue(result["read_only"])
        self.assertFalse(result["ownership_verified"])
        self.assertFalse(result["spend_eligible"])
        self.assertEqual(result["balance_scope"], "public_address_preview")
        balance_reader.assert_called_once_with("https://ethereum.example", OWNER)


if __name__ == "__main__":
    unittest.main()
