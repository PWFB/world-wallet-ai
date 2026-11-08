import unittest

from balmz_metadata import additional_balmz_registry_entries


class BalmzMetadataRegistryTests(unittest.TestCase):
    def test_missing_mainnet_addresses_remain_pending_without_decimals(self):
        entries = additional_balmz_registry_entries()
        self.assertEqual([entry["symbol"] for entry in entries], ["BALMZ-BNB", "BALMZ-SOL"])
        self.assertEqual([entry["status"] for entry in entries], ["pending_contract", "pending_contract"])
        self.assertTrue(all(entry["contract_address"] is None for entry in entries))
        self.assertTrue(all(entry["decimals"] is None for entry in entries))
        self.assertEqual([entry["network"] for entry in entries], ["bnb", "solana_mainnet"])

    def test_valid_format_addresses_are_published_as_unverified_only(self):
        entries = additional_balmz_registry_entries(
            "0x1111111111111111111111111111111111111111",
            "11111111111111111111111111111111",
        )
        self.assertEqual([entry["status"] for entry in entries], ["configured_unverified", "configured_unverified"])
        self.assertEqual(entries[0]["contract_address"], "0x1111111111111111111111111111111111111111")
        self.assertEqual(entries[1]["contract_address"], "11111111111111111111111111111111")
        self.assertTrue(all(entry["decimals"] is None for entry in entries))

    def test_invalid_addresses_are_not_exposed_as_contracts_or_mints(self):
        entries = additional_balmz_registry_entries("not-an-evm-address", "not-a-solana-address")
        self.assertEqual([entry["status"] for entry in entries], ["invalid_configuration", "invalid_configuration"])
        self.assertTrue(all(entry["contract_address"] is None for entry in entries))

    def test_zero_evm_address_is_rejected(self):
        entries = additional_balmz_registry_entries("0x" + "0" * 40, "")
        self.assertIsNone(entries[0]["contract_address"])
        self.assertEqual(entries[0]["status"], "invalid_configuration")


if __name__ == "__main__":
    unittest.main()
