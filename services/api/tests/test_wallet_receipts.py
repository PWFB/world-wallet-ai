import base64
import sys
import unittest
from pathlib import Path
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def upload_request(raw: bytes, content_type: str, **overrides):
    values = {
        "kind": "deposit",
        "issue_category": "deposit_missing",
        "file_name": "receipt.pdf" if content_type == "application/pdf" else "receipt.png",
        "content_type": content_type,
        "content_base64": base64.b64encode(raw).decode("ascii"),
        "reference": "WWTX-TEST",
        "network": "ethereum",
        "asset": "ETH",
    }
    values.update(overrides)
    return main.WalletReceiptUploadRequest(**values)


class WalletReceiptValidationTests(unittest.TestCase):
    def test_accepts_pdf_receipt_signature(self):
        raw = b"%PDF-1.7\nreceipt evidence"
        request = upload_request(raw, "application/pdf")
        self.assertEqual(main._decode_wallet_receipt(request), raw)

    def test_accepts_png_receipt_signature(self):
        raw = b"\x89PNG\r\n\x1a\n" + b"receipt"
        request = upload_request(raw, "image/png")
        self.assertEqual(main._decode_wallet_receipt(request), raw)

    def test_accepts_jpeg_receipt_signature(self):
        raw = b"\xff\xd8\xff" + b"receipt"
        request = upload_request(raw, "image/jpeg")
        self.assertEqual(main._decode_wallet_receipt(request), raw)

    def test_accepts_webp_receipt_signature(self):
        raw = b"RIFF" + b"\x04\x00\x00\x00" + b"WEBP" + b"receipt"
        request = upload_request(raw, "image/webp")
        self.assertEqual(main._decode_wallet_receipt(request), raw)

    def test_rejects_mime_spoofing(self):
        request = upload_request(b"not a pdf", "application/pdf")
        with self.assertRaises(HTTPException) as context:
            main._decode_wallet_receipt(request)
        self.assertEqual(context.exception.status_code, 415)

    def test_rejects_unsupported_file_type(self):
        request = upload_request(b"GIF89a", "image/gif")
        with self.assertRaises(HTTPException) as context:
            main._decode_wallet_receipt(request)
        self.assertEqual(context.exception.status_code, 415)

    def test_rejects_receipt_larger_than_five_megabytes(self):
        request = upload_request(b"%PDF-" + (b"x" * (5 * 1024 * 1024)), "application/pdf")
        with self.assertRaises(HTTPException) as context:
            main._decode_wallet_receipt(request)
        self.assertEqual(context.exception.status_code, 413)

    def test_rejects_unsupported_receipt_kind_and_issue_category(self):
        bad_kind = upload_request(b"%PDF-evidence", "application/pdf", kind="swap")
        with self.assertRaises(HTTPException) as kind_error:
            main._decode_wallet_receipt(bad_kind)
        self.assertEqual(kind_error.exception.status_code, 400)

        bad_issue = upload_request(b"%PDF-evidence", "application/pdf", issue_category="wallet_compromised")
        with self.assertRaises(HTTPException) as issue_error:
            main._decode_wallet_receipt(bad_issue)
        self.assertEqual(issue_error.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
