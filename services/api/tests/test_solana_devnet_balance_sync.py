import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


OWNER = "7FNyayYwgfrGb3mCsRttuJUkFQgsgDtrYBhhddKS6iVN"
MINT = "HBSuf6Dm9r2ebkwLUoaY8ScR2rq5L2CPTJpCbqMbtndF"


class FakeResult:
    def __init__(self, rows=None):
        self.rows = rows or []

    def fetchall(self):
        return self.rows


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


class SolanaDevnetSyncTests(unittest.TestCase):
    def test_spl_balance_sums_accounts_using_confirmed_devnet_rpc(self):
        rpc_result = {
            "value": [
                {"account": {"data": {"parsed": {"info": {
                    "mint": MINT,
                    "tokenAmount": {"amount": "1000000000", "decimals": 9},
                }}}}},
                {"account": {"data": {"parsed": {"info": {
                    "mint": MINT,
                    "tokenAmount": {"amount": "2500000000", "decimals": 9},
                }}}}},
            ]
        }
        with patch.object(main, "rpc_call", return_value=rpc_result) as rpc:
            balance = main.solana_spl_token_balance(OWNER, MINT, 9)

        self.assertEqual(balance, 3.5)
        self.assertEqual(rpc.call_args.args[0], "https://api.devnet.solana.com")
        self.assertEqual(rpc.call_args.args[1], "getTokenAccountsByOwner")
        self.assertEqual(
            rpc.call_args.args[2],
            [OWNER, {"mint": MINT},
             {"encoding": "jsonParsed", "commitment": "confirmed"}],
        )

    def test_no_token_accounts_is_a_real_zero_balance(self):
        with patch.object(main, "rpc_call", return_value={"value": []}):
            self.assertEqual(
                main.solana_spl_token_balance(OWNER, MINT, 9), 0.0
            )

    def test_malformed_rpc_response_is_not_mistaken_for_zero(self):
        with patch.object(main, "rpc_call", return_value=None):
            with self.assertRaises(ValueError):
                main.solana_spl_token_balance(OWNER, MINT, 9)

    def test_wrong_decimals_are_rejected(self):
        response = {"value": [{"account": {"data": {"parsed": {"info": {
            "mint": MINT,
            "tokenAmount": {"amount": "1000000000", "decimals": 6},
        }}}}}]}
        with patch.object(main, "rpc_call", return_value=response):
            with self.assertRaises(ValueError):
                main.solana_spl_token_balance(OWNER, MINT, 9)

    def test_sync_updates_separate_devnet_asset(self):
        connection = FakeConnection()
        user = {"id": "test-user", "wallet_id": "test-wallet"}

        with (
            patch.object(
                main, "wallet_network_address",
                side_effect=lambda u, n: OWNER if n == "solana-devnet" else None,
            ),
            patch.object(main, "db", return_value=FakeDB(connection)),
            patch.object(main, "solana_spl_token_balance", return_value=1234567.0),
            patch.object(main, "sync_bitcoin_transactions", return_value=[]),
            patch.object(
                main, "wallet_snapshot",
                return_value=([], [], {"available_balance_usd": 0}),
            ),
            patch.object(main, "_network_sync_status", return_value={}),
        ):
            result = main.sync_wallet(user)

        asset_updates = [
            (query, params) for query, params in connection.queries
            if "INSERT INTO assets(wallet_id,symbol,name,balance,price_usd)" in query
        ]
        self.assertEqual(len(asset_updates), 1)
        query, params = asset_updates[0]
        self.assertIn(
            "ON CONFLICT(wallet_id,symbol) DO UPDATE SET balance=EXCLUDED.balance",
            query,
        )
        self.assertEqual(params[1], "BALMZ-SOL-DEVNET")
        self.assertEqual(params[3], 1234567.0)
        self.assertIn(
            {
                "network": "solana-devnet",
                "asset": "BALMZ-SOL-DEVNET",
                "balance": 1234567.0,
                "contract_address": MINT,
                "decimals": 9,
            },
            result["updates"],
        )
        self.assertTrue(connection.committed)

    def test_rpc_failure_warns_without_writing_a_fake_balance(self):
        connection = FakeConnection()
        user = {"id": "test-user", "wallet_id": "test-wallet"}

        with (
            patch.object(
                main, "wallet_network_address",
                side_effect=lambda u, n: OWNER if n == "solana-devnet" else None,
            ),
            patch.object(main, "db", return_value=FakeDB(connection)),
            patch.object(
                main, "solana_spl_token_balance",
                side_effect=RuntimeError("RPC unavailable"),
            ),
            patch.object(main, "sync_bitcoin_transactions", return_value=[]),
            patch.object(
                main, "wallet_snapshot",
                return_value=([], [], {"available_balance_usd": 0}),
            ),
            patch.object(main, "_network_sync_status", return_value={}),
        ):
            result = main.sync_wallet(user)

        self.assertTrue(any("Devnet" in warning for warning in result["warnings"]))
        self.assertFalse(any(
            "INSERT INTO assets(wallet_id,symbol,name,balance,price_usd)" in query
            and params and params[1] == "BALMZ-SOL-DEVNET"
            for query, params in connection.queries
        ))


if __name__ == "__main__":
    unittest.main()
