# Private owner handoff for Nginx HTTPS

Prepared against the installed Nginx Proxy Manager 2.14.0 public API schemas and
source. The owner created the Cloudflare `nginx.jim-greco.com` A record on
October 8. Authoritative DNS confirms Cloudflare-proxied answers. HTTPS still
returns 525 until the origin certificate and admin route are configured.

## Exact changes

- Update only existing YoLink proxy host **12**, after confirming its sole domain
  is `yolink.jim-greco.com`, upstream is `http://yolink-dashboard:4318`, it has a
  certificate, and it is enabled. Set Force SSL on and caching off. Add the
  dedicated `/auth/callback` child location with the same upstream and:

  ```nginx
  access_log off;
  error_log /dev/null crit;
  ```

- Request or reuse a valid, dedicated Let's Encrypt certificate for only
  `nginx.jim-greco.com`. Use HTTP validation and the authenticated NPM account's
  existing email (selected by NPM 2.14.0 itself). Nginx Proxy
  Manager owns the certificate and its normal renewal process.
- Add the HTTPS admin proxy `nginx.jim-greco.com` → `http://127.0.0.1:81`, with
  Force SSL, caching off and the existing NPM login still required. An existing
  route with unexpected upstream or custom configuration stops the helper.
- Keep public port 81, its security-group rule, all existing log files, unrelated
  routes, credentials and Cloudflare TLS settings unchanged. NPM performs normal
  configuration reloads; this helper never restarts a container or writes its
  database/configuration files directly.

## Jim's step

During the parent-coordinated proxy window, Jim opens
`deploy/configure-proxy.command` himself in Terminal. It describes the changes,
links the current Let's Encrypt Subscriber Agreement, and waits for **SETUP**.
Typing SETUP approves this exact run and certificate terms. The helper then asks
for his existing NPM email/password and optional current two-factor code in
hidden fields. The assistant must not enter, submit, capture or inspect them.

The local helper sends those values over the existing pinned SSH connection to
a short-lived Python process on EC2. No SSH tunnel is created. That process
authenticates through NPM's normal API on `127.0.0.1:81`, preserving normal
permissions and two-factor requirements. It keeps credentials and its bearer
token in memory and returns only fixed status fields and public route/cert IDs.
It does not read stored credentials, private environment contents or access logs.

The process holds the two existing shared-host release locks during its work
and refuses a busy slot. It checks for conflicting routes and concurrent owner
edits before updates. There is no automatic retry, certificate deletion, or
rollback of other configuration. A partial failure reports the completed phase;
a timed-out certificate request may still be running, so stop and inspect safe
metadata before another attempt.

After **Configured: https://nginx.jim-greco.com**, Jim reports only **proxy setup
done**. The assistant then verifies public and origin TLS, the HTTPS redirect,
public health/unauthenticated gating, generated callback logging directives and
unchanged port-81 reachability. The private recovery/UAC handoff follows only
under its existing approval and owner-execution boundary.

## Local checks

`python3 -m unittest discover -s test -p 'proxy_setup_test.py' -v`

The fixtures exercise exact scope, preservation, repeat safety, conflicts,
concurrent edits, certificate failure, normal optional two-factor authentication,
cancellation and required owner confirmation. They perform no network calls,
credential collection or production mutations. No live configuration run is
claimed by these tests.

The certificate metadata contract fixture is copied from the installed public
`/app/schema/components/certificate-object.json` schema. NPM 2.14.0 rejects the
obsolete `letsencrypt_email` and `letsencrypt_agree` metadata fields; the helper
must not send them. Owner consent to the terms is collected locally, while NPM
uses the authenticated account email for its certificate request.
