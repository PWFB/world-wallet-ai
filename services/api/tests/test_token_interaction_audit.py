import unittest
from unittest.mock import patch

import main


class TokenInteractionAuditHelpersTests(unittest.TestCase):
    def setUp(self):
        self.owner = "0x" + "1" * 40
        self.spender = "0x" + "2" * 40
        self.contract = "0x" + "3" * 40

    def test_etherscan_empty_history_is_not_an_error(self):
        for message in ("No transactions found", "No records found", "No logs found"):
            self.assertEqual(
                main._etherscan_result_list({"status": "0", "message": "NOTOK", "result": message}, "history"),
                [],
            )

    def test_etherscan_transfer_list_requires_a_successful_list(self):
        entries = [{"hash": "0xabc"}]
        self.assertEqual(main._etherscan_result_list({"status": "1", "result": entries}, "history"), entries)
        with self.assertRaises(ValueError):
            main._etherscan_result_list({"status": "0", "result": "rate limit"}, "history")

    def test_transfer_amount_is_exact_and_balmz_match_uses_configured_contract(self):
        item = {
            "contractAddress": self.contract,
            "tokenName": "BALMZ Token",
            "tokenSymbol": "BALMZ",
            "tokenDecimal": "6",
            "value": "12345000",
            "from": self.owner,
            "to": self.spender,
            "hash": "0x" + "a" * 64,
            "blockNumber": "123",
        }
        result = main._format_token_interaction(item, "ethereum", self.owner, self.contract)
        self.assertEqual(result["amount_raw"], "12345000")
        self.assertEqual(result["amount"], "12.345")
        self.assertTrue(result["balmz_contract_match"])
        self.assertEqual(result["network"], "ethereum")

    def test_approval_event_is_bound_to_exact_owner_and_spender(self):
        item = {
            "address": self.contract,
            "topics": [
                main.ERC20_APPROVAL_TOPIC,
                "0x" + self.owner[2:].rjust(64, "0"),
                "0x" + self.spender[2:].rjust(64, "0"),
            ],
            "data": "0x" + format(2**128, "064x"),
            "transactionHash": "0x" + "b" * 64,
            "blockNumber": "456",
        }
        result = main._format_approval_interaction(item, "bnb", self.owner)
        self.assertIsNotNone(result)
        self.assertEqual(result["spender_address"], self.spender)
        self.assertEqual(result["amount_raw"], str(2**128))
        self.assertEqual(result["network"], "bnb")

        wrong_owner = dict(item)
        wrong_owner["topics"] = list(item["topics"])
        wrong_owner["topics"][1] = "0x" + ("4" * 64)
        self.assertIsNone(main._format_approval_interaction(wrong_owner, "bnb", self.owner))

    def test_allowance_calldata_encodes_both_addresses(self):
        expected = (
            "0xdd62ed3e"
            + self.owner[2:].lower().rjust(64, "0")
            + self.spender[2:].lower().rjust(64, "0")
        )
        self.assertEqual(main._erc20_allowance_call_data(self.owner, self.spender), expected)

    def test_current_allowance_returns_exact_raw_integer(self):
        with patch.object(main, "rpc_call", return_value="0x" + format(987654321, "064x")) as rpc:
            result = main._read_current_erc20_allowance(
                "https://rpc.example", self.contract, self.owner, self.spender
            )
        self.assertEqual(result, "987654321")
        self.assertEqual(rpc.call_args.args[1], "eth_call")

    def test_current_allowance_rejects_malformed_rpc_return(self):
        with patch.object(main, "rpc_call", return_value="0x1234"):
            result = main._read_current_erc20_allowance(
                "https://rpc.example", self.contract, self.owner, self.spender
            )
        self.assertIsNone(result)


    def _transfer_receipt(self):
        log = {
            "address": self.contract,
            "topics": [
                main.ERC20_TRANSFER_TOPIC,
                "0x" + "0" * 24 + self.owner[2:].lower(),
                "0x" + "0" * 24 + self.spender[2:].lower(),
            ],
            "data": "0x" + format(12345000, "064x"),
            "logIndex": "0x2",
        }
        return {
            "status": "0x1",
            "blockNumber": "0x64",
            "blockHash": "0x" + "a" * 64,
            "logs": [log],
        }

    def test_rpc_transfer_log_verification_requires_exact_contract_addresses_amount_and_index(self):
        receipt = self._transfer_receipt()
        self.assertTrue(main._verify_erc20_transfer_log(
            receipt,
            token_contract=self.contract,
            from_address=self.owner,
            to_address=self.spender,
            amount_raw=12345000,
            log_index=2,
        ))
        for overrides in (
            {"token_contract": self.spender},
            {"from_address": self.spender},
            {"to_address": self.owner},
            {"amount_raw": 12345001},
            {"log_index": 3},
        ):
            args = {
                "token_contract": self.contract,
                "from_address": self.owner,
                "to_address": self.spender,
                "amount_raw": 12345000,
                "log_index": 2,
            }
            args.update(overrides)
            self.assertFalse(main._verify_erc20_transfer_log(receipt, **args))

    def test_token_history_verification_returns_verified_only_after_rpc_confirmations(self):
        tx_hash = "0x" + "b" * 64
        receipt = self._transfer_receipt()
        block_hash = receipt["blockHash"]
        request = main.TokenTransferVerifyRequest(
            network="ethereum",
            owner_address=self.owner,
            token_contract_address=self.contract,
            from_address=self.owner,
            to_address=self.spender,
            tx_hash=tx_hash,
            amount_raw="12345000",
            log_index="2",
            block_number="100",
        )
        class FakeDatabaseContext:
            def __enter__(self):
                return self
            def __exit__(self, exc_type, exc, tb):
                return False
            def execute(self, *_args, **_kwargs):
                return type("Result", (), {"fetchone": lambda _self: (1,)})()

        def fake_rpc(_url, method, _params):
            if method == "eth_getTransactionByHash":
                return {"hash": tx_hash}
            if method == "eth_getTransactionReceipt":
                return receipt
            if method == "eth_getBlockByNumber":
                return {"hash": block_hash}
            if method == "eth_blockNumber":
                return "0x66"
            raise AssertionError("Unexpected RPC method: " + method)

        with patch.object(main, "db", return_value=FakeDatabaseContext()), \\
             patch.object(main, "ETH_RPC_URL", "https://ethereum.example"), \\
             patch.object(main, "require_ethereum_mainnet_rpc", return_value=1), \\
             patch.object(main, "rpc_call", side_effect=fake_rpc), \\
             patch.object(main, "required_confirmations", return_value=3):
            result = main.verify_wallet_token_interaction(request, {"wallet_id": "wallet_test"})

        self.assertEqual(result["verification_status"], "verified")
        self.assertEqual(result["confirmations"], 3)
        self.assertEqual(result["required_confirmations"], 3)
        self.assertEqual(result["evidence_source"], "selected network RPC")

    def test_token_history_verification_stays_pending_below_confirmation_threshold(self):
        tx_hash = "0x" + "b" * 64
        receipt = self._transfer_receipt()
        request = main.TokenTransferVerifyRequest(
            network="ethereum",
            owner_address=self.owner,
            token_contract_address=self.contract,
            from_address=self.owner,
            to_address=self.spender,
            tx_hash=tx_hash,
            amount_raw="12345000",
            log_index="2",
            block_number="100",
        )
        class FakeDatabaseContext:
            def __enter__(self):
                return self
            def __exit__(self, exc_type, exc, tb):
                return False
            def execute(self, *_args, **_kwargs):
                return type("Result", (), {"fetchone": lambda _self: (1,)})()

        def fake_rpc(_url, method, _params):
            if method == "eth_getTransactionByHash":
                return {"hash": tx_hash}
            if method == "eth_getTransactionReceipt":
                return receipt
            if method == "eth_getBlockByNumber":
                return {"hash": receipt["blockHash"]}
            if method == "eth_blockNumber":
                return "0x65"
            raise AssertionError("Unexpected RPC method: " + method)

        with patch.object(main, "db", return_value=FakeDatabaseContext()), \\
             patch.object(main, "ETH_RPC_URL", "https://ethereum.example"), \\
             patch.object(main, "require_ethereum_mainnet_rpc", return_value=1), \\
             patch.object(main, "rpc_call", side_effect=fake_rpc), \\
             patch.object(main, "required_confirmations", return_value=3):
            result = main.verify_wallet_token_interaction(request, {"wallet_id": "wallet_test"})

        self.assertEqual(result["verification_status"], "pending")
        self.assertEqual(result["confirmations"], 2)

    def test_token_history_verification_rejects_addresses_without_signature_ownership_proof(self):
        from fastapi import HTTPException

        request = main.TokenTransferVerifyRequest(
            network="ethereum",
            owner_address=self.owner,
            token_contract_address=self.contract,
            from_address=self.owner,
            to_address=self.spender,
            tx_hash="0x" + "b" * 64,
            amount_raw="12345000",
            log_index="2",
            block_number="100",
        )
        class FakeDatabaseContext:
            def __enter__(self):
                return self
            def __exit__(self, exc_type, exc, tb):
                return False
            def execute(self, *_args, **_kwargs):
                return type("Result", (), {"fetchone": lambda _self: None})()

        with patch.object(main, "db", return_value=FakeDatabaseContext()), \\
             patch.object(main, "require_ethereum_mainnet_rpc") as chain_check:
            with self.assertRaises(HTTPException) as caught:
                main.verify_wallet_token_interaction(request, {"wallet_id": "wallet_test"})

        self.assertEqual(caught.exception.status_code, 403)
        chain_check.assert_not_called()

    def test_token_history_verification_fails_closed_on_wrong_network_rpc(self):
        from fastapi import HTTPException

        request = main.TokenTransferVerifyRequest(
            network="bnb",
            owner_address=self.owner,
            token_contract_address=self.contract,
            from_address=self.owner,
            to_address=self.spender,
            tx_hash="0x" + "b" * 64,
            amount_raw="12345000",
            log_index="2",
            block_number="100",
        )
        class FakeDatabaseContext:
            def __enter__(self):
                return self
            def __exit__(self, exc_type, exc, tb):
                return False
            def execute(self, *_args, **_kwargs):
                return type("Result", (), {"fetchone": lambda _self: (1,)})()

        with patch.object(main, "db", return_value=FakeDatabaseContext()), \\
             patch.object(main, "BSC_RPC_URL", "https://bnb.example"), \\
             patch.object(main, "require_bnb_rpc", side_effect=ValueError("wrong chain")), \\
             patch.object(main, "rpc_call") as rpc:
            with self.assertRaises(HTTPException) as caught:
                main.verify_wallet_token_interaction(request, {"wallet_id": "wallet_test"})

        self.assertEqual(caught.exception.status_code, 503)
        rpc.assert_not_called()


if __name__ == "__main__":
    unittest.main()
