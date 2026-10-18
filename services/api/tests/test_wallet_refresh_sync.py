import unittest
from unittest.mock import patch

try:
    from services.api import main
except ModuleNotFoundError:
    import main


class WalletRefreshSyncTests(unittest.TestCase):
    def setUp(self):
        self.user = {"id": "user-test", "wallet_id": "wallet-test"}

    def test_refresh_uses_balance_only_sync_then_one_transaction_sync(self):
        balance_result = {
            "updates": [],
            "warnings": [],
            "bitcoin_transactions": [],
            "network_status": {"solana-devnet": {"status": "not_configured"}},
            "last_balance_sync_at": None,
        }
        transaction_result = {"imported": [], "warnings": []}

        with (
            patch.object(main, "_sync_wallet_impl", return_value=balance_result) as balance_sync,
            patch.object(main, "sync_transactions", return_value=transaction_result) as transaction_sync,
            patch.object(main, "wallet_snapshot", return_value=([], [], {})),
        ):
            response = main.refresh_wallet(self.user)

        balance_sync.assert_called_once_with(self.user, include_transactions=False)
        transaction_sync.assert_called_once_with(self.user)
        self.assertEqual(response["status"], "refreshed")
        self.assertEqual(response["warnings"], [])

    def test_public_wallet_sync_keeps_transaction_history_enabled(self):
        expected = {"status": "synced"}
        with patch.object(main, "_sync_wallet_impl", return_value=expected) as sync_impl:
            response = main.sync_wallet(self.user)

        sync_impl.assert_called_once_with(self.user, include_transactions=True)
        self.assertEqual(response, expected)


if __name__ == "__main__":
    unittest.main()
