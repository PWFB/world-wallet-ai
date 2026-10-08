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
import jwt
from jwt import PyJWKClient

app = FastAPI(title="World Wallet AI API", version="1.0.0")

DATABASE_URL = os.getenv("DATABASE_URL", "")
SESSION_TOKEN = os.getenv("WORLD_WALLET_SESSION_TOKEN", "")
IDENTITY_EMAIL = os.getenv("WORLD_WALLET_DEMO_EMAIL", "")
IDENTITY_PASSWORD = os.getenv("WORLD_WALLET_DEMO_PASSWORD", "")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
NEON_AUTH_BASE_URL = os.getenv("NEON_AUTH_BASE_URL", "").strip()
NEON_AUTH_JWKS_URL = os.getenv("NEON_AUTH_JWKS_URL", "").strip()
NEON_JWKS_CLIENT = PyJWKClient(NEON_AUTH_JWKS_URL) if NEON_AUTH_JWKS_URL else None
EVM_WALLET_ADDRESS = os.getenv("WORLD_WALLET_EVM_ADDRESS", "").strip()
ETH_RPC_URL = os.getenv("WORLD_WALLET_ETH_RPC_URL", "").strip()
BSC_RPC_URL = os.getenv("WORLD_WALLET_BSC_RPC_URL", "").strip()
BTC_ADDRESS = os.getenv("WORLD_WALLET_BTC_ADDRESS", "").strip()
USDT_ETH_CONTRACT = os.getenv("WORLD_WALLET_USDT_ETH_CONTRACT", "").strip()
USDT_BSC_CONTRACT = os.getenv("WORLD_WALLET_USDT_BSC_CONTRACT", "").strip()

TRUSTED_ORIGINS = [origin.strip() for origin in os.getenv("WORLD_WALLET_ALLOWED_ORIGINS", "").split(",") if origin.strip()]
if not TRUSTED_ORIGINS:
    TRUSTED_ORIGINS = ["https://world-wallet-ai-frontend.onrender.com", "http://localhost:5173", "http://localhost:4173"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=TRUSTED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


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
        CREATE TABLE IF NOT EXISTS wallet_addresses(
          wallet_id TEXT NOT NULL REFERENCES wallets(id), network TEXT NOT NULL, address TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT 'primary', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(wallet_id,network)
        );
        CREATE TABLE IF NOT EXISTS transactions(
          id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES wallets(id), type TEXT NOT NULL,
          asset TEXT NOT NULL, description TEXT NOT NULL, amount NUMERIC(36,18) NOT NULL,
          status TEXT NOT NULL, destination TEXT, network TEXT, tx_hash TEXT, confirmations INTEGER NOT NULL DEFAULT 0,
          block_height INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tx_hash TEXT;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS confirmations INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS block_height INTEGER;
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
            wallet_id = user["wallet_id"]
        else:
            user_id = "usr_" + sha(email.lower())[:24]
            conn.execute("INSERT INTO users(id,email,name,password_sha256,google_subject) VALUES(%s,%s,%s,%s,%s)",
                         (user_id,email,name,sha(password) if password else None,google_subject))
            wallet_id = "wallet_" + sha(user_id)[:24]
            conn.execute("INSERT INTO wallets(id,owner_id) VALUES(%s,%s)", (wallet_id,user_id))
        for symbol,asset_name in [("BALMZ","BALMZ Token"),("BTC","Bitcoin"),("USDT","Tether USD"),("ETH","Ethereum"),("BNB","BNB")]:
            conn.execute(
                "INSERT INTO assets(wallet_id,symbol,name,balance,price_usd) VALUES(%s,%s,%s,0,0) ON CONFLICT(wallet_id,symbol) DO NOTHING",
                (wallet_id,symbol,asset_name)
            )
        conn.commit()
    return get_user(email)


def neon_auth_user(token: str):
    if not NEON_JWKS_CLIENT:
        raise HTTPException(status_code=503, detail="Neon Auth is not configured on the server")
    try:
        signing_key = NEON_JWKS_CLIENT.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["EdDSA"],
            options={"verify_aud": False},
        )
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Invalid Neon Auth session") from exc

    subject = str(claims.get("sub") or "").strip()
    email = str(claims.get("email") or "").strip().lower()
    if not subject or not email:
        raise HTTPException(status_code=401, detail="Neon Auth token has no user identity")
    issuer = str(claims.get("iss") or "").strip()
    if issuer and NEON_AUTH_BASE_URL and issuer.rstrip("/") != NEON_AUTH_BASE_URL.rstrip("/"):
        raise HTTPException(status_code=401, detail="Invalid Neon Auth issuer")

    name = str(claims.get("name") or "World Wallet User").strip() or "World Wallet User"
    user = get_user(email)
    if not user:
        user = provision_identity(email, name=name, google_subject=subject)
    else:
        with db() as conn:
            conn.execute(
                "UPDATE users SET name=%s, google_subject=COALESCE(%s,google_subject) WHERE id=%s",
                (name, subject, user["id"]),
            )
            conn.commit()
        user = get_user(email)
    return user


def current_user(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    token = authorization[7:].strip()
    if SESSION_TOKEN and token == SESSION_TOKEN:
        if not IDENTITY_EMAIL:
            raise HTTPException(status_code=503, detail="World Wallet identity is not configured")
        user = get_user(IDENTITY_EMAIL)
        if not user:
            raise HTTPException(status_code=401, detail="Wallet user not found")
        return user
    return neon_auth_user(token)


def session(user):
    if not SESSION_TOKEN:
        raise HTTPException(status_code=503, detail="World Wallet session signing is not configured")
    return {"access_token": SESSION_TOKEN, "token_type": "bearer", "user": user, "mode": "database"}


def valid_evm_address(address: str) -> bool:
    return len(address) == 42 and address.startswith("0x") and all(c in "0123456789abcdefABCDEF" for c in address[2:])


def configured_addresses(user):
    addresses = []
    if EVM_WALLET_ADDRESS and valid_evm_address(EVM_WALLET_ADDRESS):
        with db() as conn:
            rows = conn.execute("SELECT network,address,label FROM wallet_addresses WHERE wallet_id=%s ORDER BY network", (user["wallet_id"],)).fetchall()
            if not rows:
                for network in ("ethereum", "bnb"):
                    conn.execute("INSERT INTO wallet_addresses(wallet_id,network,address) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING", (user["wallet_id"], network, EVM_WALLET_ADDRESS))
                conn.commit()
                rows = conn.execute("SELECT network,address,label FROM wallet_addresses WHERE wallet_id=%s ORDER BY network", (user["wallet_id"],)).fetchall()
            addresses.extend({"network":r[0],"address":r[1],"label":r[2]} for r in rows)
    if BTC_ADDRESS:
        addresses.append({"network":"bitcoin","address":BTC_ADDRESS,"label":"primary"})
    return addresses


def rpc_call(url: str, method: str, params: list):
    if not url:
        return None
    response = httpx.post(url, json={"jsonrpc":"2.0","id":1,"method":method,"params":params}, timeout=10)
    response.raise_for_status()
    payload = response.json()
    if payload.get("error"):
        raise ValueError(payload["error"].get("message","RPC error"))
    return payload.get("result")


def evm_balance(url: str, address: str):
    raw = rpc_call(url, "eth_getBalance", [address, "latest"])
    return int(raw, 16) / 10**18 if raw else 0.0


def btc_balance(address: str):
    if not address:
        return None
    response = httpx.get(f"https://blockstream.info/api/address/{address}", timeout=10)
    response.raise_for_status()
    data = response.json()
    chain = data.get("chain_stats", {})
    mempool = data.get("mempool_stats", {})
    confirmed = int(chain.get("funded_txo_sum", 0)) - int(chain.get("spent_txo_sum", 0))
    pending = int(mempool.get("funded_txo_sum", 0)) - int(mempool.get("spent_txo_sum", 0))
    return (confirmed + pending) / 100_000_000

def erc20_balance(url: str, contract: str, address: str):
    if not contract or not valid_evm_address(contract):
        return None
    data = "0x70a08231" + address[2:].lower().rjust(64, "0")
    raw = rpc_call(url, "eth_call", [{"to":contract,"data":data}, "latest"])
    return int(raw, 16) / 10**6 if raw else 0.0



def bitcoin_address_transactions(address: str):
    if not address:
        return []
    response = httpx.get(f"https://blockstream.info/api/address/{address}/txs", timeout=15)
    response.raise_for_status()
    txs = response.json()
    tip_response = httpx.get("https://blockstream.info/api/blocks/tip/height", timeout=10)
    tip_response.raise_for_status()
    tip_height = int(tip_response.text.strip())
    results = []
    for tx in txs:
        received = sum(int(v.get("value", 0)) for v in tx.get("vout", []) if v.get("scriptpubkey_address") == address)
        spent = sum(int((v.get("prevout") or {}).get("value", 0)) for v in tx.get("vin", []) if (v.get("prevout") or {}).get("scriptpubkey_address") == address)
        net_sats = received - spent
        if net_sats == 0:
            continue
        status = tx.get("status") or {}
        confirmed = bool(status.get("confirmed"))
        block_height = status.get("block_height")
        confirmations = max(0, tip_height - int(block_height) + 1) if confirmed and block_height else 0
        results.append({"tx_hash":tx.get("txid"),"amount":net_sats/100_000_000,"type":"received" if net_sats > 0 else "sent","status":"confirmed" if confirmed else "pending","confirmations":confirmations,"block_height":block_height})
    return results

def sync_bitcoin_transactions(user):
    if not BTC_ADDRESS:
        return []
    try:
        chain_txs = bitcoin_address_transactions(BTC_ADDRESS)
    except Exception:
        return []
    imported = []
    with db() as conn:
        for item in chain_txs:
            tx_hash = item["tx_hash"]
            if not tx_hash:
                continue
            existing = conn.execute("SELECT id FROM transactions WHERE wallet_id=%s AND tx_hash=%s",(user["wallet_id"],tx_hash)).fetchone()
            tx_id = existing[0] if existing else "btc_" + tx_hash
            description = "Bitcoin transaction " + tx_hash[:12] + "…"
            if existing:
                conn.execute("UPDATE transactions SET type=%s,asset='BTC',description=%s,amount=%s,status=%s,network='bitcoin',confirmations=%s,block_height=%s WHERE id=%s",(item["type"],description,item["amount"],item["status"],item["confirmations"],item["block_height"],tx_id))
            else:
                conn.execute("INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network,tx_hash,confirmations,block_height) VALUES(%s,%s,%s,'BTC',%s,%s,%s,%s,'bitcoin',%s,%s,%s)",(tx_id,user["wallet_id"],item["type"],description,item["amount"],item["status"],BTC_ADDRESS,item["tx_hash"],item["confirmations"],item["block_height"]))
            imported.append(item)
        conn.commit()
    return imported

def wallet_snapshot(user):
    with db() as conn:
        assets = []
        for symbol,name,balance,price in conn.execute("SELECT symbol,name,balance,price_usd FROM assets WHERE wallet_id=%s ORDER BY symbol", (user["wallet_id"],)):
            assets.append({"symbol":symbol,"name":name,"balance":float(balance),"price_usd":float(price or 0),"value_usd":float(balance)*float(price or 0),"change_24h":0})
        txs = []
        for row in conn.execute("SELECT id,type,asset,description,amount,status,tx_hash,confirmations,block_height,network,created_at FROM transactions WHERE wallet_id=%s ORDER BY created_at DESC LIMIT 100", (user["wallet_id"],)):
            txs.append({"id":row[0],"type":row[1],"asset":row[2],"description":row[3],"amount":float(row[4]),"status":row[5],"tx_hash":row[6],"confirmations":int(row[7] or 0),"block_height":row[8],"network":row[9],"time":row[10].isoformat()})
    total = sum(x["value_usd"] for x in assets)
    prices = {x["symbol"]: x["price_usd"] for x in assets}
    total_received = sum(abs(x["amount"]) * prices.get(x["asset"], 0) for x in txs if x["type"] == "received")
    total_sent = sum(abs(x["amount"]) * prices.get(x["asset"], 0) for x in txs if x["type"] in ("sent", "withdrawal") and x["amount"] < 0)
    return assets,txs,{"available_balance_usd":total,"total_received_usd":total_received,"total_sent_usd":total_sent,"profit_usd":0,"change_24h":0}


@app.on_event("startup")
def startup():
    init_db()
    if DATABASE_URL and IDENTITY_EMAIL and IDENTITY_PASSWORD:
        provision_identity(IDENTITY_EMAIL, IDENTITY_PASSWORD)


@app.get("/")
def root():
    return {"status":"World Wallet AI API running","version":"1.0.0","data_source":"postgresql","chain_data":"configured_wallets_only"}


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
    return {"user":user,"mode":"neon_auth" if NEON_JWKS_CLIENT else "database"}


@app.get("/api/v1/wallet")
def wallet(user: dict = Depends(current_user)):
    assets,_,summary = wallet_snapshot(user)
    return {"user":user,"wallet":{**summary,"wallet_id":user["wallet_id"],"owner_id":user["id"]},"assets":assets}


@app.get("/api/v1/wallet/addresses")
def wallet_addresses(user: dict = Depends(current_user)):
    addresses = configured_addresses(user)
    return {"addresses": addresses, "configured": bool(addresses), "message": None if addresses else "No production wallet address is configured yet"}


@app.post("/api/v1/wallet/sync")
def sync_wallet(user: dict = Depends(current_user)):
    evm_addresses = [a for a in configured_addresses(user) if a["network"] in ("ethereum", "bnb")]
    address = evm_addresses[0]["address"] if evm_addresses else None
    if not BTC_ADDRESS and not address:
        raise HTTPException(status_code=503, detail="No production wallet address is configured")
    updates = []
    warnings = []
    with db() as conn:
        if BTC_ADDRESS:
            try:
                btc = btc_balance(BTC_ADDRESS)
                if btc is not None:
                    conn.execute("UPDATE assets SET balance=%s WHERE wallet_id=%s AND symbol='BTC'", (btc,user["wallet_id"]))
                    updates.append({"network":"bitcoin","asset":"BTC","balance":btc})
            except Exception:
                warnings.append("Bitcoin balance service unavailable")
        if ETH_RPC_URL and address:
            try:
                eth = evm_balance(ETH_RPC_URL, address)
                conn.execute("UPDATE assets SET balance=%s WHERE wallet_id=%s AND symbol='ETH'", (eth,user["wallet_id"]))
                updates.append({"network":"ethereum","asset":"ETH","balance":eth})
                usdt = erc20_balance(ETH_RPC_URL, USDT_ETH_CONTRACT, address)
                if usdt is not None:
                    conn.execute("UPDATE assets SET balance=%s WHERE wallet_id=%s AND symbol='USDT'", (usdt,user["wallet_id"]))
                    updates.append({"network":"ethereum","asset":"USDT","balance":usdt})
            except Exception:
                warnings.append("Ethereum balance service unavailable")
        if BSC_RPC_URL and address:
            try:
                bnb = evm_balance(BSC_RPC_URL, address)
                conn.execute("UPDATE assets SET balance=%s WHERE wallet_id=%s AND symbol='BNB'", (bnb,user["wallet_id"]))
                updates.append({"network":"bnb","asset":"BNB","balance":bnb})
                usdt = erc20_balance(BSC_RPC_URL, USDT_BSC_CONTRACT, address)
                if usdt is not None:
                    conn.execute("UPDATE assets SET balance=%s WHERE wallet_id=%s AND symbol='USDT'", (usdt,user["wallet_id"]))
                    updates.append({"network":"bnb","asset":"USDT","balance":usdt})
            except Exception:
                warnings.append("BNB Chain balance service unavailable")
        conn.commit()
    imported_transactions = sync_bitcoin_transactions(user)
    assets, all_transactions, summary = wallet_snapshot(user)
    if BTC_ADDRESS and not imported_transactions:
        # An empty result can be a legitimate zero-transaction wallet; do not label it
        # as an error because the balance and transaction endpoint may still be healthy.
        pass
    return {"status":"synced_with_warnings" if warnings else "synced","wallet":{**summary,"wallet_id":user["wallet_id"],"owner_id":user["id"]},"assets":assets,"updates":updates,"warnings":warnings,"bitcoin_transactions":imported_transactions,"transactions":all_transactions}


@app.post("/api/v1/prices/refresh")
def refresh_prices(user: dict = Depends(current_user)):
    coin_ids = {"BTC":"bitcoin","USDT":"tether","ETH":"ethereum","BNB":"binancecoin"}
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
        market_prices = {}
        for symbol, coin_id in coin_ids.items():
            market_prices[symbol] = float(raw.get(coin_id, {}).get("usd", 0))
        # BALMZ is intentionally priced at the current ETH price in World Wallet AI.
        # This is an application pricing rule, not an external-market claim.
        market_prices["BALMZ"] = market_prices.get("ETH", 0.0)
        for symbol, price in market_prices.items():
            conn.execute("UPDATE assets SET price_usd=%s WHERE wallet_id=%s AND symbol=%s", (price,user["wallet_id"],symbol))
        conn.commit()
    assets, _, summary = wallet_snapshot(user)
    return {"assets":assets,"wallet":summary,"source":"coingecko+world_wallet_balmz_eth_price_rule","balmz_price_usd":market_prices["BALMZ"]}

@app.post("/api/v1/wallet/refresh")
def refresh_wallet(user: dict = Depends(current_user)):
    started_at = datetime.now(timezone.utc)
    updates = []
    sync_error = None
    price_error = None

    try:
        sync_result = sync_wallet(user)
        updates = sync_result.get("updates", [])
        bitcoin_transactions = sync_result.get("bitcoin_transactions", [])
    except HTTPException as exc:
        sync_result = {}
        bitcoin_transactions = []
        sync_error = str(exc.detail)
    except Exception:
        sync_result = {}
        bitcoin_transactions = []
        sync_error = "Wallet chain synchronization failed"

    try:
        price_result = refresh_prices(user)
    except HTTPException as exc:
        price_result = {}
        price_error = str(exc.detail)
    except Exception:
        price_result = {}
        price_error = "Live market price refresh failed"

    assets_now, transactions_now, summary_now = wallet_snapshot(user)
    warnings = [x for x in (sync_error, price_error) if x]
    return {
        "status": "refreshed_with_warnings" if warnings else "refreshed",
        "wallet": {**summary_now, "wallet_id": user["wallet_id"], "owner_id": user["id"]},
        "assets": assets_now,
        "transactions": transactions_now,
        "updates": updates,
        "bitcoin_transactions": bitcoin_transactions,
        "price_source": price_result.get("source"),
        "warnings": warnings,
        "refreshed_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000),
    }

@app.get("/api/v1/system/status")
def system_status(user: dict = Depends(current_user)):
    return {
        "status": "ok",
        "database": bool(DATABASE_URL),
        "neon_auth": bool(NEON_JWKS_CLIENT),
        "bitcoin": bool(BTC_ADDRESS),
        "ethereum": bool(EVM_WALLET_ADDRESS and ETH_RPC_URL),
        "bnb": bool(EVM_WALLET_ADDRESS and BSC_RPC_URL),
        "live_prices": True,
        "read_only_chain_sync": True,
        "transaction_broadcast": False,
    }

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

@app.post("/api/v1/transactions/sync")
def sync_transactions(user: dict = Depends(current_user)):
    if not BTC_ADDRESS:
        raise HTTPException(status_code=503, detail="No production Bitcoin wallet address is configured")
    balance = None
    try:
        balance = btc_balance(BTC_ADDRESS)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Bitcoin blockchain balance service unavailable") from exc
    if balance is not None:
        with db() as conn:
            conn.execute("UPDATE assets SET balance=%s WHERE wallet_id=%s AND symbol='BTC'", (balance,user["wallet_id"]))
            conn.commit()
    imported = sync_bitcoin_transactions(user)
    assets,tx,summary = wallet_snapshot(user)
    return {"status":"synced","imported":imported,"transactions":tx,"assets":assets,"wallet":{**summary,"wallet_id":user["wallet_id"],"owner_id":user["id"]}}


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
    symbol=request.asset.upper().strip()
    network=request.network.strip().lower()
    if network not in {"mainnet", "ethereum", "bnb", "bitcoin"}:
        raise HTTPException(status_code=400, detail="Unsupported network")
    if symbol not in {"BALMZ", "BTC", "USDT", "ETH", "BNB"}:
        raise HTTPException(status_code=400, detail="Unsupported asset")
    with db() as conn:
        row=conn.execute("SELECT balance FROM assets WHERE wallet_id=%s AND symbol=%s FOR UPDATE",(user["wallet_id"],symbol)).fetchone()
        if not row: return {"status":"rejected","reason":"Unsupported asset","asset":symbol}
        if request.amount > float(row[0]): return {"status":"rejected","reason":"Insufficient available asset balance","asset":symbol,"available":float(row[0]),"requested":request.amount}
        txid="tx_"+sha(user["wallet_id"]+datetime.now(timezone.utc).isoformat())[:24]
        conn.execute("UPDATE assets SET balance=balance-%s WHERE wallet_id=%s AND symbol=%s",(request.amount,user["wallet_id"],symbol))
        conn.execute("INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network) VALUES(%s,%s,'sent',%s,%s,%s,'pending',%s,%s)",(txid,user["wallet_id"],symbol,"Transfer request",-request.amount,request.recipient,network))
        conn.commit()
    return {"status":"pending","mode":"database","transfer":{"id":txid,"asset":symbol,"amount":request.amount,"recipient":request.recipient,"network":network}}


@app.post("/api/v1/withdrawals")
def withdrawal(request: WithdrawalRequest, user: dict = Depends(current_user)):
    symbol=request.asset.upper().strip()
    network=request.network.strip().lower()
    if network not in {"mainnet", "ethereum", "bnb", "bitcoin"}:
        raise HTTPException(status_code=400, detail="Unsupported network")
    if symbol not in {"BALMZ", "BTC", "USDT", "ETH", "BNB"}:
        raise HTTPException(status_code=400, detail="Unsupported asset")
    with db() as conn:
        row=conn.execute("SELECT balance FROM assets WHERE wallet_id=%s AND symbol=%s FOR UPDATE",(user["wallet_id"],symbol)).fetchone()
        if not row: return {"status":"rejected","reason":"Unsupported asset","asset":symbol}
        if request.amount > float(row[0]): return {"status":"rejected","reason":"Insufficient available asset balance","asset":symbol,"available":float(row[0]),"requested":request.amount}
        txid="tx_"+sha(user["wallet_id"]+datetime.now(timezone.utc).isoformat())[:24]
        conn.execute("UPDATE assets SET balance=balance-%s WHERE wallet_id=%s AND symbol=%s",(request.amount,user["wallet_id"],symbol))
        conn.execute("INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network) VALUES(%s,%s,'withdrawal',%s,%s,%s,'pending_review',%s,%s)",(txid,user["wallet_id"],symbol,"Withdrawal request",-request.amount,request.destination,network))
        conn.commit()
    return {"status":"pending_review","mode":"database","withdrawal":{"id":txid,"asset":symbol,"amount":request.amount,"destination":request.destination,"network":request.network}}
