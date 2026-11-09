import os
import logging
import base64
import hashlib
import re
import secrets
import time
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from decimal import Decimal
from threading import Lock
from anyio import to_thread

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
    from services.api.wallet_workflows import generate_transaction_reference, record_wallet_audit_event
except ModuleNotFoundError:
    from wallet_workflows import generate_transaction_reference, record_wallet_audit_event

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
GEMINI_MODEL = os.getenv("WORLD_WALLET_GEMINI_MODEL", "gemini-3.8-flash").strip()
COINGECKO_API_KEY = os.getenv("COINGECKO_API_KEY", "").strip()
# Etherscan V2 key is backend-only; never expose it through frontend build variables or API responses.
ETHERSCAN_API_KEY = os.getenv("ETHERSCAN_API_KEY", "").strip()
ETHERSCAN_V2_API_URL = "https://api.etherscan.io/v2/api"
ETHERSCAN_CHAIN_IDS = {"ethereum": 1, "bnb": 56, "sepolia": 11155111}
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
SOLANA_MAINNET_RPC_URL = (os.getenv("WORLD_WALLET_SOLANA_MAINNET_RPC_URL") or "https://api.mainnet-beta.solana.com").strip()
SOLANA_DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
BALMZ_SOLANA_DEVNET_MINT = "HBSuf6Dm9r2ebkwLUoaY8ScR2rq5L2CPTJpCbqMbtndF"
BALMZ_SOLANA_DEVNET_DECIMALS = 9
BALMZ_SOLANA_MAINNET_MINT = os.getenv("WORLD_WALLET_BALMZ_SOLANA_MAINNET_MINT", "").strip()
BALMZ_PRESALE_RECEIVING_ADDRESS = os.getenv("WORLD_WALLET_BALMZ_PRESALE_RECEIVING_ADDRESS", "").strip()
BALMZ_PRESALE_PRICE_USD = Decimal("7.00")
BALMZ_TARGET_SUPPLY = 1_000_000_000
SOLANA_SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"


def normalize_wallet_network(value: str) -> str:
    """Normalize explicit chain names without guessing which network 'mainnet' means."""
    network = re.sub(r"[\s-]+", "_", str(value or "").strip().lower())
    aliases = {
        "solana": "solana_mainnet",
        "solana_mainnet_beta": "solana_mainnet",
        "mainnet_beta": "solana_mainnet",
        "devnet": "solana_devnet",
        "eth": "ethereum",
        "ethereum_mainnet": "ethereum",
        "ethereum_sepolia": "sepolia",
        "bsc": "bnb",
        "binance_smart_chain": "bnb",
    }
    return aliases.get(network, network)
BTC_ADDRESS = os.getenv("WORLD_WALLET_BTC_ADDRESS", "").strip()
ETHEREUM_USDT_MAINNET_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7"
USDT_ETH_CONTRACT = os.getenv("WORLD_WALLET_USDT_ETH_CONTRACT", "").strip()
USDT_BSC_CONTRACT = os.getenv("WORLD_WALLET_USDT_BSC_CONTRACT", "").strip()
BSC_USDT_MAINNET_CONTRACT = "0x55d398326f99059fF775485246999027B3197955"
BALMZ_ETH_CONTRACT = os.getenv("WORLD_WALLET_BALMZ_ETH_CONTRACT", "").strip()
BALMZ_SEPOLIA_CONTRACT = os.getenv("WORLD_WALLET_BALMZ_SEPOLIA_CONTRACT", "").strip()
BALMZ_BNB_CONTRACT = os.getenv("WORLD_WALLET_BALMZ_BNB_CONTRACT", "").strip()

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
    source_address: str | None = Field(default=None, max_length=128)


class WithdrawalRequest(BaseModel):
    idempotency_key: str = Field(min_length=8, max_length=128)
    asset: str = Field(min_length=2, max_length=12)
    amount: Decimal = Field(gt=0, max_digits=36, decimal_places=18)
    destination: str = Field(min_length=4, max_length=128)
    network: str = Field(min_length=3, max_length=32)
    note: str | None = Field(default=None, max_length=200)
    source_address: str | None = Field(default=None, max_length=128)


class RequestCreate(BaseModel):
    kind: str = Field(min_length=2, max_length=32)
    title: str = Field(min_length=2, max_length=120)
    details: str = Field(default="", max_length=1000)


class RequestStatusUpdate(BaseModel):
    request_id: str = Field(min_length=4, max_length=80)
    status: str = Field(min_length=2, max_length=32)


class AdminAnnouncementUpdate(BaseModel):
    title: str = Field(default="", max_length=120)
    body: str = Field(default="", max_length=600)
    enabled: bool = False


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


class WalletAddressChallengeRequest(BaseModel):
    network: str = Field(min_length=2, max_length=32)
    address: str = Field(min_length=4, max_length=128)


class WalletAddressVerifyRequest(BaseModel):
    challenge_id: str = Field(min_length=12, max_length=100)
    signature: str = Field(min_length=20, max_length=300)


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


# A small per-process pool prevents request bursts from opening unbounded Neon
# connections. Render currently runs one API worker; keep this limit conservative.
_DB_POOL = None
_DB_POOL_LOCK = Lock()


def configure_api_thread_limit():
    """Bound synchronous FastAPI work to protect the small Render instance from RAM spikes."""
    raw_limit = os.getenv("WORLD_WALLET_API_THREAD_LIMIT", "4").strip()
    try:
        requested_limit = int(raw_limit)
    except (TypeError, ValueError):
        logger.warning("Invalid WORLD_WALLET_API_THREAD_LIMIT; using the safe default")
        requested_limit = 4

    # Keep synchronous request concurrency conservative on the 512 MiB Render
    # instance. Operators may lower this value, but cannot raise it above eight.
    # AnyIO worker capacity stays bounded for the small instance.
    requested_limit = max(2, min(requested_limit, 8))
    try:
        limiter = to_thread.current_default_thread_limiter()
        effective_limit = min(int(limiter.total_tokens), requested_limit)
        limiter.total_tokens = effective_limit
        logger.info("API synchronous request capacity configured: %s", effective_limit)
        return effective_limit
    except Exception as exc:
        # A failed tuning step must not prevent the API from starting.
        logger.warning("Could not configure API thread capacity: error_type=%s", type(exc).__name__)
        return None


def db():
    if not DATABASE_URL:
        raise HTTPException(status_code=503, detail="World Wallet database is not configured")
    global _DB_POOL
    if _DB_POOL is None:
        with _DB_POOL_LOCK:
            if _DB_POOL is None:
                from psycopg_pool import ConnectionPool
                _DB_POOL = ConnectionPool(
                    conninfo=DATABASE_URL,
                    min_size=1,
                    max_size=3,
                    timeout=5,
                    max_idle=300,
                    max_lifetime=1800,
                    reconnect_timeout=10,
                    kwargs={
                        "connect_timeout": 5,
                        "application_name": "world-wallet-ai-api",
                    },
                    open=True,
                )
    return _DB_POOL.connection(timeout=5)


@app.on_event("shutdown")
def close_database_pool():
    """Return pooled connections cleanly when the API process shuts down."""
    if _DB_POOL is not None:
        _DB_POOL.close()


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
        CREATE SEQUENCE IF NOT EXISTS wallets_wallet_number_seq
          AS BIGINT MINVALUE 1 MAXVALUE 99999999999 START WITH 10000000000 INCREMENT BY 1 NO CYCLE;
        CREATE TABLE IF NOT EXISTS wallets(
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
          name TEXT NOT NULL DEFAULT 'Wallet', currency TEXT NOT NULL DEFAULT 'USD',
          wallet_number BIGINT NOT NULL DEFAULT nextval('wallets_wallet_number_seq')
            CHECK (wallet_number BETWEEN 10000000000 AND 99999999999),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE wallets ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'Wallet';
        ALTER TABLE wallets ADD COLUMN IF NOT EXISTS wallet_number BIGINT;
        ALTER TABLE wallets ADD COLUMN IF NOT EXISTS mining_referral_code TEXT;
        ALTER TABLE wallets ADD COLUMN IF NOT EXISTS world_wallet_code TEXT;
        UPDATE wallets SET wallet_number=nextval('wallets_wallet_number_seq') WHERE wallet_number IS NULL;
        UPDATE wallets SET
          mining_referral_code=COALESCE(NULLIF(mining_referral_code,''),'MINE-' || upper(substr(md5(id || random()::text || clock_timestamp()::text),1,10))),
          world_wallet_code=COALESCE(NULLIF(world_wallet_code,''),'WWAI-' || upper(substr(md5(random()::text || clock_timestamp()::text || id),1,10)))
        WHERE mining_referral_code IS NULL OR mining_referral_code='' OR world_wallet_code IS NULL OR world_wallet_code='';
        ALTER TABLE wallets ALTER COLUMN mining_referral_code SET DEFAULT ('MINE-' || upper(substr(md5(random()::text || clock_timestamp()::text),1,10)));
        ALTER TABLE wallets ALTER COLUMN world_wallet_code SET DEFAULT ('WWAI-' || upper(substr(md5(random()::text || clock_timestamp()::text),1,10)));
        ALTER TABLE wallets ALTER COLUMN mining_referral_code SET NOT NULL;
        ALTER TABLE wallets ALTER COLUMN world_wallet_code SET NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS wallets_mining_referral_code_unique ON wallets(mining_referral_code);
        CREATE UNIQUE INDEX IF NOT EXISTS wallets_world_wallet_code_unique ON wallets(world_wallet_code);
        ALTER TABLE wallets ALTER COLUMN wallet_number SET DEFAULT nextval('wallets_wallet_number_seq');
        ALTER TABLE wallets ALTER COLUMN wallet_number SET NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS wallets_wallet_number_unique ON wallets(wallet_number);
        DO $$
        BEGIN
          ALTER TABLE wallets ADD CONSTRAINT wallets_wallet_number_11_digits
            CHECK (wallet_number BETWEEN 10000000000 AND 99999999999);
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
        SELECT setval(
          'wallets_wallet_number_seq',
          GREATEST(COALESCE((SELECT MAX(wallet_number) FROM wallets), 9999999999::BIGINT), 9999999999::BIGINT),
          TRUE
        );
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
        -- Preserve existing rows while supporting multiple addresses and ownership proof.
        ALTER TABLE wallet_addresses DROP CONSTRAINT IF EXISTS wallet_addresses_pkey;
        ALTER TABLE wallet_addresses ADD COLUMN IF NOT EXISTS ownership_verified BOOLEAN NOT NULL DEFAULT FALSE;
        CREATE UNIQUE INDEX IF NOT EXISTS wallet_addresses_unique_address_idx ON wallet_addresses(wallet_id,network,address);
        CREATE TABLE IF NOT EXISTS wallet_address_challenges(
          id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL REFERENCES wallets(id), owner_id TEXT NOT NULL REFERENCES users(id),
          network TEXT NOT NULL, address TEXT NOT NULL, message TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
          used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS wallet_address_challenges_owner_idx ON wallet_address_challenges(owner_id,wallet_id,created_at DESC);
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
        CREATE TABLE IF NOT EXISTS balmz_mining_sessions(
          id TEXT PRIMARY KEY,
          wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('active','completed')),
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ended_at TIMESTAMPTZ,
          duration_seconds BIGINT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CHECK ((status='active' AND ended_at IS NULL) OR (status='completed' AND ended_at IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS balmz_mining_sessions_wallet_started_idx
          ON balmz_mining_sessions(wallet_id,started_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS balmz_mining_one_active_session_per_wallet
          ON balmz_mining_sessions(wallet_id) WHERE status='active';
        CREATE TABLE IF NOT EXISTS balmz_mining_reward_ledger(
          id TEXT PRIMARY KEY,
          wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES balmz_mining_sessions(id) ON DELETE CASCADE,
          cycle_number BIGINT NOT NULL CHECK(cycle_number > 0),
          earned_at TIMESTAMPTZ NOT NULL,
          reward_amount NUMERIC(36,18) NOT NULL CHECK(reward_amount = 0.5),
          status TEXT NOT NULL DEFAULT 'pending_launch'
            CHECK(status IN ('pending_launch','paid')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(wallet_id,session_id,cycle_number)
        );
        CREATE INDEX IF NOT EXISTS balmz_mining_reward_wallet_day_idx
          ON balmz_mining_reward_ledger(wallet_id,earned_at);
        CREATE TABLE IF NOT EXISTS admin_audit_events(
          id TEXT PRIMARY KEY,
          actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          actor_email TEXT NOT NULL,
          action TEXT NOT NULL,
          details TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS admin_audit_events_created_idx
          ON admin_audit_events(created_at DESC);
        CREATE TABLE IF NOT EXISTS wallet_audit_events(
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
          actor_email TEXT NOT NULL,
          action TEXT NOT NULL,
          resource TEXT NOT NULL,
          resource_id TEXT,
          network TEXT,
          reference TEXT,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS wallet_audit_wallet_time_idx
          ON wallet_audit_events(wallet_id,created_at DESC);
        CREATE INDEX IF NOT EXISTS wallet_audit_owner_time_idx
          ON wallet_audit_events(owner_id,created_at DESC);
        CREATE TABLE IF NOT EXISTS wallet_announcements(
          id SMALLINT PRIMARY KEY CHECK(id=1),
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          updated_by TEXT NOT NULL REFERENCES users(id),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tx_hash TEXT;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS from_address TEXT;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS confirmations INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS block_height INTEGER;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS block_hash TEXT;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS log_index INTEGER;
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference TEXT;
        UPDATE transactions
          SET reference='WWTX-' || upper(substr(md5(id || random()::text || clock_timestamp()::text),1,24))
          WHERE reference IS NULL OR reference='';
        ALTER TABLE transactions ALTER COLUMN reference
          SET DEFAULT ('WWTX-' || upper(substr(md5(random()::text || clock_timestamp()::text),1,24)));
        ALTER TABLE transactions ALTER COLUMN reference SET NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS transactions_reference_unique
          ON transactions(reference);
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
        wallet = conn.execute("SELECT id,wallet_number FROM wallets WHERE id=%s AND owner_id=%s", (row[3],row[0])).fetchone() if row[3] else None
        if not wallet:
            wallet = conn.execute("SELECT id,wallet_number FROM wallets WHERE owner_id=%s ORDER BY created_at ASC LIMIT 1", (row[0],)).fetchone()
        return {
            "id": row[0], "email": row[1], "name": row[2],
            "wallet_id": wallet[0] if wallet else None,
            "wallet_number": str(wallet[1]) if wallet and wallet[1] is not None else None,
            "phone_number": row[4], "phone_verified": bool(row[5]),
        }


def provision_identity(email: str, password: str | None = None, name: str = "World Wallet User", google_subject: str | None = None):
    user = get_user(email)
    with db() as conn:
        wallet_provisioned = False
        owner_id = user["id"] if user else "usr_" + sha(email.lower())[:24]
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
                wallet_provisioned = True
        else:
            user_id = owner_id
            conn.execute("INSERT INTO users(id,email,name,password_sha256,google_subject) VALUES(%s,%s,%s,%s,%s)",
                         (user_id,email,name,sha(password) if password else None,google_subject))
            wallet_id = "wallet_" + sha(user_id)[:24]
            conn.execute("INSERT INTO wallets(id,owner_id,name) VALUES(%s,%s,%s)", (wallet_id,user_id,"Production Wallet"))
            conn.execute("UPDATE users SET active_wallet_id=%s WHERE id=%s", (wallet_id,user_id))
            wallet_provisioned = True
        for symbol,asset_name in [
            ("BALMZ","BALMZ Token"),("BALMZ-SEP","BALMZ Token (Sepolia)"),("BTC","Bitcoin"),("ETH","Ethereum"),("USDT","Tether USD"),("BNB","BNB"),
            ("USDC","USD Coin"),("SOL","Solana"),("XRP","XRP"),("ADA","Cardano"),("LTC","Litecoin"),("DOGE","Dogecoin")
        ]:
            conn.execute(
                "INSERT INTO assets(wallet_id,symbol,name,balance,price_usd) VALUES(%s,%s,%s,0,0) ON CONFLICT(wallet_id,symbol) DO NOTHING",
                (wallet_id,symbol,asset_name)
            )
        if wallet_provisioned:
            record_wallet_audit_event(
                conn,
                owner_id=owner_id,
                wallet_id=wallet_id,
                actor_email=email.strip().lower(),
                action="wallet_provisioned",
                resource="wallet",
                resource_id=wallet_id,
                details={"provisioning_source": "account_registration_or_legacy_repair"},
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
                    SELECT u.id,u.email,u.name,u.active_wallet_id,u.phone_number,u.phone_verified_at,k.id,w.wallet_number
                    FROM api_keys k JOIN users u ON u.id=k.owner_id
                    LEFT JOIN wallets w ON w.id=u.active_wallet_id
                    WHERE k.key_hash=%s AND k.revoked_at IS NULL
                """, (sha(token),)).fetchone()
                if row:
                    conn.execute("UPDATE api_keys SET last_used_at=NOW() WHERE id=%s", (row[6],))
                    conn.commit()
                    return {"id": row[0], "email": row[1], "name": row[2], "wallet_id": row[3], "wallet_number": str(row[7]) if row[7] is not None else None, "phone_number": row[4], "phone_verified": bool(row[5])}
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
    return b"\x00" * leading + raw


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
    # BNB Chain USDT has its own wallet-asset row. Normalize the legacy
    # request label so reservations never debit Ethereum USDT by accident.
    if symbol == "USDT" and net == "bnb":
        symbol = "USDT-BNB"
    if symbol == "BALMZ" and net == "bnb":
        symbol = "BALMZ-BNB"
    allowed = {
        "ETH": {"ethereum"},
        "BNB": {"bnb"},
        "USDT": {"ethereum"},
        "USDT-BNB": {"bnb"},
        "BTC": {"bitcoin"},
        "BALMZ": {"ethereum"},
        "BALMZ-BNB": {"bnb"},
        "BALMZ-SEP": {"sepolia"},
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



def require_solana_rpc_cluster(url: str, expected_genesis_hash: str, cluster_name: str):
    """Fail closed when a Solana RPC URL points at the wrong cluster."""
    if not url:
        raise ValueError(f"{cluster_name} RPC is not configured")
    actual_genesis_hash = rpc_call(url, "getGenesisHash", [])
    if actual_genesis_hash != expected_genesis_hash:
        raise ValueError(f"Configured {cluster_name} RPC returned an unexpected Solana cluster genesis hash")
    return actual_genesis_hash


def solana_spl_token_balance(owner_address: str, mint_address: str = BALMZ_SOLANA_DEVNET_MINT, decimals: int = BALMZ_SOLANA_DEVNET_DECIMALS):
    """Read the confirmed SPL token balance from Solana Devnet without signing."""
    if not valid_solana_address(owner_address) or not valid_solana_address(mint_address):
        raise ValueError("Invalid Solana owner or mint address")
    if int(decimals) != BALMZ_SOLANA_DEVNET_DECIMALS:
        raise ValueError("Unexpected BALMZ Solana Devnet decimals")
    require_solana_rpc_cluster(SOLANA_DEVNET_RPC_URL, SOLANA_DEVNET_GENESIS_HASH, "Solana Devnet")
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


def require_bnb_rpc(url: str):
    """Fail closed if the BNB RPC endpoint is not BNB Smart Chain mainnet."""
    chain_id = evm_chain_id(url)
    if chain_id != 56:
        raise ValueError("Configured BNB RPC did not report chain ID 56")
    return chain_id


def evm_balance(url: str, address: str):
    raw = rpc_call(url, "eth_getBalance", [address, "latest"])
    return int(raw, 16) / 10**18 if raw else 0.0


def btc_balance(address: str):
    if not address:
        return None
    # Validate before placing the address into a public API path. This also
    # prevents malformed input from being treated as a Bitcoin Mainnet address.
    if not valid_bitcoin_address(address):
        raise ValueError("Invalid Bitcoin Mainnet address")
    response = httpx.get(f"https://blockstream.info/api/address/{address}", timeout=10)
    response.raise_for_status()
    data = response.json()
    chain = data.get("chain_stats")
    if not isinstance(chain, dict):
        raise ValueError("Bitcoin API response is missing confirmed chain statistics")
    funded = int(chain.get("funded_txo_sum", 0))
    spent = int(chain.get("spent_txo_sum", 0))
    if funded < 0 or spent < 0 or spent > funded:
        raise ValueError("Bitcoin API returned invalid confirmed balance statistics")
    # Confirmed balance is the accounting source of truth. Pending mempool
    # movement is surfaced through transaction status and must not bypass
    # the wallet's reservation model.
    return (funded - spent) / 100_000_000

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


def etherscan_v2_request(chain_id: int, module: str, action: str, params: dict | None = None):
    """Perform a backend-only, read-only Etherscan API V2 GET request."""
    if not ETHERSCAN_API_KEY:
        raise HTTPException(status_code=503, detail="Etherscan API key is not configured on the backend")
    if int(chain_id) not in ETHERSCAN_CHAIN_IDS.values():
        raise ValueError("Unsupported Etherscan chain ID")
    if not re.fullmatch(r"[a-zA-Z]+", str(module or "")) or not re.fullmatch(r"[a-zA-Z]+", str(action or "")):
        raise ValueError("Invalid Etherscan API module or action")
    query = dict(params or {})
    # Reserved authentication/routing fields cannot be overridden by endpoint parameters.
    query.update({
        "chainid": int(chain_id),
        "module": module,
        "action": action,
        "apikey": ETHERSCAN_API_KEY,
    })
    response = httpx.get(ETHERSCAN_V2_API_URL, params=query, timeout=12)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("Etherscan returned an unexpected response")
    return payload


def etherscan_contract_source(chain_id: int, address: str):
    """Return safe contract verification metadata only; do not return source or API credentials."""
    payload = etherscan_v2_request(
        chain_id, "contract", "getsourcecode", {"address": address}
    )
    if str(payload.get("status")) != "1":
        raise ValueError("Etherscan source lookup did not succeed")
    results = payload.get("result")
    if not isinstance(results, list) or not results or not isinstance(results[0], dict):
        raise ValueError("Etherscan source lookup returned no contract metadata")
    item = results[0]
    source_text = str(item.get("SourceCode") or "").strip()
    abi_text = str(item.get("ABI") or "").strip()
    verified = bool(source_text and abi_text and abi_text != "Contract source code not verified")
    return {
        "source_verified": verified,
        "contract_name": str(item.get("ContractName") or "")[:160] or None,
        "compiler_version": str(item.get("CompilerVersion") or "")[:100] or None,
        "optimization_used": str(item.get("OptimizationUsed") or "")[:10] or None,
        "proxy": str(item.get("Proxy") or "")[:10] or None,
        "implementation": str(item.get("Implementation") or "")[:42] or None,
    }


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
        elif network == "bnb":
            require_bnb_rpc(url)
        latest = evm_block_number(url)
        if latest is None:
            return [], "latest block unavailable"

        lookback = max(1, min(int(os.getenv("WORLD_WALLET_EVM_NATIVE_TX_LOOKBACK_BLOCKS", "100")), 500))
        source = network + ":native"
        native_asset = "ETH" if network == "ethereum" else ("BNB" if network == "bnb" else "ETH-SEP" if network == "sepolia" else network.upper())
        wallet_lower = wallet_address.lower()
        reorg_overlap = max(1, min(int(os.getenv("WORLD_WALLET_SYNC_REORG_OVERLAP", "6")), 20))
        required = max(1, min(int(os.getenv("WORLD_WALLET_EVM_CONFIRMATIONS", "3")), 100))

        # Fetch the sync cursor, then release the connection before block/receipt RPCs.
        with db() as conn:
            cursor = _sync_cursor(conn, user["wallet_id"], source)
        start = max(0, latest - lookback + 1) if cursor is None else max(0, cursor - reorg_overlap + 1)

        block_hashes = {}
        candidates = []
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
                direction = "received" if recipient == wallet_lower else "sent"
                signed_amount = value if direction == "received" else -value
                receipt = rpc_call(url, "eth_getTransactionReceipt", [tx_hash])
                receipt_status = str(receipt.get("status") or "").lower() if receipt else ""
                confirmations = max(0, latest - block_number + 1)
                if receipt_status == "0x0":
                    status = "failed"
                elif receipt is None or receipt_status != "0x1":
                    status = "pending"
                else:
                    status = "confirmed" if confirmations >= required else "pending"
                candidates.append({
                    "tx_hash":tx_hash,
                    "sender":sender,
                    "recipient":recipient,
                    "direction":direction,
                    "amount":signed_amount,
                    "status":status,
                    "confirmations":confirmations,
                    "block_number":block_number,
                    "block_hash":block_hash,
                })

        # Read possible reorg candidates in a short query. Canonical block lookups
        # happen only after this connection has been returned to the pool.
        with db() as conn:
            saved_rows = conn.execute(
                "SELECT id,block_height,block_hash FROM transactions "
                "WHERE wallet_id=%s AND network=%s AND asset=%s AND block_height BETWEEN %s AND %s "
                "AND status IN ('confirmed','pending','failed','settled','broadcast_pending')",
                (user["wallet_id"], network, native_asset, start, latest),
            ).fetchall()

        reorg_ids = []
        for row_id, height, old_hash in saved_rows:
            if height is None or not old_hash:
                continue
            height = int(height)
            current_hash = block_hashes.get(height)
            if current_hash is None:
                try:
                    canonical = rpc_call(url, "eth_getBlockByNumber", [hex(height), False])
                    current_hash = (canonical or {}).get("hash")
                except Exception:
                    current_hash = None
            if current_hash and old_hash.lower() != current_hash.lower():
                reorg_ids.append(row_id)

        imported = []
        # Persist the already verified RPC observations in one short transaction.
        with db() as conn:
            for item in candidates:
                existing = conn.execute(
                    "SELECT id,status,type,description,block_hash FROM transactions "
                    "WHERE wallet_id=%s AND tx_hash=%s AND network=%s AND asset=%s",
                    (user["wallet_id"], item["tx_hash"], network, native_asset),
                ).fetchone()
                status = item["status"]
                confirmations = item["confirmations"]
                tx_id = "evm_" + item["tx_hash"]
                if existing:
                    old_id, old_status, old_type, old_description, old_block_hash = existing
                    tx_id = old_id
                    if old_status == "reorged" or (old_block_hash and item["block_hash"] and old_block_hash.lower() != item["block_hash"].lower()):
                        status = "reorged"
                        confirmations = 0
                    elif old_status == "settled":
                        status = "settled"
                    elif status != "failed" and old_status in {"pending","pending_review","broadcast_pending"} and (old_type == "withdrawal" or old_description in {"Transfer request","Withdrawal request"}):
                        status = "broadcast_pending"
                    conn.execute(
                        "UPDATE transactions SET confirmations=%s,block_height=%s,block_hash=%s,status=%s WHERE id=%s AND wallet_id=%s",
                        (confirmations, item["block_number"], item["block_hash"], status, tx_id, user["wallet_id"]),
                    )
                else:
                    conn.execute(
                        "INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network,tx_hash,confirmations,block_height,block_hash) "
                        "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (tx_id,user["wallet_id"],item["direction"],native_asset,
                         f"{network} native {item['direction']}",item["amount"],status,
                         item["recipient"] if item["direction"]=="sent" else item["sender"],
                         network,item["tx_hash"],confirmations,item["block_number"],item["block_hash"]),
                    )
                imported.append({
                    "tx_hash":item["tx_hash"],"asset":native_asset,"network":network,
                    "type":item["direction"],"amount":item["amount"],"status":status,
                    "confirmations":confirmations,"block_height":item["block_number"],"block_hash":item["block_hash"],
                })
            if reorg_ids:
                conn.execute(
                    "UPDATE transactions SET status='reorged',confirmations=0 WHERE wallet_id=%s AND id=ANY(%s)",
                    (user["wallet_id"], reorg_ids),
                )
            _set_sync_cursor(conn, user["wallet_id"], source, latest)
            conn.commit()
        return imported, None
    except Exception as exc:
        logger.warning("%s native transaction sync failed: error_type=%s", network, type(exc).__name__)
        return [], f"{network} native transaction service unavailable"
def sync_evm_token_transactions(user, url: str, network: str, contract: str, symbol: str, decimals: int = 6, wallet_address=None):
    wallet_address = wallet_address or next((a["address"] for a in configured_addresses(user) if a["network"]==network), None)
    if not url or not contract or not wallet_address:
        return [], None
    if not wallet_owns_network_address(user, network, wallet_address):
        return [], f"{network} wallet address is not saved to the active wallet"
    try:
        if network == "ethereum":
            require_ethereum_mainnet_rpc(url)
            decimals = verified_erc20_decimals(url, contract, network, chain_checked=True)
        elif network == "sepolia":
            require_sepolia_rpc(url)
        elif network == "bnb":
            decimals = verified_erc20_decimals(url, contract, network)
        latest = evm_block_number(url)
        if latest is None:
            return [], "latest block unavailable"
        lookback = max(1, min(int(os.getenv("WORLD_WALLET_EVM_TX_LOOKBACK_BLOCKS", "5000")), 100000))
        source = network + ":" + symbol.lower()

        # Only the cursor query uses a DB connection; log/receipt RPCs run without one.
        with db() as cursor_conn:
            cursor = _sync_cursor(cursor_conn, user["wallet_id"], source)
        reorg_overlap = max(1, min(int(os.getenv("WORLD_WALLET_SYNC_REORG_OVERLAP", "6")), 20))
        start = max(0, latest - lookback + 1) if cursor is None else max(0, cursor - reorg_overlap + 1)
        logs = evm_transfer_logs(url, contract, wallet_address, start, latest)
    except Exception as exc:
        logger.warning("%s %s transaction RPC preparation failed: error_type=%s", network, symbol, type(exc).__name__)
        return [], f"{network} {symbol} transaction service unavailable"

    candidates = []
    block_hashes = {}
    wallet_lower = wallet_address.lower()
    required = required_confirmations("WORLD_WALLET_EVM_CONFIRMATIONS")
    try:
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
            direction = "received" if recipient.lower() == wallet_lower else "sent"
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
                status = "confirmed" if confirmations >= required else "pending"
            candidates.append({
                "sender":sender,"recipient":recipient,"direction":direction,"amount":signed_amount,
                "tx_hash":tx_hash,"block_number":block_number,"log_index":log_index,
                "block_hash":block_hash,"confirmations":confirmations,"status":status,
            })

        with db() as conn:
            saved_rows = conn.execute(
                "SELECT id,block_height,block_hash FROM transactions WHERE wallet_id=%s AND network=%s AND asset=%s "
                "AND block_height BETWEEN %s AND %s AND status IN ('confirmed','pending','failed','settled','broadcast_pending')",
                (user["wallet_id"],network,symbol,start,latest),
            ).fetchall()

        reorg_ids = []
        for row_id, height, old_hash in saved_rows:
            if height is None or not old_hash:
                continue
            height = int(height)
            current_hash = block_hashes.get(height)
            if current_hash is None:
                try:
                    canonical = rpc_call(url, "eth_getBlockByNumber", [hex(height), False])
                    current_hash = (canonical or {}).get("hash")
                except Exception:
                    current_hash = None
            if current_hash and old_hash.lower() != current_hash.lower():
                reorg_ids.append(row_id)

        imported = []
        with db() as conn:
            for item in candidates:
                existing = conn.execute(
                    "SELECT id,status,type,description,block_hash FROM transactions WHERE wallet_id=%s AND tx_hash=%s AND network=%s AND asset=%s "
                    "AND COALESCE(log_index,-1)=COALESCE(%s,-1)",
                    (user["wallet_id"],item["tx_hash"],network,symbol,item["log_index"]),
                ).fetchone()
                tx_id = existing[0] if existing else "evm_" + item["tx_hash"] + "_" + str(item["log_index"] if item["log_index"] is not None else 0)
                status = item["status"]
                confirmations = item["confirmations"]
                if existing:
                    old_id, old_status, old_type, old_description, old_block_hash = existing
                    if old_status == "reorged" or (old_block_hash and item["block_hash"] and old_block_hash.lower() != item["block_hash"].lower()):
                        status = "reorged"
                        confirmations = 0
                    elif old_status == "settled":
                        status = "settled"
                    elif status != "failed" and old_status in {"pending","pending_review","broadcast_pending"} and (old_type == "withdrawal" or old_description in {"Transfer request","Withdrawal request"}):
                        status = "broadcast_pending"
                    conn.execute(
                        "UPDATE transactions SET confirmations=%s,block_height=%s,block_hash=%s,log_index=%s,status=%s,from_address=%s,destination=%s WHERE id=%s AND wallet_id=%s",
                        (confirmations,item["block_number"],item["block_hash"],item["log_index"],status,
                         item["sender"],item["recipient"],tx_id,user["wallet_id"]),
                    )
                else:
                    description = f"{symbol} {item['direction']} on {network}"
                    conn.execute(
                        "INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network,tx_hash,confirmations,block_height,block_hash,log_index,from_address) "
                        "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (tx_id,user["wallet_id"],item["direction"],symbol,description,item["amount"],status,
                         item["recipient"],network,item["tx_hash"],confirmations,item["block_number"],
                         item["block_hash"],item["log_index"],item["sender"]),
                    )
                imported.append({
                    "tx_hash":item["tx_hash"],"asset":symbol,"network":network,"type":item["direction"],
                    "amount":item["amount"],"status":status,"confirmations":confirmations,
                    "block_height":item["block_number"],"block_hash":item["block_hash"],"log_index":item["log_index"],
                    "from_address":item["sender"],"to_address":item["recipient"],
                })
            if reorg_ids:
                conn.execute(
                    "UPDATE transactions SET status='reorged',confirmations=0 WHERE wallet_id=%s AND id=ANY(%s)",
                    (user["wallet_id"], reorg_ids),
                )
            _set_sync_cursor(conn, user["wallet_id"], source, latest)
            conn.commit()
    except Exception as exc:
        logger.warning("%s %s transaction persistence failed: error_type=%s", network, symbol, type(exc).__name__)
        return [], f"{network} {symbol} transaction service unavailable"
    return imported, None
def bitcoin_address_transactions(address: str):
    if not address:
        return []
    # Never query the explorer with an unvalidated address.
    if not valid_bitcoin_address(address):
        raise ValueError("Invalid Bitcoin Mainnet address")
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

    # Fetch the explorer tip outside the DB lease, then read the rows that need
    # reorg checks and release that lease before canonical block-height requests.
    reorg_ids = []
    try:
        tip_response = httpx.get("https://blockstream.info/api/blocks/tip/height", timeout=10)
        tip_response.raise_for_status()
        tip_height = int(tip_response.text.strip())
        lookback = max(1, min(int(os.getenv("WORLD_WALLET_BTC_REORG_LOOKBACK_BLOCKS", "144")), 1000))
        with db() as conn:
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
                reorg_ids.append(row_id)
    except Exception:
        # Transaction import remains useful even if the explorer's optional
        # canonical reorg check is unavailable.
        reorg_ids = []

    imported = []
    with db() as conn:
        for item in chain_txs:
            tx_hash = item["tx_hash"]
            if not tx_hash:
                continue
            existing = conn.execute(
                "SELECT id FROM transactions WHERE wallet_id=%s AND tx_hash=%s",
                (user["wallet_id"],tx_hash),
            ).fetchone()
            tx_id = existing[0] if existing else "btc_" + tx_hash
            description = "Bitcoin transaction " + tx_hash[:12] + "…"
            if existing:
                existing_row = conn.execute(
                    "SELECT type,status,block_hash,description FROM transactions WHERE id=%s AND wallet_id=%s FOR UPDATE",
                    (tx_id,user["wallet_id"]),
                ).fetchone()
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
                    conn.execute(
                        "UPDATE transactions SET status=%s,confirmations=%s,block_height=%s,block_hash=%s,network='bitcoin' WHERE id=%s AND wallet_id=%s",
                        (status,confirmations,item["block_height"],item.get("block_hash"),tx_id,user["wallet_id"]),
                    )
                elif old_type == "sent":
                    conn.execute(
                        "UPDATE transactions SET status=%s,confirmations=%s,block_height=%s,block_hash=%s,network='bitcoin' WHERE id=%s AND wallet_id=%s",
                        (status,confirmations,item["block_height"],item.get("block_hash"),tx_id,user["wallet_id"]),
                    )
                else:
                    conn.execute(
                        "UPDATE transactions SET type=%s,asset='BTC',description=%s,amount=%s,status=%s,network='bitcoin',confirmations=%s,block_height=%s,block_hash=%s WHERE id=%s AND wallet_id=%s",
                        (item["type"],description,item["amount"],status,confirmations,item["block_height"],item.get("block_hash"),tx_id,user["wallet_id"]),
                    )
                item = {**item,"status":status,"confirmations":confirmations}
            else:
                conn.execute(
                    "INSERT INTO transactions(id,wallet_id,type,asset,description,amount,status,destination,network,tx_hash,confirmations,block_height,block_hash) "
                    "VALUES(%s,%s,%s,'BTC',%s,%s,%s,%s,'bitcoin',%s,%s,%s,%s)",
                    (tx_id,user["wallet_id"],item["type"],description,item["amount"],item["status"],address,
                     item["tx_hash"],item["confirmations"],item["block_height"],item.get("block_hash")),
                )
            imported.append(item)
        if reorg_ids:
            conn.execute(
                "UPDATE transactions SET status='reorged',confirmations=0 WHERE wallet_id=%s AND id=ANY(%s)",
                (user["wallet_id"], reorg_ids),
            )
        conn.commit()
    return imported
def wallet_valuation_summary(assets, transactions):
    """Summarize wallet exposure using verified current prices.

    Partial totals include only assets/transactions with a positive known quote.
    The corresponding unpriced-symbol lists make omissions explicit.
    """
    # Devnet assets remain visible in the wallet asset list, but must never
    # affect production portfolio valuation or mark production holdings as unpriced.
    testnet_symbols = {"BALMZ-SEP", "BALMZ-SOL-DEVNET", "SOL-DEVNET"}
    testnet_networks = {"sepolia", "ethereum-sepolia", "solana-devnet", "solana_devnet"}
    production_candidates = [item for item in assets
                             if str(item.get("symbol", "")) not in testnet_symbols
                             and str(item.get("network", "")).strip().lower() not in testnet_networks]
    unclassified_assets = [
        item for item in production_candidates
        if "network" in item and item.get("network") is None
        and (float(item.get("balance") or 0) > 0 or float(item.get("reserved_balance") or 0) > 0)
    ]
    # Legacy callers/tests without a network field keep their established
    # behaviour. Only wallet_snapshot's explicit network=None is withheld.
    assets = [item for item in production_candidates
              if not ("network" in item and item.get("network") is None)]
    transactions = [item for item in transactions
                    if str(item.get("asset", "")) not in testnet_symbols
                    and str(item.get("network", "")).strip().lower() not in testnet_networks]
    prices = {str(item["symbol"]): float(item.get("price_usd") or 0) for item in assets}
    available_valuation_complete = not unclassified_assets and all(
        (float(item["balance"] or 0) <= 0 and float(item["reserved_balance"] or 0) <= 0)
        or bool(item.get("price_available"))
        for item in assets
    )
    actual_valuation_complete = not unclassified_assets and all(
        float(item["actual_balance"] or 0) <= 0 or bool(item.get("price_available"))
        for item in assets
    )
    reserved_valuation_complete = not unclassified_assets and all(
        float(item["reserved_balance"] or 0) <= 0 or bool(item.get("price_available"))
        for item in assets
    )

    unpriced_assets = sorted({
        str(item["symbol"]) for item in assets
        if (float(item["balance"] or 0) > 0 or float(item["reserved_balance"] or 0) > 0)
        and not bool(item.get("price_available"))
    } | {
        str(item.get("symbol") or "Asset") + " (network attribution pending)"
        for item in unclassified_assets
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
        "unclassified_assets": sorted(str(item.get("symbol") or "Asset") for item in unclassified_assets),
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
        network_by_asset = {
            "BTC": "bitcoin", "ETH": "ethereum", "BNB": "bnb",
            "SOL": "solana_mainnet", "SOL-DEVNET": "solana_devnet",
            "USDT": "ethereum", "USDT-BNB": "bnb", "USDC": "ethereum",
            "USDC-BNB": "bnb", "BALMZ": "ethereum", "BALMZ-BNB": "bnb", "BALMZ-SEP": "sepolia",
            "BALMZ-SOL-DEVNET": "solana_devnet",
        }
        for registry_symbol, registry_network in conn.execute(
            "SELECT symbol,network FROM token_registry WHERE status='active'"
        ):
            network_by_asset[wallet_asset_symbol(str(registry_symbol), str(registry_network))] = str(registry_network)
        network_labels = {
            "bitcoin": "Bitcoin Mainnet", "ethereum": "Ethereum Mainnet",
            "bnb": "BNB Chain Mainnet", "solana_mainnet": "Solana Mainnet",
            "sepolia": "Ethereum Sepolia (testnet)", "solana_devnet": "Solana Devnet (testnet)",
        }
        solana_mainnet_address_exists = conn.execute(
            "SELECT 1 FROM wallet_addresses WHERE wallet_id=%s AND network='solana_mainnet' LIMIT 1",
            (user["wallet_id"],),
        ).fetchone() is not None
        for symbol,name,balance,reserved_balance,price in conn.execute(
            "SELECT symbol,name,balance,reserved_balance,price_usd FROM assets WHERE wallet_id=%s ORDER BY symbol",(user["wallet_id"],)
        ):
            actual=Decimal(balance or 0); reserved=Decimal(reserved_balance or 0); available=max(actual-reserved,Decimal("0")); p=Decimal(price or 0)
            price_available = p > 0
            asset_network = network_by_asset.get(str(symbol))
            # Older releases could store Solana Devnet SOL in the generic SOL
            # row. Without a separately configured Mainnet address that row
            # cannot safely be attributed to production holdings.
            if str(symbol) == "SOL" and not solana_mainnet_address_exists:
                asset_network = None
            display_name = ("Binance-Peg BSC-USD (BNB Chain)"
                            if str(symbol) == "USDT-BNB" and USDT_BSC_CONTRACT.lower() == BSC_USDT_MAINNET_CONTRACT.lower()
                            else name)
            assets.append({"symbol":symbol,"name":display_name,"network":asset_network,
                "network_label":network_labels.get(asset_network, "Network not classified"),
                "balance":float(available),"available_balance":float(available),
                "actual_balance":float(actual),"reserved_balance":float(reserved),"price_usd":float(p),
                "price_available":price_available,
                "live_price_usd":float(p) if price_available else None,
                "value_usd":float(available*p) if price_available else None,
                "actual_value_usd":float(actual*p) if price_available else None,"change_24h":None})
        txs=[]
        for row in conn.execute("SELECT id,reference,type,asset,description,amount,status,tx_hash,confirmations,block_height,network,block_hash,log_index,created_at FROM transactions WHERE wallet_id=%s ORDER BY created_at DESC LIMIT 100",(user["wallet_id"],)):
            txs.append({"id":row[0],"reference":row[1],"type":row[2],"asset":row[3],"description":row[4],"amount":float(row[5]),"status":row[6],"tx_hash":row[7],"confirmations":int(row[8] or 0),"block_height":row[9],"network":row[10],"block_hash":row[11],"log_index":row[12],"time":row[13].isoformat()})
        # Dashboard activity remains capped at 100 records, but the received/sent
        # valuation summaries must cover all recorded rows, not only that page.
        transaction_totals=[]
        for row in conn.execute("""
            SELECT type,asset,SUM(ABS(amount)),COUNT(*)
            FROM transactions
            WHERE wallet_id=%s
              AND (type='received' OR (type IN ('sent','withdrawal') AND amount < 0))
              AND COALESCE(LOWER(REPLACE(network, '_', '-')), '') NOT IN ('sepolia', 'ethereum-sepolia', 'solana-devnet')
            GROUP BY type,asset
        """,(user["wallet_id"],)):
            transaction_totals.append({"type":row[0],"asset":row[1],"amount":float(row[2] or 0),"count":int(row[3] or 0)})
    return assets,txs,wallet_valuation_summary(assets,transaction_totals)


def wallet_reconciliation_snapshot(user):
    """Read-only internal-ledger controls; this does not re-query chain RPCs."""
    wallet_id = user["wallet_id"]
    with db() as conn:
        reservation_rows = conn.execute(
            """
            SELECT a.symbol, a.reserved_balance,
                   COALESCE(SUM(
                     CASE WHEN t.description IN ('Transfer request','Withdrawal request')
                               AND t.status IN ('pending','pending_review','broadcast_pending')
                          THEN -t.amount ELSE 0 END
                   ), 0)
            FROM assets a
            LEFT JOIN transactions t
              ON t.wallet_id=a.wallet_id AND t.asset=a.symbol
            WHERE a.wallet_id=%s
            GROUP BY a.symbol,a.reserved_balance
            ORDER BY a.symbol
            """,
            (wallet_id,),
        ).fetchall()
        status_rows = conn.execute(
            "SELECT status,COUNT(*) FROM transactions WHERE wallet_id=%s GROUP BY status ORDER BY status",
            (wallet_id,),
        ).fetchall()
        missing_hash_rows = conn.execute(
            """
            SELECT id,reference,type,asset,network,status
            FROM transactions
            WHERE wallet_id=%s AND status IN ('confirmed','settled')
              AND (tx_hash IS NULL OR btrim(tx_hash)='')
            ORDER BY created_at DESC LIMIT 50
            """,
            (wallet_id,),
        ).fetchall()
        cursor_rows = conn.execute(
            "SELECT source,last_block,updated_at FROM chain_sync_cursors WHERE wallet_id=%s ORDER BY source",
            (wallet_id,),
        ).fetchall()

    exceptions = []
    asset_checks = []
    total_reserved = Decimal("0")
    total_expected = Decimal("0")
    for symbol, reserved_value, expected_value in reservation_rows:
        reserved = Decimal(str(reserved_value or 0))
        expected = Decimal(str(expected_value or 0))
        total_reserved += reserved
        total_expected += expected
        matches = reserved == expected
        asset_checks.append({
            "asset": symbol,
            "reserved_balance": str(reserved),
            "pending_request_reservation": str(expected),
            "matches": matches,
        })
        if not matches:
            exceptions.append({
                "type": "reservation_mismatch",
                "asset": symbol,
                "reserved_balance": str(reserved),
                "pending_request_reservation": str(expected),
            })

    for row in missing_hash_rows:
        exceptions.append({
            "type": "confirmed_transaction_missing_chain_hash",
            "transaction_id": row[0],
            "reference": row[1],
            "transaction_type": row[2],
            "asset": row[3],
            "network": row[4],
            "status": row[5],
        })

    now = datetime.now(timezone.utc)
    cursors = []
    for source, last_block, updated_at in cursor_rows:
        updated = updated_at
        if updated is not None and updated.tzinfo is None:
            updated = updated.replace(tzinfo=timezone.utc)
        age_seconds = max(0, int((now - updated).total_seconds())) if updated is not None else None
        cursors.append({
            "source": source,
            "last_block": int(last_block),
            "updated_at": updated.isoformat() if updated is not None else None,
            "age_seconds": age_seconds,
        })

    return {
        "status": "REVIEW_REQUIRED" if exceptions else "CLEAR",
        "wallet_id": wallet_id,
        "wallet_number": user.get("wallet_number"),
        "scope": "active_wallet",
        "source": "internal_transaction_and_reservation_records",
        "chain_rpc_requeried": False,
        "totals": {
            "reserved_balance": str(total_reserved),
            "pending_request_reservation": str(total_expected),
        },
        "asset_checks": asset_checks,
        "transaction_status_counts": [
            {"status": row[0], "count": int(row[1])} for row in status_rows
        ],
        "chain_sync_cursors": cursors,
        "exceptions": exceptions,
        "checked_at": now.isoformat(),
    }


@app.on_event("startup")
def startup():
    configure_api_thread_limit()
    init_db()
    if DATABASE_URL and IDENTITY_EMAIL and IDENTITY_PASSWORD:
        provision_identity(IDENTITY_EMAIL, IDENTITY_PASSWORD)


@app.get("/")
def root():
    return {"status":"World Wallet AI API running","version":"1.0.0","data_source":"postgresql","chain_data":"configured_wallets_only"}


@app.get("/health")
def health():
    return {"status":"ok","database_configured":bool(DATABASE_URL)}


_BNB_HEALTH_CACHE_TTL_SECONDS = 60
_BNB_HEALTH_CACHE_LOCK = Lock()
_BNB_HEALTH_CACHE = {"checked_at": 0.0, "result": None}


@app.get("/health/bnb")
def bnb_rpc_health():
    """Read-only operational check for the configured BNB mainnet RPC and USDT contract."""
    now = time.monotonic()
    with _BNB_HEALTH_CACHE_LOCK:
        cached = _BNB_HEALTH_CACHE
        if cached["result"] is not None and now - cached["checked_at"] < _BNB_HEALTH_CACHE_TTL_SECONDS:
            return dict(cached["result"])

    try:
        if not BSC_RPC_URL:
            raise ValueError("BNB Chain RPC is not configured")
        if not USDT_BSC_CONTRACT:
            raise ValueError("BNB USDT contract is not configured")
        chain_id = require_bnb_rpc(BSC_RPC_URL)
        decimals = verified_erc20_decimals(BSC_RPC_URL, USDT_BSC_CONTRACT, "bnb", chain_checked=True)
        latest_block = evm_block_number(BSC_RPC_URL)
        if latest_block is None or latest_block <= 0:
            raise ValueError("BNB RPC did not return a valid latest block")
    except Exception as exc:
        logger.warning("BNB RPC health check failed: error_type=%s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="BNB Chain RPC or USDT-BNB contract check failed") from exc

    result = {
        "status": "ok",
        "network": "bnb",
        "chain_id": chain_id,
        "rpc_verified": True,
        "contract_address": USDT_BSC_CONTRACT,
        "token": "Binance-Peg BSC-USD",
        "decimals": decimals,
        "latest_block": latest_block,
        "read_only": True,
    }
    with _BNB_HEALTH_CACHE_LOCK:
        _BNB_HEALTH_CACHE["checked_at"] = now
        _BNB_HEALTH_CACHE["result"] = result
    return dict(result)


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


# Historical ERC-20 Approval(owner, spender, value) event.
ERC20_APPROVAL_TOPIC = "0x" + _keccak_hex("Approval(address,address,uint256)")
KNOWN_OKX_WALLETCORE_TARGETS = {"0x80296ff8d1ed46f8e3c7992664d13b833504c2bb"}


def _etherscan_result_list(payload, operation):
    """Normalize Etherscan V2 list responses without treating empty history as an error."""
    if not isinstance(payload, dict):
        raise ValueError("Etherscan returned an invalid " + operation + " response")
    result = payload.get("result")
    if str(payload.get("status")) == "1" and isinstance(result, list):
        return [item for item in result if isinstance(item, dict)]
    message = str(result or payload.get("message") or "").strip().lower()
    if any(phrase in message for phrase in ("no transactions found", "no records found", "no logs found", "no transactions")):
        return []
    raise ValueError("Etherscan could not complete the " + operation + " lookup")


def _format_token_interaction(item, network, owner, balmz_contract):
    """Return only public ERC-20 transfer fields; amounts remain exact decimal strings."""
    contract = str(item.get("contractAddress") or "").strip()
    raw_value = str(item.get("value") or "0")
    decimals_raw = item.get("tokenDecimal")
    try:
        raw_integer = int(raw_value)
        decimals = int(decimals_raw)
        if raw_integer < 0 or decimals < 0 or decimals > 36:
            raise ValueError
        amount = format(Decimal(raw_integer) / (Decimal(10) ** decimals), "f")
    except (TypeError, ValueError, ArithmeticError):
        raw_integer = None
        decimals = None
        amount = None
    return {
        "network": network,
        "owner_address": owner,
        "token_contract_address": contract or None,
        "token_name": str(item.get("tokenName") or "")[:120] or None,
        "token_symbol": str(item.get("tokenSymbol") or "")[:32] or None,
        "token_decimals": decimals,
        "amount_raw": str(raw_integer) if raw_integer is not None else raw_value[:120],
        "amount": amount,
        "from_address": str(item.get("from") or "") or None,
        "to_address": str(item.get("to") or "") or None,
        "tx_hash": str(item.get("hash") or "") or None,
        "block_number": str(item.get("blockNumber") or "") or None,
        "timestamp": str(item.get("timeStamp") or "") or None,
        "confirmations": str(item.get("confirmations") or "") or None,
        "balmz_contract_match": bool(
            balmz_contract and contract and contract.lower() == balmz_contract.lower()
        ),
    }


def _format_approval_interaction(item, network, owner):
    """Validate and normalize an indexed ERC-20 Approval log for the connected owner."""
    topics = item.get("topics") or []
    if len(topics) < 3 or str(topics[0]).lower() != ERC20_APPROVAL_TOPIC.lower():
        return None
    owner_topic = str(topics[1] or "").lower()
    spender_topic = str(topics[2] or "").lower()
    expected_owner = "0x" + str(owner)[2:].lower().rjust(64, "0")
    if owner_topic != expected_owner or not re.fullmatch(r"0x[0-9a-f]{64}", spender_topic):
        return None
    contract = str(item.get("address") or "").strip()
    if not valid_evm_address(contract):
        return None
    raw_data = str(item.get("data") or "")
    if not re.fullmatch(r"0x[0-9a-fA-F]{64}", raw_data):
        return None
    return {
        "network": network,
        "owner_address": owner,
        "token_contract_address": contract,
        "spender_address": "0x" + spender_topic[-40:],
        "amount_raw": str(int(raw_data, 16)),
        "tx_hash": str(item.get("transactionHash") or "") or None,
        "block_number": str(item.get("blockNumber") or "") or None,
        "log_index": str(item.get("logIndex") or "") or None,
    }


def _erc20_allowance_call_data(owner, spender):
    """Encode allowance(owner, spender) for a read-only eth_call."""
    if not valid_evm_address(owner) or not valid_evm_address(spender):
        raise ValueError("Invalid ERC-20 allowance address")
    return "0xdd62ed3e" + owner[2:].lower().rjust(64, "0") + spender[2:].lower().rjust(64, "0")


def _read_current_erc20_allowance(rpc_url, contract, owner, spender):
    """Read current allowance from the selected chain; return raw units only."""
    if not rpc_url or not valid_evm_address(contract):
        return None
    raw = rpc_call(rpc_url, "eth_call", [
        {"to": contract, "data": _erc20_allowance_call_data(owner, spender)}, "latest"
    ])
    if not isinstance(raw, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", raw):
        return None
    return str(int(raw, 16))


def _inspect_eip7702_for_network_address(rpc_url, network, address):
    """Inspect delegated account code only after the RPC chain identity is verified."""
    try:
        if network == "ethereum":
            chain_id = require_ethereum_mainnet_rpc(rpc_url)
        elif network == "bnb":
            chain_id = require_bnb_rpc(rpc_url)
        else:
            chain_id = require_sepolia_rpc(rpc_url) or 11155111
        code = rpc_call(rpc_url, "eth_getCode", [address, "latest"])
        target = _decode_eip7702_designator(code)
        return {
            "rpc_chain_verified": True,
            "chain_id": chain_id,
            "delegated": bool(target),
            "delegation_target": target,
            "known_okx_walletcore": bool(target and target.lower() in KNOWN_OKX_WALLETCORE_TARGETS),
            "note": "EIP-7702 delegation is not the same as an ERC-20 allowance or a claim authorization.",
        }
    except Exception as exc:
        return {
            "rpc_chain_verified": False,
            "delegated": None,
            "delegation_target": None,
            "known_okx_walletcore": False,
            "error_type": type(exc).__name__,
            "note": "Delegation could not be verified against the selected network RPC.",
        }


@app.get("/api/v1/wallet/token-interactions")
def wallet_token_interactions(
    networks: str = "ethereum,bnb,sepolia",
    page: int = 1,
    offset: int = 100,
    approval_from_block: int = 0,
    approval_to_block: str = "latest",
    user: dict = Depends(current_user),
):
    """Read-only token transfer history and block-ranged Approval discovery for verified active-wallet addresses."""
    if not ETHERSCAN_API_KEY:
        raise HTTPException(status_code=503, detail="Etherscan API V2 is not configured on the backend")
    if page < 1 or page > 100:
        raise HTTPException(status_code=400, detail="Page must be between 1 and 100")
    if offset < 1 or offset > 1000:
        raise HTTPException(status_code=400, detail="Page size must be between 1 and 1000")
    if approval_from_block < 0 or approval_from_block > 1000000000000:
        raise HTTPException(status_code=400, detail="Approval start block is outside the supported range")
    approval_to_block = str(approval_to_block or "latest").strip().lower()
    if approval_to_block != "latest" and (not approval_to_block.isdigit() or len(approval_to_block) > 16):
        raise HTTPException(status_code=400, detail="Approval end block must be a block number or latest")
    if approval_to_block != "latest" and int(approval_to_block) < approval_from_block:
        raise HTTPException(status_code=400, detail="Approval end block must not precede its start block")

    allowed_networks = {"ethereum", "bnb", "sepolia"}
    requested_networks = list(dict.fromkeys(part.strip().lower() for part in str(networks or "").split(",") if part.strip()))
    if not requested_networks or any(network not in allowed_networks for network in requested_networks):
        raise HTTPException(status_code=400, detail="Supported networks are ethereum, bnb, and sepolia")

    # Discover only addresses already attached to the signed-in user's active wallet.
    # Unverified addresses are reported but never queried for private wallet history.
    with db() as conn:
        rows = conn.execute(
            "SELECT network,address,label,ownership_verified FROM wallet_addresses "
            "WHERE wallet_id=%s ORDER BY network, CASE WHEN lower(label)='primary' THEN 0 ELSE 1 END, created_at, address",
            (user["wallet_id"],),
        ).fetchall()

    attached = [
        {"network": str(row[0] or "").strip().lower(), "address": str(row[1] or "").strip(),
         "label": str(row[2] or "")[:80], "ownership_verified": bool(row[3])}
        for row in rows
        if str(row[0] or "").strip().lower() in requested_networks and valid_evm_address(str(row[1] or "").strip())
    ]
    network_config = {
        "ethereum": {"chain_id": 1, "rpc": ETH_RPC_URL, "balmz_contract": BALMZ_ETH_CONTRACT},
        "bnb": {"chain_id": 56, "rpc": BSC_RPC_URL, "balmz_contract": BALMZ_BNB_CONTRACT},
        "sepolia": {"chain_id": 11155111, "rpc": SEPOLIA_RPC_URL, "balmz_contract": BALMZ_SEPOLIA_CONTRACT},
    }

    scanned_networks = []
    for network in requested_networks:
        config = network_config[network]
        network_addresses = [item for item in attached if item["network"] == network]
        verified_addresses = [item for item in network_addresses if item["ownership_verified"]][:10]
        address_results = []
        skipped = [
            {"address": item["address"], "label": item["label"], "reason": "Wallet address ownership is not signature-verified"}
            for item in network_addresses if not item["ownership_verified"]
        ]
        if len(network_addresses) > 10:
            skipped.extend(
                {"address": item["address"], "label": item["label"], "reason": "Per-network scan limit reached; retry after reviewing earlier results"}
                for item in network_addresses[10:]
            )

        for item in verified_addresses:
            owner = item["address"]
            warnings = []
            transfers = []
            approvals = []
            transfer_has_more = False
            approval_logs_truncated = False
            approval_last_block = None
            try:
                payload = etherscan_v2_request(
                    config["chain_id"], "account", "tokentx",
                    {"address": owner, "page": page, "offset": offset, "sort": "desc"},
                )
                raw_transfers = _etherscan_result_list(payload, "ERC-20 transfer history")
                transfers = [
                    _format_token_interaction(tx, network, owner, config["balmz_contract"])
                    for tx in raw_transfers
                ]
                transfer_has_more = len(raw_transfers) >= offset
            except Exception as exc:
                warnings.append("ERC-20 transfer history unavailable (" + type(exc).__name__ + ")")

            try:
                owner_topic = "0x" + owner[2:].lower().rjust(64, "0")
                payload = etherscan_v2_request(
                    config["chain_id"], "logs", "getLogs",
                    {
                        "fromBlock": str(approval_from_block), "toBlock": approval_to_block,
                        "topic0": ERC20_APPROVAL_TOPIC, "topic1": owner_topic,
                        "topic0_1_opr": "and",
                    },
                )
                raw_approvals = _etherscan_result_list(payload, "ERC-20 Approval history")
                for log in raw_approvals:
                    normalized = _format_approval_interaction(log, network, owner)
                    if normalized:
                        approvals.append(normalized)
                # Etherscan documents a hard 1,000-log response cap for getLogs;
                # it does not offer reliable page/offset pagination for this endpoint.
                approval_logs_truncated = len(raw_approvals) >= 1000
                approval_last_block = max(
                    (int(str(log.get("blockNumber"))) for log in raw_approvals
                     if str(log.get("blockNumber") or "").isdigit()),
                    default=None,
                )
            except Exception as exc:
                warnings.append("ERC-20 Approval history unavailable (" + type(exc).__name__ + ")")

            if approval_logs_truncated:
                warnings.append("Approval history reached Etherscan's 1,000-log cap for this block range; narrow the block range and rescan.")
            proxy = _inspect_eip7702_for_network_address(config["rpc"], network, owner) if config["rpc"] else {
                "rpc_chain_verified": False, "delegated": None, "delegation_target": None,
                "known_okx_walletcore": False, "note": "Network RPC is not configured; delegation was not checked.",
            }

            # Historical Approval events do not reveal whether an allowance is still active.
            # Read the current allowance for the newest distinct token/spender pairs only.
            current_allowances = []
            seen_pairs = set()
            allowance_checks_truncated = False
            for approval in approvals:
                pair = (approval["token_contract_address"].lower(), approval["spender_address"].lower())
                if pair in seen_pairs:
                    continue
                seen_pairs.add(pair)
                if len(current_allowances) >= 50:
                    allowance_checks_truncated = True
                    continue
                allowance_raw = None
                if proxy.get("rpc_chain_verified") and config["rpc"]:
                    try:
                        allowance_raw = _read_current_erc20_allowance(
                            config["rpc"], approval["token_contract_address"], owner, approval["spender_address"]
                        )
                    except Exception:
                        allowance_raw = None
                current_allowances.append({
                    "token_contract_address": approval["token_contract_address"],
                    "spender_address": approval["spender_address"],
                    "current_allowance_raw": allowance_raw,
                    "status": "verified_zero" if allowance_raw == "0" else (
                        "verified_nonzero" if allowance_raw is not None else "not_verified"
                    ),
                })

            allowance_lookup = {
                (entry["token_contract_address"].lower(), entry["spender_address"].lower()): entry
                for entry in current_allowances
            }
            for approval in approvals:
                current = allowance_lookup.get((approval["token_contract_address"].lower(), approval["spender_address"].lower()))
                approval["current_allowance_raw"] = current["current_allowance_raw"] if current else None
                approval["current_allowance_status"] = current["status"] if current else "not_checked"

            address_results.append({
                "address": owner,
                "label": item["label"],
                "ownership_verified": True,
                "delegation": proxy,
                "token_transfers": transfers,
                "approvals": approvals,
                "current_allowance_checks": current_allowances,
                "allowance_checks_truncated": allowance_checks_truncated,
                "pagination": {
                    "page": page, "page_size": offset,
                    "token_transfers_has_more": transfer_has_more,
                    "approval_from_block": approval_from_block,
                    "approval_to_block": approval_to_block,
                    "approval_logs_truncated": approval_logs_truncated,
                    "approval_last_block": approval_last_block,
                    "has_more": transfer_has_more,
                },
                "warnings": warnings,
            })

        scanned_networks.append({
            "network": network,
            "chain_id": config["chain_id"],
            "address_count": len(verified_addresses),
            "skipped_addresses": skipped,
            "addresses": address_results,
            "status": "scanned" if address_results else ("ownership_verification_required" if skipped else "no_attached_address"),
        })

    return {
        "scope": "Authenticated active wallet; signature-verified EVM addresses only",
        "read_only": True,
        "secrets_exposed": False,
        "page": page,
        "page_size": offset,
        "networks": scanned_networks,
        "provider_limits": {
            "token_transfers": "Etherscan account/tokentx may return only the last 10,000 records for an address; page through available results and use an independent indexer for older completeness guarantees.",
            "approval_logs": "Etherscan logs/getLogs returns at most 1,000 matching logs per query; narrow the block range and rescan when the cap is reached.",
        },
        "claim_readiness": {
            "claim_execution_enabled": False,
            "claimable_balmz_amount": None,
            "status": "not_established",
            "reason": "Token transfers and ERC-20 approvals are not proof of an unclaimed BALMZ allocation. No verified network-specific BALMZ claim contract, allocation registry, issuer authorization, and replay-protected batch-claim interface are configured for this wallet.",
            "next_requirement": "Verify the canonical BALMZ claim contract and allocation records on each network before enabling a wallet-signed claim.",
        },
        "warning": "EIP-7702 delegation, ERC-20 allowances, and BALMZ claim eligibility are separate checks. No transaction was signed, broadcast, or credited.",
    }


@app.get("/api/v1/auth/me")
def auth_me(user: dict = Depends(current_user)):
    return {"user":user,"mode":"neon_auth" if NEON_JWKS_CLIENT else "database"}




def _decode_eip7702_designator(code: str):
    """Return the delegated implementation from an EIP-7702 designator, if present."""
    value = str(code or "").lower()
    if re.fullmatch(r"0xef0100[0-9a-f]{40}", value):
        return "0x" + value[8:]
    return None


def _decode_okx_storage_proxy(code: str):
    """Decode the 77-byte OKX-style minimal proxy only when its full byte pattern matches."""
    value = str(code or "").lower()
    prefix = "0x363d3d373d3d3d363d73"
    middle = "5af43d82803e903d91602b57fd5bf3"
    owner_prefix = "000000000000000000000000"
    if len(value) != 2 + 77 * 2 or not value.startswith(prefix):
        return None
    implementation = "0x" + value[len(prefix):len(prefix) + 40]
    expected = prefix + implementation[2:] + middle + owner_prefix
    if not value.startswith(expected) or len(value) != len(expected) + 40:
        return None
    return {"implementation": implementation, "embedded_owner": "0x" + value[-40:]}


@app.get("/api/v1/wallet/erc7702-inspection")
def wallet_erc7702_inspection(user: dict = Depends(current_user)):
    """Read-only Ethereum Mainnet inspection of the active wallet's EIP-7702 delegation."""
    owner = wallet_network_address(user, "ethereum")
    if not owner or not re.fullmatch(r"0x[a-fA-F0-9]{40}", str(owner)):
        raise HTTPException(status_code=404, detail="No valid Ethereum Mainnet address is attached to the active wallet")
    if not ETH_RPC_URL:
        raise HTTPException(status_code=503, detail="Ethereum Mainnet RPC is not configured")
    try:
        chain_id = require_ethereum_mainnet_rpc(ETH_RPC_URL)
        owner_code = rpc_call(ETH_RPC_URL, "eth_getCode", [owner, "latest"])
        delegation_target = _decode_eip7702_designator(owner_code)
    except Exception as exc:
        logger.warning("ERC-7702 inspection failed: %s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Ethereum Mainnet RPC could not complete the read-only wallet inspection")

    if not delegation_target:
        return {
            "network": "ethereum", "chain_id": chain_id, "owner_address": owner,
            "delegated": False, "delegation_target": None,
            "delegation_target_code_bytes": None, "known_okx_walletcore": False,
            "storage": {"status": "not_checked", "address": None, "proxy": None},
            "inspection": "Wallet has no EIP-7702 delegation designator at the latest block.",
        }

    known_walletcore = {"0x80296ff8d1ed46f8e3c7992664d13b833504c2bb"}
    known_storage_implementations = {"0x7daf91dfe55fcab363416a6e3bceb3da34ff1d30"}
    try:
        target_code = rpc_call(ETH_RPC_URL, "eth_getCode", [delegation_target, "latest"])
        target_code_bytes = max(0, (len(target_code or "0x") - 2) // 2)
    except Exception:
        target_code_bytes = None

    storage = {"status": "unavailable", "address": None, "proxy": None}
    selector_hash = keccak.new(digest_bits=256)
    selector_hash.update(b"getMainStorage()")
    selector = "0x" + selector_hash.digest()[:4].hex()
    try:
        storage_result = rpc_call(ETH_RPC_URL, "eth_call", [{"to": owner, "data": selector}, "latest"])
        if isinstance(storage_result, str) and re.fullmatch(r"0x[0-9a-fA-F]{64}", storage_result):
            storage_address = "0x" + storage_result[-40:]
            if int(storage_address[2:], 16) == 0:
                storage = {"status": "zero_address", "address": None, "proxy": None}
            else:
                storage_code = rpc_call(ETH_RPC_URL, "eth_getCode", [storage_address, "latest"])
                proxy = _decode_okx_storage_proxy(storage_code)
                if storage_code == "0x":
                    storage_status = "no_code"
                elif proxy:
                    storage_status = "proxy_detected"
                else:
                    storage_status = "contract_detected_unclassified"
                storage = {
                    "status": storage_status, "address": storage_address,
                    "code_bytes": max(0, (len(storage_code) - 2) // 2), "proxy": proxy,
                    "implementation_known_okx": bool(proxy and proxy["implementation"].lower() in known_storage_implementations),
                    "embedded_owner_matches": bool(proxy and proxy["embedded_owner"].lower() == owner.lower()),
                }
        else:
            storage = {"status": "unexpected_return_data", "address": None, "proxy": None}
    except Exception as exc:
        storage = {"status": "call_unavailable", "address": None, "proxy": None, "reason": type(exc).__name__}

    return {
        "network": "ethereum", "chain_id": chain_id, "owner_address": owner,
        "delegated": True, "delegation_target": delegation_target,
        "delegation_target_code_bytes": target_code_bytes,
        "known_okx_walletcore": delegation_target.lower() in known_walletcore,
        "storage": storage,
        "inspection": "Read-only chain inspection. A recognized implementation address does not prove who authorized the delegation or establish wallet security.",
    }


@app.get("/api/v1/wallet")
def wallet(user: dict = Depends(current_user)):
    assets,_,summary = wallet_snapshot(user)
    return {"user":user,"wallet":{**summary,"wallet_id":user["wallet_id"],"wallet_number":user.get("wallet_number"),"owner_id":user["id"]},"assets":assets}


@app.get("/api/v1/wallet/addresses")
def wallet_addresses(user: dict = Depends(current_user)):
    addresses = configured_addresses(user)
    return {"addresses": addresses, "configured": bool(addresses), "message": None if addresses else "No production wallet address is configured yet"}


@app.get("/api/v1/wallet/reconciliation")
def wallet_reconciliation(user: dict = Depends(current_user)):
    return wallet_reconciliation_snapshot(user)


@app.get("/api/v1/wallet/audit")
def wallet_audit(limit: int = 50, offset: int = 0, user: dict = Depends(current_user)):
    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    with db() as conn:
        total = conn.execute(
            "SELECT COUNT(*) FROM wallet_audit_events WHERE owner_id=%s AND wallet_id=%s",
            (user["id"], user["wallet_id"]),
        ).fetchone()[0]
        rows = conn.execute(
            """
            SELECT id,action,resource,resource_id,network,reference,details,created_at
            FROM wallet_audit_events
            WHERE owner_id=%s AND wallet_id=%s
            ORDER BY created_at DESC LIMIT %s OFFSET %s
            """,
            (user["id"], user["wallet_id"], limit, offset),
        ).fetchall()
    return {
        "events": [
            {
                "id": row[0], "action": row[1], "resource": row[2],
                "resource_id": row[3], "network": row[4], "reference": row[5],
                "details": row[6], "created_at": row[7].isoformat() if row[7] else None,
            }
            for row in rows
        ],
        "pagination": {
            "limit": limit, "offset": offset, "total": int(total),
            "has_more": offset + len(rows) < int(total),
        },
    }


@app.get("/api/v1/wallet/nfts")
def wallet_nfts(network: str = "ethereum", user: dict = Depends(current_user)):
    """Read the active wallet's NFTs using Alchemy; never fabricates empty holdings."""
    normalized_network = str(network or "").strip().lower()
    hosts = {"ethereum": "eth-mainnet", "bnb": "bnb-mainnet"}
    if normalized_network not in hosts:
        raise HTTPException(status_code=400, detail="NFT lookup currently supports Ethereum and BNB Chain mainnet only")
    owner_address = wallet_network_address(user, normalized_network)
    if not owner_address:
        raise HTTPException(status_code=404, detail=f"No {normalized_network} public address is attached to the active wallet")
    if not ALCHEMY_API_KEY:
        raise HTTPException(status_code=503, detail="NFT indexing is not configured. Set ALCHEMY_API_KEY on the backend.")
    url = f"https://{hosts[normalized_network]}.g.alchemy.com/nft/v3/{ALCHEMY_API_KEY}/getNFTsForOwner"
    try:
        response = httpx.get(url, params={"owner": owner_address, "withMetadata": "true", "pageSize": 100}, timeout=12)
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="NFT provider timed out. Retry the read-only lookup.") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="NFT provider could not be reached.") from exc
    if response.status_code in (401, 403):
        raise HTTPException(status_code=503, detail="The configured NFT provider key is invalid or lacks NFT API access.")
    if response.status_code == 429:
        raise HTTPException(status_code=503, detail="NFT provider rate limit reached. Retry later.")
    if response.is_error:
        raise HTTPException(status_code=502, detail=f"NFT provider returned HTTP {response.status_code}.")
    try:
        payload = response.json()
        source_items = payload.get("ownedNfts", []) if isinstance(payload, dict) else []
        nfts = []
        for item in source_items if isinstance(source_items, list) else []:
            if not isinstance(item, dict):
                continue
            contract = item.get("contract") if isinstance(item.get("contract"), dict) else {}
            image = item.get("image") if isinstance(item.get("image"), dict) else {}
            image_url = image.get("cachedUrl") or image.get("thumbnailUrl") or image.get("originalUrl") or ""
            if not str(image_url).startswith("https://"):
                image_url = ""
            nfts.append({
                "name": str(item.get("name") or item.get("title") or "Unnamed NFT")[:160],
                "description": str(item.get("description") or "")[:500],
                "token_id": str(item.get("tokenId") or ""),
                "contract_address": str(contract.get("address") or ""),
                "collection": str(contract.get("name") or contract.get("symbol") or "")[:160],
                "image_url": image_url,
                "token_type": str(item.get("tokenType") or ""),
            })
    except (ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(status_code=502, detail="NFT provider returned an invalid collection response.") from exc
    return {
        "network": normalized_network,
        "owner_address": owner_address,
        "source": "Alchemy NFT API",
        "nft_count": len(nfts),
        "nfts": nfts,
        "has_more": bool(payload.get("pageKey")) if isinstance(payload, dict) else False,
        "notice": "Read-only collection data. Images and metadata are supplied by the NFT provider and may be incomplete.",
    }


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
                if network == "ethereum":
                    require_ethereum_mainnet_rpc(url)
                elif network == "bnb":
                    require_bnb_rpc(url)
                elif network == "sepolia":
                    require_sepolia_rpc(url)
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
    if network == "bnb" and symbol in {"USDT", "USDC", "BALMZ"}:
        return f"{symbol}-BNB"
    if network == "sepolia" and symbol == "BALMZ":
        return "BALMZ-SEP"
    return symbol


def wallet_sync_token_rows(registry_rows, ethereum_address: str | None = None, bnb_address: str | None = None):
    """Add known token contracts to read-only sync when registry metadata is pending.

    BALMZ is deliberately included only when its exact chain-specific contract
    is configured. No address or balance is invented. Decimals for EVM mainnet
    contracts are always read and validated against the selected chain at sync time.
    """
    rows = list(registry_rows or [])
    known = {
        (str(row[0]).upper(), str(row[2]).strip().lower())
        for row in rows if len(row) >= 3
    }

    ethereum_usdt_contract = USDT_ETH_CONTRACT or ETHEREUM_USDT_MAINNET_CONTRACT
    if ethereum_address and ethereum_usdt_contract and ("USDT", "ethereum") not in known:
        rows.append(("USDT", "Tether USD", "ethereum", ethereum_usdt_contract, 6, "active"))
        known.add(("USDT", "ethereum"))

    if ethereum_address and BALMZ_ETH_CONTRACT and ("BALMZ", "ethereum") not in known:
        rows.append(("BALMZ", "BALMZ Token", "ethereum", BALMZ_ETH_CONTRACT, None, "active"))
        known.add(("BALMZ", "ethereum"))

    if bnb_address and USDT_BSC_CONTRACT and ("USDT", "bnb") not in known:
        rows.append(("USDT", "Tether USD", "bnb", USDT_BSC_CONTRACT, None, "active"))
        known.add(("USDT", "bnb"))

    if bnb_address and BALMZ_BNB_CONTRACT and ("BALMZ", "bnb") not in known:
        rows.append(("BALMZ", "BALMZ Token", "bnb", BALMZ_BNB_CONTRACT, None, "active"))
        known.add(("BALMZ", "bnb"))

    return rows


def _sync_wallet_impl(user: dict, *, include_transactions: bool = True):
    eth_address = wallet_network_address(user, "ethereum")
    bnb_address = wallet_network_address(user, "bnb")
    btc_address = wallet_network_address(user, "bitcoin")
    sepolia_address = wallet_network_address(user, "sepolia")
    solana_mainnet_address = wallet_network_address(user, "solana_mainnet")
    solana_address = wallet_network_address(user, "solana_devnet")
    if not btc_address and not eth_address and not bnb_address and not sepolia_address and not solana_mainnet_address and not solana_address:
        raise HTTPException(status_code=503, detail="No wallet address is configured")

    updates = []
    warnings = []
    asset_upserts = []
    asset_balance_updates = []

    # Read registry metadata and release the database connection before any RPC
    # call. Public blockchain providers can take seconds or time out entirely.
    with db() as conn:
        token_rows = conn.execute(
            "SELECT symbol,name,network,contract_address,decimals,status "
            "FROM token_registry WHERE contract_address IS NOT NULL "
            "AND decimals IS NOT NULL AND status='active' ORDER BY symbol,network"
        ).fetchall()
    token_rows = wallet_sync_token_rows(token_rows, eth_address, bnb_address)

    if solana_mainnet_address:
        try:
            require_solana_rpc_cluster(SOLANA_MAINNET_RPC_URL, SOLANA_MAINNET_GENESIS_HASH, "Solana Mainnet")
            raw_sol = rpc_call(SOLANA_MAINNET_RPC_URL, "getBalance", [solana_mainnet_address, {"commitment": "confirmed"}])
            sol_balance = int((raw_sol or {}).get("value", 0)) / 1_000_000_000
            asset_upserts.append(("SOL", "Solana (Mainnet)", sol_balance))
            updates.append({"network":"solana_mainnet","asset":"SOL","balance":sol_balance})
        except Exception:
            warnings.append("Solana Mainnet balance service unavailable")

    if btc_address:
        try:
            btc = btc_balance(btc_address)
            if btc is not None:
                asset_balance_updates.append((btc, "BTC"))
                updates.append({"network":"bitcoin","asset":"BTC","balance":btc})
        except Exception:
            warnings.append("Bitcoin balance service unavailable")

    if solana_address and SOLANA_DEVNET_RPC_URL:
        try:
            require_solana_rpc_cluster(SOLANA_DEVNET_RPC_URL, SOLANA_DEVNET_GENESIS_HASH, "Solana Devnet")
            raw_sol = rpc_call(SOLANA_DEVNET_RPC_URL, "getBalance", [solana_address, {"commitment": "confirmed"}])
            sol_balance = int((raw_sol or {}).get("value", 0)) / 1_000_000_000
            asset_upserts.append(("SOL-DEVNET", "Solana Devnet SOL", sol_balance))
            # Devnet SOL is stored separately and never clears or overwrites Mainnet SOL.
            updates.append({"network":"solana-devnet","asset":"SOL-DEVNET","balance":sol_balance})
        except Exception:
            warnings.append("Solana Devnet balance service unavailable")
    elif solana_address:
        warnings.append("Solana Devnet RPC is not configured; SOL balance sync skipped")

    if solana_address:
        try:
            balmz_balance = solana_spl_token_balance(solana_address)
            asset_upserts.append(("BALMZ-SOL-DEVNET", "BALMZ Token (Solana Devnet)", balmz_balance))
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
            asset_balance_updates.append((eth, "ETH"))
            updates.append({"network":"ethereum","asset":"ETH","balance":eth})
        except Exception:
            warnings.append("Ethereum balance service unavailable")

    if BSC_RPC_URL and bnb_address:
        try:
            require_bnb_rpc(BSC_RPC_URL)
            bnb = evm_balance(BSC_RPC_URL, bnb_address)
            asset_balance_updates.append((bnb, "BNB"))
            updates.append({"network":"bnb","asset":"BNB","balance":bnb})
        except Exception as exc:
            logger.warning("BNB Chain balance synchronization failed: error_type=%s", type(exc).__name__)
            warnings.append("BNB Chain balance service unavailable")

    # Token decimals and balances are resolved from the verified chain outside
    # the database lease. In particular, BNB decimals are never taken from the
    # potentially stale token_registry value.
    for symbol, name, network, contract, decimals, status in token_rows:
        rpc_url = ETH_RPC_URL if network == "ethereum" else BSC_RPC_URL if network == "bnb" else SEPOLIA_RPC_URL if network == "sepolia" else None
        token_address = eth_address if network == "ethereum" else bnb_address if network == "bnb" else sepolia_address if network == "sepolia" else None
        if not rpc_url or not token_address:
            continue
        try:
            if network == "ethereum":
                require_ethereum_mainnet_rpc(rpc_url)
                resolved_decimals = verified_erc20_decimals(rpc_url, contract, network, chain_checked=True)
            elif network == "sepolia":
                require_sepolia_rpc(rpc_url)
                resolved_decimals = int(decimals)
            elif network == "bnb":
                require_bnb_rpc(rpc_url)
                resolved_decimals = verified_erc20_decimals(rpc_url, contract, network, chain_checked=True)
            else:
                resolved_decimals = int(decimals)
            balance = erc20_balance(rpc_url, contract, token_address, resolved_decimals)
            if balance is None:
                continue
            asset_symbol = wallet_asset_symbol(symbol, network)
            asset_name = f"{name} (BNB Chain)" if asset_symbol.endswith("-BNB") else name
            asset_upserts.append((asset_symbol, asset_name, balance))
            updates.append({
                "network":network,
                "asset":asset_symbol,
                "balance":balance,
                "contract_address":contract,
                "decimals":resolved_decimals,
            })
        except Exception:
            warnings.append(f"{network} {symbol} token balance service unavailable")

    # Apply only the successfully observed chain values in a short transaction.
    # No HTTP/RPC requests are permitted while this connection is held.
    if asset_upserts or asset_balance_updates:
        with db() as conn:
            for symbol, name, balance in asset_upserts:
                conn.execute(
                    "INSERT INTO assets(wallet_id,symbol,name,balance,price_usd) VALUES(%s,%s,%s,%s,0) "
                    "ON CONFLICT(wallet_id,symbol) DO UPDATE SET balance=EXCLUDED.balance,name=EXCLUDED.name",
                    (user["wallet_id"], symbol, name, balance),
                )
            for balance, symbol in asset_balance_updates:
                conn.execute(
                    "UPDATE assets SET balance=%s WHERE wallet_id=%s AND symbol=%s",
                    (balance, user["wallet_id"], symbol),
                )
            conn.commit()

    imported_transactions = []
    evm_transactions = []
    if include_transactions:
        imported_transactions = sync_bitcoin_transactions(user, btc_address)
        evm_warnings = []
        native_sources = (
            (ETH_RPC_URL, "ethereum", eth_address),
            (BSC_RPC_URL, "bnb", bnb_address),
            (SEPOLIA_RPC_URL, "sepolia", sepolia_address),
        )
        for rpc_url, network, network_address in native_sources:
            if rpc_url and network_address:
                native_imported, native_warning = sync_evm_native_transactions(user, rpc_url, network, network_address)
                evm_transactions.extend(native_imported)
                if native_warning:
                    evm_warnings.append(native_warning)

        token_sources = (
            (ETH_RPC_URL, "ethereum", eth_address, USDT_ETH_CONTRACT or ETHEREUM_USDT_MAINNET_CONTRACT, "USDT"),
            (ETH_RPC_URL, "ethereum", eth_address, BALMZ_ETH_CONTRACT, "BALMZ"),
            (BSC_RPC_URL, "bnb", bnb_address, USDT_BSC_CONTRACT, "USDT-BNB"),
            (BSC_RPC_URL, "bnb", bnb_address, BALMZ_BNB_CONTRACT, "BALMZ-BNB"),
            (SEPOLIA_RPC_URL, "sepolia", sepolia_address, BALMZ_SEPOLIA_CONTRACT, "BALMZ-SEP"),
        )
        for rpc_url, network, network_address, contract, token_symbol in token_sources:
            if not rpc_url or not network_address or not contract:
                continue
            token_imported, warning = sync_evm_token_transactions(
                user, rpc_url, network, contract, token_symbol, wallet_address=network_address,
                decimals=18 if token_symbol.startswith("BALMZ") else 6,
            )
            evm_transactions.extend(token_imported)
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
    return {
        "status":"synced_with_warnings" if warnings else "synced",
        "wallet":{**summary,"wallet_id":user["wallet_id"],"owner_id":user["id"]},
        "assets":assets,
        "updates":updates,
        "warnings":warnings,
        "bitcoin_transactions":imported_transactions,
        "evm_transactions":evm_transactions,
        "transactions":all_transactions,
        "network_status":network_status,
        "last_balance_sync_at":last_balance_sync_at,
        "last_transaction_sync_at":last_transaction_sync_at,
    }

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

    with ThreadPoolExecutor(max_workers=2) as pool:
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


def _verify_balmz_solana_mainnet_mint(mint_address: str | None) -> dict:
    """Verify token identity and observed supply on Solana Mainnet without signing or moving funds."""
    result = {
        "production_mint_verified": False,
        "supply_matches_target": False,
        "mint_authority_revoked": False,
        "freeze_authority_revoked": False,
        "observed_supply": None,
        "warnings": [],
    }
    if not mint_address:
        result["warnings"].append("Production BALMZ-SOL mint could not be verified because it is not configured.")
        return result
    if not valid_solana_address(mint_address):
        result["warnings"].append("Production BALMZ-SOL mint could not be verified because its address format is invalid.")
        return result

    try:
        require_solana_rpc_cluster(SOLANA_MAINNET_RPC_URL, SOLANA_MAINNET_GENESIS_HASH, "Solana Mainnet")
        account_response = rpc_call(
            SOLANA_MAINNET_RPC_URL,
            "getAccountInfo",
            [mint_address, {"encoding": "jsonParsed", "commitment": "finalized"}],
        )
        account = account_response.get("value") if isinstance(account_response, dict) else None
        if not isinstance(account, dict):
            result["warnings"].append("Production BALMZ-SOL mint could not be verified because the account was not found on Solana Mainnet.")
            return result

        data = account.get("data", {})
        parsed = data.get("parsed", {}) if isinstance(data, dict) else {}
        info = parsed.get("info", {}) if isinstance(parsed, dict) else {}
        valid_spl_mint = (
            account.get("owner") == SOLANA_SPL_TOKEN_PROGRAM_ID
            and isinstance(parsed, dict)
            and parsed.get("type") == "mint"
            and isinstance(info, dict)
            and info.get("decimals") == BALMZ_SOLANA_DEVNET_DECIMALS
        )
        if not valid_spl_mint:
            result["warnings"].append("Production BALMZ-SOL mint could not be verified as a 9-decimal SPL Token mint on Solana Mainnet.")
            return result

        # This boolean confirms the address, program, and network. Supply and authorities
        # remain separate readiness checks so the UI can explain exactly what still fails.
        result["production_mint_verified"] = True
        result["mint_authority_revoked"] = info.get("mintAuthority") is None
        result["freeze_authority_revoked"] = info.get("freezeAuthority") is None

        supply_response = rpc_call(
            SOLANA_MAINNET_RPC_URL,
            "getTokenSupply",
            [mint_address, {"commitment": "finalized"}],
        )
        supply_info = supply_response.get("value", {}) if isinstance(supply_response, dict) else {}
        raw_amount = supply_info.get("amount")
        if isinstance(raw_amount, str) and raw_amount.isdigit() and supply_info.get("decimals") == BALMZ_SOLANA_DEVNET_DECIMALS:
            observed = Decimal(raw_amount) / (Decimal(10) ** BALMZ_SOLANA_DEVNET_DECIMALS)
            result["observed_supply"] = int(observed) if observed == observed.to_integral_value() else float(observed)
            result["supply_matches_target"] = raw_amount == str(BALMZ_TARGET_SUPPLY * (10 ** BALMZ_SOLANA_DEVNET_DECIMALS))

        if not result["supply_matches_target"]:
            result["warnings"].append("Observed Mainnet token supply does not match the 1,000,000,000-token target.")
        if not result["mint_authority_revoked"]:
            result["warnings"].append("The production mint authority is still enabled; fixed supply is not enforced.")
        if not result["freeze_authority_revoked"]:
            result["warnings"].append("The production freeze authority is still enabled; review this control before launch.")
    except Exception as exc:
        logger.warning("BALMZ Mainnet mint verification unavailable: error_type=%s", type(exc).__name__)
        result["warnings"].append("Production BALMZ-SOL mint could not be verified on Solana Mainnet.")
    return result


def _verify_balmz_presale_receiver(address: str | None) -> dict:
    """Read-only check of the configured treasury address on Solana Mainnet."""
    result = {
        "address_format_valid": bool(address and valid_solana_address(address)),
        "mainnet_rpc_verified": False,
        "account_exists": False,
        "balance_sol": None,
        "has_positive_sol_balance": False,
        "warnings": [],
    }
    if not address:
        result["warnings"].append("No presale receiving address is configured.")
        return result
    if not result["address_format_valid"]:
        result["warnings"].append("The configured presale receiving address has an invalid Solana public-key format.")
        return result

    try:
        require_solana_rpc_cluster(SOLANA_MAINNET_RPC_URL, SOLANA_MAINNET_GENESIS_HASH, "Solana Mainnet")
        balance_response = rpc_call(
            SOLANA_MAINNET_RPC_URL,
            "getBalance",
            [address, {"commitment": "finalized"}],
        )
        lamports = balance_response.get("value") if isinstance(balance_response, dict) else None
        if not isinstance(lamports, int) or isinstance(lamports, bool) or lamports < 0:
            raise ValueError("Solana Mainnet returned an invalid treasury balance")
        result["mainnet_rpc_verified"] = True
        result["balance_sol"] = float(Decimal(lamports) / Decimal(1_000_000_000))
        result["has_positive_sol_balance"] = lamports > 0

        account_response = rpc_call(
            SOLANA_MAINNET_RPC_URL,
            "getAccountInfo",
            [address, {"encoding": "base64", "commitment": "finalized"}],
        )
        account = account_response.get("value") if isinstance(account_response, dict) else None
        result["account_exists"] = isinstance(account, dict)
        if not result["account_exists"]:
            result["warnings"].append("The configured receiving address has no on-chain account at the time of this check.")
        if not result["has_positive_sol_balance"]:
            result["warnings"].append("The configured receiving address has no positive SOL balance; verify the intended treasury address before using it.")
    except Exception as exc:
        logger.warning("BALMZ Mainnet treasury check unavailable: error_type=%s", type(exc).__name__)
        result["warnings"].append("The presale receiving address balance could not be verified against Solana Mainnet.")
    return result


@app.get("/api/v1/balmz/presale/status")
def balmz_presale_status(user: dict = Depends(current_user)):
    """Return launch readiness truthfully; no payment or transfer is initiated by this endpoint."""
    configured_mint = BALMZ_SOLANA_MAINNET_MINT if valid_solana_address(BALMZ_SOLANA_MAINNET_MINT) else None
    receiver_status = _verify_balmz_presale_receiver(BALMZ_PRESALE_RECEIVING_ADDRESS)
    recipient_is_valid = receiver_status["address_format_valid"]
    mint_status = _verify_balmz_solana_mainnet_mint(configured_mint)
    readiness = {
        "production_mint_verified": mint_status["production_mint_verified"],
        "supply_matches_target": mint_status["supply_matches_target"],
        "mint_authority_revoked": mint_status["mint_authority_revoked"],
        "freeze_authority_revoked": mint_status["freeze_authority_revoked"],
        "receiving_address_configured": recipient_is_valid,
        "receiving_address_mainnet_verified": receiver_status["mainnet_rpc_verified"],
        "receiving_address_account_exists": receiver_status["account_exists"],
        "receiving_address_has_positive_sol_balance": receiver_status["has_positive_sol_balance"],
        # Intentionally false: an authenticated, replay-protected settlement endpoint is not implemented.
        "payment_verification_implemented": False,
        # A token price target alone is not a liquidity or market-making mechanism.
        "liquidity_mechanism_configured": False,
        # CI status is not inferred from runtime settings.
        "regression_suite_verified": False,
    }
    warnings = list(mint_status["warnings"]) + list(receiver_status["warnings"])
    if recipient_is_valid:
        warnings.append("On-chain balance checks do not prove that the founder controls the receiving wallet; verify ownership before accepting funds.")
    warnings.extend([
        "Presale payment acceptance remains disabled; confirmed, replay-protected settlement is not implemented.",
        "The launch target of 1 BALMZ-SOL = 1 SOL is not a guaranteed market price and needs a disclosed liquidity mechanism.",
        "Complete production readiness checks and regression tests before opening the presale.",
    ])
    return {
        "token": "BALMZ-SOL",
        "project": "World Wallet AI",
        "stage": "planning",
        "presale_price_usd": float(BALMZ_PRESALE_PRICE_USD),
        "presale_price_unit": "USD per token",
        "target_supply": BALMZ_TARGET_SUPPLY,
        "target_decimals": BALMZ_SOLANA_DEVNET_DECIMALS,
        "launch_target": "1 BALMZ-SOL = 1 SOL",
        "launch_price_guaranteed": False,
        "payment_acceptance_enabled": False,
        "production_network": "solana_mainnet",
        "production_mint": configured_mint,
        "devnet_mint": BALMZ_SOLANA_DEVNET_MINT,
        "devnet_mint_is_test_only": True,
        "recipient_address_configured": recipient_is_valid,
        "receiving_address_configured": recipient_is_valid,
        "presale_receiving_address": BALMZ_PRESALE_RECEIVING_ADDRESS if recipient_is_valid else None,
        "presale_receiving_address_mainnet_verified": receiver_status["mainnet_rpc_verified"],
        "presale_receiving_address_account_exists": receiver_status["account_exists"],
        "presale_receiving_balance_sol": receiver_status["balance_sol"],
        "presale_receiving_address_has_positive_sol_balance": receiver_status["has_positive_sol_balance"],
        "observed_supply": mint_status["observed_supply"],
        "readiness": readiness,
        "warnings": list(dict.fromkeys(warnings)),
        "transaction_scope": {
            "presale_payments": "disabled until production mint, receiving address, and replay-protected payment verification are verified",
            "mainnet_transactions": "must be confirmed at finalized commitment on the Solana Mainnet genesis hash",
            "devnet_transactions": "testing evidence only; excluded from production balances, presale settlement, and reserves",
            "proof_of_reserves": "must use independently verified production on-chain balances; transaction history is not proof of reserves",
        },
        "notice": "Planning only. Do not send funds. Presale payments are disabled; this endpoint only reports readiness and never accepts, moves, or settles funds.",
    }


# Serialize cache misses: concurrent dashboard panels share one provider refresh
# rather than each spawning a separate provider request burst.
_MARKET_PRICE_REFRESH_LOCK = Lock()


@app.get("/api/v1/prices/market")
def market_prices():
    """Public market quotes for the wallet's supported coin catalog."""
    global _MARKET_PRICE_CACHE
    cached = _MARKET_PRICE_CACHE.fresh_response(max_age_seconds=60)
    if cached is not None:
        return cached
    with _MARKET_PRICE_REFRESH_LOCK:
        # Re-check after acquiring the lock because another request may have
        # populated the cache while this request waited.
        cached = _MARKET_PRICE_CACHE.fresh_response(max_age_seconds=60)
        if cached is not None:
            return cached
        coin_ids = {
            "BTC":"bitcoin","USDT":"tether","USDT-BNB":"tether","ETH":"ethereum","BNB":"binancecoin",
            "USDC":"usd-coin","SOL":"solana","XRP":"ripple","ADA":"cardano",
            "LTC":"litecoin","DOGE":"dogecoin",
        }
        try:
            api_key, base_url = _active_coingecko_config()
            response = httpx.get(
                f"{base_url}/simple/price",
                params={
                    "ids": ",".join(coin_ids.values()),
                    "vs_currencies": "usd",
                    "include_24hr_change": "true",
                },
                headers=coingecko_headers(api_key, base_url),
                timeout=httpx.Timeout(8.0, connect=3.0),
            )
            response.raise_for_status()
            raw = response.json()
        except Exception as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            logger.warning("CoinGecko market-price request failed: error_type=%s status=%s",
                           type(exc).__name__, status)
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
        for alias, source in (("USDT-BNB", "USDT"), ("USDC-BNB", "USDC")):
            if source in prices:
                prices[alias] = dict(prices[source])
        prices["BALMZ"] = {"usd": None, "usd_24h_change": None, "listed": False,
                           "eth_reference_usd": prices.get("ETH", {}).get("usd")}
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
        market_prices["USDT-BNB"] = market_prices["USDT"]
        market_prices["USDC-BNB"] = market_prices["USDC"]
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



def require_world_wallet_admin(user):
    """Protect administrative data with the explicitly configured owner identity."""
    email = str((user or {}).get("email") or "").strip().lower()
    configured_email = WORLD_WALLET_ADMIN_EMAIL.strip().lower()
    if not configured_email:
        raise HTTPException(status_code=503, detail="Set WORLD_WALLET_ADMIN_EMAIL in the backend environment before using the admin console")
    if email != configured_email:
        raise HTTPException(status_code=403, detail="This account is not the configured World Wallet AI administrator")
    if not DATABASE_URL:
        raise HTTPException(status_code=503, detail="The admin console requires the production database")
    return email


def record_admin_event(user, action: str, details: str = ""):
    """Persist a minimal audit record; never store secrets or request payloads."""
    event_id = "adm_" + secrets.token_urlsafe(18)
    with db() as conn:
        conn.execute(
            "INSERT INTO admin_audit_events(id,actor_user_id,actor_email,action,details) VALUES(%s,%s,%s,%s,%s)",
            (event_id, user["id"], str(user.get("email") or "").strip().lower(), action[:80], details[:240]),
        )
        conn.commit()


@app.get("/api/v1/announcement")
def get_wallet_announcement(user: dict = Depends(current_user)):
    with db() as conn:
        row = conn.execute(
            "SELECT title,body,enabled,updated_at FROM wallet_announcements WHERE id=1"
        ).fetchone()
    if not row or not row[2]:
        return {"announcement": None}
    return {"announcement": {"title": row[0], "body": row[1], "enabled": bool(row[2]), "updated_at": row[3].isoformat() if row[3] else None}}


@app.get("/api/v1/admin/overview")
def admin_overview(user: dict = Depends(current_user)):
    require_world_wallet_admin(user)
    with db() as conn:
        counts = {
            "users": conn.execute("SELECT COUNT(*) FROM users").fetchone()[0],
            "wallets": conn.execute("SELECT COUNT(*) FROM wallets").fetchone()[0],
            "transactions": conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0],
            "requests": conn.execute("SELECT COUNT(*) FROM wallet_requests").fetchone()[0],
            "active_api_keys": conn.execute("SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL").fetchone()[0],
        }
    record_admin_event(user, "view_admin_overview")
    return {"counts": counts, "payments_enabled": False, "transaction_signing": "external_wallet_only"}


@app.get("/api/v1/admin/users")
def admin_users(q: str = "", limit: int = 50, offset: int = 0, user: dict = Depends(current_user)):
    require_world_wallet_admin(user)
    query = str(q or "").strip()[:100]
    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    where = ""
    params = []
    if query:
        where = "WHERE lower(u.email) LIKE lower(%s) OR lower(u.name) LIKE lower(%s)"
        pattern = "%" + query + "%"
        params.extend([pattern, pattern])
    with db() as conn:
        total = conn.execute("SELECT COUNT(*) FROM users u " + where, tuple(params)).fetchone()[0]
        rows = conn.execute(
            "SELECT u.id,u.name,u.email,u.created_at,COUNT(w.id) "
            "FROM users u LEFT JOIN wallets w ON w.owner_id=u.id " + where +
            " GROUP BY u.id,u.name,u.email,u.created_at ORDER BY u.created_at DESC LIMIT %s OFFSET %s",
            tuple(params + [limit, offset]),
        ).fetchall()
    record_admin_event(user, "view_admin_users", "count=" + str(len(rows)))
    return {"users": [
        {"id": row[0], "name": row[1], "email": row[2], "created_at": row[3].isoformat() if row[3] else None, "wallet_count": int(row[4])}
        for row in rows
    ], "total": int(total), "limit": limit, "offset": offset}


@app.get("/api/v1/admin/roles")
def admin_roles(user: dict = Depends(current_user)):
    require_world_wallet_admin(user)
    record_admin_event(user, "view_admin_role_policy")
    return {
        "model": "single_owner_allowlist",
        "owner_email": WORLD_WALLET_ADMIN_EMAIL.strip().lower(),
        "assignments_editable": False,
        "roles": [
            {"name": "Owner Admin", "source": "WORLD_WALLET_ADMIN_EMAIL", "description": "Only this explicitly configured account can access administrative endpoints."},
            {"name": "Standard User", "source": "default", "description": "All other authenticated accounts. No elevated permissions are implied."},
        ],
        "notice": "Role assignment is intentionally read-only until a persistent, audited RBAC policy is introduced. Do not grant admin access by changing client-side data.",
    }


@app.get("/api/v1/admin/settings")
def admin_settings(user: dict = Depends(current_user)):
    require_world_wallet_admin(user)
    checks = [
        {"key": "World Wallet admin email", "configured": bool(WORLD_WALLET_ADMIN_EMAIL)},
        {"key": "Alchemy NFT API key", "configured": bool(ALCHEMY_API_KEY)},
        {"key": "Etherscan API V2 key", "configured": bool(ETHERSCAN_API_KEY)},
        {"key": "Google Gemini API key", "configured": bool(GEMINI_API_KEY)},
        {"key": "PostgreSQL database", "configured": bool(DATABASE_URL)},
        {"key": "Neon Auth JWKS", "configured": bool(NEON_JWKS_CLIENT)},
        {"key": "Ethereum Mainnet RPC", "configured": bool(ETH_RPC_URL)},
        {"key": "BNB Chain Mainnet RPC", "configured": bool(BSC_RPC_URL)},
        {"key": "Bitcoin address", "configured": bool(BTC_ADDRESS)},
        {"key": "Solana Mainnet RPC", "configured": bool(SOLANA_MAINNET_RPC_URL)},
        {"key": "Solana Devnet RPC", "configured": bool(SOLANA_DEVNET_RPC_URL)},
        {"key": "CoinGecko server key", "configured": bool(COINGECKO_API_KEY)},
        {"key": "BALMZ Solana Mainnet mint", "configured": bool(BALMZ_SOLANA_MAINNET_MINT)},
    ]
    record_admin_event(user, "view_admin_settings")
    return {"checks": checks, "payments_enabled": False, "transaction_broadcast": "external_wallet_only", "secrets_exposed": False}


@app.post("/api/v1/admin/etherscan-provider/test")
def admin_test_etherscan_provider(user: dict = Depends(current_user)):
    """Test the backend Etherscan V2 key on supported EVM networks without exposing it."""
    require_world_wallet_admin(user)
    if not ETHERSCAN_API_KEY:
        raise HTTPException(status_code=503, detail="ETHERSCAN_API_KEY is not configured on the backend")

    probe_address = "0x000000000000000000000000000000000000dEaD"
    results = []
    for network, chain_id in ETHERSCAN_CHAIN_IDS.items():
        try:
            payload = etherscan_v2_request(
                chain_id, "account", "balance",
                {"address": probe_address, "tag": "latest"},
            )
            ok = str(payload.get("status")) == "1" and str(payload.get("result", "")).isdigit()
            results.append({
                "network": network,
                "chain_id": chain_id,
                "ok": ok,
                "message": "Etherscan API V2 responded successfully" if ok else "Etherscan API V2 rejected or could not complete the read-only probe",
            })
        except Exception as exc:
            logger.warning("Etherscan provider probe failed: network=%s error_type=%s", network, type(exc).__name__)
            results.append({
                "network": network,
                "chain_id": chain_id,
                "ok": False,
                "message": "Etherscan API V2 request failed; check key permissions, network support, and provider limits",
            })

    success = bool(results) and all(item["ok"] for item in results)
    record_admin_event(
        user,
        "test_etherscan_v2_provider",
        "success=" + str(success).lower() + "; networks=" + ",".join(item["network"] for item in results if item["ok"]),
    )
    return {
        "success": success,
        "key_configured": True,
        "api_version": "v2",
        "results": results,
        "read_only": True,
        "secrets_exposed": False,
        "notice": "Read-only balance probes use a fixed public address. No customer wallet, private key, or transaction signing request is involved.",
        "tested_at": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/api/v1/admin/nft-provider/test")
def admin_test_nft_provider(user: dict = Depends(current_user)):
    """Make read-only owner-lookup probes against Alchemy without exposing its key or wallet data."""
    require_world_wallet_admin(user)
    if not ALCHEMY_API_KEY:
        raise HTTPException(status_code=503, detail="ALCHEMY_API_KEY is not configured on the backend")

    probe_owner = "0x000000000000000000000000000000000000dEaD"
    results = []
    for network in ("eth-mainnet", "bnb-mainnet"):
        url = f"https://{network}.g.alchemy.com/nft/v3/{ALCHEMY_API_KEY}/getNFTsForOwner"
        try:
            response = httpx.get(
                url,
                params={"owner": probe_owner, "pageSize": 1, "withMetadata": "false"},
                timeout=12,
            )
        except httpx.TimeoutException:
            results.append({"network": network, "ok": False, "message": "Provider request timed out"})
            continue
        except httpx.HTTPError:
            results.append({"network": network, "ok": False, "message": "Provider could not be reached"})
            continue

        if response.status_code in (401, 403):
            results.append({"network": network, "ok": False, "message": "Alchemy rejected the configured key or its NFT API permissions"})
            continue
        if response.status_code == 429:
            results.append({"network": network, "ok": False, "message": "Alchemy rate limit reached"})
            continue
        if response.is_error:
            results.append({"network": network, "ok": False, "message": f"Alchemy returned HTTP {response.status_code}"})
            continue
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if not isinstance(payload, dict) or not isinstance(payload.get("ownedNfts"), list):
            results.append({"network": network, "ok": False, "message": "Alchemy returned an unexpected NFT API response"})
            continue
        results.append({
            "network": network,
            "ok": True,
            "message": "Alchemy NFT API responded successfully",
            "probe_items": len(payload["ownedNfts"]),
        })

    success = bool(results) and all(item["ok"] for item in results)
    record_admin_event(
        user,
        "test_alchemy_nft_provider",
        "success=" + str(success).lower() + "; networks=" + ",".join(item["network"] for item in results if item["ok"]),
    )
    return {
        "success": success,
        "key_configured": True,
        "results": results,
        "notice": "Read-only provider connectivity test using a fixed public probe address. No customer wallet address, key, NFT content or private data was requested or returned.",
        "tested_at": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/v1/admin/activity")
def admin_activity(limit: int = 50, user: dict = Depends(current_user)):
    require_world_wallet_admin(user)
    limit = max(1, min(int(limit), 100))
    with db() as conn:
        rows = conn.execute(
            "SELECT id,actor_email,action,details,created_at FROM admin_audit_events ORDER BY created_at DESC LIMIT %s",
            (limit,),
        ).fetchall()
    record_admin_event(user, "view_admin_activity")
    return {"events": [
        {"id": row[0], "actor_email": row[1], "action": row[2], "details": row[3], "created_at": row[4].isoformat() if row[4] else None}
        for row in rows
    ]}


@app.get("/api/v1/admin/wallet-audit")
def admin_wallet_audit(
    limit: int = 50,
    offset: int = 0,
    wallet_id: str | None = None,
    actor_email: str | None = None,
    user: dict = Depends(current_user),
):
    require_world_wallet_admin(user)
    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    clauses = []
    params = []
    if wallet_id and wallet_id.strip():
        clauses.append("e.wallet_id=%s")
        params.append(wallet_id.strip())
    if actor_email and actor_email.strip():
        clauses.append("lower(e.actor_email)=lower(%s)")
        params.append(actor_email.strip()[:254])
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    with db() as conn:
        total = conn.execute(
            "SELECT COUNT(*) FROM wallet_audit_events e" + where,
            tuple(params),
        ).fetchone()[0]
        rows = conn.execute(
            """
            SELECT e.id,e.actor_email,e.wallet_id,w.wallet_number,e.action,e.resource,
                   e.resource_id,e.network,e.reference,e.details,e.created_at
            FROM wallet_audit_events e
            JOIN wallets w ON w.id=e.wallet_id
            """ + where + " ORDER BY e.created_at DESC LIMIT %s OFFSET %s",
            tuple(params + [limit, offset]),
        ).fetchall()
    record_admin_event(user, "view_wallet_audit")
    return {
        "events": [
            {
                "id": row[0], "actor_email": row[1], "wallet_id": row[2],
                "wallet_number": str(row[3]), "action": row[4], "resource": row[5],
                "resource_id": row[6], "network": row[7], "reference": row[8],
                "details": row[9], "created_at": row[10].isoformat() if row[10] else None,
            }
            for row in rows
        ],
        "pagination": {
            "limit": limit, "offset": offset, "total": int(total),
            "has_more": offset + len(rows) < int(total),
        },
    }


@app.get("/api/v1/admin/announcement")
def admin_get_announcement(user: dict = Depends(current_user)):
    require_world_wallet_admin(user)
    with db() as conn:
        row = conn.execute("SELECT title,body,enabled,updated_at FROM wallet_announcements WHERE id=1").fetchone()
    record_admin_event(user, "view_admin_announcement")
    return {"announcement": {"title": row[0], "body": row[1], "enabled": bool(row[2]), "updated_at": row[3].isoformat() if row[3] else None} if row else {"title": "", "body": "", "enabled": False, "updated_at": None}}


@app.put("/api/v1/admin/announcement")
def admin_update_announcement(request: AdminAnnouncementUpdate, user: dict = Depends(current_user)):
    require_world_wallet_admin(user)
    title = request.title.strip()
    body = request.body.strip()
    if request.enabled and (not title or not body):
        raise HTTPException(status_code=400, detail="An enabled announcement needs both a title and message")
    with db() as conn:
        conn.execute(
            "INSERT INTO wallet_announcements(id,title,body,enabled,updated_by) VALUES(1,%s,%s,%s,%s) "
            "ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=NOW()",
            (title, body, request.enabled, user["id"]),
        )
        conn.commit()
    record_admin_event(user, "update_wallet_announcement", "enabled=" + str(bool(request.enabled)).lower())
    return {"status": "saved", "announcement": {"title": title, "body": body, "enabled": bool(request.enabled)}}



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
            "SELECT id,type,asset,description,amount,status,tx_hash,confirmations,block_height,network,block_hash,log_index,created_at,reference,from_address,destination "
            "FROM transactions WHERE wallet_id=%s ORDER BY created_at DESC,id DESC LIMIT %s OFFSET %s",
            (wallet_id, limit, offset),
        ).fetchall()
    txs = [{
        "id": row[0], "type": row[1], "asset": row[2], "description": row[3],
        "amount": float(row[4]), "status": row[5], "tx_hash": row[6],
        "confirmations": int(row[7] or 0), "block_height": row[8], "network": row[9],
        "block_hash": row[10], "log_index": row[11],
        "time": row[12].isoformat() if row[12] else None,
        "reference": row[13], "from_address": row[14], "to_address": row[15],
        "receipt_state": ("confirmed" if row[5] in {"confirmed", "settled"} else "failed" if row[5] == "failed" and row[6] else "reorged" if row[5] == "reorged" else "pending" if row[6] else "not_broadcast"),
        "token_contract_address": (
            (USDT_BSC_CONTRACT or BSC_USDT_MAINNET_CONTRACT) if row[2] == "USDT-BNB" and row[9] == "bnb"
            else (USDT_ETH_CONTRACT or ETHEREUM_USDT_MAINNET_CONTRACT) if row[2] == "USDT" and row[9] == "ethereum"
            else BALMZ_ETH_CONTRACT if row[2] == "BALMZ" and row[9] == "ethereum"
            else BALMZ_BNB_CONTRACT if row[2] == "BALMZ-BNB" and row[9] == "bnb"
            else BALMZ_SEPOLIA_CONTRACT if row[2] == "BALMZ-SEP" and row[9] == "sepolia"
            else None
        ),
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
                    "SELECT symbol,name,network,contract_address,decimals,status FROM token_registry "
                    "WHERE network=%s AND contract_address IS NOT NULL AND decimals IS NOT NULL AND status='active'",
                    (network,),
                ).fetchall()
            network_address = wallet_network_address(user, network)
            token_rows = wallet_sync_token_rows(
                token_rows,
                network_address if network == "ethereum" else None,
                network_address if network == "bnb" else None,
            )
            for symbol, _token_name, token_network, token_contract, token_decimals, _status in token_rows:
                if token_network != network:
                    continue
                transaction_symbol = wallet_asset_symbol(symbol, network)
                token_imported, warning = sync_evm_token_transactions(
                    user, rpc_url, network, token_contract, transaction_symbol,
                    decimals=int(token_decimals) if token_decimals is not None else 18,
                    wallet_address=network_address
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
    ethereum_rpc_verified = False
    ethereum_usdt_contract = USDT_ETH_CONTRACT or ETHEREUM_USDT_MAINNET_CONTRACT
    ethereum_usdt_decimals = None
    if ETH_RPC_URL and ethereum_address:
        try:
            require_ethereum_mainnet_rpc(ETH_RPC_URL)
            ethereum_rpc_verified = True
            ethereum_usdt_decimals = verified_erc20_decimals(
                ETH_RPC_URL, ethereum_usdt_contract, "ethereum", chain_checked=True
            )
        except Exception:
            # Do not offer an ERC-20 signing contract unless Ethereum Mainnet was verified.
            ethereum_rpc_verified = False
            ethereum_usdt_decimals = None

    ethereum_balmz_decimals = None
    if ethereum_rpc_verified and BALMZ_ETH_CONTRACT:
        try:
            ethereum_balmz_decimals = verified_erc20_decimals(
                ETH_RPC_URL, BALMZ_ETH_CONTRACT, "ethereum", chain_checked=True
            )
        except Exception:
            ethereum_balmz_decimals = None

    bnb_rpc_verified = False
    bnb_usdt_decimals = None
    bnb_balmz_decimals = None
    if BSC_RPC_URL:
        try:
            require_bnb_rpc(BSC_RPC_URL)
            bnb_rpc_verified = True
            if USDT_BSC_CONTRACT:
                bnb_usdt_decimals = verified_erc20_decimals(BSC_RPC_URL, USDT_BSC_CONTRACT, "bnb", chain_checked=True)
            if BALMZ_BNB_CONTRACT:
                try:
                    bnb_balmz_decimals = verified_erc20_decimals(BSC_RPC_URL, BALMZ_BNB_CONTRACT, "bnb", chain_checked=True)
                except Exception:
                    bnb_balmz_decimals = None
        except Exception:
            # Do not advertise BNB signing details when RPC chain identity is unknown.
            bnb_rpc_verified = False
            bnb_usdt_decimals = None
    return {
        "mode": "external_signer",
        "networks": {
            "ethereum": {
                "chain_id": "0x1",
                "wallet_address": ethereum_address if ethereum_rpc_verified else None,
                "usdt_contract": ethereum_usdt_contract if ethereum_rpc_verified else None,
                "usdt_decimals": ethereum_usdt_decimals if ethereum_rpc_verified else None,
                "balmz_contract": BALMZ_ETH_CONTRACT if ethereum_balmz_decimals is not None else None,
                "balmz_decimals": ethereum_balmz_decimals,
            },
            "bnb": {
                "rpc_verified": bnb_rpc_verified,
                "chain_id": "0x38" if bnb_rpc_verified else None,
                "wallet_address": bnb_address if bnb_rpc_verified else None,
                "usdt_contract": (USDT_BSC_CONTRACT or None) if bnb_rpc_verified else None,
                "usdt_decimals": bnb_usdt_decimals if bnb_rpc_verified else None,
                "balmz_contract": BALMZ_BNB_CONTRACT if bnb_rpc_verified and bnb_balmz_decimals is not None else None,
                "balmz_decimals": bnb_balmz_decimals if bnb_rpc_verified else None,
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
        token_name = r[1]
        token_decimals = r[4]
        contract_address = r[3]
        token_status = str(r[6] or "catalog_only")

        # A pending BALMZ catalog row becomes a live Mainnet contract reference
        # only when the matching Render environment value exists and the RPC
        # proves the expected chain and a readable ERC-20 decimals() response.
        if str(r[0]).upper() == "BALMZ" and not contract_address:
            if registry_network == "ethereum" and BALMZ_ETH_CONTRACT:
                contract_address = BALMZ_ETH_CONTRACT
            elif registry_network == "bnb" and BALMZ_BNB_CONTRACT:
                contract_address = BALMZ_BNB_CONTRACT
        if str(r[0]).upper() == "USDT" and registry_network == "ethereum" and not contract_address:
            contract_address = USDT_ETH_CONTRACT or ETHEREUM_USDT_MAINNET_CONTRACT

        try:
            if registry_network == "ethereum" and contract_address:
                require_ethereum_mainnet_rpc(ETH_RPC_URL)
                token_decimals = verified_erc20_decimals(
                    ETH_RPC_URL, contract_address, "ethereum", chain_checked=True
                )
                if str(r[0]).upper() == "BALMZ" and token_status == "pending_contract":
                    token_status = "active"
                elif str(r[0]).upper() == "USDT" and token_status == "catalog_only":
                    token_status = "active"
            elif registry_network == "bnb" and contract_address:
                require_bnb_rpc(BSC_RPC_URL)
                token_decimals = verified_erc20_decimals(
                    BSC_RPC_URL, contract_address, "bnb", chain_checked=True
                )
                if str(r[0]).upper() == "BALMZ" and token_status == "pending_contract":
                    token_status = "active"
        except Exception:
            # Never present an unverified token precision or contract as live.
            token_decimals = None
            if str(r[0]).upper() == "BALMZ":
                contract_address = None
                token_status = "pending_contract"

        if registry_network == "bnb" and contract_address and str(contract_address).lower() == BSC_USDT_MAINNET_CONTRACT.lower():
            token_name = "Binance-Peg BSC-USD"

        tokens.append({
            "symbol": wallet_asset_symbol(str(r[0]), str(r[2]).strip().lower()),
            "name": token_name,
            "network": registry_network,
            "contract_address": contract_address,
            "decimals": token_decimals,
            "coingecko_id": r[5],
            "status": token_status,
            "metadata_url": r[7],
            "logo_url": r[8],
            "wallet_network_connected": supported,
        })
    return {"tokens":tokens,"connected_networks":sorted(networks)}

@app.get("/api/v1/wallets")
def list_wallets(user: dict = Depends(current_user)):
    with db() as conn:
        rows=conn.execute("SELECT id,name,created_at,wallet_number FROM wallets WHERE owner_id=%s ORDER BY created_at ASC",(user["id"],)).fetchall()
    return {"wallets":[{"id":r[0],"name":r[1],"created_at":r[2].isoformat() if r[2] else None,"wallet_number":str(r[3]),"active":r[0]==user.get("wallet_id")} for r in rows],"active_wallet_id":user.get("wallet_id")}


@app.post("/api/v1/wallets")
def create_wallet(request: WalletCreateRequest,user: dict = Depends(current_user)):
    wallet_id="wallet_"+sha(user["id"]+request.name.strip()+str(datetime.now(timezone.utc).timestamp()))[:24]
    with db() as conn:
        wallet_row=conn.execute("INSERT INTO wallets(id,owner_id,name) VALUES(%s,%s,%s) RETURNING wallet_number",(wallet_id,user["id"],request.name.strip())).fetchone()
        if not wallet_row or wallet_row[0] is None:
            raise HTTPException(status_code=500,detail="A unique wallet number could not be assigned.")
        wallet_number=str(wallet_row[0])
        for symbol,asset_name in [("BALMZ","BALMZ Token"),("BALMZ-SEP","BALMZ Token (Sepolia)"),("BTC","Bitcoin"),("ETH","Ethereum"),("USDT","Tether USD"),("BNB","BNB"),("USDC","USD Coin"),("SOL","Solana"),("XRP","XRP"),("ADA","Cardano"),("LTC","Litecoin"),("DOGE","Dogecoin")]:
            conn.execute("INSERT INTO assets(wallet_id,symbol,name,balance,price_usd) VALUES(%s,%s,%s,0,0)",(wallet_id,symbol,asset_name))
        conn.execute("UPDATE users SET active_wallet_id=%s WHERE id=%s",(wallet_id,user["id"]))
        record_wallet_audit_event(
            conn, owner_id=user["id"], wallet_id=wallet_id, actor_email=user.get("email") or ("user:" + str(user["id"])),
            action="wallet_created", resource="wallet", resource_id=wallet_id,
            details={"wallet_number": wallet_number, "name": request.name.strip()},
        )
        conn.commit()
    user["wallet_id"]=wallet_id
    user["wallet_number"]=wallet_number
    return {"wallet":{"id":wallet_id,"name":request.name.strip(),"wallet_number":wallet_number,"active":True},"message":"Wallet created. Add public network addresses to connect it to live blockchain data."}


@app.post("/api/v1/wallets/active")
def activate_wallet(request: WalletActivateRequest,user: dict = Depends(current_user)):
    with db() as conn:
        row=conn.execute("SELECT id,name,wallet_number FROM wallets WHERE id=%s AND owner_id=%s",(request.wallet_id,user["id"])).fetchone()
        if not row: raise HTTPException(status_code=404, detail="Wallet not found")
        conn.execute("UPDATE users SET active_wallet_id=%s WHERE id=%s",(row[0],user["id"]))
        record_wallet_audit_event(
            conn, owner_id=user["id"], wallet_id=row[0], actor_email=user.get("email") or ("user:" + str(user["id"])),
            action="wallet_activated", resource="wallet", resource_id=row[0],
            details={"wallet_number": str(row[2]), "name": row[1]},
        )
        conn.commit()
    user["wallet_id"]=row[0]
    user["wallet_number"]=str(row[2])
    return {"wallet":{"id":row[0],"name":row[1],"wallet_number":str(row[2]),"active":True}}


@app.get("/api/v1/wallets/{wallet_id}/addresses")
def list_wallet_addresses(wallet_id: str,user: dict = Depends(current_user)):
    with db() as conn:
        owner=conn.execute("SELECT id,name FROM wallets WHERE id=%s AND owner_id=%s",(wallet_id,user["id"])).fetchone()
        if not owner: raise HTTPException(status_code=404,detail="Wallet not found")
        rows=conn.execute("SELECT network,address,label,created_at,ownership_verified FROM wallet_addresses WHERE wallet_id=%s ORDER BY network, CASE WHEN lower(label)='primary' THEN 0 ELSE 1 END, created_at, address",(wallet_id,)).fetchall()
    return {"wallet_id":wallet_id,"addresses":[{"network":r[0],"address":r[1],"label":r[2],"created_at":r[3].isoformat() if r[3] else None,"ownership_verified":bool(r[4])} for r in rows]}


@app.post("/api/v1/wallets/{wallet_id}/addresses")
def add_wallet_address(wallet_id: str,request: WalletAddressRequest,user: dict = Depends(current_user)):
    network=normalize_wallet_network(request.network)
    address=request.address.strip()
    if network in {"ethereum","bnb","sepolia"} and not valid_evm_address(address): raise HTTPException(status_code=400,detail="Invalid EVM address")
    if network=="bitcoin" and not valid_bitcoin_address(address): raise HTTPException(status_code=400,detail="Invalid Bitcoin address")
    if network in {"solana_mainnet","solana_devnet"} and not valid_solana_address(address): raise HTTPException(status_code=400,detail="Invalid Solana public address")
    if network not in {"ethereum","bnb","sepolia","bitcoin","solana_mainnet","solana_devnet"}: raise HTTPException(status_code=400,detail="Unsupported wallet network")
    with db() as conn:
        owner=conn.execute("SELECT id FROM wallets WHERE id=%s AND owner_id=%s",(wallet_id,user["id"])).fetchone()
        if not owner: raise HTTPException(status_code=404,detail="Wallet not found")
        comparison = "lower(address)=lower(%s)" if network in {"ethereum","bnb","sepolia"} else "address=%s"
        existing=conn.execute(f"SELECT ownership_verified FROM wallet_addresses WHERE wallet_id=%s AND network=%s AND {comparison} FOR UPDATE",(wallet_id,network,address)).fetchone()
        if existing:
            conn.execute(f"UPDATE wallet_addresses SET label=%s WHERE wallet_id=%s AND network=%s AND {comparison}",(request.label.strip(),wallet_id,network,address))
        else:
            conn.execute("INSERT INTO wallet_addresses(wallet_id,network,address,label,ownership_verified) VALUES(%s,%s,%s,%s,FALSE) ON CONFLICT DO NOTHING",(wallet_id,network,address,request.label.strip()))
        saved=conn.execute(f"SELECT ownership_verified FROM wallet_addresses WHERE wallet_id=%s AND network=%s AND {comparison}",(wallet_id,network,address)).fetchone()
        record_wallet_audit_event(
            conn, owner_id=user["id"], wallet_id=wallet_id, actor_email=user.get("email") or ("user:" + str(user["id"])),
            action="wallet_address_attached", resource="wallet_address", resource_id=address,
            network=network, details={"label": request.label.strip(), "ownership_verified": bool(saved and saved[0])},
        )
        conn.commit()
    return {"status":"connected","wallet_id":wallet_id,"address":{"network":network,"address":address,"label":request.label.strip(),"ownership_verified":bool(saved and saved[0])}}


@app.post("/api/v1/wallets/{wallet_id}/addresses/challenge")
def create_wallet_address_challenge(wallet_id: str,request: WalletAddressChallengeRequest,user: dict = Depends(current_user)):
    network=normalize_wallet_network(request.network); address=request.address.strip()
    if network in {"ethereum","bnb","sepolia"} and not valid_evm_address(address):
        raise HTTPException(status_code=400,detail="Invalid EVM address")
    if network in {"solana_mainnet","solana_devnet"} and not valid_solana_address(address):
        raise HTTPException(status_code=400,detail="Invalid Solana address")
    if network == "bitcoin" and not valid_bitcoin_address(address):
        raise HTTPException(status_code=400,detail="Invalid Bitcoin address")
    if network not in {"ethereum","bnb","sepolia","bitcoin","solana_mainnet","solana_devnet"}:
        raise HTTPException(status_code=400,detail="Unsupported ownership challenge network")
    challenge_id="wac_"+secrets.token_urlsafe(24); issued=int(datetime.now(timezone.utc).timestamp())
    message=(f"World Wallet AI address ownership verification\nWallet: {wallet_id}\nNetwork: {network}\nAddress: {address}\nChallenge: {challenge_id}\nIssued: {issued}\nSign this message only to prove control of this address. This does not authorize a transaction.")
    with db() as conn:
        owner=conn.execute("SELECT id FROM wallets WHERE id=%s AND owner_id=%s",(wallet_id,user["id"])).fetchone()
        if not owner: raise HTTPException(status_code=404,detail="Wallet not found")
        comparison = "lower(address)=lower(%s)" if network in {"ethereum","bnb","sepolia"} else "address=%s"
        attached=conn.execute(f"SELECT 1 FROM wallet_addresses WHERE wallet_id=%s AND network=%s AND {comparison}",(wallet_id,network,address)).fetchone()
        if not attached: raise HTTPException(status_code=404,detail="Attach this address before verifying ownership")
        conn.execute("INSERT INTO wallet_address_challenges(id,wallet_id,owner_id,network,address,message,expires_at) VALUES(%s,%s,%s,%s,%s,%s,NOW()+INTERVAL '10 minutes')",(challenge_id,wallet_id,user["id"],network,address,message))
        record_wallet_audit_event(
            conn, owner_id=user["id"], wallet_id=wallet_id, actor_email=user.get("email") or ("user:" + str(user["id"])),
            action="address_verification_challenge_issued", resource="wallet_address",
            resource_id=address, network=network, details={"expires_in_seconds": 600},
        )
        conn.commit()
    return {"challenge_id":challenge_id,"message":message,"expires_in_seconds":600}


@app.post("/api/v1/wallets/{wallet_id}/addresses/verify")
def verify_wallet_address(wallet_id: str,request: WalletAddressVerifyRequest,user: dict = Depends(current_user)):
    with db() as conn:
        challenge=conn.execute("SELECT network,address,message,expires_at,used_at FROM wallet_address_challenges WHERE id=%s AND wallet_id=%s AND owner_id=%s FOR UPDATE",(request.challenge_id,wallet_id,user["id"])).fetchone()
        if not challenge: raise HTTPException(status_code=404,detail="Verification challenge not found")
        if challenge[4] is not None: raise HTTPException(status_code=409,detail="Verification challenge already used")
        if challenge[3] <= datetime.now(timezone.utc): raise HTTPException(status_code=410,detail="Verification challenge expired")
        network,address,message=challenge[0],challenge[1],challenge[2]
        if network in {"ethereum","bnb","sepolia"}:
            try:
                from eth_account import Account
                from eth_account.messages import encode_defunct
                recovered=Account.recover_message(encode_defunct(text=message),signature=request.signature)
            except Exception as exc:
                raise HTTPException(status_code=400,detail="Invalid EVM personal-message signature") from exc
            if recovered.lower()!=address.lower():
                raise HTTPException(status_code=400,detail="Signature does not match attached address")
            comparison="lower(address)=lower(%s)"
        elif network in {"solana_mainnet","solana_devnet"}:
            try:
                signature_bytes=base64.b64decode(request.signature,validate=True)
                alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
                decoded=0
                for character in address:
                    digit=alphabet.find(character)
                    if digit<0: raise ValueError("Invalid base58 character")
                    decoded=decoded*58+digit
                public_key=decoded.to_bytes((decoded.bit_length()+7)//8,"big") if decoded else b""
                leading_zeroes=len(address)-len(address.lstrip("1"))
                public_key=(b"\x00"*leading_zeroes)+public_key
                if len(public_key)!=32 or len(signature_bytes)!=64:
                    raise ValueError("Invalid Ed25519 key or signature length")
                from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
                Ed25519PublicKey.from_public_bytes(public_key).verify(signature_bytes,message.encode("utf-8"))
            except Exception as exc:
                raise HTTPException(status_code=400,detail="Invalid Solana Ed25519 ownership signature") from exc
            comparison="address=%s"
        elif network == "bitcoin":
            try:
                raw_signature=bytes.fromhex(request.signature.removeprefix("0x"))
                if len(raw_signature)!=65:
                    raise ValueError("Expected a 65-byte recoverable secp256k1 signature")
                v=raw_signature[64]
                if v>=27: v-=27
                if v not in (0,1): raise ValueError("Invalid recovery id")
                from eth_keys import keys
                from eth_utils import keccak
                recovered=keys.Signature(vrs=(v,int.from_bytes(raw_signature[:32],"big"),int.from_bytes(raw_signature[32:64],"big"))).recover_public_key_from_msg_hash(keccak(message.encode("utf-8")))
                compressed=recovered.to_compressed_bytes()
                witness_hash=hashlib.new("ripemd160",hashlib.sha256(compressed).digest()).digest()
                alphabet="qpzry9x8gf2tvdw0s3jn54khce6mua7l"
                clean=address.lower()
                separator=clean.rfind("1")
                if separator<1 or clean[:separator]!="bc": raise ValueError("Expected a Bitcoin Mainnet Bech32 address")
                data=[alphabet.index(character) for character in clean[separator+1:]]
                if len(data)<7: raise ValueError("Invalid Bech32 data")
                values=[ord(character)>>5 for character in clean[:separator]]+[0]+[ord(character)&31 for character in clean[:separator]]
                generators=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3]
                polymod=1
                for value in values+data:
                    top=polymod>>25
                    polymod=((polymod&0x1ffffff)<<5)^value
                    for index,generator in enumerate(generators):
                        if (top>>index)&1: polymod^=generator
                if polymod!=1: raise ValueError("Invalid Bitcoin Bech32 checksum")
                payload=data[:-6]
                if not payload or payload[0]!=0: raise ValueError("Only native SegWit v0 addresses are supported for this proof")
                accumulator=0; bit_count=0; decoded_program=[]
                for value in payload[1:]:
                    accumulator=(accumulator<<5)|value
                    bit_count+=5
                    while bit_count>=8:
                        bit_count-=8
                        decoded_program.append((accumulator>>bit_count)&255)
                if bit_count>=5 or ((accumulator<<(8-bit_count))&255):
                    raise ValueError("Invalid Bech32 witness padding")
                if bytes(decoded_program)!=witness_hash or len(witness_hash)!=20:
                    raise ValueError("Bitcoin signature does not match the attached P2WPKH address")
            except Exception as exc:
                raise HTTPException(status_code=400,detail="Invalid Bitcoin Mainnet ownership signature") from exc
            comparison="address=%s"
        else:
            raise HTTPException(status_code=400,detail="Unsupported ownership proof network")
        updated=conn.execute(f"UPDATE wallet_addresses SET ownership_verified=TRUE WHERE wallet_id=%s AND network=%s AND {comparison}",(wallet_id,network,address))
        if updated.rowcount != 1: raise HTTPException(status_code=409,detail="Attached address no longer exists")
        consumed=conn.execute("UPDATE wallet_address_challenges SET used_at=NOW() WHERE id=%s AND used_at IS NULL AND expires_at>NOW()",(request.challenge_id,))
        if consumed.rowcount != 1: raise HTTPException(status_code=409,detail="Verification challenge was already consumed or expired")
        record_wallet_audit_event(
            conn, owner_id=user["id"], wallet_id=wallet_id, actor_email=user.get("email") or ("user:" + str(user["id"])),
            action="address_ownership_verified", resource="wallet_address", resource_id=address,
            network=network, details={"method": "network_native_message_signature"},
        )
        conn.commit()
    return {"status":"verified","wallet_id":wallet_id,"network":network,"address":address,"ownership_verified":True}


@app.get("/api/v1/wallets/{wallet_id}/addresses/balance")
def read_wallet_address_balance(wallet_id: str, network: str, address: str, user: dict = Depends(current_user)):
    """Read the balance for one attached public address without mutating portfolio assets."""
    network = normalize_wallet_network(network)
    address = address.strip()
    if network not in {"ethereum", "sepolia", "bnb", "bitcoin", "solana_mainnet", "solana_devnet"}:
        raise HTTPException(status_code=400, detail="Unsupported wallet network")
    if network in {"ethereum", "sepolia", "bnb"} and not valid_evm_address(address):
        raise HTTPException(status_code=400, detail="Invalid EVM address")
    if network == "bitcoin" and not valid_bitcoin_address(address):
        raise HTTPException(status_code=400, detail="Invalid Bitcoin address")
    if network in {"solana_mainnet", "solana_devnet"} and not valid_solana_address(address):
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
            require_bnb_rpc(rpc_url)
            balance = evm_balance(rpc_url, address)
        elif network in {"solana_mainnet", "solana_devnet"}:
            if network == "solana_mainnet":
                rpc_url, asset = SOLANA_MAINNET_RPC_URL, "SOL"
                expected_hash, cluster_name = SOLANA_MAINNET_GENESIS_HASH, "Solana Mainnet"
            else:
                rpc_url, asset = SOLANA_DEVNET_RPC_URL, "SOL (Devnet)"
                expected_hash, cluster_name = SOLANA_DEVNET_GENESIS_HASH, "Solana Devnet"
            if not rpc_url:
                raise HTTPException(status_code=503, detail=f"{cluster_name} RPC is not configured")
            require_solana_rpc_cluster(rpc_url, expected_hash, cluster_name)
            raw = rpc_call(rpc_url, "getBalance", [address, {"commitment": "confirmed"}])
            balance = int((raw or {}).get("value", 0)) / 1_000_000_000
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



@app.get("/api/v1/mining/balmz")
def balmz_mining_status(user: dict = Depends(current_user)):
    """Return wallet-scoped mining sessions and pending, non-spendable allocations."""
    with db() as conn:
        rows = conn.execute(
            "SELECT id,status,started_at,ended_at,duration_seconds FROM balmz_mining_sessions "
            "WHERE wallet_id=%s ORDER BY started_at DESC LIMIT 25",
            (user["wallet_id"],),
        ).fetchall()
        totals = conn.execute(
            "SELECT COUNT(*) FILTER (WHERE status='completed'),COALESCE(SUM(duration_seconds),0) "
            "FROM balmz_mining_sessions WHERE wallet_id=%s",
            (user["wallet_id"],),
        ).fetchone()
        reward_totals = conn.execute(
            "SELECT COALESCE(SUM(reward_amount),0),COUNT(*) "
            "FROM balmz_mining_reward_ledger WHERE wallet_id=%s AND status='pending_launch'",
            (user["wallet_id"],),
        ).fetchone()
        reward_rows = conn.execute(
            "SELECT id,session_id,cycle_number,earned_at,created_at,reward_amount,status "
            "FROM balmz_mining_reward_ledger WHERE wallet_id=%s "
            "ORDER BY created_at DESC,id DESC LIMIT 100",
            (user["wallet_id"],),
        ).fetchall()
        code_row = conn.execute(
            "SELECT mining_referral_code,world_wallet_code FROM wallets WHERE id=%s",
            (user["wallet_id"],),
        ).fetchone()
    active = next((row for row in rows if row[1] == "active"), None)
    total_seconds = int(totals[1] or 0)
    if active:
        total_seconds += max(0, int((datetime.now(timezone.utc) - active[2]).total_seconds()))
    return {
        "wallet_id": user["wallet_id"],
        "mining_referral_code": code_row[0] if code_row else None,
        "world_wallet_code": code_row[1] if code_row else None,
        "program": "BALMZ Free Mining",
        "mode": "pending_reward_ledger",
        "active_session": None if not active else {
            "id": active[0], "started_at": active[2].isoformat()
        },
        "completed_sessions": int(totals[0] or 0),
        "total_session_seconds": total_seconds,
        "reward_asset": "BALMZ",
        "reward_rate_per_cycle": "0.5",
        "cycle_seconds": 10800,
        "daily_reward_cap": "4",
        "pending_reward_amount": str(reward_totals[0] or 0),
        "pending_cycle_count": int(reward_totals[1] or 0),
        "reward_status": "pending_launch_not_spendable",
        "record_enabled": True,
        "withdrawal_enabled": False,
        "claim_enabled": False,
        "notice": "Eligible cycles can be recorded as pending BALMZ allocations only. No token is minted, transferred, or spendable before the official launch and funding verification.",
        "recent_rewards": [{
            "id": row[0], "session_id": row[1], "cycle_number": int(row[2]),
            "earned_at": row[3].isoformat(), "recorded_at": row[4].isoformat(),
            "amount": str(row[5]), "status": row[6]
        } for row in reward_rows],
        "recent_sessions": [{
            "id": row[0], "status": row[1], "started_at": row[2].isoformat(),
            "ended_at": row[3].isoformat() if row[3] else None,
            "duration_seconds": int(row[4]) if row[4] is not None else None,
        } for row in rows],
    }


@app.post("/api/v1/mining/balmz/record")
def record_balmz_mining_rewards(user: dict = Depends(current_user)):
    """Idempotently record completed 3-hour cycles as pending allocations only."""
    now = datetime.now(timezone.utc)
    recorded = 0
    with db() as conn:
        # Serialize all claims for this wallet, including across old/new sessions.
        wallet = conn.execute(
            "SELECT id FROM wallets WHERE id=%s FOR UPDATE", (user["wallet_id"],)
        ).fetchone()
        if not wallet:
            raise HTTPException(status_code=404, detail="Mining wallet was not found")
        sessions = conn.execute(
            "SELECT id,started_at,COALESCE(ended_at,%s) FROM balmz_mining_sessions "
            "WHERE wallet_id=%s ORDER BY started_at",
            (now, user["wallet_id"]),
        ).fetchall()
        existing_rows = conn.execute(
            "SELECT session_id,cycle_number,earned_at FROM balmz_mining_reward_ledger "
            "WHERE wallet_id=%s",
            (user["wallet_id"],),
        ).fetchall()
        existing = {(row[0], int(row[1])) for row in existing_rows}
        daily_counts = {}
        for row in existing_rows:
            day = row[2].astimezone(timezone.utc).date()
            daily_counts[day] = daily_counts.get(day, 0) + 1

        for session_id, started_at, ended_at in sessions:
            elapsed_seconds = max(0, int((min(ended_at, now) - started_at).total_seconds()))
            completed_cycles = elapsed_seconds // 10800
            for cycle_number in range(1, completed_cycles + 1):
                if (session_id, cycle_number) in existing:
                    continue
                earned_at = started_at + timedelta(seconds=cycle_number * 10800)
                earned_day = earned_at.astimezone(timezone.utc).date()
                if daily_counts.get(earned_day, 0) >= 8:
                    continue
                ledger_id = "balmz_reward_" + sha(
                    user["wallet_id"] + ":" + session_id + ":" + str(cycle_number)
                )[:32]
                inserted = conn.execute(
                    "INSERT INTO balmz_mining_reward_ledger"
                    "(id,wallet_id,session_id,cycle_number,earned_at,reward_amount,status) "
                    "VALUES(%s,%s,%s,%s,%s,0.5,'pending_launch') "
                    "ON CONFLICT(wallet_id,session_id,cycle_number) DO NOTHING",
                    (ledger_id, user["wallet_id"], session_id, cycle_number, earned_at),
                )
                if inserted.rowcount:
                    recorded += 1
                    daily_counts[earned_day] = daily_counts.get(earned_day, 0) + 1
                    existing.add((session_id, cycle_number))
        conn.commit()

    return {
        "status": "recorded",
        "new_cycles_recorded": recorded,
        "reward_per_cycle": "0.5",
        "daily_cap": "4",
        "allocation_status": "pending_launch_not_spendable",
        "withdrawal_enabled": False,
        "notice": "Eligible cycles were recorded as pending allocations only. No BALMZ was minted, transferred, or made spendable.",
    }


@app.post("/api/v1/mining/balmz/start")
def start_balmz_mining(user: dict = Depends(current_user)):
    """Start a free session record; this endpoint never issues or credits tokens."""
    session_id = "mine_" + secrets.token_hex(16)
    with db() as conn:
        existing = conn.execute(
            "SELECT id,started_at FROM balmz_mining_sessions WHERE wallet_id=%s AND status='active' FOR UPDATE",
            (user["wallet_id"],),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="A free BALMZ participation session is already active")
        inserted = conn.execute(
            "INSERT INTO balmz_mining_sessions(id,wallet_id,status) VALUES(%s,%s,'active') "
            "ON CONFLICT (wallet_id) WHERE status='active' DO NOTHING",
            (session_id, user["wallet_id"]),
        )
        if inserted.rowcount == 0:
            raise HTTPException(status_code=409, detail="A free BALMZ participation session is already active")
        conn.commit()
    return {
        "status": "started", "session_id": session_id,
        "reward_status": "disabled_pending_verified_funded_allocation",
        "claim_enabled": False,
        "notice": "Free session tracking started. No BALMZ is mined, minted, or credited by this session tracker.",
    }


@app.post("/api/v1/mining/balmz/stop")
def stop_balmz_mining(user: dict = Depends(current_user)):
    """Complete the caller's active session without assigning a token reward."""
    with db() as conn:
        row = conn.execute(
            "SELECT id,started_at FROM balmz_mining_sessions WHERE wallet_id=%s AND status='active' FOR UPDATE",
            (user["wallet_id"],),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=409, detail="There is no active BALMZ participation session")
        ended_at = datetime.now(timezone.utc)
        duration = max(0, int((ended_at - row[1]).total_seconds()))
        conn.execute(
            "UPDATE balmz_mining_sessions SET status='completed',ended_at=%s,duration_seconds=%s "
            "WHERE id=%s AND wallet_id=%s AND status='active'",
            (ended_at, duration, row[0], user["wallet_id"]),
        )
        conn.commit()
    return {
        "status": "completed", "session_id": row[0], "duration_seconds": duration,
        "reward_amount": None, "claim_enabled": False,
        "reward_status": "disabled_pending_verified_funded_allocation",
        "notice": "Session recorded. No BALMZ reward was created or credited.",
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
        if network == "ethereum":
            require_ethereum_mainnet_rpc(rpc)
        elif network == "bnb":
            require_bnb_rpc(rpc)
        elif network == "sepolia":
            require_sepolia_rpc(rpc)
        code = rpc_call(rpc, "eth_getCode", [address, "latest"])
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Blockchain RPC unavailable or chain identity mismatch") from exc
    has_code = bool(code and code not in {"0x","0x0"})
    source_check = {"status": "not_checked", "source_verified": False}
    if has_code and ETHERSCAN_API_KEY:
        try:
            source_metadata = etherscan_contract_source(ETHERSCAN_CHAIN_IDS[network], address)
            source_check = {"status": "checked", **source_metadata}
        except Exception as exc:
            logger.warning("Etherscan contract source lookup failed: network=%s error_type=%s", network, type(exc).__name__)
            source_check = {"status": "unavailable", "source_verified": False}
    elif has_code:
        source_check = {"status": "not_configured", "source_verified": False}
    return {
        "status": "contract" if has_code else "no_contract_code",
        "network": network,
        "address": address,
        "contract": has_code,
        "source_verified": bool(source_check.get("source_verified")),
        "explorer_source": source_check,
        "note": "Deployed bytecode and explorer source verification are separate checks. Etherscan source verification does not prove contract safety, ownership, reserves, or audit status.",
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
        elif network == "bnb":
            require_bnb_rpc(rpc)
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
                    token_decimals = verified_erc20_decimals(rpc, contract, network, chain_checked=True) if network == "bnb" else int(decimals)
                    value = erc20_balance(rpc, contract, address, token_decimals)
                    display_name = "Binance-Peg BSC-USD" if network == "bnb" and str(contract).lower() == BSC_USDT_MAINNET_CONTRACT.lower() else name
                    result["tokens"].append({
                        "symbol": symbol, "name": display_name, "contract_address": contract,
                        "decimals": token_decimals, "on_chain_balance": value, "available_balance": value,
                    })
                except Exception:
                    result["tokens"].append({
                        "symbol": symbol, "name": name, "contract_address": contract,
                        "decimals": None if network == "bnb" else int(decimals), "on_chain_balance": None, "available_balance": None,
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
        if network == "solana_mainnet":
            # Native SOL is production-network evidence, kept distinct from the
            # Devnet BALMZ token and never interpreted as BALMZ presale reserves.
            try:
                require_solana_rpc_cluster(SOLANA_MAINNET_RPC_URL, SOLANA_MAINNET_GENESIS_HASH, "Solana Mainnet")
                native_result = rpc_call(SOLANA_MAINNET_RPC_URL, "getBalance", [address, {"commitment": "confirmed"}])
                slot = rpc_call(SOLANA_MAINNET_RPC_URL, "getSlot", [{"commitment": "confirmed"}])
                reserves.append({
                    "network": "solana_mainnet", "address": address, "asset": "SOL",
                    "balance": int((native_result or {}).get("value", 0)) / 1_000_000_000,
                    "block_number": slot, "source": "Solana Mainnet getBalance (confirmed)",
                })
            except Exception:
                warnings.append("solana-mainnet: native SOL balance unavailable")
            continue
        if network == "solana_devnet":
            # Keep testnet holdings separate from production reserve figures.
            solana_rpc = SOLANA_DEVNET_RPC_URL or "https://api.devnet.solana.com"
            try:
                require_solana_rpc_cluster(solana_rpc, SOLANA_DEVNET_GENESIS_HASH, "Solana Devnet")
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
            if network == "ethereum":
                require_ethereum_mainnet_rpc(rpc)
            elif network == "bnb":
                require_bnb_rpc(rpc)
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
                asset_symbol = wallet_asset_symbol(symbol, network)
                try:
                    reserves.append({
                        "network": network, "address": address, "asset": asset_symbol,
                        "balance": erc20_balance(
                            rpc, contract, address,
                            verified_erc20_decimals(rpc, contract, network, chain_checked=True) if network == "bnb" else int(decimals),
                        ),
                        "contract_address": contract, "block_number": height,
                        "source": "configured ERC-20 contract balanceOf",
                    })
                except Exception:
                    warnings.append(f"{network} {asset_symbol}: token balance unavailable")
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
        if network == "ethereum":
            require_ethereum_mainnet_rpc(rpc)
        elif network == "bnb":
            require_bnb_rpc(rpc)
        elif network == "sepolia":
            require_sepolia_rpc(rpc)
        else:
            raise HTTPException(status_code=400, detail="Unsupported contract inspection network")
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
    source_address=(request.source_address or "").strip() or wallet_network_address(user,network)
    if not source_address: raise HTTPException(status_code=409,detail="No source address is attached for this network")
    if network in {"ethereum","bnb","sepolia"} and not valid_evm_address(source_address): raise HTTPException(status_code=400,detail="Invalid source address for selected network")
    comparison="lower(address)=lower(%s)" if network in {"ethereum","bnb","sepolia"} else "address=%s"
    with db() as address_conn:
        attached=address_conn.execute(f"SELECT ownership_verified FROM wallet_addresses WHERE wallet_id=%s AND network=%s AND {comparison}",(user["wallet_id"],network,source_address)).fetchone()
    if not attached: raise HTTPException(status_code=404,detail="Selected source address is not attached to this wallet")
    if network in {"ethereum","bnb","sepolia"} and not attached[0]: raise HTTPException(status_code=403,detail="Selected source address must pass message-signature ownership verification before transfer")
    fingerprint=sha(f"transfer|{symbol}|{network}|{request.amount}|{request.recipient.strip()}|{source_address}|{request.note or ''}")
    with db() as conn:
        asset_row=conn.execute(
            "SELECT balance,reserved_balance FROM assets WHERE wallet_id=%s AND symbol=%s FOR UPDATE",
            (user["wallet_id"],symbol),
        ).fetchone()
        if not asset_row:
            raise HTTPException(status_code=400,detail="Unsupported asset")
        existing=conn.execute(
            "SELECT i.request_hash,t.id,t.asset,t.amount,t.destination,t.network,t.status,t.reference "
            "FROM transaction_idempotency i JOIN transactions t ON t.id=i.transaction_id "
            "WHERE i.wallet_id=%s AND i.idempotency_key=%s",
            (user["wallet_id"],request.idempotency_key.strip()),
        ).fetchone()
        if existing:
            if existing[0] != fingerprint:
                raise HTTPException(status_code=409,detail="Idempotency key was already used for a different transfer")
            return {"status":existing[6],"mode":"database","accounting":"reserved","broadcast":False,
                    "replayed":True,"transfer":{"id":existing[1],"reference":existing[7],"asset":existing[2],"amount":float(abs(existing[3])),
                    "recipient":existing[4],"network":existing[5]}}
        ok,rejection=reserve_asset(conn,user,symbol,request.amount)
        if not ok:
            conn.rollback()
            return rejection
        txid="tx_"+sha(user["wallet_id"]+request.idempotency_key.strip())[:24]
        transaction_reference = generate_transaction_reference()
        conn.execute("INSERT INTO transactions(id,wallet_id,reference,type,asset,description,amount,status,destination,network,from_address) VALUES(%s,%s,%s,'sent',%s,%s,%s,'pending',%s,%s,%s)",
                     (txid,user["wallet_id"],transaction_reference,symbol,"Transfer request",-request.amount,request.recipient,network,source_address))
        conn.execute("INSERT INTO transaction_idempotency(wallet_id,idempotency_key,request_hash,transaction_id) VALUES(%s,%s,%s,%s)",
                     (user["wallet_id"],request.idempotency_key.strip(),fingerprint,txid))
        record_wallet_audit_event(
            conn, owner_id=user["id"], wallet_id=user["wallet_id"], actor_email=user.get("email") or ("user:" + str(user["id"])),
            action="transfer_requested", resource="transaction", resource_id=txid,
            network=network, reference=transaction_reference,
            details={"asset": symbol, "amount": str(request.amount), "status": "pending"},
        )
        conn.commit()
    return {"status":"pending","mode":"database","accounting":"reserved","broadcast":False,
            "transfer":{"id":txid,"reference":transaction_reference,"asset":symbol,"amount":float(request.amount),"recipient":request.recipient,"network":network}}

@app.post("/api/v1/withdrawals")
def withdrawal(request: WithdrawalRequest,user: dict = Depends(current_user)):
    symbol,network=validate_asset_network(request.asset,request.network)
    if not valid_destination_for_network(request.destination,network):
        raise HTTPException(status_code=400,detail="Invalid destination address for selected network")
    source_address=(request.source_address or "").strip() or wallet_network_address(user,network)
    if not source_address: raise HTTPException(status_code=409,detail="No source address is attached for this network")
    if network in {"ethereum","bnb","sepolia"} and not valid_evm_address(source_address): raise HTTPException(status_code=400,detail="Invalid source address for selected network")
    comparison="lower(address)=lower(%s)" if network in {"ethereum","bnb","sepolia"} else "address=%s"
    with db() as address_conn:
        attached=address_conn.execute(f"SELECT ownership_verified FROM wallet_addresses WHERE wallet_id=%s AND network=%s AND {comparison}",(user["wallet_id"],network,source_address)).fetchone()
    if not attached: raise HTTPException(status_code=404,detail="Selected source address is not attached to this wallet")
    if network in {"ethereum","bnb","sepolia"} and not attached[0]: raise HTTPException(status_code=403,detail="Selected source address must pass message-signature ownership verification before withdrawal")
    fingerprint=sha(f"withdrawal|{symbol}|{network}|{request.amount}|{request.destination.strip()}|{source_address}|{request.note or ''}")
    with db() as conn:
        asset_row=conn.execute(
            "SELECT balance,reserved_balance FROM assets WHERE wallet_id=%s AND symbol=%s FOR UPDATE",
            (user["wallet_id"],symbol),
        ).fetchone()
        if not asset_row:
            raise HTTPException(status_code=400,detail="Unsupported asset")
        existing=conn.execute(
            "SELECT i.request_hash,t.id,t.asset,t.amount,t.destination,t.network,t.status,t.from_address,t.reference "
            "FROM transaction_idempotency i JOIN transactions t ON t.id=i.transaction_id "
            "WHERE i.wallet_id=%s AND i.idempotency_key=%s",
            (user["wallet_id"],request.idempotency_key.strip()),
        ).fetchone()
        if existing:
            if existing[0] != fingerprint:
                raise HTTPException(status_code=409,detail="Idempotency key was already used for a different withdrawal")
            return {"status":existing[6],"mode":"database","accounting":"reserved","broadcast":False,
                    "replayed":True,"withdrawal":{"id":existing[1],"reference":existing[8],"asset":existing[2],"amount":float(abs(existing[3])),
                    "destination":existing[4],"network":existing[5],"source_address":existing[7]}}
        ok,rejection=reserve_asset(conn,user,symbol,request.amount)
        if not ok:
            conn.rollback()
            return rejection
        txid="tx_"+sha(user["wallet_id"]+request.idempotency_key.strip())[:24]
        transaction_reference = generate_transaction_reference()
        conn.execute("INSERT INTO transactions(id,wallet_id,reference,type,asset,description,amount,status,destination,network,from_address) VALUES(%s,%s,%s,'withdrawal',%s,%s,%s,'pending_review',%s,%s,%s)",
                     (txid,user["wallet_id"],transaction_reference,symbol,"Withdrawal request",-request.amount,request.destination,network,source_address))
        conn.execute("INSERT INTO transaction_idempotency(wallet_id,idempotency_key,request_hash,transaction_id) VALUES(%s,%s,%s,%s)",
                     (user["wallet_id"],request.idempotency_key.strip(),fingerprint,txid))
        record_wallet_audit_event(
            conn, owner_id=user["id"], wallet_id=user["wallet_id"], actor_email=user.get("email") or ("user:" + str(user["id"])),
            action="withdrawal_requested", resource="transaction", resource_id=txid,
            network=network, reference=transaction_reference,
            details={"asset": symbol, "amount": str(request.amount), "status": "pending_review"},
        )
        conn.commit()
    return {"status":"pending_review","mode":"database","accounting":"reserved","broadcast":False,
            "withdrawal":{"id":txid,"reference":transaction_reference,"asset":symbol,"amount":float(request.amount),"destination":request.destination,"network":network}}

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


def verified_erc20_decimals(url: str, contract: str, network: str, *, chain_checked: bool = False):
    """Read ERC-20 precision only from the selected EVM network and validate its range."""
    network = str(network or "").strip().lower()
    if network not in {"ethereum", "bnb", "sepolia"}:
        raise ValueError("Unsupported network for ERC-20 decimals")
    if not chain_checked:
        if network == "ethereum":
            require_ethereum_mainnet_rpc(url)
        elif network == "bnb":
            require_bnb_rpc(url)
        else:
            require_sepolia_rpc(url)
    decimals = erc20_decimals(url, contract)
    if decimals is None or not isinstance(decimals, int) or decimals < 0 or decimals > 36:
        raise ValueError("Unable to determine valid ERC-20 decimals")
    return decimals


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
    rpc = ETH_RPC_URL if network == "ethereum" else BSC_RPC_URL if network == "bnb" else SEPOLIA_RPC_URL if network == "sepolia" else ""
    if not rpc or not wallet_address:
        raise HTTPException(status_code=503, detail=f"{network.title()} settlement RPC or wallet is not configured")
    try:
        if network == "ethereum": require_ethereum_mainnet_rpc(rpc)
        elif network == "sepolia": require_sepolia_rpc(rpc)
        elif network == "bnb": require_bnb_rpc(rpc)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"{network.title()} RPC chain identity check failed") from exc
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
            elif asset == "BALMZ-BNB":
                contract = BALMZ_BNB_CONTRACT if network == "bnb" else ""
                label = "BALMZ on BNB Chain"
            elif asset == "BALMZ-SEP":
                contract = BALMZ_SEPOLIA_CONTRACT if network == "sepolia" else ""
                label = "BALMZ Sepolia"
            elif asset == "USDT-BNB":
                contract = USDT_BSC_CONTRACT if network == "bnb" else ""
                label = "USDT on BNB Chain"
            else:
                # Accept pre-fix pending BNB transactions using the legacy
                # generic USDT symbol, but never route new BNB reservations
                # through that label (validate_asset_network canonicalizes it).
                contract = (
                    (USDT_ETH_CONTRACT or ETHEREUM_USDT_MAINNET_CONTRACT) if network == "ethereum"
                    else USDT_BSC_CONTRACT if network == "bnb"
                    else ""
                )
                label = "USDT on BNB Chain" if network == "bnb" else "USDT"
            if not contract:
                raise HTTPException(status_code=503, detail=label + " contract is not configured for settlement verification")
            if not _same_address(tx.get("to"), contract):
                raise HTTPException(status_code=409, detail=f"Token contract does not match the configured {label} contract")
            try:
                decimals = verified_erc20_decimals(rpc, contract, network, chain_checked=True)
            except Exception as exc:
                raise HTTPException(status_code=503, detail="Unable to determine token decimals") from exc
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
            deposit_id = "dep_" + sha("solana-devnet-deposit:" + tx_signature)[:24]
            reference_row = conn.execute(
                "SELECT reference FROM transactions WHERE id=%s AND wallet_id=%s",
                (deposit_id, user["wallet_id"]),
            ).fetchone()
            conn.commit()
            return {
                "status": "confirmed",
                "recorded": True,
                "reference": reference_row[0] if reference_row else None,
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
        transaction_reference = generate_transaction_reference()
        conn.execute(
            """INSERT INTO transactions(
                 id,wallet_id,reference,type,asset,description,amount,status,destination,network,tx_hash,confirmations,block_height
               ) VALUES(%s,%s,%s,'received','BALMZ-SOL-DEVNET','BALMZ Devnet deposit',%s,'confirmed',%s,
                        'solana-devnet',%s,1,%s)""",
            (
                deposit_id, user["wallet_id"], transaction_reference, amount,
                destination_wallet, tx_signature,
                slot if isinstance(slot, int) and slot <= 2147483647 else None,
            ),
        )
        record_wallet_audit_event(
            conn, owner_id=user["id"], wallet_id=user["wallet_id"], actor_email=user.get("email") or ("user:" + str(user["id"])),
            action="deposit_verified", resource="transaction", resource_id=deposit_id,
            network="solana-devnet", reference=transaction_reference,
            details={"asset": "BALMZ-SOL-DEVNET", "amount": str(amount), "slot": slot, "finality": "finalized", "mainnet_funding": False},
        )
        conn.commit()

    return {
        "status": "confirmed",
        "recorded": True,
        "reference": transaction_reference,
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


def reconcile_settled_asset(conn, user, symbol, network, source_address=None):
    # Re-read the exact source wallet used by this transaction; do not silently
    # reconcile a different attached address on the same network.
    address = source_address or wallet_network_address(user, network)
    value = None
    try:
        if symbol == "BTC" and address:
            value = btc_balance(address)
        elif symbol in {"ETH", "BNB"} and address:
            rpc = ETH_RPC_URL if network == "ethereum" else BSC_RPC_URL if network == "bnb" else SEPOLIA_RPC_URL if network == "sepolia" else ""
            if network == "ethereum": require_ethereum_mainnet_rpc(rpc)
            elif network == "sepolia": require_sepolia_rpc(rpc)
            elif network == "bnb": require_bnb_rpc(rpc)
            value = evm_balance(rpc, address)
        elif symbol == "BALMZ-SOL-DEVNET" and network == "solana-devnet" and address:
            value = solana_spl_token_balance(
                address, BALMZ_SOLANA_DEVNET_MINT,
                BALMZ_SOLANA_DEVNET_DECIMALS,
            )
        elif symbol in {"USDT", "USDT-BNB", "BALMZ", "BALMZ-SEP"} and address:
            if symbol == "BALMZ":
                contract = BALMZ_ETH_CONTRACT if network == "ethereum" else ""
                rpc = ETH_RPC_URL if network == "ethereum" else ""
            elif symbol == "BALMZ-SEP":
                contract = BALMZ_SEPOLIA_CONTRACT if network == "sepolia" else ""
                rpc = SEPOLIA_RPC_URL if network == "sepolia" else ""
                if rpc: require_sepolia_rpc(rpc)
            elif network == "ethereum":
                contract, rpc = USDT_ETH_CONTRACT, ETH_RPC_URL
            elif network == "bnb":
                contract, rpc = USDT_BSC_CONTRACT, BSC_RPC_URL
                if rpc: require_bnb_rpc(rpc)
            else:
                contract, rpc = "", ""
            if contract and rpc:
                token_decimals = verified_erc20_decimals(rpc, contract, network, chain_checked=True) if network == "bnb" else 18
                value = erc20_balance(rpc, contract, address, token_decimals)
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
            "SELECT id,asset,amount,status,destination,network,tx_hash,from_address,type,reference FROM transactions WHERE id=%s AND wallet_id=%s FOR UPDATE",
            (txid,user["wallet_id"]),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404,detail="Transaction not found")
        txid,symbol,amount,status,destination,network,existing_hash,source_address,transaction_type,transaction_reference=row
        if status in {"confirmed","settled"}:
            return {"status":"confirmed","transaction_id":txid,"reference":transaction_reference,"tx_hash":existing_hash,"replayed":True}
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
            if not source_address and transaction_type == "withdrawal":
                raise HTTPException(status_code=409,detail="This withdrawal has no recorded source address and cannot be settled automatically")
            source_address=source_address or wallet_network_address(user,"bitcoin")
            verification=verify_bitcoin_settlement(tx_hash,destination,abs(Decimal(amount)),source_address)
        elif network in {"ethereum","bnb","sepolia"}:
            if not EVM_TX_HASH_RE.fullmatch(tx_hash):
                raise HTTPException(status_code=400,detail="Invalid EVM transaction hash")
            if not source_address and transaction_type == "withdrawal":
                raise HTTPException(status_code=409,detail="This withdrawal has no recorded source address and cannot be settled automatically")
            source_address = source_address or wallet_network_address(user,network)
            verification=verify_evm_settlement(tx_hash,symbol,network,destination,abs(Decimal(amount)),source_address)
        else:
            raise HTTPException(status_code=400,detail="Unsupported settlement network")

        if verification["state"] == "not_found":
            raise HTTPException(status_code=404,detail="Blockchain transaction was not found")
        if verification["state"] == "pending":
            conn.execute(
                "UPDATE transactions SET tx_hash=%s,status='broadcast_pending',confirmations=%s,block_height=%s WHERE id=%s AND wallet_id=%s",
                (tx_hash,verification.get("confirmations",0),verification.get("block_height"),txid),
            )
            if not existing_hash:
                record_wallet_audit_event(
                    conn, owner_id=user["id"], wallet_id=user["wallet_id"], actor_email=user.get("email") or ("user:" + str(user["id"])),
                    action="chain_transaction_observed", resource="transaction", resource_id=txid,
                    network=network, reference=transaction_reference,
                    details={"asset": symbol, "tx_hash": tx_hash, "confirmations": verification.get("confirmations", 0), "status": "broadcast_pending"},
                )
            conn.commit()
            return {"status":"broadcast_pending","transaction_id":txid,"reference":transaction_reference,"tx_hash":tx_hash,"confirmations":verification.get("confirmations",0),"finality":verification.get("finality"),"broadcast":False}

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
        reconcile_settled_asset(conn,user,symbol,network,source_address)
        record_wallet_audit_event(
            conn, owner_id=user["id"], wallet_id=user["wallet_id"], actor_email=user.get("email") or ("user:" + str(user["id"])),
            action="transaction_settled", resource="transaction", resource_id=txid,
            network=network, reference=transaction_reference,
            details={"asset": symbol, "tx_hash": tx_hash, "confirmations": verification.get("confirmations", 0), "block_height": verification.get("block_height")},
        )
        conn.commit()
        return {
            "status":"confirmed",
            "transaction_id":txid,
            "reference":transaction_reference,
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
        row=conn.execute("SELECT id,asset,amount,status,tx_hash,reference FROM transactions WHERE id=%s AND wallet_id=%s FOR UPDATE",(txid,user["wallet_id"])).fetchone()
        if not row: raise HTTPException(status_code=404,detail="Transaction not found")
        txid,symbol,amount,status,tx_hash,transaction_reference=row
        if status not in {"pending","pending_review"} or tx_hash: raise HTTPException(status_code=409,detail="Only unbroadcast pending requests can be cancelled")
        hold=-Decimal(amount)
        if not asset or Decimal(asset[0] or 0)<hold: raise HTTPException(status_code=409,detail="Reservation state is inconsistent; manual review required")
        conn.execute("UPDATE assets SET reserved_balance=reserved_balance-%s WHERE wallet_id=%s AND symbol=%s",(hold,user["wallet_id"],symbol))
        conn.execute("UPDATE transactions SET status='cancelled' WHERE id=%s AND wallet_id=%s",(txid,user["wallet_id"]))
        record_wallet_audit_event(
            conn, owner_id=user["id"], wallet_id=user["wallet_id"], actor_email=user.get("email") or ("user:" + str(user["id"])),
            action="transaction_cancelled", resource="transaction", resource_id=txid,
            reference=transaction_reference,
            details={"asset": symbol, "released": str(hold), "status": "cancelled"},
        )
        conn.commit()
    return {"status":"cancelled","transaction_id":txid,"reference":transaction_reference,"asset":symbol,"released":float(hold)}


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
