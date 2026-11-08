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

    def test_referral_history_is_scoped_and_paginated(self):
        from datetime import datetime, timezone

        class HistoryCursor:
            def __init__(self, one=None, rows=None):
                self.one = one
                self.rows = rows or []
            def fetchone(self):
                return self.one
            def fetchall(self):
                return self.rows

        class HistoryConnection:
            def __init__(self):
                self.statements = []
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def execute(self, sql, params=None):
                self.statements.append((sql, params))
                if "SELECT COUNT(*) FROM balmz_mining_referrals" in sql:
                    return HistoryCursor(one=(31,))
                return HistoryCursor(rows=[(
                    "wallet-referred-01", "MINE-AB12CD34EF",
                    datetime(2026, 11, 8, tzinfo=timezone.utc)
                )])

        fake = HistoryConnection()
        with patch.object(main, "db", return_value=fake):
            result = main.balmz_mining_referral_history(
                limit=500, offset=-5, user={"wallet_id": "wallet-owner"}
            )

        self.assertEqual(result["total"], 31)
        self.assertEqual(result["limit"], 100)
        self.assertEqual(result["offset"], 0)
        self.assertEqual(result["referrals"][0]["referred_wallet_id"], "wallet-referred-01")
        self.assertEqual(result["referrals"][0]["referral_code"], "MINE-AB12CD34EF")
        self.assertEqual(result["referrals"][0]["referred_at"], "2026-11-08T00:00:00+00:00")
        self.assertEqual(fake.statements[0][1], ("wallet-owner",))
        self.assertEqual(fake.statements[1][1], ("wallet-owner", 100, 0))
        self.assertNotIn("email", str(result).lower())
        self.assertNotIn("phone", str(result).lower())

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
