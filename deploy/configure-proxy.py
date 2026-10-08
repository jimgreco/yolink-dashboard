#!/usr/bin/env python3
"""Jim-only secure Nginx credential entry; no SSH port-forwarding or storage."""
import getpass
import json
from pathlib import Path
import shlex
import subprocess
import sys
import warnings


def main():
    warnings.simplefilter("error", getpass.GetPassWarning)
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise RuntimeError("Run this yourself in Terminal; private login input must not be captured or piped.")
    print("Jim-only Nginx HTTPS setup. This uses one encrypted SSH command, not an SSH tunnel.")
    print("Your existing Nginx login goes privately to its normal API on your EC2 server.")
    print("Changes: nginx.jim-greco.com HTTPS admin route/certificate; YoLink forced HTTPS,")
    print("no caching, and callback access/error log suppression. Port 81 remains unchanged.")
    print("Nginx performs its normal configuration reloads; no container is restarted.")
    print("The certificate uses your existing Nginx account email and requires acceptance of Let's Encrypt's")
    print("current Subscriber Agreement: https://letsencrypt.org/repository/")
    print("Continue only during the coordinated proxy configuration window.")
    if input("To approve this exact setup and the certificate terms, type SETUP: ").strip() != "SETUP":
        print("Cancelled; nothing submitted.")
        return
    identity = getpass.getpass("Existing Nginx login email (hidden): ").strip()
    secret = getpass.getpass("Existing Nginx password (hidden): ")
    code = getpass.getpass("Current Nginx two-factor code, if enabled; otherwise Enter (hidden): ").strip()
    if not identity or not secret:
        raise RuntimeError("Email or password was empty; nothing submitted.")
    payload = {"approved": True, "agree_letsencrypt": True,
               "identity": identity, "secret": secret, "code": code}
    source = Path(__file__).with_name("proxy-setup.py").read_text()
    command = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
               "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
               "-i", str(Path.home() / ".ssh/ec2-deploy-20261004"),
               "ec2-user@18.219.163.101", "python3 -c " + shlex.quote(source)]
    result = subprocess.run(command, input=json.dumps(payload), capture_output=True,
                            text=True, timeout=300)
    payload.clear()
    if len(result.stdout) > 4096:
        raise RuntimeError("Unexpected setup response; sensitive details suppressed.")
    status = json.loads(result.stdout)
    if result.returncode or status.get("status") != "configured":
        # Only the reviewed remote helper's fixed phase/code fields are shown.
        safe_phase = str(status.get("phase", "unknown"))
        safe_code = str(status.get("code", "unknown"))
        if not all(c.isalnum() or c == "_" for c in safe_phase + safe_code):
            raise RuntimeError("Setup stopped; sensitive details suppressed.")
        print("Setup stopped: phase=" + safe_phase + ", code=" + safe_code)
        print("Do not retry until this status has been checked; a certificate request may still be running.")
        return
    print("Configured: https://nginx.jim-greco.com")
    print("YoLink callback privacy and origin HTTPS verified. Existing port-81 access is unchanged.")
    print("Report only 'proxy setup done'; never paste login values or session contents into chat.")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("Cancelled.")
        sys.exit(1)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Setup unavailable; sensitive details suppressed. Do not retry until checked.", file=sys.stderr)
        sys.exit(1)
