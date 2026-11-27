import base64
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from solders.hash import Hash
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.transaction import Transaction

import balmz_delivery as delivery


class BalmzDeliveryTransactionTests(unittest.TestCase):
    def setUp(self):
        self.authority = Keypair()
        self.mint = str(Pubkey.new_unique())
        self.source = str(Pubkey.new_unique())
        self.destination = str(Pubkey.new_unique())
        self.blockhash = str(Hash.new_unique())

    def build(self, amount="1250000000"):
        return delivery.build_unsigned_transfer_checked(
            mint_address=self.mint,
            source_token_account=self.source,
            destination_token_account=self.destination,
            authority_address=str(self.authority.pubkey()),
            fee_payer_address=str(self.authority.pubkey()),
            amount_base_units=amount,
            decimals=9,
            recent_blockhash=self.blockhash,
        )

    def sign(self, unsigned_base64):
        raw = base64.b64decode(unsigned_base64, validate=True)
        transaction = Transaction.from_bytes(raw)
        transaction.sign([self.authority], Hash.from_string(self.blockhash))
        return base64.b64encode(bytes(transaction)).decode("ascii")

    def test_unsigned_transfer_checked_binds_one_instruction_and_exact_amount(self):
        result = self.build()
        self.assertEqual(result["amount_base_units"], 1_250_000_000)
        self.assertEqual(result["decimals"], 9)
        self.assertEqual(result["instruction_count"], 1)
        self.assertEqual(result["required_signer_address"], str(self.authority.pubkey()))
        self.assertEqual(len(result["message_sha256"]), 64)
        transaction = Transaction.from_bytes(base64.b64decode(result["unsigned_transaction_base64"]))
        self.assertEqual(transaction.message.header.num_required_signatures, 1)
        self.assertEqual(len(transaction.message.instructions), 1)

    def test_wallet_signature_is_accepted_only_for_exact_prepared_message(self):
        unsigned = self.build()
        signed_base64 = self.sign(unsigned["unsigned_transaction_base64"])
        result = delivery.validate_wallet_signed_transaction(
            unsigned_transaction_base64=unsigned["unsigned_transaction_base64"],
            signed_transaction_base64=signed_base64,
            expected_message_sha256=unsigned["message_sha256"],
            required_signer_address=str(self.authority.pubkey()),
        )
        self.assertEqual(result["message_sha256"], unsigned["message_sha256"])
        self.assertTrue(result["signature"])

    def test_tampered_transaction_message_is_rejected_even_when_signed(self):
        unsigned = self.build("1250000000")
        changed = self.build("1250000001")
        signed_changed = self.sign(changed["unsigned_transaction_base64"])
        with self.assertRaisesRegex(delivery.BalmzDeliveryValidationError, "message_mismatch"):
            delivery.validate_wallet_signed_transaction(
                unsigned_transaction_base64=unsigned["unsigned_transaction_base64"],
                signed_transaction_base64=signed_changed,
                expected_message_sha256=unsigned["message_sha256"],
                required_signer_address=str(self.authority.pubkey()),
            )

    def test_invalid_token_precision_and_base_units_fail_closed(self):
        for amount in (0, -1, True, "01", "1.0", "1e9", str(1 << 64)):
            with self.subTest(amount=amount), self.assertRaises(delivery.BalmzDeliveryValidationError):
                delivery.canonical_base_units(amount)
        with self.assertRaisesRegex(delivery.BalmzDeliveryValidationError, "decimals_must_be_9"):
            delivery.build_unsigned_transfer_checked(
                mint_address=self.mint,
                source_token_account=self.source,
                destination_token_account=self.destination,
                authority_address=str(self.authority.pubkey()),
                fee_payer_address=str(self.authority.pubkey()),
                amount_base_units=1,
                decimals=18,
                recent_blockhash=self.blockhash,
            )

    def test_signed_transaction_with_wrong_authority_is_rejected(self):
        unsigned = self.build()
        signed_base64 = self.sign(unsigned["unsigned_transaction_base64"])
        with self.assertRaisesRegex(delivery.BalmzDeliveryValidationError, "authority_not_fee_payer"):
            delivery.validate_wallet_signed_transaction(
                unsigned_transaction_base64=unsigned["unsigned_transaction_base64"],
                signed_transaction_base64=signed_base64,
                expected_message_sha256=unsigned["message_sha256"],
                required_signer_address=str(Keypair().pubkey()),
            )

    def test_token_account_requires_exact_program_mint_owner_and_finalized_slot(self):
        response = {
            "context": {"slot": 123},
            "value": {
                "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                "executable": False,
                "data": {"parsed": {"type": "account", "info": {
                    "mint": self.mint,
                    "owner": str(self.authority.pubkey()),
                    "state": "initialized",
                    "tokenAmount": {"amount": "2000000000", "decimals": 9},
                }}},
            },
        }
        result = delivery.parse_spl_token_account(
            response,
            expected_mint=self.mint,
            expected_owner=str(self.authority.pubkey()),
            expected_token_program="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        )
        self.assertEqual(result["amount_base_units"], "2000000000")
        self.assertEqual(result["context_slot"], "123")
        for field, value in (("mint", str(Pubkey.new_unique())), ("owner", str(Keypair().pubkey()))):
            invalid = {
                "context": {"slot": 123},
                "value": {
                    "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                    "executable": False,
                    "data": {"parsed": {"type": "account", "info": {
                        "mint": self.mint, "owner": str(self.authority.pubkey()), "state": "initialized",
                        "tokenAmount": {"amount": "2000000000", "decimals": 9},
                    }}},
                },
            }
            invalid["value"]["data"]["parsed"]["info"][field] = value
            with self.subTest(field=field), self.assertRaises(delivery.BalmzDeliveryValidationError):
                delivery.parse_spl_token_account(
                    invalid,
                    expected_mint=self.mint,
                    expected_owner=str(self.authority.pubkey()),
                    expected_token_program="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                )



    def test_finalized_delivery_requires_authority_signature(self):
        signature = "5" * 64
        response = {
            "slot": 500,
            "meta": {"err": None, "innerInstructions": []},
            "transaction": {
                "signatures": [signature],
                "message": {"accountKeys": [
                    {"pubkey": str(self.authority.pubkey()), "signer": False},
                    {"pubkey": self.source, "signer": False},
                    {"pubkey": self.mint, "signer": False},
                    {"pubkey": self.destination, "signer": False},
                ], "instructions": [{
                    "program": "spl-token", "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                    "parsed": {"type": "transferChecked", "info": {
                        "mint": self.mint, "source": self.source, "destination": self.destination,
                        "authority": str(self.authority.pubkey()),
                        "tokenAmount": {"amount": "1250000000", "decimals": 9},
                    }},
                }]},
            },
        }
        with self.assertRaisesRegex(delivery.BalmzDeliveryValidationError, "authority_signature_missing"):
            delivery.verify_finalized_delivery_observation(
                response, expected_signature=signature, expected_mint=self.mint,
                expected_source=self.source, expected_destination=self.destination,
                expected_authority=str(self.authority.pubkey()), expected_amount_base_units="1250000000",
            )

    def test_delivery_release_gates_default_closed_before_database_or_chain_work(self):
        import main
        request = main.BalmzPresaleDeliveryPrepareRequest(
            allocation_id="bpal_test_allocation_123",
            recipient_address=str(Pubkey.new_unique()),
        )
        with (
            patch.object(main, "BALMZ_PRESALE_DELIVERY_ENABLED", False),
            patch.object(main, "DATABASE_URL", ""),
        ):
            with self.assertRaises(main.HTTPException) as caught:
                main.prepare_balmz_presale_delivery(request, {"id": "buyer-1"})
        self.assertEqual(caught.exception.status_code, 503)

    def test_admin_delivery_queue_rejects_invalid_filters_before_database_access(self):
        import main
        with patch.object(main, "require_world_wallet_admin", return_value="admin@example.test"):
            with self.assertRaises(main.HTTPException) as invalid_limit:
                main.list_admin_balmz_presale_deliveries(state="active", limit=101, user={"id": "admin"})
            self.assertEqual(invalid_limit.exception.status_code, 400)
            with self.assertRaises(main.HTTPException) as invalid_state:
                main.list_admin_balmz_presale_deliveries(state="unknown", limit=50, user={"id": "admin"})
            self.assertEqual(invalid_state.exception.status_code, 400)

    def test_finalized_observation_requires_exact_transferchecked_metadata(self):
        signature = "5" * 64
        response = {
            "slot": 500,
            "meta": {"err": None, "innerInstructions": []},
            "transaction": {
                "signatures": [signature],
                "message": {"accountKeys": [
                    {"pubkey": str(self.authority.pubkey()), "signer": True},
                    {"pubkey": self.source, "signer": False},
                    {"pubkey": self.mint, "signer": False},
                    {"pubkey": self.destination, "signer": False},
                ], "instructions": [{
                    "program": "spl-token",
                    "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                    "parsed": {"type": "transferChecked", "info": {
                        "mint": self.mint,
                        "source": self.source,
                        "destination": self.destination,
                        "authority": str(self.authority.pubkey()),
                        "tokenAmount": {"amount": "1250000000", "decimals": 9},
                    }},
                }]},
            },
        }
        result = delivery.verify_finalized_delivery_observation(
            response,
            expected_signature=signature,
            expected_mint=self.mint,
            expected_source=self.source,
            expected_destination=self.destination,
            expected_authority=str(self.authority.pubkey()),
            expected_amount_base_units="1250000000",
        )
        self.assertEqual(result["slot"], 500)
        response["transaction"]["message"]["instructions"][0]["parsed"]["info"]["destination"] = str(Pubkey.new_unique())
        with self.assertRaisesRegex(delivery.BalmzDeliveryValidationError, "fields_mismatch"):
            delivery.verify_finalized_delivery_observation(
                response,
                expected_signature=signature,
                expected_mint=self.mint,
                expected_source=self.source,
                expected_destination=self.destination,
                expected_authority=str(self.authority.pubkey()),
                expected_amount_base_units="1250000000",
            )


if __name__ == "__main__":
    unittest.main()
