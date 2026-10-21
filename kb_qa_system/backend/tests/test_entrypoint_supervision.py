import os
import shutil
import signal
import subprocess
from pathlib import Path

import pytest


def test_api_worker_fails_container_when_child_exits_successfully(tmp_path):
    if os.name == "nt" or shutil.which("bash") is None:
        pytest.skip("requires a POSIX shell")

    backend_dir = Path(__file__).resolve().parents[1]
    entrypoint = tmp_path / "entrypoint.sh"
    entrypoint.write_text(
        (backend_dir / "entrypoint.sh").read_text(encoding="utf-8").replace("\r\n", "\n"),
        encoding="utf-8",
    )

    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()
    stubs = {
        "id": "#!/bin/sh\n[ \"$1\" = -u ] && { printf '1001\\n'; exit 0; }\nexit 1\n",
        "python": "#!/bin/sh\nexit 0\n",
        "celery": "#!/bin/sh\ncase \" $* \" in *\" worker \"*) exit 0 ;; *) exec sleep 30 ;; esac\n",
        "uvicorn": "#!/bin/sh\nexec sleep 30\n",
    }
    for name, contents in stubs.items():
        executable = stub_dir / name
        executable.write_text(contents, encoding="utf-8")
        executable.chmod(0o755)

    env = os.environ.copy()
    env["PATH"] = f"{stub_dir}{os.pathsep}{env['PATH']}"
    env["ROLE"] = "api+worker"
    process = subprocess.Popen(
        ["bash", str(entrypoint)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=8)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        pytest.fail("api+worker supervisor did not stop after a child exited")

    assert process.returncode == 1, f"stdout={stdout}\nstderr={stderr}"
