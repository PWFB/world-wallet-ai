"""Step-up email verification for local wallet-vault secret reveals.

The local encrypted wallet and password are never uploaded. This router only
sends and verifies server-generated BALMZ access codes and one-time grants.
"""
import hashlib
import hmac
import logging
import os
import re
import secrets
import smtplib
from email.message import EmailMessage
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

CODE_TTL_SECONDS = 300
GRANT_TTL_SECONDS = 300
MAX_CODE_ATTEMPTS = 5
MAX_CODE_REQUESTS_PER_15_MINUTES = 3


class ReceiverEmailRequest(BaseModel):
    receiver_email: str = Field(min_length=6, max_length=254)


class VaultEmailCodeRequest(BaseModel):
    code: str = Field(pattern=r"^[0-9]{6}$")


class VaultGrantRequest(BaseModel):
    grant_token: str = Field(min_length=32, max_length=512)


def normalize_gmail(value: str) -> str:
    email = str(value or "").strip().lower()
    if len(email) > 254 or not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:gmail\.com|googlemail\.com)", email):
        raise HTTPException(status_code=400, detail="Enter a valid Gmail address for Secret Room code delivery.")
    return email


def _security_secret() -> bytes:
    value = os.getenv("WORLD_WALLET_SECRET_ENCRYPTION_KEY", "").strip()
    if not value:
        raise HTTPException(
            status_code=503,
            detail="Secret Room email verification is unavailable until the backend security encryption key is configured.",
        )
    return hashlib.sha256(value.encode("utf-8")).digest()


def _sender_config():
    host = os.getenv("BANKCONNECT_SMTP_HOST", "smtp.gmail.com").strip()
    try:
        port = int(os.getenv("BANKCONNECT_SMTP_PORT", "465").strip())
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="The backend email sender port is invalid.") from exc
    username = os.getenv("BANKCONNECT_SMTP_USERNAME", "").strip()
    password = os.getenv("BANKCONNECT_SMTP_APP_PASSWORD", "").replace(" ", "").strip()
    from_email = os.getenv("BANKCONNECT_SMTP_FROM_EMAIL", username).strip()
    from_name = os.getenv("BANKCONNECT_SMTP_FROM_NAME", "World Wallet AI").strip()
    if not (host and 1 <= port <= 65535 and username and password and from_email):
        raise HTTPException(
            status_code=503,
            detail="Secret Room email delivery is not configured. Configure the backend BANKCONNECT_SMTP sender settings.",
        )
    return host, port, username, password, from_email, from_name


def _send_security_code(recipient: str, code: str, purpose: str) -> None:
    host, port, username, password, from_email, from_name = _sender_config()
    message = EmailMessage()
    if purpose == "enroll":
        message["Subject"] = "Verify your World Wallet AI Secret Room email"
        intro = "Your World Wallet AI Secret Room email verification code is: "
    else:
        message["Subject"] = "Your World Wallet AI Secret Room access code"
        intro = "Your World Wallet AI Secret Room access code is: "
    message["From"] = f"{from_name} <{from_email}>"
    message["To"] = recipient
    message.set_content(
        intro + code
        + "\n\nThis code expires in 5 minutes and can be used once. "
          "It was requested for a sensitive local wallet-vault action. "
          "World Wallet AI will never ask you to reply with this code. "
          "Never share it with anyone. If you did not request it, ignore this message."
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
        logger.warning("Secret Room code delivery failed: error_type=%s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="World Wallet AI could not deliver the Secret Room email. No access was granted.") from exc


def _code_hash(owner_id: str, purpose: str, receiver_email: str, code: str) -> str:
    payload = f"{owner_id}:{purpose}:{receiver_email}:{code}".encode("utf-8")
    return hmac.new(_security_secret(), payload, hashlib.sha256).hexdigest()


def build_vault_security_router(db_factory: Callable, current_user_dependency: Callable):
    router = APIRouter(prefix="/api/v1/vault-security", tags=["Vault Security"])

    def _ensure_schema(conn):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS world_wallet_vault_security_emails (
                owner_id TEXT PRIMARY KEY,
                account_email TEXT NOT NULL,
                receiver_email TEXT NOT NULL,
                verified_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS world_wallet_vault_security_challenges (
                id BIGSERIAL PRIMARY KEY,
                owner_id TEXT NOT NULL,
                purpose TEXT NOT NULL,
                receiver_email TEXT NOT NULL,
                code_hash TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                expires_at TIMESTAMPTZ NOT NULL,
                used_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_world_wallet_vault_challenges
            ON world_wallet_vault_security_challenges(owner_id,purpose,created_at DESC)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS world_wallet_vault_security_grants (
                id BIGSERIAL PRIMARY KEY,
                owner_id TEXT NOT NULL,
                token_hash TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                used_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_world_wallet_vault_grants
            ON world_wallet_vault_security_grants(owner_id,created_at DESC)
        """)

    def _identity(user):
        owner_id = str((user or {}).get("id") or "").strip()
        account_email = str((user or {}).get("email") or "").strip().lower()
        if not owner_id or not account_email:
            raise HTTPException(status_code=401, detail="A verified World Wallet AI account session is required.")
        return owner_id, account_email

    def _new_challenge(conn, owner_id: str, purpose: str, receiver_email: str):
        recent = conn.execute("""
            SELECT COUNT(*) FROM world_wallet_vault_security_challenges
            WHERE owner_id=%s AND purpose=%s AND created_at>NOW()-INTERVAL '15 minutes'
        """, (owner_id, purpose)).fetchone()
        if int(recent[0] or 0) >= MAX_CODE_REQUESTS_PER_15_MINUTES:
            raise HTTPException(status_code=429, detail="Too many Secret Room code requests. Try again in 15 minutes.")

        conn.execute("""
            UPDATE world_wallet_vault_security_challenges SET used_at=NOW()
            WHERE owner_id=%s AND purpose=%s AND used_at IS NULL
        """, (owner_id, purpose))
        code = f"{secrets.randbelow(900000) + 100000:06d}"
        conn.execute("""
            INSERT INTO world_wallet_vault_security_challenges
                (owner_id,purpose,receiver_email,code_hash,expires_at)
            VALUES(%s,%s,%s,%s,NOW()+INTERVAL '5 minutes')
        """, (owner_id, purpose, receiver_email, _code_hash(owner_id, purpose, receiver_email, code)))
        return code

    def _verify_challenge(conn, owner_id: str, purpose: str, receiver_email: str, code: str):
        row = conn.execute("""
            SELECT id,receiver_email,code_hash,attempts
            FROM world_wallet_vault_security_challenges
            WHERE owner_id=%s AND purpose=%s AND used_at IS NULL AND expires_at>NOW()
            ORDER BY created_at DESC LIMIT 1 FOR UPDATE
        """, (owner_id, purpose)).fetchone()
        if not row:
            raise HTTPException(status_code=400, detail="No active Secret Room code was found. Request a new code.")
        challenge_id, challenge_email, expected_hash, attempts = row
        if str(challenge_email).lower() != receiver_email:
            raise HTTPException(status_code=400, detail="The Secret Room code does not match the registered receiver Gmail.")
        if int(attempts or 0) >= MAX_CODE_ATTEMPTS:
            conn.execute(
                "UPDATE world_wallet_vault_security_challenges SET used_at=NOW() WHERE id=%s",
                (challenge_id,),
            )
            conn.commit()
            raise HTTPException(status_code=429, detail="Too many incorrect Secret Room code attempts. Request a new code.")
        candidate = _code_hash(owner_id, purpose, receiver_email, code)
        if not hmac.compare_digest(str(expected_hash), candidate):
            conn.execute(
                "UPDATE world_wallet_vault_security_challenges SET attempts=attempts+1 WHERE id=%s",
                (challenge_id,),
            )
            conn.commit()
            raise HTTPException(status_code=400, detail="The Secret Room one-time code is incorrect.")
        conn.execute(
            "UPDATE world_wallet_vault_security_challenges SET used_at=NOW() WHERE id=%s",
            (challenge_id,),
        )
        return challenge_id

    @router.get("/email/status")
    def get_receiver_email_status(user=Depends(current_user_dependency)):
        owner_id, _ = _identity(user)
        with db_factory() as conn:
            _ensure_schema(conn)
            row = conn.execute("""
                SELECT receiver_email,verified_at
                FROM world_wallet_vault_security_emails WHERE owner_id=%s
            """, (owner_id,)).fetchone()
        return {
            "configured": bool(row and row[0]),
            "verified": bool(row and row[1]),
            "receiver_email": str(row[0]) if row else "",
        }

    @router.post("/email/enroll")
    def enroll_receiver_email(request: ReceiverEmailRequest, user=Depends(current_user_dependency)):
        owner_id, account_email = _identity(user)
        receiver_email = normalize_gmail(request.receiver_email)
        _security_secret()
        _sender_config()
        with db_factory() as conn:
            _ensure_schema(conn)
            profile = conn.execute("""
                SELECT receiver_email,verified_at
                FROM world_wallet_vault_security_emails WHERE owner_id=%s FOR UPDATE
            """, (owner_id,)).fetchone()
            if profile and profile[1]:
                if str(profile[0]).lower() != receiver_email:
                    raise HTTPException(status_code=409, detail="A verified Secret Room receiver is already registered. Changing it requires the account recovery process.")
                raise HTTPException(status_code=409, detail="This receiver Gmail is already verified. Request a Secret Room access code instead.")
            conn.execute("""
                INSERT INTO world_wallet_vault_security_emails
                    (owner_id,account_email,receiver_email,verified_at,updated_at)
                VALUES(%s,%s,%s,NULL,NOW())
                ON CONFLICT(owner_id) DO UPDATE SET
                    account_email=EXCLUDED.account_email,
                    receiver_email=EXCLUDED.receiver_email,
                    verified_at=NULL,
                    updated_at=NOW()
            """, (owner_id, account_email, receiver_email))
            code = _new_challenge(conn, owner_id, "enroll", receiver_email)
            conn.commit()
        try:
            _send_security_code(receiver_email, code, "enroll")
        except HTTPException:
            with db_factory() as conn:
                _ensure_schema(conn)
                conn.execute("""
                    UPDATE world_wallet_vault_security_challenges SET used_at=NOW()
                    WHERE owner_id=%s AND purpose='enroll' AND used_at IS NULL
                """, (owner_id,))
                conn.commit()
            raise
        return {
            "sent": True,
            "receiver_email": receiver_email,
            "expires_in_seconds": CODE_TTL_SECONDS,
            "message": "A real World Wallet AI verification code was sent to the receiver Gmail.",
        }

    @router.post("/email/verify")
    def verify_receiver_email(request: VaultEmailCodeRequest, user=Depends(current_user_dependency)):
        owner_id, account_email = _identity(user)
        with db_factory() as conn:
            _ensure_schema(conn)
            profile = conn.execute("""
                SELECT receiver_email,verified_at
                FROM world_wallet_vault_security_emails WHERE owner_id=%s FOR UPDATE
            """, (owner_id,)).fetchone()
            if not profile or profile[1]:
                raise HTTPException(status_code=409, detail="Start receiver Gmail verification before entering a code.")
            receiver_email = str(profile[0]).lower()
            _verify_challenge(conn, owner_id, "enroll", receiver_email, request.code)
            conn.execute("""
                UPDATE world_wallet_vault_security_emails
                SET account_email=%s,verified_at=NOW(),updated_at=NOW()
                WHERE owner_id=%s AND receiver_email=%s
            """, (account_email, owner_id, receiver_email))
            conn.commit()
        return {"verified": True, "receiver_email": receiver_email, "message": "Secret Room receiver Gmail verified."}

    @router.post("/access/request")
    def request_secret_room_access_code(user=Depends(current_user_dependency)):
        owner_id, _ = _identity(user)
        _security_secret()
        _sender_config()
        with db_factory() as conn:
            _ensure_schema(conn)
            profile = conn.execute("""
                SELECT receiver_email,verified_at
                FROM world_wallet_vault_security_emails WHERE owner_id=%s
            """, (owner_id,)).fetchone()
            if not profile or not profile[1]:
                raise HTTPException(status_code=409, detail="Register and verify a receiver Gmail before opening the Secret Room.")
            receiver_email = str(profile[0]).lower()
            conn.execute("""
                UPDATE world_wallet_vault_security_grants SET used_at=NOW()
                WHERE owner_id=%s AND used_at IS NULL
            """, (owner_id,))
            code = _new_challenge(conn, owner_id, "access", receiver_email)
            conn.commit()
        try:
            _send_security_code(receiver_email, code, "access")
        except HTTPException:
            with db_factory() as conn:
                _ensure_schema(conn)
                conn.execute("""
                    UPDATE world_wallet_vault_security_challenges SET used_at=NOW()
                    WHERE owner_id=%s AND purpose='access' AND used_at IS NULL
                """, (owner_id,))
                conn.commit()
            raise
        return {
            "sent": True,
            "receiver_email": receiver_email,
            "expires_in_seconds": CODE_TTL_SECONDS,
            "message": "A real one-time Secret Room access code was sent to the verified receiver Gmail.",
        }

    @router.post("/access/verify")
    def verify_secret_room_access_code(request: VaultEmailCodeRequest, user=Depends(current_user_dependency)):
        owner_id, _ = _identity(user)
        grant_token = "wwvaultgrant_" + secrets.token_urlsafe(32)
        with db_factory() as conn:
            _ensure_schema(conn)
            profile = conn.execute("""
                SELECT receiver_email,verified_at
                FROM world_wallet_vault_security_emails WHERE owner_id=%s
            """, (owner_id,)).fetchone()
            if not profile or not profile[1]:
                raise HTTPException(status_code=409, detail="The Secret Room receiver Gmail is not verified.")
            receiver_email = str(profile[0]).lower()
            _verify_challenge(conn, owner_id, "access", receiver_email, request.code)
            conn.execute("""
                INSERT INTO world_wallet_vault_security_grants(owner_id,token_hash,expires_at)
                VALUES(%s,%s,NOW()+INTERVAL '5 minutes')
            """, (owner_id, hashlib.sha256(grant_token.encode("utf-8")).hexdigest()))
            conn.commit()
        return {
            "verified": True,
            "grant_token": grant_token,
            "expires_in_seconds": GRANT_TTL_SECONDS,
            "message": "Secret Room access code verified. Enter the local vault password to reveal the key.",
        }

    @router.post("/access/consume")
    def consume_secret_room_access_grant(request: VaultGrantRequest, user=Depends(current_user_dependency)):
        owner_id, _ = _identity(user)
        token_hash = hashlib.sha256(request.grant_token.encode("utf-8")).hexdigest()
        with db_factory() as conn:
            _ensure_schema(conn)
            row = conn.execute("""
                UPDATE world_wallet_vault_security_grants SET used_at=NOW()
                WHERE owner_id=%s AND token_hash=%s AND used_at IS NULL AND expires_at>NOW()
                RETURNING id
            """, (owner_id, token_hash)).fetchone()
            if not row:
                raise HTTPException(status_code=403, detail="Secret Room access expired or was already used. Request a new code.")
            conn.commit()
        return {"authorized": True, "single_use": True}

    return router
