import unittest
from unittest.mock import patch

from fastapi import HTTPException

import main


class FakeCursor:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self, returned_row):
        self.returned_row = returned_row
        self.statements = []
        self.committed = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=None):
        self.statements.append((sql, params))
        return FakeCursor(self.returned_row)

    def commit(self):
        self.committed = True


class BalmzMiningReferralTests(unittest.TestCase):
    def test_records_one_referral_without_creating_a_reward(self):
        fake = FakeConnection(("wallet-new",))
        with patch.object(main, "db", return_value=fake):
            created = main.record_mining_referral(
                "wallet-referrer", "wallet-new", "MINE-AB12CD34EF"
            )

        self.assertTrue(created)
        self.assertTrue(fake.committed)
        self.assertEqual(len(fake.statements), 1)
        sql, params = fake.statements[0]
        self.assertIn("INSERT INTO balmz_mining_referrals", sql)
        self.assertIn("ON CONFLICT(referred_wallet_id) DO NOTHING", sql)
        self.assertEqual(params, ("wallet-new", "wallet-referrer", "MINE-AB12CD34EF"))
        self.assertNotIn("balmz_mining_reward_ledger", sql)

    def test_duplicate_referral_is_idempotent(self):
        fake = FakeConnection(None)
        with patch.object(main, "db", return_value=fake):
            created = main.record_mining_referral(
                "wallet-referrer", "wallet-new", "MINE-AB12CD34EF"
            )
        self.assertFalse(created)
        self.assertTrue(fake.committed)

    def test_wallet_cannot_refer_itself(self):
        with patch.object(main, "db") as mocked_db:
            with self.assertRaises(HTTPException) as error:
                main.record_mining_referral(
                    "wallet-same", "wallet-same", "MINE-AB12CD34EF"
                )
        self.assertEqual(error.exception.status_code, 400)
        mocked_db.assert_not_called()


if __name__ == "__main__":
    unittest.main()
