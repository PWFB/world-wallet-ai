import unittest

from main import _decode_eip7702_designator, _decode_okx_storage_proxy


class Erc7702InspectorDecodeTests(unittest.TestCase):
    def test_decodes_valid_eip7702_designator(self):
        implementation = "80296ff8d1ed46f8e3c7992664d13b833504c2bb"
        self.assertEqual(
            _decode_eip7702_designator("0xef0100" + implementation),
            "0x" + implementation,
        )

    def test_rejects_non_designator_and_malformed_code(self):
        self.assertIsNone(_decode_eip7702_designator("0x"))
        self.assertIsNone(_decode_eip7702_designator("0xef0100" + "a" * 39))

    def test_decodes_known_storage_proxy_pattern(self):
        implementation = "7daf91dfe55fcab363416a6e3bceb3da34ff1d30"
        owner = "bbdb482ae0895e496676ec84501d2945a404ff2c"
        code = (
            "0x363d3d373d3d3d363d73" + implementation
            + "5af43d82803e903d91602b57fd5bf3"
            + "000000000000000000000000" + owner
        )
        self.assertEqual(
            _decode_okx_storage_proxy(code),
            {"implementation": "0x" + implementation, "embedded_owner": "0x" + owner},
        )

    def test_rejects_other_77_byte_contracts(self):
        self.assertIsNone(_decode_okx_storage_proxy("0x" + "00" * 77))


if __name__ == "__main__":
    unittest.main()
