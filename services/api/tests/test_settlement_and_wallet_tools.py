import os
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class SettlementAndWalletToolTests(unittest.TestCase):
    def test_wallet_sync_route_is_registered_on_sync_handler_only(self):
        sync_routes = [
            route for route in main.app.routes
            if getattr(route, "path", None) == "/api/v1/wallet/sync"
            and "POST" in (getattr(route, "methods", set()) or set())
        ]
        self.assertEqual(len(sync_routes), 1)
        self.assertIs(sync_routes[0].endpoint, main.sync_wallet)
        self.assertNotIn(main._chain_heights, [route.endpoint for route in main.app.routes])
        self.assertNotIn(main.wallet_asset_symbol, [route.endpoint for route in main.app.routes])

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

    def test_ethereum_mainnet_rpc_requires_chain_id_one(self):
        with patch.object(main, "evm_chain_id", return_value=1):
            self.assertEqual(main.require_ethereum_mainnet_rpc("https://rpc.example"), 1)
        with patch.object(main, "evm_chain_id", return_value=11155111):
            with self.assertRaisesRegex(ValueError, "mainnet chain ID 1"):
                main.require_ethereum_mainnet_rpc("https://rpc.example")

    def test_ethereum_rpc_falls_back_when_primary_provider_fails(self):
        class Response:
            def raise_for_status(self):
                return None
            def json(self):
                return {"jsonrpc": "2.0", "id": 1, "result": "0x1"}

        with patch.object(main, "ETH_RPC_URL", "https://primary.example"), \
             patch.object(main, "ETH_PUBLIC_RPC_URL", "https://ethereum-rpc.publicnode.com"), \
             patch.object(main.httpx, "post", side_effect=[main.httpx.ConnectError("offline"), Response()]) as post:
            self.assertEqual(main.rpc_call(main.ETH_RPC_URL, "eth_chainId", []), "0x1")
            self.assertEqual(post.call_count, 2)
            self.assertEqual(post.call_args_list[1].args[0], "https://ethereum-rpc.publicnode.com")

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

    def test_normalize_wallet_network_never_aliases_solana_to_devnet_or_generic_mainnet_to_ethereum(self):
        self.assertEqual(main.normalize_wallet_network("solana"), "solana_mainnet")
        self.assertEqual(main.normalize_wallet_network("solana-mainnet"), "solana_mainnet")
        self.assertEqual(main.normalize_wallet_network("mainnet-beta"), "solana_mainnet")
        self.assertEqual(main.normalize_wallet_network("solana-devnet"), "solana_devnet")
        self.assertEqual(main.normalize_wallet_network("mainnet"), "mainnet")
        self.assertEqual(main.normalize_wallet_network("Ethereum Mainnet"), "ethereum")

    def test_solana_rpc_cluster_guard_rejects_devnet_for_production(self):
        with patch.object(main, "rpc_call", return_value=main.SOLANA_MAINNET_GENESIS_HASH):
            main.require_solana_rpc_cluster(
                "https://rpc.example", main.SOLANA_MAINNET_GENESIS_HASH, "Solana Mainnet"
            )
        with patch.object(main, "rpc_call", return_value=main.SOLANA_DEVNET_GENESIS_HASH):
            with self.assertRaisesRegex(ValueError, "unexpected Solana cluster genesis hash"):
                main.require_solana_rpc_cluster(
                    "https://rpc.example", main.SOLANA_MAINNET_GENESIS_HASH, "Solana Mainnet"
                )

    def test_solana_mainnet_reserves_use_mainnet_rpc_and_are_not_testnet_evidence(self):
        address = "7FNyayYwgfrGb3mCsRttuJUkFQgsgDtrYBhhddKS6iVN"

        def fake_rpc(_url, method, _params):
            if method == "getGenesisHash":
                return main.SOLANA_MAINNET_GENESIS_HASH
            if method == "getBalance":
                return {"value": 2_000_000_000}
            if method == "getSlot":
                return 987654
            raise AssertionError("Unexpected RPC method: " + method)

        with (
            patch.object(main, "configured_addresses", return_value=[
                {"network": "solana_mainnet", "address": address, "label": "mainnet wallet"},
            ]),
            patch.object(main, "rpc_call", side_effect=fake_rpc),
        ):
            result = main.wallet_proof_of_reserves({"wallet_id": "wallet_test"})

        self.assertEqual(result["reserves"][0]["network"], "solana_mainnet")
        self.assertEqual(result["reserves"][0]["asset"], "SOL")
        self.assertEqual(result["reserves"][0]["balance"], 2.0)
        self.assertEqual(result["reserves"][0]["block_number"], 987654)
        self.assertEqual(result["testnet_assets"], [])
        self.assertEqual(result["token_supplies"], [])

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
        with patch.object(main, "configured_addresses", return_value=[
            {"network": "sepolia", "address": wallet, "label": "testnet"}
        ]), patch.object(main, "rpc_call", side_effect=fake_rpc):
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


    def test_evm_sync_rejects_address_not_saved_to_active_wallet(self):
        user = {"wallet_id": "wallet_test"}
        foreign_address = "0x" + "3" * 40
        with patch.object(main, "configured_addresses", return_value=[
            {"network": "ethereum", "address": "0x" + "1" * 40, "label": "primary"}
        ]), patch.object(main, "rpc_call") as rpc:
            imported, warning = main.sync_evm_native_transactions(
                user, "https://rpc.example", "ethereum", wallet_address=foreign_address
            )
        self.assertEqual(imported, [])
        self.assertIn("not saved to the active wallet", warning)
        rpc.assert_not_called()

    def test_evm_sync_does_not_accept_address_from_another_network(self):
        user = {"wallet_id": "wallet_test"}
        address = "0x" + "1" * 40
        with patch.object(main, "configured_addresses", return_value=[
            {"network": "sepolia", "address": address, "label": "testnet"}
        ]), patch.object(main, "rpc_call") as rpc:
            imported, warning = main.sync_evm_native_transactions(
                user, "https://rpc.example", "ethereum", wallet_address=address
            )
        self.assertEqual(imported, [])
        self.assertIn("not saved to the active wallet", warning)
        rpc.assert_not_called()

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
        with patch.object(main, "_sync_wallet_impl", return_value={"updates": [], "warnings": []}), \
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
        with patch.object(main, "_sync_wallet_impl", return_value={"updates": [], "warnings": []}), \
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
        with patch.object(main, "db", return_value=fake_conn):
            with patch.object(main, "EVM_WALLET_ADDRESS", "0x" + "2" * 40):
                with patch.object(main, "BTC_ADDRESS", "bc1q" + "a" * 38):
                    result = main.configured_addresses({"wallet_id": "wallet_test"})
        self.assertEqual(result, [{"network": "sepolia", "address": saved[0][1], "label": "Sepolia testnet"}])
        self.assertEqual(len(fake_conn.calls), 1)
        self.assertNotIn("INSERT", fake_conn.calls[0][0].upper())


    def test_signing_config_is_external_signer_and_never_exposes_secret_material(self):
        user = {"id": "user_test", "wallet_id": "wallet_test"}
        with patch.object(main, "wallet_network_address", side_effect=lambda _user, network: {
            "ethereum": "0x" + "1" * 40,
            "bnb": "0x" + "2" * 40,
            "bitcoin": None,
        }.get(network)), \
             patch.object(main, "ETH_RPC_URL", ""), \
             patch.object(main, "BSC_RPC_URL", ""), \
             patch.object(main, "USDT_ETH_CONTRACT", ""), \
             patch.object(main, "USDT_BSC_CONTRACT", ""), \
             patch.object(main, "BALMZ_ETH_CONTRACT", ""):
            result = main.wallet_signing_config(user)

        self.assertEqual(result["mode"], "external_signer")
        self.assertEqual(result["broadcast_policy"], "user_signed_only")
        self.assertEqual(result["networks"]["ethereum"]["wallet_address"], None)
        self.assertEqual(result["networks"]["bnb"]["wallet_address"], None)
        serialized = str(result).lower()
        for forbidden in ("private_key", "privatekey", "seed_phrase", "mnemonic", "secret_key"):
            self.assertNotIn(forbidden, serialized)

    def test_transfer_and_withdrawal_routes_do_not_claim_to_broadcast(self):
        transfer_route = next(
            route for route in main.app.routes
            if getattr(route, "path", None) == "/api/v1/transfers"
            and "POST" in (getattr(route, "methods", set()) or set())
        )
        withdrawal_route = next(
            route for route in main.app.routes
            if getattr(route, "path", None) == "/api/v1/withdrawals"
            and "POST" in (getattr(route, "methods", set()) or set())
        )
        self.assertIs(transfer_route.endpoint, main.transfer)
        self.assertIs(withdrawal_route.endpoint, main.withdrawal)


    def test_signing_config_keeps_sepolia_separate_with_correct_chain_id(self):
        user = {"id": "user_test", "wallet_id": "wallet_test"}
        sepolia_address = "0x" + "1" * 40
        sepolia_contract = "0x" + "2" * 40
        with patch.object(main, "wallet_network_address", side_effect=lambda _user, network: {
            "ethereum": "0x" + "3" * 40,
            "bnb": "0x" + "4" * 40,
            "bitcoin": None,
            "sepolia": sepolia_address,
        }.get(network)), \
             patch.object(main, "ETH_RPC_URL", ""), \
             patch.object(main, "BSC_RPC_URL", ""), \
             patch.object(main, "SEPOLIA_RPC_URL", "https://sepolia.example"), \
             patch.object(main, "BALMZ_SEPOLIA_CONTRACT", sepolia_contract), \
             patch.object(main, "USDT_ETH_CONTRACT", ""), \
             patch.object(main, "USDT_BSC_CONTRACT", ""), \
             patch.object(main, "BALMZ_ETH_CONTRACT", ""):
            result = main.wallet_signing_config(user)

        sepolia = result["networks"]["sepolia"]
        self.assertEqual(sepolia["chain_id"], "0xaa36a7")
        self.assertEqual(sepolia["wallet_address"], sepolia_address)
        self.assertEqual(sepolia["balmz_contract"], sepolia_contract)
        self.assertEqual(sepolia["balmz_decimals"], 18)
        self.assertEqual(sepolia["network_type"], "testnet")
        self.assertEqual(result["networks"]["ethereum"]["chain_id"], "0x1")
        self.assertEqual(result["networks"]["bnb"]["chain_id"], "0x38")


    def test_wallet_sync_does_not_timestamp_transaction_history_with_warnings(self):
        user = {"id": "user_test", "wallet_id": "wallet_test"}
        sepolia_address = "0x" + "1" * 40
        with patch.object(main, "db") as mocked_db, \
             patch.object(main, "wallet_network_address", side_effect=lambda _user, network: sepolia_address if network == "sepolia" else None), \
             patch.object(main, "SEPOLIA_RPC_URL", "https://sepolia.example"), \
             patch.object(main, "BALMZ_SEPOLIA_CONTRACT", ""), \
             patch.object(main, "ETH_RPC_URL", ""), \
             patch.object(main, "BSC_RPC_URL", ""), \
             patch.object(main, "sync_bitcoin_transactions", return_value=[]), \
             patch.object(main, "sync_evm_native_transactions", return_value=([], "Sepolia RPC unavailable")), \
             patch.object(main, "wallet_snapshot", return_value=([], [], {})), \
             patch.object(main, "_network_sync_status", return_value={}):
            conn = mocked_db.return_value.__enter__.return_value
            conn.execute.return_value.fetchall.return_value = []
            result = main.sync_wallet(user)

        self.assertEqual(result["status"], "synced_with_warnings")
        self.assertIn("Sepolia RPC unavailable", result["warnings"])
        self.assertIsNone(result["last_transaction_sync_at"])


    def test_system_status_uses_active_wallet_and_does_not_claim_api_broadcast(self):
        user = {"id": "user_test", "wallet_id": "wallet_test"}
        with patch.object(main, "wallet_network_address", side_effect=lambda _user, network: {
            "bitcoin": None,
            "ethereum": None,
            "bnb": "0x" + "1" * 40,
            "sepolia": "0x" + "2" * 40,
        }.get(network)), \
             patch.object(main, "DATABASE_URL", "postgresql://configured"), \
             patch.object(main, "NEON_JWKS_CLIENT", object()), \
             patch.object(main, "BTC_ADDRESS", "bc1q" + "a" * 38), \
             patch.object(main, "EVM_WALLET_ADDRESS", "0x" + "3" * 40), \
             patch.object(main, "ETH_RPC_URL", "https://eth.example"), \
             patch.object(main, "BSC_RPC_URL", "https://bnb.example"), \
             patch.object(main, "SEPOLIA_RPC_URL", "https://sepolia.example"), \
             patch.object(main, "COINGECKO_API_BASE_URL", "https://api.coingecko.com/api/v3"):
            result = main.system_status(user)

        self.assertFalse(result["bitcoin"])
        self.assertFalse(result["ethereum"])
        self.assertTrue(result["bnb"])
        self.assertTrue(result["sepolia"])
        self.assertFalse(result["transaction_broadcast"])
        self.assertEqual(result["transaction_broadcast_mode"], "external_wallet_signed_by_client")


    def test_custom_cors_origins_keep_production_frontend_allowed(self):
        origins = main._build_trusted_origins("https://admin.example")
        self.assertIn("https://admin.example", origins)
        self.assertIn("https://world-wallet-ai-frontend.onrender.com", origins)

    def test_neon_auth_repairs_existing_user_without_wallet(self):
        fake_key = type("FakeSigningKey", (), {"key": object(), "algorithm_name": "RS256"})()
        healed_user = {"id": "user-1", "email": "user@example.com", "wallet_id": "wallet-repaired"}
        with (
            patch.object(main, "NEON_JWKS_CLIENT") as jwks,
            patch.object(main, "NEON_AUTH_BASE_URL", ""),
            patch.object(main.jwt, "get_unverified_header", return_value={"alg": "RS256", "kid": "test-key"}),
            patch.object(main.jwt, "decode", return_value={
                "sub": "subject-1", "email": "user@example.com", "name": "Wallet Owner", "exp": 9999999999
            }),
            patch.object(main, "get_user", return_value={"id": "user-1", "email": "user@example.com", "wallet_id": None}),
            patch.object(main, "provision_identity", return_value=healed_user) as provision,
        ):
            jwks.get_signing_key_from_jwt.return_value = fake_key
            result = main.neon_auth_user("test.jwt")

        provision.assert_called_once_with("user@example.com", name="Wallet Owner", google_subject="subject-1")
        self.assertEqual(result["wallet_id"], "wallet-repaired")

    def test_neon_jwt_decode_requires_expiry_subject_and_email(self):
        fake_key = type("FakeSigningKey", (), {"key": object(), "algorithm_name": "RS256"})()
        with patch.object(main, "NEON_JWKS_CLIENT") as jwks, \
             patch.object(main.jwt, "get_unverified_header", return_value={"alg": "RS256", "kid": "test-key"}), \
             patch.object(main.jwt, "decode", return_value={"sub": "subject-1", "email": "user@example.com", "exp": 9999999999}) as decode, \
             patch.object(main, "get_user", return_value={"id": "user-1", "email": "user@example.com", "wallet_id": "wallet-1"}):
            jwks.get_signing_key_from_jwt.return_value = fake_key
            with patch.object(main, "db") as mocked_db:
                mocked_db.return_value.__enter__.return_value.execute.return_value = None
                main.neon_auth_user("test.jwt")

        self.assertEqual(decode.call_args.kwargs["options"]["require"], ["exp", "sub", "email"])

    def test_solana_devnet_proof_includes_wallet_holdings_and_live_mint_supply(self):
        address = "7FNyayYwgfrGb3mCsRttuJUkFQgsgDtrYBhhddKS6iVN"
        mint = main.BALMZ_SOLANA_DEVNET_MINT

        def fake_rpc(_url, method, _params):
            if method == "getGenesisHash":
                return main.SOLANA_DEVNET_GENESIS_HASH
            if method == "getBalance":
                return {"value": 5_000_000_000}
            if method == "getTokenSupply":
                return {"value": {
                    "amount": "1000000000000000000",
                    "decimals": 9,
                    "uiAmountString": "1000000000",
                }}
            raise AssertionError("Unexpected RPC method: " + method)

        with (
            patch.object(main, "configured_addresses", return_value=[
                {"network": "solana_devnet", "address": address, "label": "BALMZ wallet"},
            ]),
            patch.object(main, "rpc_call", side_effect=fake_rpc),
            patch.object(main, "solana_spl_token_balance", return_value=321.5),
        ):
            result = main.wallet_proof_of_reserves({"wallet_id": "wallet_test"})

        self.assertEqual(result["reserves"], [])
        self.assertEqual(result["testnet_assets"][0]["asset"], "SOL-DEVNET")
        balmz = next(item for item in result["testnet_assets"] if item["asset"] == "BALMZ-SOL-DEVNET")
        self.assertEqual(balmz["balance"], 321.5)
        supply = result["token_supplies"][0]
        self.assertEqual(supply["mint_address"], mint)
        self.assertEqual(supply["total_supply"], 1_000_000_000)
        self.assertEqual(supply["raw_amount"], "1000000000000000000")
        self.assertFalse(result["audited"])
        self.assertFalse(result["liabilities_included"])

if __name__ == "__main__":
    unittest.main()

    def test_sepolia_native_sync_stops_before_block_reads_on_wrong_chain(self):
        wallet = "0x" + "1" * 40
        calls = []

        def fake_rpc(_url, method, _params):
            calls.append(method)
            if method == "eth_chainId":
                return hex(1)
            raise AssertionError("Sepolia blocks must not be queried on the wrong chain")

        user = {"wallet_id": "wallet_test"}
        with patch.object(main, "rpc_call", side_effect=fake_rpc):
            imported, warning = main.sync_evm_native_transactions(
                user, "https://rpc.example", "sepolia", wallet_address=wallet,
            )
        self.assertEqual(imported, [])
        self.assertIn("transaction service unavailable", warning)
        self.assertEqual(calls, ["eth_chainId"])


class WalletValuationSummaryTests(unittest.TestCase):
    def test_partial_valuation_preserves_known_values_and_names_unpriced_assets(self):
        assets = [
            {
                "symbol": "ETH", "balance": 1.5, "actual_balance": 1.5,
                "reserved_balance": 0, "price_usd": 2000, "price_available": True,
                "value_usd": 3000, "actual_value_usd": 3000,
            },
            {
                "symbol": "BALMZ", "balance": 10, "actual_balance": 10,
                "reserved_balance": 0, "price_usd": 0, "price_available": False,
                "value_usd": None, "actual_value_usd": None,
            },
        ]
        transactions = [
            {"type": "received", "asset": "ETH", "amount": 1.0},
            {"type": "received", "asset": "BALMZ", "amount": 2.0},
            {"type": "sent", "asset": "ETH", "amount": 0.25},
            {"type": "withdrawal", "asset": "BALMZ", "amount": 1.0},
        ]

        summary = main.wallet_valuation_summary(assets, transactions)

        self.assertFalse(summary["valuation_complete"])
        self.assertIsNone(summary["available_balance_usd"])
        self.assertEqual(summary["partial_available_balance_usd"], 3000)
        self.assertEqual(summary["unpriced_assets"], ["BALMZ"])
        self.assertEqual(summary["partial_total_received_usd"], 2000)
        self.assertIsNone(summary["total_received_usd"])
        self.assertEqual(summary["unpriced_received_assets"], ["BALMZ"])
        self.assertEqual(summary["received_transaction_count"], 2)
        self.assertEqual(summary["partial_total_sent_usd"], 500)
        self.assertIsNone(summary["total_sent_usd"])
        self.assertEqual(summary["unpriced_sent_assets"], ["BALMZ"])
        self.assertEqual(summary["sent_transaction_count"], 2)
        self.assertTrue(summary["reserved_valuation_complete"])
        self.assertEqual(summary["reserved_balance_usd"], 0)
        self.assertEqual(summary["valuation_basis"], "current_verified_market_quotes")

    def test_empty_wallet_returns_real_zero_when_nothing_is_unpriced(self):
        summary = main.wallet_valuation_summary([], [])

        self.assertTrue(summary["valuation_complete"])
        self.assertEqual(summary["available_balance_usd"], 0)
        self.assertEqual(summary["partial_available_balance_usd"], 0)
        self.assertEqual(summary["total_received_usd"], 0)
        self.assertEqual(summary["received_transaction_count"], 0)
        self.assertEqual(summary["total_sent_usd"], 0)
        self.assertEqual(summary["sent_transaction_count"], 0)
