"""Unit checks for the production frontend response-policy verifier."""

from email.message import Message
import unittest

from verify_frontend_image import app_policy, policy


def response_headers(csp):
    headers = Message()
    headers.add_header("Content-Security-Policy", csp)
    return headers


class ResponsePolicyTests(unittest.TestCase):
    def test_app_keeps_strict_script_and_frame_policy(self):
        app_policy(response_headers(
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
            "frame-src 'self'; object-src 'none'"
        ))

    def test_app_rejects_inline_scripts_and_preview_sandbox(self):
        for csp in [
            "default-src 'self'; script-src 'self' 'unsafe-inline'; frame-src 'self'",
            "default-src 'self'; script-src 'self'; frame-src 'self'; sandbox allow-scripts",
        ]:
            with self.subTest(csp=csp), self.assertRaises(RuntimeError):
                app_policy(response_headers(csp))

    def test_duplicate_or_missing_csp_is_rejected(self):
        for headers in [Message(), response_headers("default-src 'none'")]:
            if headers.get_all("Content-Security-Policy"):
                headers.add_header("Content-Security-Policy", "default-src 'none'")
            with self.subTest(headers=headers), self.assertRaises(RuntimeError):
                policy(headers)


if __name__ == "__main__":
    unittest.main()
