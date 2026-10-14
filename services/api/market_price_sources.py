"""Verified market quote retrieval with a public secondary provider."""
from datetime import datetime, timezone
import logging

import httpx

logger = logging.getLogger(__name__)

COINGECKO_IDS = {
    "BTC": "bitcoin", "USDT": "tether", "USDT-BNB": "tether",
    "ETH": "ethereum", "BNB": "binancecoin", "USDC": "usd-coin",
    "SOL": "solana", "XRP": "ripple", "ADA": "cardano",
    "LTC": "litecoin", "DOGE": "dogecoin",
}
BINANCE_PAIRS = {
    "BTC": "BTCUSDT", "ETH": "ETHUSDT", "BNB": "BNBUSDT",
    "SOL": "SOLUSDT", "XRP": "XRPUSDT", "ADA": "ADAUSDT",
    "LTC": "LTCUSDT", "DOGE": "DOGEUSDT",
}


def _decorate(raw, source):
    prices = {}
    for symbol, coin_id in COINGECKO_IDS.items():
        quote = raw.get(coin_id, {})
        usd = quote.get("usd")
        prices[symbol] = {
            "usd": float(usd) if usd is not None else None,
            "usd_24h_change": float(quote["usd_24h_change"]) if quote.get("usd_24h_change") is not None else None,
            "listed": usd is not None,
        }
    prices["BALMZ"] = {"usd": None, "usd_24h_change": None, "listed": False,
                       "eth_reference_usd": prices.get("ETH", {}).get("usd")}
    prices["BALMZ-SEP"] = {"usd": None, "usd_24h_change": None, "listed": False}
    return {"source": source, "updated_at": datetime.now(timezone.utc).isoformat(),
            "prices": prices, "stale": False, "cache_age_seconds": 0}


def fetch_market_prices(api_base_url, headers=None, timeout=8):
    """Try CoinGecko first; on provider failure use real Binance USD-quoted pairs.

    Stablecoin prices are deliberately left unavailable on the secondary source rather
    than assuming a peg. No values are synthesized.
    """
    try:
        response = httpx.get(
            f"{api_base_url.rstrip('/')}/simple/price",
            params={"ids": ",".join(COINGECKO_IDS.values()), "vs_currencies": "usd",
                    "include_24hr_change": "true"},
            headers=headers or {}, timeout=timeout,
        )
        response.raise_for_status()
        raw = response.json()
        return _decorate(raw, "CoinGecko")
    except Exception as exc:
        logger.warning("Primary market-price provider failed; trying Binance fallback (error_type=%s)",
                       type(exc).__name__)

    try:
        response = httpx.get("https://api.binance.com/api/v3/ticker/24hr", timeout=timeout)
        response.raise_for_status()
        tickers = response.json()
        by_pair = {item.get("symbol"): item for item in tickers if isinstance(item, dict)}
        prices = {symbol: {"usd": None, "usd_24h_change": None, "listed": False}
                  for symbol in COINGECKO_IDS}
        for symbol, pair in BINANCE_PAIRS.items():
            quote = by_pair.get(pair)
            if not quote:
                continue
            prices[symbol] = {
                "usd": float(quote["lastPrice"]),
                "usd_24h_change": float(quote["priceChangePercent"]),
                "listed": True,
            }
        prices["BALMZ"] = {"usd": None, "usd_24h_change": None, "listed": False,
                           "eth_reference_usd": prices.get("ETH", {}).get("usd")}
        prices["BALMZ-SEP"] = {"usd": None, "usd_24h_change": None, "listed": False}
        if not any(prices[s]["usd"] is not None for s in BINANCE_PAIRS):
            raise ValueError("Binance returned no supported market pairs")
        return {"source": "Binance", "updated_at": datetime.now(timezone.utc).isoformat(),
                "prices": prices, "stale": False, "cache_age_seconds": 0}
    except Exception as exc:
        logger.error("Secondary market-price provider failed (error_type=%s)", type(exc).__name__)
        raise
