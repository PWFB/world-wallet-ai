"""Official Plaid BankConnect integration for BALMZ AI APT.

Plaid credentials and access tokens stay server-side. The Android client receives
only short-lived Link tokens and sanitized account metadata.
"""
import base64
import hashlib
import logging
import os
import re
import secrets
import smtplib
import hmac
from email.message import EmailMessage
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


class BankEmailRequest(BaseModel):
    owner_email: str = Field(min_length=5, max_length=254)
    otp_email: str = Field(min_length=5, max_length=254)


class BankEmailCodeRequest(BaseModel):
    code: str = Field(pattern=r"^[0-9]{6}$")


def build_bankconnect_router(db_factory: Callable, current_user_dependency: Callable):
    router = APIRouter(prefix="/api/v1/bankconnect", tags=["BankConnect"])


    def _ensure_email_tables(conn):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS bankconnect_email_profiles (
                owner_id TEXT NOT NULL,
                wallet_id TEXT NOT NULL,
                owner_email TEXT NOT NULL,
                otp_email TEXT NOT NULL,
                verified_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY(owner_id, wallet_id)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS bankconnect_email_challenges (
                id BIGSERIAL PRIMARY KEY,
                owner_id TEXT NOT NULL,
                wallet_id TEXT NOT NULL,
                owner_email TEXT NOT NULL,
                otp_email TEXT NOT NULL,
                code_hash TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                expires_at TIMESTAMPTZ NOT NULL,
                used_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_bankconnect_email_challenge_lookup
            ON bankconnect_email_challenges(owner_id,wallet_id,created_at DESC)
        """)

    def _email_sender_config():
        host = os.getenv("BANKCONNECT_SMTP_HOST", "smtp.gmail.com").strip()
        try:
            port = int(os.getenv("BANKCONNECT_SMTP_PORT", "465").strip())
        except ValueError as exc:
            raise HTTPException(status_code=503, detail="BANKCONNECT_SMTP_PORT must be a valid port number.") from exc
        username = os.getenv("BANKCONNECT_SMTP_USERNAME", "").strip()
        password = os.getenv("BANKCONNECT_SMTP_APP_PASSWORD", "").replace(" ", "").strip()
        from_email = os.getenv("BANKCONNECT_SMTP_FROM_EMAIL", username).strip()
        from_name = os.getenv("BANKCONNECT_SMTP_FROM_NAME", "BALMZ AI APT").strip()
        if not (host and 1 <= port <= 65535 and username and password and from_email):
            raise HTTPException(
                status_code=503,
                detail="BALMZ code email is not configured. Set BANKCONNECT_SMTP_USERNAME, BANKCONNECT_SMTP_APP_PASSWORD and BANKCONNECT_SMTP_FROM_EMAIL on the backend.",
            )
        return host, port, username, password, from_email, from_name

    def _send_bankconnect_code(recipient: str, code: str):
        host, port, username, password, from_email, from_name = _email_sender_config()
        message = EmailMessage()
        message["Subject"] = "Your BALMZ AI APT BankConnect verification code"
        message["From"] = f"{from_name} <{from_email}>"
        message["To"] = recipient
        message.set_content(
            "Your BALMZ AI APT BankConnect verification code is: "
            + code
            + "\\n\\nThis BALMZ security code expires in 10 minutes and can be used once. "
              "It verifies the BALMZ email destination only. It is NOT a bank-issued OTP and cannot replace a code sent by your bank. "
              "Never share this code with anyone. If you did not request it, you can ignore this email."
        )
        try:
            if port == 465:
                with smtplib.SMTP_SSL(host, port, timeout=20) as smtp:
                    smtp.login(username, password)
                    smtp.send_message(message, from_addr=from_email, to_addrs=[recipient])
            else:
                with smtplib.SMTP(host, port, timeout=20) as smtp:
                    smtp.ehlo()
                    smtp.starttls()
                    smtp.ehlo()
                    smtp.login(username, password)
                    smtp.send_message(message, from_addr=from_email, to_addrs=[recipient])
        except Exception as exc:
            logger.warning("BankConnect verification email delivery failed: error_type=%s", type(exc).__name__)
            raise HTTPException(status_code=502, detail="BALMZ could not deliver the verification email. Check the dedicated BankConnect email sender configuration.") from exc

    def _normalize_email(value: str, label: str):
        normalized = str(value or "").strip().lower()
        if len(normalized) > 254 or not re.fullmatch(r"[^@\\s]+@[^@\\s]+\\.[^@\\s]+", normalized):
            raise HTTPException(status_code=400, detail=f"Enter a valid {label} email address.")
        return normalized

    def _require_verified_email(user):
        wallet_id = str(user.get("wallet_id") or "").strip()
        if not wallet_id:
            raise HTTPException(status_code=409, detail="Create or select a BALMZ wallet before BankConnect.")
        with db_factory() as conn:
            _ensure_email_tables(conn)
            row = conn.execute("""
                SELECT verified_at FROM bankconnect_email_profiles
                WHERE owner_id=%s AND wallet_id=%s
            """, (str(user["id"]), wallet_id)).fetchone()
        if not row or not row[0]:
            raise HTTPException(
                status_code=409,
                detail="Add the account holder Gmail and the BALMZ code-delivery Gmail, then verify the BALMZ code before connecting a bank.",
            )

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


    @router.get("/email/settings")
    def get_bankconnect_email_settings(user=Depends(current_user_dependency)):
        wallet_id = str(user.get("wallet_id") or "").strip()
        if not wallet_id:
            raise HTTPException(status_code=409, detail="Create or select a BALMZ wallet before configuring BankConnect email.")
        with db_factory() as conn:
            _ensure_email_tables(conn)
            row = conn.execute("""
                SELECT owner_email,otp_email,verified_at
                FROM bankconnect_email_profiles WHERE owner_id=%s AND wallet_id=%s
            """, (str(user["id"]), wallet_id)).fetchone()
        return {
            "owner_email": str(row[0]) if row else "",
            "otp_email": str(row[1]) if row else "",
            "verified": bool(row and row[2]),
            "code_delivery": "BALMZ email verification only; bank OTP remains bank-controlled",
        }

    @router.post("/email/request-code")
    def request_bankconnect_email_code(request: BankEmailRequest, user=Depends(current_user_dependency)):
        wallet_id = str(user.get("wallet_id") or "").strip()
        if not wallet_id:
            raise HTTPException(status_code=409, detail="Create or select a BALMZ wallet before configuring BankConnect email.")
        owner_email = _normalize_email(request.owner_email, "account holder")
        otp_email = _normalize_email(request.otp_email, "BALMZ code-delivery")
        # Validate sender configuration before creating a challenge.
        _email_sender_config()
        code = f"{secrets.randbelow(900000) + 100000:06d}"
        challenge_secret = _encryption_key()
        code_hash = hmac.new(
            challenge_secret,
            f"{user['id']}:{wallet_id}:{otp_email}:{code}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        with db_factory() as conn:
            _ensure_email_tables(conn)
            recent = conn.execute("""
                SELECT COUNT(*) FROM bankconnect_email_challenges
                WHERE owner_id=%s AND wallet_id=%s AND created_at > NOW()-INTERVAL '15 minutes'
            """, (str(user["id"]), wallet_id)).fetchone()
            if int(recent[0] or 0) >= 5:
                raise HTTPException(status_code=429, detail="Too many BankConnect email-code requests. Try again in 15 minutes.")
            conn.execute("""
                INSERT INTO bankconnect_email_profiles(owner_id,wallet_id,owner_email,otp_email,verified_at,updated_at)
                VALUES(%s,%s,%s,%s,NULL,NOW())
                ON CONFLICT(owner_id,wallet_id) DO UPDATE SET
                    owner_email=EXCLUDED.owner_email,
                    otp_email=EXCLUDED.otp_email,
                    verified_at=NULL,
                    updated_at=NOW()
            """, (str(user["id"]), wallet_id, owner_email, otp_email))
            conn.execute("""
                UPDATE bankconnect_email_challenges
                SET used_at=NOW()
                WHERE owner_id=%s AND wallet_id=%s AND used_at IS NULL
            """, (str(user["id"]), wallet_id))
            conn.execute("""
                INSERT INTO bankconnect_email_challenges
                    (owner_id,wallet_id,owner_email,otp_email,code_hash,expires_at)
                VALUES(%s,%s,%s,%s,%s,NOW()+INTERVAL '10 minutes')
            """, (str(user["id"]), wallet_id, owner_email, otp_email, code_hash))
            conn.commit()
        _send_bankconnect_code(otp_email, code)
        return {
            "sent": True,
            "otp_email": otp_email,
            "expires_in_seconds": 600,
            "message": "A BALMZ verification code was sent to the code-delivery email. This is not a bank-issued OTP.",
        }

    @router.post("/email/verify-code")
    def verify_bankconnect_email_code(request: BankEmailCodeRequest, user=Depends(current_user_dependency)):
        wallet_id = str(user.get("wallet_id") or "").strip()
        if not wallet_id:
            raise HTTPException(status_code=409, detail="Create or select a BALMZ wallet before verifying BankConnect email.")
        with db_factory() as conn:
            _ensure_email_tables(conn)
            row = conn.execute("""
                SELECT id,otp_email,code_hash,attempts
                FROM bankconnect_email_challenges
                WHERE owner_id=%s AND wallet_id=%s AND used_at IS NULL AND expires_at>NOW()
                ORDER BY created_at DESC LIMIT 1 FOR UPDATE
            """, (str(user["id"]), wallet_id)).fetchone()
            if not row:
                raise HTTPException(status_code=400, detail="No active BankConnect code was found. Request a new code.")
            challenge_id, otp_email, expected_hash, attempts = row
            if int(attempts or 0) >= 5:
                conn.execute("UPDATE bankconnect_email_challenges SET used_at=NOW() WHERE id=%s", (challenge_id,))
                conn.commit()
                raise HTTPException(status_code=429, detail="Too many incorrect attempts. Request a new BankConnect code.")
            candidate = hmac.new(
                _encryption_key(),
                f"{user['id']}:{wallet_id}:{otp_email}:{request.code}".encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()
            if not hmac.compare_digest(str(expected_hash), candidate):
                conn.execute("UPDATE bankconnect_email_challenges SET attempts=attempts+1 WHERE id=%s", (challenge_id,))
                conn.commit()
                raise HTTPException(status_code=400, detail="The BALMZ verification code is incorrect.")
            conn.execute("UPDATE bankconnect_email_challenges SET used_at=NOW() WHERE id=%s", (challenge_id,))
            conn.execute("""
                UPDATE bankconnect_email_profiles SET verified_at=NOW(),updated_at=NOW()
                WHERE owner_id=%s AND wallet_id=%s AND otp_email=%s
            """, (str(user["id"]), wallet_id, otp_email))
            conn.commit()
        return {"verified": True, "message": "BALMZ code-delivery email verified. You can now continue to official bank authentication."}

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
        _require_verified_email(user)
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
