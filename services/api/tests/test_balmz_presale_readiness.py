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
        return {"value": {"owner": "11111111111111111111111111111111", "executable": False, "data": ["", "base64"]}}
    if method == "getAccountInfo":
        return {
            "value": {
                "owner": main.SOLANA_SPL_TOKEN_PROGRAM_ID,
                "executable": False,
                "data": {
                    "program": "spl-token",
                    "parsed": {
                        "type": "mint",
                        "info": {
                            "decimals": 9,
                            "isInitialized": True,
                            "supply": str(10_000_000_000 * (10 ** 9)),
                            "mintAuthority": None,
                            "freezeAuthority": None,
                        },
                    },
                },
            },
        }
    if method == "getTokenSupply":
        return {"value": {"amount": str(10_000_000_000 * (10 ** 9)), "decimals": 9, "uiAmountString": "10000000000"}}
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
        self.assertTrue(result["readiness"]["payment_verification_implemented"])
        self.assertTrue(result["readiness"]["payment_intents_implemented"])
        self.assertTrue(result["readiness"]["atomic_settlement_implemented"])
        self.assertTrue(result["readiness"]["presale_allocation_ledger_implemented"])
        self.assertTrue(result["warnings"])

    def test_verified_ten_billion_solana_allocation_does_not_enable_presale(self):
        with (
            patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", VALID_MINT),
            patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", VALID_RECEIVER),
            patch.object(main, "rpc_call", side_effect=mainnet_rpc),
        ):
            result = main.balmz_presale_status({"id": "test-user"})

        self.assertTrue(result["readiness"]["production_mint_verified"])
        self.assertTrue(result["readiness"]["supply_matches_target"])
        self.assertTrue(result["readiness"]["mint_authority_revoked"])
        self.assertEqual(result["observed_supply"], 10_000_000_000)
        self.assertEqual(result["target_supply"], 10_000_000_000)
        self.assertEqual(result["solana_mainnet_allocation"], 10_000_000_000)
        self.assertEqual(result["initial_presale_tranche"], 1_000_000_000)
        self.assertTrue(result["initial_presale_tranche_within_allocation"])
        self.assertEqual(result["remaining_solana_allocation_after_initial_tranche"], 9_000_000_000)
        self.assertEqual(result["global_max_supply"], 31_000_000_000)
        self.assertTrue(result["receiving_address_configured"])
        self.assertTrue(result["presale_receiving_address_mainnet_verified"])
        self.assertTrue(result["presale_receiving_address_account_exists"])
        self.assertTrue(result["readiness"]["receiving_address_system_account_verified"])
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
                return {"value": {"owner": "11111111111111111111111111111111", "executable": False, "data": ["", "base64"]}}
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

    def test_receiver_missing_from_mainnet_is_not_a_valid_funded_treasury(self):
        def rpc_missing_receiver(_url, method, _params):
            if method == "getGenesisHash":
                return main.SOLANA_MAINNET_GENESIS_HASH
            if method == "getBalance":
                return {"value": 0}
            if method == "getAccountInfo":
                return {"value": None}
            raise AssertionError("Unexpected RPC method: " + method)

        with (
            patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", ""),
            patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", VALID_RECEIVER),
            patch.object(main, "rpc_call", side_effect=rpc_missing_receiver),
        ):
            result = main.balmz_presale_status({"id": "test-user"})

        self.assertTrue(result["receiving_address_configured"])
        self.assertTrue(result["presale_receiving_address_mainnet_verified"])
        self.assertFalse(result["presale_receiving_address_account_exists"])
        self.assertFalse(result["presale_receiving_address_has_positive_sol_balance"])
        self.assertFalse(result["payment_acceptance_enabled"])
        self.assertTrue(any("no on-chain account" in warning for warning in result["warnings"]))


    def test_receiver_owned_by_non_system_program_is_not_accepted_as_treasury_wallet(self):
        def rpc_non_system_owner(_url, method, params):
            if method == "getGenesisHash":
                return main.SOLANA_MAINNET_GENESIS_HASH
            if method == "getBalance":
                return {"value": 2_500_000_000}
            if method == "getAccountInfo" and params and params[0] == VALID_RECEIVER:
                return {"value": {"owner": main.SOLANA_SPL_TOKEN_PROGRAM_ID, "executable": False, "data": ["", "base64"]}}
            return mainnet_rpc(_url, method, params)

        with (
            patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", ""),
            patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", VALID_RECEIVER),
            patch.object(main, "rpc_call", side_effect=rpc_non_system_owner),
        ):
            result = main.balmz_presale_status({"id": "test-user"})

        self.assertTrue(result["presale_receiving_address_account_exists"])
        self.assertFalse(result["readiness"]["receiving_address_system_account_verified"])
        self.assertFalse(result["payment_acceptance_enabled"])
        self.assertTrue(any("not verified as a non-executable System Program wallet" in warning for warning in result["warnings"]))

    def test_executable_system_program_account_is_not_accepted_as_treasury_wallet(self):
        def rpc_executable(_url, method, params):
            if method == "getGenesisHash":
                return main.SOLANA_MAINNET_GENESIS_HASH
            if method == "getBalance":
                return {"value": 2_500_000_000}
            if method == "getAccountInfo" and params and params[0] == VALID_RECEIVER:
                return {"value": {"owner": "11111111111111111111111111111111", "executable": True, "data": ["", "base64"]}}
            return mainnet_rpc(_url, method, params)

        with (
            patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", ""),
            patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", VALID_RECEIVER),
            patch.object(main, "rpc_call", side_effect=rpc_executable),
        ):
            result = main.balmz_presale_status({"id": "test-user"})

        self.assertFalse(result["readiness"]["receiving_address_system_account_verified"])
        self.assertFalse(result["payment_acceptance_enabled"])


    def test_mint_account_must_be_initialized_and_non_executable(self):
        for metadata in (
            {"executable": True, "isInitialized": True},
            {"executable": False, "isInitialized": False},
        ):
            def rpc_invalid_metadata(_url, method, params):
                response = mainnet_rpc(_url, method, params)
                if method == "getAccountInfo" and params and params[0] != VALID_RECEIVER:
                    response["value"]["executable"] = metadata["executable"]
                    response["value"]["data"]["parsed"]["info"]["isInitialized"] = metadata["isInitialized"]
                return response

            with (
                self.subTest(metadata=metadata),
                patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", VALID_MINT),
                patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", ""),
                patch.object(main, "rpc_call", side_effect=rpc_invalid_metadata),
            ):
                result = main.balmz_presale_status({"id": "test-user"})

            self.assertFalse(result["readiness"]["production_mint_verified"])
            self.assertFalse(result["payment_acceptance_enabled"])

    def test_mint_parsed_and_token_supply_rpc_amounts_must_match(self):
        def rpc_inconsistent_supply(_url, method, params):
            response = mainnet_rpc(_url, method, params)
            if method == "getAccountInfo" and params and params[0] != VALID_RECEIVER:
                response["value"]["data"]["parsed"]["info"]["supply"] = "1"
            return response

        with (
            patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", VALID_MINT),
            patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", ""),
            patch.object(main, "rpc_call", side_effect=rpc_inconsistent_supply),
        ):
            result = main.balmz_presale_status({"id": "test-user"})

        self.assertTrue(result["readiness"]["production_mint_verified"])
        self.assertFalse(result["readiness"]["supply_matches_target"])
        self.assertIsNone(result["observed_supply"])
        self.assertFalse(result["payment_acceptance_enabled"])
        self.assertTrue(any("missing or inconsistent" in warning for warning in result["warnings"]))

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

    def test_mainnet_read_only_verifiers_reject_insecure_rpc_urls_before_rpc(self):
        for rpc_url in (
            "http://solana-mainnet.example",
            "not-a-url",
            "https://user:password@solana-mainnet.example",
        ):
            with (
                self.subTest(rpc_url=rpc_url),
                patch.object(main, "SOLANA_MAINNET_RPC_URL", rpc_url),
                patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", VALID_MINT),
                patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", VALID_RECEIVER),
                patch.object(main, "rpc_call") as rpc,
            ):
                result = main.balmz_presale_status({"id": "test-user"})
            rpc.assert_not_called()
            self.assertFalse(result["readiness"]["production_mint_verified"])
            self.assertFalse(result["readiness"]["receiving_address_mainnet_verified"])
            self.assertFalse(result["payment_acceptance_enabled"])
            self.assertTrue(any("could not be verified" in warning for warning in result["warnings"]))

    def test_devnet_rpc_cluster_validation_remains_separate(self):
        with patch.object(main, "rpc_call", return_value=main.SOLANA_DEVNET_GENESIS_HASH) as rpc:
            result = main.require_solana_rpc_cluster(
                "https://api.devnet.solana.com",
                main.SOLANA_DEVNET_GENESIS_HASH,
                "Solana Devnet",
            )
        self.assertEqual(result, main.SOLANA_DEVNET_GENESIS_HASH)
        rpc.assert_called_once()

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


    def test_treasury_balance_rejects_malformed_lamport_metadata(self):
        invalid_balances = (True, -1, 1.5, "2500000000", None)
        for invalid_balance in invalid_balances:
            def rpc_invalid_balance(_url, method, _params):
                if method == "getGenesisHash":
                    return main.SOLANA_MAINNET_GENESIS_HASH
                if method == "getBalance":
                    return {"value": invalid_balance}
                raise AssertionError("Treasury account lookup must not run after invalid balance metadata")

            with (
                self.subTest(balance=invalid_balance),
                patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", ""),
                patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", VALID_RECEIVER),
                patch.object(main, "rpc_call", side_effect=rpc_invalid_balance),
            ):
                result = main.balmz_presale_status({"id": "test-user"})

            self.assertFalse(result["presale_receiving_address_mainnet_verified"])
            self.assertIsNone(result["presale_receiving_balance_sol"])
            self.assertFalse(result["presale_receiving_address_has_positive_sol_balance"])
            self.assertFalse(result["payment_acceptance_enabled"])
            self.assertTrue(any("balance could not be verified" in warning for warning in result["warnings"]))


    def test_treasury_requires_exact_non_executable_system_account_metadata(self):
        invalid_accounts = (
            {"executable": False},
            {"owner": "11111111111111111111111111111111"},
            {"owner": main.SOLANA_SPL_TOKEN_PROGRAM_ID, "executable": False},
            {"owner": "11111111111111111111111111111111", "executable": 0},
            {"owner": "11111111111111111111111111111111", "executable": None},
        )
        for account_metadata in invalid_accounts:
            def rpc_invalid_account(_url, method, params):
                if method == "getGenesisHash":
                    return main.SOLANA_MAINNET_GENESIS_HASH
                if method == "getBalance":
                    return {"value": 2_500_000_000}
                if method == "getAccountInfo" and params and params[0] == VALID_RECEIVER:
                    return {"value": {**account_metadata, "data": ["", "base64"]}}
                return mainnet_rpc(_url, method, params)

            with (
                self.subTest(account=account_metadata),
                patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", ""),
                patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", VALID_RECEIVER),
                patch.object(main, "rpc_call", side_effect=rpc_invalid_account),
            ):
                result = main.balmz_presale_status({"id": "test-user"})

            self.assertTrue(result["presale_receiving_address_account_exists"])
            self.assertFalse(result["readiness"]["receiving_address_system_account_verified"])
            self.assertFalse(result["payment_acceptance_enabled"])
            self.assertTrue(any("not verified as a non-executable System Program wallet" in warning for warning in result["warnings"]))


    def test_treasury_account_info_requires_object_response_metadata(self):
        malformed_values = (None, [], "account", 0, True)
        for account_value in malformed_values:
            def rpc_malformed_account(_url, method, params):
                if method == "getGenesisHash":
                    return main.SOLANA_MAINNET_GENESIS_HASH
                if method == "getBalance":
                    return {"value": 2_500_000_000}
                if method == "getAccountInfo" and params and params[0] == VALID_RECEIVER:
                    return {"value": account_value}
                return mainnet_rpc(_url, method, params)

            with (
                self.subTest(account_value=account_value),
                patch.object(main, "BALMZ_SOLANA_MAINNET_MINT", ""),
                patch.object(main, "BALMZ_PRESALE_RECEIVING_ADDRESS", VALID_RECEIVER),
                patch.object(main, "rpc_call", side_effect=rpc_malformed_account),
            ):
                result = main.balmz_presale_status({"id": "test-user"})

            self.assertFalse(result["presale_receiving_address_account_exists"])
            self.assertFalse(result["readiness"]["receiving_address_system_account_verified"])
            self.assertFalse(result["payment_acceptance_enabled"])
            self.assertTrue(any("no on-chain account" in warning for warning in result["warnings"]))


if __name__ == "__main__":
    unittest.main()
