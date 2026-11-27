import unittest
from unittest.mock import patch

try:
    from services.api import main
except ModuleNotFoundError:
    import main


class EvmSecondaryRpcUrlSecurityTests(unittest.TestCase):
    CONTRACT = "0x" + "1" * 40
    PRIMARY_ARGS = (
        "0x1234",
        "0x" + "a" * 64,
        "0x60016000",
        11_000_000_000 * (10 ** 18),
        18,
        "BALMZ Token",
        "BALMZ",
    )

    def test_rejects_non_https_secondary_endpoint_before_rpc(self):
        for url in (
            "http://secondary.example",
            "https://user:secret@secondary.example",
            "https://secondary.example/path#fragment",
            "https://secondary.example:99999",
        ):
            with self.subTest(url=url):
                with patch.object(main, "evm_chain_id") as chain_id, patch.object(
                    main, "rpc_call"
                ) as rpc:
                    result = main._balmz_evm_independent_rpc_corroboration(
                        "https://primary.example",
                        url,
                        self.CONTRACT,
                        1,
                        *self.PRIMARY_ARGS,
                    )
                self.assertEqual(
                    result,
                    {"status": "FAILED", "reason": "insecure_mainnet_rpc_url"},
                )
                chain_id.assert_not_called()
                rpc.assert_not_called()

    def test_accepts_secure_secondary_url_for_chain_verification(self):
        block_tag, block_hash, code, raw_supply, decimals, name, symbol = self.PRIMARY_ARGS

        def fake_rpc(url, method, params):
            if method == "eth_getBlockByNumber":
                return {"number": block_tag, "hash": block_hash}
            if method == "eth_getCode":
                return code
            selector = params[0]["data"]
            if selector == "0x06fdde03":
                return _abi_string("BALMZ Token")
            if selector == "0x95d89b41":
                return _abi_string("BALMZ")
            if selector == "0x18160ddd":
                return "0x" + format(raw_supply, "064x")
            if selector == "0x313ce567":
                return "0x" + format(decimals, "064x")
            raise AssertionError((url, method, params))

        with patch.object(main, "evm_chain_id", return_value=1), patch.object(
            main, "rpc_call", side_effect=fake_rpc
        ):
            result = main._balmz_evm_independent_rpc_corroboration(
                "https://primary.example",
                "https://secondary.example",
                self.CONTRACT,
                1,
                *self.PRIMARY_ARGS,
            )
        self.assertEqual(result["status"], "VERIFIED")
        self.assertEqual(result["provider_host"], "secondary.example")


if __name__ == "__main__":
    unittest.main()
