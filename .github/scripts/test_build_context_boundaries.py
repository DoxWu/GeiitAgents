"""Check that Docker build contexts exclude runtime secrets and artifacts."""

from pathlib import Path
import subprocess


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


def test_gitignore_blocks_private_inputs_but_keeps_reviewed_sources():
    def is_ignored(path: str) -> bool:
        result = subprocess.run(
            ["git", "check-ignore", "--quiet", "--no-index", "--", path],
            cwd=ROOT,
            check=False,
        )
        if result.returncode not in (0, 1):
            raise AssertionError(f"git check-ignore failed for {path}")
        return result.returncode == 0

    ignored = [
        ".env.production",
        "kb_qa_system/backend/.env.staging",
        "kb_qa_system/deploy/sealos/secret.yaml",
        "backups/private.dump",
        "backup/private.sql",
        "backups/private.zip",
        "kubeconfig",
        "credentials.private.json",
    ]
    allowed = [
        ".env.example",
        "kb_qa_system/frontend/.env.desktop",
        "kb_qa_system/backend/init-db.sql",
        "kb_qa_system/backend/alembic/versions/20261010_0010_embedding_space.py",
    ]
    assert all(is_ignored(path) for path in ignored)
    assert not any(is_ignored(path) for path in allowed)


def test_production_backend_image_does_not_ship_pip_vendored_packages():
    dockerfile = (ROOT / "kb_qa_system/backend/Dockerfile").read_text(
        encoding="utf-8"
    )
    assert "/opt/venv/lib/python3.11/site-packages/pip" in dockerfile
    assert "/usr/local/lib/python3.11/site-packages/pip" in dockerfile
    assert "/usr/local/lib/python3.11/ensurepip" in dockerfile


if __name__ == "__main__":
    test_frontend_dockerignore_has_runtime_secret_boundaries()
    test_backend_dockerignore_keeps_example_only_environment_exception()
    test_gitignore_blocks_private_inputs_but_keeps_reviewed_sources()
    test_production_backend_image_does_not_ship_pip_vendored_packages()
    print("build context boundary checks passed")
