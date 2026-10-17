"""Check that Docker build contexts exclude runtime secrets and artifacts."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _rules(path: Path) -> set[str]:
    return {
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }


def test_frontend_dockerignore_has_runtime_secret_boundaries():
    rules = _rules(ROOT / "kb_qa_system/frontend/.dockerignore")
    required = {
        ".env.*",
        "!.env.example",
        "backups/",
        "backup/",
        "*.dump",
        "*.sql",
        "*.sql.gz",
        "*.backup*",
        "*.zip",
        "*.tar",
        "*.tar.gz",
        "*.tgz",
        "*.7z",
        "*.bak",
        "kubeconfig",
        "kubeconfig.*",
        "credentials.json",
        "credentials.*.json",
        "secrets.json",
        "*.pem",
        "*.key",
        ".aws/",
        ".kube/",
    }
    assert required <= rules


def test_backend_dockerignore_keeps_example_only_environment_exception():
    rules = _rules(ROOT / "kb_qa_system/backend/.dockerignore")
    assert ".env.*" in rules
    assert "!.env.example" in rules
    assert "!.env.production" not in rules
    assert "backups/" in rules
    assert "*.sql" in rules
    assert "*.zip" in rules
    assert "*.tar.gz" in rules
    assert "*.bak" in rules
    assert "credentials*.json" in rules
    assert "kubeconfig*" in rules


if __name__ == "__main__":
    test_frontend_dockerignore_has_runtime_secret_boundaries()
    test_backend_dockerignore_keeps_example_only_environment_exception()
    print("build context boundary checks passed")
