import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class BalmzGlobalSupplyReconciliationTests(unittest.TestCase):
    def test_evm_mainnet_rpc_rejects_insecure_fallback_endpoint(self):
        with (
            patch.object(main, "ETH_RPC_URL", "https://primary.example"),
            patch.object(main, "ETH_PUBLIC_RPC_URL", "http://fallback.example"),
        ):
            with self.assertRaisesRegex(ValueError, "insecure_mainnet_rpc_url"):
                main._balmz_require_secure_evm_mainnet_rpc_url("https://primary.example")

    def test_evm_mainnet_rpc_accepts_secure_fallback_endpoint(self):
        with (
            patch.object(main, "ETH_RPC_URL", "https://primary.example"),
            patch.object(main, "ETH_PUBLIC_RPC_URL", "https://fallback.example"),
        ):
            parsed = main._balmz_require_secure_evm_mainnet_rpc_url("https://primary.example")
        self.assertEqual(parsed.hostname, "primary.example")

    def test_evm_chain_id_accepts_canonical_json_rpc_quantities(self):
        for raw, expected in (("0x0", 0), ("0x1", 1), ("0x38", 56), ("0xaa36a7", 11155111)):
            with self.subTest(raw=raw), patch.object(main, "rpc_call", return_value=raw):
                self.assertEqual(main.evm_chain_id("https://rpc.example"), expected)

    def test_evm_chain_id_rejects_noncanonical_or_malformed_quantities(self):
        invalid_values = (None, "", True, 1, "0x", "0x00", "0x01", "0X1", "1", "0x+1", "0x-1", "0xgg", " 0x1")
        for raw in invalid_values:
            with self.subTest(raw=raw), patch.object(main, "rpc_call", return_value=raw):
                with self.assertRaisesRegex(ValueError, "invalid_chain_id"):
                    main.evm_chain_id("https://rpc.example")

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

    def test_verified_chain_records_with_malformed_supply_fail_closed(self):
        invalid_values = (None, True, 1, -1, "1.5", "1e10", "", "031000000000")
        for invalid in invalid_values:
            with self.subTest(invalid=invalid):
                chains = {
                    "ethereum": {"status": "VERIFIED", "observed_supply": "11000000000"},
                    "bnb": {"status": "VERIFIED", "observed_supply": "10000000000"},
                    "solana": {"status": "VERIFIED", "observed_supply": invalid},
                }
                result = main._balmz_global_supply_summary(chains)
                self.assertEqual(result["status"], "PARTIAL_DEPLOYMENT")
                self.assertIsNone(result["observed_global_supply"])
                self.assertFalse(result["transaction_authorized"])
                self.assertFalse(result["presale_release_gate_changed"])

    def test_missing_or_non_object_chain_record_fails_closed(self):
        for chains in (None, {}, {"ethereum": None, "bnb": {}, "solana": []}):
            with self.subTest(chains=chains):
                result = main._balmz_global_supply_summary(chains)
                self.assertEqual(result["status"], "PARTIAL_DEPLOYMENT")
                self.assertIsNone(result["observed_global_supply"])


    def test_solana_mainnet_cluster_mismatch_stops_before_mint_reads(self):
        with patch.object(main, "require_solana_rpc_cluster", side_effect=ValueError("wrong_genesis_hash")), patch.object(main, "rpc_call") as rpc:
            result = main._balmz_reconcile_solana_supply("So11111111111111111111111111111111111111112")
        self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
        self.assertEqual(result["reason"], "mainnet_rpc_or_mint_verification_failed")
        self.assertIsNone(result["observed_supply"])
        rpc.assert_not_called()

    def test_solana_parsed_supply_must_match_finalized_token_supply(self):
        mint = "So11111111111111111111111111111111111111112"
        raw_supply = str(main.BALMZ_SOLANA_MAINNET_ALLOCATION * (10 ** 9))
        account = {
            "context": {"slot": 777},
            "value": {
                "owner": main.SOLANA_SPL_TOKEN_PROGRAM_ID,
                "executable": False,
                "data": {"parsed": {"type": "mint", "info": {
                    "isInitialized": True, "decimals": 9, "supply": raw_supply,
                    "mintAuthority": None, "freezeAuthority": None
                }}}
            }
        }
        def fake_rpc(_url, method, params):
            if method == "getAccountInfo":
                return account
            if method == "getTokenSupply":
                return {"context": {"slot": 777}, "value": {"amount": str(int(raw_supply) + 1), "decimals": 9}}
            raise AssertionError(method)
        with patch.object(main, "require_solana_rpc_cluster"), patch.object(main, "rpc_call", side_effect=fake_rpc):
            result = main._balmz_reconcile_solana_supply(mint)
        self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
        self.assertEqual(result["reason"], "mint_supply_rpc_mismatch")
        self.assertIsNone(result["observed_supply"])

    def test_solana_supply_verifies_both_rpc_reads_at_the_same_finalized_slot(self):
        mint = "So11111111111111111111111111111111111111112"
        raw_supply = str(main.BALMZ_SOLANA_MAINNET_ALLOCATION * (10 ** 9))
        account = {
            "context": {"slot": 777},
            "value": {
                "owner": main.SOLANA_SPL_TOKEN_PROGRAM_ID,
                "executable": False,
                "data": {"parsed": {"type": "mint", "info": {
                    "isInitialized": True, "decimals": 9, "supply": raw_supply,
                    "mintAuthority": None, "freezeAuthority": None
                }}}
            }
        }
        calls = []
        def fake_rpc(_url, method, params):
            calls.append((method, params))
            if method == "getAccountInfo":
                return account
            if method == "getTokenSupply":
                self.assertEqual(params[1], {"commitment": "finalized", "minContextSlot": 777})
                return {"context": {"slot": 777}, "value": {"amount": raw_supply, "decimals": 9}}
            raise AssertionError(method)
        with patch.object(main, "require_solana_rpc_cluster"), patch.object(main, "rpc_call", side_effect=fake_rpc):
            result = main._balmz_reconcile_solana_supply(mint)
        self.assertEqual(result["status"], "VERIFIED")
        self.assertEqual(result["observed_supply"], str(main.BALMZ_SOLANA_MAINNET_ALLOCATION))
        self.assertEqual(result["context_slot"], 777)
        self.assertEqual(result["commitment"], "finalized")
        self.assertEqual([call[0] for call in calls], ["getAccountInfo", "getTokenSupply"])

    def test_solana_supply_rejects_different_finalized_rpc_slots(self):
        mint = "So11111111111111111111111111111111111111112"
        raw_supply = str(main.BALMZ_SOLANA_MAINNET_ALLOCATION * (10 ** 9))
        account = {
            "context": {"slot": 777},
            "value": {
                "owner": main.SOLANA_SPL_TOKEN_PROGRAM_ID,
                "executable": False,
                "data": {"parsed": {"type": "mint", "info": {
                    "isInitialized": True, "decimals": 9, "supply": raw_supply,
                    "mintAuthority": None, "freezeAuthority": None
                }}}
            }
        }
        def fake_rpc(_url, method, params):
            if method == "getAccountInfo":
                return account
            if method == "getTokenSupply":
                self.assertEqual(params[1]["minContextSlot"], 777)
                return {"context": {"slot": 778}, "value": {"amount": raw_supply, "decimals": 9}}
            raise AssertionError(method)
        with patch.object(main, "require_solana_rpc_cluster"), patch.object(main, "rpc_call", side_effect=fake_rpc):
            result = main._balmz_reconcile_solana_supply(mint)
        self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
        self.assertEqual(result["reason"], "mint_snapshot_slot_mismatch")
        self.assertIsNone(result["observed_supply"])

    def test_solana_supply_requires_valid_context_slot_metadata(self):
        mint = "So11111111111111111111111111111111111111112"
        invalid_contexts = (None, {}, {"slot": True}, {"slot": "777"}, {"slot": -1})
        for context in invalid_contexts:
            with self.subTest(context=context):
                def fake_rpc(_url, method, _params):
                    if method == "getAccountInfo":
                        return {"context": context, "value": None}
                    raise AssertionError("token supply read must not follow invalid account context")
                with patch.object(main, "require_solana_rpc_cluster"), patch.object(main, "rpc_call", side_effect=fake_rpc):
                    result = main._balmz_reconcile_solana_supply(mint)
                self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
                self.assertEqual(result["reason"], "mint_context_slot_invalid")
                self.assertIsNone(result["observed_supply"])

    def test_evm_supply_reads_all_contract_data_at_one_finalized_block(self):
        contract = "0x" + "1" * 40
        raw_supply = 11_000_000_000 * (10 ** 18)
        block_tag = "0x1234"
        block_hash = "0x" + "a" * 64
        seen_tags = []
        def fake_rpc(_url, method, params):
            if method == "eth_getBlockByNumber":
                self.assertEqual(params, ["finalized", False])
                return {"number": block_tag, "hash": block_hash}
            if method == "eth_getCode":
                seen_tags.append(params[1])
                return "0x60016000"
            if method == "eth_call" and params[0]["data"] == "0x18160ddd":
                seen_tags.append(params[1])
                return "0x" + format(raw_supply, "064x")
            if method == "eth_call" and params[0]["data"] == "0x313ce567":
                seen_tags.append(params[1])
                return "0x" + format(18, "064x")
            raise AssertionError(method)
        with patch.object(main, "evm_chain_id", return_value=1), patch.object(main, "rpc_call", side_effect=fake_rpc):
            result = main._balmz_reconcile_evm_supply("ethereum", "https://rpc.example", contract, 1, 11_000_000_000)
        self.assertEqual(result["status"], "VERIFIED")
        self.assertEqual(result["observed_supply"], "11000000000")
        self.assertEqual(result["raw_supply"], str(raw_supply))
        self.assertEqual(seen_tags, [block_tag, block_tag, block_tag])
        self.assertEqual(result["block_number"], str(int(block_tag, 16)))
        self.assertEqual(result["block_hash"], block_hash)
        self.assertEqual(result["commitment"], "finalized")

    def test_evm_supply_rejects_malformed_finalized_block_before_contract_reads(self):
        contract = "0x" + "1" * 40
        for block in (
            None,
            {"number": "0x01", "hash": "0x" + "a" * 64},
            {"number": "0x1", "hash": "0x1234"},
            {"number": "latest", "hash": "0x" + "a" * 64},
        ):
            with self.subTest(block=block):
                def fake_rpc(_url, method, _params):
                    if method == "eth_getBlockByNumber":
                        return block
                    raise AssertionError("contract read must not occur")
                with patch.object(main, "evm_chain_id", return_value=1), patch.object(main, "rpc_call", side_effect=fake_rpc):
                    result = main._balmz_reconcile_evm_supply("ethereum", "https://rpc.example", contract, 1, 11_000_000_000)
                self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
                self.assertEqual(result["reason"], "finalized_block_metadata_invalid")
                self.assertIsNone(result["observed_supply"])

    def test_evm_mainnet_supply_requires_https_rpc_without_credentials(self):
        contract = "0x" + "1" * 40
        invalid_urls = (
            "http://rpc.example",
            "https://user:secret@rpc.example",
            "https:///missing-host",
            "https://rpc.example:99999",
            "https://rpc.example/path#fragment",
        )
        for rpc_url in invalid_urls:
            with self.subTest(rpc_url=rpc_url), patch.object(main, "evm_chain_id") as chain_id, patch.object(main, "rpc_call") as rpc:
                result = main._balmz_reconcile_evm_supply("ethereum", rpc_url, contract, 1, 11_000_000_000)
            self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
            self.assertEqual(result["reason"], "insecure_mainnet_rpc_url")
            self.assertIsNone(result["observed_supply"])
            chain_id.assert_not_called()
            rpc.assert_not_called()

    def test_ethereum_reserve_rejects_insecure_rpc_before_contract_reads(self):
        with patch.object(main, "valid_evm_address", return_value=True), patch.object(main, "rpc_call") as rpc:
            result = main._balmz_reconcile_ethereum_reserve(
                "http://rpc.example", "0x" + "1" * 40, "0x" + "2" * 40, "0x" + "3" * 40
            )
        self.assertEqual(result["status"], "CONTRACT_INVALID")
        self.assertEqual(result["reason"], "insecure_mainnet_rpc_url")
        rpc.assert_not_called()

    def test_evm_wrong_chain_fails_closed_before_contract_reads(self):
        with patch.object(main, "evm_chain_id", return_value=56), patch.object(main, "rpc_call") as rpc:
            result = main._balmz_reconcile_evm_supply("ethereum", "https://rpc.example", "0x" + "1" * 40, 1, 11_000_000_000)
        self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
        self.assertEqual(result["reason"], "wrong_chain_id")
        rpc.assert_not_called()

    def test_solana_supply_amounts_must_be_canonical_unsigned_integers(self):
        mint = "So11111111111111111111111111111111111111112"
        raw_supply = str(main.BALMZ_SOLANA_MAINNET_ALLOCATION * (10 ** 9))
        invalid_amounts = ("", "00", "01", "+1", "-1", " 1", "1 ", "1.0", "1e9", "١")
        for invalid in invalid_amounts:
            with self.subTest(invalid=invalid):
                account = {
                    "value": {
                        "owner": main.SOLANA_SPL_TOKEN_PROGRAM_ID,
                        "executable": False,
                        "data": {"parsed": {"type": "mint", "info": {
                            "isInitialized": True, "decimals": 9, "supply": invalid,
                            "mintAuthority": None, "freezeAuthority": None
                        }}}
                    }
                }
                with patch.object(main, "require_solana_rpc_cluster"), patch.object(main, "rpc_call", return_value=account) as rpc:
                    result = main._balmz_reconcile_solana_supply(mint)
                self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
                self.assertEqual(result["reason"], "mint_supply_invalid")
                self.assertIsNone(result["observed_supply"])
                self.assertEqual(rpc.call_count, 1)

        account = {
            "context": {"slot": 777},
            "value": {
                "owner": main.SOLANA_SPL_TOKEN_PROGRAM_ID,
                "executable": False,
                "data": {"parsed": {"type": "mint", "info": {
                    "isInitialized": True, "decimals": 9, "supply": raw_supply,
                    "mintAuthority": None, "freezeAuthority": None
                }}}
            }
        }
        for invalid in ("00", "01", "+1", "-1", " 1", "1.0", "1e9"):
            with self.subTest(token_supply_amount=invalid):
                def fake_rpc(_url, method, _params):
                    if method == "getAccountInfo":
                        return account
                    if method == "getTokenSupply":
                        return {"context": {"slot": 777}, "value": {"amount": invalid, "decimals": 9}}
                    raise AssertionError(method)
                with patch.object(main, "require_solana_rpc_cluster"), patch.object(main, "rpc_call", side_effect=fake_rpc):
                    result = main._balmz_reconcile_solana_supply(mint)
                self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
                self.assertEqual(result["reason"], "mint_supply_rpc_mismatch")
                self.assertIsNone(result["observed_supply"])

    def test_devnet_mint_is_never_accepted_as_production(self):
        with patch.object(main, "rpc_call") as rpc:
            result = main._balmz_reconcile_solana_supply(main.BALMZ_SOLANA_DEVNET_MINT)
        self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
        self.assertEqual(result["reason"], "devnet_mint_rejected")
        rpc.assert_not_called()


    def test_admin_authorization_runs_before_any_chain_or_audit_operation(self):
        user = {"id": "not-admin", "email": "user@example.com"}
        with (
            patch.object(main, "require_world_wallet_admin", side_effect=PermissionError("admin_required")) as authorize,
            patch.object(main, "_balmz_reconcile_evm_supply") as evm,
            patch.object(main, "_balmz_reconcile_solana_supply") as solana,
            patch.object(main, "_balmz_reconcile_ethereum_reserve") as reserve,
            patch.object(main, "record_admin_event") as audit,
        ):
            with self.assertRaises(PermissionError):
                main.balmz_global_supply_reconciliation(user)
        authorize.assert_called_once_with(user)
        evm.assert_not_called()
        solana.assert_not_called()
        reserve.assert_not_called()
        audit.assert_not_called()

    def test_endpoint_cannot_claim_full_reconciliation_without_reserve_evidence(self):
        user = {"id": "owner", "email": "owner@example.com"}
        verified = {"network": "test", "status": "VERIFIED", "observed_supply": "10000000000", "allocation_matches": True}
        with (
            patch.object(main, "require_world_wallet_admin"),
            patch.object(main, "record_admin_event"),
            patch.object(main, "_balmz_reconcile_evm_supply", side_effect=[{**verified, "observed_supply": "11000000000"}, verified]),
            patch.object(main, "_balmz_reconcile_solana_supply", return_value=verified),
            patch.object(main, "_balmz_reconcile_ethereum_reserve", return_value={"status": "NOT_CONFIGURED", "read_only": True}),
        ):
            result = main.balmz_global_supply_reconciliation(user)
        self.assertEqual(result["status"], "PARTIAL_DEPLOYMENT")
        self.assertEqual(result["ethereum_reserve_evidence"]["status"], "NOT_CONFIGURED")
        self.assertFalse(result["presale_release_gate_changed"])

    def test_reserve_verifies_immutable_fields_and_remaining_balance(self):
        vesting = "0x" + "2" * 40
        token = "0x" + "1" * 40
        beneficiary = "0x" + "3" * 40
        allocation = main.BALMZ_ETH_RESERVE_ALLOCATION_RAW
        selectors = {}
        for sig in ("totalAllocation()", "released()", "balanceOf(address)"):
            digest = main.keccak.new(digest_bits=256); digest.update(sig.encode("ascii"))
            selectors[sig] = digest.hexdigest()[:8]
        block_tag = "0x2345"
        block_hash = "0x" + "b" * 64
        seen_tags = []
        def fake_rpc(_url, method, params):
            if method == "eth_getBlockByNumber":
                return {"number": block_tag, "hash": block_hash}
            if method == "eth_getCode":
                seen_tags.append(params[1])
                return "0x60016000"
            data = params[0]["data"]
            seen_tags.append(params[1])
            if data == "0x" + selectors["totalAllocation()"]: value = allocation
            elif data == "0x" + selectors["released()"]: value = allocation // 4
            elif data.startswith("0x" + selectors["balanceOf(address)"]): value = allocation * 3 // 4
            elif data == "0x" + main.keccak.new(digest_bits=256, data=b"token()").hexdigest()[:8]: value = int(token, 16)
            elif data == "0x" + main.keccak.new(digest_bits=256, data=b"beneficiary()").hexdigest()[:8]: value = int(beneficiary, 16)
            else: raise AssertionError(data)
            return "0x" + format(value, "064x")
        with patch.object(main, "valid_evm_address", return_value=True), patch.object(main, "evm_chain_id", return_value=1), patch.object(main, "rpc_call", side_effect=fake_rpc):
            result = main._balmz_reconcile_ethereum_reserve("https://rpc.example", token, vesting, beneficiary)
        self.assertEqual(result["status"], "VERIFIED")
        self.assertEqual(result["allocation_raw"], str(allocation))
        self.assertEqual(result["reserve_balance_raw"], str(allocation * 3 // 4))
        self.assertTrue(seen_tags)
        self.assertEqual(set(seen_tags), {block_tag})
        self.assertEqual(result["block_number"], str(int(block_tag, 16)))
        self.assertEqual(result["block_hash"], block_hash)
        self.assertEqual(result["commitment"], "finalized")

    def test_ethereum_reserve_requires_chain_id_one_before_contract_reads(self):
        with patch.object(main, "valid_evm_address", return_value=True), patch.object(main, "evm_chain_id", return_value=56) as chain_id, patch.object(main, "rpc_call") as rpc:
            result = main._balmz_reconcile_ethereum_reserve(
                "https://rpc.example", "0x" + "1" * 40, "0x" + "2" * 40, "0x" + "3" * 40
            )
        self.assertEqual(result["status"], "CONTRACT_INVALID")
        self.assertEqual(result["reason"], "wrong_chain_id")
        chain_id.assert_called_once_with("https://rpc.example")
        rpc.assert_not_called()

    def test_reserve_fails_closed_when_beneficiary_mismatches(self):
        with patch.object(main, "valid_evm_address", return_value=True), patch.object(main, "rpc_call", return_value="0x" + "0" * 64):
            result = main._balmz_reconcile_ethereum_reserve("https://rpc.example", "0x" + "1"*40, "0x" + "2"*40, "0x" + "3"*40)
        self.assertEqual(result["status"], "CONTRACT_INVALID")
        self.assertFalse(result["allocation_matches"])

    def test_reserve_requires_both_contract_and_beneficiary_configuration(self):
        result = main._balmz_reconcile_ethereum_reserve("https://rpc.example", "0x" + "1"*40, "", "")
        self.assertEqual(result["status"], "NOT_CONFIGURED")
        self.assertFalse(result["allocation_matches"])


    def test_evm_supply_rejects_wrong_chain_before_contract_reads(self):
        contract = "0x" + "1" * 40
        for network, expected_chain_id, observed_chain_id in (
            ("ethereum", 1, 56),
            ("bnb", 56, 1),
        ):
            with self.subTest(network=network):
                with (
                    patch.object(main, "evm_chain_id", return_value=observed_chain_id) as chain_id,
                    patch.object(main, "rpc_call") as rpc,
                ):
                    result = main._balmz_reconcile_evm_supply(
                        network, "https://rpc.example", contract, expected_chain_id, 10_000_000_000
                    )
                self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
                self.assertEqual(result["reason"], "wrong_chain_id")
                self.assertIsNone(result["observed_supply"])
                chain_id.assert_called_once_with("https://rpc.example")
                rpc.assert_not_called()

    def test_evm_bytecode_must_be_nonempty_complete_bytes(self):
        contract = "0x" + "1" * 40
        for invalid_code in ("0x", "0x0", "0x123", "0xgg"):
            with self.subTest(invalid_code=invalid_code):
                def fake_rpc(_url, method, _params):
                    if method == "eth_getBlockByNumber":
                        return {"number": "0x123", "hash": "0x" + "a" * 64}
                    if method == "eth_getCode":
                        return invalid_code
                    raise AssertionError("invalid bytecode must stop contract reads")
                with patch.object(main, "evm_chain_id", return_value=1), patch.object(main, "rpc_call", side_effect=fake_rpc):
                    result = main._balmz_reconcile_evm_supply("ethereum", "https://rpc.example", contract, 1, 11_000_000_000)
                self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
                self.assertEqual(result["reason"], "contract_bytecode_missing")
                self.assertIsNone(result["observed_supply"])

    def test_evm_valid_bytecode_requires_even_hex_byte_pairs(self):
        contract = "0x" + "1" * 40
        def fake_rpc(_url, method, _params):
            if method == "eth_getBlockByNumber":
                return {"number": "0x123", "hash": "0x" + "a" * 64}
            if method == "eth_getCode":
                return "0x60016000"
            if method == "eth_call":
                return "malformed ABI result"
            raise AssertionError(method)
        with patch.object(main, "evm_chain_id", return_value=1), patch.object(main, "rpc_call", side_effect=fake_rpc):
            result = main._balmz_reconcile_evm_supply("ethereum", "https://rpc.example", contract, 1, 11_000_000_000)
        self.assertEqual(result["status"], "CONTRACT_OR_MINT_INVALID")
        self.assertEqual(result["reason"], "rpc_or_metadata_verification_failed")
        self.assertIsNone(result["observed_supply"])


if __name__ == "__main__":
    unittest.main()
