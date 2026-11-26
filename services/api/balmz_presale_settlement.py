"""Fail-closed Solana Mainnet native-SOL payment verification.

This module only verifies chain evidence. It does not create orders, settle balances,
allocate tokens, sign transactions, or move funds. Callers must enforce a unique
signature constraint and atomically settle an existing server-created payment intent.
"""
import re
from fastapi import HTTPException


_SIGNATURE_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{64,100}$")
_BASE58_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")


def verify_solana_mainnet_sol_payment(
    tx_signature: str,
    sender_address: str,
    destination_address: str,
    expected_lamports: int,
    rpc_call,
    *,
    expected_genesis_hash: str,
    rpc_url: str,
    valid_address=None,
):
    """Verify an exact sender->treasury System Program SOL transfer at finalized commitment."""
    if not isinstance(tx_signature, str) or not _SIGNATURE_RE.fullmatch(tx_signature):
        raise ValueError("Invalid Solana transaction signature")
    address_check = valid_address or (lambda value: isinstance(value, str) and bool(_BASE58_RE.fullmatch(value)))
    if not address_check(sender_address) or not address_check(destination_address):
        raise ValueError("Invalid Solana payment sender or destination address")
    if sender_address == destination_address:
        raise ValueError("Payment sender and treasury destination must be different")
    if isinstance(expected_lamports, bool) or not isinstance(expected_lamports, int) or expected_lamports <= 0:
        raise ValueError("Expected payment must be a positive integer lamport amount")
    if not rpc_url or not expected_genesis_hash:
        raise HTTPException(status_code=503, detail="Solana Mainnet payment verification is not configured")

    try:
        genesis = rpc_call(rpc_url, "getGenesisHash", [])
        if genesis != expected_genesis_hash:
            raise HTTPException(status_code=503, detail="Solana RPC is not connected to the expected Mainnet cluster")

        result = rpc_call(
            rpc_url,
            "getTransaction",
            [tx_signature, {
                "encoding": "jsonParsed",
                "commitment": "finalized",
                "maxSupportedTransactionVersion": 0,
            }],
        )
        if result is None:
            statuses = rpc_call(
                rpc_url, "getSignatureStatuses",
                [[tx_signature], {"searchTransactionHistory": True}],
            )
            if not isinstance(statuses, dict) or not isinstance(statuses.get("value"), list) or len(statuses["value"]) != 1:
                raise HTTPException(status_code=503, detail="Malformed Solana signature-status response")
            status = statuses["value"][0]
            if status is None:
                return {"state": "not_found", "finality": None, "slot": None}
            if not isinstance(status, dict) or "err" not in status:
                raise HTTPException(status_code=503, detail="Malformed Solana signature status")
            if status["err"] is not None:
                raise ValueError("Solana payment transaction failed on-chain")
            return {"state": "pending", "finality": status.get("confirmationStatus"), "slot": status.get("slot")}

        if not isinstance(result, dict):
            raise HTTPException(status_code=503, detail="Malformed Solana transaction response")
        meta = result.get("meta")
        transaction = result.get("transaction")
        slot = result.get("slot")
        if (
            not isinstance(meta, dict)
            or not isinstance(transaction, dict)
            or isinstance(slot, bool)
            or not isinstance(slot, int)
            or slot < 0
        ):
            raise HTTPException(status_code=503, detail="Malformed finalized Solana transaction metadata")
        if meta.get("err") is not None:
            raise ValueError("Solana payment transaction failed on-chain")

        signatures = transaction.get("signatures")
        if (
            not isinstance(signatures, list)
            or not signatures
            or any(not isinstance(item, str) for item in signatures)
            or tx_signature not in signatures
        ):
            raise HTTPException(status_code=503, detail="Solana RPC transaction signature does not match the requested payment")

        message = transaction.get("message")
        if not isinstance(message, dict):
            raise HTTPException(status_code=503, detail="Malformed Solana transaction message")
        keys = message.get("accountKeys")
        outer = message.get("instructions")
        inner = meta.get("innerInstructions") or []
        if not isinstance(keys, list) or not isinstance(outer, list) or not isinstance(inner, list):
            raise HTTPException(status_code=503, detail="Malformed Solana transaction instruction data")

        signer_keys = set()
        for item in keys:
            if isinstance(item, dict):
                pubkey = item.get("pubkey")
                signer = item.get("signer")
            else:
                pubkey, signer = item, False
            if not isinstance(pubkey, str):
                raise HTTPException(status_code=503, detail="Malformed Solana transaction account key")
            if signer is True:
                signer_keys.add(pubkey)
        if sender_address not in signer_keys:
            raise ValueError("Solana payment sender did not sign the transaction")

        instructions = list(outer)
        for group in inner:
            if not isinstance(group, dict) or not isinstance(group.get("instructions", []), list):
                raise HTTPException(status_code=503, detail="Malformed Solana inner instruction data")
            instructions.extend(group.get("instructions") or [])

        paid_lamports = 0
        matching_transfer_count = 0
        for instruction in instructions:
            if not isinstance(instruction, dict):
                raise HTTPException(status_code=503, detail="Malformed Solana instruction")
            parsed = instruction.get("parsed")
            if parsed is None:
                continue
            if not isinstance(parsed, dict):
                raise HTTPException(status_code=503, detail="Malformed parsed Solana instruction")
            if instruction.get("program") != "system" or parsed.get("type") != "transfer":
                continue
            info = parsed.get("info")
            if not isinstance(info, dict):
                raise HTTPException(status_code=503, detail="Malformed System Program transfer")
            if info.get("source") != sender_address or info.get("destination") != destination_address:
                continue
            lamports = info.get("lamports")
            if isinstance(lamports, bool) or not isinstance(lamports, (int, str)) or not str(lamports).isdigit():
                raise HTTPException(status_code=503, detail="Malformed SOL transfer amount")
            matching_transfer_count += 1
            paid_lamports += int(lamports)

        if matching_transfer_count != 1:
            raise ValueError("Finalized Solana transaction must contain exactly one matching SOL transfer for the exact expected SOL payment")
        if paid_lamports != expected_lamports:
            raise ValueError("Finalized Solana transaction does not contain the exact expected SOL payment")

        return {
            "state": "confirmed",
            "finality": "finalized",
            "slot": slot,
            "paid_lamports": paid_lamports,
            "confirmations": 1,
        }
    except HTTPException:
        raise
    except ValueError:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Solana Mainnet payment verification is temporarily unavailable") from exc
