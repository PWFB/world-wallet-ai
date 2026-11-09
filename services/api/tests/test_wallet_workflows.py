import json
import re
import sys
import unittest
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wallet_workflows import (
    generate_transaction_reference,
    record_wallet_audit_event,
    sanitize_audit_details,
)


class FakeConnection:
    def __init__(self):
        self.calls = []

    def execute(self, query, params):
        self.calls.append((query, params))


class ProvisioningConnection:
    def __init__(self):
        self.statements = []
        self.committed = False

    def execute(self, query, params=None):
        self.statements.append((query, params))
        return None

    def commit(self):
        self.committed = True


class ProvisioningDatabase:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, exc_type, exc, tb):
        return False


class WalletWorkflowTests(unittest.TestCase):
    def test_first_time_wallet_provisioning_writes_audit_event(self):
        from unittest.mock import patch
        import main

        connection = ProvisioningConnection()
        expected_user_id = "usr_" + main.sha("user@example.com")[:24]
        expected_wallet_id = "wallet_" + main.sha(expected_user_id)[:24]
        provisioned_user = {
            "id": expected_user_id,
            "email": "user@example.com",
            "name": "New User",
            "wallet_id": expected_wallet_id,
            "wallet_number": "12345678901",
        }
        with (
            patch.object(main, "get_user", side_effect=[None, provisioned_user]),
            patch.object(main, "db", return_value=ProvisioningDatabase(connection)),
            patch.object(main, "record_wallet_audit_event") as audit,
        ):
            result = main.provision_identity("user@example.com", name="New User")

        self.assertEqual(result["wallet_id"], expected_wallet_id)
        self.assertTrue(connection.committed)
        audit.assert_called_once()
        audit_kwargs = audit.call_args.kwargs
        self.assertEqual(audit_kwargs["owner_id"], "usr_" + main.sha("user@example.com")[:24])
        self.assertEqual(audit_kwargs["wallet_id"], expected_wallet_id)
        self.assertEqual(audit_kwargs["action"], "wallet_provisioned")

    def test_transaction_reference_is_unique_and_readable(self):
        references = {generate_transaction_reference() for _ in range(500)}
        self.assertEqual(len(references), 500)
        self.assertTrue(all(re.fullmatch(r"WWTX-[A-F0-9]{24}", value) for value in references))

    def test_audit_details_redact_sensitive_fields_recursively(self):
        safe = sanitize_audit_details({
            "asset": "ETH",
            "amount": Decimal("1.250000000000000000"),
            "signature": "do-not-store",
            "metadata": {
                "access_token": "do-not-store",
                "network": "ethereum",
                "nested": {"private_key": "do-not-store", "confirmations": 12},
            },
        })
        self.assertEqual(safe["asset"], "ETH")
        self.assertEqual(safe["amount"], "1.250000000000000000")
        self.assertNotIn("signature", safe)
        self.assertNotIn("access_token", safe["metadata"])
        self.assertNotIn("private_key", safe["metadata"]["nested"])
        self.assertEqual(safe["metadata"]["nested"]["confirmations"], 12)

    def test_audit_event_is_written_to_callers_transaction(self):
        connection = FakeConnection()
        event_id = record_wallet_audit_event(
            connection,
            owner_id="user-1",
            wallet_id="wallet-1",
            actor_email="user@example.com",
            action="transfer_requested",
            resource="transaction",
            resource_id="tx-1",
            network="ethereum",
            reference="WWTX-ABC",
            details={"asset": "ETH", "amount": "0.25", "signature": "redacted"},
        )
        self.assertTrue(event_id.startswith("wva_"))
        self.assertEqual(len(connection.calls), 1)
        query, params = connection.calls[0]
        self.assertIn("INSERT INTO wallet_audit_events", query)
        self.assertEqual(params[1:9], (
            "user-1", "wallet-1", "user@example.com", "transfer_requested",
            "transaction", "tx-1", "ethereum", "WWTX-ABC",
        ))
        serialized = params[9]
        parsed = json.loads(serialized)
        self.assertEqual(parsed, {"asset": "ETH", "amount": "0.25"})
        self.assertNotIn("redacted", serialized)

    def test_audit_requires_identity_and_action_fields(self):
        with self.assertRaises(ValueError):
            record_wallet_audit_event(
                FakeConnection(),
                owner_id="",
                wallet_id="wallet-1",
                actor_email="user@example.com",
                action="created",
                resource="wallet",
            )


if __name__ == "__main__":
    unittest.main()
