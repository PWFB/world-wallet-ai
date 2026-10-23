import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


WALLET = "7FNyayYwgfrGb3mCsRttuJUkFQgsgDtrYBhhddKS6iVN"
OTHER_WALLET = "Vote111111111111111111111111111111111111111"
SOURCE_TOKEN_ACCOUNT = "SourceTokenAccountForTestFixture"
DESTINATION_TOKEN_ACCOUNT = "MockTokenAccountForSettlementTests"
SIGNATURE = "5" * 64
AMOUNT = Decimal("1.25")
RAW_AMOUNT = "1250000000"


def confirmed_deposit_transaction():
    mint = main.BALMZ_SOLANA_DEVNET_MINT
    return {
        "slot": 123,
        "transaction": {
            "message": {
                "accountKeys": [
                    {"pubkey": "SourceAuthorityForTestFixture", "signer": True},
                    {"pubkey": SOURCE_TOKEN_ACCOUNT, "signer": False},
                    {"pubkey": DESTINATION_TOKEN_ACCOUNT, "signer": False},
                ],
                "instructions": [
                    {
                        "program": "spl-token",
                        "parsed": {
                            "type": "transferChecked",
                            "info": {
                                "mint": mint,
                                "authority": "SourceAuthorityForTestFixture",
                                "source": SOURCE_TOKEN_ACCOUNT,
                                "destination": DESTINATION_TOKEN_ACCOUNT,
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
            "preTokenBalances": [
                {
                    "accountIndex": 1,
                    "owner": OTHER_WALLET,
                    "mint": mint,
                    "uiTokenAmount": {"amount": "5000000000", "decimals": 9},
                }
            ],
            "postTokenBalances": [
                {
                    "accountIndex": 2,
                    "owner": WALLET,
                    "mint": mint,
                    "uiTokenAmount": {"amount": RAW_AMOUNT, "decimals": 9},
                }
            ],
            "innerInstructions": [],
        },
    }


class FakeCursor:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class FakeStore:
    def __init__(self):
        self.deposits = {}
        self.transactions = []
        self.asset_updates = []


class FakeConnection:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, query, params=()):
        sql = " ".join(query.split())
        if sql.startswith("INSERT INTO solana_devnet_deposits"):
            signature, wallet_id, destination, amount, slot = params
            if signature in self.store.deposits:
                return FakeCursor(None)
            self.store.deposits[signature] = (wallet_id, Decimal(amount), destination, slot)
            return FakeCursor((signature,))
        if sql.startswith("SELECT wallet_id,amount FROM solana_devnet_deposits"):
            row = self.store.deposits.get(params[0])
            return FakeCursor((row[0], row[1]) if row else None)
        if sql.startswith("INSERT INTO assets"):
            self.store.asset_updates.append(params)
            return FakeCursor()
        if sql.startswith("INSERT INTO transactions"):
            self.store.transactions.append((sql, params))
            return FakeCursor()
        raise AssertionError(f"Unexpected SQL in test fake: {sql}")

    def commit(self):
        return None


class SolanaDevnetDepositVerificationTests(unittest.TestCase):
    def test_exact_incoming_balmz_devnet_transfer_is_confirmed(self):
        tx = confirmed_deposit_transaction()
        with patch.object(main, "rpc_call", return_value=tx) as rpc:
            result = main.verify_solana_devnet_deposit(SIGNATURE, WALLET)

        self.assertEqual(result["state"], "confirmed")
        self.assertEqual(result["amount"], AMOUNT)
        self.assertEqual(result["finality"], "finalized")
        self.assertEqual(result["slot"], 123)
        self.assertEqual(rpc.call_args.args[1], "getTransaction")
        self.assertEqual(rpc.call_args.args[2][1]["commitment"], "finalized")

    def test_wrong_mint_is_rejected(self):
        tx = confirmed_deposit_transaction()
        tx["transaction"]["message"]["instructions"][0]["parsed"]["info"]["mint"] = OTHER_WALLET

        with patch.object(main, "rpc_call", return_value=tx):
            with self.assertRaisesRegex(ValueError, "incoming BALMZ Devnet deposit"):
                main.verify_solana_devnet_deposit(SIGNATURE, WALLET)

    def test_wrong_recipient_owner_is_rejected(self):
        tx = confirmed_deposit_transaction()
        tx["meta"]["postTokenBalances"][0]["owner"] = OTHER_WALLET

        with patch.object(main, "rpc_call", return_value=tx):
            with self.assertRaisesRegex(ValueError, "incoming BALMZ Devnet deposit"):
                main.verify_solana_devnet_deposit(SIGNATURE, WALLET)

    def test_failed_on_chain_deposit_is_rejected(self):
        tx = confirmed_deposit_transaction()
        tx["meta"]["err"] = {"InstructionError": [0, "Custom"]}

        with patch.object(main, "rpc_call", return_value=tx):
            with self.assertRaisesRegex(ValueError, "failed on-chain"):
                main.verify_solana_devnet_deposit(SIGNATURE, WALLET)

    def test_unfinalized_signature_is_not_recorded_as_deposit(self):
        with patch.object(
            main,
            "rpc_call",
            side_effect=[
                None,
                {"value": [{"err": None, "confirmationStatus": "processed"}]},
            ],
        ):
            result = main.verify_solana_devnet_deposit(SIGNATURE, WALLET)

        self.assertEqual(result["state"], "pending")
        self.assertEqual(result["confirmations"], 0)

    def test_invalid_signature_is_rejected_before_rpc(self):
        with patch.object(main, "rpc_call") as rpc:
            with self.assertRaisesRegex(ValueError, "Invalid Solana transaction signature"):
                main.verify_solana_devnet_deposit("not-a-signature", WALLET)
        rpc.assert_not_called()


class SolanaDevnetDepositEndpointTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        self.request = main.SolanaDevnetDepositRequest(tx_signature=SIGNATURE)
        self.user = {"id": "user_1", "wallet_id": "wallet_1"}

    def call_endpoint(self, user=None):
        return main.verify_solana_devnet_deposit_request(self.request, user or self.user)

    def patches(self):
        return (
            patch.object(main, "wallet_network_address", return_value=WALLET),
            patch.object(
                main,
                "verify_solana_devnet_deposit",
                return_value={
                    "state": "confirmed",
                    "amount": AMOUNT,
                    "confirmations": 1,
                    "finality": "finalized",
                    "slot": 123,
                },
            ),
            patch.object(main, "solana_spl_token_balance", return_value=2.5),
            patch.object(main, "db", side_effect=lambda: FakeConnection(self.store)),
        )

    def test_deposit_is_recorded_once_and_replay_does_not_duplicate_activity(self):
        patches = self.patches()
        for context in patches:
            context.start()
        self.addCleanup(patch.stopall)

        first = self.call_endpoint()
        second = self.call_endpoint()

        self.assertEqual(first["status"], "confirmed")
        self.assertFalse(first["replayed"])
        self.assertFalse(first["mainnet_funding"])
        self.assertTrue(second["replayed"])
        self.assertEqual(len(self.store.deposits), 1)
        self.assertEqual(len(self.store.transactions), 1)
        self.assertIn("'BALMZ-SOL-DEVNET'", self.store.transactions[0][0])

    def test_same_signature_cannot_be_claimed_by_another_wallet(self):
        patches = self.patches()
        for context in patches:
            context.start()
        self.addCleanup(patch.stopall)

        self.call_endpoint()
        with self.assertRaises(HTTPException) as raised:
            self.call_endpoint({"id": "user_2", "wallet_id": "wallet_2"})

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(len(self.store.transactions), 1)


if __name__ == "__main__":
    unittest.main()
