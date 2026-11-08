import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient
import main


class FakeCursor:
    def __init__(self, one=None, all_rows=None, rowcount=1):
        self.one = one
        self.all_rows = all_rows or []
        self.rowcount = rowcount

    def fetchone(self):
        return self.one

    def fetchall(self):
        return self.all_rows


class FakeConnection:
    def __init__(self, active=None, sessions=None, reward_rows=None):
        self.active = active
        self.sessions = sessions or []
        self.reward_rows = reward_rows or []
        self.statements = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def commit(self):
        return None

    def execute(self, sql, params=None):
        self.statements.append((sql, params))
        if "SELECT id,started_at FROM balmz_mining_sessions" in sql:
            return FakeCursor(one=self.active)
        if "SELECT id FROM wallets WHERE id=%s FOR UPDATE" in sql:
            return FakeCursor(one=("wallet-test",))
        if "SELECT id,started_at,COALESCE(ended_at,%s)" in sql:
            return FakeCursor(all_rows=self.sessions)
        if "SELECT session_id,cycle_number,earned_at FROM balmz_mining_reward_ledger" in sql:
            return FakeCursor(all_rows=[])
        if "COALESCE(SUM(reward_amount),0),COUNT(*)" in sql:
            return FakeCursor(one=(0, 0))
        if "FROM balmz_mining_reward_ledger WHERE wallet_id=%s" in sql and "ORDER BY created_at DESC" in sql:
            return FakeCursor(all_rows=self.reward_rows)
        if "SELECT mining_referral_code,world_wallet_code FROM wallets" in sql:
            return FakeCursor(one=("MINE-AB12CD34EF", "WWAI-9876FEDCBA"))
        if "SELECT id,status,started_at,ended_at,duration_seconds" in sql:
            return FakeCursor(all_rows=[])
        if "COUNT(*) FILTER" in sql:
            return FakeCursor(one=(0, 0))
        return FakeCursor()


class FreeBalmzMiningSessionTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.previous_overrides = dict(main.app.dependency_overrides)
        main.app.dependency_overrides[main.current_user] = lambda: {
            "id": "user-test", "wallet_id": "wallet-test", "email": "test@example.invalid"
        }

    def tearDown(self):
        main.app.dependency_overrides.clear()
        main.app.dependency_overrides.update(self.previous_overrides)

    def test_status_never_claims_or_credits_rewards(self):
        fake = FakeConnection()
        with patch.object(main, "db", return_value=fake):
            response = self.client.get("/api/v1/mining/balmz")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["claim_enabled"])
        self.assertFalse(body["withdrawal_enabled"])
        self.assertEqual(body["pending_reward_amount"], "0")
        self.assertEqual(body["pending_cycle_count"], 0)
        self.assertEqual(body["reward_rate_per_cycle"], "0.5")
        self.assertEqual(body["daily_reward_cap"], "4")
        self.assertEqual(body["reward_status"], "pending_launch_not_spendable")
        self.assertEqual(body["mining_referral_code"], "MINE-AB12CD34EF")
        self.assertEqual(body["world_wallet_code"], "WWAI-9876FEDCBA")
        self.assertNotEqual(body["mining_referral_code"], body["world_wallet_code"])
        self.assertFalse(any("INSERT INTO balmz_mining_reward_ledger" in sql for sql, _ in fake.statements))

    def test_status_exposes_immutable_timestamp_receipt_fields(self):
        earned_at = datetime.now(timezone.utc) - timedelta(hours=3)
        recorded_at = datetime.now(timezone.utc)
        receipt = ("balmz_reward_receipt1", "mine_test", 1, earned_at, recorded_at, "0.5", "pending_launch")
        fake = FakeConnection(reward_rows=[receipt])
        with patch.object(main, "db", return_value=fake):
            response = self.client.get("/api/v1/mining/balmz")
        self.assertEqual(response.status_code, 200)
        item = response.json()["recent_rewards"][0]
        self.assertEqual(item["id"], receipt[0])
        self.assertEqual(item["session_id"], receipt[1])
        self.assertEqual(item["cycle_number"], 1)
        self.assertEqual(item["earned_at"], earned_at.isoformat())
        self.assertEqual(item["recorded_at"], recorded_at.isoformat())
        self.assertEqual(item["amount"], "0.5")
        self.assertEqual(item["status"], "pending_launch")
    def test_start_creates_free_session_but_no_token_reward(self):
        fake = FakeConnection()
        with patch.object(main, "db", return_value=fake):
            response = self.client.post("/api/v1/mining/balmz/start")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "started")
        self.assertFalse(response.json()["claim_enabled"])
        self.assertTrue(any("INSERT INTO balmz_mining_sessions" in sql for sql, _ in fake.statements))

    def test_start_rejects_second_active_session_for_same_wallet(self):
        fake = FakeConnection(active=("mine_existing", datetime.now(timezone.utc)))
        with patch.object(main, "db", return_value=fake):
            response = self.client.post("/api/v1/mining/balmz/start")
        self.assertEqual(response.status_code, 409)


    def test_record_creates_one_pending_entry_per_completed_cycle(self):
        started = datetime.now(timezone.utc) - timedelta(hours=9, minutes=1)
        fake = FakeConnection(sessions=[("mine_test", started, datetime.now(timezone.utc))])
        with patch.object(main, "db", return_value=fake):
            response = self.client.post("/api/v1/mining/balmz/record")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["new_cycles_recorded"], 3)
        self.assertEqual(body["allocation_status"], "pending_launch_not_spendable")
        self.assertFalse(body["withdrawal_enabled"])
        inserts = [sql for sql, _ in fake.statements if "INSERT INTO balmz_mining_reward_ledger" in sql]
        self.assertEqual(len(inserts), 3)

    def test_stop_completes_session_without_credit(self):
        started = datetime.now(timezone.utc) - timedelta(seconds=60)
        fake = FakeConnection(active=("mine_existing", started))
        with patch.object(main, "db", return_value=fake):
            response = self.client.post("/api/v1/mining/balmz/stop")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "completed")
        self.assertGreaterEqual(body["duration_seconds"], 60)
        self.assertIsNone(body["reward_amount"])
        self.assertFalse(body["claim_enabled"])


if __name__ == "__main__":
    unittest.main()
