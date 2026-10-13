import unittest
from datetime import datetime, timedelta, timezone

try:
    from services.api.market_price_cache import MarketPriceCache
except ModuleNotFoundError:
    # unittest discovery may put services/api on sys.path instead of the repository root.
    from market_price_cache import MarketPriceCache


class MarketPriceCacheTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 13, 12, 0, tzinfo=timezone.utc)
        self.cache = MarketPriceCache(max_age_seconds=900)
        self.payload = {
            "source": "CoinGecko",
            "updated_at": self.now.isoformat(),
            "prices": {"ETH": {"usd": 2500.0, "listed": True},
                       "BALMZ": {"usd": None, "listed": False}},
            "stale": False,
        }

    def test_cache_miss_has_no_fallback(self):
        self.assertIsNone(self.cache.stale_response(now=self.now))

    def test_recent_quote_is_returned_as_stale_with_age(self):
        self.cache.store(self.payload, fetched_at=self.now)
        result = self.cache.stale_response(now=self.now + timedelta(seconds=75))
        self.assertTrue(result["stale"])
        self.assertEqual(result["cache_age_seconds"], 75)
        self.assertEqual(result["prices"]["ETH"]["usd"], 2500.0)
        self.assertIsNone(result["prices"]["BALMZ"]["usd"])

    def test_expired_quote_is_not_served(self):
        self.cache.store(self.payload, fetched_at=self.now)
        self.assertIsNone(self.cache.stale_response(now=self.now + timedelta(seconds=901)))

    def test_stale_decoration_does_not_mutate_cached_payload(self):
        self.cache.store(self.payload, fetched_at=self.now)
        result = self.cache.stale_response(now=self.now + timedelta(seconds=1))
        result["prices"]["ETH"]["usd"] = 1.0
        result["prices"]["OTHER"] = {"usd": 99}
        again = self.cache.stale_response(now=self.now + timedelta(seconds=2))
        self.assertEqual(again["prices"]["ETH"]["usd"], 2500.0)
        self.assertNotIn("OTHER", again["prices"])
        self.assertFalse(self.cache._entry["payload"]["stale"])

    def test_successful_store_resets_stale_state_and_age(self):
        self.cache.store(self.payload, fetched_at=self.now)
        self.cache.store({"source": "CoinGecko", "prices": {"ETH": {"usd": 2600.0}}}, fetched_at=self.now + timedelta(seconds=10))
        result = self.cache.stale_response(now=self.now + timedelta(seconds=10))
        self.assertFalse(result["stale"])
        self.assertEqual(result["cache_age_seconds"], 0)
        self.assertEqual(result["prices"]["ETH"]["usd"], 2600.0)


if __name__ == "__main__":
    unittest.main()
