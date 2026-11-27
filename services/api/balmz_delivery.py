"""Safe, non-custodial BALMZ-SOL delivery transaction helpers.

This module creates unsigned SPL Token TransferChecked transactions and validates
wallet-signed transactions against the exact prepared message. It never loads,
stores, or handles private keys and never broadcasts by itself.
"""
from __future__ import annotations

import base64
import hashlib
import re
from typing import Any

from solders.hash import Hash
from solders.message import Message
from solders.pubkey import Pubkey
from solders.transaction import Transaction
from solders.signature import Signature
from spl.token.constants import TOKEN_PROGRAM_ID
from spl.token.instructions import get_associated_token_address, transfer_checked
from spl.token.models import TransferCheckedParams


_U64_MAX = (1 << 64) - 1
_DECIMAL_INTEGER = re.compile(r"^(0|[1-9][0-9]*)$")


class BalmzDeliveryValidationError(ValueError):
    """Raised when a delivery preview or signed transaction is unsafe."""


def _pubkey(value: str, field: str) -> Pubkey:
    if not isinstance(value, str) or not value:
        raise BalmzDeliveryValidationError(f"{field}_invalid")
    try:
        parsed = Pubkey.from_string(value)
    except Exception as exc:
        raise BalmzDeliveryValidationError(f"{field}_invalid") from exc
    if str(parsed) != value:
        raise BalmzDeliveryValidationError(f"{field}_noncanonical")
    return parsed


def canonical_base_units(value: Any) -> int:
    """Accept canonical unsigned integer token base units only."""
    if isinstance(value, bool):
        raise BalmzDeliveryValidationError("token_base_units_invalid")
    if isinstance(value, int):
        raw = str(value)
    elif isinstance(value, str):
        raw = value
    else:
        raise BalmzDeliveryValidationError("token_base_units_invalid")
    if not _DECIMAL_INTEGER.fullmatch(raw):
        raise BalmzDeliveryValidationError("token_base_units_invalid")
    amount = int(raw)
    if amount < 1 or amount > _U64_MAX:
        raise BalmzDeliveryValidationError("token_base_units_out_of_range")
    return amount


def derive_associated_token_address(owner_address: str, mint_address: str) -> str:
    """Derive the canonical Associated Token Account for a wallet and SPL mint."""
    owner = _pubkey(owner_address, "owner_address")
    mint = _pubkey(mint_address, "mint_address")
    return str(get_associated_token_address(owner, mint, TOKEN_PROGRAM_ID))


def build_unsigned_transfer_checked(
    *,
    mint_address: str,
    source_token_account: str,
    destination_token_account: str,
    authority_address: str,
    fee_payer_address: str,
    amount_base_units: int | str,
    decimals: int,
    recent_blockhash: str,
) -> dict[str, str | int]:
    """Compile one TransferChecked instruction into an unsigned legacy transaction."""
    amount = canonical_base_units(amount_base_units)
    if isinstance(decimals, bool) or not isinstance(decimals, int) or decimals != 9:
        raise BalmzDeliveryValidationError("token_decimals_must_be_9")
    mint = _pubkey(mint_address, "mint_address")
    source = _pubkey(source_token_account, "source_token_account")
    destination = _pubkey(destination_token_account, "destination_token_account")
    authority = _pubkey(authority_address, "authority_address")
    fee_payer = _pubkey(fee_payer_address, "fee_payer_address")
    try:
        blockhash = Hash.from_string(recent_blockhash)
    except Exception as exc:
        raise BalmzDeliveryValidationError("recent_blockhash_invalid") from exc

    instruction = transfer_checked(
        TransferCheckedParams(
            program_id=TOKEN_PROGRAM_ID,
            source=source,
            mint=mint,
            dest=destination,
            owner=authority,
            amount=amount,
            decimals=decimals,
        )
    )
    message = Message.new_with_blockhash([instruction], fee_payer, blockhash)
    transaction = Transaction.new_unsigned(message)
    wire = bytes(transaction)
    message_bytes = transaction.message_data()
    if not wire or not message_bytes:
        raise BalmzDeliveryValidationError("unsigned_transaction_encoding_failed")
    return {
        "unsigned_transaction_base64": base64.b64encode(wire).decode("ascii"),
        "message_base64": base64.b64encode(message_bytes).decode("ascii"),
        "message_sha256": hashlib.sha256(message_bytes).hexdigest(),
        "amount_base_units": amount,
        "decimals": decimals,
        "token_program_id": str(TOKEN_PROGRAM_ID),
        "fee_payer_address": str(fee_payer),
        "required_signer_address": str(authority),
        "instruction_count": 1,
    }


def validate_wallet_signed_transaction(
    *,
    unsigned_transaction_base64: str,
    signed_transaction_base64: str,
    expected_message_sha256: str,
    required_signer_address: str,
) -> dict[str, str]:
    """Require valid signatures over precisely the prepared unsigned message."""
    if not isinstance(expected_message_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_message_sha256):
        raise BalmzDeliveryValidationError("prepared_message_digest_invalid")
    try:
        unsigned_wire = base64.b64decode(unsigned_transaction_base64, validate=True)
        signed_wire = base64.b64decode(signed_transaction_base64, validate=True)
        unsigned_tx = Transaction.from_bytes(unsigned_wire)
        signed_tx = Transaction.from_bytes(signed_wire)
    except Exception as exc:
        raise BalmzDeliveryValidationError("transaction_encoding_invalid") from exc

    unsigned_message = unsigned_tx.message_data()
    signed_message = signed_tx.message_data()
    digest = hashlib.sha256(unsigned_message).hexdigest()
    if digest != expected_message_sha256 or signed_message != unsigned_message:
        raise BalmzDeliveryValidationError("signed_transaction_message_mismatch")

    required_count = signed_tx.message.header.num_required_signatures
    required_keys = [str(key) for key in signed_tx.message.account_keys[:required_count]]
    if not required_keys or required_keys[0] != required_signer_address:
        raise BalmzDeliveryValidationError("required_delivery_authority_not_fee_payer")
    try:
        verification = signed_tx.verify_with_results()
    except Exception as exc:
        raise BalmzDeliveryValidationError("transaction_signature_invalid") from exc
    if not verification or not all(verification):
        raise BalmzDeliveryValidationError("transaction_signature_invalid")
    signatures = signed_tx.signatures
    if not signatures or signatures[0] == Signature.default():
        raise BalmzDeliveryValidationError("fee_payer_signature_missing")
    signature = str(signatures[0])
    if not re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{64,100}", signature):
        raise BalmzDeliveryValidationError("transaction_signature_invalid")
    return {
        "signature": signature,
        "signed_transaction_base64": base64.b64encode(signed_wire).decode("ascii"),
        "message_sha256": digest,
    }


def parse_spl_token_account(
    response: Any,
    *,
    expected_mint: str,
    expected_owner: str,
    expected_token_program: str,
) -> dict[str, str]:
    """Validate a finalized jsonParsed SPL token account response."""
    context = response.get("context") if isinstance(response, dict) else None
    slot = context.get("slot") if isinstance(context, dict) else None
    if isinstance(slot, bool) or not isinstance(slot, int) or slot < 0:
        raise BalmzDeliveryValidationError("token_account_context_slot_invalid")
    value = response.get("value") if isinstance(response, dict) else None
    if not isinstance(value, dict):
        raise BalmzDeliveryValidationError("token_account_missing")
    if value.get("owner") != expected_token_program or value.get("executable") is not False:
        raise BalmzDeliveryValidationError("token_account_program_invalid")
    data = value.get("data")
    parsed = data.get("parsed") if isinstance(data, dict) else None
    info = parsed.get("info") if isinstance(parsed, dict) else None
    if not isinstance(info, dict) or parsed.get("type") != "account":
        raise BalmzDeliveryValidationError("token_account_data_invalid")
    if info.get("mint") != expected_mint or info.get("owner") != expected_owner:
        raise BalmzDeliveryValidationError("token_account_mint_or_owner_mismatch")
    if info.get("state") != "initialized":
        raise BalmzDeliveryValidationError("token_account_not_initialized")
    token_amount = info.get("tokenAmount")
    raw_amount = token_amount.get("amount") if isinstance(token_amount, dict) else None
    decimals = token_amount.get("decimals") if isinstance(token_amount, dict) else None
    if not isinstance(raw_amount, str) or not _DECIMAL_INTEGER.fullmatch(raw_amount):
        raise BalmzDeliveryValidationError("token_account_amount_invalid")
    if int(raw_amount) > _U64_MAX:
        raise BalmzDeliveryValidationError("token_account_amount_out_of_range")
    if isinstance(decimals, bool) or not isinstance(decimals, int) or decimals != 9:
        raise BalmzDeliveryValidationError("token_account_decimals_invalid")
    return {"amount_base_units": raw_amount, "context_slot": str(slot), "state": "initialized"}


def verify_finalized_delivery_observation(
    response: Any,
    *,
    expected_signature: str,
    expected_mint: str,
    expected_source: str,
    expected_destination: str,
    expected_authority: str,
    expected_amount_base_units: int | str,
    expected_decimals: int = 9,
    expected_token_program: str = str(TOKEN_PROGRAM_ID),
) -> dict[str, int | str]:
    """Verify one exact TransferChecked instruction in finalized transaction metadata."""
    amount = canonical_base_units(expected_amount_base_units)
    if isinstance(expected_decimals, bool) or not isinstance(expected_decimals, int) or expected_decimals != 9:
        raise BalmzDeliveryValidationError("delivery_expected_decimals_invalid")
    if not isinstance(response, dict):
        raise BalmzDeliveryValidationError("finalized_transaction_missing")
    slot = response.get("slot")
    meta = response.get("meta")
    transaction = response.get("transaction")
    if isinstance(slot, bool) or not isinstance(slot, int) or slot < 0:
        raise BalmzDeliveryValidationError("finalized_transaction_slot_invalid")
    if not isinstance(meta, dict) or not isinstance(transaction, dict):
        raise BalmzDeliveryValidationError("finalized_transaction_metadata_invalid")
    if meta.get("err") is not None:
        raise BalmzDeliveryValidationError("delivery_transaction_failed")
    signatures = transaction.get("signatures")
    if not isinstance(signatures, list) or expected_signature not in signatures:
        raise BalmzDeliveryValidationError("finalized_transaction_signature_mismatch")
    message = transaction.get("message")
    if not isinstance(message, dict):
        raise BalmzDeliveryValidationError("finalized_transaction_message_invalid")
    account_keys = message.get("accountKeys")
    if not isinstance(account_keys, list):
        raise BalmzDeliveryValidationError("finalized_transaction_account_keys_invalid")
    authority_signed = False
    for key in account_keys:
        if isinstance(key, dict):
            if key.get("pubkey") == expected_authority and key.get("signer") is True:
                authority_signed = True
        elif key == expected_authority:
            # Non-parsed account key encodings don't expose signer metadata.
            continue
    if not authority_signed:
        raise BalmzDeliveryValidationError("delivery_authority_signature_missing")
    instructions = message.get("instructions")
    inner_groups = meta.get("innerInstructions") or []
    if not isinstance(instructions, list) or not isinstance(inner_groups, list):
        raise BalmzDeliveryValidationError("finalized_transaction_instructions_invalid")
    inner_instructions = []
    for group in inner_groups:
        if not isinstance(group, dict) or not isinstance(group.get("instructions", []), list):
            raise BalmzDeliveryValidationError("finalized_inner_instructions_invalid")
        inner_instructions.extend(group.get("instructions") or [])
    if inner_instructions or len(instructions) != 1:
        raise BalmzDeliveryValidationError("unexpected_delivery_instruction_set")
    instruction = instructions[0]
    if not isinstance(instruction, dict):
        raise BalmzDeliveryValidationError("delivery_instruction_invalid")
    parsed = instruction.get("parsed")
    info = parsed.get("info") if isinstance(parsed, dict) else None
    token_amount = info.get("tokenAmount") if isinstance(info, dict) else None
    observed_amount = token_amount.get("amount") if isinstance(token_amount, dict) else None
    observed_decimals = token_amount.get("decimals") if isinstance(token_amount, dict) else None
    expected = {
        "program": "spl-token",
        "programId": expected_token_program,
    }
    if (
        any(instruction.get(key) != value for key, value in expected.items())
        or not isinstance(parsed, dict)
        or parsed.get("type") != "transferChecked"
    ):
        raise BalmzDeliveryValidationError("delivery_instruction_program_or_type_mismatch")
    if not isinstance(info, dict):
        raise BalmzDeliveryValidationError("delivery_instruction_info_invalid")
    if (
        info.get("mint") != expected_mint
        or info.get("source") != expected_source
        or info.get("destination") != expected_destination
        or info.get("authority") != expected_authority
        or observed_amount != str(amount)
        or observed_decimals != expected_decimals
    ):
        raise BalmzDeliveryValidationError("delivery_instruction_fields_mismatch")
    return {"slot": slot, "signature": expected_signature, "amount_base_units": str(amount)}
