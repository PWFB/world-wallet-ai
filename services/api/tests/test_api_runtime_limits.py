import os
import unittest
from unittest.mock import patch

try:
    from services.api import main
except ModuleNotFoundError:
    import main


class _FakeLimiter:
    def __init__(self, total_tokens=40):
        self.total_tokens = total_tokens


class ApiRuntimeLimitTests(unittest.TestCase):
    def test_default_sync_capacity_is_bounded_to_eight(self):
        limiter = _FakeLimiter(40)
        with patch.dict(os.environ, {"WORLD_WALLET_API_THREAD_LIMIT": "8"}), \
             patch.object(main.to_thread, "current_default_thread_limiter", return_value=limiter):
            configured = main.configure_api_thread_limit()

        self.assertEqual(configured, 8)
        self.assertEqual(limiter.total_tokens, 8)

    def test_invalid_environment_value_uses_safe_default(self):
        limiter = _FakeLimiter(40)
        with patch.dict(os.environ, {"WORLD_WALLET_API_THREAD_LIMIT": "invalid"}), \
             patch.object(main.to_thread, "current_default_thread_limiter", return_value=limiter):
            configured = main.configure_api_thread_limit()

        self.assertEqual(configured, 8)
        self.assertEqual(limiter.total_tokens, 8)

    def test_environment_value_cannot_expand_capacity_above_sixteen(self):
        limiter = _FakeLimiter(40)
        with patch.dict(os.environ, {"WORLD_WALLET_API_THREAD_LIMIT": "64"}), \
             patch.object(main.to_thread, "current_default_thread_limiter", return_value=limiter):
            configured = main.configure_api_thread_limit()

        self.assertEqual(configured, 16)
        self.assertEqual(limiter.total_tokens, 16)

    def test_existing_lower_capacity_is_never_increased(self):
        limiter = _FakeLimiter(4)
        with patch.dict(os.environ, {"WORLD_WALLET_API_THREAD_LIMIT": "8"}), \
             patch.object(main.to_thread, "current_default_thread_limiter", return_value=limiter):
            configured = main.configure_api_thread_limit()

        self.assertEqual(configured, 4)
        self.assertEqual(limiter.total_tokens, 4)


if __name__ == "__main__":
    unittest.main()
