"""Mono-hosted Nigerian bank authentication for the BALMZ AI banking tab.

BALMZ AI retrieves the official institution directory and sends users to Mono's
hosted Connect URL. Bank passwords and bank-issued OTPs are never collected by
the BALMZ application or stored in its database.
"""
import hashlib
import hmac
import logging
import os
import re
import uuid
from typing import Callable
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

MONO_API_BASE = "https://api.withmono.com"


class MonoBankLinkRequest(BaseModel):
    institution_id: str = Field(min_length=8, max_length=128)
    auth_method: str = Field(min_length=3, max_length=40, pattern=r"^[a-z][a-z0-9_]*$")


def _mono_secret() -> str:
    value = os.getenv("MONO_SECRET_KEY", "").strip()
    if not value:
        raise HTTPException(
            status_code=503,
            detail="Nigerian bank linking is not configured. Set MONO_SECRET_KEY on the BALMZ AI backend.",
        )
    return value


def _public_app_url() -> str:
    value = os.getenv(
        "BALMZ_AI_PUBLIC_URL",
        "https://world-wallet-ai-frontend.onrender.com",
    ).strip().rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise HTTPException(status_code=503, detail="BALMZ AI public return URL must be a valid HTTPS origin.")
    return value


async def _mono_get(path: str, params: dict | None = None):
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=8.0), follow_redirects=False) as client:
            response = await client.get(
                MONO_API_BASE + path,
                params=params or {},
                headers={"Accept": "application/json", "mono-sec-key": _mono_secret()},
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="Mono bank directory timed out. Try again.") from exc
    except httpx.HTTPError as exc:
        logger.warning("Mono institution directory request failed: error_type=%s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Mono bank directory could not be reached.") from exc
    if not response.is_success:
        logger.warning("Mono institution directory rejected request: status=%s", response.status_code)
        raise HTTPException(status_code=502, detail="Mono could not return the supported bank list.")
    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="Mono returned an unreadable bank directory.") from exc
    if not isinstance(payload, dict) or str(payload.get("status") or "").lower() != "successful":
        raise HTTPException(status_code=502, detail="Mono did not confirm a successful bank directory response.")
    return payload


async def _mono_post(path: str, payload: dict):
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(25.0, connect=8.0), follow_redirects=False) as client:
            response = await client.post(
                MONO_API_BASE + path,
                json=payload,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "mono-sec-key": _mono_secret(),
                },
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail="Mono bank authentication could not be started in time. Try again.") from exc
    except httpx.HTTPError as exc:
        logger.warning("Mono hosted bank-link request failed: error_type=%s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Mono could not start bank authentication.") from exc
    if not response.is_success:
        logger.warning("Mono hosted bank-link request rejected: status=%s", response.status_code)
        raise HTTPException(status_code=502, detail="Mono could not start authentication for the selected bank.")
    try:
        result = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="Mono returned an unreadable bank authentication response.") from exc
    if not isinstance(result, dict) or str(result.get("status") or "").lower() != "successful":
        raise HTTPException(status_code=502, detail="Mono did not confirm that bank authentication was started.")
    return result


def _safe_icon(value):
    candidate = str(value or "").strip()
    parsed = urlparse(candidate)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host or not (host == "withmono.com" or host.endswith(".withmono.com")):
        return None
    return candidate[:2048]


def _normalize_institutions(payload: dict):
    raw = payload.get("data")
    if not isinstance(raw, list):
        raise HTTPException(status_code=502, detail="Mono returned an invalid bank directory.")
    institutions = []
    for row in raw:
        if not isinstance(row, dict) or str(row.get("country") or "").strip().lower() != "ng":
            continue
        institution_id = str(row.get("_id") or row.get("id") or "").strip()
        name = str(row.get("name") or "").strip()
        if not institution_id or not name:
            continue
        auth_methods = []
        for method in row.get("auth_methods") or []:
            if not isinstance(method, dict):
                continue
            kind = str(method.get("type") or "").strip().lower()
            if re.fullmatch(r"[a-z][a-z0-9_]{1,39}", kind) and kind not in auth_methods:
                auth_methods.append(kind)
        institutions.append({
            "id": institution_id,
            "name": name[:160],
            "icon": _safe_icon(row.get("icon")),
            "primary_color": str(row.get("primary_color") or "")[:7] or None,
            "type": str(row.get("type") or "")[:40] or None,
            "auth_methods": auth_methods,
        })
    institutions.sort(key=lambda item: item["name"].casefold())
    return institutions


def build_mono_bankconnect_router(db_factory: Callable, current_user_dependency: Callable):
    router = APIRouter(prefix="/api/v1/mono-bankconnect", tags=["BALMZ AI BankConnect"])

    def _ensure_schema(conn):
        conn.execute("""
            CREATE TABLE IF NOT EXISTS balmz_mono_bank_link_sessions (
                reference TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                institution_id TEXT NOT NULL,
                institution_name TEXT NOT NULL,
                auth_method TEXT NOT NULL,
                mono_account_id TEXT,
                status TEXT NOT NULL DEFAULT 'initiating',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_balmz_mono_bank_link_owner
            ON balmz_mono_bank_link_sessions(owner_id,created_at DESC)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS balmz_mono_bank_webhook_events (
                event_id TEXT PRIMARY KEY,
                received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """)

    def _identity(user):
        owner_id = str((user or {}).get("id") or "").strip()
        email = str((user or {}).get("email") or "").strip().lower()
        if not owner_id or not email:
            raise HTTPException(status_code=401, detail="A signed-in BALMZ AI account is required.")
        return owner_id, email

    @router.get("/status")
    def mono_bankconnect_status(user=Depends(current_user_dependency)):
        _identity(user)
        return {
            "provider": "Mono",
            "configured": bool(os.getenv("MONO_SECRET_KEY", "").strip()),
            "country": "NG",
            "mode": "provider_hosted_authentication",
            "bank_passwords_collected_by_balmz": False,
        }

    @router.get("/institutions")
    async def mono_bank_institutions(user=Depends(current_user_dependency)):
        _identity(user)
        payload = await _mono_get("/v3/institutions", {"scope": "financial_data"})
        institutions = _normalize_institutions(payload)
        return {
            "provider": "Mono",
            "country": "NG",
            "institutions": institutions,
            "count": len(institutions),
            "source": "Mono live institution directory",
        }

    @router.post("/initiate")
    async def initiate_mono_bank_link(request: MonoBankLinkRequest, user=Depends(current_user_dependency)):
        owner_id, email = _identity(user)
        payload = await _mono_get("/v3/institutions", {"scope": "financial_data"})
        institutions = _normalize_institutions(payload)
        selected = next((item for item in institutions if item["id"] == request.institution_id), None)
        if not selected:
            raise HTTPException(status_code=400, detail="Choose a bank from the live supported-bank directory.")
        if request.auth_method not in selected["auth_methods"]:
            raise HTTPException(status_code=400, detail="That authentication method is not listed for the selected bank.")
        customer_name = str((user or {}).get("name") or "").strip()
        if not customer_name:
            customer_name = email.split("@", 1)[0].replace(".", " ").replace("_", " ").strip().title()
        reference = "balmz_" + uuid.uuid4().hex
        with db_factory() as conn:
            _ensure_schema(conn)
            conn.execute("""
                INSERT INTO balmz_mono_bank_link_sessions
                    (reference,owner_id,institution_id,institution_name,auth_method,status)
                VALUES(%s,%s,%s,%s,%s,'initiating')
            """, (reference, owner_id, selected["id"], selected["name"], request.auth_method))
            conn.commit()
        redirect_url = _public_app_url() + "/?balmz_bank_return=1&bank_ref=" + reference
        try:
            provider_result = await _mono_post("/v2/accounts/initiate", {
                "customer": {"name": customer_name, "email": email},
                "meta": {"ref": reference},
                "scope": "auth",
                "redirect_url": redirect_url,
                "institution": {
                    "id": selected["id"],
                    "auth_method": request.auth_method,
                },
            })
        except HTTPException:
            with db_factory() as conn:
                _ensure_schema(conn)
                conn.execute("""
                    UPDATE balmz_mono_bank_link_sessions
                    SET status='failed',updated_at=NOW()
                    WHERE reference=%s AND owner_id=%s
                """, (reference, owner_id))
                conn.commit()
            raise
        data = provider_result.get("data") if isinstance(provider_result.get("data"), dict) else {}
        mono_url = str(data.get("mono_url") or "").strip()
        parsed = urlparse(mono_url)
        if parsed.scheme != "https" or parsed.hostname not in {"link.mono.co"}:
            with db_factory() as conn:
                _ensure_schema(conn)
                conn.execute("""
                    UPDATE balmz_mono_bank_link_sessions
                    SET status='failed',updated_at=NOW()
                    WHERE reference=%s AND owner_id=%s
                """, (reference, owner_id))
                conn.commit()
            raise HTTPException(status_code=502, detail="Mono returned an invalid hosted bank-authentication URL.")
        with db_factory() as conn:
            _ensure_schema(conn)
            conn.execute("""
                UPDATE balmz_mono_bank_link_sessions
                SET status='pending_provider_auth',updated_at=NOW()
                WHERE reference=%s AND owner_id=%s
            """, (reference, owner_id))
            conn.commit()
        return {
            "provider": "Mono",
            "reference": reference,
            "redirect_url": mono_url,
            "expires_in_seconds": None,
            "message": "Continue to Mono's hosted bank authentication. Your bank handles its password and any bank-issued OTP.",
        }

    @router.get("/link-status/{reference}")
    def mono_bank_link_status(reference: str, user=Depends(current_user_dependency)):
        owner_id, _ = _identity(user)
        with db_factory() as conn:
            _ensure_schema(conn)
            row = conn.execute("""
                SELECT institution_name,status,created_at
                FROM balmz_mono_bank_link_sessions
                WHERE reference=%s AND owner_id=%s
            """, (reference, owner_id)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Bank-link request was not found for this account.")
        return {"institution_name": str(row[0]), "status": str(row[1]), "created_at": row[2].isoformat() if hasattr(row[2], "isoformat") else str(row[2])}

    @router.post("/webhook")
    async def mono_bank_webhook(
        request: Request,
        mono_webhook_secret: str | None = Header(default=None, alias="mono-webhook-secret"),
    ):
        expected = os.getenv("MONO_WEBHOOK_SECRET", "").strip()
        if not expected:
            raise HTTPException(status_code=503, detail="Mono webhook verification is not configured.")
        if not mono_webhook_secret or not hmac.compare_digest(mono_webhook_secret, expected):
            raise HTTPException(status_code=401, detail="Invalid Mono webhook secret.")
        try:
            event = await request.json()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid Mono webhook payload.") from exc
        if not isinstance(event, dict):
            raise HTTPException(status_code=400, detail="Invalid Mono webhook payload.")
        event_id = str(event.get("event_id") or "").strip()
        event_type = str(event.get("event") or "").strip()
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
        reference = str(meta.get("ref") or "").strip()
        if not event_id:
            raise HTTPException(status_code=400, detail="Mono webhook event ID is missing.")
        with db_factory() as conn:
            _ensure_schema(conn)
            inserted = conn.execute("""
                INSERT INTO balmz_mono_bank_webhook_events(event_id)
                VALUES(%s) ON CONFLICT(event_id) DO NOTHING RETURNING event_id
            """, (event_id,)).fetchone()
            if not inserted:
                conn.commit()
                return {"received": True, "duplicate": True}
            if event_type == "mono.events.account_connected" and reference:
                account_id = str(data.get("id") or "").strip()
                conn.execute("""
                    UPDATE balmz_mono_bank_link_sessions
                    SET mono_account_id=%s,status='connected',updated_at=NOW()
                    WHERE reference=%s
                """, (account_id or None, reference))
            elif event_type == "mono.events.account_updated" and reference:
                state = str(meta.get("data_status") or "").strip().lower()
                status = "data_available" if state in {"available", "partial"} else "connected"
                conn.execute("""
                    UPDATE balmz_mono_bank_link_sessions
                    SET status=%s,updated_at=NOW()
                    WHERE reference=%s
                """, (status, reference))
            conn.commit()
        return {"received": True, "processed": bool(reference)}

    return router
