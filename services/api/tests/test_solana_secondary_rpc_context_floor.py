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

    def assert_provider_rejected_before_rpc(self, primary_url, secondary_url, expected_reason):
        with patch.object(main, "require_solana_rpc_cluster") as cluster, patch.object(
            main, "rpc_call"
        ) as rpc:
            result = main._balmz_solana_independent_rpc_corroboration(
                primary_url,
                secondary_url,
                self.MINT,
                987,
                self.RAW_SUPPLY,
                9,
                main.SOLANA_SPL_TOKEN_PROGRAM_ID,
                None,
                None,
            )
        self.assertEqual(result, {"status": "FAILED", "reason": expected_reason})
        cluster.assert_not_called()
        rpc.assert_not_called()

    def test_rejects_trailing_dot_dns_alias_before_rpc(self):
        self.assert_provider_rejected_before_rpc(
            "https://primary.example", "https://primary.example.",
            "secondary_rpc_provider_not_independent",
        )

    def test_rejects_idn_and_punycode_alias_before_rpc(self):
        self.assert_provider_rejected_before_rpc(
            "https://xn--bcher-kva.example", "https://bücher.example",
            "secondary_rpc_provider_not_independent",
        )

    def test_rejects_equivalent_ipv6_spellings_before_rpc(self):
        self.assert_provider_rejected_before_rpc(
            "https://[2001:db8::1]", "https://[2001:0db8:0:0:0:0:0:1]",
            "secondary_rpc_provider_not_independent",
        )

    def test_rejects_ipv4_mapped_ipv6_alias_before_rpc(self):
        self.assert_provider_rejected_before_rpc(
            "https://192.0.2.1", "https://[::ffff:192.0.2.1]",
            "secondary_rpc_provider_not_independent",
        )

    def test_rejects_ambiguous_legacy_numeric_host_before_rpc(self):
        self.assert_provider_rejected_before_rpc(
            "https://127.0.0.1", "https://127.1",
            "invalid_rpc_provider_hostname",
        )

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
