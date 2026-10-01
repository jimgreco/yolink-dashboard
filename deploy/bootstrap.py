#!/usr/bin/env python3
"""Provision only the approved YoLink database and server-held secrets.

Run on EC2 as ec2-user. Never prints credentials or SQL errors. Does not start
the application, change the shared Compose file, or configure Google/YoLink.
"""
import base64
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

ROOT = Path.home() / "yolink-dashboard"
SOURCE = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / "private"
ENV = PRIVATE / "runtime.env"


def sql(statement, database="postgres"):
    result = subprocess.run(
        ["docker", "exec", "-i", "shared_db", "psql", "-X", "-qAt",
         "-v", "ON_ERROR_STOP=1", "-U", "admin", "-d", database],
        input="SET log_statement='none'; SET log_min_error_statement='panic';\n" + statement,
        text=True, capture_output=True, timeout=30,
    )
    if result.returncode:
        raise RuntimeError("Database setup failed; captured SQL output was suppressed to protect secrets.")
    return result.stdout.strip()


def atomic_private(path, value):
    temporary = path.with_suffix(".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(value)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def main():
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, exist_ok=True)
    PRIVATE.mkdir(mode=0o700, exist_ok=True)
    existing_database = sql("SELECT 1 FROM pg_database WHERE datname='yolink_dashboard';") == "1"
    existing_role = sql("SELECT 1 FROM pg_roles WHERE rolname='yolink_dashboard_app';") == "1"
    marker = PRIVATE / "provision.json"
    if not marker.exists() and (existing_database or existing_role):
        raise RuntimeError("YoLink database/role already exists without this deployment's marker; review ownership before proceeding.")
    if not marker.exists():
        atomic_private(marker, json.dumps({"database": "yolink_dashboard", "role": "yolink_dashboard_app"}) + "\n")
    if not ENV.exists():
        password = secrets.token_urlsafe(36)
        values = {
            "YOLINK_MODE": "cloud", "NODE_ENV": "production", "PORT": "4318",
            "PUBLIC_ORIGIN": "https://yolink.jim-greco.com",
            "DATABASE_URL": f"postgresql://yolink_dashboard_app:{password}@shared_db:5432/yolink_dashboard",
            "SESSION_SECRET": secrets.token_urlsafe(48),
            "YOLINK_ENCRYPTION_KEY": base64.b64encode(secrets.token_bytes(32)).decode(),
        }
        atomic_private(ENV, "".join(f"{key}={value}\n" for key, value in values.items()))
    values = dict(line.split("=", 1) for line in ENV.read_text().splitlines() if "=" in line)
    password = urlsplit(values["DATABASE_URL"]).password
    if not password or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" for c in password):
        raise RuntimeError("Unexpected database password format; no changes applied.")
    if not existing_role:
        sql(f"CREATE ROLE yolink_dashboard_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3 PASSWORD '{password}';")
    if not existing_database:
        sql("CREATE DATABASE yolink_dashboard OWNER admin;")
    sql("""REVOKE ALL ON DATABASE yolink_dashboard FROM PUBLIC;
GRANT CONNECT ON DATABASE yolink_dashboard TO yolink_dashboard_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO yolink_dashboard_app;
""", "yolink_dashboard")
    sql((SOURCE / "db/001_initial.sql").read_text(), "yolink_dashboard")
    sql("""GRANT SELECT, INSERT, UPDATE ON dashboard_users, dashboard_snapshots TO yolink_dashboard_app;
GRANT SELECT ON yolink_connections TO yolink_dashboard_app;
GRANT UPDATE (last_attempt_at) ON yolink_connections TO yolink_dashboard_app;
""", "yolink_dashboard")
    shutil.copyfile(SOURCE / "deploy/compose.yaml", ROOT / "compose.yaml")
    shutil.copyfile(SOURCE / "deploy/install-google.py", ROOT / "install-google.py")
    print("Dedicated YoLink database, restricted role, and private server secrets prepared.")
    if not values.get("GOOGLE_CLIENT_ID") or not values.get("GOOGLE_CLIENT_SECRET"):
        print("Google OAuth credentials absent; application startup remains blocked until secure user handoff.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else "Provisioning stopped; sensitive error details suppressed.", file=sys.stderr)
        sys.exit(1)
