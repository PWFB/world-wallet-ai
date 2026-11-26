import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from balmz_presale_settlement import verify_solana_mainnet_sol_payment


SENDER = "7FNyayYwgfrGb3mCsRttuJUkFQgsgDtrYBhhddKS6iVN"
RECIPIENT = "Vote111111111111111111111111111111111111111"
SIGNATURE = "5" * 64
EXPECTED = 250_000_000


def transaction():
    return {
        "slot": 987654,
        "transaction": {"signatures": [SIGNATURE], "message": {
            "accountKeys": [
                {"pubkey": SENDER, "signer": True},
                {"pubkey": RECIPIENT, "signer": False},
            ],
            "instructions": [{
                "program": "system",
                "parsed": {"type": "transfer", "info": {
                    "source": SENDER, "destination": RECIPIENT, "lamports": EXPECTED
                }},
            }],
        }},
        "meta": {"err": None, "innerInstructions": []},
    }


class BalmzSolanaMainnetPaymentVerificationTests(unittest.TestCase):
    def verify(self, tx=None, expected=EXPECTED, rpc_side_effect=None):
        if rpc_side_effect is None:
            rpc_side_effect = [
                main.SOLANA_MAINNET_GENESIS_HASH,
                tx if tx is not None else transaction(),
            ]
        with patch.object(main, "rpc_call", side_effect=rpc_side_effect) as rpc:
            result = verify_solana_mainnet_sol_payment(
                SIGNATURE, SENDER, RECIPIENT, expected, main.rpc_call,
                expected_genesis_hash=main.SOLANA_MAINNET_GENESIS_HASH,
                rpc_url="https://solana-mainnet.example",
                valid_address=main.valid_solana_address,
            )
        return result, rpc

    def test_exact_finalized_mainnet_sol_transfer_is_confirmed(self):
        result, rpc = self.verify()
        self.assertEqual(result["state"], "confirmed")
        self.assertEqual(result["finality"], "finalized")
        self.assertEqual(result["paid_lamports"], EXPECTED)
        self.assertEqual(rpc.call_args_list[1].args[1], "getTransaction")
        self.assertEqual(rpc.call_args_list[1].args[2][1]["commitment"], "finalized")

    def test_rpc_response_must_contain_the_requested_signature(self):
        tx = transaction()
        tx["transaction"]["signatures"] = ["4" * 64]
        with self.assertRaises(main.HTTPException) as caught:
            self.verify(tx)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn("signature does not match", caught.exception.detail)

    def test_boolean_slot_is_rejected_as_malformed_metadata(self):
        tx = transaction()
        tx["slot"] = True
        with self.assertRaises(main.HTTPException) as caught:
            self.verify(tx)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn("transaction metadata", caught.exception.detail)

    def test_negative_slot_is_rejected_as_malformed_metadata(self):
        tx = transaction()
        tx["slot"] = -1
        with self.assertRaises(main.HTTPException) as caught:
            self.verify(tx)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn("transaction metadata", caught.exception.detail)

    def test_multiple_matching_transfers_are_rejected(self):
        tx = transaction()
        second = {
            "program": "system",
            "parsed": {"type": "transfer", "info": {
                "source": SENDER, "destination": RECIPIENT, "lamports": 1
            }},
        }
        tx["transaction"]["message"]["instructions"].append(second)
        with self.assertRaisesRegex(ValueError, "exactly one matching SOL transfer"):
            self.verify(tx)

    def test_wrong_cluster_fails_closed_before_transaction_lookup(self):
        with patch.object(main, "rpc_call", return_value=main.SOLANA_DEVNET_GENESIS_HASH) as rpc:
            with self.assertRaises(main.HTTPException) as caught:
                verify_solana_mainnet_sol_payment(
                    SIGNATURE, SENDER, RECIPIENT, EXPECTED, main.rpc_call,
                    expected_genesis_hash=main.SOLANA_MAINNET_GENESIS_HASH,
                    rpc_url="https://wrong-cluster.example",
                    valid_address=main.valid_solana_address,
                )
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(rpc.call_count, 1)

    def test_wrong_sender_is_rejected(self):
        tx = transaction()
        tx["transaction"]["message"]["instructions"][0]["parsed"]["info"]["source"] = RECIPIENT
        with self.assertRaisesRegex(ValueError, "exact expected SOL payment"):
            self.verify(tx)

    def test_wrong_recipient_is_rejected(self):
        tx = transaction()
        tx["transaction"]["message"]["instructions"][0]["parsed"]["info"]["destination"] = SENDER
        with self.assertRaisesRegex(ValueError, "exact expected SOL payment"):
            self.verify(tx)

    def test_underpayment_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "exact expected SOL payment"):
            self.verify(expected=EXPECTED + 1)

    def test_non_signing_sender_is_rejected(self):
        tx = transaction()
        tx["transaction"]["message"]["accountKeys"][0]["signer"] = False
        with self.assertRaisesRegex(ValueError, "did not sign"):
            self.verify(tx)

    def test_failed_transaction_is_rejected(self):
        tx = transaction()
        tx["meta"]["err"] = {"InstructionError": [0, "Custom"]}
        with self.assertRaisesRegex(ValueError, "failed on-chain"):
            self.verify(tx)

    def test_pending_signature_is_not_settled(self):
        result, _ = self.verify(
            tx=None,
            rpc_side_effect=[
                main.SOLANA_MAINNET_GENESIS_HASH,
                None,
                {"value": [{"err": None, "confirmationStatus": "confirmed", "slot": 99}]},
            ],
        )
        self.assertEqual(result["state"], "pending")
        self.assertNotEqual(result["finality"], "finalized")

    def test_unknown_signature_is_not_found(self):
        result, _ = self.verify(
            tx=None,
            rpc_side_effect=[main.SOLANA_MAINNET_GENESIS_HASH, None, {"value": [None]}],
        )
        self.assertEqual(result["state"], "not_found")

    def test_malformed_pending_signature_status_metadata_fails_closed(self):
        malformed_statuses = [
            {"err": None, "confirmationStatus": "confirmed", "slot": True},
            {"err": None, "confirmationStatus": "confirmed", "slot": -1},
            {"err": None, "confirmationStatus": "unknown", "slot": 99},
            {"err": None, "confirmationStatus": "confirmed"},
        ]
        for status in malformed_statuses:
            with self.subTest(status=status):
                with self.assertRaises(main.HTTPException) as caught:
                    self.verify(
                        tx=None,
                        rpc_side_effect=[
                            main.SOLANA_MAINNET_GENESIS_HASH,
                            None,
                            {"value": [status]},
                        ],
                    )
                self.assertEqual(caught.exception.status_code, 503)
                self.assertIn("signature-status metadata", caught.exception.detail)

    def test_mainnet_payment_verifier_requires_https_rpc_endpoint(self):
        for rpc_url in (
            "http://solana-mainnet.example",
            "not-a-url",
            "https://user:password@solana-mainnet.example",
        ):
            with self.subTest(rpc_url=rpc_url):
                with patch.object(main, "rpc_call") as rpc:
                    with self.assertRaises(main.HTTPException) as caught:
                        verify_solana_mainnet_sol_payment(
                            SIGNATURE, SENDER, RECIPIENT, EXPECTED, main.rpc_call,
                            expected_genesis_hash=main.SOLANA_MAINNET_GENESIS_HASH,
                            rpc_url=rpc_url,
                            valid_address=main.valid_solana_address,
                        )
                self.assertEqual(caught.exception.status_code, 503)
                self.assertIn("HTTPS RPC endpoint", caught.exception.detail)
                rpc.assert_not_called()

    def test_invalid_signature_is_rejected_before_rpc(self):
        with patch.object(main, "rpc_call") as rpc:
            with self.assertRaisesRegex(ValueError, "Invalid Solana transaction signature"):
                verify_solana_mainnet_sol_payment(
                    "not-a-signature", SENDER, RECIPIENT, EXPECTED, main.rpc_call,
                    expected_genesis_hash=main.SOLANA_MAINNET_GENESIS_HASH,
                    rpc_url="https://solana-mainnet.example",
                    valid_address=main.valid_solana_address,
                )
        rpc.assert_not_called()


if __name__ == "__main__":
    unittest.main()
