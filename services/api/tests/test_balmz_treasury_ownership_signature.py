import base64
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def _base58_encode(raw: bytes) -> str:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    leading_zeroes = len(raw) - len(raw.lstrip(b"\\x00"))
    value = int.from_bytes(raw, "big")
    encoded = ""
    while value:
        value, digit = divmod(value, 58)
        encoded = alphabet[digit] + encoded
    return ("1" * leading_zeroes) + encoded


class BalmzTreasuryOwnershipSignatureTests(unittest.TestCase):
    def setUp(self):
        self.private_key = Ed25519PrivateKey.generate()
        public_key = self.private_key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        self.address = _base58_encode(public_key)
        self.message = (
            "World Wallet AI BALMZ-SOL treasury ownership proof\\n"
            "Network: Solana Mainnet\\n"
            f"Treasury: {self.address}\\n"
            "This message does not authorize a transaction."
        )
        self.signature = base64.b64encode(
            self.private_key.sign(self.message.encode("utf-8"))
        ).decode("ascii")

    def test_valid_signature_proves_exact_canonical_address_and_message(self):
        self.assertTrue(
            main._verify_balmz_treasury_ownership_signature(
                self.address, self.message, self.signature
            )
        )

    def test_signature_for_another_message_is_rejected(self):
        self.assertFalse(
            main._verify_balmz_treasury_ownership_signature(
                self.address, self.message + " altered", self.signature
            )
        )

    def test_noncanonical_or_invalid_public_key_encoding_is_rejected(self):
        self.assertFalse(
            main._verify_balmz_treasury_ownership_signature(
                "1" + self.address, self.message, self.signature
            )
        )
        self.assertFalse(
            main._verify_balmz_treasury_ownership_signature(
                "0" * 32, self.message, self.signature
            )
        )

    def test_malformed_signature_length_and_base64_are_rejected(self):
        self.assertFalse(
            main._verify_balmz_treasury_ownership_signature(
                self.address, self.message, "%%%not-base64%%%"
            )
        )
        short_signature = base64.b64encode(b"short").decode("ascii")
        self.assertFalse(
            main._verify_balmz_treasury_ownership_signature(
                self.address, self.message, short_signature
            )
        )


if __name__ == "__main__":
    unittest.main()
