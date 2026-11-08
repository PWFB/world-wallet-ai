import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient
import main


class FakeCursor:
    def __init__(self, one=None, all_rows=None):
        self.one = one
        self.all_rows = all_rows or []

    def fetchone(self):
        return self.one

    def fetchall(self):
        return self.all_rows


class FakeConnection:
    def __init__(self, active=None):
        self.active = active
        self.statements = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=None):
        self.statements.append((sql, params))
        if "SELECT id,started_at FROM balmz_mining_sessions" in sql:
            return FakeCursor(one=self.active)
        if "SELECT id,status,started_at,ended_at,duration_seconds" in sql:
            return FakeCursor(all_rows=[])
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
        self.assertIsNone(body["reward_amount"])
        self.assertEqual(body["reward_status"], "disabled_pending_verified_funded_allocation")

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
