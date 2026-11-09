"""Reusable, privacy-aware helpers for World Wallet AI wallet operations."""
from __future__ import annotations

import json
import secrets
from datetime import date, datetime
from decimal import Decimal
from math import isfinite
from typing import Any


_SENSITIVE_KEY_PARTS = (
    "authorization",
    "password",
    "secret",
    "private",
    "seed",
    "signature",
    "mnemonic",
    "access_token",
    "refresh_token",
    "api_key",
    "credential",
    "session_token",
)


def generate_transaction_reference() -> str:
    """Return a user-facing, non-secret reference independent of the DB row ID."""
    return "WWTX-" + secrets.token_hex(12).upper()


def sanitize_audit_details(details: Any) -> dict[str, Any]:
    """Bound audit payload size and remove common credential/signing fields."""
    if not isinstance(details, dict):
        return {}

    def clean(value: Any, depth: int = 0) -> Any:
        if depth > 3:
            return "[depth-limited]"
        if isinstance(value, dict):
            result = {}
            for raw_key, item in list(value.items())[:40]:
                key = str(raw_key)[:80]
                normalized = key.lower().replace("-", "_")
                if any(part in normalized for part in _SENSITIVE_KEY_PARTS):
                    continue
                result[key] = clean(item, depth + 1)
            return result
        if isinstance(value, (list, tuple)):
            return [clean(item, depth + 1) for item in list(value)[:25]]
        if isinstance(value, Decimal):
            return str(value)
        if isinstance(value, (datetime, date)):
            return value.isoformat()
        if isinstance(value, bool) or value is None or isinstance(value, int):
            return value
        if isinstance(value, float):
            return value if isfinite(value) else str(value)
        if isinstance(value, str):
            return value[:500]
        return str(value)[:200]

    return clean(details)


def record_wallet_audit_event(
    conn: Any,
    *,
    owner_id: str,
    wallet_id: str,
    actor_email: str,
    action: str,
    resource: str,
    resource_id: str | None = None,
    network: str | None = None,
    reference: str | None = None,
    details: dict[str, Any] | None = None,
) -> str:
    """Write an audit event in the caller's transaction so state and audit commit together."""
    required = (owner_id, wallet_id, actor_email, action, resource)
    if not all(str(value or "").strip() for value in required):
        raise ValueError("Wallet audit event is missing a required identity or action field")

    event_id = "wva_" + secrets.token_urlsafe(18)
    safe_details = json.dumps(sanitize_audit_details(details or {}), separators=(",", ":"))
    conn.execute(
        """
        INSERT INTO wallet_audit_events
          (id, owner_id, wallet_id, actor_email, action, resource, resource_id,
           network, reference, details)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
        """,
        (
            event_id,
            str(owner_id),
            str(wallet_id),
            str(actor_email).strip().lower(),
            str(action)[:80],
            str(resource)[:80],
            str(resource_id)[:160] if resource_id else None,
            str(network)[:40] if network else None,
            str(reference)[:80] if reference else None,
            safe_details,
        ),
    )
    return event_id
