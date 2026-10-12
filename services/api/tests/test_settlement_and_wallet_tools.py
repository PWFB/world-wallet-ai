import os
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class SettlementAndWalletToolTests(unittest.TestCase):
    def test_exact_base_units_accepts_supported_precision(self):
        self.assertEqual(main.exact_base_units(Decimal("1.25"), 8), 125000000)
        self.assertEqual(main.exact_base_units(Decimal("0.000001"), 6), 1)

    def test_exact_base_units_rejects_rounding(self):
        with self.assertRaises(main.HTTPException) as caught:
            main.exact_base_units(Decimal("0.000000001"), 8)
        self.assertEqual(caught.exception.status_code, 409)

    def test_exact_base_units_rejects_non_finite_values(self):
        with self.assertRaises(main.HTTPException):
            main.exact_base_units(Decimal("NaN"), 18)

    def test_confirmation_threshold_is_bounded(self):
        with patch.dict(os.environ, {"WORLD_WALLET_BTC_CONFIRMATIONS": "0"}):
            with self.assertRaises(main.HTTPException) as caught:
                main.required_confirmations("WORLD_WALLET_BTC_CONFIRMATIONS")
        self.assertEqual(caught.exception.status_code, 503)

    def test_abi_text_decoder_reads_dynamic_token_metadata(self):
        payload = (32).to_bytes(32, "big") + (4).to_bytes(32, "big") + b"TEST" + (b"\x00" * 28)
        self.assertEqual(main._abi_text_value("0x" + payload.hex()), "TEST")

    def test_sepolia_is_excluded_from_production_reserve_snapshot(self):
        address = "0x" + "1" * 40
        with patch.object(main, "configured_addresses", return_value=[{"network": "sepolia", "address": address, "label": "testnet"}]):
            result = main.wallet_proof_of_reserves({"wallet_id": "wallet_test"})
        self.assertEqual(result["reserves"], [])
        self.assertFalse(result["audited"])
        self.assertFalse(result["liabilities_included"])
        self.assertIn("sepolia", result["excluded_networks"])
        self.assertEqual(result["warnings"], [])

    def test_sepolia_rpc_requires_expected_chain_id(self):
        with patch.object(main, "rpc_call", return_value=hex(11155111)):
            main.require_sepolia_rpc("https://rpc.example")

    def test_sepolia_address_inspection_stops_before_balance_on_wrong_chain(self):
        address = "0x" + "1" * 40
        calls = []

        def fake_rpc(_url, method, _params):
            calls.append(method)
            if method == "eth_chainId":
                return hex(1)
            raise AssertionError("Balance must not be read from the wrong chain")

        with patch.object(main, "rpc_call", side_effect=fake_rpc):
            with self.assertRaises(main.HTTPException) as caught:
                main._inspect_evm_address(address, "sepolia", "https://rpc.example")
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn("balance lookup failed", caught.exception.detail)
        self.assertEqual(calls, ["eth_chainId"])

    def test_sepolia_rpc_rejects_mainnet_chain_id(self):
        with patch.object(main, "rpc_call", return_value=hex(1)):
            with self.assertRaisesRegex(ValueError, "returned chain ID 1, expected 11155111"):
                main.require_sepolia_rpc("https://rpc.example")

    def test_sepolia_rpc_rejects_missing_chain_id(self):
        with patch.object(main, "rpc_call", return_value=None):
            with self.assertRaisesRegex(ValueError, "did not return a chain ID"):
                main.require_sepolia_rpc("https://rpc.example")

    def test_sepolia_token_sync_skips_logs_on_wrong_chain(self):
        wallet = "0x" + "1" * 40
        contract = "0x" + "2" * 40
        calls = []

        def fake_rpc(_url, method, _params):
            calls.append(method)
            if method == "eth_chainId":
                return hex(1)
            raise AssertionError("Token logs must not be queried on the wrong chain")

        user = {"wallet_id": "wallet_test"}
        with patch.object(main, "rpc_call", side_effect=fake_rpc):
            imported, warning = main.sync_evm_token_transactions(
                user, "https://rpc.example", "sepolia", contract, "BALMZ-SEP",
                decimals=18, wallet_address=wallet,
            )
        self.assertEqual(imported, [])
        self.assertIn("transaction service unavailable", warning)
        self.assertEqual(calls, ["eth_chainId"])

    def test_sepolia_address_balance_uses_chain_rpc(self):
        address = "0x" + "1" * 40

        def fake_rpc(_url, method, _params):
            if method == "eth_chainId":
                return hex(11155111)
            if method == "eth_getBalance":
                return hex(10**18)
            if method == "eth_blockNumber":
                return "0x123"
            raise AssertionError("Unexpected RPC method: " + method)

        with patch.object(main, "rpc_call", side_effect=fake_rpc):
            result = main._inspect_evm_address(address, "sepolia", "https://rpc.example")
        self.assertEqual(result["on_chain_balance"], 1.0)
        self.assertEqual(result["block_number"], 0x123)
        self.assertEqual(result["native_symbol"], "ETH-SEP")
        self.assertIn("testnet", result["balance_basis"])

    def test_evm_settlement_waits_for_confirmation_threshold(self):
        tx_hash = "0x" + "a" * 64
        wallet = "0x" + "1" * 40
        destination = "0x" + "2" * 40
        tx = {"from": wallet, "to": destination, "value": hex(10**18)}
        receipt = {"status": "0x1", "blockNumber": "0x64", "blockHash": "0xabc", "logs": []}

        def fake_rpc(_url, method, _params):
            if method == "eth_getTransactionByHash":
                return tx
            if method == "eth_getTransactionReceipt":
                return receipt
            if method == "eth_blockNumber":
                return "0x65"
            if method == "eth_getBlockByNumber":
                return {"hash": "0xabc"}
            raise AssertionError("Unexpected RPC method: " + method)

        with patch.object(main, "ETH_RPC_URL", "https://rpc.example"), patch.object(main, "rpc_call", side_effect=fake_rpc), patch.dict(os.environ, {"WORLD_WALLET_EVM_CONFIRMATIONS": "3"}):
            result = main.verify_evm_settlement(tx_hash, "ETH", "ethereum", destination, Decimal("1"), wallet)
        self.assertEqual(result["state"], "pending")
        self.assertEqual(result["confirmations"], 2)

    def test_evm_settlement_waits_when_receipt_block_was_reorged(self):
        tx_hash = "0x" + "b" * 64
        wallet = "0x" + "1" * 40
        destination = "0x" + "2" * 40
        tx = {"from": wallet, "to": destination, "value": hex(10**18)}
        receipt = {"status": "0x1", "blockNumber": "0x64", "blockHash": "0xold", "logs": []}

        def fake_rpc(_url, method, _params):
            if method == "eth_getTransactionByHash":
                return tx
            if method == "eth_getTransactionReceipt":
                return receipt
            if method == "eth_blockNumber":
                return "0x70"
            if method == "eth_getBlockByNumber":
                return {"hash": "0xnew"}
            raise AssertionError("Unexpected RPC method: " + method)

        with patch.object(main, "ETH_RPC_URL", "https://rpc.example"), patch.object(main, "rpc_call", side_effect=fake_rpc):
            result = main.verify_evm_settlement(tx_hash, "ETH", "ethereum", destination, Decimal("1"), wallet)
        self.assertEqual(result["state"], "pending")
        self.assertEqual(result["confirmations"], 0)


    def test_sepolia_native_sync_stops_before_block_reads_on_wrong_chain(self):
        wallet = "0x" + "1" * 40
        calls = []

        def fake_rpc(_url, method, _params):
            calls.append(method)
            if method == "eth_chainId":
                return hex(1)
            raise AssertionError("Native transaction blocks must not be read from the wrong chain")

        user = {"wallet_id": "wallet_test"}
        with patch.object(main, "configured_addresses", return_value=[
            {"network": "sepolia", "address": wallet, "label": "testnet"}
        ]), patch.object(main, "rpc_call", side_effect=fake_rpc):
            imported, warning = main.sync_evm_native_transactions(
                user, "https://rpc.example", "sepolia", wallet_address=wallet
            )

        self.assertEqual(imported, [])
        self.assertIn("transaction service unavailable", warning)
        self.assertEqual(calls, ["eth_chainId"])


    def test_wallet_sync_includes_sepolia_native_and_balmz_history(self):
        user = {"id": "user_test", "wallet_id": "wallet_test"}
        sepolia_address = "0x" + "1" * 40
        contract = "0x" + "2" * 40
        with patch.object(main, "db") as mocked_db, \
             patch.object(main, "wallet_network_address", side_effect=lambda _user, network: sepolia_address if network == "sepolia" else None), \
             patch.object(main, "SEPOLIA_RPC_URL", "https://sepolia.example"), \
             patch.object(main, "BALMZ_SEPOLIA_CONTRACT", contract), \
             patch.object(main, "ETH_RPC_URL", ""), \
             patch.object(main, "BSC_RPC_URL", ""), \
             patch.object(main, "sync_bitcoin_transactions", return_value=[]), \
             patch.object(main, "sync_evm_native_transactions", return_value=([], None)) as native_sync, \
             patch.object(main, "sync_evm_token_transactions", return_value=([], None)) as token_sync, \
             patch.object(main, "wallet_snapshot", return_value=([], [], {})), \
             patch.object(main, "_network_sync_status", return_value={}):
            conn = mocked_db.return_value.__enter__.return_value
            conn.execute.return_value.fetchall.return_value = []
            result = main.sync_wallet(user)

        native_sync.assert_called_once_with(user, "https://sepolia.example", "sepolia", sepolia_address)
        token_sync.assert_called_once_with(
            user, "https://sepolia.example", "sepolia", contract, "BALMZ-SEP",
            wallet_address=sepolia_address, decimals=18,
        )
        self.assertIn("evm_transactions", result)


    def test_refresh_does_not_claim_transaction_sync_succeeded_with_warnings(self):
        user = {"id": "user_test", "wallet_id": "wallet_test"}
        with patch.object(main, "sync_wallet", return_value={"updates": [], "warnings": []}), \
             patch.object(main, "sync_transactions", return_value={"imported": [], "warnings": ["Ethereum RPC unavailable"]}), \
             patch.object(main, "refresh_prices", return_value={"source": "test"}), \
             patch.object(main, "wallet_snapshot", return_value=([], [], {})), \
             patch.object(main, "_network_sync_status", return_value={}):
            result = main.refresh_wallet(user)

        self.assertEqual(result["status"], "refreshed_with_warnings")
        self.assertIsNone(result["last_transaction_sync_at"])
        self.assertIn("Ethereum RPC unavailable", result["warnings"])

    def test_refresh_reports_transaction_sync_time_after_clean_sync(self):
        user = {"id": "user_test", "wallet_id": "wallet_test"}
        with patch.object(main, "sync_wallet", return_value={"updates": [], "warnings": []}), \
             patch.object(main, "sync_transactions", return_value={"imported": [], "warnings": []}), \
             patch.object(main, "refresh_prices", return_value={"source": "test"}), \
             patch.object(main, "wallet_snapshot", return_value=([], [], {})), \
             patch.object(main, "_network_sync_status", return_value={}):
            result = main.refresh_wallet(user)

        self.assertEqual(result["status"], "refreshed")
        self.assertIsNotNone(result["last_transaction_sync_at"])


    def test_token_asset_symbol_keeps_bnb_usdt_separate(self):
        # The same ERC-20 symbol on two chains must not be merged into one balance.
        self.assertEqual(main.wallet_asset_symbol("USDT", "ethereum"), "USDT")
        self.assertEqual(main.wallet_asset_symbol("USDT", "bnb"), "USDT-BNB")
        self.assertEqual(main.wallet_asset_symbol("BALMZ-SEP", "sepolia"), "BALMZ-SEP")



    def test_configured_addresses_never_inject_service_fallback_addresses(self):
        saved = [("sepolia", "0x" + "1" * 40, "Sepolia testnet")]
        class FakeCursor:
            def __init__(self, rows):
                self.rows = rows
            def fetchall(self):
                return self.rows
        class FakeConnection:
            def __init__(self):
                self.calls = []
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def execute(self, query, params):
                self.calls.append((query, params))
                return FakeCursor(saved)
        fake_conn = FakeConnection()
        with patch.object(main, "db", return_value=fake_conn), \\
             patch.object(main, "EVM_WALLET_ADDRESS", "0x" + "2" * 40), \\
             patch.object(main, "BTC_ADDRESS", "bc1q" + "a" * 38):
            result = main.configured_addresses({"wallet_id": "wallet_test"})
        self.assertEqual(result, [{"network": "sepolia", "address": saved[0][1], "label": "Sepolia testnet"}])
        self.assertEqual(len(fake_conn.calls), 1)
        self.assertNotIn("INSERT", fake_conn.calls[0][0].upper())

if __name__ == "__main__":
    unittest.main()
