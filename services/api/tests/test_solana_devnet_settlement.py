import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


WALLET = "7FNyayYwgfrGb3mCsRttuJUkFQgsgDtrYBhhddKS6iVN"
RECIPIENT = "Vote111111111111111111111111111111111111111"
SIGNATURE = "5" * 64
TOKEN_ACCOUNT = "MockTokenAccountForSettlementTests"
AMOUNT = Decimal("1.25")
RAW_AMOUNT = "1250000000"


def confirmed_transaction():
    return {
        "slot": 123,
        "transaction": {
            "message": {
                "accountKeys": [
                    {"pubkey": WALLET, "signer": True},
                    {"pubkey": TOKEN_ACCOUNT, "signer": False},
                ],
                "instructions": [
                    {
                        "program": "spl-token",
                        "parsed": {
                            "type": "transferChecked",
                            "info": {
                                "mint": main.BALMZ_SOLANA_DEVNET_MINT,
                                "authority": WALLET,
                                "destination": TOKEN_ACCOUNT,
                                "tokenAmount": {
                                    "amount": RAW_AMOUNT,
                                    "decimals": main.BALMZ_SOLANA_DEVNET_DECIMALS,
                                    "uiAmountString": "1.25",
                                },
                            },
                        },
                    }
                ],
            }
        },
        "meta": {
            "err": None,
            "innerInstructions": [],
            "postTokenBalances": [
                {
                    "accountIndex": 1,
                    "owner": RECIPIENT,
                    "mint": main.BALMZ_SOLANA_DEVNET_MINT,
                    "uiTokenAmount": {
                        "amount": RAW_AMOUNT,
                        "decimals": main.BALMZ_SOLANA_DEVNET_DECIMALS,
                    },
                }
            ],
        },
    }


class SolanaDevnetSettlementTests(unittest.TestCase):
    def verify(self, transaction=None, amount=AMOUNT):
        with patch.object(
            main, "rpc_call", return_value=transaction
        ) as rpc:
            result = main.verify_solana_devnet_settlement(
                SIGNATURE, RECIPIENT, amount, WALLET
            )
        return result, rpc

    def test_valid_exact_balmz_transfer_is_confirmed(self):
        result, rpc = self.verify(confirmed_transaction())

        self.assertEqual(result["state"], "confirmed")
        self.assertEqual(result["confirmations"], 1)
        self.assertEqual(result["finality"], "finalized")
        self.assertIsNone(result["block_height"])
        self.assertEqual(rpc.call_args.args[1], "getTransaction")
        self.assertEqual(
            rpc.call_args.args[2][1]["commitment"], "finalized"
        )

    def test_token_2022_transfer_checked_is_supported(self):
        tx = confirmed_transaction()
        tx["transaction"]["message"]["instructions"][0]["program"] = "spl-token-2022"

        result, _ = self.verify(tx)

        self.assertEqual(result["state"], "confirmed")
        self.assertEqual(result["finality"], "finalized")

    def test_malformed_signature_status_returns_service_error(self):
        with patch.object(main, "rpc_call", side_effect=[None, {"value": ["not-a-status"]}]):
            with self.assertRaises(main.HTTPException) as raised:
                main.verify_solana_devnet_settlement(SIGNATURE, RECIPIENT, AMOUNT, WALLET)

        self.assertEqual(raised.exception.status_code, 503)

    def test_malformed_signature_status_shape_returns_service_error(self):
        with patch.object(main, "rpc_call", side_effect=[None, {"value": []}]):
            with self.assertRaises(main.HTTPException) as raised:
                main.verify_solana_devnet_settlement(SIGNATURE, RECIPIENT, AMOUNT, WALLET)

        self.assertEqual(raised.exception.status_code, 503)

    def test_malformed_token_decimals_returns_service_error(self):
        tx = confirmed_transaction()
        tx["transaction"]["message"]["instructions"][0]["parsed"]["info"]["tokenAmount"]["decimals"] = "nine"

        with patch.object(main, "rpc_call", return_value=tx):
            with self.assertRaises(main.HTTPException) as raised:
                main.verify_solana_devnet_settlement(SIGNATURE, RECIPIENT, AMOUNT, WALLET)

        self.assertEqual(raised.exception.status_code, 503)

    def test_missing_transaction_details_is_not_treated_as_user_error(self):
        with patch.object(main, "rpc_call", return_value={"meta": None, "transaction": None}):
            with self.assertRaises(main.HTTPException) as raised:
                main.verify_solana_devnet_settlement(SIGNATURE, RECIPIENT, AMOUNT, WALLET)

        self.assertEqual(raised.exception.status_code, 503)

    def test_wrong_mint_is_rejected(self):
        tx = confirmed_transaction()
        tx["transaction"]["message"]["instructions"][0]["parsed"]["info"][
            "mint"
        ] = RECIPIENT

        with self.assertRaisesRegex(ValueError, "exact BALMZ Devnet transfer"):
            self.verify(tx)

    def test_wrong_sender_authority_is_rejected(self):
        tx = confirmed_transaction()
        tx["transaction"]["message"]["instructions"][0]["parsed"]["info"][
            "authority"
        ] = RECIPIENT

        with self.assertRaisesRegex(ValueError, "exact BALMZ Devnet transfer"):
            self.verify(tx)

    def test_wrong_raw_amount_is_rejected(self):
        tx = confirmed_transaction()
        tx["transaction"]["message"]["instructions"][0]["parsed"]["info"][
            "tokenAmount"
        ]["amount"] = "1250000001"

        with self.assertRaisesRegex(ValueError, "exact BALMZ Devnet transfer"):
            self.verify(tx)

    def test_wrong_token_decimals_are_rejected(self):
        tx = confirmed_transaction()
        tx["transaction"]["message"]["instructions"][0]["parsed"]["info"][
            "tokenAmount"
        ]["decimals"] = 6

        with self.assertRaisesRegex(ValueError, "exact BALMZ Devnet transfer"):
            self.verify(tx)

    def test_wrong_recipient_owner_is_rejected(self):
        tx = confirmed_transaction()
        tx["meta"]["postTokenBalances"][0]["owner"] = WALLET

        with self.assertRaisesRegex(ValueError, "exact BALMZ Devnet transfer"):
            self.verify(tx)

    def test_failed_on_chain_transaction_is_rejected(self):
        tx = confirmed_transaction()
        tx["meta"]["err"] = {"InstructionError": [0, "Custom"]}

        with self.assertRaisesRegex(ValueError, "failed on-chain"):
            self.verify(tx)

    def test_missing_transaction_and_status_returns_not_found(self):
        with patch.object(
            main,
            "rpc_call",
            side_effect=[None, {"value": [None]}],
        ):
            result = main.verify_solana_devnet_settlement(
                SIGNATURE, RECIPIENT, AMOUNT, WALLET
            )

        self.assertEqual(result["state"], "not_found")
        self.assertEqual(result["confirmations"], 0)

    def test_existing_unconfirmed_signature_returns_pending(self):
        with patch.object(
            main,
            "rpc_call",
            side_effect=[
                None,
                {"value": [{"err": None, "confirmationStatus": "processed"}]},
            ],
        ):
            result = main.verify_solana_devnet_settlement(
                SIGNATURE, RECIPIENT, AMOUNT, WALLET
            )

        self.assertEqual(result["state"], "pending")
        self.assertEqual(result["confirmations"], 0)

    def test_failed_signature_status_is_rejected(self):
        with patch.object(
            main,
            "rpc_call",
            side_effect=[
                None,
                {"value": [{"err": {"InstructionError": [0, "Custom"]}}]},
            ],
        ):
            with self.assertRaisesRegex(ValueError, "failed on-chain"):
                main.verify_solana_devnet_settlement(
                    SIGNATURE, RECIPIENT, AMOUNT, WALLET
                )

    def test_invalid_signature_is_rejected_before_rpc(self):
        with patch.object(main, "rpc_call") as rpc:
            with self.assertRaisesRegex(ValueError, "Invalid Solana transaction signature"):
                main.verify_solana_devnet_settlement(
                    "invalid-signature", RECIPIENT, AMOUNT, WALLET
                )

        rpc.assert_not_called()

    def test_amount_with_excess_precision_is_rejected(self):
        with patch.object(
            main, "rpc_call", return_value=confirmed_transaction()
        ):
            with self.assertRaisesRegex(ValueError, "unsupported precision"):
                main.verify_solana_devnet_settlement(
                    SIGNATURE, RECIPIENT, Decimal("0.0000000001"), WALLET
                )


if __name__ == "__main__":
    unittest.main()
