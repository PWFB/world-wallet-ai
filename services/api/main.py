import os
import hashlib
from datetime import datetime, timezone

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token
from pydantic import BaseModel, Field
import httpx

app = FastAPI(title="World Wallet AI API", version="0.9.0")

DATABASE_URL = os.getenv("DATABASE_URL", "")
SESSION_TOKEN = os.getenv("WORLD_WALLET_SESSION_TOKEN", "")
IDENTITY_EMAIL = os.getenv("WORLD_WALLET_DEMO_EMAIL", "")
IDENTITY_PASSWORD = os.getenv("WORLD_WALLET_DEMO_PASSWORD", "")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


class LoginRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=1, max_length=128)


class GoogleLoginRequest(BaseModel):
    credential: str = Field(min_length=20, max_length=10000)


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


def db():
    if not DATABASE_URL:
        raise HTTPException(status_code=503, detail="World Wallet database is not configured")
    return psycopg.connect(DATABASE_URL)


def sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def init_db():
    if not DATABASE_URL:
        return
    with db() as conn:
        conn.execute("""
        CREATE TABLE IF NOT EXISTS users(
          id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
          password_sha256 TEXT, google_subject TEXT UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS wallets(
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
          currency TEXT NOT NULL DEFAULT 'USD', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS assets(
          wallet_id TEXT NOT NULL REFERENCES wallets(id), symbol TEXT NOT NULL, name TEXT NOT NULL,
          balance NUMERIC(36,18) NOT NULL DEFAULT 0, price_usd NUMERIC(36,18) NOT NULL DEFAULT 0, PRIMARY KEY(wallet_id,symbol)
        );
        CREATE TABLE IF NOT EXISTS transactions(
          id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES wallets(id), type TEXT NOT NULL,
          asset TEXT NOT NULL, description TEXT NOT NULL, amount NUMERIC(36,18) NOT NULL,
          status TEXT NOT NULL, destination TEXT, network TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """)
        conn.commit()


def get_user(email: str):
    with db() as conn:
        row = conn.execute("SELECT id,email,name FROM users WHERE lower(email)=lower(%s)", (email,)).fetchone()
        if not row:
            return None
        wallet = conn.execute("SELECT id FROM wallets WHERE owner_id=%s", (row[0],)).fetchone()
        return {"id": row[0], "email": row[1], "name": row[2], "wallet_id": wallet[0] if wallet else None}


def provision_identity(email: str, password: str | None = None, name: str = "World Wallet User", google_subject: str | None = None):
    user = get_user(email)
    with db() as conn:
        if user:
            conn.execute("UPDATE users SET name=%s, google_subject=COALESCE(%s,google_subject) WHERE id=%s", (name, google_subject, user["id"]))
        else:
            user_id = "usr_" + sha(email.lower())[:24]
            conn.execute("INSERT INTO users(id,email,name,password_sha256,google_subject) VALUES(%s,%s,%s,%s,%s)",
                         (user_id,email,name,sha(password) if password else None,google_subject))
            wallet_id = "wallet_" + sha(user_id)[:24]
            conn.execute("INSERT INTO wallets(id,owner_id) VALUES(%s,%s)", (wallet_id,user_id))
            for symbol,asset_name in [("BALMZ","BALMZ Token"),("USDT","Tether USD"),("ETH","Ethereum"),("BNB","BNB")]:
                conn.execute("INSERT INTO assets(wallet_id,symbol,name,balance,price_usd) VALUES(%s,%s,%s,0,0)", (wallet_id,symbol,asset_name))
        conn.commit()
    return get_user(email)


def current_user(authorization: str | None = Header(default=None)):
    if not SESSION_TOKEN or not authorization or authorization != "Bearer " + SESSION_TOKEN:
        raise HTTPException(status_code=401, detail="Authentication required")
    if not IDENTITY_EMAIL:
        raise HTTPException(status_code=503, detail="World Wallet identity is not configured")
    user = get_user(IDENTITY_EMAIL)
    if not user:
        raise HTTPException(status_code=401, detail="Wallet user not found")
    return user


def session(user):
    if not SESSION_TOKEN:
        raise HTTPException(status_code=503, detail="World Wallet session signing is not configured")
    return {"access_token": SESSION_TOKEN, "token_type": "bearer", "user": user, "mode": "database"}


def wallet_snapshot(user):
    with db() as conn:
        assets = []
        for symbol,name,balance,price in conn.execute("SELECT symbol,name,balance,price_usd FROM assets WHERE wallet_id=%s ORDER BY symbol", (user["wallet_id"],)):
            assets.append({"symbol":symbol,"name":name,"balance":float(balance),"price_usd":float(price or 0),"value_usd":float(balance)*float(price or 0),"change_24h":0})
        txs = []
        for row in conn.execute("SELECT id,type,asset,description,amount,status,created_at FROM transactions WHERE wallet_id=%s ORDER BY created_at DESC LIMIT 100", (user["wallet_id"],)):
            txs.append({"id":row[0],"type":row[1],"asset":row[2],"description":row[3],"amount":float(row[4]),"status":row[5],"time":row[6].isoformat()})
    total = sum(x["value_usd"] for x in assets)
    return assets,txs,{"available_balance_usd":total,"total_received_usd":sum(x["amount"] for x in txs if x["type"]=="received"),"total_sent_usd":abs(sum(x["amount"] for x in txs if x["type"] in ("sent","withdrawal") and x["amount"]<0)),"profit_usd":0,"change_24h":0}


@app.on_event("startup")
def startup():
    init_db()
    if DATABASE_URL and IDENTITY_EMAIL and IDENTITY_PASSWORD:
        provision_identity(IDENTITY_EMAIL, IDENTITY_PASSWORD)


@app.get("/")
def root():
    return {"status":"World Wallet AI API running","version":"0.9.0","data_source":"postgresql"}


@app.get("/health")
def health():
    return {"status":"ok","database_configured":bool(DATABASE_URL)}


@app.post("/api/v1/auth/login")
def login(request: LoginRequest):
    if request.email.strip().lower() != IDENTITY_EMAIL.lower() or request.password != IDENTITY_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    user = provision_identity(IDENTITY_EMAIL, IDENTITY_PASSWORD)
    return session(user)


@app.post("/api/v1/auth/google")
def google_login(request: GoogleLoginRequest):
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=503, detail="Google Sign-In is not configured on the server")
    try:
        claims = id_token.verify_oauth2_token(request.credential, google_requests.Request(), GOOGLE_CLIENT_ID)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid Google identity token") from exc
    if claims.get("iss") not in {"accounts.google.com","https://accounts.google.com"} or claims.get("email_verified") is not True:
        raise HTTPException(status_code=401, detail="Invalid or unverified Google identity")
    email = str(claims.get("email","")).strip().lower()
    if email != IDENTITY_EMAIL.strip().lower():
        raise HTTPException(status_code=403, detail="This Google account is not linked to this World Wallet")
    user = provision_identity(email, name=claims.get("name") or "World Wallet User", google_subject=claims.get("sub"))
    return {**session(user),"mode":"google","provider":"google"}


@app.get("/api/v1/auth/me")
def auth_me(user: dict = Depends(current_user)):
    return {"user":user,"mode":"database"}


@app.get("/api/v1/wallet")
def wallet(user: dict = Depends(current_user)):
    assets,_,summary = wallet_snapshot(user)
    return {"user":user,"wallet":{**summary,"wallet_id":user["wallet_id"],"owner_id":user["id"]},"assets":assets}


@app.post("/api/v1/prices/refresh")
def refresh_prices(user: dict = Depends(current_user)):
    coin_ids = {"USDT":"tether","ETH":"ethereum","BNB":"binancecoin"}
    try:
        response = httpx.get(
            "https://api.coingecko.com/api/v3/simple/price",
            params={"ids":",".join(coin_ids.values()),"vs_currencies":"usd"},
            timeout=8,
        )
        response.raise_for_status()
        raw = response.json()
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Live market price service unavailable") from exc
    with db() as conn:
        for symbol, coin_id in coin_ids.items():
            price = float(raw.get(coin_id, {}).get("usd", 0))
            conn.execute("UPDATE assets SET price_usd=%s WHERE wallet_id=%s AND symbol=%s", (price,user["wallet_id"],symbol))
        conn.commit()
    assets, _, summary = wallet_snapshot(user)
    return {"assets":assets,"wallet":summary,"source":"coingecko"}

@app.get("/api/v1/assets")
def assets(user: dict = Depends(current_user)):
    a,_,_ = wallet_snapshot(user)
    return {"assets":a}


@app.get("/api/v1/portfolio/performance")
def performance(user: dict = Depends(current_user)):
    _,_,summary = wallet_snapshot(user)
    return {"currency":"USD","period":"all","change_percent":summary["change_24h"],"points":[{"label":"Current","value_usd":summary["available_balance_usd"]}]}


@app.get("/api/v1/transactions")
def transactions(user: dict = Depends(current_user)):
    _,tx,_ = wallet_snapshot(user)
    return {"transactions":tx}


def reserve_asset(user, symbol: str, amount: float):
    with db() as conn:
        row = conn.execute("SELECT balance FROM assets WHERE wallet_id=%s AND symbol=%s FOR UPDATE", (user["wallet_id"],symbol)).fetchone()
        if not row:
            conn.rollback()
            return {"status":"rejected","reason":"Unsupported asset","asset":symbol}
        if amount > float(row[0]):
            conn.rollback()
            return {"status":"rejected","reason":"Insufficient available asset balance","asset":symbol,"available":float(row[0]),"requested":amount}
        conn.execute("UPDATE assets SET balance=balance-%s WHERE wallet_id=%s AND symbol=%s",(amount,user["wallet_id"],symbol))
        return conn


@app.post("/api/v1/transfers")
def transfer(request: TransferRequest, user: dict = Depends(current_user)):
    symbol=request.asset.upper()
    with db() as conn:
        row=conn.execute("SELECT balance FROM assets WHERE wallet_id=%s AND symbol=%s FOR UPDATE",(user["wallet_id"],symbol)).fetchone()
        if not row: return {"status":"rejected","reason":"Unsupported asset","asset":symbol}
        if request.amount > float(row[0]): return {"status":"rejected","reason":"Insufficient available asset balance","asset":symbol,"available":float(row[0]),"requested":request.amount}
        txid="tx_"+sha(user["wallet_id"]+datetime.now(timezone.utc).isoformat())[:24]
        conn.execute("UPDATE assets SET balance=balance-%s WHERE wallet_id=%s AND symbol=%s",(request.amount,user["wallet_id"],symbol))
        conn.execute("INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network) VALUES(%s,%s,'sent',%s,%s,%s,'pending',%s,%s)",(txid,user["wallet_id"],symbol,"Transfer request",-request.amount,request.recipient,request.network))
        conn.commit()
    return {"status":"pending","mode":"database","transfer":{"id":txid,"asset":symbol,"amount":request.amount,"recipient":request.recipient,"network":request.network}}


@app.post("/api/v1/withdrawals")
def withdrawal(request: WithdrawalRequest, user: dict = Depends(current_user)):
    symbol=request.asset.upper()
    with db() as conn:
        row=conn.execute("SELECT balance FROM assets WHERE wallet_id=%s AND symbol=%s FOR UPDATE",(user["wallet_id"],symbol)).fetchone()
        if not row: return {"status":"rejected","reason":"Unsupported asset","asset":symbol}
        if request.amount > float(row[0]): return {"status":"rejected","reason":"Insufficient available asset balance","asset":symbol,"available":float(row[0]),"requested":request.amount}
        txid="tx_"+sha(user["wallet_id"]+datetime.now(timezone.utc).isoformat())[:24]
        conn.execute("UPDATE assets SET balance=balance-%s WHERE wallet_id=%s AND symbol=%s",(request.amount,user["wallet_id"],symbol))
        conn.execute("INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network) VALUES(%s,%s,'withdrawal',%s,%s,%s,'pending_review',%s,%s)",(txid,user["wallet_id"],symbol,"Withdrawal request",-request.amount,request.destination,request.network))
        conn.commit()
    return {"status":"pending_review","mode":"database","withdrawal":{"id":txid,"asset":symbol,"amount":request.amount,"destination":request.destination,"network":request.network}}
