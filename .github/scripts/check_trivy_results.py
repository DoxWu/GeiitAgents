import json
import re
import sys
from pathlib import Path

BLOCKING_SEVERITIES = {"HIGH", "CRITICAL"}


def normalize_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def package_paths(result: dict) -> dict[tuple[str, str], list[str]]:
    paths: dict[tuple[str, str], list[str]] = {}
    for package in result.get("Packages") or []:
        name = package.get("Name") or package.get("PkgName")
        version = package.get("Version") or package.get("InstalledVersion")
        path = (
            package.get("FilePath")
            or package.get("PkgPath")
            or package.get("Path")
            or package.get("FileName")
        )
        if name and version and path:
            key = (normalize_name(name), version)
            paths.setdefault(key, []).append(path)
    return paths


def scan_report(path: Path) -> tuple[list[str], int]:
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"ERROR {path}: {error}", file=sys.stderr)
        return [], 1

    if (
        not isinstance(report, dict)
        or report.get("SchemaVersion") != 2
        or report.get("ArtifactType") != "container_image"
        or not report.get("ArtifactName")
        or not isinstance(report.get("Results"), list)
        or not report["Results"]
    ):
        print(
            f"ERROR {path}: incomplete or unsupported Trivy image report",
            file=sys.stderr,
        )
        return [], 1

    blocking: list[str] = []
    unfixed = 0
    for result in report.get("Results") or []:
        target = result.get("Target") or "unknown target"
        paths = package_paths(result)
        for vulnerability in result.get("Vulnerabilities") or []:
            severity = (vulnerability.get("Severity") or "").upper()
            if severity not in BLOCKING_SEVERITIES:
                continue

            package = vulnerability.get("PkgName") or "unknown package"
            version = vulnerability.get("InstalledVersion") or "unknown version"
            fixed = (vulnerability.get("FixedVersion") or "").strip()
            location = vulnerability.get("PkgPath") or vulnerability.get("FilePath")
            if not location:
                matches = paths.get((normalize_name(package), version), [])
                location = ", ".join(matches) if matches else target
            vulnerability_id = (
                vulnerability.get("VulnerabilityID") or "unknown advisory"
            )
            finding = (
                f"{path}: {severity} {vulnerability_id} {package}@{version} "
                f"at {location}"
            )
            if fixed:
                blocking.append(f"{finding}; fixed in {fixed}")
            else:
                unfixed += 1
                print(f"UNFIXED {finding}")

    print(f"{path}: {unfixed} unfixed HIGH/CRITICAL finding(s), retained for review")
    return blocking, 0


def main(arguments: list[str]) -> int:
    if not arguments:
        print(
            "Usage: check_trivy_results.py REPORT.json [REPORT.json ...]",
            file=sys.stderr,
        )
        return 2

    blocking: list[str] = []
    errors = 0
    for argument in arguments:
        findings, error = scan_report(Path(argument))
        blocking.extend(findings)
        errors += error

    if blocking:
        print("Fixable HIGH/CRITICAL vulnerabilities:", file=sys.stderr)
        print("\n".join(blocking), file=sys.stderr)
    return 1 if blocking or errors else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
