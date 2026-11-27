import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class SolanaMainnetRpcUrlValidationTests(unittest.TestCase):
    def test_accepts_https_endpoint_with_valid_optional_port(self):
        parsed = main._balmz_require_secure_solana_mainnet_rpc_url(
            "https://rpc.example:8443/solana"
        )
        self.assertEqual(parsed.hostname, "rpc.example")
        self.assertEqual(parsed.port, 8443)

    def test_rejects_non_https_or_missing_host(self):
        for url in ("http://rpc.example", "https:///missing-host", "rpc.example"):
            with self.subTest(url=url):
                with self.assertRaisesRegex(ValueError, "solana_mainnet_rpc_url_invalid"):
                    main._balmz_require_secure_solana_mainnet_rpc_url(url)

    def test_rejects_embedded_credentials_and_fragments(self):
        for url in (
            "https://user@rpc.example/path",
            "https://user:password@rpc.example/path",
            "https://rpc.example/path#fragment",
        ):
            with self.subTest(url=url):
                with self.assertRaisesRegex(ValueError, "solana_mainnet_rpc_url_invalid"):
                    main._balmz_require_secure_solana_mainnet_rpc_url(url)

    def test_rejects_malformed_and_out_of_range_ports(self):
        for url in ("https://rpc.example:not-a-port", "https://rpc.example:65536"):
            with self.subTest(url=url):
                with self.assertRaisesRegex(ValueError, "solana_mainnet_rpc_url_invalid"):
                    main._balmz_require_secure_solana_mainnet_rpc_url(url)

    def test_mainnet_cluster_check_rejects_invalid_endpoint_before_rpc(self):
        with patch.object(main, "rpc_call") as rpc:
            with self.assertRaisesRegex(ValueError, "solana_mainnet_rpc_url_invalid"):
                main.require_solana_rpc_cluster(
                    "https://user:secret@rpc.example", main.SOLANA_MAINNET_GENESIS_HASH,
                    "Solana Mainnet",
                )
            rpc.assert_not_called()

    def test_secondary_corroboration_rejects_invalid_endpoint_before_rpc(self):
        with patch.object(main, "rpc_call") as rpc:
            result = main._balmz_solana_independent_rpc_corroboration(
                "https://primary.example", "https://rpc.example:70000", "11111111111111111111111111111111",
                100, "1", 9, main.SOLANA_SPL_TOKEN_PROGRAM_ID, None, None,
            )
            self.assertEqual(result, {
                "status": "FAILED", "reason": "solana_mainnet_rpc_url_invalid"
            })
            rpc.assert_not_called()


if __name__ == "__main__":
    unittest.main()
