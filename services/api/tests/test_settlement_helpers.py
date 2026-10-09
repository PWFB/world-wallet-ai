import os
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class SettlementHelperTests(unittest.TestCase):
    def test_exact_base_units_converts_supported_precision(self):
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


if __name__ == "__main__":
    unittest.main()
