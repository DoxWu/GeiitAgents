import base64
import copy
import unittest

from enrich_python_sbom import enrich, metadata_url


class PythonSbomTests(unittest.TestCase):
    def document(self):
        return {
            "bomFormat": "CycloneDX",
            "specVersion": "1.4",
            "components": [
                {
                    "name": "Example_Package",
                    "version": "1.2.3",
                    "bom-ref": "original-reference",
                }
            ],
            "dependencies": [{"ref": "original-reference", "dependsOn": []}],
            "vulnerabilities": [
                {"id": "synthetic-advisory", "affects": [{"ref": "original-reference"}]}
            ],
        }

    def loader(self, **values):
        def load(name, version):
            return {"info": {"name": name, "version": version, **values}}, "a" * 64

        return load

    def test_spdx_expression_purl_and_audit_references_survive(self):
        doc = self.document()
        before = copy.deepcopy(doc)
        report = enrich(doc, self.loader(license_expression="MIT OR Apache-2.0"))
        self.assertEqual(doc["components"][0]["purl"], "pkg:pypi/example-package@1.2.3")
        self.assertEqual(
            doc["components"][0]["licenses"], [{"expression": "MIT OR Apache-2.0"}]
        )
        self.assertEqual(doc["components"][0]["bom-ref"], "original-reference")
        self.assertEqual(doc["dependencies"], before["dependencies"])
        self.assertEqual(doc["vulnerabilities"], before["vulnerabilities"])
        self.assertEqual(report["unknown_licenses"], [])
        self.assertEqual(report["components"][0]["metadata_sha256"], "a" * 64)

    def test_legacy_declarations_are_recorded_without_inventing_spdx(self):
        doc = self.document()
        enrich(doc, self.loader(license="Publisher custom terms"))
        self.assertEqual(
            doc["components"][0]["licenses"],
            [{"license": {"name": "Publisher custom terms"}}],
        )

    def test_long_license_text_uses_specific_classifier_and_retains_source_text(self):
        doc = self.document()
        text = "Full license text " * 100
        report = enrich(
            doc,
            self.loader(
                license=text,
                classifiers=[
                    "License :: OSI Approved",
                    "License :: OSI Approved :: BSD License",
                ],
            ),
        )
        self.assertEqual(
            doc["components"][0]["licenses"], [{"license": {"name": "BSD License"}}]
        )
        self.assertEqual(report["components"][0]["license"], text)

    def test_unknown_license_stays_explicit(self):
        doc = self.document()
        report = enrich(
            doc, self.loader(license="UNKNOWN", classifiers=["License :: OSI Approved"])
        )
        self.assertNotIn("licenses", doc["components"][0])
        self.assertEqual(report["unknown_licenses"], ["pkg:pypi/example-package@1.2.3"])

    def test_long_unclassified_terms_are_preserved_as_a_publisher_declaration(self):
        for classifiers in ([], ["License :: OSI Approved"]):
            with self.subTest(classifiers=classifiers):
                doc = self.document()
                terms = "  Publisher terms / \u53d1\u5e03\u8005\u6761\u6b3e\r\n" * 100
                report = enrich(
                    doc, self.loader(license=terms, classifiers=classifiers)
                )
                license = doc["components"][0]["licenses"][0]["license"]
                self.assertEqual(license["name"], "Publisher license declaration")
                self.assertNotIn("id", license)
                self.assertEqual(
                    license["url"], metadata_url("Example_Package", "1.2.3")
                )
                self.assertEqual(license["text"]["contentType"], "text/plain")
                self.assertEqual(license["text"]["encoding"], "base64")
                self.assertEqual(
                    base64.b64decode(license["text"]["content"], validate=True).decode(
                        "utf-8"
                    ),
                    terms,
                )
                self.assertEqual(report["unknown_licenses"], [])
                self.assertEqual(report["components"][0]["status"], "declared")
                self.assertEqual(report["components"][0]["license"], terms)

    def test_existing_license_is_not_replaced_by_long_publisher_terms(self):
        doc = self.document()
        doc["components"][0]["licenses"] = [{"expression": "MIT"}]
        enrich(doc, self.loader(license="Publisher terms " * 100))
        self.assertEqual(doc["components"][0]["licenses"], [{"expression": "MIT"}])

    def test_existing_license_is_preserved(self):
        doc = self.document()
        doc["components"][0]["licenses"] = [{"expression": "MIT"}]
        enrich(doc, self.loader())
        self.assertEqual(doc["components"][0]["licenses"], [{"expression": "MIT"}])

    def test_wrong_release_and_name_are_rejected(self):
        for values in ({"name": "different"}, {"version": "9.9"}):
            with (
                self.subTest(values=values),
                self.assertRaisesRegex(ValueError, "identity"),
            ):
                enrich(self.document(), self.loader(**values))

    def test_pep440_equivalent_release_is_accepted_but_original_is_preserved(self):
        doc = {
            "bomFormat": "CycloneDX",
            "components": [{"name": "cuda-toolkit", "version": "13.0.3.0"}],
        }
        report = enrich(doc, self.loader(name="cuda-toolkit", version="13.0.3"))
        self.assertEqual(doc["components"][0]["purl"], "pkg:pypi/cuda-toolkit@13.0.3.0")
        self.assertEqual(report["components"][0]["version"], "13.0.3.0")
        self.assertEqual(report["components"][0]["publisher_version"], "13.0.3")

    def test_distribution_cannot_change_metadata_host_or_path(self):
        with self.assertRaises(ValueError):
            metadata_url("../untrusted", "1.0")
        self.assertEqual(
            metadata_url("Example_Package", "1.0+cpu"),
            "https://pypi.org/pypi/example-package/1.0%2Bcpu/json",
        )

    def test_failed_metadata_fetch_leaves_no_partial_enrichment(self):
        doc = self.document()
        original = copy.deepcopy(doc)

        def fail(*_):
            raise TimeoutError("synthetic network failure")

        with self.assertRaises(TimeoutError):
            enrich(doc, fail)
        self.assertEqual(doc, original)


if __name__ == "__main__":
    unittest.main()
