#!/usr/bin/env python3
"""Private SSH-only setup. Reads approved user input on stdin; never logs it."""
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path.home() / "yolink-dashboard"


def quoted(value):
    return "'" + str(value).replace("'", "''") + "'"


def sql(statement):
    result = subprocess.run(
        ["docker", "exec", "-i", "shared_db", "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "admin", "-d", "yolink_dashboard"],
        input="SET log_statement='none'; SET log_min_error_statement='panic';\n" + statement,
        text=True, capture_output=True, timeout=20,
    )
    if result.returncode:
        raise RuntimeError("Connection was not saved. This Home may already be connected; do not create a second credential for the same Home.")
    return result.stdout.strip()


def main():
    raw = sys.stdin.buffer.read(131073)
    if len(raw) > 131072: raise ValueError("input too large")
    payload = json.loads(raw)
    if payload.get("approved") is not True: raise RuntimeError("Personal credential use must be explicitly approved first.")
    env = dict(line.split("=", 1) for line in (ROOT / "private/runtime.env").read_text().splitlines() if "=" in line)
    owner = env.get("OWNER_GOOGLE_EMAIL", "").lower()
    if not owner: raise RuntimeError("Configure the owner restriction first.")
    subjects = sql("SELECT google_sub FROM dashboard_users WHERE lower(email)=" + quoted(owner) + ";").splitlines()
    if len(subjects) != 1 or (env.get("OWNER_GOOGLE_SUB") and env["OWNER_GOOGLE_SUB"] != subjects[0]):
        raise RuntimeError("Sign in to the dashboard with the configured owner Google account before connecting YoLink.")
    payload["ownerSub"] = subjects[0]
    image = dict(line.split("=", 1) for line in (ROOT / "release.env").read_text().splitlines() if "=" in line)["YOLINK_IMAGE"]
    if not re.fullmatch(r"yolink-dashboard:[a-f0-9]{40}", image): raise ValueError("unexpected release")
    result = subprocess.run(
        ["docker", "run", "--rm", "-i", "--memory=128m", "--cpus=0.35", "--pids-limit=64", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--network", "deploy_default", "--env-file", str(ROOT / "private/runtime.env"), "--entrypoint", "node", image, "/app/lib/personal-setup-cli.mjs"],
        input=json.dumps(payload), text=True, capture_output=True, timeout=90,
    )
    if result.returncode: raise RuntimeError("YoLink setup could not verify the credential, Home ID, or house assignments. No connection was saved.")
    value = json.loads(result.stdout)
    if payload["action"] == "inspect":
        print(json.dumps(value))
        return
    # Only encrypted credential bytes reach SQL. Nothing from the original
    # UAC or token response is included in a SQL statement or command argument.
    sql("INSERT INTO yolink_connections(id,owner_sub,provider,label,expected_home_id,device_houses,credential_cipher,credential_nonce,credential_tag,last_attempt_at) VALUES(" +
        ",".join([quoted(value["id"]), quoted(subjects[0]), "'personal_uac'", quoted(value["label"]), quoted(value["expectedHomeId"]), quoted(json.dumps(value["deviceHouses"])) + "::jsonb",
        "decode(" + quoted(value["cipher"]) + ",'hex')", "decode(" + quoted(value["nonce"]) + ",'hex')", "decode(" + quoted(value["tag"]) + ",'hex')", "now()"]) + ");")
    print(json.dumps({"saved": True, "house": value["label"], "message": "Connection saved encrypted. Open the dashboard; the first state check is available after a five-minute rate-limit buffer."}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else "Personal setup stopped; sensitive error details suppressed.", file=sys.stderr)
        sys.exit(1)
