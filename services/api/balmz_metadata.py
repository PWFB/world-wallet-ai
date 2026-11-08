"""Network-qualified BALMZ token registry configuration.

Addresses are sourced only from backend environment configuration. A syntactically
valid address is NOT proof that the contract/mint exists, belongs to BALMZ, or has
the expected supply. Those checks remain an explicit on-chain verification step.
"""
from __future__ import annotations

import re
from typing import Any

BALMZ_LOGO_URL = (
    "https://raw.githubusercontent.com/PWFB/world-wallet-ai/"
    "assets/balmz-solana-devnet-logo/tools/balmz-solana-devnet/balmz-logo.png"
)
_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _valid_evm_contract(value: str) -> bool:
    address = str(value or "").strip()
    return bool(
        re.fullmatch(r"0x[0-9a-fA-F]{40}", address)
        and int(address[2:], 16) != 0
    )


def _valid_solana_pubkey(value: str) -> bool:
    """Check Base58 encoding decodes to exactly 32 bytes; does not verify a mint."""
    address = str(value or "").strip()
    if not address or any(character not in _BASE58_ALPHABET for character in address):
        return False
    leading_zeroes = len(address) - len(address.lstrip("1"))
    decoded_value = 0
    for character in address:
        decoded_value = decoded_value * 58 + _BASE58_ALPHABET.index(character)
    body = (
        decoded_value.to_bytes((decoded_value.bit_length() + 7) // 8, "big")
        if decoded_value
        else b""
    )
    return len((b"\x00" * leading_zeroes) + body) == 32


def additional_balmz_registry_entries(
    bnb_contract_address: str = "",
    solana_mainnet_mint: str = "",
) -> list[dict[str, Any]]:
    """Return BNB and Solana Mainnet rows for the existing token_registry.

    A valid configured address is deliberately marked configured_unverified.
    Decimals remain NULL until a chain-specific metadata read verifies them.
    Invalid values are not published as addresses and are surfaced as
    invalid_configuration so operators can correct the backend setting.
    """
    bnb_value = str(bnb_contract_address or "").strip()
    solana_value = str(solana_mainnet_mint or "").strip()
    bnb_valid = _valid_evm_contract(bnb_value) if bnb_value else False
    solana_valid = _valid_solana_pubkey(solana_value) if solana_value else False

    return [
        {
            "id": "token-balmz-bnb",
            "symbol": "BALMZ-BNB",
            "name": "BALMZ Token (BNB Chain Mainnet)",
            "network": "bnb",
            "contract_address": bnb_value if bnb_valid else None,
            "decimals": None,
            "status": (
                "configured_unverified" if bnb_valid
                else "invalid_configuration" if bnb_value
                else "pending_contract"
            ),
            "metadata_url": None,
            "logo_url": BALMZ_LOGO_URL,
        },
        {
            "id": "token-balmz-solana-mainnet",
            "symbol": "BALMZ-SOL",
            "name": "BALMZ Token (Solana Mainnet)",
            "network": "solana_mainnet",
            "contract_address": solana_value if solana_valid else None,
            "decimals": None,
            "status": (
                "configured_unverified" if solana_valid
                else "invalid_configuration" if solana_value
                else "pending_contract"
            ),
            "metadata_url": None,
            "logo_url": BALMZ_LOGO_URL,
        },
    ]
