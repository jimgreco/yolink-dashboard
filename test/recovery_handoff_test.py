"""Synthetic fixtures only; no subprocesses, AWS, SSH or real private files."""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
import tarfile
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "recovery_handoff", Path(__file__).parents[1] / "deploy/backup-recovery.py")
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)
def configuration_fixture(name="runtime.env", mode=0o600, extra=False):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        payload = b"FAKE_KEY=fixture-secret-never-print\n"
        item = tarfile.TarInfo(name)
        item.size = len(payload)
        item.mode = mode
        archive.addfile(item, io.BytesIO(payload))
        if extra:
            archive.addfile(tarfile.TarInfo("unrelated"), io.BytesIO())
    return output.getvalue()


CONFIG = configuration_fixture()
DUMP = b"PGDMPsynthetic-private-database-fixture"


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.calls = []
        self.corrupt = False
        self.missing_version = False
        self.public = False

    def record(self, name, args):
        self.calls.append((name, args.copy()))
        assert args["Bucket"] == helper.BUCKET
        assert args["ExpectedBucketOwner"] == helper.ACCOUNT

    def get_bucket_versioning(self, **args):
        self.record("versioning", args)
        return {"Status": "Enabled"}

    def get_bucket_encryption(self, **args):
        self.record("encryption", args)
        return {"ServerSideEncryptionConfiguration": {"Rules": [
            {"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]}}

    def get_public_access_block(self, **args):
        self.record("public_access", args)
        return {"PublicAccessBlockConfiguration": {key: not self.public for key in
            ("BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets")}}

    def put_object(self, **args):
        self.record("put", args)
        assert args["IfNoneMatch"] == "*"
        assert args["ServerSideEncryption"] == "AES256"
        assert args["ChecksumAlgorithm"] == "SHA256"
        assert args["ChecksumSHA256"] == base64.b64encode(hashlib.sha256(args["Body"]).digest()).decode()
        assert args["Key"] not in self.objects
        self.objects[args["Key"]] = args.copy()
        return {} if self.missing_version else {"VersionId": "fixture-version-1"}

    def head_object(self, **args):
        self.record("head", args)
        assert args["VersionId"] == "fixture-version-1"
        value = self.objects[args["Key"]]
        return {"ServerSideEncryption": "AES256", "ContentLength": len(value["Body"]),
                "ChecksumSHA256": value["ChecksumSHA256"]}

    def get_object(self, **args):
        self.record("get", args)
        assert args["VersionId"] == "fixture-version-1"
        value = self.objects[args["Key"]]["Body"]
        return {"Body": io.BytesIO(value + b"corrupted" if self.corrupt else value)}


class OwnerIO(io.StringIO):
    def isatty(self):
        return True


class RecoveryHandoffTests(unittest.TestCase):
    def perform(self, s3, configs=None, dump=DUMP):
        configs = iter(configs or [CONFIG, CONFIG])
        return helper.backup(s3, lambda: next(configs), lambda: dump,
                             lambda data: self.assertEqual(data, DUMP))

    def test_opaque_recovery_is_versioned_encrypted_and_download_verified(self):
        s3 = FakeS3()
        uri = self.perform(s3)
        self.assertTrue(uri.startswith("s3://" + helper.BUCKET + "/yolink/activation/"))
        self.assertEqual(len(s3.objects), 3)
        manifest_key = next(k for k in s3.objects if k.endswith("manifest.json"))
        manifest = json.loads(s3.objects[manifest_key]["Body"])
        self.assertEqual([r["bytes"] for r in manifest["objects"]], [len(DUMP), len(CONFIG)])
        self.assertNotIn("fixture-secret", json.dumps(manifest))
        self.assertNotIn("private-database-fixture", json.dumps(manifest))
        self.assertEqual(len([name for name, _ in s3.calls if name == "get"]), 3)
        self.assertIn("no database restore", manifest["verification"])

    def test_configuration_change_stops_before_any_upload(self):
        s3 = FakeS3()
        with self.assertRaisesRegex(helper.Stop, "configuration_changed_during_dump"):
            self.perform(s3, [CONFIG, b"changed"])
        self.assertFalse(s3.objects)

    def test_corrupted_version_stops_and_retains_objects_without_manifest(self):
        s3 = FakeS3()
        s3.corrupt = True
        with self.assertRaisesRegex(helper.Stop, "retrieved_object_verification_failed"):
            self.perform(s3)
        self.assertEqual(len(s3.objects), 1)
        self.assertFalse(any(k.endswith("manifest.json") for k in s3.objects))

    def test_missing_version_never_claims_success(self):
        s3 = FakeS3()
        s3.missing_version = True
        with self.assertRaisesRegex(helper.Stop, "object_version_required"):
            self.perform(s3)
        self.assertEqual(len(s3.objects), 1)

    def test_public_bucket_is_rejected_before_sources_are_read(self):
        s3 = FakeS3()
        s3.public = True
        def forbidden():
            self.fail("source must not be read")
        with self.assertRaisesRegex(helper.Stop, "bucket_public_access_guard"):
            helper.backup(s3, forbidden, forbidden, forbidden)
        self.assertFalse(s3.objects)

    def test_invalid_and_oversized_dump_never_upload(self):
        for dump in (b"not-a-custom-dump", b"PGDMP" + b"x" * helper.MAX_DUMP):
            s3 = FakeS3()
            with self.assertRaisesRegex(helper.Stop, "dump_format_or_size"):
                self.perform(s3, dump=dump)
            self.assertFalse(s3.objects)

    def test_configuration_archive_is_scoped_and_private(self):
        for config in (b"invalid", configuration_fixture("../runtime.env"),
                       configuration_fixture(mode=0o644), configuration_fixture(extra=True)):
            s3 = FakeS3()
            with self.assertRaises(helper.Stop):
                self.perform(s3, [config, config])
            self.assertFalse(s3.objects)

    def test_noninteractive_execution_is_refused_without_source_access(self):
        with patch.object(helper.sys, "stdin", io.StringIO()), \
                patch.object(helper, "source_preflight") as preflight, \
                contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(helper.cli(), 1)
            self.assertIn("owner_terminal_required", err.getvalue())
            preflight.assert_not_called()

    def test_owner_cancellation_performs_no_source_access(self):
        with patch.object(helper.sys, "stdin", OwnerIO()), \
                patch.object(helper.sys, "stdout", OwnerIO()) as out, \
                patch("builtins.input", return_value="CANCEL"), \
                patch.object(helper, "source_preflight") as preflight:
            self.assertEqual(helper.cli(), 0)
            self.assertIn("Cancelled", out.getvalue())
            preflight.assert_not_called()

    def test_provider_errors_are_never_printed(self):
        with patch.object(helper, "main", side_effect=RuntimeError("fixture-secret-never-print")), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(helper.cli(), 1)
            self.assertNotIn("fixture-secret", err.getvalue())
            self.assertIn("sensitive error details suppressed", err.getvalue())


if __name__ == "__main__":
    unittest.main()
