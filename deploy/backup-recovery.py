#!/usr/bin/env python3
"""Owner-run activation backup. Never invoke against production from agent tools.

Private bytes stay in process memory and travel through pinned SSH and S3 TLS.
Only Jim may confirm and execute the credential-bearing upload. This does not
authorize inspection of runtime.env, modify IAM, or restore/delete any data.
"""
import base64
import datetime as dt
import hashlib
import io
import json
import select
import subprocess
import sys
import tarfile
import time
import uuid
from pathlib import Path

ACCOUNT = "931115508693"
BUCKET = "jgreco-db-backups-931115508693-us-east-2"
REGION = "us-east-2"
REVISION = "711552bb1b336e6c6d58c7ffb24badefff9f4112"
IMAGE = "sha256:b1f26d97deda5c6d6933789c7484d3292635b08479edf58a04eb05b7a346de42"
MAX_DUMP = 4 * 1024 * 1024
MAX_CONFIG = 128 * 1024
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
       "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
       "-o", "ServerAliveCountMax=2", "-i",
       str(Path.home() / ".ssh/ec2-deploy-20261004"), "ec2-user@18.219.163.101"]

# Fixed commands only. No environment values, SQL rows, or provider identifiers
# are interpreted or printed. Opaque configuration archival is owner-approved
# recovery work, not a repetition of the denied environment-inspection probe.
CONFIG_COMMAND = """set -eu
p=/home/ec2-user/yolink-dashboard/private/runtime.env
test -f "$p" && test ! -L "$p"
test "$(stat -c '%a:%u:%h' "$p")" = '600:1000:1'
test "$(stat -c '%s' "$p")" -gt 0
test "$(stat -c '%s' "$p")" -le 65536
unset TAR_OPTIONS
timeout 15s tar --format=ustar -C /home/ec2-user/yolink-dashboard/private -cf - -- runtime.env
"""
DUMP_COMMAND = """set -eu
exec 9</tmp/codex-shared-host-release.lock
flock -n 9
exec 8</home/ec2-user/deploy/.app-release.lock
flock -n 8
timeout 90s docker exec -e PGAPPNAME=yolink_owner_activation_backup \\
  -e 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=90000 -c lock_timeout=2000 -c work_mem=2MB' \\
  -e PGPASSFILE=/dev/null shared_db pg_dump -w -h /var/run/postgresql \\
  -U admin -d yolink_dashboard --format=custom --lock-wait-timeout=2s
"""


class Stop(Exception):
    """Contains only a fixed, non-sensitive error code."""


def require(condition, code):
    if not condition:
        raise Stop(code)


def ssh_capture(command, maximum, timeout=110):
    import shlex
    process = subprocess.Popen(SSH + ["bash -c " + shlex.quote(command)],
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL)
    result = bytearray()
    deadline = time.monotonic() + timeout
    try:
        while True:
            require(time.monotonic() < deadline, "source_timeout")
            if not select.select([process.stdout], [], [], .2)[0]:
                continue
            chunk = process.stdout.read1(65536)
            if not chunk:
                break
            result.extend(chunk)
            require(len(result) <= maximum, "source_size_limit")
        require(process.wait(timeout=5) == 0, "source_command_failed")
        return bytes(result)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        process.stdout.close()


def source_preflight():
    actual = ssh_capture("docker inspect yolink-dashboard-yolink-dashboard-1 --format '{{.Image}} {{.State.Health.Status}}'", 256)
    require(actual.strip() == (IMAGE + " healthy").encode(), "live_release_changed")
    size = ssh_capture("docker exec -e 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=5000' shared_db psql -X -qAt -w -U admin -d yolink_dashboard -c \"SELECT pg_database_size(current_database())\"", 64)
    require(size.strip().isdigit() and 0 < int(size) < 64 * 1024 * 1024, "source_database_size")


def validate_dump(data):
    require(data.startswith(b"PGDMP") and len(data) <= MAX_DUMP, "dump_format_or_size")
    process = subprocess.run(SSH + ["timeout 20s docker exec -i shared_db pg_restore --list"],
                             input=data, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, timeout=30)
    require(process.returncode == 0, "dump_catalog_invalid")


def validate_configuration_archive(data):
    # Check archive headers only. Never extract or interpret credential values.
    require(0 < len(data) <= MAX_CONFIG, "configuration_archive_size")
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
            members = archive.getmembers()
            require(len(members) == 1, "configuration_archive_members")
            item = members[0]
            require(item.name == "runtime.env" and item.isfile() and
                    item.mode == 0o600 and 0 < item.size <= 65536 and
                    item.offset_data + item.size <= len(data), "configuration_archive_metadata")
    except tarfile.TarError:
        raise Stop("configuration_archive_invalid") from None


def check_storage(s3):
    args = {"Bucket": BUCKET, "ExpectedBucketOwner": ACCOUNT}
    versioning = s3.get_bucket_versioning(**args)
    require(versioning.get("Status") == "Enabled", "bucket_versioning_required")
    encryption = s3.get_bucket_encryption(**args)
    rules = encryption.get("ServerSideEncryptionConfiguration", {}).get("Rules", [])
    require(len(rules) == 1 and rules[0].get("ApplyServerSideEncryptionByDefault", {}).get("SSEAlgorithm") == "AES256", "bucket_encryption_changed")
    protection = s3.get_public_access_block(**args).get("PublicAccessBlockConfiguration", {})
    require(all(protection.get(key) is True for key in
                ("BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets")), "bucket_public_access_guard")


def store_and_verify(s3, key, data):
    require(key.startswith("yolink/activation/") and len(data) <= MAX_DUMP,
            "destination_or_size_guard")
    digest = hashlib.sha256(data).digest()
    checksum = base64.b64encode(digest).decode()
    args = {"Bucket": BUCKET, "Key": key, "ExpectedBucketOwner": ACCOUNT}
    result = s3.put_object(**args, Body=data, ServerSideEncryption="AES256",
                           ChecksumAlgorithm="SHA256", ChecksumSHA256=checksum,
                           IfNoneMatch="*", ContentType="application/octet-stream")
    version = result.get("VersionId")
    require(version not in (None, "", "null"), "object_version_required")
    head = s3.head_object(**args, VersionId=version, ChecksumMode="ENABLED")
    require(head.get("ServerSideEncryption") == "AES256" and
            head.get("ContentLength") == len(data) and head.get("ChecksumSHA256") == checksum,
            "stored_object_verification_failed")
    fetched = s3.get_object(**args, VersionId=version, ChecksumMode="ENABLED")
    body = fetched["Body"]
    try:
        recovered = body.read(len(data) + 1)
        require(len(recovered) == len(data) and hashlib.sha256(recovered).digest() == digest,
                "retrieved_object_verification_failed")
    finally:
        body.close()
    return {"key": key, "version_id": version, "bytes": len(data), "sha256": digest.hex()}


def backup(s3, read_config, read_dump, check_dump):
    check_storage(s3)
    configuration = read_config()
    validate_configuration_archive(configuration)
    database = read_dump()
    require(database.startswith(b"PGDMP") and len(database) <= MAX_DUMP, "dump_format_or_size")
    check_dump(database)
    # Refuse a database/configuration pair captured across a key/config change.
    require(read_config() == configuration, "configuration_changed_during_dump")
    run = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex
    prefix = "yolink/activation/" + run + "/"
    objects = [store_and_verify(s3, prefix + name, value) for name, value in
               (("database.dump", database), ("private-config.tar", configuration))]
    manifest = {"format": 1, "database": "yolink_dashboard", "revision": REVISION,
                "image": IMAGE, "bucket": BUCKET, "region": REGION, "objects": objects,
                "verified_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "verification": "Version-pinned download, SHA-256 and dump catalog; no database restore performed."}
    store_and_verify(s3, prefix + "manifest.json", json.dumps(manifest, sort_keys=True).encode())
    return "s3://" + BUCKET + "/" + prefix + "manifest.json"


def main():
    require(sys.stdin.isatty() and sys.stdout.isatty(), "owner_terminal_required")
    print("Jim-only YoLink activation recovery backup.")
    print("Destination: s3://" + BUCKET + "/yolink/activation/")
    print("This transfers the dedicated database and the complete private runtime configuration,")
    print("including database/Google credentials, session secret and application encryption key.")
    print("Values are not shown. Transfer uses pinned SSH and S3 HTTPS; S3 stores AES256-encrypted,")
    print("versioned objects. No secret-bearing Mac file, IAM change, deletion or restore is made.")
    print("Run once before connecting YoLink and once after all Home mappings are saved.")
    if input("To execute this backup yourself now, type BACKUP: ").strip() != "BACKUP":
        print("Cancelled; no backup source was read or transmitted.")
        return
    import boto3
    from botocore.config import Config
    session = boto3.Session(region_name=REGION)
    options = Config(connect_timeout=5, read_timeout=25, retries={"max_attempts": 1})
    identity = session.client("sts", endpoint_url="https://sts.us-east-2.amazonaws.com",
                              verify=True, config=options).get_caller_identity()
    require(identity.get("Account") == ACCOUNT, "aws_account_mismatch")
    source_preflight()
    uri = backup(session.client("s3", endpoint_url="https://s3.us-east-2.amazonaws.com",
                                verify=True, config=options),
                 lambda: ssh_capture(CONFIG_COMMAND, MAX_CONFIG, 30),
                 lambda: ssh_capture(DUMP_COMMAND, MAX_DUMP), validate_dump)
    print("Verified encrypted recovery backup: " + uri)
    print("Report only 'backup done'. Never paste configuration or credential values into chat.")


def cli():
    try:
        main()
        return 0
    except (KeyboardInterrupt, EOFError):
        print("Stopped. No existing data or backups were deleted.", file=sys.stderr)
    except Stop as error:
        print("Backup stopped: " + str(error) + ". Existing and partial objects retained.", file=sys.stderr)
    except Exception:
        print("Backup stopped; sensitive error details suppressed. Existing and partial objects retained.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(cli())
