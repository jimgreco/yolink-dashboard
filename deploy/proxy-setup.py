#!/usr/bin/env python3
"""Owner-triggered, authenticated NPM setup, executed on EC2 over SSH stdin.

Never read stored credentials, private environment files, keys, or access logs.
Only sanitized phase/status metadata is returned to the owner's local helper.
"""
import contextlib
import datetime as dt
import fcntl
import json
import os
import socket
import stat
import sys
import urllib.error
import urllib.request

ADMIN = "nginx.jim-greco.com"
YOLINK = "yolink.jim-greco.com"
YOLINK_ID = 12
CALLBACK = {"path": "/auth/callback", "forward_scheme": "http",
            "forward_host": "yolink-dashboard", "forward_port": 4318,
            "forward_path": "", "advanced_config": "access_log off;\nerror_log /dev/null crit;"}


class Stop(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Stop(code)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class API:
    def __init__(self):
        self.token = None
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def call(self, method, path, data=None):
        require(path.startswith("/api/") and "\n" not in path, "api_path")
        headers = {"Content-Type": "application/json", "User-Agent": "HomeWatchOwnerSetup/1.0"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = urllib.request.Request("http://127.0.0.1:81" + path,
                                         data=None if data is None else json.dumps(data).encode(),
                                         headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=180) as response:
                raw = response.read(1024 * 1024 + 1)
                require(len(raw) <= 1024 * 1024, "api_response_size")
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            raise Stop("api_http_" + str(error.code)) from None
        except (urllib.error.URLError, TimeoutError, socket.timeout):
            raise Stop("api_unavailable_or_timeout") from None

    def login(self, payload):
        token = self.call("POST", "/api/tokens", {"identity": payload["identity"], "secret": payload["secret"]})
        if token.get("requires_2fa"):
            require(bool(payload.get("code")), "two_factor_code_required")
            token = self.call("POST", "/api/tokens/2fa", {"challenge_token": token["challenge_token"], "code": payload["code"]})
        require(isinstance(token.get("token"), str) and token["token"], "login_token_missing")
        self.token = token["token"]


@contextlib.contextmanager
def release_locks():
    descriptors = []
    try:
        for path in ("/tmp/codex-shared-host-release.lock", "/home/ec2-user/deploy/.app-release.lock"):
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            descriptors.append(fd)
            value = os.fstat(fd)
            require(stat.S_ISREG(value.st_mode) and value.st_uid == os.geteuid()
                    and value.st_nlink == 1 and not value.st_mode & 0o002, "release_lock_metadata")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Stop("shared_host_busy") from None
        yield
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def host_guard(row, domain, host, port):
    require(row.get("domain_names") == [domain] and row.get("forward_scheme") == "http"
            and row.get("forward_host") == host and row.get("forward_port") == port
            and row.get("enabled") in (True, 1), "proxy_target_changed")
    require(type(row.get("id")) is int and row["id"] > 0, "proxy_identifier")


def same_host(left, right):
    # List and detail endpoints may expand different non-config relationships.
    # Compare persisted configuration and its modification marker, not expansions.
    keys = ("id", "modified_on", "domain_names", "forward_scheme", "forward_host",
            "forward_port", "enabled", "certificate_id", "ssl_forced", "caching_enabled",
            "access_list_id", "block_exploits", "advanced_config", "locations",
            "owner_user_id", "allow_websocket_upgrade", "http2_support", "hsts_enabled",
            "hsts_subdomains", "trust_forwarded_proto")
    return all(left.get(key) == right.get(key) for key in keys)


def callback_patch(row):
    require(row.get("id") == YOLINK_ID, "yolink_identifier_changed")
    host_guard(row, YOLINK, "yolink-dashboard", 4318)
    require(type(row.get("certificate_id")) is int and row["certificate_id"] > 0, "yolink_certificate_missing")
    locations = row.get("locations", [])
    require(isinstance(locations, list), "callback_locations_changed")
    if locations:
        require(len(locations) == 1 and all(locations[0].get(k, "") == v for k, v in CALLBACK.items()),
                "existing_custom_locations_require_review")
    return {"ssl_forced": True, "caching_enabled": False,
            "locations": locations or [dict(CALLBACK)]}


def valid_certificate(row):
    require(type(row.get("id")) is int and row["id"] > 0 and
            row.get("provider") == "letsencrypt" and row.get("domain_names") == [ADMIN],
            "admin_certificate_changed")
    try:
        expiry = dt.datetime.fromisoformat(row["expires_on"].replace("Z", "+00:00"))
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=dt.timezone.utc)
    except (KeyError, ValueError, TypeError):
        raise Stop("admin_certificate_incomplete") from None
    require(expiry > dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1), "admin_certificate_not_valid")
    return row["id"]


def configure(api, progress):
    # Read both exact targets before any mutation; do not override owner changes.
    progress["phase"] = "preflight"
    yolink = api.call("GET", "/api/nginx/proxy-hosts/12")
    patch = callback_patch(yolink)
    found = api.call("GET", "/api/nginx/proxy-hosts?query=" + ADMIN)
    require(isinstance(found, list) and len(found) <= 1, "admin_hostname_conflict")
    admin = found[0] if found else None
    if admin:
        host_guard(admin, ADMIN, "127.0.0.1", 81)
        require(not admin.get("advanced_config") and not admin.get("locations"), "admin_custom_config_requires_review")
    certs = api.call("GET", "/api/nginx/certificates?query=" + ADMIN)
    require(isinstance(certs, list) and len(certs) <= 1, "admin_certificate_conflict")
    certificate_id = valid_certificate(certs[0]) if certs else None

    progress["phase"] = "yolink_settings"
    # Detect edits made while preparing the certificate/host plan.
    current = api.call("GET", "/api/nginx/proxy-hosts/12")
    require(same_host(current, yolink), "yolink_changed_during_preflight")
    if any(yolink.get(k) != v for k, v in patch.items()):
        api.call("PUT", "/api/nginx/proxy-hosts/12", patch)
    current = api.call("GET", "/api/nginx/proxy-hosts/12")
    callback_patch(current)
    require(all(current.get(k) == v for k, v in patch.items()) and
            current.get("meta", {}).get("nginx_online") in (True, 1), "yolink_proxy_verification")
    progress["yolink_settings_verified"] = True

    progress["phase"] = "admin_certificate"
    if certificate_id is None:
        certificate_id = valid_certificate(api.call("POST", "/api/nginx/certificates", {
            "provider": "letsencrypt", "domain_names": [ADMIN],
            "meta": {"letsencrypt_email": "jgreco@gmail.com", "letsencrypt_agree": True, "dns_challenge": False}}))
    progress["admin_certificate_id"] = certificate_id

    progress["phase"] = "admin_proxy"
    tls = {"certificate_id": certificate_id, "ssl_forced": True, "caching_enabled": False}
    if admin is None:
        created = api.call("POST", "/api/nginx/proxy-hosts", dict(tls,
            domain_names=[ADMIN], forward_scheme="http", forward_host="127.0.0.1",
            forward_port=81, access_list_id=0, block_exploits=True, advanced_config="",
            locations=[], enabled=True, allow_websocket_upgrade=False, http2_support=True,
            hsts_enabled=False, hsts_subdomains=False, trust_forwarded_proto=False))
        host_guard(created, ADMIN, "127.0.0.1", 81)
        admin_id = created["id"]
    else:
        admin_id = admin["id"]
        current = api.call("GET", "/api/nginx/proxy-hosts/" + str(admin_id))
        require(same_host(current, admin), "admin_changed_during_preflight")
        if any(current.get(k) != v for k, v in tls.items()):
            api.call("PUT", "/api/nginx/proxy-hosts/" + str(admin_id), tls)
    current = api.call("GET", "/api/nginx/proxy-hosts/" + str(admin_id))
    host_guard(current, ADMIN, "127.0.0.1", 81)
    require(all(current.get(k) == v for k, v in tls.items()) and
            current.get("meta", {}).get("nginx_online") in (True, 1), "admin_proxy_verification")
    progress.update(phase="complete", status="configured", admin_proxy_id=admin_id,
                    admin_url="https://" + ADMIN, port81_access_changed=False)


def main():
    progress = {"status": "stopped", "phase": "input", "yolink_settings_verified": False}
    try:
        raw = sys.stdin.buffer.read(16385)
        require(len(raw) <= 16384, "input_size")
        payload = json.loads(raw)
        require(payload.get("approved") is True and payload.get("agree_letsencrypt") is True,
                "owner_confirmation_required")
        require(all(isinstance(payload.get(k), str) and 0 < len(payload[k]) <= 4096
                    for k in ("identity", "secret")), "login_input")
        progress["phase"] = "dns"
        socket.getaddrinfo(ADMIN, 443)
        with release_locks():
            progress["phase"] = "login"
            api = API()
            api.login(payload)
            payload.clear()
            configure(api, progress)
            api.token = None
    except Stop as error:
        progress["code"] = str(error)
    except Exception:
        progress["code"] = "setup_unavailable_sensitive_details_suppressed"
    print(json.dumps(progress))
    return 0 if progress["status"] == "configured" else 1


if __name__ == "__main__":
    sys.exit(main())
