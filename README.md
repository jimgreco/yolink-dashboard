# Home Watch

A responsive, read-only YoLink dashboard for Manhattan and East Hampton. The local preview uses **illustrative sample data**. It has never been connected to Jim's YoLink account.

## Current state

- `npm run dev` starts sample mode on `127.0.0.1:4318`. Sample mode never reads credentials or calls YoLink.
- `npm run check` checks JavaScript syntax and runs the focused tests.
- `YOLINK_MODE=cloud` is the deployment mode. It requires Google sign-in, a dedicated PostgreSQL database, and server-held encryption/session secrets. It fails closed when these are absent. The dedicated database and server secrets are provisioned on the shared EC2 host; public service startup awaits the Google credential handoff and HTTPS route.
- This is Jim's private dashboard. `OWNER_GOOGLE_EMAIL` is required in cloud mode; other Google users are rejected, including previously signed sessions. Personal UAC setup is available only through a user-run SSH helper. No UAC has been created, read, or used. Commercial OAuth/API registration is not part of this project.

## Architecture

The single Node 22 container serves the web UI and `GET /api/v1/dashboard`. Google OpenID Connect code flow uses state, PKCE, nonce, signed ID token validation, and an eight-hour HttpOnly/Secure/SameSite cookie backed by a hashed, owner-scoped PostgreSQL session record. Only the configured owner's verified Google account can sign in. The owner restriction is also enforced on each session or native-token request; PostgreSQL row-level security independently scopes queries to the owner's subject. A later personal iOS app can use a separately configured Google native client audience, but native sign-in and end-to-end device acceptance remain unbuilt and unverified.

Each personal YoLink connection and cached snapshot belongs to the owner's Google subject. The private setup helper encrypts credentials with AES-256-GCM and binds them to the owner and connection; its key stays outside the database and container image. No HTTP credential-entry or connection-creation route exists. Setup discovers the actual YoLink Home ID and rechecks it before storage; every poll verifies that same ID. If both houses share one YoLink Home, device assignments split its single connection into Manhattan/East Hampton; newly discovered unmapped devices appear under Unassigned. A second credential is needed only for a distinct actual YoLink Home.

The personal UAC adapter calls only `Home.getGeneralInfo`, `Home.getDeviceList`, and allowlisted `*.getState` methods over HTTPS. It confirms the returned home ID before listing devices, limits to 90 state calls per five-minute cycle per connection, and never returns device net tokens to clients. It does not call control methods, request historical data, or use MQTT. Current YoSmart MQTT documentation does not establish a TLS endpoint, so tokens are never sent to documented plaintext MQTT ports. Device `reportAt` and dashboard `fetchedAt` are distinct; an old report is not presented as a fresh dry reading.

## Shared EC2 deployment

The existing `/Users/jgreco/code/deploy` stack runs PostgreSQL 16 and Nginx Proxy Manager. Deployment uses an isolated Compose project on its existing internal network. Progress and remaining steps:

1. **Prepared:** isolated `yolink_dashboard` database, restricted `yolink_dashboard_app` role, and [migration](db/001_initial.sql). The app pool and role are capped at three connections. No other app database is used.
2. **Prepared:** separate `yolink-dashboard` Compose project on the internal network, exposed only to the proxy at port 4318, with an exact-commit ARM64 image. It is limited to 128 MiB and 0.35 CPU. The public service has not been started.
3. **Pending:** HTTPS proxy host and DNS record for `yolink.jim-greco.com`. `PUBLIC_ORIGIN` is configurable for a later custom domain.
4. **User handoff pending:** dedicated Google OAuth web client authorized for `https://yolink.jim-greco.com/auth/callback`, using only `openid email`. Generated session/encryption/database secrets already reside in `~/yolink-dashboard/private/runtime.env` on EC2 (0600 file, 0700 directory). The [setup helper and runbook](deploy/README.md) securely install the user-selected Google client download over SSH without showing its secret to the agent.
5. **Separate approval and user handoff pending:** personal YoLink setup using the [private setup instructions](deploy/PERSONAL_SETUP.md). Until completed, the owner sees a clearly disconnected view with no sample household data.

The user approved the bounded EC2 deployment, DNS/proxy changes, database/role creation, Google OAuth configuration, and server-only key generation/storage on September 30. Capacity and proxy conflicts were checked before provisioning; existing services were not restarted. Live YoLink credential handling still needs its separate approved setup. Existing PostgreSQL has had connection-capacity pressure, which is why this service has a small pool and no background worker.

**Secret-entry handoff:** no credential belongs in chat, Git, logs, sample fixtures, or browser JavaScript. After explicit personal-UAC approval, Jim creates the personal credential in his YoLink app and enters it himself in `deploy/configure-yolink.command`. Hidden Terminal fields submit over SSH to his EC2 server; the helper never writes the UAC to a local file. Jim reviews the actual Home inventory and house assignments before typing SAVE. This helper has been tested only with synthetic credentials; do not run it on Jim's credentials until the separate action-time approval and user handoff.

## API and limitations

`GET /api/health` is a non-sensitive process health response. `GET /api/v1/dashboard` returns only the signed-in user's normalized device data, timestamps, errors, and connection status. Both are read-only. The dashboard refreshes its own API every minute; the optional personal UAC adapter polls at most once per five minutes per connection. The production database is provisioned and its row isolation has been checked using rolled-back synthetic records. No YoLink data has been fetched, and no public HTTPS deployment or real Google login has been verified.

Official references: [UAC setup](https://doc.yosmart.com/docs/overall/qsg_uac/), [home methods](https://doc.yosmart.com/docs/account/Home/), [leak sensor state](https://doc.yosmart.com/docs/yolinkapi/LeakSensor/), [YoSmart OAuth app setup](https://doc.yosmart.com/docs/overall/qsg_csid/).

## Session and refresh readiness — October 7, 2026

Prepared locally, not deployed. Browser sign-out is now a same-origin POST and
revokes the stored session before clearing its cookie. **Sign out all browsers**
revokes every browser session for the owner; it does not revoke Google consent,
YoLink credentials, or optional native Google bearer tokens. Replayed and legacy
stateless cookies are rejected, including after another server instance revokes
the record. Existing cookies must sign in again after this release. A dedicated
signed-out page avoids immediately starting another Google login.

Apply additive migration `db/003_browser_sessions.sql` only to
`yolink_dashboard`, then grant the existing restricted role SELECT/INSERT/DELETE
on `dashboard_sessions` as specified by `deploy/bootstrap.py`. Forced row-level
security scopes this table like the existing owner data. Startup and health
verify the sessions table and SELECT grant; database queries are time bounded. Never roll back to the
old stateless-cookie image after accepting this session contract; prepare a
forward fix or stop only this service. No encryption/session secret rotation is
needed. The table stores hashes, not raw browser tokens.

Refreshes have a 120-second overall provider deadline inside the existing
five-minute database claim. Concurrent stores cannot claim the same interval;
late results are discarded after disable, credential replacement, a changed verified Home or a newer
claim. Transient provider failures preserve cached alerts; a Home-ID mismatch
clears cached data. Safe structured events describe request/login failures,
session revocation, and refresh outcomes with duration/device counts. They do
not contain account/device names, subjects, credentials, OAuth codes, URLs or
raw errors. This remains an on-demand dashboard: no background leak monitor or
real notification service has been enabled.

Both private handoff helpers now use `.ssh/ec2-deploy-20261004` with strict host
checking. Their hidden input/explicit CONNECT/SAVE confirmation remains intact.
The host currently has no running YoLink container. The private environment file
exists with mode 0600; its contents were not read. Google credential presence,
owner configuration, public HTTPS and real login still require handoff/acceptance.
The current personal route is documented by [YoSmart](https://doc.yosmart.com/docs/overall/qsg_uac/)
and is Home-scoped; commercial registration is unnecessary for this design.

Local validation: `npm run check` passes 20 tests when
`HOME_WATCH_TEST_DATABASE_URL` names a fresh loopback-only database whose name
begins `home_watch_test_`. This includes actual PostgreSQL migrations and forced
RLS, two-store session revocation, concurrent refresh claims, failed reads,
Home-ID mismatch, disabled connections and credential replacement. The database
test skips when its explicit local fixture URL is absent; it refuses nonlocal
hosts or production-like database names. Browser fixture inspection covers
390-pixel phone width and both sign-out controls. No real Google or YoLink call
was made by these tests.
