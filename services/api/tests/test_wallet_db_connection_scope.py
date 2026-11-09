import unittest
from unittest.mock import patch

try:
    from services.api import main
except ModuleNotFoundError:
    import main


class _Cursor:
    def __init__(self, rows=None, one=None):
        self.rows = list(rows or [])
        self.one = one

    def fetchall(self):
        return list(self.rows)

    def fetchone(self):
        if self.one is not None:
            return self.one
        return self.rows[0] if self.rows else None

    def __iter__(self):
        return iter(self.rows)


class _Connection:
    active = 0
    max_active = 0

    def __enter__(self):
        type(self).active += 1
        type(self).max_active = max(type(self).max_active, type(self).active)
        return self

    def __exit__(self, exc_type, exc, traceback):
        type(self).active -= 1
        return False

    def execute(self, query, params=None):
        sql = " ".join(str(query).split())
        if "SELECT symbol,name,network,contract_address,decimals,status FROM token_registry" in sql:
            return _Cursor([])
        if "SELECT symbol,network FROM token_registry" in sql:
            return _Cursor([])
        if "SELECT 1 FROM wallet_addresses" in sql:
            return _Cursor([])
        if "SELECT symbol,name,balance,reserved_balance,price_usd FROM assets" in sql:
            return _Cursor([("SOL", "Solana", 0, 0, 0)])
        return _Cursor([])

    def commit(self):
        return None


class WalletDatabaseConnectionScopeTests(unittest.TestCase):
    def setUp(self):
        _Connection.active = 0
        _Connection.max_active = 0

    def _assert_no_database_connection_during_network(self):
        self.assertEqual(_Connection.active, 0, "network I/O must not hold a database connection")

    def test_wallet_balance_rpc_runs_outside_database_connection(self):
        user = {"id": "user-1", "wallet_id": "wallet-1"}
        addresses = {"ethereum": None, "bnb": "0x" + "1" * 40, "bitcoin": None,
                     "sepolia": None, "solana_mainnet": None, "solana_devnet": None}

        def verify_bnb(_url):
            self._assert_no_database_connection_during_network()
            return 56

        def read_balance(_url, _address):
            self._assert_no_database_connection_during_network()
            return 0.75

        with patch.object(main, "db", side_effect=lambda: _Connection()), \
             patch.object(main, "wallet_network_address", side_effect=lambda _user, network: addresses[network]), \
             patch.object(main, "BSC_RPC_URL", "https://bnb-rpc.invalid"), \
             patch.object(main, "ETH_RPC_URL", ""), \
             patch.object(main, "require_bnb_rpc", side_effect=verify_bnb), \
             patch.object(main, "evm_balance", side_effect=read_balance), \
             patch.object(main, "wallet_snapshot", return_value=([], [], {})), \
             patch.object(main, "_network_sync_status", return_value={}):
            result = main._sync_wallet_impl(user, include_transactions=False)

        self.assertEqual(result["updates"], [{"network": "bnb", "asset": "BNB", "balance": 0.75}])
        self.assertEqual(_Connection.active, 0)


    def test_wallet_sync_adds_canonical_ethereum_usdt_when_registry_is_catalog_only(self):
        user = {"id": "user-1", "wallet_id": "wallet-1"}
        address = "0x" + "1" * 40
        contract = main.ETHEREUM_USDT_MAINNET_CONTRACT

        def verify_ethereum(_url):
            self._assert_no_database_connection_during_network()
            return 1

        def token_balance(_url, token_contract, owner, decimals):
            self._assert_no_database_connection_during_network()
            self.assertEqual(token_contract.lower(), contract.lower())
            self.assertEqual(owner, address)
            self.assertEqual(decimals, 6)
            return 12.345678

        with patch.object(main, "db", side_effect=lambda: _Connection()), \
             patch.object(main, "wallet_network_address", side_effect=lambda _user, network: address if network == "ethereum" else None), \
             patch.object(main, "ETH_RPC_URL", "https://ethereum-rpc.invalid"), \
             patch.object(main, "USDT_ETH_CONTRACT", contract), \
             patch.object(main, "require_ethereum_mainnet_rpc", side_effect=verify_ethereum), \
             patch.object(main, "evm_balance", return_value=0.125), \
             patch.object(main, "verified_erc20_decimals", return_value=6), \
             patch.object(main, "erc20_balance", side_effect=token_balance), \
             patch.object(main, "wallet_snapshot", return_value=([], [], {})), \
             patch.object(main, "_network_sync_status", return_value={}):
            result = main._sync_wallet_impl(user, include_transactions=False)

        self.assertIn({"network": "ethereum", "asset": "ETH", "balance": 0.125}, result["updates"])
        self.assertIn({"network": "ethereum", "asset": "USDT", "balance": 12.345678,
                       "contract_address": contract, "decimals": 6}, result["updates"])
        self.assertEqual(_Connection.active, 0)

    def test_wallet_sync_does_not_duplicate_active_ethereum_usdt_registry_row(self):
        contract = main.ETHEREUM_USDT_MAINNET_CONTRACT
        rows = [("USDT", "Tether USD", "ethereum", contract, 6, "active")]
        self.assertEqual(main.wallet_sync_token_rows(rows, "0x" + "1" * 40), rows)
        self.assertEqual(main.wallet_sync_token_rows(rows, None), rows)

    def test_wallet_snapshot_does_not_acquire_a_nested_connection(self):
        user = {"id": "user-1", "wallet_id": "wallet-1"}
        with patch.object(main, "db", side_effect=lambda: _Connection()), \
             patch.object(main, "wallet_network_address", side_effect=AssertionError("nested DB lookup")):
            assets, transactions, summary = main.wallet_snapshot(user)

        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0]["network"], None)
        self.assertEqual(transactions, [])
        self.assertEqual(_Connection.max_active, 1)
        self.assertEqual(_Connection.active, 0)

    def test_native_transaction_rpc_runs_outside_database_connection(self):
        user = {"id": "user-1", "wallet_id": "wallet-1"}
        address = "0x" + "2" * 40

        def rpc(_url, method, _params):
            self._assert_no_database_connection_during_network()
            self.assertEqual(method, "eth_getBlockByNumber")
            return {"hash": "0xblock", "transactions": []}

        with patch.object(main, "db", side_effect=lambda: _Connection()), \
             patch.object(main, "wallet_owns_network_address", return_value=True), \
             patch.object(main, "evm_block_number", return_value=1), \
             patch.object(main, "_sync_cursor", return_value=None), \
             patch.object(main, "_set_sync_cursor"), \
             patch.object(main, "rpc_call", side_effect=rpc):
            imported, warning = main.sync_evm_native_transactions(user, "https://rpc.invalid", "ethereum", address)

        self.assertEqual(imported, [])
        self.assertIsNone(warning)
        self.assertEqual(_Connection.active, 0)

    def test_token_receipt_rpc_runs_outside_database_connection(self):
        user = {"id": "user-1", "wallet_id": "wallet-1"}
        address = "0x" + "2" * 40
        sender_topic = "0x" + "0" * 24 + "1" * 40
        recipient_topic = "0x" + "0" * 24 + "2" * 40
        transfer_log = {
            "topics": ["0x" + "0" * 64, sender_topic, recipient_topic],
            "data": hex(1_000_000),
            "transactionHash": "0x" + "a" * 64,
            "blockNumber": "0xa",
            "logIndex": "0x0",
            "blockHash": "0xblock",
        }

        def rpc(_url, method, _params):
            self._assert_no_database_connection_during_network()
            self.assertEqual(method, "eth_getTransactionReceipt")
            return {"status": "0x1"}

        with patch.object(main, "db", side_effect=lambda: _Connection()), \
             patch.object(main, "wallet_owns_network_address", return_value=True), \
             patch.object(main, "evm_block_number", return_value=10), \
             patch.object(main, "_sync_cursor", return_value=None), \
             patch.object(main, "_set_sync_cursor"), \
             patch.object(main, "evm_transfer_logs", return_value=[transfer_log]), \
             patch.object(main, "required_confirmations", return_value=1), \
             patch.object(main, "rpc_call", side_effect=rpc):
            imported, warning = main.sync_evm_token_transactions(
                user, "https://rpc.invalid", "ethereum", "0x" + "3" * 40, "USDT",
                decimals=6, wallet_address=address,
            )

        self.assertIsNone(warning)
        self.assertEqual(len(imported), 1)
        self.assertEqual(imported[0]["amount"], 1.0)
        self.assertEqual(_Connection.active, 0)


if __name__ == "__main__":
    unittest.main()
