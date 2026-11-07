import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class FakeResult:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self):
        self.statements = []

    def execute(self, sql, params=None):
        self.statements.append((sql, params))
        return FakeResult((1,))

    def commit(self):
        pass


class FakeDatabaseContext:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self.connection

    def __exit__(self, exc_type, exc, tb):
        return False


class FakeResponse:
    status_code = 200
    is_error = False

    def json(self):
        return {
            "ownedNfts": [{
                "name": "Verified test NFT",
                "description": "Provider metadata",
                "tokenId": "17",
                "contract": {"address": "0x" + "a" * 40, "name": "Example collection"},
                "image": {"cachedUrl": "https://example.invalid/nft.png"},
                "tokenType": "ERC721",
            }]
        }


class AdminConsoleTests(unittest.TestCase):
    def test_admin_guard_requires_explicit_owner_email(self):
        user = {"id": "user_owner", "email": "owner@example.com"}
        with patch.object(main, "WORLD_WALLET_ADMIN_EMAIL", "owner@example.com"), patch.object(main, "DATABASE_URL", "postgresql://test"):
            self.assertEqual(main.require_world_wallet_admin(user), "owner@example.com")
            with self.assertRaises(main.HTTPException) as denied:
                main.require_world_wallet_admin({"id": "other", "email": "user@example.com"})
            self.assertEqual(denied.exception.status_code, 403)

    def test_admin_guard_fails_closed_when_owner_is_not_configured(self):
        with patch.object(main, "WORLD_WALLET_ADMIN_EMAIL", ""), patch.object(main, "DATABASE_URL", "postgresql://test"):
            with self.assertRaises(main.HTTPException) as unavailable:
                main.require_world_wallet_admin({"id": "owner", "email": "owner@example.com"})
            self.assertEqual(unavailable.exception.status_code, 503)

    def test_admin_announcement_requires_content_when_enabled(self):
        request = main.AdminAnnouncementUpdate(title="", body="", enabled=True)
        with patch.object(main, "WORLD_WALLET_ADMIN_EMAIL", "owner@example.com"), patch.object(main, "DATABASE_URL", "postgresql://test"):
            with self.assertRaises(main.HTTPException) as invalid:
                main.admin_update_announcement(request, {"id": "owner", "email": "owner@example.com"})
            self.assertEqual(invalid.exception.status_code, 400)

    def test_admin_schema_adds_audit_and_announcement_tables_without_deleting_wallet_data(self):
        connection = FakeConnection()
        with patch.object(main, "DATABASE_URL", "postgresql://test"), patch.object(main, "db", return_value=FakeDatabaseContext(connection)):
            main.init_db()
        ddl = "\n".join(sql for sql, _ in connection.statements)
        self.assertIn("CREATE TABLE IF NOT EXISTS admin_audit_events", ddl)
        self.assertIn("CREATE TABLE IF NOT EXISTS wallet_announcements", ddl)
        self.assertNotIn("DELETE FROM users", ddl.upper())
        self.assertNotIn("DELETE FROM wallets", ddl.upper())
        self.assertNotIn("DROP TABLE", ddl.upper())

    def test_nft_endpoint_reads_provider_data_for_the_active_wallet(self):
        user = {"id": "user_test", "wallet_id": "wallet_test"}
        with patch.object(main, "wallet_network_address", return_value="0x" + "b" * 40), patch.object(main, "ALCHEMY_API_KEY", "test-key"), patch.object(main.httpx, "get", return_value=FakeResponse()) as fetch:
            result = main.wallet_nfts("ethereum", user)
        self.assertEqual(result["network"], "ethereum")
        self.assertEqual(result["nft_count"], 1)
        self.assertEqual(result["nfts"][0]["token_id"], "17")
        self.assertEqual(result["nfts"][0]["image_url"], "https://example.invalid/nft.png")
        self.assertIn("eth-mainnet.g.alchemy.com", fetch.call_args.args[0])

    def test_nft_endpoint_rejects_unsupported_testnet_or_chain(self):
        with self.assertRaises(main.HTTPException) as invalid:
            main.wallet_nfts("sepolia", {"id": "user_test", "wallet_id": "wallet_test"})
        self.assertEqual(invalid.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
