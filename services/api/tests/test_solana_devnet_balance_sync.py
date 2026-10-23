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
        def fake_rpc(_url, method, _params):
            if method == "getGenesisHash":
                return main.SOLANA_DEVNET_GENESIS_HASH
            if method == "getTokenAccountsByOwner":
                return response
            raise AssertionError("Unexpected RPC method: " + method)

        with patch.object(main, "rpc_call", side_effect=fake_rpc) as rpc:
            self.assertEqual(main.solana_spl_token_balance(OWNER), 3.5)
        token_calls = [call for call in rpc.call_args_list if call.args[1] == "getTokenAccountsByOwner"]
        self.assertEqual(len(token_calls), 1)
        self.assertEqual(token_calls[0].args[0], "https://api.devnet.solana.com")
        self.assertEqual(token_calls[0].args[2], [
            OWNER, {"mint": MINT},
            {"encoding": "jsonParsed", "commitment": "confirmed"},
        ])

    def test_empty_account_list_is_a_real_zero_balance(self):
        with patch.object(main, "rpc_call", side_effect=lambda _url, method, _params:
                          main.SOLANA_DEVNET_GENESIS_HASH if method == "getGenesisHash" else {"value": []}):
            self.assertEqual(main.solana_spl_token_balance(OWNER), 0.0)

    def test_malformed_response_is_not_treated_as_zero(self):
        with patch.object(main, "rpc_call", side_effect=lambda _url, method, _params:
                          main.SOLANA_DEVNET_GENESIS_HASH if method == "getGenesisHash" else None):
            with self.assertRaises(ValueError):
                main.solana_spl_token_balance(OWNER)

    def test_wrong_decimals_or_mint_are_rejected(self):
        for response in ({"value": [account(1000000000, decimals=6)]},
                         {"value": [account(1000000000, mint="So11111111111111111111111111111111111111112")]}):
            with self.subTest(response=response), patch.object(
                main, "rpc_call",
                side_effect=lambda _url, method, _params:
                    main.SOLANA_DEVNET_GENESIS_HASH if method == "getGenesisHash" else response,
            ):
                with self.assertRaises(ValueError):
                    main.solana_spl_token_balance(OWNER)

    def test_sync_writes_devnet_asset_without_overwriting_price_or_reserve(self):
        connection = FakeConnection()
        user = {"id": "test-user", "wallet_id": "test-wallet"}
        with (
            patch.object(main, "wallet_network_address",
                         side_effect=lambda u, n: OWNER if n == "solana_devnet" else None),
            patch.object(main, "db", return_value=FakeDB(connection)),
            patch.object(main, "rpc_call", side_effect=lambda _url, method, _params:
                          main.SOLANA_DEVNET_GENESIS_HASH if method == "getGenesisHash" else {"value": 0}),
            patch.object(main, "solana_spl_token_balance", return_value=1234567.0),
            patch.object(main, "sync_bitcoin_transactions", return_value=[]),
            patch.object(main, "wallet_snapshot",
                         return_value=([], [], {"available_balance_usd": 0})),
            patch.object(main, "_network_sync_status", return_value={}),
        ):
            result = main.sync_wallet(user)

        # Sync writes both native Devnet SOL and the BALMZ SPL token as
        # separate assets. Assert specifically on the BALMZ token upsert.
        writes = [(query, params) for query, params in connection.queries
                  if "INSERT INTO assets(wallet_id,symbol,name,balance,price_usd)" in query
                  and params and params[1] == "BALMZ-SOL-DEVNET"]
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

    def test_devnet_assets_do_not_affect_production_portfolio_valuation(self):
        assets = [
            {
                "symbol": "ETH", "balance": 1.0, "actual_balance": 1.0,
                "reserved_balance": 0.0, "price_usd": 2000.0,
                "price_available": True, "value_usd": 2000.0,
                "actual_value_usd": 2000.0,
            },
            {
                "symbol": "BALMZ-SOL-DEVNET", "balance": 500.0, "actual_balance": 500.0,
                "reserved_balance": 0.0, "price_usd": 0.0,
                "price_available": False, "value_usd": None,
                "actual_value_usd": None,
            },
            {
                "symbol": "SOL-DEVNET", "balance": 2.0, "actual_balance": 2.0,
                "reserved_balance": 0.0, "price_usd": 0.0,
                "price_available": False, "value_usd": None,
                "actual_value_usd": None,
            },
        ]
        summary = main.wallet_valuation_summary(assets, [])

        self.assertEqual(summary["available_balance_usd"], 2000.0)
        self.assertEqual(summary["actual_balance_usd"], 2000.0)
        self.assertTrue(summary["valuation_complete"])
        self.assertEqual(summary["unpriced_assets"], [])

    def test_native_devnet_sol_is_stored_separately_from_mainnet_sol(self):
        connection = FakeConnection()
        user = {"id": "test-user", "wallet_id": "test-wallet"}
        with (
            patch.object(main, "wallet_network_address",
                         side_effect=lambda u, n: OWNER if n == "solana_devnet" else None),
            patch.object(main, "db", return_value=FakeDB(connection)),
            patch.object(main, "rpc_call", side_effect=lambda _url, method, _params:
                          main.SOLANA_DEVNET_GENESIS_HASH if method == "getGenesisHash" else {"value": 1000000000}),
            patch.object(main, "solana_spl_token_balance", return_value=0.0),
            patch.object(main, "sync_bitcoin_transactions", return_value=[]),
            patch.object(main, "wallet_snapshot",
                         return_value=([], [], {"available_balance_usd": 0})),
            patch.object(main, "_network_sync_status", return_value={}),
        ):
            main.sync_wallet(user)

        devnet_writes = [
            (query, params) for query, params in connection.queries
            if "INSERT INTO assets(wallet_id,symbol,name,balance,price_usd)" in query
            and params and params[1] == "SOL-DEVNET"
        ]
        self.assertEqual(len(devnet_writes), 1)
        self.assertEqual(devnet_writes[0][1][3], 1.0)
        self.assertTrue(any(
            "UPDATE assets SET balance=0 WHERE wallet_id=%s AND symbol='SOL'" in query
            and params == (user["wallet_id"],)
            for query, params in connection.queries
        ))

    def test_rpc_failure_warns_and_does_not_write_fake_balance(self):
        connection = FakeConnection()
        user = {"id": "test-user", "wallet_id": "test-wallet"}
        with (
            patch.object(main, "wallet_network_address",
                         side_effect=lambda u, n: OWNER if n == "solana_devnet" else None),
            patch.object(main, "db", return_value=FakeDB(connection)),
            patch.object(main, "rpc_call", return_value={"value": 0}),
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
