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
    def test_unverified_attached_address_cannot_be_used_for_balance_lookup(self):
        from fastapi import HTTPException

        user = {"id": "user-test", "wallet_id": "wallet-test"}
        with (
            patch.object(main, "db", return_value=Database()),
            patch.object(main, "valid_evm_address", return_value=True),
            patch.object(main, "evm_balance") as balance_reader,
        ):
            with self.assertRaises(HTTPException) as caught:
                main.read_wallet_address_balance("wallet-test", "ethereum", OWNER, user)

        self.assertEqual(caught.exception.status_code, 403)
        balance_reader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
