#!/usr/bin/env python3
"""Run interactively by Jim after the personal-credential approval/handoff."""
import getpass
import json
from pathlib import Path
import subprocess
import sys
import warnings


def send(payload):
    result = subprocess.run([
        "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
        "-i", str(Path.home() / ".ssh/ec2-deploy-20261004"), "ec2-user@18.219.163.101",
        "python3 ~/yolink-dashboard/personal-setup.py",
    ], input=json.dumps(payload), capture_output=True, text=True, timeout=100)
    if result.returncode:
        # The remote wrapper emits only fixed, non-secret error messages.
        raise RuntimeError(result.stderr.strip() or "The private server setup was unavailable.")
    return json.loads(result.stdout)


def visible(value):
    return "".join(c for c in str(value) if c.isprintable())[:200]


def main():
    warnings.simplefilter("error", getpass.GetPassWarning)
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise RuntimeError("Run this directly in Terminal; credential entry must not be recorded or piped.")
    print("Personal YoLink setup for Jim's private Home Watch dashboard.")
    print("Your UAID and secret will go over SSH to your EC2 server, then over HTTPS to YoLink.")
    print("Only home/device reads are allowed. Credentials are stored encrypted in your isolated database.")
    print("Google access must already be restricted to you. Nothing is sent to chat or written locally.")
    if input("To approve this connection now, type CONNECT: ").strip() != "CONNECT":
        print("Cancelled.")
        return
    payload = {"approved": True, "action": "inspect", "uaid": getpass.getpass("YoLink UAID (hidden): ").strip(), "secret": getpass.getpass("YoLink secret (hidden): ").strip()}
    inspected = send(payload)
    print("Verified YoLink Home ID:", visible(inspected["homeId"]))
    print("Devices in this Home:")
    for number, device in enumerate(inspected["devices"], 1):
        print(f"  {number}. {visible(device['name'])} ({visible(device['type'])})")
    print("Choose where these devices are: 1 Manhattan; 2 East Hampton; 3 split across both houses.")
    selection = input("Choice (1/2/3): ").strip()
    label = {"1": "Manhattan", "2": "East Hampton", "3": "Both houses"}.get(selection)
    if not label: raise RuntimeError("No house selected; nothing saved.")
    assignments = {}
    if label == "Both houses":
        for device in inspected["devices"]:
            choice = input(visible(device["name"]) + " — 1 Manhattan, 2 East Hampton, Enter unassigned: ").strip()
            if choice not in ("", "1", "2"): raise RuntimeError("Invalid assignment; nothing saved.")
            if choice: assignments[device["id"]] = {"1": "Manhattan", "2": "East Hampton"}[choice]
    if input("Save this verified Home and its house assignments? Type SAVE: ").strip() != "SAVE":
        print("Cancelled. No credential was stored.")
        return
    payload.update(action="connect", expectedHomeId=inspected["homeId"], label=label, deviceHouses=assignments)
    print(send(payload)["message"])
    print("Only repeat for a separate actual YoLink Home. One Home covering both houses needs one credential.")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled.")
        sys.exit(1)
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else "Setup unavailable; no credential details were printed.", file=sys.stderr)
        sys.exit(1)
