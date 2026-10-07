#!/bin/bash
# Run by Jim. Select the dedicated downloaded Google OAuth JSON in the file picker.
# Its contents travel only through encrypted SSH stdin to a private server file.
set -eu
python3 - <<'PY'
import pathlib
import subprocess
import sys

try:
    picked = subprocess.run([
        "osascript", "-e",
        'POSIX path of (choose file with prompt "Choose the new Home Watch Google OAuth Web client JSON. Its contents go directly to your EC2 server over SSH, never to chat.")'
    ], capture_output=True, text=True, check=True).stdout.strip()
    path = pathlib.Path(picked)
    if path.stat().st_size > 32768:
        raise ValueError("Unexpected file size")
    with path.open("rb") as source:
        result = subprocess.run([
            "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "ConnectTimeout=10", "-i",
            str(pathlib.Path.home() / ".ssh/ec2-deploy-20261004"),
            "ec2-user@18.219.163.101", "python3 ~/yolink-dashboard/install-google.py"
        ], stdin=source, timeout=30)
    sys.exit(result.returncode)
except Exception:
    print("Setup cancelled or unavailable. No secret was printed. Ask Codex to check the non-secret setup status.", file=sys.stderr)
    sys.exit(1)
PY
