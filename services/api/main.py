from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(
    title="World Wallet AI API",
    version="0.5.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ASSETS = [
    {"symbol": "BALMZ", "name": "BALMZ Token", "balance": 18420.0, "price_usd": 1.0, "value_usd": 18420.0, "change_24h": 4.82},
    {"symbol": "USDT", "name": "Tether USD", "balance": 8250.40, "price_usd": 1.0, "value_usd": 8250.40, "change_24h": 0.08},
    {"symbol": "ETH", "name": "Ethereum", "balance": 2.184, "price_usd": 3590.20, "value_usd": 7842.60, "change_24h": 2.14},
    {"symbol": "BNB", "name": "BNB", "balance": 8.42, "price_usd": 702.40, "value_usd": 5914.20, "change_24h": -0.61},
]

WALLET_SUMMARY = {
    "available_balance_usd": 40427.20,
    "total_received_usd": 92814.60,
    "total_sent_usd": 51238.14,
    "profit_usd": 8942.76,
    "change_24h": 2.31,
}

TRANSACTIONS = [
    {"id": "tx_1004", "type": "received", "asset": "BALMZ", "description": "Wallet funding", "amount": 2500.0, "status": "confirmed", "time": "2 min ago"},
    {"id": "tx_1003", "type": "sent", "asset": "USDT", "description": "External wallet", "amount": -420.0, "status": "confirmed", "time": "1 hour ago"},
    {"id": "tx_1002", "type": "swap", "asset": "USDT", "description": "ETH → USDT", "amount": 1120.50, "status": "confirmed", "time": "Yesterday"},
    {"id": "tx_1001", "type": "staking", "asset": "BALMZ", "description": "BALMZ staking reward", "amount": 86.40, "status": "confirmed", "time": "Yesterday"},
]


class TransferRequest(BaseModel):
    asset: str = Field(min_length=2, max_length=12)
    amount: float = Field(gt=0)
    recipient: str = Field(min_length=4, max_length=128)
    network: str = Field(default="mainnet", min_length=3, max_length=32)
    note: str | None = Field(default=None, max_length=200)


class WithdrawalRequest(BaseModel):
    asset: str = Field(min_length=2, max_length=12)
    amount: float = Field(gt=0)
    destination: str = Field(min_length=4, max_length=128)
    network: str = Field(default="mainnet", min_length=3, max_length=32)
    note: str | None = Field(default=None, max_length=200)


@app.get("/")
def root():
    return {"status": "World Wallet AI API running", "version": "0.5.0"}


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.get("/api/v1/wallet")
def wallet():
    return {"wallet": WALLET_SUMMARY, "assets": ASSETS}


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


@app.get("/api/v1/transactions")
def transactions():
    return {"transactions": TRANSACTIONS}


def validate_asset_amount(asset: str, amount: float):
    symbol = asset.upper()
    supported = next((item for item in ASSETS if item["symbol"] == symbol), None)

    if supported is None:
        return symbol, None, {"status": "rejected", "reason": "Unsupported asset", "asset": symbol}

    if amount > supported["balance"]:
        return symbol, supported, {
            "status": "rejected",
            "reason": "Insufficient available asset balance",
            "asset": symbol,
            "available": supported["balance"],
            "requested": amount,
        }

    return symbol, supported, None


@app.post("/api/v1/transfers")
def create_transfer(request: TransferRequest):
    asset, supported, rejection = validate_asset_amount(request.asset, request.amount)

    if rejection:
        return rejection

    transfer_id = f"transfer_demo_{len(TRANSACTIONS) + 1:04d}"
    return {
        "status": "pending",
        "mode": "demo",
        "transfer": {
            "id": transfer_id,
            "type": "send",
            "asset": asset,
            "amount": request.amount,
            "recipient": request.recipient,
            "network": request.network,
            "note": request.note,
            "message": "Transfer request accepted for review; no blockchain transaction has been broadcast.",
        },
    }


@app.post("/api/v1/withdrawals")
def create_withdrawal(request: WithdrawalRequest):
    asset, supported, rejection = validate_asset_amount(request.asset, request.amount)

    if rejection:
        return rejection

    withdrawal_id = f"withdrawal_demo_{len(TRANSACTIONS) + 1:04d}"
    return {
        "status": "pending_review",
        "mode": "demo",
        "withdrawal": {
            "id": withdrawal_id,
            "type": "withdrawal",
            "asset": asset,
            "amount": request.amount,
            "destination": request.destination,
            "network": request.network,
            "note": request.note,
            "message": "Withdrawal request received for review; no blockchain transaction has been broadcast.",
        },
    }
