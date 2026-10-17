import io
import json
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from check_trivy_results import main, scan_report


def image_report(results):
    return {
        "SchemaVersion": 2,
        "ArtifactType": "container_image",
        "ArtifactName": "geiit/test:unit-test",
        "Results": results,
    }


class TrivyResultGateTest(unittest.TestCase):
    def test_fixable_high_finding_blocks_with_package_path(self):
        report = {
            "Results": [
                {
                    "Target": "Python",
                    "Packages": [
                        {
                            "Name": "urllib3",
                            "Version": "2.7.0",
                            "FilePath": "usr/local/lib/python3.11/site-packages/urllib3/METADATA",
                        }
                    ],
                    "Vulnerabilities": [
                        {
                            "Severity": "HIGH",
                            "VulnerabilityID": "CVE-TEST-FIXED",
                            "PkgName": "urllib3",
                            "InstalledVersion": "2.7.0",
                            "FixedVersion": "2.8.0",
                        }
                    ],
                }
            ]
        }

        report = image_report(report["Results"])
        with patch.object(Path, "read_text", return_value=json.dumps(report)):
            findings, error = scan_report(Path("backend-trivy.json"))

        self.assertEqual(error, 0)
        self.assertEqual(len(findings), 1)
        self.assertIn("urllib3@2.7.0", findings[0])
        self.assertIn("urllib3/METADATA", findings[0])
        self.assertIn("fixed in 2.8.0", findings[0])

    def test_unfixed_critical_finding_is_reported_but_does_not_block(self):
        report = {
            "Results": [
                {
                    "Target": "Debian GNU/Linux",
                    "Vulnerabilities": [
                        {
                            "Severity": "CRITICAL",
                            "VulnerabilityID": "CVE-TEST-UNFIXED",
                            "PkgName": "libfoo",
                            "InstalledVersion": "1.0",
                            "FixedVersion": "",
                        }
                    ],
                }
            ]
        }

        report = image_report(report["Results"])
        output = io.StringIO()
        with (
            patch.object(Path, "read_text", return_value=json.dumps(report)),
            redirect_stdout(output),
        ):
            findings, error = scan_report(Path("backend-trivy.json"))

        self.assertEqual(error, 0)
        self.assertEqual(findings, [])
        self.assertIn("UNFIXED", output.getvalue())
        self.assertIn("1 unfixed HIGH/CRITICAL finding", output.getvalue())

    def test_incomplete_report_fails(self):
        with patch.object(Path, "read_text", return_value="{}"):
            self.assertEqual(scan_report(Path("report.json")), ([], 1))

    def test_empty_results_fail(self):
        with patch.object(Path, "read_text", return_value=json.dumps(image_report([]))):
            self.assertEqual(scan_report(Path("report.json")), ([], 1))

    def test_missing_report_fails(self):
        with patch.object(
            Path, "read_text", side_effect=FileNotFoundError("missing report")
        ):
            self.assertEqual(scan_report(Path("report.json")), ([], 1))

    def test_invalid_json_fails(self):
        with patch.object(Path, "read_text", return_value="{"):
            self.assertEqual(scan_report(Path("report.json")), ([], 1))

    def test_valid_clean_report_passes(self):
        report = image_report([{"Target": "Debian", "Vulnerabilities": None}])
        with patch.object(Path, "read_text", return_value=json.dumps(report)):
            self.assertEqual(main(["report.json"]), 0)

    def test_one_failed_image_blocks_both_image_gate(self):
        with patch("check_trivy_results.scan_report", side_effect=[([], 0), ([], 1)]):
            self.assertEqual(main(["backend.json", "frontend.json"]), 1)


if __name__ == "__main__":
    unittest.main()
