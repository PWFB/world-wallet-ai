import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

try:
    from services.api import main
except ModuleNotFoundError:
    import main


class FakeConnectionPool:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.closed = False
        self.connection_calls = 0
        self.__class__.instances.append(self)

    def connection(self, timeout=None):
        self.connection_calls += 1
        return ("connection-context", timeout)

    def close(self):
        self.closed = True


class DatabasePoolTests(unittest.TestCase):
    def setUp(self):
        FakeConnectionPool.instances = []
        self.original_pool = main._DB_POOL
        main._DB_POOL = None

    def tearDown(self):
        main._DB_POOL = self.original_pool

    def test_database_connections_use_one_bounded_pool(self):
        fake_module = SimpleNamespace(ConnectionPool=FakeConnectionPool)
        with patch.object(main, "DATABASE_URL", "postgresql://example.invalid/test"), patch.dict(
            sys.modules, {"psycopg_pool": fake_module}
        ):
            first = main.db()
            second = main.db()

        self.assertEqual(first, ("connection-context", 5))
        self.assertEqual(second, ("connection-context", 5))
        self.assertEqual(len(FakeConnectionPool.instances), 1)
        pool = FakeConnectionPool.instances[0]
        self.assertEqual(pool.kwargs["max_size"], 5)
        self.assertEqual(pool.kwargs["min_size"], 1)
        self.assertEqual(pool.kwargs["kwargs"]["connect_timeout"], 5)
        self.assertEqual(pool.connection_calls, 2)

    def test_shutdown_closes_the_initialized_pool(self):
        fake_module = SimpleNamespace(ConnectionPool=FakeConnectionPool)
        with patch.object(main, "DATABASE_URL", "postgresql://example.invalid/test"), patch.dict(
            sys.modules, {"psycopg_pool": fake_module}
        ):
            main.db()
            pool = main._DB_POOL
            main.close_database_pool()

        self.assertTrue(pool.closed)

    def test_missing_database_url_keeps_existing_503_behavior(self):
        with patch.object(main, "DATABASE_URL", ""):
            with self.assertRaises(main.HTTPException) as error:
                main.db()
        self.assertEqual(error.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
