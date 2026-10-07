from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="World Wallet AI API",
    version="0.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ASSETS = [
    {
        "symbol": "BALMZ",
        "name": "BALMZ Token",
        "balance": 18420.0,
        "price_usd": 1.0,
        "value_usd": 18420.0,
        "change_24h": 4.82,
    },
    {
        "symbol": "USDT",
        "name": "Tether USD",
        "balance": 8250.40,
        "price_usd": 1.0,
        "value_usd": 8250.40,
        "change_24h": 0.08,
    },
    {
        "symbol": "ETH",
        "name": "Ethereum",
        "balance": 2.184,
        "price_usd": 3590.20,
        "value_usd": 7842.60,
        "change_24h": 2.14,
    },
    {
        "symbol": "BNB",
        "name": "BNB",
        "balance": 8.42,
        "price_usd": 702.40,
        "value_usd": 5914.20,
        "change_24h": -0.61,
    },
]

WALLET_SUMMARY = {
    "available_balance_usd": 40427.20,
    "total_received_usd": 92814.60,
    "total_sent_usd": 51238.14,
    "profit_usd": 8942.76,
    "change_24h": 2.31,
}


@app.get("/")
def root():
    return {"status": "World Wallet AI API running", "version": "0.2.0"}


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.get("/api/v1/wallet")
def wallet():
    return {
        "wallet": WALLET_SUMMARY,
        "assets": ASSETS,
    }


@app.get("/api/v1/assets")
def assets():
    return {"assets": ASSETS}


@app.get("/api/v1/portfolio/performance")
def portfolio_performance():
    return {
        "currency": "USD",
        "period": "24h",
        "change_percent": WALLET_SUMMARY["change_24h"],
        "points": [
            {"label": "00:00", "value_usd": 39640.00},
            {"label": "04:00", "value_usd": 39880.00},
            {"label": "08:00", "value_usd": 40120.00},
            {"label": "12:00", "value_usd": 39980.00},
            {"label": "16:00", "value_usd": 40310.00},
            {"label": "20:00", "value_usd": 40427.20},
        ],
    }
