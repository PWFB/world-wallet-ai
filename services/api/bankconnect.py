"""Official Plaid BankConnect integration for BALMZ AI APT.

Plaid credentials and access tokens stay server-side. The Android client receives
only short-lived Link tokens and sanitized account metadata.
"""
import base64
import hashlib
import logging
import os
from datetime import date, timedelta
from typing import Callable

import httpx
from Crypto.Cipher import AES
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

PLAID_CLIENT_ID = os.getenv("PLAID_CLIENT_ID", "").strip()
PLAID_SECRET = os.getenv("PLAID_SECRET", "").strip()
PLAID_ENV = os.getenv("PLAID_ENV", "sandbox").strip().lower()
PLAID_PRODUCTS = ["transactions"]
PLAID_COUNTRIES = ["US"]
PLAID_PACKAGE_NAME = "com.balmz.aptido"


class PublicTokenExchange(BaseModel):
    public_token: str = Field(min_length=20, max_length=4096)


class LinkTokenRequest(BaseModel):
    android_package_name: str = Field(default=PLAID_PACKAGE_NAME, max_length=128)


def build_bankconnect_router(db_factory: Callable, current_user_dependency: Callable):
    router = APIRouter(prefix="/api/v1/bankconnect", tags=["BankConnect"])

    def _config():
        if not (PLAID_CLIENT_ID and PLAID_SECRET):
            raise HTTPException(
                status_code=503,
                detail="BankConnect is not configured. The administrator must set PLAID_CLIENT_ID and PLAID_SECRET on the backend.",
            )
        if PLAID_ENV not in {"sandbox", "development", "production"}:
            raise HTTPException(status_code=503, detail="PLAID_ENV must be sandbox, development, or production.")
        return {
            "client_id": PLAID_CLIENT_ID,
            "secret": PLAID_SECRET,
            "base_url": f"https://{PLAID_ENV}.plaid.com",
        }

    def _encryption_key():
        value = os.getenv("WORLD_WALLET_SECRET_ENCRYPTION_KEY", "").strip()
        if not value:
            raise HTTPException(
                status_code=503,
                detail="BankConnect secure storage is unavailable. Configure WORLD_WALLET_SECRET_ENCRYPTION_KEY on the backend.",
            )
        return hashlib.sha256(value.encode("utf-8")).digest()

    def _encrypt(value: str):
        cipher = AES.new(_encryption_key(), AES.MODE_GCM)
        ciphertext, tag = cipher.encrypt_and_digest(value.encode("utf-8"))
        return tuple(base64.urlsafe_b64encode(part).decode("ascii") for part in (cipher.nonce, tag, ciphertext))

    def _decrypt(nonce: str, tag: str, ciphertext: str):
        try:
            cipher = AES.new(
                _encryption_key(),
                AES.MODE_GCM,
                nonce=base64.urlsafe_b64decode(nonce),
            )
            return cipher.decrypt_and_verify(
                base64.urlsafe_b64decode(ciphertext),
                base64.urlsafe_b64decode(tag),
            ).decode("utf-8")
        except HTTPException:
            raise
        except Exception as exc:
            logger.error("BankConnect token decryption failed: error_type=%s", type(exc).__name__)
            raise HTTPException(status_code=503, detail="A saved bank connection cannot be decrypted. Contact support.") from exc

    def _ensure_table(conn):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS bankconnect_items (
                id BIGSERIAL PRIMARY KEY,
                owner_id TEXT NOT NULL,
                wallet_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                institution_id TEXT,
                institution_name TEXT NOT NULL DEFAULT 'Connected bank',
                access_token_nonce TEXT NOT NULL,
                access_token_tag TEXT NOT NULL,
                encrypted_access_token TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(owner_id, item_id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_bankconnect_items_owner ON bankconnect_items(owner_id, created_at DESC)")

    async def _plaid_post(path: str, payload: dict):
        config = _config()
        body = {
            "client_id": config["client_id"],
            "secret": config["secret"],
            **payload,
        }
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(25.0, connect=8.0)) as client:
                response = await client.post(
                    config["base_url"] + path,
                    json=body,
                    headers={"Content-Type": "application/json", "Plaid-Version": "2020-09-14"},
                )
        except httpx.TimeoutException as exc:
            raise HTTPException(status_code=504, detail="The bank connection provider timed out. Try again.") from exc
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail="The bank connection provider could not be reached.") from exc
        if not response.is_success:
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            code = str(payload.get("error_code") or "")
            logger.warning("Plaid request failed: endpoint=%s status=%s code=%s", path, response.status_code, code[:80])
            if code in {"INVALID_ACCESS_TOKEN", "ITEM_LOGIN_REQUIRED"}:
                raise HTTPException(status_code=409, detail="This bank connection needs to be repaired. Reconnect the bank through BankConnect.")
            if response.status_code in {401, 403}:
                raise HTTPException(status_code=503, detail="BankConnect provider credentials or product access are not valid.")
            raise HTTPException(status_code=502, detail="The bank provider could not complete this request. Try again later.")
        try:
            return response.json()
        except ValueError as exc:
            raise HTTPException(status_code=502, detail="The bank provider returned an unreadable response.") from exc

    @router.get("/status")
    def bankconnect_status(user=Depends(current_user_dependency)):
        return {
            "provider": "Plaid",
            "configured": bool(PLAID_CLIENT_ID and PLAID_SECRET and os.getenv("WORLD_WALLET_SECRET_ENCRYPTION_KEY", "").strip()),
            "environment": PLAID_ENV if PLAID_ENV in {"sandbox", "development", "production"} else "unconfigured",
            "country_codes": PLAID_COUNTRIES,
            "products": PLAID_PRODUCTS,
            "read_only": True,
        }

    @router.post("/link-token")
    async def create_link_token(request: LinkTokenRequest, user=Depends(current_user_dependency)):
        config = _config()
        _encryption_key()
        if request.android_package_name not in {PLAID_PACKAGE_NAME, PLAID_PACKAGE_NAME + ".debug"}:
            raise HTTPException(status_code=400, detail="The Android package name is not an approved BALMZ APT application ID.")
        client_user_id = hashlib.sha256(str(user["id"]).encode("utf-8")).hexdigest()
        result = await _plaid_post("/link/token/create", {
            "user": {"client_user_id": client_user_id},
            "client_name": "BALMZ AI APT",
            "products": PLAID_PRODUCTS,
            "country_codes": PLAID_COUNTRIES,
            "language": "en",
            "android_package_name": request.android_package_name,
        })
        token = str(result.get("link_token") or "")
        if not token:
            raise HTTPException(status_code=502, detail="The bank provider did not return a Link token.")
        return {
            "link_token": token,
            "expiration": result.get("expiration"),
            "request_id": result.get("request_id"),
            "provider": "Plaid",
            "environment": PLAID_ENV,
        }

    @router.post("/exchange")
    async def exchange_public_token(request: PublicTokenExchange, user=Depends(current_user_dependency)):
        if not str(user.get("wallet_id") or "").strip():
            raise HTTPException(status_code=409, detail="Create or select a BALMZ wallet before linking a bank.")
        result = await _plaid_post("/item/public_token/exchange", {"public_token": request.public_token})
        access_token = str(result.get("access_token") or "")
        item_id = str(result.get("item_id") or "")
        if not access_token or not item_id:
            raise HTTPException(status_code=502, detail="The bank provider returned incomplete connection details.")
        nonce, tag, encrypted = _encrypt(access_token)
        institution_id = ""
        institution_name = "Connected bank"
        # The provider Item lookup is authoritative; never trust institution names from the device.
        try:
            item_result = await _plaid_post("/item/get", {"access_token": access_token})
            institution_id = str((item_result.get("item") or {}).get("institution_id") or "")
            if institution_id:
                institution = await _plaid_post("/institutions/get_by_id", {
                    "institution_id": institution_id,
                    "country_codes": PLAID_COUNTRIES,
                    "options": {"include_optional_metadata": True},
                })
                institution_name = str((institution.get("institution") or {}).get("name") or institution_name)[:160]
        except HTTPException:
            # Token exchange already succeeded. Preserve the encrypted connection even if
            # optional institution-name enrichment is temporarily unavailable.
            logger.warning("BankConnect institution metadata lookup failed; retaining linked Item")
        with db_factory() as conn:
            _ensure_table(conn)
            conn.execute("""
                INSERT INTO bankconnect_items
                    (owner_id,wallet_id,item_id,institution_id,institution_name,
                     access_token_nonce,access_token_tag,encrypted_access_token,updated_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,NOW())
                ON CONFLICT(owner_id,item_id) DO UPDATE SET
                    wallet_id=EXCLUDED.wallet_id,
                    institution_id=EXCLUDED.institution_id,
                    institution_name=EXCLUDED.institution_name,
                    access_token_nonce=EXCLUDED.access_token_nonce,
                    access_token_tag=EXCLUDED.access_token_tag,
                    encrypted_access_token=EXCLUDED.encrypted_access_token,
                    updated_at=NOW()
            """, (str(user["id"]), str(user["wallet_id"]), item_id, institution_id, institution_name, nonce, tag, encrypted))
            conn.commit()
        return {"connected": True, "institution_name": institution_name, "message": "Bank connected securely. Account details are read-only."}

    @router.get("/accounts")
    async def list_bank_accounts(user=Depends(current_user_dependency)):
        with db_factory() as conn:
            _ensure_table(conn)
            rows = conn.execute("""
                SELECT id,item_id,institution_name,access_token_nonce,access_token_tag,encrypted_access_token,created_at
                FROM bankconnect_items WHERE owner_id=%s AND wallet_id=%s ORDER BY created_at DESC
            """, (str(user["id"]), str(user.get("wallet_id") or ""))).fetchall()
        output = []
        for row in rows:
            access_token = _decrypt(row[3], row[4], row[5])
            result = await _plaid_post("/accounts/get", {"access_token": access_token})
            for account in result.get("accounts", []):
                balances = account.get("balances") or {}
                output.append({
                    "connection_id": str(row[0]),
                    "institution_name": str(row[2]),
                    "account_id": str(account.get("account_id") or ""),
                    "name": str(account.get("name") or "Bank account")[:120],
                    "official_name": str(account.get("official_name") or "")[:120],
                    "mask": str(account.get("mask") or ""),
                    "type": str(account.get("type") or ""),
                    "subtype": str(account.get("subtype") or ""),
                    "currency": str((balances.get("iso_currency_code") or balances.get("unofficial_currency_code") or "USD")),
                    "available_balance": balances.get("available"),
                    "current_balance": balances.get("current"),
                    "limit": balances.get("limit"),
                })
        return {"accounts": output, "count": len(output), "read_only": True}

    @router.get("/transactions")
    async def list_bank_transactions(user=Depends(current_user_dependency)):
        with db_factory() as conn:
            _ensure_table(conn)
            rows = conn.execute("""
                SELECT item_id,institution_name,access_token_nonce,access_token_tag,encrypted_access_token
                FROM bankconnect_items WHERE owner_id=%s AND wallet_id=%s ORDER BY created_at DESC
            """, (str(user["id"]), str(user.get("wallet_id") or ""))).fetchall()
        today = date.today()
        start_date = (today - timedelta(days=30)).isoformat()
        end_date = today.isoformat()
        output = []
        for row in rows:
            access_token = _decrypt(row[2], row[3], row[4])
            result = await _plaid_post("/transactions/get", {
                "access_token": access_token,
                "start_date": start_date,
                "end_date": end_date,
                "options": {"count": 100, "offset": 0},
            })
            account_map = {
                str(account.get("account_id") or ""): account
                for account in result.get("accounts", [])
                if isinstance(account, dict)
            }
            for transaction in result.get("transactions", []):
                if not isinstance(transaction, dict):
                    continue
                account = account_map.get(str(transaction.get("account_id") or ""), {})
                output.append({
                    "institution_name": str(row[1]),
                    "transaction_id": str(transaction.get("transaction_id") or ""),
                    "account_name": str(account.get("name") or "Bank account")[:120],
                    "account_mask": str(account.get("mask") or ""),
                    "date": str(transaction.get("date") or ""),
                    "name": str(transaction.get("name") or "Transaction")[:180],
                    "merchant_name": str(transaction.get("merchant_name") or "")[:160],
                    "amount": transaction.get("amount"),
                    "currency": str(transaction.get("iso_currency_code") or "USD"),
                    "pending": bool(transaction.get("pending")),
                    "category": transaction.get("personal_finance_category", {}).get("primary")
                        if isinstance(transaction.get("personal_finance_category"), dict)
                        else None,
                })
        output.sort(key=lambda item: item["date"], reverse=True)
        return {"transactions": output[:200], "count": min(len(output), 200), "period_days": 30, "read_only": True}

    @router.delete("/connections/{connection_id}")
    async def disconnect_bank(connection_id: int, user=Depends(current_user_dependency)):
        with db_factory() as conn:
            _ensure_table(conn)
            row = conn.execute("""
                SELECT item_id,access_token_nonce,access_token_tag,encrypted_access_token
                FROM bankconnect_items WHERE id=%s AND owner_id=%s AND wallet_id=%s
            """, (connection_id, str(user["id"]), str(user.get("wallet_id") or ""))).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Bank connection not found.")
        access_token = _decrypt(row[1], row[2], row[3])
        await _plaid_post("/item/remove", {"access_token": access_token})
        with db_factory() as conn:
            _ensure_table(conn)
            conn.execute("DELETE FROM bankconnect_items WHERE id=%s AND owner_id=%s", (connection_id, str(user["id"])))
            conn.commit()
        return {"disconnected": True}

    return router
