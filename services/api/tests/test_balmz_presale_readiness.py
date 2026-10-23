import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


VALID_MINT = "HBSuf6Dm9r2ebkwLUoaY8ScR2rq5L2CPTJpCbqMbtndF"
VALID_RECEIVER = "7FNyayYwgfrGb3mCsRttuJUkFQgsgDtrYBhhddKS6iVN"


def mainnet_rpc(_url, method, _params):
    if method == "getGenesisHash":
        return main.SOLANA_MAINNET_GENESIS_HASH
    if method == "getBalance":
        return {"value": 2_500_000_000}
    if method == "getAccountInfo" and _params and _params[0] == VALID_RECEIVER:
        return {"value": {"owner": "11111111111111111111111111111111", "data": ["", "base64"]}}
    if method == "getAccountInfo":
        return {
            "value": {
                "owner": main.SOLANA_SPL_TOKEN_PROGRAM_ID,
                "data": {
                    "program": "spl-token",
                    "parsed": {
                        "type": "mint",
                        "info": {
                            "decimals": 9,
                            "mintAuthority": None,
                            "freezeAuthority": None,
                        },
                    },
                },
            },
        }
    if method == "getTokenSupply":
        return {"value": {"amount": str(1_000_000_000 * (10 ** 9)), "decimals": 9, "uiAmountString": "1000000000"}}
    raise AssertionError("Unexpected RPC method: " + method)


class BalmzPresaleReadinessTests(unittest.TestCase):
    def test_unconfigured_presale_is_planning_only_and_payments_stay_disabled(self):
        with patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", ""), patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", ""):
            result = main.balmz_presale_status({"id": "test-user"})

        self.assertEqual(result["stage"], "planning")
        self.assertEqual(result["presale_price_usd"], 7.0)
        self.assertEqual(result["launch_target"], "1 BALMZ-SOL = 1 SOL")
        self.assertFalse(result["launch_price_guaranteed"])
        self.assertFalse(result["payment_acceptance_enabled"])
        self.assertIsNone(result["production_mint"])
        self.assertEqual(result["devnet_mint"], main.BALMZ_SOLANA_DEVNET_MINT)
        self.assertFalse(result["readiness"]["production_mint_verified"])
        self.assertFalse(result["readiness"]["payment_verification_implemented"])
        self.assertTrue(result["warnings"])

    def test_verified_one_billion_mainnet_mint_does_not_enable_presale(self):
        with (
            patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", VALID_MINT),
            patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", VALID_RECEIVER),
            patch.object(main, "rpc_call", side_effect=mainnet_rpc),
        ):
            result = main.balmz_presale_status({"id": "test-user"})

        self.assertTrue(result["readiness"]["production_mint_verified"])
        self.assertTrue(result["readiness"]["supply_matches_target"])
        self.assertTrue(result["readiness"]["mint_authority_revoked"])
        self.assertEqual(result["observed_supply"], 1_000_000_000)
        self.assertTrue(result["receiving_address_configured"])
        self.assertTrue(result["presale_receiving_address_mainnet_verified"])
        self.assertTrue(result["presale_receiving_address_account_exists"])
        self.assertTrue(result["presale_receiving_address_has_positive_sol_balance"])
        self.assertEqual(result["presale_receiving_balance_sol"], 2.5)
        self.assertFalse(result["payment_acceptance_enabled"])


    def test_receiver_with_zero_balance_is_not_marked_funded(self):
        def rpc_zero_balance(_url, method, params):
            if method == "getGenesisHash":
                return main.SOLANA_MAINNET_GENESIS_HASH
            if method == "getBalance":
                return {"value": 0}
            if method == "getAccountInfo" and params and params[0] == VALID_RECEIVER:
                return {"value": {"owner": "11111111111111111111111111111111", "data": ["", "base64"]}}
            return mainnet_rpc(_url, method, params)

        with (
            patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", ""),
            patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", VALID_RECEIVER),
            patch.object(main, "rpc_call", side_effect=rpc_zero_balance),
        ):
            result = main.balmz_presale_status({"id": "test-user"})

        self.assertTrue(result["presale_receiving_address_mainnet_verified"])
        self.assertFalse(result["presale_receiving_address_has_positive_sol_balance"])
        self.assertEqual(result["presale_receiving_balance_sol"], 0.0)
        self.assertFalse(result["payment_acceptance_enabled"])
        self.assertTrue(any("no positive SOL balance" in warning for warning in result["warnings"]))

    def test_mint_authority_still_enabled_is_not_fixed_supply(self):
        def rpc_with_authority(_url, method, params):
            result = mainnet_rpc(_url, method, params)
            if method == "getAccountInfo" and params and params[0] != VALID_RECEIVER:
                result["value"]["data"]["parsed"]["info"]["mintAuthority"] = VALID_RECEIVER
            return result

        with (
            patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", VALID_MINT),
            patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", VALID_RECEIVER),
            patch.object(main, "rpc_call", side_effect=rpc_with_authority),
        ):
            result = main.balmz_presale_status({"id": "test-user"})

        self.assertTrue(result["readiness"]["production_mint_verified"])
        self.assertTrue(result["readiness"]["supply_matches_target"])
        self.assertFalse(result["readiness"]["mint_authority_revoked"])
        self.assertFalse(result["payment_acceptance_enabled"])
        self.assertTrue(any("mint authority is still enabled" in warning for warning in result["warnings"]))

    def test_wrong_mainnet_cluster_fails_closed(self):
        with (
            patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", VALID_MINT),
            patch.object(main, "rpc_call", return_value=main.SOLANA_DEVNET_GENESIS_HASH),
        ):
            result = main.balmz_presale_status({"id": "test-user"})

        self.assertFalse(result["readiness"]["production_mint_verified"])
        self.assertFalse(result["payment_acceptance_enabled"])
        self.assertTrue(any("could not be verified" in warning for warning in result["warnings"]))

    def test_invalid_mint_address_is_not_queried(self):
        with (
            patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", "not-a-solana-address"),
            patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", ""),
            patch.object(main, "rpc_call") as rpc,
        ):
            result = main.balmz_presale_status({"id": "test-user"})

        rpc.assert_not_called()
        self.assertIsNone(result["production_mint"])
        self.assertFalse(result["readiness"]["production_mint_verified"])
        self.assertFalse(result["payment_acceptance_enabled"])


if __name__ == "__main__":
    unittest.main()
