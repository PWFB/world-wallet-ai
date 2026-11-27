import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import main


class BalmzPresaleIntentPricingTests(unittest.TestCase):
    def test_one_token_at_140_usd_per_sol_is_exactly_point_zero_five_sol(self):
        lamports,base_units=main.balmz_presale_expected_lamports(Decimal("1"),Decimal("140"))
        self.assertEqual(lamports,50_000_000)
        self.assertEqual(base_units,1_000_000_000)

    def test_fractional_token_amount_uses_nine_decimal_base_units(self):
        lamports,base_units=main.balmz_presale_expected_lamports(Decimal("0.125"),Decimal("100"))
        self.assertEqual(base_units,125_000_000)
        self.assertEqual(lamports,8_750_000)

    def test_lamports_round_up_not_down(self):
        lamports,_=main.balmz_presale_expected_lamports(Decimal("1"),Decimal("123.45"))
        self.assertEqual(lamports,56_703_119)

    def test_rejects_zero_negative_nan_and_infinite_quotes(self):
        for amount,price in [
            (Decimal("0"),Decimal("100")),
            (Decimal("-1"),Decimal("100")),
            (Decimal("1"),Decimal("0")),
            (Decimal("1"),Decimal("NaN")),
            (Decimal("Infinity"),Decimal("100")),
        ]:
            with self.subTest(amount=amount,price=price),self.assertRaises(ValueError):
                main.balmz_presale_expected_lamports(amount,price)

    def test_rejects_precision_beyond_nine_decimals(self):
        with self.assertRaisesRegex(ValueError,"9-decimal"):
            main.balmz_presale_expected_lamports(Decimal("0.0000000001"),Decimal("100"))

    def test_quote_creation_is_closed_by_default(self):
        with patch.object(main,"BALMZ_PRESALE_INTENTS_ENABLED",False):
            with self.assertRaises(main.HTTPException) as caught:
                main.create_balmz_presale_intent(
                    main.BalmzPresaleIntentRequest(
                        payer_address="7FNyayYwgfrGb3mCsRttuJUkFQgsgDtrYBhhddKS6iVN",
                        token_amount=Decimal("1"),
                    ),
                    {"id":"test-user"},
                )
        self.assertEqual(caught.exception.status_code,503)

    def test_quote_creation_requires_independent_global_supply_proof(self):
        flags = (
            "BALMZ_PRESALE_INTENTS_ENABLED",
            "BALMZ_PRESALE_RELEASE_APPROVED",
            "BALMZ_PRESALE_TREASURY_OWNERSHIP_VERIFIED",
            "BALMZ_PRESALE_REGRESSION_SUITE_VERIFIED",
            "BALMZ_PRESALE_DELIVERY_ENABLED",
        )
        with (
            patch.multiple(main, **{name: True for name in flags}),
            patch.object(main, "_balmz_global_supply_is_verified_for_delivery", return_value=False),
        ):
            with self.assertRaises(main.HTTPException) as caught:
                main.create_balmz_presale_intent(
                    main.BalmzPresaleIntentRequest(
                        payer_address="7FNyayYwgfrGb3mCsRttuJUkFQgsgDtrYBhhddKS6iVN",
                        token_amount=Decimal("1"),
                    ),
                    {"id": "test-user"},
                )
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn("Independent Ethereum, BNB and Solana", caught.exception.detail)

    def test_settlement_requires_independent_global_supply_proof(self):
        flags = (
            "BALMZ_PRESALE_INTENTS_ENABLED",
            "BALMZ_PRESALE_SETTLEMENT_ENABLED",
            "BALMZ_PRESALE_RELEASE_APPROVED",
            "BALMZ_PRESALE_TREASURY_OWNERSHIP_VERIFIED",
            "BALMZ_PRESALE_REGRESSION_SUITE_VERIFIED",
            "BALMZ_PRESALE_DELIVERY_ENABLED",
        )
        with (
            patch.multiple(main, **{name: True for name in flags}),
            patch.object(main, "_balmz_global_supply_is_verified_for_delivery", return_value=False),
        ):
            with self.assertRaises(main.HTTPException) as caught:
                main.settle_balmz_presale_intent(
                    main.BalmzPresaleSettlementRequest(intent_id="bpi_test_intent_123", tx_signature="5" * 64),
                    {"id": "test-user"},
                )
        self.assertEqual(caught.exception.status_code, 503)
        self.assertIn("Independent Ethereum, BNB and Solana", caught.exception.detail)

    def test_settlement_is_closed_by_default(self):
        with patch.object(main,"BALMZ_PRESALE_SETTLEMENT_ENABLED",False):
            with self.assertRaises(main.HTTPException) as caught:
                main.settle_balmz_presale_intent(
                    main.BalmzPresaleSettlementRequest(intent_id="bpi_test_intent_123",tx_signature="5"*64),
                    {"id":"test-user"},
                )
        self.assertEqual(caught.exception.status_code,503)


if __name__=="__main__":
    unittest.main()
