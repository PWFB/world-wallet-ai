import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class BalmzGlobalSupplyReconciliationTests(unittest.TestCase):
    def test_uint256_decoder_requires_exact_abi_word(self):
        self.assertEqual(main._balmz_decode_uint256_rpc("0x" + format(123, "064x")), 123)
        for invalid in (None, "0x01", "123", "0x" + "g" * 64, True):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                main._balmz_decode_uint256_rpc(invalid)

    def test_missing_chain_configuration_never_counts_as_zero(self):
        result = main._balmz_global_supply_summary({
            "ethereum": {"status": "NOT_CONFIGURED"},
            "bnb": {"status": "VERIFIED", "observed_supply": "10000000000"},
            "solana": {"status": "VERIFIED", "observed_supply": "10000000000"},
        })
        self.assertEqual(result["status"], "NOT_CONFIGURED")
        self.assertIsNone(result["observed_global_supply"])
        self.assertTrue(result["read_only"])
        self.assertFalse(result["transaction_authorized"])
        self.assertFalse(result["presale_release_gate_changed"])

    def test_exact_global_sum_is_reconciled_only_when_every_chain_verified(self):
        chains = {
            "ethereum": {"status": "VERIFIED", "observed_supply": "11000000000"},
            "bnb": {"status": "VERIFIED", "observed_supply": "10000000000"},
            "solana": {"status": "VERIFIED", "observed_supply": "10000000000"},
        }
        result = main._balmz_global_supply_summary(chains)
        self.assertEqual(result["status"], "RECONCILED")
        self.assertEqual(result["observed_global_supply"], "31000000000")
        chains["solana"]["status"] = "SUPPLY_MISMATCH"
        self.assertEqual(main._balmz_global_supply_summary(chains)["status"], "PARTIAL_DEPLOYMENT")

    def test_evm_supply_reads_chain_bytecode_supply_and_decimals(self):
        contract = "0x" + "1" * 40
        raw_supply = 11_000_000_000 * (10 ** 18)
        def fake_rpc(_url, method, params):
            if method == "eth_getCode":
                return "0x60016000"
            if method == "eth_call" and params[0]["data"] == "0x18160ddd":
                return "0x" + format(raw_supply, "064x")
            if method == "eth_call" and params[0]["data"] == "0x313ce567":
                return "0x" + format(18, "064x")
            raise AssertionError(method)
        with patch.object(main, "evm_chain_id", return_value=1), patch.object(main, "rpc_call", side_effect=fake_rpc):
            result = main._balmz_reconcile_evm_supply("ethereum", "https://rpc.example", contract, 1, 11_000_000_000)
        self.assertEqual(result["status"], "VERIFIED")
        self.assertEqual(result["observed_supply"], "11000000000")
        self.assertEqual(result["raw_supply"], str(raw_supply))

    def test_evm_wrong_chain_fails_closed_before_contract_reads(self):
        with patch.object(main, "evm_chain_id", return_value=56), patch.object(main, "rpc_call") as rpc:
            result = main._balmz_reconcile_evm_supply("ethereum", "https://rpc.example", "0x" + "1" * 40, 1, 11_000_000_000)
        self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
        self.assertEqual(result["reason"], "wrong_chain_id")
        rpc.assert_not_called()

    def test_devnet_mint_is_never_accepted_as_production(self):
        with patch.object(main, "rpc_call") as rpc:
            result = main._balmz_reconcile_solana_supply(main.BALMZ_SOLANA_DEVNET_MINT)
        self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
        self.assertEqual(result["reason"], "devnet_mint_rejected")
        rpc.assert_not_called()

    def test_endpoint_cannot_claim_full_reconciliation_without_reserve_evidence(self):
        user = {"id": "owner", "email": "owner@example.com"}
        verified = {"network": "test", "status": "VERIFIED", "observed_supply": "10000000000", "allocation_matches": True}
        with (
            patch.object(main, "require_world_wallet_admin"),
            patch.object(main, "record_admin_event"),
            patch.object(main, "_balmz_reconcile_evm_supply", side_effect=[{**verified, "observed_supply": "11000000000"}, verified]),
            patch.object(main, "_balmz_reconcile_solana_supply", return_value=verified),
            patch.object(main, "BALMZ_ETH_VESTING_CONTRACT", ""),
        ):
            result = main.balmz_global_supply_reconciliation(user)
        self.assertEqual(result["status"], "PARTIAL_DEPLOYMENT")
        self.assertEqual(result["ethereum_reserve_evidence"], "NOT_CONFIGURED")
        self.assertFalse(result["presale_release_gate_changed"])


if __name__ == "__main__":
    unittest.main()
