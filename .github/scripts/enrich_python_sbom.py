"""Enrich pip-audit's resolved inventory using version-specific PyPI metadata.

This records publisher declarations, not a legal determination. No package is
installed or executed. Unknown licenses remain explicit in the sidecar inventory.
"""

import argparse
import hashlib
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote

from packaging.version import InvalidVersion, Version


def canonical(value):
    return re.sub(r"[-_.]+", "-", value).lower()


def metadata_url(name, version):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name):
        raise ValueError("Invalid PyPI distribution name")
    if not version or any(ord(char) < 32 for char in version):
        raise ValueError("A resolved distribution version is required")
    return f"https://pypi.org/pypi/{quote(canonical(name), safe='')}/{quote(version, safe='')}/json"


def fetch(name, version, client=None):
    import httpx

    url = metadata_url(name, version)
    own_client = client is None
    client = client or httpx.Client(
        timeout=httpx.Timeout(connect=8, read=15, write=5, pool=5),
        follow_redirects=False,
        trust_env=True,
    )
    try:
        for attempt in range(2):
            try:
                response = client.get(url, headers={"User-Agent": "GeiitAgents-SBOM/1"})
                if response.status_code in {429, 500, 502, 503, 504} and attempt == 0:
                    time.sleep(1)
                    continue
                if response.is_redirect:
                    raise ValueError("PyPI metadata redirected unexpectedly")
                response.raise_for_status()
                if len(response.content) > 4 * 1024**2:
                    raise ValueError("PyPI metadata exceeded the response budget")
                raw = response.content
                return response.json(), hashlib.sha256(raw).hexdigest()
            except httpx.TimeoutException:
                if attempt:
                    raise ValueError(
                        "Version-specific PyPI metadata request timed out"
                    ) from None
                time.sleep(1)
            except httpx.HTTPStatusError as error:
                if (
                    error.response.status_code in {429, 500, 502, 503, 504}
                    and attempt == 0
                ):
                    time.sleep(1)
                    continue
                raise ValueError(
                    "Version-specific PyPI metadata request failed"
                ) from None
            except httpx.RequestError:
                if attempt:
                    raise ValueError(
                        "Version-specific PyPI metadata request failed"
                    ) from None
                time.sleep(1)
    finally:
        if own_client:
            client.close()
    raise ValueError("Version-specific PyPI metadata request failed")


def meaningful(value):
    return (
        isinstance(value, str)
        and value.strip()
        and value.strip().upper() not in {"UNKNOWN", "NONE", "N/A"}
    )


def enrich(document, loader=fetch):
    components = document.get("components", [])
    if document.get("bomFormat") != "CycloneDX" or not components:
        raise ValueError("A nonempty CycloneDX inventory is required")
    identities = [(item["name"], item["version"]) for item in components]
    # Preserve bom-refs, dependencies and vulnerability references from pip-audit.
    if loader is fetch:
        import httpx

        with (
            httpx.Client(
                timeout=httpx.Timeout(connect=8, read=15, write=5, pool=5),
                follow_redirects=False,
                trust_env=True,
                limits=httpx.Limits(max_connections=24, max_keepalive_connections=24),
            ) as client,
            ThreadPoolExecutor(max_workers=24) as executor,
        ):
            metadata = list(
                executor.map(lambda pair: loader(*pair, client=client), identities)
            )
    else:
        with ThreadPoolExecutor(max_workers=24) as executor:
            metadata = list(executor.map(lambda pair: loader(*pair), identities))
    inventory = []
    for component, ((payload, digest), (name, version)) in zip(
        components, zip(metadata, identities), strict=True
    ):
        info = payload.get("info", {})
        try:
            version_matches = Version(info.get("version", "")) == Version(version)
        except InvalidVersion:
            version_matches = False
        if canonical(info.get("name", "")) != canonical(name) or not version_matches:
            raise ValueError(
                f"PyPI metadata identity mismatch for {name}=={version}; "
                f"received {info.get('name')}=={info.get('version')}"
            )
        component["purl"] = (
            f"pkg:pypi/{quote(canonical(name), safe='')}@{quote(version, safe='')}"
        )
        url = metadata_url(name, version)
        expression = info.get("license_expression")
        legacy = info.get("license")
        classifiers = [
            value
            for value in info.get("classifiers", [])
            if value.startswith("License ::")
        ]
        choices = []
        if meaningful(expression):
            choices = [{"expression": expression.strip()}]
        elif meaningful(legacy) and len(legacy.strip()) <= 256:
            choices = [{"license": {"name": legacy.strip()}}]
        else:
            choices = [
                {"license": {"name": value.split(" :: ")[-1]}}
                for value in classifiers
                if value.count(" :: ") >= 2
            ]
        # Do not erase a license already present in the original SBOM.
        if not component.get("licenses") and choices:
            component["licenses"] = choices
        component.setdefault("properties", []).append(
            {"name": "geiit:license-metadata-source", "value": url}
        )
        inventory.append(
            {
                "name": name,
                "version": version,
                "publisher_version": info.get("version"),
                "purl": component["purl"],
                "metadata_url": url,
                "metadata_sha256": digest,
                "license_expression": expression,
                "license": legacy,
                "classifiers": classifiers,
                "status": "declared" if component.get("licenses") else "unknown",
            }
        )
    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "scope": "pip-audit resolved runtime, optional ML and test requirements",
        "source": "Version-specific PyPI publisher metadata; no legal determination",
        "components": inventory,
        "unknown_licenses": [
            item["purl"] for item in inventory if item["status"] == "unknown"
        ],
    }


def write_json(path, data):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--licenses", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        document = json.loads(args.input.read_text(encoding="utf-8"))
        inventory = enrich(document)
        write_json(args.licenses, inventory)
        write_json(args.output, document)
        print(
            f"Python inventory: {len(inventory['components'])} packages with PURLs; "
            f"{len(inventory['unknown_licenses'])} unknown license declarations (see license inventory)"
        )
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        detail = str(error).replace("\n", " ")[:300]
        print(
            f"Python license inventory failed ({type(error).__name__}): {detail}; "
            "no successful inventory claimed"
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
