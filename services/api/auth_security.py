"""Alternate-Gmail verification for authenticated BALMZ AI account password changes.

Neon Auth remains the source of truth for passwords. This router stores only
receiver-mailbox metadata, short-lived OTP hashes, and one-time verification grants.
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


class EmailCodeRequest(BaseModel):
    code: str = Field(pattern=r"^[0-9]{6}$")


class PasswordChangeGrantRequest(BaseModel):
    grant_token: str = Field(min_length=32, max_length=512)


def normalize_gmail(value: str) -> str:
    email = str(value or "").strip().lower()
    if len(email) > 254 or not re.fullmatch(
        r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:gmail\.com|googlemail\.com)", email
    ):
        raise HTTPException(status_code=400, detail="Enter a valid receiver Gmail address.")
    return email


def _security_secret() -> bytes:
    value = os.getenv("WORLD_WALLET_SECRET_ENCRYPTION_KEY", "").strip()
    if not value:
        raise HTTPException(
            status_code=503,
            detail="Account password-change verification is unavailable until the backend security encryption key is configured.",
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
    from_name = os.getenv("BANKCONNECT_SMTP_FROM_NAME", "BALMZ AI").strip()
    if not (host and 1 <= port <= 65535 and username and password and from_email):
        raise HTTPException(
            status_code=503,
            detail="Alternate-Gmail code delivery is not configured. Configure the backend BANKCONNECT_SMTP sender settings.",
        )
    return host, port, username, password, from_email, from_name


def _send_security_code(recipient: str, code: str, purpose: str) -> None:
    host, port, username, password, from_email, from_name = _sender_config()
    if purpose == "receiver_verify":
        subject = "Verify your BALMZ AI recovery Gmail"
        intro = "Your BALMZ AI receiver-Gmail verification code is: "
        action = "verify the alternate recovery Gmail for your account"
    else:
        subject = "Your BALMZ AI password-change verification code"
        intro = "Your BALMZ AI password-change code is: "
        action = "authorize a BALMZ AI account password change"
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = f"{from_name} <{from_email}>"
    message["To"] = recipient
    message.set_content(
        intro + code
        + "\n\nThis code expires in 5 minutes and can be used once. It was requested to "
        + action + ". BALMZ AI will never ask you to reply with this code. "
        + "Never share it with anyone. If you did not request it, ignore this message."
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
        logger.warning("BALMZ AI account-security email delivery failed: error_type=%s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="BALMZ AI could not deliver the Gmail verification code. No password change was authorized.") from exc


def _code_hash(owner_id: str, purpose: str, receiver_email: str, code: str) -> str:
    payload = f"{owner_id}:{purpose}:{receiver_email}:{code}".encode("utf-8")
    return hmac.new(_security_secret(), payload, hashlib.sha256).hexdigest()


def build_auth_security_router(db_factory: Callable, current_user_dependency: Callable):
    router = APIRouter(prefix="/api/v1/auth/neon/account-security", tags=["Account Security"])

    def _ensure_schema(conn):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS world_wallet_auth_recovery_emails (
                owner_id TEXT PRIMARY KEY,
                account_email TEXT NOT NULL,
                receiver_email TEXT NOT NULL,
                verified_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS world_wallet_auth_recovery_challenges (
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
            CREATE INDEX IF NOT EXISTS idx_world_wallet_auth_recovery_challenges
            ON world_wallet_auth_recovery_challenges(owner_id,purpose,created_at DESC)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS world_wallet_auth_password_grants (
                id BIGSERIAL PRIMARY KEY,
                owner_id TEXT NOT NULL,
                token_hash TEXT NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                used_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_world_wallet_auth_password_grants
            ON world_wallet_auth_password_grants(owner_id,created_at DESC)
        """)

    def _identity(user):
        owner_id = str((user or {}).get("id") or "").strip()
        account_email = str((user or {}).get("email") or "").strip().lower()
        if not owner_id or not account_email:
            raise HTTPException(status_code=401, detail="A signed-in BALMZ AI account is required.")
        return owner_id, account_email

    def _profile(conn, owner_id: str):
        return conn.execute("""
            SELECT receiver_email,account_email,verified_at
            FROM world_wallet_auth_recovery_emails WHERE owner_id=%s
        """, (owner_id,)).fetchone()

    def _new_challenge(conn, owner_id: str, purpose: str, receiver_email: str):
        recent = conn.execute("""
            SELECT COUNT(*) FROM world_wallet_auth_recovery_challenges
            WHERE owner_id=%s AND purpose=%s AND created_at>NOW()-INTERVAL '15 minutes'
        """, (owner_id, purpose)).fetchone()
        if int(recent[0] or 0) >= MAX_CODE_REQUESTS_PER_15_MINUTES:
            raise HTTPException(status_code=429, detail="Too many verification-code requests. Try again in 15 minutes.")
        conn.execute("""
            UPDATE world_wallet_auth_recovery_challenges SET used_at=NOW()
            WHERE owner_id=%s AND purpose=%s AND used_at IS NULL
        """, (owner_id, purpose))
        code = f"{secrets.randbelow(900000) + 100000:06d}"
        conn.execute("""
            INSERT INTO world_wallet_auth_recovery_challenges
                (owner_id,purpose,receiver_email,code_hash,expires_at)
            VALUES(%s,%s,%s,%s,NOW()+INTERVAL '5 minutes')
        """, (owner_id, purpose, receiver_email, _code_hash(owner_id, purpose, receiver_email, code)))
        return code

    def _verify_challenge(conn, owner_id: str, purpose: str, receiver_email: str, code: str):
        row = conn.execute("""
            SELECT id,receiver_email,code_hash,attempts
            FROM world_wallet_auth_recovery_challenges
            WHERE owner_id=%s AND purpose=%s AND used_at IS NULL AND expires_at>NOW()
            ORDER BY created_at DESC LIMIT 1 FOR UPDATE
        """, (owner_id, purpose)).fetchone()
        if not row:
            raise HTTPException(status_code=400, detail="No active code was found. Request a new code.")
        challenge_id, challenge_email, expected_hash, attempts = row
        if str(challenge_email).lower() != receiver_email:
            raise HTTPException(status_code=400, detail="The code does not match the verified receiver Gmail.")
        if int(attempts or 0) >= MAX_CODE_ATTEMPTS:
            conn.execute(
                "UPDATE world_wallet_auth_recovery_challenges SET used_at=NOW() WHERE id=%s",
                (challenge_id,),
            )
            conn.commit()
            raise HTTPException(status_code=429, detail="Too many incorrect codes. Request a new code.")
        candidate = _code_hash(owner_id, purpose, receiver_email, code)
        if not hmac.compare_digest(str(expected_hash), candidate):
            conn.execute(
                "UPDATE world_wallet_auth_recovery_challenges SET attempts=attempts+1 WHERE id=%s",
                (challenge_id,),
            )
            conn.commit()
            raise HTTPException(status_code=400, detail="The one-time code is incorrect.")
        conn.execute(
            "UPDATE world_wallet_auth_recovery_challenges SET used_at=NOW() WHERE id=%s",
            (challenge_id,),
        )

    def _verified_receiver(conn, owner_id: str, account_email: str):
        profile = _profile(conn, owner_id)
        if not profile or not profile[2]:
            raise HTTPException(status_code=409, detail="Verify a separate receiver Gmail before changing your password.")
        receiver_email = str(profile[0]).strip().lower()
        if str(profile[1]).strip().lower() != account_email:
            raise HTTPException(status_code=409, detail="Your account email changed. Verify the receiver Gmail again.")
        if receiver_email == account_email:
            raise HTTPException(status_code=409, detail="The receiver Gmail must be different from your BALMZ AI login email.")
        return receiver_email

    @router.get("/receiver-email/status")
    def receiver_email_status(user=Depends(current_user_dependency)):
        owner_id, account_email = _identity(user)
        with db_factory() as conn:
            _ensure_schema(conn)
            profile = _profile(conn, owner_id)
        verified = bool(profile and profile[2] and str(profile[1]).strip().lower() == account_email)
        return {
            "configured": bool(profile and profile[0]),
            "verified": verified,
            "receiver_email": str(profile[0]) if profile else "",
        }

    @router.post("/receiver-email/request")
    def request_receiver_email_code(request: ReceiverEmailRequest, user=Depends(current_user_dependency)):
        owner_id, account_email = _identity(user)
        receiver_email = normalize_gmail(request.receiver_email)
        if receiver_email == account_email:
            raise HTTPException(status_code=400, detail="Use a different Gmail address from your BALMZ AI login email.")
        _security_secret()
        _sender_config()
        with db_factory() as conn:
            _ensure_schema(conn)
            profile = _profile(conn, owner_id)
            if profile and profile[2]:
                if str(profile[0]).strip().lower() != receiver_email:
                    raise HTTPException(status_code=409, detail="A receiver Gmail is already verified. Changing it requires account recovery.")
                raise HTTPException(status_code=409, detail="This receiver Gmail is already verified.")
            conn.execute("""
                INSERT INTO world_wallet_auth_recovery_emails
                    (owner_id,account_email,receiver_email,verified_at,updated_at)
                VALUES(%s,%s,%s,NULL,NOW())
                ON CONFLICT(owner_id) DO UPDATE SET
                    account_email=EXCLUDED.account_email,
                    receiver_email=EXCLUDED.receiver_email,
                    verified_at=NULL,
                    updated_at=NOW()
            """, (owner_id, account_email, receiver_email))
            code = _new_challenge(conn, owner_id, "receiver_verify", receiver_email)
            conn.commit()
        try:
            _send_security_code(receiver_email, code, "receiver_verify")
        except HTTPException:
            with db_factory() as conn:
                _ensure_schema(conn)
                conn.execute("""
                    UPDATE world_wallet_auth_recovery_challenges SET used_at=NOW()
                    WHERE owner_id=%s AND purpose='receiver_verify' AND used_at IS NULL
                """, (owner_id,))
                conn.commit()
            raise
        return {
            "sent": True,
            "receiver_email": receiver_email,
            "expires_in_seconds": CODE_TTL_SECONDS,
            "message": "A real one-time verification code was sent to the separate receiver Gmail.",
        }

    @router.post("/receiver-email/verify")
    def verify_receiver_email_code(request: EmailCodeRequest, user=Depends(current_user_dependency)):
        owner_id, account_email = _identity(user)
        with db_factory() as conn:
            _ensure_schema(conn)
            profile = _profile(conn, owner_id)
            if not profile or profile[2]:
                raise HTTPException(status_code=409, detail="Start receiver Gmail verification before entering a code.")
            receiver_email = str(profile[0]).strip().lower()
            if str(profile[1]).strip().lower() != account_email:
                raise HTTPException(status_code=409, detail="Your account email changed. Start receiver Gmail verification again.")
            _verify_challenge(conn, owner_id, "receiver_verify", receiver_email, request.code)
            conn.execute("""
                UPDATE world_wallet_auth_recovery_emails
                SET verified_at=NOW(),updated_at=NOW()
                WHERE owner_id=%s AND receiver_email=%s AND account_email=%s
            """, (owner_id, receiver_email, account_email))
            conn.commit()
        return {"verified": True, "receiver_email": receiver_email, "message": "Receiver Gmail verified."}

    @router.post("/password-change/request")
    def request_password_change_code(user=Depends(current_user_dependency)):
        owner_id, account_email = _identity(user)
        _security_secret()
        _sender_config()
        with db_factory() as conn:
            _ensure_schema(conn)
            receiver_email = _verified_receiver(conn, owner_id, account_email)
            code = _new_challenge(conn, owner_id, "password_change", receiver_email)
            conn.execute("""
                UPDATE world_wallet_auth_password_grants SET used_at=NOW()
                WHERE owner_id=%s AND used_at IS NULL
            """, (owner_id,))
            conn.commit()
        try:
            _send_security_code(receiver_email, code, "password_change")
        except HTTPException:
            with db_factory() as conn:
                _ensure_schema(conn)
                conn.execute("""
                    UPDATE world_wallet_auth_recovery_challenges SET used_at=NOW()
                    WHERE owner_id=%s AND purpose='password_change' AND used_at IS NULL
                """, (owner_id,))
                conn.commit()
            raise
        return {
            "sent": True,
            "receiver_email": receiver_email,
            "expires_in_seconds": CODE_TTL_SECONDS,
            "message": "A separate password-change code was sent to the verified receiver Gmail.",
        }

    @router.post("/password-change/verify")
    def verify_password_change_code(request: EmailCodeRequest, user=Depends(current_user_dependency)):
        owner_id, account_email = _identity(user)
        grant_token = "wwauthgrant_" + secrets.token_urlsafe(32)
        with db_factory() as conn:
            _ensure_schema(conn)
            receiver_email = _verified_receiver(conn, owner_id, account_email)
            _verify_challenge(conn, owner_id, "password_change", receiver_email, request.code)
            conn.execute("""
                INSERT INTO world_wallet_auth_password_grants(owner_id,token_hash,expires_at)
                VALUES(%s,%s,NOW()+INTERVAL '5 minutes')
            """, (owner_id, hashlib.sha256(grant_token.encode("utf-8")).hexdigest()))
            conn.commit()
        return {
            "verified": True,
            "grant_token": grant_token,
            "expires_in_seconds": GRANT_TTL_SECONDS,
            "message": "Password-change code verified. You may now update your BALMZ AI account password.",
        }

    @router.post("/password-change/complete")
    def complete_password_change_verification(request: PasswordChangeGrantRequest, user=Depends(current_user_dependency)):
        owner_id, account_email = _identity(user)
        _ = account_email
        token_hash = hashlib.sha256(request.grant_token.encode("utf-8")).hexdigest()
        with db_factory() as conn:
            _ensure_schema(conn)
            row = conn.execute("""
                UPDATE world_wallet_auth_password_grants SET used_at=NOW()
                WHERE owner_id=%s AND token_hash=%s AND used_at IS NULL AND expires_at>NOW()
                RETURNING id
            """, (owner_id, token_hash)).fetchone()
            if not row:
                raise HTTPException(status_code=403, detail="Password-change authorization expired or was already used. Request a new code.")
            conn.commit()
        return {"authorized": True, "single_use": True}

    return router
