import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class FakeEtherscanResponse:
    status_code = 200
    is_error = False

    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class EtherscanProviderTests(unittest.TestCase):
    def test_v2_request_uses_backend_key_and_chain_id(self):
        response = FakeEtherscanResponse({"status": "1", "message": "OK", "result": "0"})
        with patch.object(main, "ETHERSCAN_API_KEY", "server-side-test-key"):
            with patch.object(main.httpx, "get", return_value=response) as fetch:
                result = main.etherscan_v2_request(56, "account", "balance", {"address": "0x" + "0" * 40, "tag": "latest"})
        self.assertEqual(result["status"], "1")
        self.assertEqual(fetch.call_args.args[0], "https://api.etherscan.io/v2/api")
        params = fetch.call_args.kwargs["params"]
        self.assertEqual(params["chainid"], 56)
        self.assertEqual(params["module"], "account")
        self.assertEqual(params["action"], "balance")
        self.assertEqual(params["apikey"], "server-side-test-key")

    def test_v2_request_rejects_missing_key_and_unsupported_chain(self):
        with patch.object(main, "ETHERSCAN_API_KEY", ""):
            with self.assertRaises(main.HTTPException) as missing:
                main.etherscan_v2_request(1, "account", "balance")
            self.assertEqual(missing.exception.status_code, 503)
        with patch.object(main, "ETHERSCAN_API_KEY", "test-key"):
            with self.assertRaises(ValueError):
                main.etherscan_v2_request(999999, "account", "balance")

    def test_source_metadata_reports_verified_source_without_returning_source_or_key(self):
        response = FakeEtherscanResponse({
            "status": "1",
            "message": "OK",
            "result": [{
                "SourceCode": "contract Example {}",
                "ABI": "[]",
                "ContractName": "Example",
                "CompilerVersion": "v0.8.24+commit.e11b9ed9",
                "OptimizationUsed": "1",
                "Proxy": "0",
                "Implementation": "",
            }],
        })
        with patch.object(main, "ETHERSCAN_API_KEY", "private-test-key"):
            with patch.object(main.httpx, "get", return_value=response):
                result = main.etherscan_contract_source(1, "0x" + "a" * 40)
        self.assertTrue(result["source_verified"])
        self.assertEqual(result["contract_name"], "Example")
        self.assertNotIn("SourceCode", result)
        self.assertNotIn("private-test-key", str(result))

    def test_unverified_source_is_not_reported_as_verified(self):
        response = FakeEtherscanResponse({
            "status": "1",
            "message": "OK",
            "result": [{
                "SourceCode": "",
                "ABI": "Contract source code not verified",
                "ContractName": "",
            }],
        })
        with patch.object(main, "ETHERSCAN_API_KEY", "private-test-key"):
            with patch.object(main.httpx, "get", return_value=response):
                result = main.etherscan_contract_source(1, "0x" + "a" * 40)
        self.assertFalse(result["source_verified"])

    def test_admin_probe_checks_ethereum_bnb_sepolia_and_polygon_without_exposing_key(self):
        response = {"status": "1", "message": "OK", "result": "0"}
        user = {"id": "owner", "email": "owner@example.com"}
        with patch.object(main, "require_world_wallet_admin"):
            with patch.object(main, "ETHERSCAN_API_KEY", "private-test-key"):
                with patch.object(main, "record_admin_event"):
                    with patch.object(main, "etherscan_v2_request", return_value=response) as request:
                        result = main.admin_test_etherscan_provider(user)
        self.assertTrue(result["success"])
        self.assertEqual([item["chain_id"] for item in result["results"]], [1, 56, 11155111, 137])
        self.assertEqual(request.call_count, 4)
        self.assertNotIn("private-test-key", str(result))
        self.assertFalse(result["secrets_exposed"])

    def test_address_data_returns_read_only_native_and_activity_data_for_polygon(self):
        user = {"id": "user", "email": "user@example.com"}
        address = "0x" + "1" * 40
        def fake_request(chain_id, module, action, params=None):
            self.assertEqual(chain_id, 137)
            if action == "balance":
                return {"status": "1", "result": "1230000000000000000"}
            return {"status": "1", "result": [{"hash": action}]}
        request = main.EtherscanAddressDataRequest(address=address, network="polygon", page=1, offset=10)
        with patch.object(main, "ETHERSCAN_API_KEY", "private-test-key"):
            with patch.object(main, "etherscan_v2_request", side_effect=fake_request) as call:
                result = main.etherscan_address_data(request, user)
        self.assertEqual(result["native_asset"], "POL")
        self.assertEqual(result["native_balance_base_units"], "1230000000000000000")
        self.assertEqual(result["transactions"], [{"hash": "txlist"}])
        self.assertEqual(result["token_transfers"], [{"hash": "tokentx"}])
        self.assertEqual(result["internal_transactions"], [{"hash": "txlistinternal"}])
        self.assertEqual(call.call_count, 4)
        self.assertTrue(result["read_only"])
        self.assertFalse(result["secrets_exposed"])
        self.assertNotIn("private-test-key", str(result))

    def test_address_data_normalizes_empty_history_responses_for_all_activity_types(self):
        user = {"id": "user"}
        address = "0x" + "1" * 40
        empty_messages = {
            "txlist": "No transactions found",
            "tokentx": "No records found",
            "txlistinternal": "No logs found",
        }
        def fake_request(chain_id, module, action, params=None):
            if action == "balance":
                return {"status": "1", "result": "0"}
            return {"status": "0", "message": "No transactions", "result": empty_messages[action]}
        request = main.EtherscanAddressDataRequest(address=address, network="ethereum")
        with patch.object(main, "ETHERSCAN_API_KEY", "private-test-key"):
            with patch.object(main, "etherscan_v2_request", side_effect=fake_request):
                result = main.etherscan_address_data(request, user)
        self.assertEqual(result["transactions"], [])
        self.assertEqual(result["token_transfers"], [])
        self.assertEqual(result["internal_transactions"], [])

    def test_address_data_rejects_malformed_activity_payload(self):
        user = {"id": "user"}
        address = "0x" + "1" * 40
        def fake_request(chain_id, module, action, params=None):
            if action == "balance":
                return {"status": "1", "result": "0"}
            return {"status": "1", "message": "OK", "result": {"unexpected": "object"}}
        request = main.EtherscanAddressDataRequest(address=address, network="ethereum")
        with patch.object(main, "ETHERSCAN_API_KEY", "private-test-key"):
            with patch.object(main, "etherscan_v2_request", side_effect=fake_request):
                with self.assertRaises(main.HTTPException) as error:
                    main.etherscan_address_data(request, user)
        self.assertEqual(error.exception.status_code, 502)

    def test_address_data_rejects_unsupported_network(self):
        request = main.EtherscanAddressDataRequest(address="0x" + "1" * 40, network="sepolia")
        with patch.object(main, "ETHERSCAN_API_KEY", "private-test-key"):
            with self.assertRaises(main.HTTPException) as error:
                main.etherscan_address_data(request, {"id": "user"})
        self.assertEqual(error.exception.status_code, 400)

    def test_admin_settings_reports_only_etherscan_key_presence(self):
        user = {"id": "owner", "email": "owner@example.com"}
        with patch.object(main, "require_world_wallet_admin"):
            with patch.object(main, "ETHERSCAN_API_KEY", "private-test-key"):
                with patch.object(main, "record_admin_event"):
                    result = main.admin_settings(user)
        checks = {item["key"]: item["configured"] for item in result["checks"]}
        self.assertTrue(checks["Etherscan API V2 key"])
        self.assertNotIn("private-test-key", str(result))
        self.assertFalse(result["secrets_exposed"])


if __name__ == "__main__":
    unittest.main()
