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
        with patch.object(main, "ETHERSCAN_API_KEY", "server-side-test-key"), \\
             patch.object(main.httpx, "get", return_value=response) as fetch:
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
        with patch.object(main, "ETHERSCAN_API_KEY", "private-test-key"), \\
             patch.object(main.httpx, "get", return_value=response):
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
        with patch.object(main, "ETHERSCAN_API_KEY", "private-test-key"), \\
             patch.object(main.httpx, "get", return_value=response):
            result = main.etherscan_contract_source(1, "0x" + "a" * 40)
        self.assertFalse(result["source_verified"])

    def test_admin_probe_checks_ethereum_bnb_and_sepolia_without_exposing_key(self):
        response = FakeEtherscanResponse({"status": "1", "message": "OK", "result": "0"})
        user = {"id": "owner", "email": "owner@example.com"}
        with patch.object(main, "require_world_wallet_admin"), \\
             patch.object(main, "ETHERSCAN_API_KEY", "private-test-key"), \\
             patch.object(main, "record_admin_event"), \\
             patch.object(main, "etherscan_v2_request", return_value=response) as request:
            result = main.admin_test_etherscan_provider(user)
        self.assertTrue(result["success"])
        self.assertEqual([item["chain_id"] for item in result["results"]], [1, 56, 11155111])
        self.assertEqual(request.call_count, 3)
        self.assertNotIn("private-test-key", str(result))
        self.assertFalse(result["secrets_exposed"])


if __name__ == "__main__":
    unittest.main()
