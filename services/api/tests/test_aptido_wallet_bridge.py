import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class AptidoWalletBridgeTests(unittest.TestCase):
    def test_public_bridge_serves_binance_only_message_signing_flow(self):
        response = main.aptido_wallet_bridge()
        body = response.body.decode("utf-8")
        self.assertEqual(response.status_code, 200)
        self.assertIn("window.binancew3w.ethereum", body)
        self.assertIn("eth_requestAccounts", body)
        self.assertIn("personal_sign", body)
        self.assertIn("balmzaptido://wallet-connect/callback", body)
        self.assertNotIn("eth_sendTransaction", body)
        self.assertNotIn("wallet_addEthereumChain", body)
        self.assertEqual(response.headers.get("cache-control"), "no-store")
        self.assertEqual(response.headers.get("referrer-policy"), "no-referrer")


if __name__ == "__main__":
    unittest.main()
