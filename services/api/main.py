import os
import logging
import base64
import hashlib
import re
import secrets
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
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
from Crypto.Cipher import AES
try:
    from services.api.market_price_cache import MarketPriceCache
except ModuleNotFoundError:
    # Supports running from services/api (e.g. `uvicorn main:app`) as well as repo root.
    from market_price_cache import MarketPriceCache

logger = logging.getLogger(__name__)
app = FastAPI(title="World Wallet AI API", version="1.0.0")

DATABASE_URL = os.getenv("DATABASE_URL", "")
SESSION_TOKEN = os.getenv("WORLD_WALLET_SESSION_TOKEN", "")
# One explicit administrator identity takes precedence over legacy per-feature/demo email settings.
WORLD_WALLET_ADMIN_EMAIL = os.getenv("WORLD_WALLET_ADMIN_EMAIL", "").strip().lower()
IDENTITY_EMAIL = (WORLD_WALLET_ADMIN_EMAIL or os.getenv("WORLD_WALLET_DEMO_EMAIL", "")).strip().lower()
IDENTITY_PASSWORD = os.getenv("WORLD_WALLET_DEMO_PASSWORD", "")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_ADMIN_EMAIL = (WORLD_WALLET_ADMIN_EMAIL or os.getenv("WORLD_WALLET_GEMINI_ADMIN_EMAIL") or os.getenv("WORLD_WALLET_GITHUB_ADMIN_EMAIL") or "").strip().lower()
GEMINI_MODEL = os.getenv("WORLD_WALLET_GEMINI_MODEL", "gemini-2.5-flash").strip()
COINGECKO_API_KEY = os.getenv("COINGECKO_API_KEY", "").strip()
COINGECKO_API_BASE_URL = os.getenv("COINGECKO_API_BASE_URL", "https://api.coingecko.com/api/v3").strip().rstrip("/")
COINGECKO_ADMIN_EMAIL = (WORLD_WALLET_ADMIN_EMAIL or os.getenv("WORLD_WALLET_COINGECKO_ADMIN_EMAIL") or GEMINI_ADMIN_EMAIL).strip().lower()
WORLD_WALLET_SECRET_ENCRYPTION_KEY = os.getenv("WORLD_WALLET_SECRET_ENCRYPTION_KEY", "").strip()
NEON_AUTH_BASE_URL = os.getenv("NEON_AUTH_BASE_URL", "").strip()
NEON_AUTH_EXPECTED_AUDIENCE = os.getenv("NEON_AUTH_EXPECTED_AUDIENCE", "").strip()
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "").strip()
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
TWILIO_VERIFY_SERVICE_SID = os.getenv("TWILIO_VERIFY_SERVICE_SID", "").strip()
NEON_AUTH_JWKS_URL = os.getenv("NEON_AUTH_JWKS_URL", "").strip()
NEON_JWKS_CLIENT = PyJWKClient(NEON_AUTH_JWKS_URL) if NEON_AUTH_JWKS_URL else None
EVM_WALLET_ADDRESS = os.getenv("WORLD_WALLET_EVM_ADDRESS", "").strip()
# Alchemy credentials remain backend-only. Explicit RPC URL takes precedence; otherwise build
# the Ethereum Mainnet endpoint from ALCHEMY_API_KEY without ever returning it to the client.
ALCHEMY_API_KEY = os.getenv("ALCHEMY_API_KEY", "").strip()
ETH_PUBLIC_RPC_URL = os.getenv("WORLD_WALLET_ETH_PUBLIC_RPC_URL", "https://ethereum-rpc.publicnode.com").strip()
ETH_RPC_URL = (os.getenv("WORLD_WALLET_ETH_RPC_URL") or (f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_API_KEY}" if ALCHEMY_API_KEY else "") or ETH_PUBLIC_RPC_URL).strip()
BSC_RPC_URL = os.getenv("WORLD_WALLET_BSC_RPC_URL", "").strip()
# Sepolia RPC is separate from CoinGecko market pricing. Override with a dedicated provider in production.
SEPOLIA_RPC_URL = (os.getenv("WORLD_WALLET_SEPOLIA_RPC_URL") or os.getenv("SEPOLIA_RPC_URL") or "https://rpc.sepolia.dev").strip()
SOLANA_DEVNET_RPC_URL = (os.getenv("WORLD_WALLET_SOLANA_DEVNET_RPC_URL") or "https://api.devnet.solana.com").strip()
BALMZ_SOLANA_DEVNET_MINT = "HBSuf6Dm9r2ebkwLUoaY8ScR2rq5L2CPTJpCbqMbtndF"
BALMZ_SOLANA_DEVNET_DECIMALS = 9
BTC_ADDRESS = os.getenv("WORLD_WALLET_BTC_ADDRESS", "").strip()
USDT_ETH_CONTRACT = os.getenv("WORLD_WALLET_USDT_ETH_CONTRACT", "").strip()
USDT_BSC_CONTRACT = os.getenv("WORLD_WALLET_USDT_BSC_CONTRACT", "").strip()
BALMZ_ETH_CONTRACT = os.getenv("WORLD_WALLET_BALMZ_ETH_CONTRACT", "").strip()
BALMZ_SEPOLIA_CONTRACT = os.getenv("WORLD_WALLET_BALMZ_SEPOLIA_CONTRACT", "").strip()

DEFAULT_TRUSTED_ORIGINS = [
    "https://world-wallet-ai-frontend.onrender.com",
    "http://localhost:5173",
    "http://localhost:4173",
]


def _build_trusted_origins(configured_value: str | None = None):
    """Honor explicit origins while always retaining the production app origin."""
    raw = os.getenv("WORLD_WALLET_ALLOWED_ORIGINS", "") if configured_value is None else configured_value
    configured = [origin.strip() for origin in raw.split(",") if origin.strip()]
    if not configured:
        return DEFAULT_TRUSTED_ORIGINS.copy()
    # Do not silently broaden a production allowlist to localhost origins.
    return list(dict.fromkeys([*configured, "https://world-wallet-ai-frontend.onrender.com"]))


TRUSTED_ORIGINS = _build_trusted_origins()


def _coingecko_encryption_key():
    if not WORLD_WALLET_SECRET_ENCRYPTION_KEY:
        return None
    return hashlib.sha256(WORLD_WALLET_SECRET_ENCRYPTION_KEY.encode("utf-8")).digest()


def _encrypt_coingecko_key(secret):
    key = _coingecko_encryption_key()
    if not key:
        raise HTTPException(status_code=503, detail="Set WORLD_WALLET_SECRET_ENCRYPTION_KEY in the backend environment before saving CoinGecko keys")
    cipher = AES.new(key, AES.MODE_GCM)
    encrypted, tag = cipher.encrypt_and_digest(secret.encode("utf-8"))
    return tuple(base64.urlsafe_b64encode(part).decode("ascii") for part in (cipher.nonce, tag, encrypted))


def _decrypt_coingecko_key(nonce, tag, encrypted):
    key = _coingecko_encryption_key()
    if not key:
        return None
    try:
        cipher = AES.new(key, AES.MODE_GCM, nonce=base64.urlsafe_b64decode(nonce))
        return cipher.decrypt_and_verify(base64.urlsafe_b64decode(encrypted), base64.urlsafe_b64decode(tag)).decode("utf-8")
    except Exception:
        logger.error("CoinGecko key decryption failed; check WORLD_WALLET_SECRET_ENCRYPTION_KEY")
        return None


def _active_coingecko_config():
    if DATABASE_URL:
        try:
            with db() as conn:
                row = conn.execute("""SELECT key_nonce,key_tag,key_ciphertext,base_url FROM coingecko_api_keys
                    WHERE active=TRUE AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1""").fetchone()
            if row:
                key = _decrypt_coingecko_key(row[0], row[1], row[2])
                if key:
                    return key, str(row[3] or COINGECKO_API_BASE_URL).rstrip("/")
        except Exception as exc:
            logger.warning("CoinGecko encrypted-key lookup failed: error_type=%s", type(exc).__name__)
    return COINGECKO_API_KEY, COINGECKO_API_BASE_URL


def coingecko_headers(api_key=None, base_url=None):
    """Keep CoinGecko credentials server-side; support Demo and Pro API hosts."""
    key, base = (api_key, base_url) if api_key is not None else _active_coingecko_config()
    if not key:
        return {}
    if "pro-api.coingecko.com" in (base or ""):
        return {"x-cg-pro-api-key": key}
    return {"x-cg-demo-api-key": key}


def require_coingecko_admin(user):
    email = str(user.get("email") or "").strip().lower()
    if not COINGECKO_ADMIN_EMAIL or email != COINGECKO_ADMIN_EMAIL:
        raise HTTPException(status_code=403, detail="Only the configured World Wallet AI administrator can manage CoinGecko keys")
    if not DATABASE_URL:
        raise HTTPException(status_code=503, detail="CoinGecko key management requires PostgreSQL")
    if not _coingecko_encryption_key():
        raise HTTPException(status_code=503, detail="Set WORLD_WALLET_SECRET_ENCRYPTION_KEY in the backend environment before saving CoinGecko keys")
    return email


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


class NeonAuthCredentials(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=1, max_length=128)

class NeonAuthRegistration(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=5, max_length=254)
    phone_number: str = Field(min_length=8, max_length=16)
    phone_otp: str = Field(min_length=4, max_length=10)
    password: str = Field(min_length=8, max_length=128)


class PhoneOtpRequest(BaseModel):
    phone_number: str = Field(min_length=8, max_length=16)


class NeonAuthOtpRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    otp: str = Field(min_length=4, max_length=12)


class TransferRequest(BaseModel):
    idempotency_key: str = Field(min_length=8, max_length=128)
    asset: str = Field(min_length=2, max_length=12)
    amount: Decimal = Field(gt=0, max_digits=36, decimal_places=18)
    recipient: str = Field(min_length=4, max_length=128)
    network: str = Field(min_length=3, max_length=32)
    note: str | None = Field(default=None, max_length=200)


class WithdrawalRequest(BaseModel):
    idempotency_key: str = Field(min_length=8, max_length=128)
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


class AddressInspectRequest(BaseModel):
    address: str = Field(min_length=4, max_length=128)
    network: str = Field(min_length=2, max_length=16)
    compare_address: str | None = Field(default=None, min_length=4, max_length=128)


class ContractInspectRequest(BaseModel):
    address: str = Field(min_length=42, max_length=42)
    network: str = Field(min_length=2, max_length=16)


class WalletCreateRequest(BaseModel):
    name: str = Field(default="New Wallet", min_length=1, max_length=80)


class WalletAddressRequest(BaseModel):
    network: str = Field(min_length=2, max_length=32)
    address: str = Field(min_length=4, max_length=128)
    label: str = Field(default="primary", min_length=1, max_length=80)


class WalletActivateRequest(BaseModel):
    wallet_id: str = Field(min_length=4, max_length=80)


class ApiKeyCreateRequest(BaseModel):
    name: str = Field(default="My API key", min_length=1, max_length=80)


class ApiKeyRevokeRequest(BaseModel):
    key_id: str = Field(min_length=4, max_length=100)


class CoinGeckoKeyCreateRequest(BaseModel):
    name: str = Field(default="CoinGecko API key", min_length=1, max_length=80)
    api_key: str = Field(min_length=8, max_length=300)
    base_url: str = Field(default="https://api.coingecko.com/api/v3", min_length=12, max_length=200)


class ApiKeyImportRequest(BaseModel):
    name: str = Field(default="Imported API key", min_length=1, max_length=80)
    api_key: str = Field(min_length=30, max_length=300)


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
          password_sha256 TEXT, google_subject TEXT UNIQUE, active_wallet_id TEXT,
          phone_number TEXT, phone_verified_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE users ADD COLUMN IF NOT EXISTS active_wallet_id TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
        CREATE UNIQUE INDEX IF NOT EXISTS users_phone_number_unique ON users(phone_number) WHERE phone_number IS NOT NULL;
        CREATE TABLE IF NOT EXISTS api_keys(
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
          name TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, key_prefix TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_used_at TIMESTAMPTZ,
          revoked_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS api_keys_owner_created_idx ON api_keys(owner_id,created_at DESC);
        CREATE TABLE IF NOT EXISTS coingecko_api_keys(
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
          key_prefix TEXT NOT NULL, key_nonce TEXT NOT NULL, key_tag TEXT NOT NULL, key_ciphertext TEXT NOT NULL,
          base_url TEXT NOT NULL DEFAULT 'https://api.coingecko.com/api/v3', active BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), revoked_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS coingecko_api_keys_status_idx ON coingecko_api_keys(active,revoked_at,created_at DESC);
        CREATE TABLE IF NOT EXISTS phone_otp_requests(
          id BIGSERIAL PRIMARY KEY,
          phone_number TEXT NOT NULL,
          requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS phone_otp_requests_phone_time_idx ON phone_otp_requests(phone_number,requested_at DESC);
        CREATE TABLE IF NOT EXISTS wallets(
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
          name TEXT NOT NULL DEFAULT 'Wallet', currency TEXT NOT NULL DEFAULT 'USD',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE wallets ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'Wallet';
        CREATE TABLE IF NOT EXISTS token_registry(
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          name TEXT NOT NULL,
          network TEXT NOT NULL,
          contract_address TEXT,
          decimals INTEGER,
          coingecko_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(symbol,network)
        );
        ALTER TABLE token_registry ADD COLUMN IF NOT EXISTS metadata_url TEXT;
        ALTER TABLE token_registry ADD COLUMN IF NOT EXISTS logo_url TEXT;

        CREATE TABLE IF NOT EXISTS assets(
          wallet_id TEXT NOT NULL REFERENCES wallets(id), symbol TEXT NOT NULL, name TEXT NOT NULL,
          balance NUMERIC(36,18) NOT NULL DEFAULT 0, reserved_balance NUMERIC(36,18) NOT NULL DEFAULT 0, price_usd NUMERIC(36,18) NOT NULL DEFAULT 0, PRIMARY KEY(wallet_id,symbol)
        );
        INSERT INTO token_registry(id,symbol,name,network,contract_address,decimals,coingecko_id,status) VALUES
          ('native-btc','BTC','Bitcoin','bitcoin',NULL,8,'bitcoin','active'),
          ('native-eth','ETH','Ethereum','ethereum',NULL,18,'ethereum','active'),
          ('native-bnb','BNB','BNB','bnb',NULL,18,'binancecoin','active'),
          ('token-usdt-eth','USDT','Tether USD','ethereum',NULL,6,'tether','catalog_only'),
          ('token-usdt-bnb','USDT','Tether USD','bnb',NULL,6,'tether','catalog_only'),
          ('token-balmz','BALMZ','BALMZ Token','ethereum',NULL,NULL,NULL,'pending_contract'),
          ('token-balmz-sepolia','BALMZ-SEP','BALMZ Token (Sepolia)','sepolia',NULL,18,NULL,'pending_contract')
        ON CONFLICT(symbol,network) DO UPDATE SET
          name=EXCLUDED.name,
          status=CASE WHEN token_registry.symbol='BALMZ' THEN 'pending_contract' ELSE token_registry.status END;
        INSERT INTO token_registry(id,symbol,name,network,contract_address,decimals,coingecko_id,status,metadata_url,logo_url)
        VALUES ('token-balmz-solana-devnet','BALMZ-SOL-DEVNET','BALMZ Token (Solana Devnet)','solana-devnet','HBSuf6Dm9r2ebkwLUoaY8ScR2rq5L2CPTJpCbqMbtndF',9,NULL,'catalog_only','https://raw.githubusercontent.com/PWFB/world-wallet-ai/assets/balmz-solana-devnet-logo/tools/balmz-solana-devnet/balmz-token-metadata.json','https://raw.githubusercontent.com/PWFB/world-wallet-ai/assets/balmz-solana-devnet-logo/tools/balmz-solana-devnet/balmz-logo.png')
        ON CONFLICT(symbol,network) DO UPDATE SET
          name=EXCLUDED.name, contract_address=EXCLUDED.contract_address, decimals=EXCLUDED.decimals,
          coingecko_id=NULL, status='catalog_only', metadata_url=EXCLUDED.metadata_url, logo_url=EXCLUDED.logo_url;
        CREATE TABLE IF NOT EXISTS wallet_addresses(
          wallet_id TEXT NOT NULL REFERENCES wallets(id), network TEXT NOT NULL, address TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT 'primary', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(wallet_id,network)
        );
        -- Upgrade legacy one-address-per-network wallets without removing saved addresses.
        ALTER TABLE wallet_addresses DROP CONSTRAINT IF EXISTS wallet_addresses_pkey;
        CREATE UNIQUE INDEX IF NOT EXISTS wallet_addresses_unique_address_idx ON wallet_addresses(wallet_id,network,address);
        CREATE TABLE IF NOT EXISTS portfolio_performance_snapshots(
          id BIGSERIAL PRIMARY KEY,
          wallet_id TEXT NOT NULL REFERENCES wallets(id),
          value_usd NUMERIC(36,18) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS portfolio_performance_wallet_time_idx
          ON portfolio_performance_snapshots(wallet_id, created_at DESC);
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
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS block_hash TEXT;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS log_index INTEGER;
        ALTER TABLE assets ADD COLUMN IF NOT EXISTS reserved_balance NUMERIC(36,18) NOT NULL DEFAULT 0;
        CREATE TABLE IF NOT EXISTS accounting_migrations(
          wallet_id TEXT NOT NULL REFERENCES wallets(id),
          symbol TEXT NOT NULL,
          migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY(wallet_id,symbol)
        );
        CREATE TABLE IF NOT EXISTS transaction_idempotency(
          wallet_id TEXT NOT NULL REFERENCES wallets(id),
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          transaction_id TEXT NOT NULL REFERENCES transactions(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY(wallet_id,idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS chain_sync_cursors(
          wallet_id TEXT NOT NULL REFERENCES wallets(id),
          source TEXT NOT NULL,
          last_block INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY(wallet_id,source)
        );
        CREATE TABLE IF NOT EXISTS solana_devnet_deposits(
          tx_signature TEXT PRIMARY KEY,
          wallet_id TEXT NOT NULL REFERENCES wallets(id),
          destination_address TEXT NOT NULL,
          amount NUMERIC(36,18) NOT NULL,
          slot BIGINT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS solana_devnet_deposits_wallet_created_idx
          ON solana_devnet_deposits(wallet_id,created_at DESC);
        """)
        if USDT_ETH_CONTRACT and valid_evm_address(USDT_ETH_CONTRACT):
            conn.execute(
                "UPDATE token_registry SET contract_address=%s,decimals=COALESCE(decimals,6),status='active' "
                "WHERE symbol='USDT' AND network='ethereum'",
                (USDT_ETH_CONTRACT,),
            )
        if USDT_BSC_CONTRACT and valid_evm_address(USDT_BSC_CONTRACT):
            conn.execute(
                "UPDATE token_registry SET contract_address=%s,decimals=COALESCE(decimals,6),status='active' "
                "WHERE symbol='USDT' AND network='bnb'",
                (USDT_BSC_CONTRACT,),
            )
        if BALMZ_ETH_CONTRACT and valid_evm_address(BALMZ_ETH_CONTRACT):
            conn.execute(
                "UPDATE token_registry SET contract_address=%s,decimals=COALESCE(decimals,18),status='active' "
                "WHERE symbol='BALMZ' AND network='ethereum'",
                (BALMZ_ETH_CONTRACT,),
            )
        if BALMZ_SEPOLIA_CONTRACT and valid_evm_address(BALMZ_SEPOLIA_CONTRACT):
            conn.execute(
                "UPDATE token_registry SET contract_address=%s,decimals=COALESCE(decimals,18),status='active' "
                "WHERE symbol='BALMZ-SEP' AND network='sepolia'",
                (BALMZ_SEPOLIA_CONTRACT,),
            )
        legacy_holds = conn.execute("""
          SELECT a.wallet_id,a.symbol,COALESCE(SUM(-t.amount),0)
          FROM assets a
          LEFT JOIN transactions t
            ON t.wallet_id=a.wallet_id AND t.asset=a.symbol
           AND t.tx_hash IS NULL AND t.amount < 0
           AND t.status IN ('pending','pending_review')
          WHERE NOT EXISTS (
            SELECT 1 FROM accounting_migrations m
            WHERE m.wallet_id=a.wallet_id AND m.symbol=a.symbol
          )
          GROUP BY a.wallet_id,a.symbol
        """).fetchall()
        for wallet_id,symbol,legacy_reserved in legacy_holds:
            hold=legacy_reserved or Decimal("0")
            if hold > 0:
                conn.execute(
                    "UPDATE assets SET balance=balance+%s,reserved_balance=reserved_balance+%s "
                    "WHERE wallet_id=%s AND symbol=%s",
                    (hold,hold,wallet_id,symbol),
                )
            conn.execute(
                "INSERT INTO accounting_migrations(wallet_id,symbol) VALUES(%s,%s) "
                "ON CONFLICT DO NOTHING",
                (wallet_id,symbol),
            )
        conn.commit()


def get_user(email: str):
    with db() as conn:
        row = conn.execute("SELECT id,email,name,active_wallet_id,phone_number,phone_verified_at FROM users WHERE lower(email)=lower(%s)", (email,)).fetchone()
        if not row:
            return None
        wallet = conn.execute("SELECT id FROM wallets WHERE id=%s AND owner_id=%s", (row[3],row[0])).fetchone() if row[3] else None
        if not wallet:
            wallet = conn.execute("SELECT id FROM wallets WHERE owner_id=%s ORDER BY created_at ASC LIMIT 1", (row[0],)).fetchone()
        return {"id": row[0], "email": row[1], "name": row[2], "wallet_id": wallet[0] if wallet else None, "phone_number": row[4], "phone_verified": bool(row[5])}


def provision_identity(email: str, password: str | None = None, name: str = "World Wallet User", google_subject: str | None = None):
    user = get_user(email)
    with db() as conn:
        if user:
            conn.execute("UPDATE users SET name=%s, google_subject=COALESCE(%s,google_subject) WHERE id=%s", (name, google_subject, user["id"]))
            wallet_id = user["wallet_id"]
            if not wallet_id:
                # Heal legacy Neon-auth users whose profile exists but whose
                # wallet provisioning was interrupted during an earlier login.
                wallet_id = "wallet_" + sha(user["id"] + ":production")[:24]
                conn.execute(
                    "INSERT INTO wallets(id,owner_id,name) VALUES(%s,%s,%s) ON CONFLICT(id) DO NOTHING",
                    (wallet_id, user["id"], "Production Wallet"),
                )
                conn.execute("UPDATE users SET active_wallet_id=%s WHERE id=%s", (wallet_id, user["id"]))
        else:
            user_id = "usr_" + sha(email.lower())[:24]
            conn.execute("INSERT INTO users(id,email,name,password_sha256,google_subject) VALUES(%s,%s,%s,%s,%s)",
                         (user_id,email,name,sha(password) if password else None,google_subject))
            wallet_id = "wallet_" + sha(user_id)[:24]
            conn.execute("INSERT INTO wallets(id,owner_id,name) VALUES(%s,%s,%s)", (wallet_id,user_id,"Production Wallet"))
            conn.execute("UPDATE users SET active_wallet_id=%s WHERE id=%s", (wallet_id,user_id))
        for symbol,asset_name in [
            ("BALMZ","BALMZ Token"),("BALMZ-SEP","BALMZ Token (Sepolia)"),("BTC","Bitcoin"),("ETH","Ethereum"),("USDT","Tether USD"),("BNB","BNB"),
            ("USDC","USD Coin"),("SOL","Solana"),("XRP","XRP"),("ADA","Cardano"),("LTC","Litecoin"),("DOGE","Dogecoin")
        ]:
            conn.execute(
                "INSERT INTO assets(wallet_id,symbol,name,balance,price_usd) VALUES(%s,%s,%s,0,0) ON CONFLICT(wallet_id,symbol) DO NOTHING",
                (wallet_id,symbol,asset_name)
            )
        conn.commit()
    return get_user(email)


def neon_auth_user(token: str):
    if not NEON_JWKS_CLIENT:
        raise HTTPException(status_code=503, detail="Neon Auth is not configured on the server")
    stage = "read_jwt_header"
    algorithm = "unavailable"
    try:
        # Neon Auth is the issuer of the JWT used by the wallet API. Do not
        # hard-code an algorithm: use the algorithm advertised by the
        # verified JWKS key, which keeps this compatible with Neon key
        # rotation while still binding the token to the expected public key.
        header = jwt.get_unverified_header(token)
        algorithm = str(header.get("alg") or "").strip()
        stage = "select_jwks_key"
        signing_key = NEON_JWKS_CLIENT.get_signing_key_from_jwt(token)
        key_algorithm = str(getattr(signing_key, "algorithm_name", "") or "").strip()
        allowed_algorithms = {"EdDSA", "ES256", "ES384", "ES512", "RS256", "RS384", "RS512"}
        stage = "validate_signing_algorithm"
        if algorithm not in allowed_algorithms:
            raise ValueError("Unsupported Neon Auth signing algorithm")
        # Some JWKS providers omit the optional "alg" field on public keys.
        # In that case PyJWKClient can still select the matching key by kid;
        # PyJWT verifies the signature using the explicit allow-listed header
        # algorithm. If the JWK does declare an algorithm, require an exact match.
        if key_algorithm and algorithm != key_algorithm:
            raise ValueError("JWT signing algorithm does not match the Neon JWKS key")
        stage = "verify_jwt_signature_and_claims"
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=[algorithm],
            # A signed token without an expiry must never become a permanent session.
            # Neon Auth access tokens must carry expiry and user identity claims.
            audience=NEON_AUTH_EXPECTED_AUDIENCE or None,
            options={
                "verify_aud": bool(NEON_AUTH_EXPECTED_AUDIENCE),
                "require": ["exp", "sub", "email"],
            },
        )
    except Exception as exc:
        # Never log the bearer token, claims, or raw exception text. The
        # exception class tells us which verification stage is rejecting it.
        import logging
        logging.getLogger("uvicorn.error").warning(
            "Neon Auth JWT verification rejected: stage=%s error_type=%s alg=%s",
            stage if "stage" in locals() else "unknown",
            type(exc).__name__,
            algorithm if "algorithm" in locals() else "unavailable",
        )
        raise HTTPException(status_code=401, detail="Invalid Neon Auth session") from exc

    subject = str(claims.get("sub") or "").strip()
    email = str(claims.get("email") or "").strip().lower()
    if not subject or not email:
        raise HTTPException(status_code=401, detail="Neon Auth token has no user identity")
    issuer = str(claims.get("iss") or "").strip()
    if NEON_AUTH_BASE_URL:
        configured_issuer = NEON_AUTH_BASE_URL.rstrip("/")
        configured_origin = configured_issuer.split("/neondb/auth", 1)[0].rstrip("/")
        allowed_issuers = {configured_issuer, configured_origin}
        # A signed JWT with no issuer is not accepted as a Neon session.
        if not issuer or issuer.rstrip("/") not in allowed_issuers:
            raise HTTPException(status_code=401, detail="Invalid Neon Auth issuer")

    name = str(claims.get("name") or "World Wallet User").strip() or "World Wallet User"
    user = get_user(email)
    if not user or not user.get("wallet_id"):
        # Heal existing Neon-auth profiles when their wallet row or active-wallet link
        # is missing. provision_identity is idempotent and ensures the catalog exists.
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
    # First accept app-issued API keys. Only a SHA-256 digest is stored in PostgreSQL.
    if DATABASE_URL and token.startswith("wwai_"):
        try:
            with db() as conn:
                row = conn.execute("""
                    SELECT u.id,u.email,u.name,u.active_wallet_id,u.phone_number,u.phone_verified_at,k.id
                    FROM api_keys k JOIN users u ON u.id=k.owner_id
                    WHERE k.key_hash=%s AND k.revoked_at IS NULL
                """, (sha(token),)).fetchone()
                if row:
                    conn.execute("UPDATE api_keys SET last_used_at=NOW() WHERE id=%s", (row[6],))
                    conn.commit()
                    return {"id": row[0], "email": row[1], "name": row[2], "wallet_id": row[3], "phone_number": row[4], "phone_verified": bool(row[5])}
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=503, detail="API key authentication is temporarily unavailable") from exc
    return neon_auth_user(token)




def _neon_auth_origin():
    return TRUSTED_ORIGINS[0] if TRUSTED_ORIGINS else "http://localhost:5173"


def _neon_auth_json(response):
    try:
        value = response.json()
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _neon_auth_error(response):
    payload = _neon_auth_json(response)
    message = str(payload.get("message") or payload.get("error") or payload.get("code") or "Neon Auth request failed").strip()
    if response.status_code in {400, 401}:
        return "Invalid email, password, or sign-in code."
    return message[:240]


def _neon_auth_sign_in(path: str, body: dict):
    if not NEON_AUTH_BASE_URL:
        raise HTTPException(status_code=503, detail="Neon Auth is not configured on the server")
    base = NEON_AUTH_BASE_URL.rstrip("/")
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Origin": _neon_auth_origin(),
        "User-Agent": "WorldWalletAI-AuthRelay/1.0",
    }
    try:
        with httpx.Client(timeout=15, follow_redirects=False) as client:
            response = client.post(base + path, json=body, headers=headers)
            if not response.is_success:
                # If the credentials are rejected because this email has no Neon Auth
                # account yet, create the account using the password the user supplied.
                # If the email already exists, sign-up will fail and we keep the normal
                # generic authentication error; this never bypasses an existing password.
                if path == "/sign-in/email" and response.status_code in {400, 401}:
                    signup_body = {
                        "name": "World Wallet User",
                        "email": str(body.get("email", "")).strip().lower(),
                        "password": str(body.get("password", "")),
                    }
                    signup = client.post(base + "/sign-up/email", json=signup_body, headers=headers)
                    if signup.is_success:
                        response = signup
                    else:
                        raise HTTPException(
                            status_code=response.status_code if response.status_code < 500 else 502,
                            detail=_neon_auth_error(response),
                        )
                else:
                    raise HTTPException(
                        status_code=response.status_code if response.status_code < 500 else 502,
                        detail=_neon_auth_error(response),
                    )
            payload = _neon_auth_json(response)
            token_response = client.get(base + "/token", headers={
                "Accept": "application/json",
                "Origin": _neon_auth_origin(),
                "User-Agent": "WorldWalletAI-AuthRelay/1.0",
            })
            if not token_response.is_success:
                raise HTTPException(status_code=502, detail="Neon Auth signed in, but the secure wallet token could not be created.")
            token_payload = _neon_auth_json(token_response)
            token = str(token_payload.get("token") or "").strip()
            if not token:
                raise HTTPException(status_code=502, detail="Neon Auth did not return a secure wallet token.")
            auth_user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
            email = str(auth_user.get("email") or body.get("email") or "").strip().lower()
            if not email:
                raise HTTPException(status_code=502, detail="Neon Auth did not return a user identity.")
            name = str(auth_user.get("name") or "World Wallet User").strip() or "World Wallet User"
            user = provision_identity(email, name=name, google_subject=auth_user.get("id"))
            return {"access_token": token, "token_type": "bearer", "user": user, "mode": "neon_auth_relay"}
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Unable to reach Neon Auth. Please try again.") from exc


def _neon_auth_post(path: str, body: dict):
    if not NEON_AUTH_BASE_URL:
        raise HTTPException(status_code=503, detail="Neon Auth is not configured on the server")
    base = NEON_AUTH_BASE_URL.rstrip("/")
    try:
        response = httpx.post(base + path, json=body, headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": _neon_auth_origin(),
            "User-Agent": "WorldWalletAI-AuthRelay/1.0",
        }, timeout=15, follow_redirects=False)
        if not response.is_success:
            raise HTTPException(status_code=response.status_code if response.status_code < 500 else 502, detail=_neon_auth_error(response))
        return _neon_auth_json(response)
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Unable to reach Neon Auth. Please try again.") from exc


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


def valid_solana_address(address: str) -> bool:
    """Validate a Solana public key as a Base58-encoded 32-byte value."""
    value = address.strip()
    raw = _base58_decode(value)
    return bool(raw and len(raw) == 32 and 32 <= len(value) <= 44)


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
        "BALMZ-SOL-DEVNET": {"solana-devnet"},
    }
    if symbol not in allowed or net not in allowed[symbol]:
        raise HTTPException(status_code=400, detail=f"{symbol} is not supported on the {net} network")
    return symbol, net


def configured_addresses(user):
    # Only return addresses explicitly saved to this user's active wallet.
    # Service-level fallback addresses must never be copied into user wallets:
    # doing so can misattribute balances/transactions and mix testnet with mainnet.
    with db() as conn:
        rows = conn.execute(
            "SELECT network,address,label FROM wallet_addresses WHERE wallet_id=%s ORDER BY network, CASE WHEN lower(label)='primary' THEN 0 ELSE 1 END, created_at, address",
            (user["wallet_id"],),
        ).fetchall()
    return [{"network": r[0], "address": r[1], "label": r[2]} for r in rows]


def wallet_network_address(user, network):
    return next((a["address"] for a in configured_addresses(user) if a["network"] == network), None)


def wallet_owns_network_address(user, network, address):
    """Require every chain sync address to belong to this user's active wallet."""
    if not address:
        return False
    normalized_network = str(network or "").strip().lower()
    normalized_address = str(address).strip().lower()
    return any(
        str(item.get("network") or "").strip().lower() == normalized_network
        and str(item.get("address") or "").strip().lower() == normalized_address
        for item in configured_addresses(user)
    )


def rpc_call(url: str, method: str, params: list):
    """Call JSON-RPC, falling back to a public read-only Ethereum RPC if needed."""
    if not url:
        return None
    candidates = [url]
    if url == ETH_RPC_URL and ETH_PUBLIC_RPC_URL and ETH_PUBLIC_RPC_URL not in candidates:
        candidates.append(ETH_PUBLIC_RPC_URL)
    last_error = None
    for candidate in candidates:
        try:
            response = httpx.post(
                candidate,
                json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                timeout=10,
            )
            response.raise_for_status()
            payload = response.json()
            if payload.get("error"):
                raise ValueError("RPC provider returned a JSON-RPC error")
            if "result" not in payload:
                raise ValueError("RPC provider returned no result")
            return payload["result"]
        except Exception as exc:
            last_error = exc
    if last_error:
        raise last_error
    return None



def solana_spl_token_balance(owner_address: str, mint_address: str = BALMZ_SOLANA_DEVNET_MINT, decimals: int = BALMZ_SOLANA_DEVNET_DECIMALS):
    """Read the confirmed SPL token balance from Solana Devnet without signing."""
    if not valid_solana_address(owner_address) or not valid_solana_address(mint_address):
        raise ValueError("Invalid Solana owner or mint address")
    if int(decimals) != BALMZ_SOLANA_DEVNET_DECIMALS:
        raise ValueError("Unexpected BALMZ Solana Devnet decimals")
    response = rpc_call(
        SOLANA_DEVNET_RPC_URL,
        "getTokenAccountsByOwner",
        [owner_address, {"mint": mint_address},
         {"encoding": "jsonParsed", "commitment": "confirmed"}],
    )
    if not isinstance(response, dict) or not isinstance(response.get("value"), list):
        raise ValueError("Solana Devnet returned an invalid token-account response")
    raw_total = 0
    for item in response["value"]:
        try:
            info = item["account"]["data"]["parsed"]["info"]
            amount = info["tokenAmount"]
            if info.get("mint") != mint_address or int(amount.get("decimals")) != int(decimals):
                raise ValueError("Solana token account mint or decimals mismatch")
            raw_amount = amount.get("amount")
            if not isinstance(raw_amount, str) or not raw_amount.isdigit():
                raise ValueError("Solana token account returned an invalid raw amount")
            raw_total += int(raw_amount)
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("Solana Devnet returned malformed token-account data") from exc
    return float(Decimal(raw_total) / (Decimal(10) ** int(decimals)))


def evm_chain_id(url: str):
    """Return the connected EVM RPC chain ID as an integer."""
    raw = rpc_call(url, "eth_chainId", [])
    return int(raw, 16) if raw else None


def require_ethereum_mainnet_rpc(url: str):
    """Fail closed if an Ethereum RPC endpoint is not connected to mainnet."""
    chain_id = evm_chain_id(url)
    if chain_id != 1:
        raise ValueError("Ethereum RPC did not report mainnet chain ID 1")
    return chain_id


def require_sepolia_rpc(url: str):
    """Fail closed if a configured Sepolia endpoint is actually another chain."""
    chain_id = evm_chain_id(url)
    if chain_id != 11155111:
        raise ValueError("Configured Sepolia RPC did not report chain ID 11155111")


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
    # Confirmed balance is the accounting source of truth. Pending mempool
    # movement is surfaced through transaction status and must not bypass
    # the wallet's reservation model.
    confirmed = int(chain.get("funded_txo_sum", 0)) - int(chain.get("spent_txo_sum", 0))
    return confirmed / 100_000_000

def erc20_balance(url: str, contract: str, address: str, decimals: int = 18):
    """Read a real ERC-20 balance using registry metadata."""
    if not url or not contract or not valid_evm_address(contract) or not valid_evm_address(address):
        return None
    data = "0x70a08231" + address[2:].lower().rjust(64, "0")
    raw = rpc_call(url, "eth_call", [{"to":contract,"data":data}, "latest"])
    if not raw:
        return 0.0
    return int(raw, 16) / (10 ** max(0, int(decimals)))



def evm_block_number(url: str):
    raw = rpc_call(url, "eth_blockNumber", [])
    return int(raw, 16) if raw else None


def require_sepolia_rpc(url: str):
    """Fail closed if a Sepolia-configured RPC actually points at another EVM chain."""
    raw = rpc_call(url, "eth_chainId", [])
    if not raw:
        raise ValueError("Sepolia RPC did not return a chain ID")
    chain_id = int(raw, 16)
    if chain_id != 11155111:
        raise ValueError("Configured Sepolia RPC returned chain ID %s, expected 11155111" % chain_id)
    return chain_id


def evm_transfer_logs(url: str, contract: str, wallet_address: str, from_block: int, to_block: int):
    if not url or not contract or not valid_evm_address(contract) or not valid_evm_address(wallet_address):
        return []
    transfer_topic = "0x" + _keccak_hex("Transfer(address,address,uint256)")
    wallet_topic = "0x" + wallet_address[2:].lower().rjust(64, "0")
    logs = []
    for topic_index in (1, 2):
        logs.extend(rpc_call(url, "eth_getLogs", [{
            "fromBlock": hex(from_block),
            "toBlock": hex(to_block),
            "address": contract,
            "topics": [transfer_topic, wallet_topic if topic_index == 1 else None, wallet_topic if topic_index == 2 else None],
        }]) or [])
    return logs


def _sync_cursor(conn, wallet_id: str, source: str):
    row = conn.execute(
        "SELECT last_block FROM chain_sync_cursors WHERE wallet_id=%s AND source=%s",
        (wallet_id, source),
    ).fetchone()
    return int(row[0]) if row else None


def _set_sync_cursor(conn, wallet_id: str, source: str, block_number: int):
    conn.execute(
        "INSERT INTO chain_sync_cursors(wallet_id,source,last_block) VALUES(%s,%s,%s) "
        "ON CONFLICT(wallet_id,source) DO UPDATE SET last_block=EXCLUDED.last_block,updated_at=NOW()",
        (wallet_id, source, int(block_number)),
    )


def sync_evm_native_transactions(user, url: str, network: str, wallet_address=None):
    wallet_address = wallet_address or next((a["address"] for a in configured_addresses(user) if a["network"]==network), None)
    if not url or not wallet_address:
        return [], None
    if not wallet_owns_network_address(user, network, wallet_address):
        return [], f"{network} wallet address is not saved to the active wallet"
    try:
        if network == "sepolia":
            require_sepolia_rpc(url)
        latest = evm_block_number(url)
        if latest is None:
            return [], "latest block unavailable"
        lookback = max(1, min(int(os.getenv("WORLD_WALLET_EVM_NATIVE_TX_LOOKBACK_BLOCKS", "100")), 500))
        source = network + ":native"
        wallet_lower = wallet_address.lower()
        imported = []
        reorg_overlap = max(1, min(int(os.getenv("WORLD_WALLET_SYNC_REORG_OVERLAP", "6")), 20))
        required_confirmations = max(1, min(int(os.getenv("WORLD_WALLET_EVM_CONFIRMATIONS", "3")), 100))
        with db() as conn:
            cursor = _sync_cursor(conn, user["wallet_id"], source)
            start = max(0, latest - lookback + 1) if cursor is None else max(0, cursor - reorg_overlap + 1)
            block_hashes = {}
            seen_hashes = set()
            for block_number in range(start, latest + 1):
                block = rpc_call(url, "eth_getBlockByNumber", [hex(block_number), True])
                if not block:
                    continue
                block_hash = block.get("hash")
                if block_hash:
                    block_hashes[block_number] = block_hash
                for tx in block.get("transactions", []):
                    sender = str(tx.get("from") or "").lower()
                    recipient = str(tx.get("to") or "").lower()
                    if sender != wallet_lower and recipient != wallet_lower:
                        continue
                    value = int(tx.get("value") or "0x0", 16) / 10**18
                    if value <= 0:
                        continue
                    tx_hash = tx.get("hash")
                    if not tx_hash:
                        continue
                    seen_hashes.add(tx_hash.lower())
                    direction = "received" if recipient == wallet_lower else "sent"
                    signed_amount = value if direction == "received" else -value
                    receipt = rpc_call(url, "eth_getTransactionReceipt", [tx_hash])
                    receipt_status = str(receipt.get("status") or "").lower() if receipt else ""
                    confirmations = max(0, latest - block_number + 1)
                    if receipt_status == "0x0":
                        status = "failed"
                    elif receipt is None or receipt_status != "0x1":
                        status = "pending"
                    elif confirmations >= required_confirmations:
                        status = "confirmed"
                    else:
                        status = "pending"
                    tx_id = "evm_" + tx_hash
                    native_asset = "ETH" if network == "ethereum" else ("BNB" if network == "bnb" else "ETH-SEP" if network == "sepolia" else network.upper())
                    existing = conn.execute(
                        "SELECT id,status,type,description,block_hash FROM transactions "
                        "WHERE wallet_id=%s AND tx_hash=%s AND network=%s AND asset=%s",
                        (user["wallet_id"], tx_hash, network, native_asset),
                    ).fetchone()
                    if existing:
                        old_id, old_status, old_type, old_description, old_block_hash = existing
                        if old_status == "reorged" or (old_block_hash and block_hash and old_block_hash.lower() != block_hash.lower()):
                            status = "reorged"
                            confirmations = 0
                        elif old_status == "settled":
                            status = "settled"
                        elif status != "failed" and old_status in {"pending","pending_review","broadcast_pending"} and (old_type == "withdrawal" or old_description in {"Transfer request","Withdrawal request"}):
                            status = "broadcast_pending"
                    values=(confirmations, block_number, block_hash, status, existing[0] if existing else tx_id, user["wallet_id"])
                    if existing:
                        conn.execute(
                            "UPDATE transactions SET confirmations=%s,block_height=%s,block_hash=%s,status=%s WHERE id=%s AND wallet_id=%s",
                            values,
                        )
                    else:
                        conn.execute(
                            "INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network,tx_hash,confirmations,block_height,block_hash) "
                            "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                            (tx_id,user["wallet_id"],direction,native_asset,
                             f"{network} native {direction}",signed_amount,status,
                             recipient if direction=="sent" else sender,network,tx_hash,confirmations,block_number,block_hash),
                        )
                    imported.append({"tx_hash":tx_hash,"asset":native_asset,"network":network,
                                     "type":direction,"amount":signed_amount,"status":status,"confirmations":confirmations,
                                     "block_height":block_number,"block_hash":block_hash})
            # A block hash changing inside the overlap means an old record can no longer
            # be treated as confirmed. Mark it explicitly so accounting/UI never lies.
            for row in conn.execute(
                "SELECT id,tx_hash,block_height,block_hash FROM transactions "
                "WHERE wallet_id=%s AND network=%s AND asset=%s AND block_height BETWEEN %s AND %s "
                "AND status IN ('confirmed','pending','failed','settled','broadcast_pending')",
                (user["wallet_id"],network,native_asset,start,latest),
            ).fetchall():
                txid, old_hash, old_height, old_block_hash = row
                current_hash = block_hashes.get(int(old_height)) if old_height is not None else None
                if current_hash is None and old_height is not None:
                    try:
                        canonical = rpc_call(url, "eth_getBlockByNumber", [hex(int(old_height)), False])
                        current_hash = (canonical or {}).get("hash")
                    except Exception:
                        current_hash = None
                if old_block_hash and current_hash and old_block_hash.lower() != current_hash.lower():
                    conn.execute(
                        "UPDATE transactions SET status='reorged',confirmations=0 WHERE id=%s AND wallet_id=%s",
                        (txid,user["wallet_id"]),
                    )
            _set_sync_cursor(conn, user["wallet_id"], source, latest)
            conn.commit()
        return imported, None
    except Exception:
        return [], f"{network} native transaction service unavailable"

def sync_evm_token_transactions(user, url: str, network: str, contract: str, symbol: str, decimals: int = 6, wallet_address=None):
    wallet_address = wallet_address or next((a["address"] for a in configured_addresses(user) if a["network"]==network), None)
    if not url or not contract or not wallet_address:
        return [], None
    if not wallet_owns_network_address(user, network, wallet_address):
        return [], f"{network} wallet address is not saved to the active wallet"
    try:
        if network == "sepolia":
            require_sepolia_rpc(url)
        latest = evm_block_number(url)
        if latest is None:
            return [], "latest block unavailable"
        lookback = max(1, min(int(os.getenv("WORLD_WALLET_EVM_TX_LOOKBACK_BLOCKS", "5000")), 100000))
        source = network + ":" + symbol.lower()
        with db() as cursor_conn:
            cursor = _sync_cursor(cursor_conn, user["wallet_id"], source)
        reorg_overlap = max(1, min(int(os.getenv("WORLD_WALLET_SYNC_REORG_OVERLAP", "6")), 20))
        start = max(0, latest - lookback + 1) if cursor is None else max(0, cursor - reorg_overlap + 1)
        logs = evm_transfer_logs(url, contract, wallet_address, start, latest)
    except Exception:
        return [], f"{network} {symbol} transaction service unavailable"
    imported = []
    wallet_lower = wallet_address.lower()
    block_hashes = {}
    try:
        with db() as conn:
            for log in logs:
                topics = log.get("topics") or []
                if len(topics) < 3:
                    continue
                sender = "0x" + topics[1][-40:]
                recipient = "0x" + topics[2][-40:]
                raw_value = int(log.get("data") or "0x0", 16)
                amount = raw_value / (10 ** decimals)
                if amount <= 0:
                    continue
                direction = "received" if recipient.lower() == wallet_address.lower() else "sent"
                signed_amount = amount if direction == "received" else -amount
                tx_hash = log.get("transactionHash")
                block_number = int(log.get("blockNumber"), 16) if log.get("blockNumber") else None
                log_index = int(log.get("logIndex"), 16) if log.get("logIndex") else None
                block_hash = log.get("blockHash")
                if not tx_hash:
                    continue
                if block_number is not None and block_hash:
                    block_hashes[block_number] = block_hash
                confirmations = max(0, latest - block_number + 1) if block_number is not None else 0
                receipt = rpc_call(url, "eth_getTransactionReceipt", [tx_hash])
                receipt_status = str(receipt.get("status") or "").lower() if receipt else ""
                if receipt_status == "0x0":
                    status = "failed"
                elif receipt is None or receipt_status != "0x1":
                    status = "pending"
                else:
                    status = "confirmed" if confirmations >= required_confirmations("WORLD_WALLET_EVM_CONFIRMATIONS") else "pending"
                description = f"{symbol} {direction} on {network}"
                existing = conn.execute(
                    "SELECT id,status,type,description,block_hash FROM transactions WHERE wallet_id=%s AND tx_hash=%s AND network=%s AND asset=%s "
                    "AND COALESCE(log_index,-1)=COALESCE(%s,-1)",
                    (user["wallet_id"],tx_hash,network,symbol,log_index),
                ).fetchone()
                tx_id = existing[0] if existing else "evm_" + tx_hash + "_" + str(log_index if log_index is not None else 0)
                if existing:
                    old_id, old_status, old_type, old_description, old_block_hash = existing
                    if old_status == "reorged" or (old_block_hash and block_hash and old_block_hash.lower() != block_hash.lower()):
                        status = "reorged"
                        confirmations = 0
                    elif old_status == "settled":
                        status = "settled"
                    elif status != "failed" and old_status in {"pending","pending_review","broadcast_pending"} and (old_type == "withdrawal" or old_description in {"Transfer request","Withdrawal request"}):
                        status = "broadcast_pending"
                    conn.execute(
                        "UPDATE transactions SET confirmations=%s,block_height=%s,block_hash=%s,log_index=%s,status=%s WHERE id=%s AND wallet_id=%s",
                        (confirmations,block_number,block_hash,log_index,status,tx_id,user["wallet_id"]),
                    )
                else:
                    conn.execute(
                        "INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network,tx_hash,confirmations,block_height,block_hash,log_index) "
                        "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (tx_id,user["wallet_id"],direction,symbol,description,signed_amount,status,
                         recipient if direction=="sent" else sender,network,tx_hash,confirmations,block_number,block_hash,log_index),
                    )
                imported.append({"tx_hash":tx_hash,"asset":symbol,"network":network,"type":direction,"amount":signed_amount,
                                 "status":status,"confirmations":confirmations,"block_height":block_number,"block_hash":block_hash,
                                 "log_index":log_index})
            for row in conn.execute(
                "SELECT id,block_height,block_hash FROM transactions WHERE wallet_id=%s AND network=%s AND asset=%s "
                "AND block_height BETWEEN %s AND %s AND status IN ('confirmed','pending','failed','settled','broadcast_pending')",
                (user["wallet_id"],network,symbol,start,latest),
            ).fetchall():
                txid, old_height, old_block_hash = row
                current_hash = block_hashes.get(int(old_height)) if old_height is not None else None
                if current_hash is None and old_height is not None:
                    try:
                        canonical = rpc_call(url, "eth_getBlockByNumber", [hex(int(old_height)), False])
                        current_hash = (canonical or {}).get("hash")
                    except Exception:
                        current_hash = None
                if old_block_hash and current_hash and old_block_hash.lower() != current_hash.lower():
                    conn.execute(
                        "UPDATE transactions SET status='reorged',confirmations=0 WHERE id=%s AND wallet_id=%s",
                        (txid,user["wallet_id"]),
                    )
            _set_sync_cursor(conn, user["wallet_id"], source, latest)
            conn.commit()
    except Exception:
        return [], f"{network} {symbol} transaction service unavailable"
    return imported, None


def bitcoin_address_transactions(address: str):
    if not address:
        return []
    txs = []
    next_url = f"https://blockstream.info/api/address/{address}/txs"
    max_pages = max(1, min(int(os.getenv("WORLD_WALLET_BTC_TX_PAGES", "3")), 10))
    for page in range(max_pages):
        response = httpx.get(next_url, timeout=15)
        response.raise_for_status()
        page_txs = response.json()
        if not page_txs:
            break
        txs.extend(page_txs)
        if len(page_txs) < 25:
            break
        last_txid = page_txs[-1].get("txid")
        if not last_txid:
            break
        next_url = f"https://blockstream.info/api/address/{address}/txs/chain/{last_txid}"
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
        threshold = required_confirmations("WORLD_WALLET_BTC_CONFIRMATIONS")
        results.append({"tx_hash":tx.get("txid"),"amount":net_sats/100_000_000,"type":"received" if net_sats > 0 else "sent","status":"confirmed" if confirmations >= threshold else "pending","confirmations":confirmations,"block_height":block_height,"block_hash":status.get("block_hash")})
    return results

def sync_bitcoin_transactions(user, address=None):
    address = address or next((a["address"] for a in configured_addresses(user) if a["network"]=="bitcoin"), None)
    if not address:
        return []
    if not wallet_owns_network_address(user, "bitcoin", address):
        return []
    try:
        chain_txs = bitcoin_address_transactions(address)
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
                existing_row = conn.execute("SELECT type,status,block_hash,description FROM transactions WHERE id=%s AND wallet_id=%s FOR UPDATE",(tx_id,user["wallet_id"])).fetchone()
                old_type, old_status, old_block_hash, old_description = existing_row if existing_row else ("", "", None, "")
                status = item["status"]
                confirmations = item["confirmations"]
                if old_status == "reorged" or (old_status in {"confirmed","settled"} and status == "pending") or (old_block_hash and item.get("block_hash") and old_block_hash.lower() != item["block_hash"].lower()):
                    status = "reorged"
                    confirmations = 0
                elif old_status == "settled":
                    status = "settled"
                elif status != "failed" and old_status in {"pending","pending_review","broadcast_pending"} and (old_type == "withdrawal" or old_description in {"Transfer request","Withdrawal request"}):
                    status = "broadcast_pending"
                if old_type == "withdrawal" or old_description in {"Transfer request","Withdrawal request"}:
                    conn.execute("UPDATE transactions SET status=%s,confirmations=%s,block_height=%s,block_hash=%s,network='bitcoin' WHERE id=%s AND wallet_id=%s",
                                 (status,confirmations,item["block_height"],item.get("block_hash"),tx_id,user["wallet_id"]))
                elif old_type == "sent":
                    conn.execute("UPDATE transactions SET status=%s,confirmations=%s,block_height=%s,block_hash=%s,network='bitcoin' WHERE id=%s AND wallet_id=%s",
                                 (status,confirmations,item["block_height"],item.get("block_hash"),tx_id,user["wallet_id"]))
                else:
                    conn.execute("UPDATE transactions SET type=%s,asset='BTC',description=%s,amount=%s,status=%s,network='bitcoin',confirmations=%s,block_height=%s,block_hash=%s WHERE id=%s AND wallet_id=%s",
                                 (item["type"],description,item["amount"],status,confirmations,item["block_height"],item.get("block_hash"),tx_id,user["wallet_id"]))
                item = {**item,"status":status,"confirmations":confirmations}
            else:
                conn.execute("INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network,tx_hash,confirmations,block_height,block_hash) VALUES(%s,%s,%s,'BTC',%s,%s,%s,%s,'bitcoin',%s,%s,%s,%s)",(tx_id,user["wallet_id"],item["type"],description,item["amount"],item["status"],address,item["tx_hash"],item["confirmations"],item["block_height"],item.get("block_hash")))
            imported.append(item)
        # Detect recent confirmed Bitcoin blocks that disappear from the explorer's
        # address history after a reorg, including transactions no longer listed.
        try:
            tip_response = httpx.get("https://blockstream.info/api/blocks/tip/height", timeout=10)
            tip_response.raise_for_status()
            tip_height = int(tip_response.text.strip())
            lookback = max(1, min(int(os.getenv("WORLD_WALLET_BTC_REORG_LOOKBACK_BLOCKS", "144")), 1000))
            saved = conn.execute(
                "SELECT id,block_height,block_hash FROM transactions WHERE wallet_id=%s AND network='bitcoin' "
                "AND block_height BETWEEN %s AND %s AND status IN ('confirmed','settled','broadcast_pending')",
                (user["wallet_id"], max(0, tip_height - lookback + 1), tip_height),
            ).fetchall()
            canonical = {}
            for row_id, height, old_hash in saved:
                if height is None or not old_hash:
                    continue
                height = int(height)
                if height not in canonical:
                    try:
                        response = httpx.get(f"https://blockstream.info/api/block-height/{height}", timeout=10)
                        response.raise_for_status()
                        canonical[height] = response.text.strip()
                    except Exception:
                        canonical[height] = None
                if canonical[height] and old_hash.lower() != canonical[height].lower():
                    conn.execute("UPDATE transactions SET status='reorged',confirmations=0 WHERE id=%s AND wallet_id=%s",(row_id,user["wallet_id"]))
        except Exception:
            pass
        conn.commit()
    return imported

def wallet_valuation_summary(assets, transactions):
    """Summarize wallet exposure using verified current prices.

    Partial totals include only assets/transactions with a positive known quote.
    The corresponding unpriced-symbol lists make omissions explicit.
    """
    # Devnet assets remain visible in the wallet asset list, but must never
    # affect production portfolio valuation or mark production holdings as unpriced.
    devnet_symbols = {"BALMZ-SOL-DEVNET", "SOL-DEVNET"}
    assets = [item for item in assets if str(item.get("symbol", "")) not in devnet_symbols]
    transactions = [item for item in transactions if str(item.get("asset", "")) not in devnet_symbols]
    prices = {str(item["symbol"]): float(item.get("price_usd") or 0) for item in assets}
    available_valuation_complete = all(
        (float(item["balance"] or 0) <= 0 and float(item["reserved_balance"] or 0) <= 0)
        or bool(item.get("price_available"))
        for item in assets
    )
    actual_valuation_complete = all(
        float(item["actual_balance"] or 0) <= 0 or bool(item.get("price_available"))
        for item in assets
    )
    reserved_valuation_complete = all(
        float(item["reserved_balance"] or 0) <= 0 or bool(item.get("price_available"))
        for item in assets
    )

    unpriced_assets = sorted({
        str(item["symbol"]) for item in assets
        if (float(item["balance"] or 0) > 0 or float(item["reserved_balance"] or 0) > 0)
        and not bool(item.get("price_available"))
    })
    unpriced_actual_assets = sorted({
        str(item["symbol"]) for item in assets
        if float(item["actual_balance"] or 0) > 0 and not bool(item.get("price_available"))
    })
    unpriced_reserved_assets = sorted({
        str(item["symbol"]) for item in assets
        if float(item["reserved_balance"] or 0) > 0 and not bool(item.get("price_available"))
    })

    received_txs = [item for item in transactions if item["type"] == "received"]
    sent_txs = [
        item for item in transactions
        if item["type"] in ("sent", "withdrawal") and float(item["amount"] or 0) > 0
    ]
    unpriced_received_assets = sorted({
        str(item["asset"]) for item in received_txs
        if prices.get(str(item["asset"]), 0) <= 0 and float(item["amount"] or 0) > 0
    })
    unpriced_sent_assets = sorted({
        str(item["asset"]) for item in sent_txs
        if prices.get(str(item["asset"]), 0) <= 0 and float(item["amount"] or 0) > 0
    })
    partial_available = sum(
        float(item["value_usd"]) for item in assets if item.get("value_usd") is not None
    )
    partial_actual = sum(
        float(item["actual_value_usd"]) for item in assets if item.get("actual_value_usd") is not None
    )
    partial_reserved = sum(
        float(item["reserved_balance"] or 0) * prices.get(str(item["symbol"]), 0)
        for item in assets if bool(item.get("price_available"))
    )
    partial_received = sum(
        float(item["amount"] or 0) * prices[str(item["asset"])]
        for item in received_txs if prices.get(str(item["asset"]), 0) > 0
    )
    partial_sent = sum(
        float(item["amount"] or 0) * prices[str(item["asset"])]
        for item in sent_txs if prices.get(str(item["asset"]), 0) > 0
    )
    received_valuation_complete = not unpriced_received_assets
    sent_valuation_complete = not unpriced_sent_assets
    received_transaction_count = sum(int(item.get("count", 1)) for item in received_txs)
    sent_transaction_count = sum(int(item.get("count", 1)) for item in sent_txs)

    return {
        "available_balance_usd": partial_available if available_valuation_complete else None,
        "partial_available_balance_usd": partial_available,
        "actual_balance_usd": partial_actual if actual_valuation_complete else None,
        "partial_actual_balance_usd": partial_actual,
        "reserved_balance_usd": partial_reserved if reserved_valuation_complete else None,
        "partial_reserved_balance_usd": partial_reserved,
        "valuation_complete": available_valuation_complete and actual_valuation_complete,
        "reserved_valuation_complete": reserved_valuation_complete,
        "unpriced_assets": unpriced_assets,
        "unpriced_actual_assets": unpriced_actual_assets,
        "unpriced_reserved_assets": unpriced_reserved_assets,
        "total_received_usd": partial_received if received_valuation_complete else None,
        "partial_total_received_usd": partial_received,
        "received_transaction_count": received_transaction_count,
        "unpriced_received_assets": unpriced_received_assets,
        "total_sent_usd": partial_sent if sent_valuation_complete else None,
        "partial_total_sent_usd": partial_sent,
        "sent_transaction_count": sent_transaction_count,
        "unpriced_sent_assets": unpriced_sent_assets,
        "profit_usd": None,
        "change_24h": None,
        "valuation_basis": "current_verified_market_quotes",
    }


def wallet_snapshot(user):
    with db() as conn:
        assets=[]
        for symbol,name,balance,reserved_balance,price in conn.execute(
            "SELECT symbol,name,balance,reserved_balance,price_usd FROM assets WHERE wallet_id=%s ORDER BY symbol",(user["wallet_id"],)
        ):
            actual=Decimal(balance or 0); reserved=Decimal(reserved_balance or 0); available=max(actual-reserved,Decimal("0")); p=Decimal(price or 0)
            price_available = p > 0
            assets.append({"symbol":symbol,"name":name,"balance":float(available),"available_balance":float(available),
                "actual_balance":float(actual),"reserved_balance":float(reserved),"price_usd":float(p),
                "price_available":price_available,
                "live_price_usd":float(p) if price_available else None,
                "value_usd":float(available*p) if price_available else None,
                "actual_value_usd":float(actual*p) if price_available else None,"change_24h":None})
        txs=[]
        for row in conn.execute("SELECT id,type,asset,description,amount,status,tx_hash,confirmations,block_height,network,block_hash,log_index,created_at FROM transactions WHERE wallet_id=%s ORDER BY created_at DESC LIMIT 100",(user["wallet_id"],)):
            txs.append({"id":row[0],"type":row[1],"asset":row[2],"description":row[3],"amount":float(row[4]),"status":row[5],"tx_hash":row[6],"confirmations":int(row[7] or 0),"block_height":row[8],"network":row[9],"block_hash":row[10],"log_index":row[11],"time":row[12].isoformat()})
        # Dashboard activity remains capped at 100 records, but the received/sent
        # valuation summaries must cover all recorded rows, not only that page.
        transaction_totals=[]
        for row in conn.execute("""
            SELECT type,asset,SUM(ABS(amount)),COUNT(*)
            FROM transactions
            WHERE wallet_id=%s
              AND (type='received' OR (type IN ('sent','withdrawal') AND amount < 0))
            GROUP BY type,asset
        """,(user["wallet_id"],)):
            transaction_totals.append({"type":row[0],"asset":row[1],"amount":float(row[2] or 0),"count":int(row[3] or 0)})
    return assets,txs,wallet_valuation_summary(assets,transaction_totals)


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




@app.post("/api/v1/auth/neon/password")
def neon_password_login(request: NeonAuthCredentials):
    return _neon_auth_sign_in("/sign-in/email", {
        "email": request.email.strip().lower(),
        "password": request.password,
        "rememberMe": True,
    })

def _normalise_phone_number(value: str) -> str:
    phone = re.sub(r"[\s()-]", "", value or "")
    if not re.fullmatch(r"\+[1-9]\d{7,14}", phone):
        raise HTTPException(status_code=400, detail="Enter a valid phone number in international format, for example +2348012345678.")
    return phone


def _twilio_verify_request(phone_number: str, code: str | None = None):
    if not (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID):
        raise HTTPException(status_code=503, detail="Phone verification is not configured. The SMS provider credentials and Verify Service must be configured by the operator.")
    url = f"https://verify.twilio.com/v2/Services/{TWILIO_VERIFY_SERVICE_SID}/" + ("VerificationCheck" if code is not None else "Verifications")
    form = {"To": phone_number, "Channel": "sms"}
    if code is not None:
        form["Code"] = code.strip()
    try:
        response = httpx.post(url, data=form, auth=(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN), timeout=15.0)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Phone verification provider could not be reached. Please try again.") from exc
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    if not response.is_success:
        # Never return provider credentials or raw provider responses to clients.
        detail = "Unable to send phone verification code." if code is None else "Phone verification failed."
        raise HTTPException(status_code=502 if response.status_code >= 500 else 400, detail=detail)
    if code is None:
        if payload.get("status") not in {"pending", "approved"}:
            raise HTTPException(status_code=502, detail="Phone verification provider did not accept the SMS request.")
        return payload
    return payload.get("status") == "approved"


@app.post("/api/v1/auth/phone/send-otp")
def send_registration_phone_otp(request: PhoneOtpRequest):
    phone = _normalise_phone_number(request.phone_number)
    # Provider configuration is required; no pretend/simulated SMS codes are issued.
    if not (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID):
        raise HTTPException(status_code=503, detail="Phone verification is not configured. The SMS provider credentials and Verify Service must be configured by the operator.")
    # Add a local per-number throttle as well as the provider's own Verify limits.
    with db() as conn:
        counts = conn.execute(
            "SELECT COUNT(*) FILTER (WHERE requested_at > NOW() - INTERVAL '1 minute'), "
            "COUNT(*) FILTER (WHERE requested_at > NOW() - INTERVAL '1 hour') "
            "FROM phone_otp_requests WHERE phone_number=%s",
            (phone,),
        ).fetchone()
        if counts and (counts[0] >= 1 or counts[1] >= 5):
            raise HTTPException(status_code=429, detail="Too many verification requests. Wait before requesting another code.")
        conn.execute("INSERT INTO phone_otp_requests(phone_number) VALUES(%s)", (phone,))
        conn.commit()
    _twilio_verify_request(phone)
    return {"ok": True, "message": "If the phone number can receive verification SMS, a code has been requested."}


@app.post("/api/v1/auth/neon/register")
def neon_register(request: NeonAuthRegistration):
    name = request.name.strip()
    email = request.email.strip().lower()
    phone = _normalise_phone_number(request.phone_number)
    if not name:
        raise HTTPException(status_code=400, detail="Enter your name")
    if not request.phone_otp.strip():
        raise HTTPException(status_code=400, detail="Enter the SMS verification code.")
    # Check conflicts before creating the external Neon Auth identity.
    with db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE phone_number=%s", (phone,)).fetchone():
            raise HTTPException(status_code=409, detail="That phone number is already linked to an account.")
    if not _twilio_verify_request(phone, request.phone_otp):
        raise HTTPException(status_code=400, detail="The phone verification code is invalid or expired.")
    # Create the Neon Auth identity only after the SMS code has been verified.
    signed_in = _neon_auth_sign_in("/sign-up/email", {
        "name": name,
        "email": email,
        "password": request.password,
    })
    user = signed_in.get("user")
    if isinstance(user, dict):
        try:
            with db() as conn:
                conn.execute(
                    "UPDATE users SET name=%s, phone_number=%s, phone_verified_at=NOW() WHERE lower(email)=lower(%s)",
                    (name, phone, email),
                )
                conn.commit()
        except psycopg.errors.UniqueViolation as exc:
            raise HTTPException(status_code=409, detail="That phone number is already linked to an account.") from exc
        refreshed = get_user(email)
        if refreshed:
            signed_in["user"] = refreshed
    else:
        raise HTTPException(status_code=502, detail="The authentication provider did not return a user identity.")
    return signed_in


@app.post("/api/v1/auth/neon/send-otp")
def neon_send_otp(request: NeonAuthOtpRequest):
    _neon_auth_post("/email-otp/send-verification-otp", {
        "email": request.email.strip().lower(),
        "type": "sign-in",
    })
    return {"ok": True}


@app.post("/api/v1/auth/neon/otp")
def neon_otp_login(request: NeonAuthOtpRequest):
    return _neon_auth_sign_in("/sign-in/email-otp", {
        "email": request.email.strip().lower(),
        "otp": request.otp.strip(),
    })


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


def _chain_heights():
    heights = {}
    try:
        if BTC_ADDRESS:
            heights["bitcoin"] = int(httpx.get("https://blockstream.info/api/blocks/tip/height", timeout=8).text.strip())
    except Exception:
        heights["bitcoin"] = None
    for network, url in (("ethereum", ETH_RPC_URL), ("bnb", BSC_RPC_URL), ("sepolia", SEPOLIA_RPC_URL)):
        if url:
            try:
                heights[network] = _hex_int(rpc_call(url, "eth_blockNumber", []))
            except Exception:
                heights[network] = None
    return heights


def _network_sync_status(user, warnings, updates, transaction_sync_at=None):
    now = datetime.now(timezone.utc).isoformat()
    warning_text = {network: next((w for w in warnings if network in w.lower()), None) for network in ("bitcoin", "ethereum", "bnb", "sepolia")}
    updated_networks = {str(item.get("network")) for item in updates}
    chain_heights = _chain_heights()
    address_configured = {
        "bitcoin": bool(wallet_network_address(user, "bitcoin")),
        "ethereum": bool(wallet_network_address(user, "ethereum")),
        "bnb": bool(wallet_network_address(user, "bnb")),
        "sepolia": bool(wallet_network_address(user, "sepolia")),
    }
    rpc_configured = {
        "bitcoin": True,  # Bitcoin balances use the configured public Blockstream API.
        "ethereum": bool(ETH_RPC_URL),
        "bnb": bool(BSC_RPC_URL),
        "sepolia": bool(SEPOLIA_RPC_URL),
    }
    configured = {network: address_configured[network] and rpc_configured[network]
                  for network in ("bitcoin", "ethereum", "bnb", "sepolia")}
    result = {}
    for network in ("bitcoin", "ethereum", "bnb", "sepolia"):
        warning = warning_text[network]
        sepolia_healthy = network == "sepolia" and configured[network] and chain_heights.get(network) is not None
        result[network] = {
            "configured": configured[network],
            "address_configured": address_configured[network],
            "rpc_configured": rpc_configured[network],
            "status": "healthy" if (network in updated_networks or sepolia_healthy) and not warning else (
                "warning" if configured[network] and (warning or (network == "sepolia" and chain_heights.get(network) is None)) else "not_configured"
            ),
            "configuration_message": (
                "Blockchain RPC is responding; add an Ethereum wallet address to enable balance syncing."
                if network == "ethereum" and rpc_configured[network] and not address_configured[network]
                else "Ethereum RPC is not configured on the backend."
                if network == "ethereum" and not rpc_configured[network]
                else None
            ),
            "last_balance_sync_at": now if network in updated_networks else None,
            "last_transaction_sync_at": transaction_sync_at if network in updated_networks and not warning else None,
            "chain_height": chain_heights.get(network),
            "warning": warning or ("Sepolia RPC unavailable" if network == "sepolia" and configured[network] and chain_heights.get(network) is None else None),
        }
    return result


def wallet_asset_symbol(symbol: str, network: str) -> str:
    """Keep identical token symbols on different chains in separate wallet assets."""
    return "USDT-BNB" if network == "bnb" and symbol == "USDT" else symbol


def _sync_wallet_impl(user: dict, *, include_transactions: bool = True):
    eth_address = wallet_network_address(user, "ethereum")
    bnb_address = wallet_network_address(user, "bnb")
    btc_address = wallet_network_address(user, "bitcoin")
    sepolia_address = wallet_network_address(user, "sepolia")
    solana_address = wallet_network_address(user, "solana_devnet")
    if not btc_address and not eth_address and not bnb_address and not sepolia_address and not solana_address:
        raise HTTPException(status_code=503, detail="No wallet address is configured")
    updates = []
    warnings = []
    with db() as conn:
        if btc_address:
            try:
                btc = btc_balance(btc_address)
                if btc is not None:
                    conn.execute("UPDATE assets SET balance=%s WHERE wallet_id=%s AND symbol='BTC'", (btc,user["wallet_id"]))
                    updates.append({"network":"bitcoin","asset":"BTC","balance":btc})
            except Exception:
                warnings.append("Bitcoin balance service unavailable")
        if solana_address and SOLANA_DEVNET_RPC_URL:
            try:
                raw_sol = rpc_call(SOLANA_DEVNET_RPC_URL, "getBalance", [solana_address, {"commitment": "confirmed"}])
                sol_balance = int((raw_sol or {}).get("value", 0)) / 1_000_000_000
                conn.execute(
                    "INSERT INTO assets(wallet_id,symbol,name,balance,price_usd) VALUES(%s,%s,%s,%s,0) "
                    "ON CONFLICT(wallet_id,symbol) DO UPDATE SET balance=EXCLUDED.balance,name=EXCLUDED.name",
                    (user["wallet_id"], "SOL-DEVNET", "Solana Devnet SOL", sol_balance),
                )
                # This sync path previously stored Devnet SOL in the production SOL row.
                # Clear that legacy value only after a confirmed live Devnet balance was read.
                conn.execute("UPDATE assets SET balance=0 WHERE wallet_id=%s AND symbol='SOL'", (user["wallet_id"],))
                updates.append({"network":"solana-devnet","asset":"SOL-DEVNET","balance":sol_balance})
            except Exception:
                warnings.append("Solana Devnet balance service unavailable")
        elif solana_address:
            warnings.append("Solana Devnet RPC is not configured; SOL balance sync skipped")
        if solana_address:
            try:
                balmz_balance = solana_spl_token_balance(solana_address)
                conn.execute(
                    "INSERT INTO assets(wallet_id,symbol,name,balance,price_usd) VALUES(%s,%s,%s,%s,0) "
                    "ON CONFLICT(wallet_id,symbol) DO UPDATE SET balance=EXCLUDED.balance,name=EXCLUDED.name",
                    (user["wallet_id"], "BALMZ-SOL-DEVNET", "BALMZ Token (Solana Devnet)", balmz_balance),
                )
                updates.append({
                    "network": "solana-devnet",
                    "asset": "BALMZ-SOL-DEVNET",
                    "balance": balmz_balance,
                    "contract_address": BALMZ_SOLANA_DEVNET_MINT,
                    "decimals": BALMZ_SOLANA_DEVNET_DECIMALS,
                })
            except Exception:
                warnings.append("BALMZ Solana Devnet token balance service unavailable")
        if ETH_RPC_URL and eth_address:
            try:
                require_ethereum_mainnet_rpc(ETH_RPC_URL)
                eth = evm_balance(ETH_RPC_URL, eth_address)
                conn.execute("UPDATE assets SET balance=%s WHERE wallet_id=%s AND symbol='ETH'", (eth,user["wallet_id"]))
                updates.append({"network":"ethereum","asset":"ETH","balance":eth})
            except Exception:
                warnings.append("Ethereum balance service unavailable")
        if BSC_RPC_URL and bnb_address:
            try:
                bnb = evm_balance(BSC_RPC_URL, bnb_address)
                conn.execute("UPDATE assets SET balance=%s WHERE wallet_id=%s AND symbol='BNB'", (bnb,user["wallet_id"]))
                updates.append({"network":"bnb","asset":"BNB","balance":bnb})
            except Exception:
                warnings.append("BNB Chain balance service unavailable")

        token_rows = conn.execute(
            "SELECT symbol,name,network,contract_address,decimals,status "
            "FROM token_registry WHERE contract_address IS NOT NULL "
            "AND decimals IS NOT NULL AND status='active' ORDER BY symbol,network"
        ).fetchall()
        for symbol, name, network, contract, decimals, status in token_rows:
            rpc_url = ETH_RPC_URL if network == "ethereum" else BSC_RPC_URL if network == "bnb" else SEPOLIA_RPC_URL if network == "sepolia" else None
            token_address = eth_address if network == "ethereum" else bnb_address if network == "bnb" else wallet_network_address(user, "sepolia") if network == "sepolia" else None
            if not rpc_url or not token_address:
                continue
            try:
                if network == "sepolia":
                    require_sepolia_rpc(rpc_url)
                balance = erc20_balance(rpc_url, contract, token_address, int(decimals))
                if balance is None:
                    continue
                # Asset balances are keyed by symbol, so never combine the same
                # token symbol across chains. Keep Ethereum USDT as USDT and
                # represent BNB Chain USDT separately.
                asset_symbol = wallet_asset_symbol(symbol, network)
                asset_name = f"{name} (BNB Chain)" if asset_symbol == "USDT-BNB" else name
                conn.execute(
                    "INSERT INTO assets(wallet_id,symbol,name,balance,price_usd) VALUES(%s,%s,%s,%s,0) "
                    "ON CONFLICT(wallet_id,symbol) DO UPDATE SET balance=EXCLUDED.balance,name=EXCLUDED.name",
                    (user["wallet_id"],asset_symbol,asset_name,balance),
                )
                updates.append({"network":network,"asset":asset_symbol,"balance":balance,
                                "contract_address":contract,"decimals":int(decimals)})
            except Exception:
                warnings.append(f"{network} {symbol} token balance service unavailable")
        conn.commit()
    imported_transactions = []
    evm_transactions = []
    if include_transactions:
        imported_transactions = sync_bitcoin_transactions(user, btc_address)
        evm_warnings = []
        for rpc_url, network, contract, token_symbol, network_address in (
            (ETH_RPC_URL, "ethereum", USDT_ETH_CONTRACT, "USDT", eth_address),
            (BSC_RPC_URL, "bnb", USDT_BSC_CONTRACT, "USDT-BNB", bnb_address),
            (SEPOLIA_RPC_URL, "sepolia", BALMZ_SEPOLIA_CONTRACT, "BALMZ-SEP", sepolia_address),
        ):
            if rpc_url and network_address:
                native_imported, native_warning = sync_evm_native_transactions(user, rpc_url, network, network_address)
                evm_transactions.extend(native_imported)
                if native_warning:
                    evm_warnings.append(native_warning)
                if contract:
                    imported, warning = sync_evm_token_transactions(
                        user, rpc_url, network, contract, token_symbol, wallet_address=network_address,
                        decimals=18 if network == "sepolia" else 6,
                    )
                    evm_transactions.extend(imported)
                    if warning:
                        evm_warnings.append(warning)
        warnings.extend(evm_warnings)
    assets, all_transactions, summary = wallet_snapshot(user)
    if btc_address and not imported_transactions:
        # An empty result can be a legitimate zero-transaction wallet; do not label it
        # as an error because the balance and transaction endpoint may still be healthy.
        pass
    # A configured address is not proof that history synced successfully. Only publish a
    # success timestamp when every configured transaction source completed without warnings.
    last_transaction_sync_at = datetime.now(timezone.utc).isoformat() if include_transactions and (btc_address or eth_address or bnb_address or sepolia_address) and not warnings else None
    network_status = _network_sync_status(user, warnings, updates, last_transaction_sync_at)
    last_balance_sync_at = datetime.now(timezone.utc).isoformat() if updates else None
    return {"status":"synced_with_warnings" if warnings else "synced","wallet":{**summary,"wallet_id":user["wallet_id"],"owner_id":user["id"]},"assets":assets,"updates":updates,"warnings":warnings,"bitcoin_transactions":imported_transactions,"evm_transactions":evm_transactions,"transactions":all_transactions,"network_status":network_status,"last_balance_sync_at":last_balance_sync_at,"last_transaction_sync_at":last_transaction_sync_at}


@app.post("/api/v1/wallet/sync")
def sync_wallet(user: dict = Depends(current_user)):
    # Keep the public sync endpoint's existing behavior: balances plus transaction history.
    return _sync_wallet_impl(user, include_transactions=True)


# Process-local cache of verified provider responses. Cache entries expire after 15 minutes;
# stale responses are explicitly flagged and never fabricated from zero/default values.
_MARKET_PRICE_CACHE = MarketPriceCache(max_age_seconds=900)

def _coinbase_spot_price_fallback():
    """Fetch real USD spot quotes from Coinbase when CoinGecko is unavailable.

    Unsupported pairs stay unlisted; no synthetic values or 24-hour changes are added.
    """
    pairs = {
        "BTC": "BTC-USD", "USDT": "USDT-USD", "ETH": "ETH-USD",
        "USDC": "USDC-USD", "SOL": "SOL-USD", "XRP": "XRP-USD",
        "ADA": "ADA-USD", "LTC": "LTC-USD", "DOGE": "DOGE-USD",
        "BNB": "BNB-USD",
    }
    prices = {}
    def fetch(symbol, product):
        response = httpx.get(
            f"https://api.coinbase.com/v2/prices/{product}/spot",
            timeout=4,
            headers={"Accept": "application/json"},
        )
        response.raise_for_status()
        amount = response.json().get("data", {}).get("amount")
        value = float(amount) if amount is not None else None
        if value is None or value <= 0:
            return symbol, None
        return symbol, {"usd": value, "usd_24h_change": None, "listed": True}

    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(fetch, symbol, product): symbol for symbol, product in pairs.items()}
        for future in as_completed(futures):
            symbol = futures[future]
            try:
                key, quote = future.result()
                prices[key] = quote or {"usd": None, "usd_24h_change": None, "listed": False}
            except Exception as exc:
                logger.info("Coinbase spot fallback unavailable: asset=%s error_type=%s",
                            symbol, type(exc).__name__)
                prices[symbol] = {"usd": None, "usd_24h_change": None, "listed": False}

    prices["USDT-BNB"] = dict(prices.get("USDT", {"usd": None, "usd_24h_change": None, "listed": False}))
    prices["BALMZ"] = {
        "usd": None, "usd_24h_change": None, "listed": False,
        "eth_reference_usd": prices.get("ETH", {}).get("usd"),
    }
    prices["BALMZ-SEP"] = {"usd": None, "usd_24h_change": None, "listed": False}
    if not any(item.get("listed") and item.get("usd") is not None for item in prices.values()):
        return None
    return {
        "source": "Coinbase",
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "prices": prices,
        "stale": False,
        "cache_age_seconds": 0,
        "note": "Spot prices from fallback provider; 24-hour changes are unavailable.",
    }


@app.get("/api/v1/prices/market")
def market_prices():
    """Public market quotes for the wallet's supported coin catalog."""
    global _MARKET_PRICE_CACHE
    # Reuse the last verified quote for one minute. The frontend refreshes at a
    # similar cadence, so this avoids duplicate provider calls from multiple
    # dashboard panels while still exposing a fresh timestamp and cache age.
    cached = _MARKET_PRICE_CACHE.fresh_response(max_age_seconds=60)
    if cached is not None:
        return cached
    coin_ids = {
        "BTC":"bitcoin","USDT":"tether","USDT-BNB":"tether","ETH":"ethereum","BNB":"binancecoin",
        "USDC":"usd-coin","SOL":"solana","XRP":"ripple","ADA":"cardano",
        "LTC":"litecoin","DOGE":"dogecoin",
    }
    try:
        response = httpx.get(
            f"{_active_coingecko_config()[1]}/simple/price",
            params={
                "ids": ",".join(coin_ids.values()),
                "vs_currencies": "usd",
                "include_24hr_change": "true",
            },
            headers=coingecko_headers(),
            timeout=8,
        )
        response.raise_for_status()
        raw = response.json()
    except Exception as exc:
        # Log only provider/status metadata, never request headers or API keys.
        status = getattr(getattr(exc, "response", None), "status_code", None)
        logger.warning("CoinGecko market-price request failed: error_type=%s status=%s",
                       type(exc).__name__, status)
        # Prefer a recent successful quote, then try an independent spot-price provider.
        fallback = _MARKET_PRICE_CACHE.stale_response()
        if fallback is not None:
            logger.info("Serving cached market quotes: age_seconds=%s", fallback.get("cache_age_seconds"))
            return fallback
        backup = _coinbase_spot_price_fallback()
        if backup is not None:
            _MARKET_PRICE_CACHE.store(backup)
            logger.warning("Serving fresh spot quotes from Coinbase fallback; 24h changes are unavailable")
            return backup
        raise HTTPException(status_code=503, detail="Live market price service unavailable") from exc

    prices = {}
    for symbol, coin_id in coin_ids.items():
        quote = raw.get(coin_id, {})
        usd = quote.get("usd")
        prices[symbol] = {
            "usd": float(usd) if usd is not None else None,
            "usd_24h_change": float(quote["usd_24h_change"]) if quote.get("usd_24h_change") is not None else None,
            "listed": usd is not None,
        }
    # BALMZ has no verified market quote yet. Never invent a price.
    prices["BALMZ"] = {"usd": None, "usd_24h_change": None, "listed": False, "eth_reference_usd": prices.get("ETH", {}).get("usd")}
    prices["BALMZ-SEP"] = {"usd": None, "usd_24h_change": None, "listed": False}
    payload = {
        "source": "CoinGecko",
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "prices": prices,
        "stale": False,
        "cache_age_seconds": 0,
    }
    _MARKET_PRICE_CACHE.store(payload)
    return payload


@app.get("/api/v1/prices/history/{symbol}")
def market_price_history(symbol: str, days: int = 1):
    """Return provider-sourced market history; unlisted tokens remain uncharted."""
    coin_ids = {"BTC":"bitcoin","USDT":"tether","ETH":"ethereum","BNB":"binancecoin","USDC":"usd-coin","SOL":"solana","XRP":"ripple","ADA":"cardano","LTC":"litecoin","DOGE":"dogecoin"}
    key = symbol.strip().upper()
    if key not in coin_ids:
        raise HTTPException(status_code=404, detail="No verified market history is available for this token")
    if days not in (1, 7, 14, 30):
        raise HTTPException(status_code=400, detail="Supported chart ranges are 1, 7, 14, or 30 days")
    try:
        response = httpx.get(f"{_active_coingecko_config()[1]}/coins/{coin_ids[key]}/market_chart", params={"vs_currency":"usd","days":days}, headers=coingecko_headers(), timeout=12)
        response.raise_for_status()
        raw = response.json()
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Verified market history service unavailable") from exc
    points = [{"timestamp":int(item[0]),"price":float(item[1])} for item in raw.get("prices",[]) if isinstance(item,list) and len(item)>=2 and item[1] is not None]
    if len(points)<2:
        raise HTTPException(status_code=503, detail="Provider returned insufficient market history")
    return {"symbol":key,"currency":"USD","days":days,"source":"CoinGecko","points":points}


@app.post("/api/v1/prices/refresh")
def refresh_prices(user: dict = Depends(current_user)):
    coin_ids = {
        "BTC":"bitcoin","USDT":"tether","ETH":"ethereum","BNB":"binancecoin",
        "USDC":"usd-coin","SOL":"solana","XRP":"ripple","ADA":"cardano",
        "LTC":"litecoin","DOGE":"dogecoin",
    }
    try:
        response = httpx.get(
            f"{_active_coingecko_config()[1]}/simple/price",
            params={"ids":",".join(coin_ids.values()),"vs_currencies":"usd"},
            headers=coingecko_headers(),
            timeout=8,
        )
        response.raise_for_status()
        raw = response.json()
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Live market price service unavailable") from exc
    with db() as conn:
        market_prices = {}
        for symbol, coin_id in coin_ids.items():
            quote = raw.get(coin_id, {}).get("usd") if isinstance(raw, dict) else None
            # A missing quote is not a zero-dollar price. Reject the incomplete
            # provider response before writing any values, preserving the last
            # known prices rather than replacing them with fabricated zeros.
            if not isinstance(quote, (int, float)) or isinstance(quote, bool) or quote <= 0:
                raise HTTPException(status_code=503, detail="Live market price response is missing a valid quote for one or more supported assets")
            market_prices[symbol] = float(quote)
        # BALMZ has no verified market quote; zero is retained only as the
        # existing internal placeholder, and the frontend labels it Not listed.
        market_prices["BALMZ"] = 0.0
        market_prices["BALMZ-SEP"] = 0.0
        for symbol, price in market_prices.items():
            conn.execute("UPDATE assets SET price_usd=%s WHERE wallet_id=%s AND symbol=%s", (price,user["wallet_id"],symbol))
        conn.commit()
    assets, _, summary = wallet_snapshot(user)
    return {"assets":assets,"wallet":summary,"source":"coingecko+token_registry","balmz_price_usd":0.0}

@app.post("/api/v1/wallet/refresh")
def refresh_wallet(user: dict = Depends(current_user)):
    started_at = datetime.now(timezone.utc)
    updates = []
    sync_error = None
    transaction_sync_error = None
    last_transaction_sync_at = None
    price_error = None
    sync_result = {}
    bitcoin_transactions = []

    try:
        sync_result = _sync_wallet_impl(user, include_transactions=False)
        updates = sync_result.get("updates", [])
        bitcoin_transactions = sync_result.get("bitcoin_transactions", [])
        sync_error = " • ".join(sync_result.get("warnings", [])) or None
    except HTTPException as exc:
        sync_error = str(exc.detail)
    except Exception:
        sync_error = "Wallet chain synchronization failed"

    # Keep transaction history verification separate from balance reads so one
    # failing transaction source does not discard a valid balance snapshot.
    try:
        transaction_result = sync_transactions(user)
        bitcoin_transactions = transaction_result.get("imported", bitcoin_transactions)
        tx_warnings = transaction_result.get("warnings", [])
        transaction_sync_error = " • ".join(tx_warnings) or None
        if transaction_sync_error is None:
            last_transaction_sync_at = datetime.now(timezone.utc).isoformat()
    except HTTPException as exc:
        transaction_sync_error = str(exc.detail)
    except Exception:
        transaction_sync_error = "Wallet transaction synchronization failed"

    # Market quotes are fetched separately by /api/v1/prices/market. Avoid a
    # second synchronous provider request here so the wallet response is faster.
    assets_now, transactions_now, summary_now = wallet_snapshot(user)
    warnings = [x for x in (sync_error, transaction_sync_error) if x]
    network_status = sync_result.get("network_status") or _network_sync_status(user, warnings, [])
    return {
        "status": "refreshed_with_warnings" if warnings else "refreshed",
        "wallet": {**summary_now, "wallet_id": user["wallet_id"], "owner_id": user["id"]},
        "assets": assets_now,
        "transactions": transactions_now,
        "updates": updates,
        "bitcoin_transactions": bitcoin_transactions,
        "price_source": None,
        "warnings": warnings,
        "network_status": network_status,
        "last_balance_sync_at": sync_result.get("last_balance_sync_at"),
        "last_transaction_sync_at": last_transaction_sync_at,
        "refreshed_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000),
    }

@app.get("/api/v1/system/status")
def system_status(user: dict = Depends(current_user)):
    # Report the active user's saved addresses, not service-level defaults, and
    # do not imply the API itself broadcasts transactions when signing is external.
    return {
        "status": "ok",
        "database": bool(DATABASE_URL),
        "neon_auth": bool(NEON_JWKS_CLIENT),
        "bitcoin": bool(wallet_network_address(user, "bitcoin")),
        "ethereum": bool(wallet_network_address(user, "ethereum") and ETH_RPC_URL),
        "bnb": bool(wallet_network_address(user, "bnb") and BSC_RPC_URL),
        "sepolia": bool(wallet_network_address(user, "sepolia") and SEPOLIA_RPC_URL),
        "live_prices": bool(_active_coingecko_config()[0]),
        "price_assets": ["BALMZ","BALMZ-SEP","BTC","ETH","USDT","BNB","USDC","SOL","XRP","ADA","LTC","DOGE"],
        "read_only_chain_sync": True,
        "transaction_broadcast": False,
        "transaction_broadcast_mode": "external_wallet_signed_by_client",
    }

@app.get("/api/v1/assets")
def assets(user: dict = Depends(current_user)):
    a,_,_ = wallet_snapshot(user)
    return {"assets":a}


@app.post("/api/v1/portfolio/performance/snapshot")
def record_portfolio_performance_snapshot(user: dict = Depends(current_user)):
    """Record a timestamped portfolio value only when the full USD valuation is verified."""
    _, _, summary = wallet_snapshot(user)
    value = summary.get("available_balance_usd")
    if value is None or summary.get("valuation_complete") is not True:
        return {"recorded": False, "reason": "A complete verified USD valuation is not available yet."}
    with db() as conn:
        # Avoid duplicate points from repeated reloads; keep at most one sample per 5 minutes.
        inserted = conn.execute(
            """
            INSERT INTO portfolio_performance_snapshots(wallet_id, value_usd)
            SELECT %s, %s
            WHERE NOT EXISTS (
              SELECT 1 FROM portfolio_performance_snapshots
              WHERE wallet_id=%s AND created_at > NOW() - INTERVAL '5 minutes'
            )
            RETURNING created_at
            """,
            (user["wallet_id"], Decimal(str(value)), user["wallet_id"]),
        ).fetchone()
        latest = inserted[0] if inserted else conn.execute(
            "SELECT created_at FROM portfolio_performance_snapshots WHERE wallet_id=%s ORDER BY created_at DESC LIMIT 1",
            (user["wallet_id"],),
        ).fetchone()
    return {"recorded": bool(inserted), "timestamp": latest[0].isoformat() if latest and latest[0] else None,
            "value_usd": float(value), "currency": "USD"}


@app.get("/api/v1/portfolio/performance")
def performance(period: str = "1M", user: dict = Depends(current_user)):
    period = str(period or "1M").strip().upper()
    windows = {"1D": "1 day", "1W": "7 days", "1M": "30 days", "1Y": "365 days"}
    if period not in windows:
        raise HTTPException(status_code=400, detail="Period must be one of 1D, 1W, 1M, or 1Y")
    interval = windows[period]
    with db() as conn:
        rows = conn.execute(
            """
            SELECT created_at, value_usd
            FROM portfolio_performance_snapshots
            WHERE wallet_id=%s AND created_at >= NOW() - (%s)::interval
            ORDER BY created_at ASC
            """,
            (user["wallet_id"], interval),
        ).fetchall()
    points = [
        {
            "timestamp": row[0].isoformat() if row[0] else None,
            "label": row[0].astimezone(timezone.utc).strftime("%b %d %H:%M") if row[0] else "",
            "value_usd": float(row[1]),
        }
        for row in rows
    ]
    first = points[0]["value_usd"] if points else None
    last = points[-1]["value_usd"] if points else None
    change_percent = ((last - first) / first * 100) if first not in (None, 0) and last is not None else None
    return {"currency": "USD", "period": period, "change_percent": change_percent, "points": points,
            "history_source": "timestamped_portfolio_snapshots"}


@app.get("/api/v1/transactions")
def transactions(user: dict = Depends(current_user), limit: int = 50, offset: int = 0):
    # Keep history scoped to the authenticated user's active wallet. A bounded page
    # avoids silently truncating history at the old fixed 100-row snapshot limit.
    if limit < 1 or limit > 100:
        raise HTTPException(status_code=400, detail="Transaction history limit must be between 1 and 100")
    if offset < 0:
        raise HTTPException(status_code=400, detail="Transaction history offset cannot be negative")
    wallet_id = user["wallet_id"]
    with db() as conn:
        total_row = conn.execute(
            "SELECT COUNT(*) FROM transactions WHERE wallet_id=%s",
            (wallet_id,),
        ).fetchone()
        total = int(total_row[0] or 0) if total_row else 0
        rows = conn.execute(
            "SELECT id,type,asset,description,amount,status,tx_hash,confirmations,block_height,network,block_hash,log_index,created_at "
            "FROM transactions WHERE wallet_id=%s ORDER BY created_at DESC,id DESC LIMIT %s OFFSET %s",
            (wallet_id, limit, offset),
        ).fetchall()
    txs = [{
        "id": row[0], "type": row[1], "asset": row[2], "description": row[3],
        "amount": float(row[4]), "status": row[5], "tx_hash": row[6],
        "confirmations": int(row[7] or 0), "block_height": row[8], "network": row[9],
        "block_hash": row[10], "log_index": row[11],
        "time": row[12].isoformat() if row[12] else None,
    } for row in rows]
    next_offset = offset + len(txs)
    return {
        "transactions": txs,
        "pagination": {
            "limit": limit, "offset": offset, "total": total,
            "has_more": next_offset < total,
            "next_offset": next_offset if next_offset < total else None,
        },
    }

@app.post("/api/v1/transactions/sync")
def sync_transactions(user: dict = Depends(current_user)):
    imported = []
    warnings = []
    sepolia_address = wallet_network_address(user, "sepolia")
    btc_address = wallet_network_address(user, "bitcoin")
    if btc_address:
        try:
            balance = btc_balance(btc_address)
            if balance is not None:
                with db() as conn:
                    conn.execute("UPDATE assets SET balance=%s WHERE wallet_id=%s AND symbol='BTC'", (balance,user["wallet_id"]))
                    conn.commit()
            imported.extend(sync_bitcoin_transactions(user, btc_address))
        except Exception:
            warnings.append("Bitcoin transaction service unavailable")
    for rpc_url, network, contract in (
        (ETH_RPC_URL, "ethereum", USDT_ETH_CONTRACT),
        (BSC_RPC_URL, "bnb", USDT_BSC_CONTRACT),
        (SEPOLIA_RPC_URL if sepolia_address else "", "sepolia", BALMZ_SEPOLIA_CONTRACT),
    ):
        if rpc_url:
            if network == "sepolia":
                try:
                    require_sepolia_rpc(rpc_url)
                except Exception:
                    warnings.append("Sepolia RPC chain ID mismatch or unavailable; Sepolia sync skipped.")
                    continue
            native_imported, native_warning = sync_evm_native_transactions(user, rpc_url, network, wallet_network_address(user, network))
            imported.extend(native_imported)
            if native_warning:
                warnings.append(native_warning)
            with db() as conn:
                token_rows = conn.execute(
                    "SELECT symbol,contract_address,decimals FROM token_registry "
                    "WHERE network=%s AND contract_address IS NOT NULL AND decimals IS NOT NULL AND status='active'",
                    (network,),
                ).fetchall()
            for symbol, token_contract, token_decimals in token_rows:
                transaction_symbol = wallet_asset_symbol(symbol, network)
                token_imported, warning = sync_evm_token_transactions(
                    user, rpc_url, network, token_contract, transaction_symbol,
                    decimals=int(token_decimals), wallet_address=wallet_network_address(user, network)
                )
                imported.extend(token_imported)
                if warning:
                    warnings.append(warning)
        elif wallet_network_address(user, network):
            warnings.append(f"{network.title()} RPC is not configured; {network.title()} transaction sync skipped.")
    supported_source_configured = bool(btc_address) or any(
        wallet_network_address(user, network) and rpc_url
        for network, rpc_url in (
            ("ethereum", ETH_RPC_URL),
            ("bnb", BSC_RPC_URL),
            ("sepolia", SEPOLIA_RPC_URL),
        )
    )
    if not imported and not supported_source_configured:
        detail = (
            "Sepolia transaction history is not yet supported by live sync."
            if sepolia_address
            else "No live transaction source is configured for this wallet."
        )
        raise HTTPException(status_code=503, detail=detail)
    assets,tx,summary = wallet_snapshot(user)
    return {"status":"synced_with_warnings" if warnings else "synced","imported":imported,"warnings":warnings,
            "transactions":tx,"assets":assets,"wallet":{**summary,"wallet_id":user["wallet_id"],"owner_id":user["id"]}}




@app.get("/api/v1/wallet/signing-config")
def wallet_signing_config(user: dict = Depends(current_user)):
    # External-wallet signing only: the API never receives or stores a private key.
    ethereum_address = wallet_network_address(user, "ethereum")
    bnb_address = wallet_network_address(user, "bnb")
    bitcoin_address = wallet_network_address(user, "bitcoin")
    return {
        "mode": "external_signer",
        "networks": {
            "ethereum": {
                "chain_id": "0x1",
                "wallet_address": ethereum_address if ETH_RPC_URL else None,
                "usdt_contract": USDT_ETH_CONTRACT or None,
                "usdt_decimals": erc20_decimals(ETH_RPC_URL, USDT_ETH_CONTRACT) if ETH_RPC_URL and USDT_ETH_CONTRACT else None,
                "balmz_contract": BALMZ_ETH_CONTRACT or None,
                "balmz_decimals": erc20_decimals(ETH_RPC_URL, BALMZ_ETH_CONTRACT) if ETH_RPC_URL and BALMZ_ETH_CONTRACT else None,
            },
            "bnb": {
                "chain_id": "0x38",
                "wallet_address": bnb_address if BSC_RPC_URL else None,
                "usdt_contract": USDT_BSC_CONTRACT or None,
                "usdt_decimals": erc20_decimals(BSC_RPC_URL, USDT_BSC_CONTRACT) if BSC_RPC_URL and USDT_BSC_CONTRACT else None,
            },
            # Sepolia is a separate test network. Do not query token metadata here:
            # only the chain-checked sync path may call the configured Sepolia RPC.
            "sepolia": {
                "chain_id": "0xaa36a7",
                "wallet_address": wallet_network_address(user, "sepolia") if SEPOLIA_RPC_URL else None,
                "balmz_contract": BALMZ_SEPOLIA_CONTRACT or None,
                "balmz_decimals": 18 if BALMZ_SEPOLIA_CONTRACT else None,
                "network_type": "testnet",
            },
        },
        "broadcast_policy": "user_signed_only",
        "bitcoin": {
            "wallet_address": bitcoin_address,
            "signer": "unisat" if bitcoin_address else None,
        },
    }


@app.get("/api/v1/tokens")
def list_token_registry(user: dict = Depends(current_user)):
    # Registry rows historically use both hyphenated and underscored network IDs.
    networks = {str(a["network"]).strip().lower().replace("-", "_") for a in configured_addresses(user)}
    with db() as conn:
        rows=conn.execute("SELECT symbol,name,network,contract_address,decimals,coingecko_id,status,metadata_url,logo_url FROM token_registry ORDER BY symbol,network").fetchall()
    tokens=[]
    for r in rows:
        registry_network = str(r[2]).strip().lower().replace("-", "_")
        supported = registry_network in networks
        tokens.append({"symbol":r[0],"name":r[1],"network":r[2],"contract_address":r[3],"decimals":r[4],"coingecko_id":r[5],"status":r[6],"metadata_url":r[7],"logo_url":r[8],"wallet_network_connected":supported})
    return {"tokens":tokens,"connected_networks":sorted(networks)}

@app.get("/api/v1/wallets")
def list_wallets(user: dict = Depends(current_user)):
    with db() as conn:
        rows=conn.execute("SELECT id,name,created_at FROM wallets WHERE owner_id=%s ORDER BY created_at ASC",(user["id"],)).fetchall()
    return {"wallets":[{"id":r[0],"name":r[1],"created_at":r[2].isoformat() if r[2] else None,"active":r[0]==user.get("wallet_id")} for r in rows],"active_wallet_id":user.get("wallet_id")}


@app.post("/api/v1/wallets")
def create_wallet(request: WalletCreateRequest,user: dict = Depends(current_user)):
    wallet_id="wallet_"+sha(user["id"]+request.name.strip()+str(datetime.now(timezone.utc).timestamp()))[:24]
    with db() as conn:
        conn.execute("INSERT INTO wallets(id,owner_id,name) VALUES(%s,%s,%s)",(wallet_id,user["id"],request.name.strip()))
        for symbol,asset_name in [("BALMZ","BALMZ Token"),("BALMZ-SEP","BALMZ Token (Sepolia)"),("BTC","Bitcoin"),("ETH","Ethereum"),("USDT","Tether USD"),("BNB","BNB"),("USDC","USD Coin"),("SOL","Solana"),("XRP","XRP"),("ADA","Cardano"),("LTC","Litecoin"),("DOGE","Dogecoin")]:
            conn.execute("INSERT INTO assets(wallet_id,symbol,name,balance,price_usd) VALUES(%s,%s,%s,0,0)",(wallet_id,symbol,asset_name))
        conn.execute("UPDATE users SET active_wallet_id=%s WHERE id=%s",(wallet_id,user["id"]))
        conn.commit()
    user["wallet_id"]=wallet_id
    return {"wallet":{"id":wallet_id,"name":request.name.strip(),"active":True},"message":"Wallet created. Add public network addresses to connect it to live blockchain data."}


@app.post("/api/v1/wallets/active")
def activate_wallet(request: WalletActivateRequest,user: dict = Depends(current_user)):
    with db() as conn:
        row=conn.execute("SELECT id,name FROM wallets WHERE id=%s AND owner_id=%s",(request.wallet_id,user["id"])).fetchone()
        if not row: raise HTTPException(status_code=404, detail="Wallet not found")
        conn.execute("UPDATE users SET active_wallet_id=%s WHERE id=%s",(row[0],user["id"]))
        conn.commit()
    user["wallet_id"]=row[0]
    return {"wallet":{"id":row[0],"name":row[1],"active":True}}


@app.get("/api/v1/wallets/{wallet_id}/addresses")
def list_wallet_addresses(wallet_id: str,user: dict = Depends(current_user)):
    with db() as conn:
        owner=conn.execute("SELECT id,name FROM wallets WHERE id=%s AND owner_id=%s",(wallet_id,user["id"])).fetchone()
        if not owner: raise HTTPException(status_code=404,detail="Wallet not found")
        rows=conn.execute("SELECT network,address,label,created_at FROM wallet_addresses WHERE wallet_id=%s ORDER BY network, CASE WHEN lower(label)='primary' THEN 0 ELSE 1 END, created_at, address",(wallet_id,)).fetchall()
    return {"wallet_id":wallet_id,"addresses":[{"network":r[0],"address":r[1],"label":r[2],"created_at":r[3].isoformat() if r[3] else None} for r in rows]}


@app.post("/api/v1/wallets/{wallet_id}/addresses")
def add_wallet_address(wallet_id: str,request: WalletAddressRequest,user: dict = Depends(current_user)):
    network=request.network.strip().lower().replace("-", "_")
    network = {"solana":"solana_devnet","devnet":"solana_devnet","solana_devnet":"solana_devnet","mainnet":"ethereum","eth":"ethereum","ethereum_mainnet":"ethereum","bsc":"bnb","binance_smart_chain":"bnb"}.get(network, network)
    address=request.address.strip()
    if network in {"ethereum","bnb","sepolia"} and not valid_evm_address(address): raise HTTPException(status_code=400,detail="Invalid EVM address")
    if network=="bitcoin" and not valid_bitcoin_address(address): raise HTTPException(status_code=400,detail="Invalid Bitcoin address")
    if network=="solana_devnet" and not valid_solana_address(address): raise HTTPException(status_code=400,detail="Invalid Solana public address")
    if network not in {"ethereum","bnb","sepolia","bitcoin","solana_devnet"}: raise HTTPException(status_code=400,detail="Unsupported wallet network")
    with db() as conn:
        owner=conn.execute("SELECT id FROM wallets WHERE id=%s AND owner_id=%s",(wallet_id,user["id"])).fetchone()
        if not owner: raise HTTPException(status_code=404,detail="Wallet not found")
        # EVM addresses are case-insensitive; Base58 Solana addresses are case-sensitive.
        comparison = "lower(address)=lower(%s)" if network in {"ethereum","bnb","sepolia"} else "address=%s"
        existing=conn.execute(f"SELECT 1 FROM wallet_addresses WHERE wallet_id=%s AND network=%s AND {comparison}",(wallet_id,network,address)).fetchone()
        if existing:
            conn.execute(f"UPDATE wallet_addresses SET label=%s WHERE wallet_id=%s AND network=%s AND {comparison}",(request.label.strip(),wallet_id,network,address))
        else:
            conn.execute("INSERT INTO wallet_addresses(wallet_id,network,address,label) VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING",(wallet_id,network,address,request.label.strip()))
        conn.commit()
    return {"status":"connected","wallet_id":wallet_id,"address":{"network":network,"address":address,"label":request.label.strip()}}


@app.get("/api/v1/wallets/{wallet_id}/addresses/balance")
def read_wallet_address_balance(wallet_id: str, network: str, address: str, user: dict = Depends(current_user)):
    """Read the balance for one attached public address without mutating portfolio assets."""
    network = network.strip().lower().replace("-", "_")
    network = {"solana":"solana_devnet","devnet":"solana_devnet","mainnet":"ethereum","eth":"ethereum","ethereum_mainnet":"ethereum","bsc":"bnb","binance_smart_chain":"bnb"}.get(network, network)
    address = address.strip()
    if network not in {"ethereum", "sepolia", "bnb", "bitcoin", "solana_devnet"}:
        raise HTTPException(status_code=400, detail="Unsupported wallet network")
    if network in {"ethereum", "sepolia", "bnb"} and not valid_evm_address(address):
        raise HTTPException(status_code=400, detail="Invalid EVM address")
    if network == "bitcoin" and not valid_bitcoin_address(address):
        raise HTTPException(status_code=400, detail="Invalid Bitcoin address")
    if network == "solana_devnet" and not valid_solana_address(address):
        raise HTTPException(status_code=400, detail="Invalid Solana public address")
    with db() as conn:
        owner = conn.execute("SELECT id FROM wallets WHERE id=%s AND owner_id=%s", (wallet_id, user["id"])).fetchone()
        if not owner:
            raise HTTPException(status_code=404, detail="Wallet not found")
        comparison = "lower(address)=lower(%s)" if network in {"ethereum", "sepolia", "bnb"} else "address=%s"
        attached = conn.execute(
            f"SELECT 1 FROM wallet_addresses WHERE wallet_id=%s AND network=%s AND {comparison}",
            (wallet_id, network, address),
        ).fetchone()
        if not attached:
            raise HTTPException(status_code=404, detail="Attach this public address to the selected wallet before checking its balance")
    try:
        if network == "ethereum":
            rpc_url, asset = ETH_RPC_URL, "ETH"
            if not rpc_url: raise HTTPException(status_code=503, detail="Ethereum Mainnet RPC is not configured")
            require_ethereum_mainnet_rpc(rpc_url)
            balance = evm_balance(rpc_url, address)
        elif network == "sepolia":
            rpc_url, asset = SEPOLIA_RPC_URL, "ETH (Sepolia)"
            if not rpc_url: raise HTTPException(status_code=503, detail="Ethereum Sepolia RPC is not configured")
            require_sepolia_rpc(rpc_url)
            balance = evm_balance(rpc_url, address)
        elif network == "bnb":
            rpc_url, asset = BSC_RPC_URL, "BNB"
            if not rpc_url: raise HTTPException(status_code=503, detail="BNB Chain RPC is not configured")
            balance = evm_balance(rpc_url, address)
        elif network == "solana_devnet":
            if not SOLANA_DEVNET_RPC_URL: raise HTTPException(status_code=503, detail="Solana Devnet RPC is not configured. Set WORLD_WALLET_SOLANA_DEVNET_RPC_URL on the backend.")
            raw = rpc_call(SOLANA_DEVNET_RPC_URL, "getBalance", [address, {"commitment": "confirmed"}])
            balance = int((raw or {}).get("value", 0)) / 1_000_000_000
            asset = "SOL (Devnet)"
        else:
            balance = btc_balance(address)
            asset = "BTC"
            if balance is None: raise HTTPException(status_code=503, detail="Bitcoin balance service is unavailable")
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Wallet balance lookup failed for network=%s error_type=%s", network, type(exc).__name__)
        raise HTTPException(status_code=503, detail=f"{network.replace('_', ' ').title()} balance service unavailable") from exc
    return {"wallet_id": wallet_id, "network": network, "address": address, "asset": asset,
            "balance": balance, "unit": asset, "read_only": True,
            "synced_at": datetime.now(timezone.utc).isoformat()}


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
    rpc_by_network = {
        "ethereum": ETH_RPC_URL,
        "bnb": BSC_RPC_URL,
        "sepolia": SEPOLIA_RPC_URL,
    }
    if network not in rpc_by_network:
        raise HTTPException(status_code=400, detail="Unsupported network. Choose ethereum, bnb, or sepolia.")
    rpc = rpc_by_network[network]
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

def _abi_text_value(raw):
    if not isinstance(raw, str) or not raw.startswith("0x"):
        return None
    try:
        data = bytes.fromhex(raw[2:])
        if len(data) == 32:
            return data.rstrip(b"\x00").decode("utf-8", errors="replace") or None
        if len(data) >= 64:
            offset = int.from_bytes(data[:32], "big")
            if offset + 32 <= len(data):
                length = int.from_bytes(data[offset:offset + 32], "big")
                start = offset + 32
                if length <= len(data) - start:
                    return data[start:start + length].decode("utf-8", errors="replace") or None
    except (ValueError, UnicodeDecodeError):
        return None
    return None


def _inspect_evm_address(address, network, rpc):
    if not valid_evm_address(address):
        raise HTTPException(status_code=400, detail="Invalid EVM address")
    try:
        if network == "sepolia":
            require_sepolia_rpc(rpc)
        elif network == "ethereum":
            require_ethereum_mainnet_rpc(rpc)
        raw_balance = rpc_call(rpc, "eth_getBalance", [address, "latest"])
        block_number = _hex_int(rpc_call(rpc, "eth_blockNumber", []))
        balance = int(raw_balance or "0x0", 16) / 10**18
        native_symbol = "BNB" if network == "bnb" else "ETH-SEP" if network == "sepolia" else "ETH"
        balance_basis = (
            "Latest Sepolia testnet balance; test ETH has no mainnet value."
            if network == "sepolia"
            else "Latest on-chain native balance; fees and protocol locks may apply."
        )
        result = {
            "network": network, "address": address, "native_symbol": native_symbol,
            "on_chain_balance": balance, "available_balance": balance,
            "balance_basis": balance_basis,
            "block_number": block_number, "tokens": [],
        }
        if network in {"ethereum", "bnb"}:
            with db() as conn:
                tokens = conn.execute(
                    "SELECT symbol,name,contract_address,decimals FROM token_registry "
                    "WHERE network=%s AND status='active' AND contract_address IS NOT NULL AND decimals IS NOT NULL ORDER BY symbol",
                    (network,),
                ).fetchall()
            for symbol, name, contract, decimals in tokens:
                try:
                    value = erc20_balance(rpc, contract, address, int(decimals))
                    result["tokens"].append({
                        "symbol": symbol, "name": name, "contract_address": contract,
                        "decimals": int(decimals), "on_chain_balance": value, "available_balance": value,
                    })
                except Exception:
                    result["tokens"].append({
                        "symbol": symbol, "name": name, "contract_address": contract,
                        "decimals": int(decimals), "on_chain_balance": None, "available_balance": None,
                        "status": "unavailable",
                    })
        return result
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"{network.title()} balance lookup failed") from exc


@app.get("/api/v1/api-request/key-balance")
def api_request_key_balance(user: dict = Depends(current_user)):
    """Return CoinGecko API-key usage without ever exposing the configured secret."""
    if not _active_coingecko_config()[0]:
        raise HTTPException(status_code=503, detail="CoinGecko API key is not configured on the server")
    try:
        response = httpx.get(
            _active_coingecko_config()[1] + "/key",
            headers=coingecko_headers(),
            timeout=8,
        )
        if response.status_code in {401, 403}:
            raise HTTPException(status_code=502, detail="The configured CoinGecko API key was rejected or cannot access key usage")
        response.raise_for_status()
        payload = response.json()
        return {
            "provider": "CoinGecko",
            "plan": payload.get("plan"),
            "rate_limit_request_per_minute": payload.get("rate_limit_request_per_minute"),
            "monthly_call_credit": payload.get("api_key_monthly_call_credit", payload.get("monthly_call_credit")),
            "current_total_monthly_calls": payload.get("current_total_monthly_calls"),
            "current_remaining_monthly_calls": payload.get("current_remaining_monthly_calls"),
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="CoinGecko API-key usage is temporarily unavailable") from exc


@app.get("/api/v1/api-keys")
def list_api_keys(user: dict = Depends(current_user)):
    """List key metadata only; full key values are never retrievable after creation."""
    with db() as conn:
        rows = conn.execute("""
            SELECT id,name,key_prefix,created_at,last_used_at,revoked_at
            FROM api_keys WHERE owner_id=%s ORDER BY created_at DESC LIMIT 100
        """, (user["id"],)).fetchall()
    return {"keys": [{"id": r[0], "name": r[1], "prefix": r[2], "created_at": r[3].isoformat() if r[3] else None,
                       "last_used_at": r[4].isoformat() if r[4] else None, "revoked": bool(r[5])} for r in rows]}


@app.post("/api/v1/api-keys")
def create_api_key(request: ApiKeyCreateRequest, user: dict = Depends(current_user)):
    """Create an app API key. The raw value is returned once and is never stored."""
    if not DATABASE_URL:
        raise HTTPException(status_code=503, detail="API key storage requires the configured PostgreSQL database")
    raw_key = "wwai_" + secrets.token_urlsafe(32)
    key_id = "key_" + secrets.token_hex(12)
    with db() as conn:
        conn.execute("INSERT INTO api_keys(id,owner_id,name,key_hash,key_prefix) VALUES(%s,%s,%s,%s,%s)",
                     (key_id, user["id"], request.name.strip(), sha(raw_key), raw_key[:13]))
        conn.commit()
    return {"id": key_id, "name": request.name.strip(), "api_key": raw_key,
            "prefix": raw_key[:13], "created_at": datetime.now(timezone.utc).isoformat(),
            "warning": "Copy this key now. It cannot be displayed again."}


@app.post("/api/v1/api-keys/import")
def import_api_key(request: ApiKeyImportRequest, user: dict = Depends(current_user)):
    """Import an existing World Wallet AI API key by storing only its hash."""
    raw_key = request.api_key.strip()
    if not raw_key.startswith("wwai_") or len(raw_key) < 40:
        raise HTTPException(status_code=400, detail="Only an existing World Wallet AI key beginning with wwai_ can be imported.")
    if not DATABASE_URL:
        raise HTTPException(status_code=503, detail="API key storage requires the configured PostgreSQL database")
    with db() as conn:
        existing = conn.execute("SELECT id,owner_id,revoked_at FROM api_keys WHERE key_hash=%s", (sha(raw_key),)).fetchone()
        if existing:
            if existing[1] != user["id"]:
                raise HTTPException(status_code=409, detail="This API key is already registered to another account.")
            if existing[2]:
                raise HTTPException(status_code=409, detail="This API key was revoked and cannot be re-imported.")
            return {"id": existing[0], "imported": False, "message": "This API key is already in your account."}
        key_id = "key_" + secrets.token_hex(12)
        conn.execute("INSERT INTO api_keys(id,owner_id,name,key_hash,key_prefix) VALUES(%s,%s,%s,%s,%s)",
                     (key_id, user["id"], request.name.strip(), sha(raw_key), raw_key[:13]))
        conn.commit()
    return {"id": key_id, "imported": True, "message": "Existing API key imported. Its value is not stored in readable form."}


@app.post("/api/v1/api-keys/revoke")
def revoke_api_key(request: ApiKeyRevokeRequest, user: dict = Depends(current_user)):
    with db() as conn:
        result = conn.execute("UPDATE api_keys SET revoked_at=NOW() WHERE id=%s AND owner_id=%s AND revoked_at IS NULL", (request.key_id, user["id"]))
        conn.commit()
        if result.rowcount < 1:
            raise HTTPException(status_code=404, detail="API key not found or already revoked")
    return {"revoked": True, "id": request.key_id}

@app.post("/api/v1/api-keys/activate")
def activate_api_key(request: ApiKeyRevokeRequest, user: dict = Depends(current_user)):
    """Reactivate a revoked key only for its owner."""
    with db() as conn:
        result = conn.execute("UPDATE api_keys SET revoked_at=NULL WHERE id=%s AND owner_id=%s AND revoked_at IS NOT NULL", (request.key_id, user["id"]))
        conn.commit()
        if result.rowcount < 1:
            raise HTTPException(status_code=404, detail="Revoked API key not found")
    return {"activated": True, "id": request.key_id}


@app.get("/api/v1/coingecko-keys")
def list_coingecko_keys(user: dict = Depends(current_user)):
    require_coingecko_admin(user)
    with db() as conn:
        rows = conn.execute("""SELECT id,name,key_prefix,base_url,active,created_at,revoked_at
            FROM coingecko_api_keys ORDER BY created_at DESC LIMIT 100""").fetchall()
    return {"keys": [{"id":r[0],"name":r[1],"prefix":r[2],"base_url":r[3],"active":bool(r[4]),
        "created_at":r[5].isoformat() if r[5] else None,"revoked":bool(r[6])} for r in rows]}


@app.post("/api/v1/coingecko-keys")
def create_coingecko_key(request: CoinGeckoKeyCreateRequest, user: dict = Depends(current_user)):
    require_coingecko_admin(user)
    base_url = request.base_url.strip().rstrip("/")
    if base_url not in {"https://api.coingecko.com/api/v3","https://pro-api.coingecko.com/api/v3"}:
        raise HTTPException(status_code=400, detail="Choose the official CoinGecko Demo or Pro API URL")
    api_key = request.api_key.strip()
    nonce, tag, ciphertext = _encrypt_coingecko_key(api_key)
    key_id = "cgkey_" + secrets.token_hex(12)
    with db() as conn:
        conn.execute("UPDATE coingecko_api_keys SET active=FALSE WHERE active=TRUE AND revoked_at IS NULL")
        conn.execute("""INSERT INTO coingecko_api_keys(id,owner_id,name,key_prefix,key_nonce,key_tag,key_ciphertext,base_url,active)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,TRUE)""",
            (key_id,user["id"],request.name.strip(),api_key[:8],nonce,tag,ciphertext,base_url))
        conn.commit()
    return {"id":key_id,"created":True,"active":True,"message":"CoinGecko key saved encrypted on the server and activated."}


@app.post("/api/v1/coingecko-keys/activate")
def activate_coingecko_key(request: ApiKeyRevokeRequest, user: dict = Depends(current_user)):
    require_coingecko_admin(user)
    with db() as conn:
        row = conn.execute("SELECT id FROM coingecko_api_keys WHERE id=%s", (request.key_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="CoinGecko key not found")
        conn.execute("UPDATE coingecko_api_keys SET active=FALSE WHERE active=TRUE")
        conn.execute("UPDATE coingecko_api_keys SET active=TRUE,revoked_at=NULL WHERE id=%s", (request.key_id,))
        conn.commit()
    return {"activated":True,"id":request.key_id}


@app.post("/api/v1/coingecko-keys/revoke")
def revoke_coingecko_key(request: ApiKeyRevokeRequest, user: dict = Depends(current_user)):
    require_coingecko_admin(user)
    with db() as conn:
        result = conn.execute("UPDATE coingecko_api_keys SET revoked_at=NOW(),active=FALSE WHERE id=%s AND revoked_at IS NULL", (request.key_id,))
        conn.commit()
        if result.rowcount < 1:
            raise HTTPException(status_code=404, detail="CoinGecko key not found or already revoked")
    return {"revoked":True,"id":request.key_id}


@app.post("/api/v1/tools/address-balance")
def inspect_wallet_address(request: AddressInspectRequest, user: dict = Depends(current_user)):
    network = request.network.strip().lower()
    address = request.address.strip()
    compare_address = request.compare_address.strip() if request.compare_address else None
    if network == "bitcoin":
        if not valid_bitcoin_address(address):
            raise HTTPException(status_code=400, detail="Invalid Bitcoin address")
        try:
            balance = btc_balance(address)
            result = {
                "network": network, "address": address, "native_symbol": "BTC",
                "on_chain_balance": balance, "available_balance": balance,
                "balance_basis": "Confirmed UTXO balance; spending fees and wallet locks may apply.",
                "block_number": None, "tokens": [],
            }
            if compare_address:
                if not valid_bitcoin_address(compare_address):
                    raise HTTPException(status_code=400, detail="Invalid comparison Bitcoin address")
                other_balance = btc_balance(compare_address)
                result["comparison"] = {
                    "network": network, "address": compare_address, "native_symbol": "BTC",
                    "on_chain_balance": other_balance, "available_balance": other_balance,
                    "balance_basis": "Confirmed UTXO balance; spending fees and wallet locks may apply.",
                    "block_number": None, "tokens": [],
                }
            return result
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Bitcoin balance lookup failed") from exc
    rpc = {"ethereum": ETH_RPC_URL, "bnb": BSC_RPC_URL, "sepolia": SEPOLIA_RPC_URL}.get(network)
    if network not in {"ethereum", "bnb", "sepolia"}:
        raise HTTPException(status_code=400, detail="Unsupported network")
    if not rpc:
        raise HTTPException(status_code=503, detail=f"{network.title()} RPC is not configured")
    result = _inspect_evm_address(address, network, rpc)
    if compare_address:
        result["comparison"] = _inspect_evm_address(compare_address, network, rpc)
    if network == "sepolia":
        result["testnet"] = True
        try:
            price_response = httpx.get(
                _active_coingecko_config()[1] + "/simple/price",
                params={"ids": "ethereum", "vs_currencies": "usd"},
                headers=coingecko_headers(), timeout=6,
            )
            price_response.raise_for_status()
            price = float(price_response.json()["ethereum"]["usd"])
            result["mainnet_eth_usd_price"] = price
            result["usd_reference"] = round(result["on_chain_balance"] * price, 2)
        except Exception:
            result["mainnet_eth_usd_price"] = None
            result["usd_reference"] = None
        result["valuation_note"] = "Sepolia ETH is testnet-only and has no redeemable real-world value. The USD figure is only an ETH mainnet price reference, not the value of test funds."
        if result.get("comparison"):
            result["comparison"]["testnet"] = True
    return result


@app.get("/api/v1/wallet/proof-of-reserves")
def wallet_proof_of_reserves(user: dict = Depends(current_user)):
    addresses = configured_addresses(user)
    if not addresses:
        raise HTTPException(status_code=503, detail="Connect at least one public wallet address to inspect on-chain reserves")
    reserves = []
    testnet_assets = []
    token_supplies = []
    warnings = []
    excluded_networks = []
    for item in addresses:
        network = str(item["network"]).strip().lower().replace("-", "_")
        address = item["address"]
        if network == "solana_devnet":
            # Keep testnet holdings separate from production reserve figures.
            solana_rpc = SOLANA_DEVNET_RPC_URL or "https://api.devnet.solana.com"
            try:
                native_result = rpc_call(solana_rpc, "getBalance", [address, {"commitment": "confirmed"}])
                testnet_assets.append({
                    "network": "solana-devnet", "address": address, "asset": "SOL-DEVNET",
                    "balance": int((native_result or {}).get("value", 0)) / 1_000_000_000,
                    "block_number": None, "source": "Solana Devnet getBalance (confirmed)",
                })
            except Exception:
                warnings.append("solana-devnet: native SOL balance unavailable")
            try:
                token_balance = solana_spl_token_balance(address)
                testnet_assets.append({
                    "network": "solana-devnet", "address": address, "asset": "BALMZ-SOL-DEVNET",
                    "balance": token_balance, "contract_address": BALMZ_SOLANA_DEVNET_MINT,
                    "block_number": None, "source": "Solana Devnet SPL token account balance (confirmed)",
                })
            except Exception:
                warnings.append("solana-devnet BALMZ: wallet token balance unavailable")
            try:
                supply_response = rpc_call(solana_rpc, "getTokenSupply", [BALMZ_SOLANA_DEVNET_MINT, {"commitment": "confirmed"}])
                supply = (supply_response or {}).get("value") or {}
                supply_decimals = int(supply.get("decimals", -1))
                raw_supply = str(supply.get("amount", ""))
                if supply_decimals != BALMZ_SOLANA_DEVNET_DECIMALS or not raw_supply.isdigit():
                    raise ValueError("Unexpected BALMZ mint supply response")
                total_supply = float(supply.get("uiAmountString") or (int(raw_supply) / (10 ** supply_decimals)))
                token_supplies.append({
                    "symbol": "BALMZ-SOL-DEVNET", "network": "solana-devnet",
                    "mint_address": BALMZ_SOLANA_DEVNET_MINT, "decimals": supply_decimals,
                    "total_supply": total_supply, "raw_amount": raw_supply,
                    "source": "Solana Devnet getTokenSupply (confirmed)", "commitment": "confirmed",
                })
            except Exception:
                warnings.append("solana-devnet BALMZ: on-chain total supply unavailable")
            continue
        if network == "sepolia":
            excluded_networks.append("sepolia")
            continue
        try:
            if network == "bitcoin":
                reserves.append({
                    "network": network, "address": address, "asset": "BTC",
                    "balance": btc_balance(address), "block_number": None,
                    "source": "Blockstream confirmed UTXO data",
                })
                continue
            rpc = {"ethereum": ETH_RPC_URL, "bnb": BSC_RPC_URL}.get(network)
            if not rpc:
                warnings.append(f"{network}: RPC is not configured")
                continue
            raw = rpc_call(rpc, "eth_getBalance", [address, "latest"])
            height = _hex_int(rpc_call(rpc, "eth_blockNumber", []))
            reserves.append({
                "network": network, "address": address, "asset": "BNB" if network == "bnb" else "ETH",
                "balance": int(raw or "0x0", 16) / 10**18, "block_number": height,
                "source": "configured JSON-RPC latest state",
            })
            with db() as conn:
                tokens = conn.execute(
                    "SELECT symbol,contract_address,decimals FROM token_registry "
                    "WHERE network=%s AND status='active' AND contract_address IS NOT NULL AND decimals IS NOT NULL",
                    (network,),
                ).fetchall()
            for symbol, contract, decimals in tokens:
                try:
                    reserves.append({
                        "network": network, "address": address, "asset": symbol,
                        "balance": erc20_balance(rpc, contract, address, int(decimals)),
                        "contract_address": contract, "block_number": height,
                        "source": "configured ERC-20 contract balanceOf",
                    })
                except Exception:
                    warnings.append(f"{network} {symbol}: token balance unavailable")
        except Exception:
            warnings.append(f"{network}: on-chain lookup failed")
    return {
        "status": "partial" if warnings else "snapshot",
        "scope": "Connected public addresses for this authenticated wallet only",
        "as_of": datetime.now(timezone.utc).isoformat(),
        "reserves": reserves, "testnet_assets": testnet_assets, "token_supplies": token_supplies,
        "warnings": warnings, "excluded_networks": sorted(set(excluded_networks)),
        "audited": False, "liabilities_included": False,
        "note": "This is an on-chain asset snapshot, not an audited proof of reserves or solvency attestation. It excludes platform-wide customer liabilities, off-chain assets, and ownership proof.",
    }


@app.post("/api/v1/contracts/inspect")
def inspect_contract(request: ContractInspectRequest, user: dict = Depends(current_user)):
    address = request.address.strip()
    network = request.network.strip().lower()
    if not valid_evm_address(address):
        raise HTTPException(status_code=400, detail="Invalid EVM address")
    rpc = {"ethereum": ETH_RPC_URL, "bnb": BSC_RPC_URL, "sepolia": SEPOLIA_RPC_URL}.get(network)
    if not rpc:
        raise HTTPException(status_code=503, detail=f"{network.title()} RPC is not configured")
    try:
        code = rpc_call(rpc, "eth_getCode", [address, "latest"])
        has_code = bool(code and code not in {"0x", "0x0"})
        if not has_code:
            return {"network": network, "address": address, "is_contract": False,
                    "name": None, "symbol": None, "decimals": None, "source_verified": False,
                    "note": "No deployed contract bytecode was found at this address."}
        metadata = {}
        for key, selector in (("name", "0x06fdde03"), ("symbol", "0x95d89b41"), ("decimals", "0x313ce567")):
            try:
                raw = rpc_call(rpc, "eth_call", [{"to": address, "data": selector}, "latest"])
                metadata[key] = (_hex_int(raw) if key == "decimals" else _abi_text_value(raw)) if raw is not None else None
            except Exception:
                metadata[key] = None
        return {
            "network": network, "address": address, "is_contract": True,
            "name": metadata.get("name"), "symbol": metadata.get("symbol"), "decimals": metadata.get("decimals"),
            "source_verified": False,
            "note": "Contract address inspected. This does not convert it into a wallet address, prove ownership, verify source code, or certify safety.",
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Contract inspection unavailable from blockchain RPC") from exc


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
    if not valid_destination_for_network(request.recipient,network):
        raise HTTPException(status_code=400,detail="Invalid recipient address for selected network")
    fingerprint=sha(f"transfer|{symbol}|{network}|{request.amount}|{request.recipient.strip()}|{request.note or ''}")
    with db() as conn:
        asset_row=conn.execute(
            "SELECT balance,reserved_balance FROM assets WHERE wallet_id=%s AND symbol=%s FOR UPDATE",
            (user["wallet_id"],symbol),
        ).fetchone()
        if not asset_row:
            raise HTTPException(status_code=400,detail="Unsupported asset")
        existing=conn.execute(
            "SELECT i.request_hash,t.id,t.asset,t.amount,t.destination,t.network,t.status "
            "FROM transaction_idempotency i JOIN transactions t ON t.id=i.transaction_id "
            "WHERE i.wallet_id=%s AND i.idempotency_key=%s",
            (user["wallet_id"],request.idempotency_key.strip()),
        ).fetchone()
        if existing:
            if existing[0] != fingerprint:
                raise HTTPException(status_code=409,detail="Idempotency key was already used for a different transfer")
            return {"status":existing[6],"mode":"database","accounting":"reserved","broadcast":False,
                    "replayed":True,"transfer":{"id":existing[1],"asset":existing[2],"amount":float(abs(existing[3])),
                    "recipient":existing[4],"network":existing[5]}}
        ok,rejection=reserve_asset(conn,user,symbol,request.amount)
        if not ok:
            conn.rollback()
            return rejection
        txid="tx_"+sha(user["wallet_id"]+request.idempotency_key.strip())[:24]
        conn.execute("INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network) VALUES(%s,%s,'sent',%s,%s,%s,'pending',%s,%s)",
                     (txid,user["wallet_id"],symbol,"Transfer request",-request.amount,request.recipient,network))
        conn.execute("INSERT INTO transaction_idempotency(wallet_id,idempotency_key,request_hash,transaction_id) VALUES(%s,%s,%s,%s)",
                     (user["wallet_id"],request.idempotency_key.strip(),fingerprint,txid))
        conn.commit()
    return {"status":"pending","mode":"database","accounting":"reserved","broadcast":False,
            "transfer":{"id":txid,"asset":symbol,"amount":float(request.amount),"recipient":request.recipient,"network":network}}

@app.post("/api/v1/withdrawals")
def withdrawal(request: WithdrawalRequest,user: dict = Depends(current_user)):
    symbol,network=validate_asset_network(request.asset,request.network)
    if not valid_destination_for_network(request.destination,network):
        raise HTTPException(status_code=400,detail="Invalid destination address for selected network")
    fingerprint=sha(f"withdrawal|{symbol}|{network}|{request.amount}|{request.destination.strip()}|{request.note or ''}")
    with db() as conn:
        asset_row=conn.execute(
            "SELECT balance,reserved_balance FROM assets WHERE wallet_id=%s AND symbol=%s FOR UPDATE",
            (user["wallet_id"],symbol),
        ).fetchone()
        if not asset_row:
            raise HTTPException(status_code=400,detail="Unsupported asset")
        existing=conn.execute(
            "SELECT i.request_hash,t.id,t.asset,t.amount,t.destination,t.network,t.status "
            "FROM transaction_idempotency i JOIN transactions t ON t.id=i.transaction_id "
            "WHERE i.wallet_id=%s AND i.idempotency_key=%s",
            (user["wallet_id"],request.idempotency_key.strip()),
        ).fetchone()
        if existing:
            if existing[0] != fingerprint:
                raise HTTPException(status_code=409,detail="Idempotency key was already used for a different withdrawal")
            return {"status":existing[6],"mode":"database","accounting":"reserved","broadcast":False,
                    "replayed":True,"withdrawal":{"id":existing[1],"asset":existing[2],"amount":float(abs(existing[3])),
                    "destination":existing[4],"network":existing[5]}}
        ok,rejection=reserve_asset(conn,user,symbol,request.amount)
        if not ok:
            conn.rollback()
            return rejection
        txid="tx_"+sha(user["wallet_id"]+request.idempotency_key.strip())[:24]
        conn.execute("INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network) VALUES(%s,%s,'withdrawal',%s,%s,%s,'pending_review',%s,%s)",
                     (txid,user["wallet_id"],symbol,"Withdrawal request",-request.amount,request.destination,network))
        conn.execute("INSERT INTO transaction_idempotency(wallet_id,idempotency_key,request_hash,transaction_id) VALUES(%s,%s,%s,%s)",
                     (user["wallet_id"],request.idempotency_key.strip(),fingerprint,txid))
        conn.commit()
    return {"status":"pending_review","mode":"database","accounting":"reserved","broadcast":False,
            "withdrawal":{"id":txid,"asset":symbol,"amount":float(request.amount),"destination":request.destination,"network":network}}

class TransactionCancelRequest(BaseModel):
    transaction_id: str = Field(min_length=4,max_length=80)


class TransactionSettleRequest(BaseModel):
    transaction_id: str = Field(min_length=4,max_length=80)
    tx_hash: str = Field(min_length=8,max_length=128)

class SolanaDevnetDepositRequest(BaseModel):
    tx_signature: str = Field(min_length=64, max_length=100)

EVM_TX_HASH_RE = __import__("re").compile(r"^0x[0-9a-fA-F]{64}$")
BTC_TX_HASH_RE = __import__("re").compile(r"^[0-9a-fA-F]{64}$")
ERC20_TRANSFER_TOPIC = "0x" + _keccak_hex("Transfer(address,address,uint256)")


def _hex_int(value):
    if value is None:
        return None
    return int(value, 16) if isinstance(value, str) and value.startswith("0x") else int(value)


def _same_address(left, right):
    return bool(left and right and left.lower() == right.lower())


def exact_base_units(amount: Decimal, decimals: int) -> int:
    """Convert a value to integer chain units without silently rounding."""
    if not amount.is_finite() or amount < 0 or not isinstance(decimals, int) or decimals < 0 or decimals > 36:
        raise HTTPException(status_code=409, detail="Invalid settlement amount or asset precision")
    scaled = amount * (Decimal(10) ** decimals)
    if scaled != scaled.to_integral_value():
        raise HTTPException(status_code=409, detail="Settlement amount exceeds the asset's supported decimal precision")
    return int(scaled)


def required_confirmations(env_name: str) -> int:
    raw = os.getenv(env_name, "3")
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=f"Invalid confirmation configuration: {env_name}") from exc
    if value < 1 or value > 100:
        raise HTTPException(status_code=503, detail=f"Confirmation configuration out of range: {env_name}")
    return value


def erc20_decimals(url: str, contract: str):
    if not url or not valid_evm_address(contract):
        return None
    raw = rpc_call(url, "eth_call", [{"to": contract, "data": "0x313ce567"}, "latest"])
    return _hex_int(raw) if raw is not None else None


def verify_bitcoin_settlement(tx_hash: str, destination: str, amount: Decimal, wallet_address: str):
    response = httpx.get(f"https://blockstream.info/api/tx/{tx_hash}", timeout=15)
    if response.status_code == 404:
        return {"state": "not_found"}
    response.raise_for_status()
    tx = response.json()
    status = tx.get("status") or {}
    vins = tx.get("vin") or []
    if not any(_same_address((v.get("prevout") or {}).get("scriptpubkey_address"), wallet_address) for v in vins):
        raise HTTPException(status_code=409, detail="Bitcoin transaction is not spending the configured wallet address")
    paid = sum(int(v.get("value", 0)) for v in tx.get("vout", []) if _same_address(v.get("scriptpubkey_address"), destination))
    expected = exact_base_units(amount, 8)
    if paid != expected:
        raise HTTPException(status_code=409, detail="Bitcoin transaction amount or destination does not match the wallet request")
    confirmed = bool(status.get("confirmed"))
    block_height = status.get("block_height")
    tip_response = httpx.get("https://blockstream.info/api/blocks/tip/height", timeout=10)
    tip_response.raise_for_status()
    tip = int(tip_response.text.strip())
    confirmations = max(0, tip - int(block_height) + 1) if confirmed and block_height else 0
    threshold = required_confirmations("WORLD_WALLET_BTC_CONFIRMATIONS")
    return {
        "state": "confirmed" if confirmations >= threshold else "pending",
        "tx_hash": tx_hash,
        "confirmations": confirmations,
        "block_height": block_height,
    }


def verify_evm_settlement(tx_hash: str, asset: str, network: str, destination: str, amount: Decimal, wallet_address: str):
    rpc = ETH_RPC_URL if network == "ethereum" else BSC_RPC_URL if network == "bnb" else ""
    if not rpc or not wallet_address:
        raise HTTPException(status_code=503, detail=f"{network.title()} settlement RPC or wallet is not configured")
    try:
        tx = rpc_call(rpc, "eth_getTransactionByHash", [tx_hash])
        if not tx:
            return {"state": "not_found"}
        receipt = rpc_call(rpc, "eth_getTransactionReceipt", [tx_hash])
        if not receipt:
            return {"state": "pending", "tx_hash": tx_hash, "confirmations": 0, "block_height": None}
        receipt_status = str(receipt.get("status") or "").lower()
        if receipt_status == "0x0":
            raise HTTPException(status_code=409, detail="Blockchain transaction failed and cannot settle the wallet request")
        if receipt_status != "0x1":
            return {"state": "pending", "tx_hash": tx_hash, "confirmations": 0, "block_height": None}
        if not _same_address(tx.get("from"), wallet_address):
            raise HTTPException(status_code=409, detail="Blockchain transaction sender does not match the configured wallet")
        block_number = _hex_int(receipt.get("blockNumber"))
        latest = _hex_int(rpc_call(rpc, "eth_blockNumber", []))
        if block_number is None or latest is None:
            return {"state": "pending", "tx_hash": tx_hash, "confirmations": 0, "block_height": block_number}
        canonical_block = rpc_call(rpc, "eth_getBlockByNumber", [hex(block_number), False])
        receipt_block_hash = str(receipt.get("blockHash") or "").lower()
        canonical_block_hash = str((canonical_block or {}).get("hash") or "").lower()
        if not receipt_block_hash or not canonical_block_hash or receipt_block_hash != canonical_block_hash:
            return {"state": "pending", "tx_hash": tx_hash, "confirmations": 0, "block_height": block_number}
        confirmations = max(0, latest - block_number + 1)

        if asset in {"ETH", "BNB"}:
            if not _same_address(tx.get("to"), destination):
                raise HTTPException(status_code=409, detail="Blockchain destination does not match the wallet request")
            expected = exact_base_units(amount, 18)
            if _hex_int(tx.get("value") or "0x0") != expected:
                raise HTTPException(status_code=409, detail="Blockchain amount does not match the wallet request")
        else:
            if asset == "BALMZ":
                contract = BALMZ_ETH_CONTRACT if network == "ethereum" else ""
                label = "BALMZ"
            else:
                contract = USDT_ETH_CONTRACT if network == "ethereum" else USDT_BSC_CONTRACT if network == "bnb" else ""
                label = "USDT"
            if not contract:
                raise HTTPException(status_code=503, detail=label + " contract is not configured for settlement verification")
            if not _same_address(tx.get("to"), contract):
                raise HTTPException(status_code=409, detail="Token contract does not match the configured USDT contract")
            decimals = erc20_decimals(rpc, contract)
            if decimals is None or decimals < 0 or decimals > 36:
                raise HTTPException(status_code=503, detail="Unable to determine token decimals")
            expected = exact_base_units(amount, decimals)
            found = False
            for log in receipt.get("logs") or []:
                topics = log.get("topics") or []
                if len(topics) < 3 or str(topics[0]).lower() != ERC20_TRANSFER_TOPIC.lower():
                    continue
                if not _same_address("0x" + topics[1][-40:], wallet_address):
                    continue
                if not _same_address("0x" + topics[2][-40:], destination):
                    continue
                if _hex_int(log.get("data") or "0x0") != expected:
                    continue
                if not _same_address(log.get("address"), contract):
                    continue
                found = True
                break
            if not found:
                raise HTTPException(status_code=409, detail="No matching ERC-20 transfer event was found in the confirmed transaction")

        threshold = required_confirmations("WORLD_WALLET_EVM_CONFIRMATIONS")
        return {
            "state": "confirmed" if confirmations >= threshold else "pending",
            "tx_hash": tx_hash,
            "confirmations": confirmations,
            "block_height": block_number,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Blockchain settlement verification unavailable") from exc



def verify_solana_devnet_settlement(
    tx_signature: str, destination: str, amount: Decimal, wallet_address: str
):
    """Verify a confirmed BALMZ SPL transfer on Solana Devnet."""
    import re

    if not re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{64,100}", tx_signature):
        raise ValueError("Invalid Solana transaction signature")
    if not valid_solana_address(destination) or not valid_solana_address(wallet_address):
        raise ValueError("Invalid Solana sender or recipient address")

    result = rpc_call(
        SOLANA_DEVNET_RPC_URL, "getTransaction",
        [tx_signature, {
            "encoding": "jsonParsed",
            # Settlement must not release a reservation on a merely confirmed
            # transaction. Require the RPC provider to return finalized data.
            "commitment": "finalized",
            "maxSupportedTransactionVersion": 0,
        }],
    )
    if result is None:
        statuses = rpc_call(
            SOLANA_DEVNET_RPC_URL, "getSignatureStatuses",
            [[tx_signature], {"searchTransactionHistory": True}],
        )
        if not isinstance(statuses, dict) or not isinstance(statuses.get("value"), list):
            raise HTTPException(status_code=503, detail="Malformed Solana signature-status response")
        values = statuses["value"]
        if len(values) != 1:
            raise HTTPException(status_code=503, detail="Unexpected Solana signature-status response length")
        status = values[0]
        if status is None:
            return {"state": "not_found", "confirmations": 0, "block_height": None}
        if not isinstance(status, dict) or "err" not in status:
            raise HTTPException(status_code=503, detail="Malformed Solana signature status")
        if status["err"] is not None:
            raise ValueError("Solana transaction failed on-chain")
        # A status alone does not prove the exact token transfer. Keep it pending
        # until getTransaction returns the finalized transaction details.
        return {"state": "pending", "confirmations": 0, "block_height": None}

    if not isinstance(result, dict):
        raise HTTPException(status_code=503, detail="Malformed Solana transaction response")

    meta = result.get("meta")
    transaction = result.get("transaction")
    if not isinstance(meta, dict) or not isinstance(transaction, dict):
        raise HTTPException(status_code=503, detail="Malformed Solana transaction metadata")

    if meta.get("err") is not None:
        raise ValueError("Solana transaction failed on-chain")

    message = transaction.get("message")
    if not isinstance(message, dict):
        raise HTTPException(status_code=503, detail="Malformed Solana transaction message")

    keys = message.get("accountKeys") or []
    post_balances = meta.get("postTokenBalances") or []
    outer_instructions = message.get("instructions") or []
    inner_groups = meta.get("innerInstructions") or []
    if not all(isinstance(items, list) for items in (keys, post_balances, outer_instructions, inner_groups)):
        raise HTTPException(status_code=503, detail="Malformed Solana transaction instruction or balance lists")
    if not all(isinstance(item, dict) for item in post_balances):
        raise HTTPException(status_code=503, detail="Malformed Solana token balance entry")

    key_names = [
        item.get("pubkey") if isinstance(item, dict) else item
        for item in keys
    ]
    if not all(isinstance(key, str) and key for key in key_names):
        raise HTTPException(status_code=503, detail="Malformed Solana account keys")
    instructions = list(outer_instructions)
    for inner in inner_groups:
        if not isinstance(inner, dict) or not isinstance(inner.get("instructions", []), list):
            raise HTTPException(status_code=503, detail="Malformed Solana inner instruction group")
        instructions.extend(inner.get("instructions") or [])
    if not all(isinstance(item, dict) for item in instructions):
        raise HTTPException(status_code=503, detail="Malformed Solana instruction")

    expected = Decimal(amount) * (Decimal(10) ** BALMZ_SOLANA_DEVNET_DECIMALS)
    if expected != expected.to_integral_value():
        raise ValueError("Token amount has unsupported precision")
    expected_raw = int(expected)

    for instruction in instructions:
        parsed = instruction.get("parsed")
        if parsed is None:
            continue
        if not isinstance(parsed, dict):
            raise HTTPException(status_code=503, detail="Malformed parsed Solana instruction")
        if parsed.get("type") != "transferChecked":
            continue
        if instruction.get("program") not in {"spl-token", "spl-token-2022"}:
            continue
        info = parsed.get("info")
        if not isinstance(info, dict):
            raise HTTPException(status_code=503, detail="Malformed Solana transfer instruction")
        if info.get("mint") != BALMZ_SOLANA_DEVNET_MINT:
            continue
        if info.get("authority") != wallet_address:
            continue
        token_amount = info.get("tokenAmount")
        if not isinstance(token_amount, dict):
            raise HTTPException(status_code=503, detail="Malformed Solana token amount metadata")
        raw_amount = token_amount.get("amount")
        if not isinstance(raw_amount, str) or not raw_amount.isdigit():
            raise HTTPException(status_code=503, detail="Malformed Solana raw token amount")
        if raw_amount != str(expected_raw):
            continue
        try:
            parsed_decimals = token_amount.get("decimals")
            if isinstance(parsed_decimals, bool) or not isinstance(parsed_decimals, int):
                raise TypeError("Invalid token decimals")
        except (TypeError, ValueError):
            raise HTTPException(status_code=503, detail="Malformed Solana token amount metadata")
        if parsed_decimals != BALMZ_SOLANA_DEVNET_DECIMALS:
            continue

        destination_account = info.get("destination")
        account_index = next(
            (i for i, key in enumerate(key_names) if key == destination_account),
            None,
        )
        if account_index is None:
            continue
        recipient_matches = any(
            item.get("accountIndex") == account_index
            and item.get("owner") == destination
            and item.get("mint") == BALMZ_SOLANA_DEVNET_MINT
            for item in post_balances
        )
        if recipient_matches:
            return {
                "state": "confirmed",
                # Compatibility marker for the existing integer DB/API field;
                # finality is explicitly represented separately below.
                "confirmations": 1,
                "finality": "finalized",
                "block_height": None,
            }

    raise ValueError(
        "Confirmed transaction does not contain the exact BALMZ Devnet transfer"
    )


def verify_solana_devnet_deposit(tx_signature: str, destination_wallet: str):
    """Verify a finalized incoming BALMZ Devnet transfer; never treats test tokens as Mainnet value."""
    import re

    if not re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{64,100}", tx_signature):
        raise ValueError("Invalid Solana transaction signature")
    if not valid_solana_address(destination_wallet):
        raise ValueError("Invalid Solana Devnet receiving wallet address")

    result = rpc_call(
        SOLANA_DEVNET_RPC_URL, "getTransaction",
        [tx_signature, {
            "encoding": "jsonParsed",
            "commitment": "finalized",
            "maxSupportedTransactionVersion": 0,
        }],
    )
    if result is None:
        statuses = rpc_call(
            SOLANA_DEVNET_RPC_URL, "getSignatureStatuses",
            [[tx_signature], {"searchTransactionHistory": True}],
        )
        if not isinstance(statuses, dict) or not isinstance(statuses.get("value"), list):
            raise HTTPException(status_code=503, detail="Malformed Solana signature-status response")
        values = statuses["value"]
        if len(values) != 1:
            raise HTTPException(status_code=503, detail="Unexpected Solana signature-status response length")
        status = values[0]
        if status is None:
            return {"state": "not_found", "confirmations": 0, "slot": None}
        if not isinstance(status, dict) or "err" not in status:
            raise HTTPException(status_code=503, detail="Malformed Solana signature status")
        if status["err"] is not None:
            raise ValueError("Solana deposit transaction failed on-chain")
        # A signature status alone cannot establish the mint, recipient owner, or exact amount.
        return {"state": "pending", "confirmations": 0, "slot": None}

    if not isinstance(result, dict):
        raise HTTPException(status_code=503, detail="Malformed Solana transaction response")
    meta = result.get("meta")
    transaction = result.get("transaction")
    if not isinstance(meta, dict) or not isinstance(transaction, dict):
        raise HTTPException(status_code=503, detail="Malformed Solana transaction metadata")
    if meta.get("err") is not None:
        raise ValueError("Solana deposit transaction failed on-chain")

    message = transaction.get("message")
    if not isinstance(message, dict):
        raise HTTPException(status_code=503, detail="Malformed Solana transaction message")
    keys = message.get("accountKeys") or []
    post_balances = meta.get("postTokenBalances") or []
    pre_balances = meta.get("preTokenBalances") or []
    outer_instructions = message.get("instructions") or []
    inner_groups = meta.get("innerInstructions") or []
    if not all(isinstance(items, list) for items in (keys, post_balances, pre_balances, outer_instructions, inner_groups)):
        raise HTTPException(status_code=503, detail="Malformed Solana transaction instruction or balance lists")
    if not all(isinstance(item, dict) for item in (*post_balances, *pre_balances)):
        raise HTTPException(status_code=503, detail="Malformed Solana token balance entry")

    key_names = [
        item.get("pubkey") if isinstance(item, dict) else item
        for item in keys
    ]
    if not all(isinstance(key, str) and key for key in key_names):
        raise HTTPException(status_code=503, detail="Malformed Solana account keys")

    instructions = list(outer_instructions)
    for inner in inner_groups:
        if not isinstance(inner, dict) or not isinstance(inner.get("instructions", []), list):
            raise HTTPException(status_code=503, detail="Malformed Solana inner instruction group")
        instructions.extend(inner.get("instructions") or [])
    if not all(isinstance(item, dict) for item in instructions):
        raise HTTPException(status_code=503, detail="Malformed Solana instruction")

    received_raw = 0
    matching_transfer_count = 0
    for instruction in instructions:
        parsed = instruction.get("parsed")
        if parsed is None:
            continue
        if not isinstance(parsed, dict):
            raise HTTPException(status_code=503, detail="Malformed parsed Solana instruction")
        if parsed.get("type") != "transferChecked" or instruction.get("program") not in {"spl-token", "spl-token-2022"}:
            continue
        info = parsed.get("info")
        if not isinstance(info, dict):
            raise HTTPException(status_code=503, detail="Malformed Solana token transfer instruction")
        if info.get("mint") != BALMZ_SOLANA_DEVNET_MINT:
            continue

        token_amount = info.get("tokenAmount")
        if not isinstance(token_amount, dict):
            raise HTTPException(status_code=503, detail="Malformed Solana transfer amount")
        raw_amount = token_amount.get("amount")
        try:
            decimals = int(token_amount.get("decimals"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=503, detail="Malformed Solana transfer decimals") from exc
        if not isinstance(raw_amount, str) or not raw_amount.isdigit():
            raise HTTPException(status_code=503, detail="Malformed Solana raw transfer amount")
        if decimals != BALMZ_SOLANA_DEVNET_DECIMALS:
            raise ValueError("BALMZ Devnet deposit has unexpected token decimals")
        raw_int = int(raw_amount)
        if raw_int <= 0:
            raise ValueError("BALMZ Devnet deposit amount must be greater than zero")

        destination_token_account = info.get("destination")
        source_token_account = info.get("source")
        if not isinstance(destination_token_account, str):
            continue
        try:
            destination_index = key_names.index(destination_token_account)
        except ValueError:
            continue

        owner_rows = [
            item for item in post_balances
            if item.get("accountIndex") == destination_index
            and item.get("owner") == destination_wallet
            and item.get("mint") == BALMZ_SOLANA_DEVNET_MINT
        ]
        if not owner_rows:
            continue

        # Do not count a wallet sending tokens to itself as an incoming deposit.
        if isinstance(source_token_account, str):
            try:
                source_index = key_names.index(source_token_account)
            except ValueError:
                source_index = None
            if source_index is not None and any(
                item.get("accountIndex") == source_index
                and item.get("owner") == destination_wallet
                and item.get("mint") == BALMZ_SOLANA_DEVNET_MINT
                for item in (*pre_balances, *post_balances)
            ):
                continue

        matching_transfer_count += 1
        received_raw += raw_int

    if matching_transfer_count == 0 or received_raw <= 0:
        raise ValueError("Transaction does not contain an incoming BALMZ Devnet deposit to this wallet")

    return {
        "state": "confirmed",
        "amount": Decimal(received_raw) / (Decimal(10) ** BALMZ_SOLANA_DEVNET_DECIMALS),
        "confirmations": 1,
        "finality": "finalized",
        "slot": result.get("slot") if isinstance(result.get("slot"), int) else None,
    }


@app.post("/api/v1/deposits/solana-devnet/verify")
def verify_solana_devnet_deposit_request(
    request: SolanaDevnetDepositRequest,
    user: dict = Depends(current_user),
):
    """Record a genuine finalized Devnet deposit for testing; it is not Mainnet funding."""
    tx_signature = request.tx_signature.strip()
    destination_wallet = wallet_network_address(user, "solana_devnet")
    if not destination_wallet:
        raise HTTPException(
            status_code=409,
            detail="Connect a Solana Devnet receiving address to this wallet before verifying deposits",
        )

    try:
        verification = verify_solana_devnet_deposit(tx_signature, destination_wallet)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if verification["state"] == "not_found":
        raise HTTPException(status_code=404, detail="Solana Devnet deposit transaction was not found")
    if verification["state"] == "pending":
        return {
            "status": "pending",
            "recorded": False,
            "network": "solana-devnet",
            "asset": "BALMZ-SOL-DEVNET",
            "message": "Waiting for finalized transaction details; no deposit has been recorded.",
        }

    amount = Decimal(verification["amount"])
    slot = verification.get("slot")
    try:
        live_balance = solana_spl_token_balance(destination_wallet)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Could not refresh the live BALMZ Devnet balance") from exc

    with db() as conn:
        inserted = conn.execute(
            """INSERT INTO solana_devnet_deposits(tx_signature,wallet_id,destination_address,amount,slot)
               VALUES(%s,%s,%s,%s,%s)
               ON CONFLICT(tx_signature) DO NOTHING
               RETURNING tx_signature""",
            (tx_signature, user["wallet_id"], destination_wallet, amount, slot),
        ).fetchone()

        if not inserted:
            existing = conn.execute(
                "SELECT wallet_id,amount FROM solana_devnet_deposits WHERE tx_signature=%s",
                (tx_signature,),
            ).fetchone()
            if not existing:
                raise HTTPException(status_code=503, detail="Could not confirm the existing Devnet deposit record")
            if existing[0] != user["wallet_id"]:
                raise HTTPException(status_code=409, detail="This transaction signature has already been claimed by another wallet")
            amount = Decimal(existing[1])
            conn.execute(
                """INSERT INTO assets(wallet_id,symbol,name,balance,price_usd)
                   VALUES(%s,'BALMZ-SOL-DEVNET','BALMZ Token (Solana Devnet)',%s,0)
                   ON CONFLICT(wallet_id,symbol) DO UPDATE
                   SET balance=EXCLUDED.balance,name=EXCLUDED.name""",
                (user["wallet_id"], live_balance),
            )
            conn.commit()
            return {
                "status": "confirmed",
                "recorded": True,
                "replayed": True,
                "network": "solana-devnet",
                "asset": "BALMZ-SOL-DEVNET",
                "amount": str(amount),
                "balance": live_balance,
                "tx_signature": tx_signature,
                "slot": slot,
                "finality": "finalized",
                "mainnet_funding": False,
            }

        conn.execute(
            """INSERT INTO assets(wallet_id,symbol,name,balance,price_usd)
               VALUES(%s,'BALMZ-SOL-DEVNET','BALMZ Token (Solana Devnet)',%s,0)
               ON CONFLICT(wallet_id,symbol) DO UPDATE
               SET balance=EXCLUDED.balance,name=EXCLUDED.name""",
            (user["wallet_id"], live_balance),
        )
        deposit_id = "dep_" + sha("solana-devnet-deposit:" + tx_signature)[:24]
        conn.execute(
            """INSERT INTO transactions(
                 id,wallet_id,type,asset,description,amount,status,destination,network,tx_hash,confirmations,block_height
               ) VALUES(%s,%s,'received','BALMZ-SOL-DEVNET','BALMZ Devnet deposit',%s,'confirmed',%s,
                        'solana-devnet',%s,1,%s)""",
            (
                deposit_id, user["wallet_id"], amount, destination_wallet, tx_signature,
                slot if isinstance(slot, int) and slot <= 2147483647 else None,
            ),
        )
        conn.commit()

    return {
        "status": "confirmed",
        "recorded": True,
        "replayed": False,
        "network": "solana-devnet",
        "asset": "BALMZ-SOL-DEVNET",
        "amount": str(amount),
        "balance": live_balance,
        "tx_signature": tx_signature,
        "slot": slot,
        "finality": "finalized",
        "mainnet_funding": False,
        "broadcast": False,
    }


def reconcile_settled_asset(conn, user, symbol, network):
    # Chain synchronization is authoritative for actual balance. Re-read it after
    # verification instead of subtracting the request amount a second time.
    address = wallet_network_address(user, network)
    value = None
    try:
        if symbol == "BTC" and address:
            value = btc_balance(address)
        elif symbol in {"ETH", "BNB"} and address:
            value = evm_balance(ETH_RPC_URL if network == "ethereum" else BSC_RPC_URL, address)
        elif symbol == "BALMZ-SOL-DEVNET" and network == "solana-devnet" and address:
            value = solana_spl_token_balance(
                address, BALMZ_SOLANA_DEVNET_MINT,
                BALMZ_SOLANA_DEVNET_DECIMALS,
            )
        elif symbol in {"USDT", "BALMZ"} and address:
            if symbol == "BALMZ":
                contract = BALMZ_ETH_CONTRACT if network == "ethereum" else ""
                rpc = ETH_RPC_URL if network == "ethereum" else ""
            else:
                contract = USDT_ETH_CONTRACT if network == "ethereum" else USDT_BSC_CONTRACT
                rpc = ETH_RPC_URL if network == "ethereum" else BSC_RPC_URL
            if contract and rpc:
                value = erc20_balance(rpc, contract, address)
    except Exception:
        value = None
    if value is not None:
        conn.execute("UPDATE assets SET balance=%s WHERE wallet_id=%s AND symbol=%s", (value,user["wallet_id"],symbol))


@app.post("/api/v1/transactions/settle")
def settle_transaction(request: TransactionSettleRequest,user: dict = Depends(current_user)):
    tx_hash = request.tx_hash.strip()
    with db() as conn:
        initial=conn.execute(
            "SELECT id,asset FROM transactions WHERE id=%s AND wallet_id=%s",
            (request.transaction_id,user["wallet_id"]),
        ).fetchone()
        if not initial:
            raise HTTPException(status_code=404,detail="Transaction not found")
        txid,symbol=initial
        asset=conn.execute(
            "SELECT reserved_balance FROM assets WHERE wallet_id=%s AND symbol=%s FOR UPDATE",
            (user["wallet_id"],symbol),
        ).fetchone()
        row=conn.execute(
            "SELECT id,asset,amount,status,destination,network,tx_hash FROM transactions WHERE id=%s AND wallet_id=%s FOR UPDATE",
            (txid,user["wallet_id"]),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404,detail="Transaction not found")
        txid,symbol,amount,status,destination,network,existing_hash=row
        if status in {"confirmed","settled"}:
            return {"status":"confirmed","transaction_id":txid,"tx_hash":existing_hash,"replayed":True}
        if status == "cancelled":
            raise HTTPException(status_code=409,detail="Cancelled transaction cannot be settled")
        if status not in {"pending","pending_review","broadcast_pending"}:
            raise HTTPException(status_code=409,detail="Transaction is not eligible for settlement")
        if existing_hash and existing_hash.lower() != tx_hash.lower():
            raise HTTPException(status_code=409,detail="Transaction already has a different broadcast hash")
        if network == "solana-devnet" and symbol == "BALMZ-SOL-DEVNET":
            try:
                verification = verify_solana_devnet_settlement(
                    tx_hash, destination, abs(Decimal(amount)),
                    wallet_network_address(user, "solana-devnet"),
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        elif network == "bitcoin":
            if not BTC_TX_HASH_RE.fullmatch(tx_hash):
                raise HTTPException(status_code=400,detail="Invalid Bitcoin transaction hash")
            verification=verify_bitcoin_settlement(tx_hash,destination,abs(Decimal(amount)),wallet_network_address(user,"bitcoin"))
        elif network in {"ethereum","bnb"}:
            if not EVM_TX_HASH_RE.fullmatch(tx_hash):
                raise HTTPException(status_code=400,detail="Invalid EVM transaction hash")
            verification=verify_evm_settlement(tx_hash,symbol,network,destination,abs(Decimal(amount)),wallet_network_address(user,network))
        else:
            raise HTTPException(status_code=400,detail="Unsupported settlement network")

        if verification["state"] == "not_found":
            raise HTTPException(status_code=404,detail="Blockchain transaction was not found")
        if verification["state"] == "pending":
            conn.execute(
                "UPDATE transactions SET tx_hash=%s,status='broadcast_pending',confirmations=%s,block_height=%s WHERE id=%s AND wallet_id=%s",
                (tx_hash,verification.get("confirmations",0),verification.get("block_height"),txid),
            )
            conn.commit()
            return {"status":"broadcast_pending","transaction_id":txid,"tx_hash":tx_hash,"confirmations":verification.get("confirmations",0),"finality":verification.get("finality"),"broadcast":False}

        hold=abs(Decimal(amount))
        if not asset or Decimal(asset[0] or 0) < hold:
            raise HTTPException(status_code=409,detail="Reservation state is inconsistent; manual review required")
        conn.execute(
            "UPDATE assets SET reserved_balance=reserved_balance-%s WHERE wallet_id=%s AND symbol=%s",
            (hold,user["wallet_id"],symbol),
        )
        conn.execute(
            "UPDATE transactions SET status='settled',tx_hash=%s,confirmations=%s,block_height=%s WHERE id=%s AND wallet_id=%s",
            (tx_hash,verification.get("confirmations",0),verification.get("block_height"),txid),
        )
        reconcile_settled_asset(conn,user,symbol,network)
        conn.commit()
        return {
            "status":"confirmed",
            "transaction_id":txid,
            "tx_hash":tx_hash,
            "confirmations":verification.get("confirmations",0),
            "finality":verification.get("finality"),
            "block_height":verification.get("block_height"),
            "accounting":"reserved_released_and_chain_reconciled",
            "broadcast":False,
        }


@app.post("/api/v1/transactions/cancel")
def cancel_transaction(request: TransactionCancelRequest,user: dict = Depends(current_user)):
    with db() as conn:
        initial=conn.execute("SELECT id,asset FROM transactions WHERE id=%s AND wallet_id=%s",(request.transaction_id,user["wallet_id"])).fetchone()
        if not initial: raise HTTPException(status_code=404,detail="Transaction not found")
        txid,symbol=initial
        asset=conn.execute("SELECT reserved_balance FROM assets WHERE wallet_id=%s AND symbol=%s FOR UPDATE",(user["wallet_id"],symbol)).fetchone()
        row=conn.execute("SELECT id,asset,amount,status,tx_hash FROM transactions WHERE id=%s AND wallet_id=%s FOR UPDATE",(txid,user["wallet_id"])).fetchone()
        if not row: raise HTTPException(status_code=404,detail="Transaction not found")
        txid,symbol,amount,status,tx_hash=row
        if status not in {"pending","pending_review"} or tx_hash: raise HTTPException(status_code=409,detail="Only unbroadcast pending requests can be cancelled")
        hold=-Decimal(amount)
        if not asset or Decimal(asset[0] or 0)<hold: raise HTTPException(status_code=409,detail="Reservation state is inconsistent; manual review required")
        conn.execute("UPDATE assets SET reserved_balance=reserved_balance-%s WHERE wallet_id=%s AND symbol=%s",(hold,user["wallet_id"],symbol))
        conn.execute("UPDATE transactions SET status='cancelled' WHERE id=%s AND wallet_id=%s",(txid,user["wallet_id"]))
        conn.commit()
    return {"status":"cancelled","transaction_id":txid,"asset":symbol,"released":float(hold)}


# GitHub account OAuth: tokens are encrypted at rest and never returned to the browser.
import hmac as _github_hmac
from fastapi import Request
from fastapi.responses import RedirectResponse
from cryptography.fernet import Fernet, InvalidToken

GITHUB_OAUTH_CLIENT_ID = os.getenv("WORLD_WALLET_GITHUB_CLIENT_ID", "").strip()
GITHUB_OAUTH_CLIENT_SECRET = os.getenv("WORLD_WALLET_GITHUB_CLIENT_SECRET", "").strip()
GITHUB_OAUTH_REDIRECT_URI = os.getenv("WORLD_WALLET_GITHUB_REDIRECT_URI", "").strip()
GITHUB_OAUTH_ADMIN_EMAIL = (WORLD_WALLET_ADMIN_EMAIL or os.getenv("WORLD_WALLET_GITHUB_ADMIN_EMAIL", "")).strip().lower()
GITHUB_OAUTH_FRONTEND_URL = os.getenv("WORLD_WALLET_GITHUB_FRONTEND_URL", "").strip().rstrip("/")
GITHUB_OAUTH_SCOPES = os.getenv("WORLD_WALLET_GITHUB_SCOPES", "read:user,public_repo").strip()
GITHUB_TOKEN_ENCRYPTION_KEY = os.getenv("WORLD_WALLET_GITHUB_TOKEN_ENCRYPTION_KEY", "").strip()


def _github_fernet():
    if not GITHUB_TOKEN_ENCRYPTION_KEY:
        raise HTTPException(status_code=503, detail="GitHub token encryption is not configured")
    try:
        return Fernet(GITHUB_TOKEN_ENCRYPTION_KEY.encode("ascii"))
    except Exception as exc:
        raise HTTPException(status_code=503, detail="GitHub token encryption key is invalid") from exc


def _github_oauth_configured():
    if not (GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET and GITHUB_OAUTH_REDIRECT_URI):
        raise HTTPException(status_code=503, detail="GitHub OAuth is not configured on the server")
    if not GITHUB_OAUTH_ADMIN_EMAIL:
        raise HTTPException(status_code=503, detail="GitHub admin email is not configured on the server")
    _github_fernet()


def _github_admin(user):
    if not GITHUB_OAUTH_ADMIN_EMAIL:
        raise HTTPException(status_code=503, detail="GitHub admin email is not configured on the server")
    if str((user or {}).get("email") or "").strip().lower() != GITHUB_OAUTH_ADMIN_EMAIL:
        raise HTTPException(status_code=403, detail="GitHub integration is restricted to the configured administrator")
    return user


def _github_tables(conn):
    conn.execute("""
      CREATE TABLE IF NOT EXISTS github_oauth_states (
        state_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    """)
    conn.execute("""
      CREATE TABLE IF NOT EXISTS github_oauth_connections (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        github_user_id BIGINT NOT NULL,
        github_login TEXT NOT NULL,
        encrypted_access_token TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '',
        connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    """)
    conn.commit()


def _github_frontend_redirect(status):
    base = GITHUB_OAUTH_FRONTEND_URL or (TRUSTED_ORIGINS[0] if TRUSTED_ORIGINS else "")
    if not base:
        raise HTTPException(status_code=503, detail="GitHub OAuth frontend URL is not configured")
    return RedirectResponse(url=base + "/?github_oauth=" + status, status_code=303)


@app.get("/api/v1/integrations/github/status")
def github_oauth_status(user=Depends(current_user)):
    _github_admin(user)
    with db() as conn:
        _github_tables(conn)
        row = conn.execute(
            "SELECT github_login,scopes,connected_at FROM github_oauth_connections WHERE user_id=%s",
            (user["id"],),
        ).fetchone()
    return {
        "configured": bool(GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET and GITHUB_OAUTH_REDIRECT_URI and GITHUB_TOKEN_ENCRYPTION_KEY),
        "connected": bool(row),
        "login": row[0] if row else None,
        "scopes": row[1].split(",") if row and row[1] else [],
        "connected_at": row[2].isoformat() if row and row[2] else None,
        "repository_access": "public_and_authorized_public_repositories",
    }


@app.post("/api/v1/integrations/github/oauth/start")
def github_oauth_start(user=Depends(current_user)):
    _github_admin(user)
    _github_oauth_configured()
    state = secrets.token_urlsafe(32)
    state_hash = hashlib.sha256(state.encode("utf-8")).hexdigest()
    with db() as conn:
        _github_tables(conn)
        conn.execute("DELETE FROM github_oauth_states WHERE expires_at < NOW()")
        conn.execute(
            "INSERT INTO github_oauth_states(state_hash,user_id,expires_at) VALUES(%s,%s,NOW()+INTERVAL '10 minutes')",
            (state_hash, user["id"]),
        )
        conn.commit()
    from urllib.parse import urlencode
    query = urlencode({
        "client_id": GITHUB_OAUTH_CLIENT_ID,
        "redirect_uri": GITHUB_OAUTH_REDIRECT_URI,
        "scope": GITHUB_OAUTH_SCOPES.replace(" ", ""),
        "state": state,
        "allow_signup": "false",
    })
    return {"authorize_url": "https://github.com/login/oauth/authorize?" + query}


@app.get("/api/v1/integrations/github/oauth/callback")
def github_oauth_callback(code: str = "", state: str = "", error: str = ""):
    # Callback is protected by a high-entropy, single-use state tied to the initiating admin.
    if error:
        return _github_frontend_redirect("denied")
    if not code or not state or len(state) > 200:
        return _github_frontend_redirect("invalid")
    if not (GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET and GITHUB_OAUTH_REDIRECT_URI):
        return _github_frontend_redirect("not_configured")
    state_hash = hashlib.sha256(state.encode("utf-8")).hexdigest()
    with db() as conn:
        _github_tables(conn)
        row = conn.execute(
            "DELETE FROM github_oauth_states WHERE state_hash=%s AND expires_at > NOW() RETURNING user_id",
            (state_hash,),
        ).fetchone()
        conn.commit()
    if not row:
        return _github_frontend_redirect("invalid")
    admin_user_id = row[0]
    try:
        token_response = httpx.post(
            "https://github.com/login/oauth/access_token",
            headers={"Accept": "application/json", "User-Agent": "WorldWalletAI"},
            data={
                "client_id": GITHUB_OAUTH_CLIENT_ID,
                "client_secret": GITHUB_OAUTH_CLIENT_SECRET,
                "code": code,
                "redirect_uri": GITHUB_OAUTH_REDIRECT_URI,
            },
            timeout=15,
            follow_redirects=False,
        )
        if not token_response.is_success:
            return _github_frontend_redirect("exchange_failed")
        token_payload = token_response.json()
        access_token = str(token_payload.get("access_token") or "")
        granted_scopes = str(token_payload.get("scope") or "")
        if not access_token or token_payload.get("error"):
            return _github_frontend_redirect("exchange_failed")
        gh_headers = {
            "Authorization": "Bearer " + access_token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "WorldWalletAI",
        }
        profile_response = httpx.get("https://api.github.com/user", headers=gh_headers, timeout=15, follow_redirects=False)
        if not profile_response.is_success:
            return _github_frontend_redirect("profile_failed")
        profile = profile_response.json()
        github_id = profile.get("id")
        github_login = str(profile.get("login") or "").strip()
        if not isinstance(github_id, int) or not github_login:
            return _github_frontend_redirect("profile_failed")
        encrypted_token = _github_fernet().encrypt(access_token.encode("utf-8")).decode("ascii")
        with db() as conn:
            _github_tables(conn)
            # Ensure the OAuth flow's initiating user is still the configured admin.
            admin = conn.execute("SELECT email FROM users WHERE id=%s", (admin_user_id,)).fetchone()
            if not admin or str(admin[0] or "").strip().lower() != GITHUB_OAUTH_ADMIN_EMAIL:
                return _github_frontend_redirect("not_authorized")
            conn.execute("""
              INSERT INTO github_oauth_connections(user_id,github_user_id,github_login,encrypted_access_token,scopes,connected_at,updated_at)
              VALUES(%s,%s,%s,%s,%s,NOW(),NOW())
              ON CONFLICT(user_id) DO UPDATE SET
                github_user_id=EXCLUDED.github_user_id,
                github_login=EXCLUDED.github_login,
                encrypted_access_token=EXCLUDED.encrypted_access_token,
                scopes=EXCLUDED.scopes,
                connected_at=NOW(),
                updated_at=NOW()
            """, (admin_user_id, github_id, github_login, encrypted_token, granted_scopes))
            conn.commit()
        return _github_frontend_redirect("connected")
    except (httpx.HTTPError, ValueError, KeyError):
        return _github_frontend_redirect("exchange_failed")


@app.get("/api/v1/integrations/github/repositories")
def github_oauth_repositories(user=Depends(current_user)):
    _github_admin(user)
    with db() as conn:
        _github_tables(conn)
        row = conn.execute(
            "SELECT encrypted_access_token FROM github_oauth_connections WHERE user_id=%s",
            (user["id"],),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=409, detail="Connect GitHub before loading repository metadata")
    try:
        access_token = _github_fernet().decrypt(row[0].encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError, UnicodeError) as exc:
        raise HTTPException(status_code=503, detail="Stored GitHub credential cannot be decrypted; reconnect GitHub") from exc
    response = httpx.get(
        "https://api.github.com/user/repos",
        headers={
            "Authorization": "Bearer " + access_token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "WorldWalletAI",
        },
        params={"per_page": 100, "sort": "updated", "direction": "desc", "visibility": "all"},
        timeout=20,
        follow_redirects=False,
    )
    if response.status_code == 401:
        raise HTTPException(status_code=409, detail="GitHub authorization expired or was revoked; reconnect GitHub")
    if not response.is_success:
        raise HTTPException(status_code=502, detail="GitHub repository metadata could not be loaded")
    repositories = []
    for item in response.json():
        if not isinstance(item, dict):
            continue
        repositories.append({
            "id": item.get("id"),
            "name": item.get("name"),
            "full_name": item.get("full_name"),
            "private": bool(item.get("private")),
            "default_branch": item.get("default_branch"),
            "description": item.get("description"),
            "html_url": item.get("html_url"),
            "updated_at": item.get("updated_at"),
            "pushed_at": item.get("pushed_at"),
            "language": item.get("language"),
            "fork": bool(item.get("fork")),
            "archived": bool(item.get("archived")),
            "stargazers_count": item.get("stargazers_count"),
            "open_issues_count": item.get("open_issues_count"),
        })
    return {"repositories": repositories, "count": len(repositories)}


@app.delete("/api/v1/integrations/github")
def github_oauth_disconnect(user=Depends(current_user)):
    _github_admin(user)
    with db() as conn:
        _github_tables(conn)
        row = conn.execute("SELECT encrypted_access_token FROM github_oauth_connections WHERE user_id=%s", (user["id"],)).fetchone()
    if row and GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET:
        try:
            token = _github_fernet().decrypt(row[0].encode("ascii")).decode("utf-8")
            revoke = httpx.delete(
                "https://api.github.com/applications/" + GITHUB_OAUTH_CLIENT_ID + "/grant",
                auth=(GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET),
                headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "WorldWalletAI"},
                json={"access_token": token},
                timeout=15,
                follow_redirects=False,
            )
            if revoke.status_code not in {204, 404} and not revoke.is_success:
                raise HTTPException(status_code=502, detail="GitHub token revocation failed; the saved connection was kept. Try again.")
        except (InvalidToken, ValueError, UnicodeError) as exc:
            raise HTTPException(status_code=503, detail="Stored GitHub token cannot be decrypted; connection was kept for manual recovery") from exc
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail="GitHub token revocation could not be reached; the saved connection was kept") from exc
    with db() as conn:
        _github_tables(conn)
        conn.execute("DELETE FROM github_oauth_connections WHERE user_id=%s", (user["id"],))
        conn.execute("DELETE FROM github_oauth_states WHERE user_id=%s", (user["id"],))
        conn.commit()
    return {"connected": False}


# Gemini provider connection check. The API key stays in backend environment only.
def _gemini_admin(user):
    if not GEMINI_ADMIN_EMAIL:
        raise HTTPException(status_code=503, detail="Gemini admin email is not configured on the server")
    if str((user or {}).get("email") or "").strip().lower() != GEMINI_ADMIN_EMAIL:
        raise HTTPException(status_code=403, detail="Gemini integration is restricted to the configured administrator")
    return user


@app.get("/api/v1/integrations/gemini/status")
def gemini_status(user=Depends(current_user)):
    _gemini_admin(user)
    return {
        "configured": bool(GEMINI_API_KEY),
        "model": GEMINI_MODEL,
        "provider": "Google Gemini",
        "key_present": bool(GEMINI_API_KEY),
    }


@app.post("/api/v1/integrations/gemini/test")
async def gemini_connection_test(user=Depends(current_user)):
    _gemini_admin(user)
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="Gemini API key is not configured on the backend. Set GEMINI_API_KEY in Render.")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=8.0)) as client:
            response = await client.post(
                url,
                headers={"x-goog-api-key": GEMINI_API_KEY},
                json={
                    "contents": [{"parts": [{"text": "Reply with exactly: World Wallet AI Gemini connection OK"}]}],
                    "generationConfig": {"temperature": 0, "maxOutputTokens": 24},
                },
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="Gemini connection timed out. Try again shortly.") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Unable to reach the Gemini API from the backend.") from exc

    if response.is_error:
        # Do not echo provider response bodies; they may contain request metadata.
        if response.status_code in (401, 403):
            detail = "Gemini rejected the API key or its permissions. Check the key and Gemini API access in Google AI Studio/Cloud."
            status_code = 502
        elif response.status_code == 429:
            detail = "Gemini rate limit or quota reached. Check the project's quota and billing settings."
            status_code = 429
        else:
            detail = f"Gemini API returned HTTP {response.status_code}. Check the selected model and provider configuration."
            status_code = 502
        raise HTTPException(status_code=status_code, detail=detail)

    try:
        data = response.json()
        text = "".join(
            part.get("text", "")
            for candidate in data.get("candidates", [])
            for part in candidate.get("content", {}).get("parts", [])
            if isinstance(part, dict)
        ).strip()
    except (ValueError, AttributeError, TypeError):
        text = ""
    if not text:
        raise HTTPException(status_code=502, detail="Gemini responded but returned no text. Check model availability and API access.")
    return {
        "success": True,
        "provider": "Google Gemini",
        "model": GEMINI_MODEL,
        "message": "Gemini connection test passed.",
        "response_preview": text[:160],
        "tested_at": datetime.now(timezone.utc).isoformat(),
    }
