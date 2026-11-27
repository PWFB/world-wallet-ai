import unittest
from unittest.mock import patch

try:
    from services.api import main
except ModuleNotFoundError:
    import main


class SolanaSecondaryRpcContextFloorTests(unittest.TestCase):
    MINT = "So11111111111111111111111111111111111111112"
    RAW_SUPPLY = "10000000000000000000"

    def account(self, slot):
        return {
            "context": {"slot": slot},
            "value": {
                "owner": main.SOLANA_SPL_TOKEN_PROGRAM_ID,
                "executable": False,
                "data": {"parsed": {"type": "mint", "info": {
                    "isInitialized": True,
                    "decimals": 9,
                    "supply": self.RAW_SUPPLY,
                    "mintAuthority": None,
                    "freezeAuthority": None,
                }}},
            },
        }

    def supply(self, slot):
        return {
            "context": {"slot": slot},
            "value": {"amount": self.RAW_SUPPLY, "decimals": 9},
        }

    def reconcile(self, responses):
        with patch.object(main, "require_solana_rpc_cluster"), patch.object(
            main, "rpc_call", side_effect=responses
        ) as rpc:
            result = main._balmz_solana_independent_rpc_corroboration(
                "https://primary.example",
                "https://secondary.example",
                self.MINT,
                987,
                self.RAW_SUPPLY,
                9,
                main.SOLANA_SPL_TOKEN_PROGRAM_ID,
                None,
                None,
            )
        return result, rpc

    def test_rejects_secondary_account_older_than_primary_context_floor(self):
        result, rpc = self.reconcile([self.account(986)])
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["reason"], "secondary_rpc_mint_state_mismatch")
        self.assertEqual(rpc.call_count, 1)

    def test_rejects_secondary_supply_older_than_secondary_account_context(self):
        result, rpc = self.reconcile([self.account(990), self.supply(989)])
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["reason"], "secondary_rpc_supply_mismatch")
        self.assertEqual(rpc.call_count, 2)

    def test_accepts_equal_context_floor_and_supply_slot(self):
        result, rpc = self.reconcile([self.account(987), self.supply(987)])
        self.assertEqual(result["status"], "VERIFIED")
        self.assertTrue(result["same_finalized_slot"])
        self.assertEqual(rpc.call_count, 2)


if __name__ == "__main__":
    unittest.main()
