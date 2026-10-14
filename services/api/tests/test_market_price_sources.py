import unittest
from unittest.mock import patch, Mock

from services.api.market_price_sources import fetch_market_prices


class MarketPriceSourcesTests(unittest.TestCase):
    @patch("services.api.market_price_sources.httpx.get")
    def test_primary_provider_success_is_used(self, get):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"bitcoin": {"usd": 65000, "usd_24h_change": 1.2}}
        get.return_value = response
        result = fetch_market_prices("https://example.test/api/v3")
        self.assertEqual(result["source"], "CoinGecko")
        self.assertEqual(result["prices"]["BTC"]["usd"], 65000)
        self.assertIsNone(result["prices"]["BALMZ"]["usd"])
        get.assert_called_once()

    @patch("services.api.market_price_sources.httpx.get")
    def test_binance_fallback_uses_only_provider_quotes(self, get):
        primary = Mock()
        primary.raise_for_status.side_effect = RuntimeError("rate limited")
        secondary = Mock()
        secondary.raise_for_status.return_value = None
        secondary.json.return_value = [
            {"symbol": "BTCUSDT", "lastPrice": "64000", "priceChangePercent": "2.1"},
            {"symbol": "ETHUSDT", "lastPrice": "3200", "priceChangePercent": "-0.5"},
        ]
        get.side_effect = [primary, secondary]
        result = fetch_market_prices("https://example.test/api/v3")
        self.assertEqual(result["source"], "Binance")
        self.assertEqual(result["prices"]["BTC"]["usd"], 64000)
        self.assertEqual(result["prices"]["BTC"]["usd_24h_change"], 2.1)
        self.assertIsNone(result["prices"]["USDT"]["usd"])
        self.assertIsNone(result["prices"]["BALMZ"]["usd"])
        self.assertEqual(get.call_count, 2)

    @patch("services.api.market_price_sources.httpx.get")
    def test_both_providers_fail(self, get):
        get.side_effect = RuntimeError("offline")
        with self.assertRaises(RuntimeError):
            fetch_market_prices("https://example.test/api/v3")
        self.assertEqual(get.call_count, 2)


if __name__ == "__main__":
    unittest.main()
