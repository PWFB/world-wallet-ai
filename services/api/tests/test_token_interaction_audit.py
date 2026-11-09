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


if __name__ == "__main__":
    unittest.main()
