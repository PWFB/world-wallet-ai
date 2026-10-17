import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from decimal import Decimal

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


OWNER = "7FNyayYwgfrGb3mCsRttuJUkFQgsgDtrYBhhddKS6iVN"
MINT = "HBSuf6Dm9r2ebkwLUoaY8ScR2rq5L2CPTJpCbqMbtndF"


class FakeResult:
    def fetchall(self):
        return []


class FakeConnection:
    def __init__(self):
        self.queries = []
        self.committed = False

    def execute(self, query, params=None):
        self.queries.append((query, params))
        return FakeResult()

    def commit(self):
        self.committed = True


class FakeDB:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, exc_type, exc, tb):
        return False


def account(raw_amount, decimals=9, mint=MINT):
    return {"account": {"data": {"parsed": {"info": {
        "mint": mint,
        "tokenAmount": {"amount": str(raw_amount), "decimals": decimals},
    }}}}}


class SolanaDevnetBalanceTests(unittest.TestCase):
    def test_sums_all_matching_accounts_with_confirmed_devnet_rpc(self):
        response = {"value": [account(1000000000), account(2500000000)]}
        with patch.object(main, "rpc_call", return_value=response) as rpc:
            self.assertEqual(main.solana_spl_token_balance(OWNER), 3.5)
        self.assertEqual(rpc.call_args.args[0], "https://api.devnet.solana.com")
        self.assertEqual(rpc.call_args.args[1], "getTokenAccountsByOwner")
        self.assertEqual(rpc.call_args.args[2], [
            OWNER, {"mint": MINT},
            {"encoding": "jsonParsed", "commitment": "confirmed"},
        ])

    def test_empty_account_list_is_a_real_zero_balance(self):
        with patch.object(main, "rpc_call", return_value={"value": []}):
            self.assertEqual(main.solana_spl_token_balance(OWNER), 0.0)

    def test_malformed_response_is_not_treated_as_zero(self):
        with patch.object(main, "rpc_call", return_value=None):
            with self.assertRaises(ValueError):
                main.solana_spl_token_balance(OWNER)

    def test_wrong_decimals_or_mint_are_rejected(self):
        for response in ({"value": [account(1000000000, decimals=6)]},
                         {"value": [account(1000000000, mint="So11111111111111111111111111111111111111112")]}):
            with self.subTest(response=response), patch.object(main, "rpc_call", return_value=response):
                with self.assertRaises(ValueError):
                    main.solana_spl_token_balance(OWNER)

    def test_sync_writes_devnet_asset_without_overwriting_price_or_reserve(self):
        connection = FakeConnection()
        user = {"id": "test-user", "wallet_id": "test-wallet"}
        with (
            patch.object(main, "wallet_network_address",
                         side_effect=lambda u, n: OWNER if n == "solana_devnet" else None),
            patch.object(main, "db", return_value=FakeDB(connection)),
            patch.object(main, "solana_spl_token_balance", return_value=1234567.0),
            patch.object(main, "sync_bitcoin_transactions", return_value=[]),
            patch.object(main, "wallet_snapshot",
                         return_value=([], [], {"available_balance_usd": 0})),
            patch.object(main, "_network_sync_status", return_value={}),
        ):
            result = main.sync_wallet(user)

        writes = [(query, params) for query, params in connection.queries
                  if "INSERT INTO assets(wallet_id,symbol,name,balance,price_usd)" in query]
        self.assertEqual(len(writes), 1)
        query, params = writes[0]
        self.assertIn("ON CONFLICT(wallet_id,symbol) DO UPDATE SET balance=EXCLUDED.balance,name=EXCLUDED.name", query)
        self.assertEqual(params[1], "BALMZ-SOL-DEVNET")
        self.assertEqual(params[3], 1234567.0)
        self.assertIn({
            "network": "solana-devnet",
            "asset": "BALMZ-SOL-DEVNET",
            "balance": 1234567.0,
            "contract_address": MINT,
            "decimals": 9,
        }, result["updates"])
        self.assertTrue(connection.committed)

    def test_rpc_failure_warns_and_does_not_write_fake_balance(self):
        connection = FakeConnection()
        user = {"id": "test-user", "wallet_id": "test-wallet"}
        with (
            patch.object(main, "wallet_network_address",
                         side_effect=lambda u, n: OWNER if n == "solana_devnet" else None),
            patch.object(main, "db", return_value=FakeDB(connection)),
            patch.object(main, "solana_spl_token_balance", side_effect=RuntimeError("RPC unavailable")),
            patch.object(main, "sync_bitcoin_transactions", return_value=[]),
            patch.object(main, "wallet_snapshot",
                         return_value=([], [], {"available_balance_usd": 0})),
            patch.object(main, "_network_sync_status", return_value={}),
        ):
            result = main.sync_wallet(user)
        self.assertTrue(any("BALMZ Solana Devnet" in warning for warning in result["warnings"]))
        self.assertFalse(any(
            "INSERT INTO assets(wallet_id,symbol,name,balance,price_usd)" in query
            and params and params[1] == "BALMZ-SOL-DEVNET"
            for query, params in connection.queries
        ))


if __name__ == "__main__":
    unittest.main()
