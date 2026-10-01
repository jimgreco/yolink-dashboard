#!/usr/bin/env python3
"""Receive a user-submitted Google OAuth download over SSH stdin; never echo it."""
import json
import os
from pathlib import Path
import re
import sys


def main():
    raw = sys.stdin.buffer.read(32769)
    if len(raw) > 32768:
        raise ValueError("file too large")
    client = json.loads(raw)["web"]
    if "https://yolink.jim-greco.com/auth/callback" not in client.get("redirect_uris", []):
        raise ValueError("callback missing")
    client_id = client["client_id"]
    client_secret = client["client_secret"]
    if not re.fullmatch(r"[A-Za-z0-9._-]+\.apps\.googleusercontent\.com", client_id):
        raise ValueError("invalid client id")
    if not re.fullmatch(r"[A-Za-z0-9._-]{12,512}", client_secret):
        raise ValueError("invalid client secret")
    path = Path.home() / "yolink-dashboard/private/runtime.env"
    if not path.is_file():
        raise ValueError("server bootstrap missing")
    values = dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)
    if values.get("GOOGLE_CLIENT_ID") or values.get("GOOGLE_CLIENT_SECRET"):
        raise ValueError("Google credentials already configured; refuse to replace")
    values.update(GOOGLE_CLIENT_ID=client_id, GOOGLE_CLIENT_SECRET=client_secret)
    temporary = path.with_suffix(".google-tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as output:
            output.write("".join(f"{key}={value}\n" for key, value in values.items()))
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()
    print("Google OAuth configuration stored privately on EC2. No credential was printed.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Setup stopped. Use a new Web application OAuth JSON with the exact callback, after server bootstrap; existing credentials are never replaced.", file=sys.stderr)
        sys.exit(1)
