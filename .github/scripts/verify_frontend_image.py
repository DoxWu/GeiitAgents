"""Verify real Nginx response policies in a disposable production frontend."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, build_opener
import uuid


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def docker(*args):
    result = subprocess.run(
        [os.environ.get("GEIIT_DOCKER", "docker"), *args],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=40,
    )
    return result.stdout.strip()


def policy(headers):
    values = headers.get_all("Content-Security-Policy") or []
    require(len(values) == 1, "Expected exactly one enforced response CSP")
    result = {}
    for part in values[0].split(";"):
        words = part.split()
        if words:
            require(words[0] not in result, "Duplicate CSP directive")
            result[words[0]] = words[1:]
    return result


def app_policy(headers):
    csp = policy(headers)
    require(csp.get("default-src") == ["'self'"], "App default-src changed")
    require("'self'" in csp.get("script-src", []), "App scripts are unavailable")
    require(
        "'unsafe-inline'" not in csp.get("script-src", [])
        and "'unsafe-eval'" not in csp.get("script-src", []),
        "Preview permissions leaked into application script policy",
    )
    require(csp.get("frame-src") == ["'self'"], "App preview frame policy changed")
    require("sandbox" not in csp, "Preview sandbox leaked into application")
    require(csp.get("object-src") == ["'none'"], "App object policy missing")


def verify(image, output, browser_check):
    name = "geiit-preview-qa-" + uuid.uuid4().hex[:12]
    opener = build_opener(ProxyHandler({}))
    report = {"passed": False, "image": image, "container": name, "checks": []}
    created = False

    def get(url):
        try:
            with opener.open(url, timeout=3) as response:
                return response.status, response.headers, response.read(2_000_001)
        except HTTPError as error:
            return error.code, error.headers, error.read(2_000_001)

    try:
        report["imageId"] = docker("image", "inspect", image, "--format", "{{.Id}}")
        docker(
            "create", "--name", name, "--label", "geiit.acceptance=preview-csp",
            "--publish", "127.0.0.1::80", "--env", "BACKEND_URL=http://127.0.0.1:9",
            "--env", "PUBLIC_CONTACT_EMAIL=preview@example.test", image,
        )
        created = True
        docker("start", name)
        mapping = docker("port", name, "80/tcp")
        require(re.fullmatch(r"127\.0\.0\.1:\d+", mapping), "Unexpected published address")
        base = "http://" + mapping
        report["baseUrl"] = base
        deadline = time.monotonic() + 35
        while True:
            try:
                status, headers, body = get(base + "/index.html")
                if status == 200:
                    break
            except (URLError, TimeoutError, ConnectionError):
                pass
            require(time.monotonic() < deadline, "Production frontend did not become ready")
            time.sleep(0.2)
        for path in ["/", "/workbench", "/index.html"]:
            status, headers, body = get(base + path)
            require(status == 200 and b'id="root"' in body, "Application route failed: " + path)
            app_policy(headers)
        report["checks"].append("application routes retain strict script policy")

        status, headers, body = get(base + "/web-preview.html")
        require(status == 200, "Preview bootstrap is missing from production image")
        require("text/html" in headers.get("Content-Type", ""), "Preview MIME type is wrong")
        require(headers.get("Cache-Control") == "no-store", "Preview must not be cached")
        require(headers.get("X-Content-Type-Options") == "nosniff", "Preview nosniff missing")
        csp = policy(headers)
        for key, expected in {
            "default-src": ["'none'"], "script-src": ["'unsafe-inline'"],
            "style-src": ["'unsafe-inline'"], "img-src": ["data:", "blob:"],
            "connect-src": ["'none'"], "frame-src": ["'none'"],
            "object-src": ["'none'"], "base-uri": ["'none'"],
            "form-action": ["'none'"], "frame-ancestors": ["'self'"],
            "sandbox": ["allow-scripts"],
        }.items():
            require(csp.get(key) == expected, "Unexpected preview directive: " + key)
        require(
            b"geiit-preview-ready" in body and b"document.write" in body
            and b"8_000_000" in body and b'id="root"' not in body,
            "Preview was replaced by SPA fallback or wrong bootstrap",
        )
        report["checks"].append("preview has independent opaque sandbox and network-denying CSP")

        status, headers, body = get(base + "/runtime-config.js")
        require(status == 200 and b"preview@example.test" in body, "Runtime public config failed")
        app_policy(headers)
        status, _, _ = get(base + "/assets/acceptance-missing.js.map")
        require(status == 404, "Source maps must not be served")
        report["checks"].append("runtime config works and source maps remain unavailable")

        if browser_check:
            frontend = Path(__file__).resolve().parents[2] / "kb_qa_system/frontend"
            node = shutil.which("node")
            require(node is not None, "Node is required for the optional browser acceptance")
            subprocess.run(
                [node, "scripts/verify-document-task.mjs", "--served-csp", "--output", str(output / "browser")],
                cwd=frontend,
                env={**os.environ, "DOCUMENT_TASK_BASE_URL": base, "DOCUMENT_TASK_LIVE": "0"},
                check=True,
                timeout=180,
            )
            report["checks"].append("full browser task uses unmodified production Nginx response CSP")
        report["passed"] = True
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        try:
            if created:
                docker("rm", "--force", name)
                require(not docker("ps", "--all", "--quiet", "--filter", "name=^/" + name + "$"), "Test container remains")
            report["containerRemoved"] = True
        finally:
            output.mkdir(parents=True, exist_ok=True)
            (output / "result.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--browser", action="store_true", help="Also run the local synthetic Playwright task")
    args = parser.parse_args()
    verify(args.image, args.output.resolve(), args.browser)
