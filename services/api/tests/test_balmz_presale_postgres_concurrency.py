"""PostgreSQL integration tests for BALMZ-SOL presale settlement concurrency.

The suite uses an isolated schema in BALMZ_PRESALE_TEST_DATABASE_URL. CI provides a
disposable PostgreSQL service; local runs may set the same variable. It never uses
the production DATABASE_URL and never contacts Solana Mainnet.
"""
from __future__ import annotations

import os
import sys
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

import psycopg
from psycopg import sql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


TEST_DATABASE_URL = os.getenv("BALMZ_PRESALE_TEST_DATABASE_URL", "").strip()
OWNER_ID = "presale-concurrency-test-owner"
PAYER = "7FNyayYwgfrGb3mCsRttuJUkFQgsgDtrYBhhddKS6iVN"
TREASURY = "11111111111111111111111111111111"


@unittest.skipUnless(TEST_DATABASE_URL, "requires BALMZ_PRESALE_TEST_DATABASE_URL (disposable PostgreSQL)")
class BalmzPresalePostgresConcurrencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = "balmz_presale_test_" + uuid.uuid4().hex
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as conn:
            conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(cls.schema)))
        cls._create_schema_tables()

    @classmethod
    def tearDownClass(cls):
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as conn:
            conn.execute(
                sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(cls.schema))
            )

    @classmethod
    def _connect(cls):
        return psycopg.connect(
            TEST_DATABASE_URL,
            options=f"-c search_path={cls.schema}",
            application_name="balmz-presale-postgres-tests",
        )

    @classmethod
    def _create_schema_tables(cls):
        ddl = """
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL
        );
        CREATE TABLE balmz_presale_allocation_state (
          id SMALLINT PRIMARY KEY CHECK (id = 1),
          cap_tokens NUMERIC(36,9) NOT NULL CHECK (cap_tokens > 0),
          allocated_tokens NUMERIC(36,9) NOT NULL DEFAULT 0 CHECK (allocated_tokens >= 0),
          reserved_tokens NUMERIC(36,9) NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (allocated_tokens + reserved_tokens <= cap_tokens)
        );
        CREATE TABLE balmz_presale_payment_intents (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          payer_address TEXT NOT NULL,
          treasury_address TEXT NOT NULL,
          token_amount NUMERIC(36,9) NOT NULL CHECK (token_amount > 0),
          token_base_units BIGINT NOT NULL CHECK (token_base_units > 0),
          token_price_usd NUMERIC(24,8) NOT NULL CHECK (token_price_usd > 0),
          sol_usd_quote NUMERIC(24,10) NOT NULL CHECK (sol_usd_quote > 0),
          expected_lamports BIGINT NOT NULL CHECK (expected_lamports > 0),
          quote_source TEXT NOT NULL,
          quoted_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','settled','expired')),
          tx_signature TEXT UNIQUE,
          settled_slot BIGINT,
          settled_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK (expires_at > created_at)
        );
        CREATE TABLE balmz_presale_allocation_ledger (
          id TEXT PRIMARY KEY,
          intent_id TEXT NOT NULL UNIQUE REFERENCES balmz_presale_payment_intents(id),
          owner_id TEXT NOT NULL REFERENCES users(id),
          payer_address TEXT NOT NULL,
          tx_signature TEXT NOT NULL UNIQUE,
          token_amount NUMERIC(36,9) NOT NULL CHECK (token_amount > 0),
          token_base_units BIGINT NOT NULL CHECK (token_base_units > 0),
          paid_lamports BIGINT NOT NULL CHECK (paid_lamports > 0),
          finalized_slot BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """
        with cls._connect() as conn:
            conn.execute(ddl)
            conn.execute("INSERT INTO users(id,email) VALUES (%s,%s)", (OWNER_ID, "presale-test@example.invalid"))
            conn.execute(
                """INSERT INTO balmz_presale_allocation_state
                   (id,cap_tokens,allocated_tokens,reserved_tokens)
                   VALUES (1,1000000000,0,0)"""
            )

    @contextmanager
    def _database_connection(self):
        conn = self._connect()
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def setUp(self):
        with self._database_connection() as conn:
            conn.execute("TRUNCATE balmz_presale_allocation_ledger, balmz_presale_payment_intents")
            conn.execute(
                """UPDATE balmz_presale_allocation_state
                   SET cap_tokens=1000000000,allocated_tokens=0,reserved_tokens=0 WHERE id=1"""
            )
            conn.execute("DELETE FROM users")
            conn.execute("INSERT INTO users(id,email) VALUES (%s,%s)", (OWNER_ID, "presale-test@example.invalid"))

    def _set_cap(self, cap: Decimal):
        with self._database_connection() as conn:
            conn.execute(
                """UPDATE balmz_presale_allocation_state
                   SET cap_tokens=%s,allocated_tokens=0,reserved_tokens=0 WHERE id=1""",
                (cap,),
            )

    def _add_intent(self, intent_id: str, amount: Decimal):
        base_units = int(amount * Decimal(1_000_000_000))
        with self._database_connection() as conn:
            conn.execute(
                """INSERT INTO balmz_presale_payment_intents
                   (id,owner_id,payer_address,treasury_address,token_amount,token_base_units,
                    token_price_usd,sol_usd_quote,expected_lamports,quote_source,quoted_at,expires_at)
                   VALUES (%s,%s,%s,%s,%s,%s,7,140,'50000000','test-fixture',NOW(),%s)""",
                (
                    intent_id,
                    OWNER_ID,
                    PAYER,
                    TREASURY,
                    amount,
                    base_units,
                    datetime.now(timezone.utc) + timedelta(minutes=20),
                ),
            )
            conn.execute(
                "UPDATE balmz_presale_allocation_state SET reserved_tokens=reserved_tokens+%s WHERE id=1",
                (amount,),
            )

    def _enable_settlement_gates(self):
        return patch.multiple(
            main,
            DATABASE_URL=TEST_DATABASE_URL,
            BALMZ_PRESALE_INTENTS_ENABLED=True,
            BALMZ_PRESALE_SETTLEMENT_ENABLED=True,
            BALMZ_PRESALE_RELEASE_APPROVED=True,
            BALMZ_PRESALE_TREASURY_OWNERSHIP_VERIFIED=True,
            BALMZ_PRESALE_REGRESSION_SUITE_VERIFIED=True,
            BALMZ_PRESALE_DELIVERY_ENABLED=True,
            BALMZ_PRESALE_RECEIVING_ADDRESS=TREASURY,
            _balmz_global_supply_is_verified_for_delivery=lambda: True,
        )

    @staticmethod
    def _verified_evidence(_signature, _payer, _expected_lamports):
        return {"state": "confirmed", "finality": "finalized", "paid_lamports": 50_000_000, "slot": 123456}

    def _settle(self, intent_id: str, signature: str):
        return main.settle_balmz_presale_intent(
            main.BalmzPresaleSettlementRequest(intent_id=intent_id, tx_signature=signature),
            {"id": OWNER_ID},
        )

    def _counts(self):
        with self._database_connection() as conn:
            state = conn.execute(
                "SELECT allocated_tokens,reserved_tokens FROM balmz_presale_allocation_state WHERE id=1"
            ).fetchone()
            ledger_count = conn.execute("SELECT COUNT(*) FROM balmz_presale_allocation_ledger").fetchone()[0]
            intent_rows = conn.execute(
                "SELECT id,status,tx_signature FROM balmz_presale_payment_intents ORDER BY id"
            ).fetchall()
        return state, ledger_count, intent_rows

    def test_concurrent_retry_of_same_intent_is_idempotent_and_allocates_once(self):
        self._add_intent("bpi_same_intent", Decimal("5"))
        barrier = Barrier(2)

        def verify(*args):
            barrier.wait(timeout=10)
            return self._verified_evidence(*args)

        with (
            self._enable_settlement_gates(),
            patch.object(main, "db", side_effect=self._database_connection),
            patch.object(main, "verify_balmz_presale_mainnet_payment", side_effect=verify),
            ThreadPoolExecutor(max_workers=2) as pool,
        ):
            futures = [pool.submit(self._settle, "bpi_same_intent", "SAME_SIGNATURE_" + "x" * 70) for _ in range(2)]
            results = [future.result(timeout=20) for future in futures]

        self.assertEqual(sum(result.get("state") == "settled" for result in results), 2)
        self.assertEqual(sum(result.get("idempotent") is True for result in results), 1)
        state, ledger_count, intents = self._counts()
        self.assertEqual(state, (Decimal("5.000000000"), Decimal("0E-9")))
        self.assertEqual(ledger_count, 1)
        self.assertEqual(intents[0][1], "settled")

    def test_same_finalized_signature_cannot_be_reused_for_two_intents(self):
        self._add_intent("bpi_reuse_intent_a", Decimal("5"))
        self._add_intent("bpi_reuse_intent_b", Decimal("5"))
        barrier = Barrier(2)

        def verify(*args):
            barrier.wait(timeout=10)
            return self._verified_evidence(*args)

        signature = "REPLAYED_SIGNATURE_" + "y" * 70
        with (
            self._enable_settlement_gates(),
            patch.object(main, "db", side_effect=self._database_connection),
            patch.object(main, "verify_balmz_presale_mainnet_payment", side_effect=verify),
            ThreadPoolExecutor(max_workers=2) as pool,
        ):
            futures = [
                pool.submit(self._settle, "bpi_reuse_intent_a", signature),
                pool.submit(self._settle, "bpi_reuse_intent_b", signature),
            ]
            outcomes = []
            for future in futures:
                try:
                    outcomes.append(future.result(timeout=20))
                except main.HTTPException as exc:
                    outcomes.append(exc)

        self.assertEqual(sum(isinstance(item, dict) and item.get("state") == "settled" for item in outcomes), 1)
        conflicts = [item for item in outcomes if isinstance(item, main.HTTPException)]
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0].status_code, 409)
        state, ledger_count, intents = self._counts()
        self.assertEqual(state, (Decimal("5.000000000"), Decimal("5.000000000")))
        self.assertEqual(ledger_count, 1)
        self.assertEqual(sum(row[1] == "settled" for row in intents), 1)
        self.assertEqual(sum(row[1] == "pending" for row in intents), 1)

    def test_two_distinct_finalized_payments_cannot_exceed_reserved_cap(self):
        self._set_cap(Decimal("10"))
        self._add_intent("bpi_cap_intent_a", Decimal("5"))
        self._add_intent("bpi_cap_intent_b", Decimal("5"))
        barrier = Barrier(2)

        def verify(*args):
            barrier.wait(timeout=10)
            return self._verified_evidence(*args)

        with (
            self._enable_settlement_gates(),
            patch.object(main, "db", side_effect=self._database_connection),
            patch.object(main, "verify_balmz_presale_mainnet_payment", side_effect=verify),
            ThreadPoolExecutor(max_workers=2) as pool,
        ):
            futures = [
                pool.submit(self._settle, "bpi_cap_intent_a", "CAP_SIGNATURE_A_" + "a" * 70),
                pool.submit(self._settle, "bpi_cap_intent_b", "CAP_SIGNATURE_B_" + "b" * 70),
            ]
            results = [future.result(timeout=20) for future in futures]

        self.assertTrue(all(result.get("state") == "settled" for result in results))
        state, ledger_count, intents = self._counts()
        self.assertEqual(state, (Decimal("10.000000000"), Decimal("0E-9")))
        self.assertEqual(ledger_count, 2)
        self.assertTrue(all(row[1] == "settled" for row in intents))


if __name__ == "__main__":
    unittest.main()
