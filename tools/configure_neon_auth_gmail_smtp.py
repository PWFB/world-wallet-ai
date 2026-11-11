#!/usr/bin/env python3
"""Configure Neon Managed Better Auth to send customer auth mail through Gmail SMTP.

Secrets are prompted with hidden input and are sent only to the Neon Management API.
They are never written to disk, printed, or stored in the repository.
"""
from __future__ import annotations

import getpass
import json
import sys
import urllib.error
import urllib.request

PROJECT_ID = "hidden-recipe-66704507"
BRANCH_ID = "br-shy-butterfly-b4858jqu"
NEON_API_BASE = "https://console.neon.tech/api/v2"


def main() -> int:
    print("World Wallet AI · Neon Auth Gmail SMTP setup")
    print("This changes the customer verification, OTP and password-reset sender.")
    print("It does not change the separate Super Admin PIN-recovery SMTP settings.\n")

    api_key = getpass.getpass("Neon API key (hidden): ").strip()
    if not api_key:
        print("No Neon API key supplied; no changes were made.", file=sys.stderr)
        return 2

    gmail_address = input("Gmail address to use as sender: ").strip()
    if "@" not in gmail_address or not gmail_address.lower().endswith("@gmail.com"):
        print("Enter a valid @gmail.com sender address; no changes were made.", file=sys.stderr)
        return 2

    app_password = getpass.getpass("Google App Password (hidden, not your normal password): ").replace(" ", "").strip()
    if len(app_password) < 10:
        print("The App Password looks too short; no changes were made.", file=sys.stderr)
        return 2

    sender_name = input("Sender display name [World Wallet AI]: ").strip() or "World Wallet AI"
    payload = {
        "type": "standard",
        "host": "smtp.gmail.com",
        "port": 465,
        "username": gmail_address,
        "password": app_password,
        "sender_email": gmail_address,
        "sender_name": sender_name,
    }
    url = (
        f"{NEON_API_BASE}/projects/{PROJECT_ID}/branches/{BRANCH_ID}/auth/email_provider"
    )
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="PATCH",
    )

    # Clear local references as soon as practical; Python cannot guarantee memory zeroization.
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if not 200 <= response.status < 300:
                print(f"Neon returned HTTP {response.status}; configuration was not confirmed.", file=sys.stderr)
                return 1
    except urllib.error.HTTPError as exc:
        print(f"Neon rejected the SMTP configuration (HTTP {exc.code}). Check the API key, project, branch and App Password.", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"Could not reach Neon: {exc.reason}. No successful configuration was confirmed.", file=sys.stderr)
        return 1
    finally:
        # Do not print or persist any credentials.
        payload.clear()
        api_key = ""
        app_password = ""

    print("\nCustom Gmail SMTP provider saved successfully.")
    print("Next, send a test email using the Neon CLI:")
    print(
        f"neon neon-auth config email-provider test --project-id {PROJECT_ID} "
        f"--branch {BRANCH_ID} --recipient-email YOUR_TEST_MAILBOX"
    )
    print("After delivery is confirmed, verify Google sign-in, email OTP and password-reset links.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
