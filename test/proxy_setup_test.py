"""Synthetic API only. Does not open sockets or read NPM/private configuration."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / "deploy" / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


remote = load("proxy_setup", "proxy-setup.py")
local = load("configure_proxy", "configure-proxy.py")
CERTIFICATE_META_SCHEMA = json.loads((Path(__file__).parent / "fixtures/npm-certificate-meta-2.14.json").read_text())


def certificate_metadata_contract(data):
    # Authoritative installed API contract, independent of the helper payload.
    assert CERTIFICATE_META_SCHEMA["additionalProperties"] is False
    assert not (set(data) - set(CERTIFICATE_META_SCHEMA["properties"]))
    if "dns_challenge" in data:
        assert type(data["dns_challenge"]) is bool


def host(identifier=12, domain=remote.YOLINK, target="yolink-dashboard", port=4318):
    return {"id": identifier, "domain_names": [domain], "forward_scheme": "http",
            "forward_host": target, "forward_port": port, "enabled": True,
            "certificate_id": 23, "ssl_forced": False, "caching_enabled": False,
            "advanced_config": "", "locations": [], "meta": {"nginx_online": True},
            "access_list_id": 0, "block_exploits": True, "hsts_enabled": False,
            "owner_user_id": 1}


class FakeAPI:
    def __init__(self):
        self.yolink = host()
        self.admin = None
        self.certificates = []
        self.calls = []
        self.fail_certificate = False
        self.get_yolink_count = 0
        self.change_yolink = False

    def call(self, method, path, data=None):
        self.calls.append((method, path, copy.deepcopy(data)))
        if path == "/api/nginx/proxy-hosts/12":
            if method == "GET":
                self.get_yolink_count += 1
                if self.change_yolink and self.get_yolink_count == 2:
                    self.yolink["advanced_config"] = "owner changed this"
                return copy.deepcopy(self.yolink)
            assert method == "PUT"
            assert set(data) == {"ssl_forced", "caching_enabled", "locations"}
            self.yolink.update(copy.deepcopy(data))
            return copy.deepcopy(self.yolink)
        if path == "/api/nginx/proxy-hosts?query=" + remote.ADMIN:
            assert method == "GET"
            return [copy.deepcopy(self.admin)] if self.admin else []
        if path == "/api/nginx/certificates?query=" + remote.ADMIN:
            assert method == "GET"
            return copy.deepcopy(self.certificates)
        if path == "/api/nginx/certificates":
            assert method == "POST"
            certificate_metadata_contract(data["meta"])
            assert data == {"provider": "letsencrypt", "domain_names": [remote.ADMIN],
                            "meta": {"dns_challenge": False}}
            if self.fail_certificate:
                raise remote.Stop("api_http_504")
            self.certificates = [{"id": 24, "domain_names": [remote.ADMIN], "provider": "letsencrypt", "expires_on": "2099-01-01 00:00:00"}]
            return copy.deepcopy(self.certificates[0])
        if path == "/api/nginx/proxy-hosts":
            assert method == "POST"
            assert data["domain_names"] == [remote.ADMIN]
            self.admin = dict(copy.deepcopy(data), id=13, meta={"nginx_online": True})
            return copy.deepcopy(self.admin)
        if path == "/api/nginx/proxy-hosts/13":
            if method == "PUT":
                self.admin.update(copy.deepcopy(data))
            else:
                assert method == "GET"
            return copy.deepcopy(self.admin)
        raise AssertionError("unexpected API operation")


class ProxySetupTests(unittest.TestCase):
    def test_installed_contract_rejects_obsolete_certificate_metadata(self):
        for field, value in (("letsencrypt_email", "owner@example.invalid"), ("letsencrypt_agree", True)):
            with self.assertRaises(AssertionError):
                certificate_metadata_contract({"dns_challenge": False, field: value})

    def test_exact_scoped_updates_create_managed_certificate_and_admin_route(self):
        api = FakeAPI()
        before = copy.deepcopy(api.yolink)
        result = {}
        remote.configure(api, result)
        self.assertEqual(result["status"], "configured")
        self.assertFalse(result["port81_access_changed"])
        self.assertTrue(result["yolink_settings_verified"])
        for key, value in before.items():
            if key not in ("ssl_forced", "caching_enabled", "locations"):
                self.assertEqual(api.yolink[key], value)
        self.assertEqual(api.yolink["locations"], [remote.CALLBACK])
        self.assertEqual(api.admin["forward_host"], "127.0.0.1")
        self.assertEqual(api.admin["forward_port"], 81)
        self.assertEqual(api.admin["certificate_id"], 24)

    def test_second_run_does_not_issue_or_mutate_again(self):
        api = FakeAPI()
        remote.configure(api, {})
        api.calls.clear()
        remote.configure(api, {})
        self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_existing_location_or_wrong_target_stops_before_writes(self):
        for change in ({"locations": [{"path": "/other"}]}, {"domain_names": ["another.example.invalid"]},
                       {"forward_host": "different"}, {"id": 3}):
            api = FakeAPI()
            api.yolink.update(change)
            with self.assertRaises(remote.Stop):
                remote.configure(api, {})
            self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_admin_conflict_preserves_both_routes(self):
        api = FakeAPI()
        api.admin = host(13, remote.ADMIN, "unrelated", 443)
        with self.assertRaisesRegex(remote.Stop, "proxy_target_changed"):
            remote.configure(api, {})
        self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_concurrent_owner_edit_stops_before_writes(self):
        api = FakeAPI()
        api.change_yolink = True
        with self.assertRaisesRegex(remote.Stop, "yolink_changed_during_preflight"):
            remote.configure(api, {})
        self.assertTrue(all(method == "GET" for method, _, _ in api.calls))

    def test_certificate_failure_keeps_completed_privacy_fix_and_does_not_retry(self):
        api = FakeAPI()
        api.fail_certificate = True
        result = {}
        with self.assertRaisesRegex(remote.Stop, "api_http_504"):
            remote.configure(api, result)
        self.assertTrue(result["yolink_settings_verified"])
        self.assertEqual(result["phase"], "admin_certificate")
        self.assertIsNone(api.admin)
        self.assertEqual(sum(method == "POST" for method, _, _ in api.calls), 1)

    def test_optional_two_factor_uses_normal_api_and_retains_no_output_token(self):
        api = remote.API()
        answers = iter([{"requires_2fa": True, "challenge_token": "fixture-challenge"}, {"token": "fixture-bearer"}])
        with patch.object(api, "call", side_effect=lambda *a: next(answers)) as call:
            api.login({"identity": "owner@example.invalid", "secret": "fixture-password", "code": "123456"})
            self.assertEqual(call.call_args.args[1], "/api/tokens/2fa")
            self.assertEqual(call.call_args.args[2], {"challenge_token": "fixture-challenge", "code": "123456"})
        self.assertEqual(api.token, "fixture-bearer")

    def test_missing_second_factor_stops_without_configuration_calls(self):
        api = remote.API()
        with patch.object(api, "call", return_value={"requires_2fa": True, "challenge_token": "fixture"}) as call:
            with self.assertRaisesRegex(remote.Stop, "two_factor_code_required"):
                api.login({"identity": "owner@example.invalid", "secret": "fixture-password"})
            self.assertEqual(call.call_count, 1)

    def test_owner_cancel_does_not_collect_credentials_or_run_ssh(self):
        with patch.object(local.sys.stdin, "isatty", return_value=True), \
                patch.object(local.sys.stdout, "isatty", return_value=True), \
                patch("builtins.input", return_value="CANCEL"), \
                patch("builtins.print"), patch.object(local.getpass, "getpass") as secret, \
                patch.object(local.subprocess, "run") as execute:
            local.main()
            secret.assert_not_called()
            execute.assert_not_called()

    def test_remote_requires_owner_confirmation_before_network_or_locks(self):
        stream = type("Input", (), {"buffer": io.BytesIO(b'{"approved":false}')})()
        with patch.object(remote.sys, "stdin", stream), patch.object(remote.sys, "stdout", io.StringIO()) as out, \
                patch.object(remote.socket, "getaddrinfo") as dns:
            self.assertEqual(remote.main(), 1)
            self.assertEqual(json.loads(out.getvalue())["code"], "owner_confirmation_required")
            dns.assert_not_called()


if __name__ == "__main__":
    unittest.main()
