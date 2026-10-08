import os
import hashlib
from datetime import datetime, timezone
from decimal import Decimal

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token
from pydantic import BaseModel, Field
import httpx
import jwt
from jwt import PyJWKClient
from Crypto.Hash import keccak

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
    amount: Decimal = Field(gt=0, max_digits=36, decimal_places=18)
    recipient: str = Field(min_length=4, max_length=128)
    network: str = Field(min_length=3, max_length=32)
    note: str | None = Field(default=None, max_length=200)


class WithdrawalRequest(BaseModel):
    asset: str = Field(min_length=2, max_length=12)
    amount: Decimal = Field(gt=0, max_digits=36, decimal_places=18)
    destination: str = Field(min_length=4, max_length=128)
    network: str = Field(min_length=3, max_length=32)
    note: str | None = Field(default=None, max_length=200)


class RequestCreate(BaseModel):
    kind: str = Field(min_length=2, max_length=32)
    title: str = Field(min_length=2, max_length=120)
    details: str = Field(default="", max_length=1000)


class RequestStatusUpdate(BaseModel):
    request_id: str = Field(min_length=4, max_length=80)
    status: str = Field(min_length=2, max_length=32)


class AddressBookCreate(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    address: str = Field(min_length=4, max_length=128)
    network: str = Field(min_length=2, max_length=32)
    notes: str = Field(default="", max_length=200)


class AddressBookDelete(BaseModel):
    id: str = Field(min_length=4, max_length=80)


class ContractVerifyRequest(BaseModel):
    address: str = Field(min_length=42, max_length=42)
    network: str = Field(min_length=2, max_length=16)


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
          balance NUMERIC(36,18) NOT NULL DEFAULT 0, reserved_balance NUMERIC(36,18) NOT NULL DEFAULT 0, price_usd NUMERIC(36,18) NOT NULL DEFAULT 0, PRIMARY KEY(wallet_id,symbol)
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
        CREATE TABLE IF NOT EXISTS address_book(
          id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES wallets(id),
          label TEXT NOT NULL, address TEXT NOT NULL, network TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(wallet_id,network,address)
        );
        CREATE TABLE IF NOT EXISTS wallet_requests(
          id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES wallets(id),
          kind TEXT NOT NULL, title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tx_hash TEXT;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS confirmations INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS block_height INTEGER;
        ALTER TABLE assets ADD COLUMN IF NOT EXISTS reserved_balance NUMERIC(36,18) NOT NULL DEFAULT 0;
        CREATE TABLE IF NOT EXISTS accounting_migrations(
          wallet_id TEXT NOT NULL REFERENCES wallets(id),
          symbol TEXT NOT NULL,
          migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY(wallet_id,symbol)
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


BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _keccak_hex(value: str) -> str:
    digest = keccak.new(digest_bits=256)
    digest.update(value.encode("ascii"))
    return digest.hexdigest()


def valid_evm_address(address: str) -> bool:
    value = address.strip()
    if len(value) != 42 or not value.startswith(("0x", "0X")):
        return False
    body = value[2:]
    if any(c not in "0123456789abcdefABCDEF" for c in body):
        return False
    # All-lower/all-upper addresses are valid legacy EVM representations.
    if body.islower() or body.isupper() or body.isdigit():
        return True
    lowered = body.lower()
    checksum = _keccak_hex(lowered)
    return all(
        (not c.isalpha()) or (c.isupper() == (int(checksum[i], 16) >= 8))
        for i, c in enumerate(body)
    )


def _base58_decode(value: str):
    if not value or any(c not in BASE58_ALPHABET for c in value):
        return None
    number = 0
    for c in value:
        number = number * 58 + BASE58_ALPHABET.index(c)
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    leading = len(value) - len(value.lstrip("1"))
    return b"\\x00" * leading + raw


def valid_bitcoin_base58(address: str) -> bool:
    raw = _base58_decode(address.strip())
    if not raw or len(raw) != 25:
        return False
    payload, checksum = raw[:-4], raw[-4:]
    return hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4] == checksum and payload[0] in {0, 5}


def _bech32_polymod(values):
    generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for value in values:
        top = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ value
        for i in range(5):
            if (top >> i) & 1:
                chk ^= generator[i]
    return chk


def _bech32_hrp_expand(hrp):
    return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]


def _bech32_decode(address: str):
    if not address or address.lower() != address and address.upper() != address:
        return None
    value = address.lower()
    pos = value.rfind("1")
    if pos < 1 or pos + 7 > len(value) or len(value) > 90:
        return None
    hrp, data = value[:pos], value[pos + 1:]
    try:
        values = [BECH32_CHARSET.index(c) for c in data]
    except ValueError:
        return None
    checksum = _bech32_polymod(_bech32_hrp_expand(hrp) + values)
    if checksum not in {1, 0x2bc830a3}:
        return None
    return hrp, values[:-6], checksum


def _convertbits(data, from_bits, to_bits, pad=False):
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << to_bits) - 1
    for value in data:
        if value < 0 or value >> from_bits:
            return None
        acc = (acc << from_bits) | value
        bits += from_bits
        while bits >= to_bits:
            bits -= to_bits
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (to_bits - bits)) & maxv)
    elif bits >= from_bits or ((acc << (to_bits - bits)) & maxv):
        return None
    return ret


def valid_bitcoin_segwit(address: str) -> bool:
    decoded = _bech32_decode(address.strip())
    if not decoded or decoded[0] != "bc" or not decoded[1]:
        return False
    witness_version = decoded[1][0]
    encoding_constant = decoded[2]
    if witness_version == 0 and encoding_constant != 1:
        return False
    if witness_version > 0 and encoding_constant != 0x2bc830a3:
        return False
    if witness_version > 16:
        return False
    program = _convertbits(decoded[1][1:], 5, 8, False)
    if program is None or not 2 <= len(program) <= 40:
        return False
    if witness_version == 0 and len(program) not in {20, 32}:
        return False
    return True


def valid_bitcoin_address(address: str) -> bool:
    value = address.strip()
    return valid_bitcoin_base58(value) or valid_bitcoin_segwit(value)


def valid_destination_for_network(address: str, network: str) -> bool:
    value = address.strip()
    if network in {"ethereum", "bnb"}:
        return valid_evm_address(value)
    if network == "bitcoin":
        return valid_bitcoin_address(value)
    return False


def validate_asset_network(asset: str, network: str):
    symbol = asset.upper().strip()
    net = network.strip().lower()
    allowed = {
        "ETH": {"ethereum"},
        "BNB": {"bnb"},
        "USDT": {"ethereum", "bnb"},
        "BTC": {"bitcoin"},
        "BALMZ": {"ethereum"},
    }
    if symbol not in allowed or net not in allowed[symbol]:
        raise HTTPException(status_code=400, detail=f"{symbol} is not supported on the {net} network")
    return symbol, net


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
        assets=[]
        for symbol,name,balance,reserved_balance,price in conn.execute(
            "SELECT symbol,name,balance,reserved_balance,price_usd FROM assets WHERE wallet_id=%s ORDER BY symbol",(user["wallet_id"],)
        ):
            actual=Decimal(balance or 0); reserved=Decimal(reserved_balance or 0); available=max(actual-reserved,Decimal("0")); p=Decimal(price or 0)
            assets.append({"symbol":symbol,"name":name,"balance":float(available),"actual_balance":float(actual),
                "reserved_balance":float(reserved),"price_usd":float(p),"value_usd":float(available*p),
                "actual_value_usd":float(actual*p),"change_24h":0})
        txs=[]
        for row in conn.execute("SELECT id,type,asset,description,amount,status,tx_hash,confirmations,block_height,network,created_at FROM transactions WHERE wallet_id=%s ORDER BY created_at DESC LIMIT 100",(user["wallet_id"],)):
            txs.append({"id":row[0],"type":row[1],"asset":row[2],"description":row[3],"amount":float(row[4]),"status":row[5],"tx_hash":row[6],"confirmations":int(row[7] or 0),"block_height":row[8],"network":row[9],"time":row[10].isoformat()})
    prices={x["symbol"]:x["price_usd"] for x in assets}
    return assets,txs,{"available_balance_usd":sum(x["value_usd"] for x in assets),"actual_balance_usd":sum(x["actual_value_usd"] for x in assets),
        "reserved_balance_usd":sum(x["reserved_balance"]*x["price_usd"] for x in assets),
        "total_received_usd":sum(abs(x["amount"])*prices.get(x["asset"],0) for x in txs if x["type"]=="received"),
        "total_sent_usd":sum(abs(x["amount"])*prices.get(x["asset"],0) for x in txs if x["type"] in ("sent","withdrawal") and x["amount"]<0),"profit_usd":0,"change_24h":0}



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




@app.get("/api/v1/wallet/connect")
def wallet_connect(user: dict = Depends(current_user)):
    addresses = configured_addresses(user)
    return {
        "status": "connected" if addresses else "not_configured",
        "mode": "read_only",
        "addresses": addresses,
        "networks": sorted({a["network"] for a in addresses}),
        "message": None if addresses else "No production wallet address is configured yet",
    }


@app.get("/api/v1/request-center")
def request_center(user: dict = Depends(current_user)):
    with db() as conn:
        rows = conn.execute(
            "SELECT id,kind,title,details,status,created_at,updated_at FROM wallet_requests WHERE wallet_id=%s ORDER BY created_at DESC LIMIT 100",
            (user["wallet_id"],),
        ).fetchall()
    return {"requests":[{"id":r[0],"kind":r[1],"title":r[2],"details":r[3],"status":r[4],"created_at":r[5].isoformat(),"updated_at":r[6].isoformat()} for r in rows]}


@app.post("/api/v1/request-center")
def create_request(request: RequestCreate, user: dict = Depends(current_user)):
    kind = request.kind.strip().lower()
    if kind not in {"support","withdrawal_review","transfer_review","account","security","other"}:
        raise HTTPException(status_code=400, detail="Unsupported request type")
    request_id = "req_" + sha(user["wallet_id"] + datetime.now(timezone.utc).isoformat())[:24]
    with db() as conn:
        conn.execute("INSERT INTO wallet_requests(id,wallet_id,kind,title,details,status) VALUES(%s,%s,%s,%s,%s,'open')",
                     (request_id,user["wallet_id"],kind,request.title.strip(),request.details.strip()))
        conn.commit()
    return {"status":"created","request":{"id":request_id,"kind":kind,"title":request.title.strip(),"details":request.details.strip(),"status":"open"}}


@app.post("/api/v1/request-center/status")
def update_request_status(request: RequestStatusUpdate, user: dict = Depends(current_user)):
    status = request.status.strip().lower()
    if status not in {"open","in_review","resolved","closed"}:
        raise HTTPException(status_code=400, detail="Unsupported request status")
    with db() as conn:
        row = conn.execute("SELECT id FROM wallet_requests WHERE id=%s AND wallet_id=%s FOR UPDATE", (request.request_id,user["wallet_id"])).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Request not found")
        conn.execute("UPDATE wallet_requests SET status=%s,updated_at=NOW() WHERE id=%s AND wallet_id=%s", (status,request.request_id,user["wallet_id"]))
        conn.commit()
    return {"status":"updated","request_id":request.request_id,"request_status":status}


@app.get("/api/v1/address-book")
def address_book(user: dict = Depends(current_user)):
    with db() as conn:
        rows = conn.execute("SELECT id,label,address,network,notes,created_at FROM address_book WHERE wallet_id=%s ORDER BY label", (user["wallet_id"],)).fetchall()
    return {"entries":[{"id":r[0],"label":r[1],"address":r[2],"network":r[3],"notes":r[4],"created_at":r[5].isoformat()} for r in rows]}


@app.post("/api/v1/address-book")
def add_address_book(request: AddressBookCreate, user: dict = Depends(current_user)):
    network = request.network.strip().lower()
    if network not in {"ethereum","bnb","bitcoin"}:
        raise HTTPException(status_code=400, detail="Unsupported address-book network")
    if not valid_destination_for_network(request.address, network):
        raise HTTPException(status_code=400, detail="Invalid address for selected network")
    entry_id = "addr_" + sha(user["wallet_id"] + request.address.strip().lower() + network)[:24]
    with db() as conn:
        try:
            conn.execute("INSERT INTO address_book(id,wallet_id,label,address,network,notes) VALUES(%s,%s,%s,%s,%s,%s)",
                         (entry_id,user["wallet_id"],request.label.strip(),request.address.strip(),network,request.notes.strip()))
        except psycopg.errors.UniqueViolation as exc:
            conn.rollback()
            raise HTTPException(status_code=409, detail="This address is already in your address book") from exc
        conn.commit()
    return {"status":"created","entry":{"id":entry_id,"label":request.label.strip(),"address":request.address.strip(),"network":network,"notes":request.notes.strip()}}


@app.post("/api/v1/address-book/delete")
def delete_address_book(request: AddressBookDelete, user: dict = Depends(current_user)):
    with db() as conn:
        result = conn.execute("DELETE FROM address_book WHERE id=%s AND wallet_id=%s", (request.id,user["wallet_id"]))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Address-book entry not found")
        conn.commit()
    return {"status":"deleted","id":request.id}


@app.post("/api/v1/contracts/verify")
def verify_contract(request: ContractVerifyRequest, user: dict = Depends(current_user)):
    address = request.address.strip()
    network = request.network.strip().lower()
    if not valid_evm_address(address):
        raise HTTPException(status_code=400, detail="Invalid EVM contract address")
    rpc = ETH_RPC_URL if network == "ethereum" else BSC_RPC_URL if network == "bnb" else ""
    if not rpc:
        raise HTTPException(status_code=503, detail=f"{network.title()} RPC is not configured")
    try:
        code = rpc_call(rpc, "eth_getCode", [address, "latest"])
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Blockchain RPC unavailable") from exc
    has_code = bool(code and code not in {"0x","0x0"})
    return {
        "status": "contract" if has_code else "no_contract_code",
        "network": network,
        "address": address,
        "contract": has_code,
        "source_verified": False,
        "note": "This check confirms deployed bytecode only; it does not prove source-code verification or safety.",
    }

def reserve_asset(conn,user,symbol: str,amount: Decimal):
    row=conn.execute("SELECT balance,reserved_balance FROM assets WHERE wallet_id=%s AND symbol=%s FOR UPDATE",(user["wallet_id"],symbol)).fetchone()
    if not row: return False,{"status":"rejected","reason":"Unsupported asset","asset":symbol}
    actual=Decimal(row[0] or 0); reserved=Decimal(row[1] or 0); available=actual-reserved
    if amount>available: return False,{"status":"rejected","reason":"Insufficient available asset balance","asset":symbol,"available":float(max(available,Decimal("0"))),"requested":float(amount)}
    conn.execute("UPDATE assets SET reserved_balance=reserved_balance+%s WHERE wallet_id=%s AND symbol=%s",(amount,user["wallet_id"],symbol))
    return True,None

@app.post("/api/v1/transfers")
def transfer(request: TransferRequest,user: dict = Depends(current_user)):
    symbol,network=validate_asset_network(request.asset,request.network)
    if not valid_destination_for_network(request.recipient,network): raise HTTPException(status_code=400,detail="Invalid recipient address for selected network")
    with db() as conn:
        ok,rejection=reserve_asset(conn,user,symbol,request.amount)
        if not ok: conn.rollback(); return rejection
        txid="tx_"+sha(user["wallet_id"]+datetime.now(timezone.utc).isoformat())[:24]
        conn.execute("INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network) VALUES(%s,%s,'sent',%s,%s,%s,'pending',%s,%s)",(txid,user["wallet_id"],symbol,"Transfer request",-request.amount,request.recipient,network))
        conn.commit()
    return {"status":"pending","mode":"database","accounting":"reserved","broadcast":False,"transfer":{"id":txid,"asset":symbol,"amount":float(request.amount),"recipient":request.recipient,"network":network}}

@app.post("/api/v1/withdrawals")
def withdrawal(request: WithdrawalRequest,user: dict = Depends(current_user)):
    symbol,network=validate_asset_network(request.asset,request.network)
    if not valid_destination_for_network(request.destination,network): raise HTTPException(status_code=400,detail="Invalid destination address for selected network")
    with db() as conn:
        ok,rejection=reserve_asset(conn,user,symbol,request.amount)
        if not ok: conn.rollback(); return rejection
        txid="tx_"+sha(user["wallet_id"]+datetime.now(timezone.utc).isoformat())[:24]
        conn.execute("INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network) VALUES(%s,%s,'withdrawal',%s,%s,%s,'pending_review',%s,%s)",(txid,user["wallet_id"],symbol,"Withdrawal request",-request.amount,request.destination,network))
        conn.commit()
    return {"status":"pending_review","mode":"database","accounting":"reserved","broadcast":False,"withdrawal":{"id":txid,"asset":symbol,"amount":float(request.amount),"destination":request.destination,"network":network}}

class TransactionCancelRequest(BaseModel):
    transaction_id: str = Field(min_length=4,max_length=80)

@app.post("/api/v1/transactions/cancel")
def cancel_transaction(request: TransactionCancelRequest,user: dict = Depends(current_user)):
    with db() as conn:
        row=conn.execute("SELECT id,asset,amount,status,tx_hash FROM transactions WHERE id=%s AND wallet_id=%s FOR UPDATE",(request.transaction_id,user["wallet_id"])).fetchone()
        if not row: raise HTTPException(status_code=404,detail="Transaction not found")
        txid,symbol,amount,status,tx_hash=row
        if status not in {"pending","pending_review"} or tx_hash: raise HTTPException(status_code=409,detail="Only unbroadcast pending requests can be cancelled")
        hold=-Decimal(amount)
        asset=conn.execute("SELECT reserved_balance FROM assets WHERE wallet_id=%s AND symbol=%s FOR UPDATE",(user["wallet_id"],symbol)).fetchone()
        if not asset or Decimal(asset[0] or 0)<hold: raise HTTPException(status_code=409,detail="Reservation state is inconsistent; manual review required")
        conn.execute("UPDATE assets SET reserved_balance=reserved_balance-%s WHERE wallet_id=%s AND symbol=%s",(hold,user["wallet_id"],symbol))
        conn.execute("UPDATE transactions SET status='cancelled' WHERE id=%s AND wallet_id=%s",(txid,user["wallet_id"]))
        conn.commit()
    return {"status":"cancelled","transaction_id":txid,"asset":symbol,"released":float(hold)}
