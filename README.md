# Home Watch

A responsive, owner-only, read-only YoLink dashboard for Manhattan and East Hampton. Both real Homes were connected by Jim on October 8, 2026. The local preview uses **illustrative sample data** and never contacts his account.

## Current state

- `npm run dev` starts sample mode on `127.0.0.1:4318`. Sample mode never reads credentials or calls YoLink.
- `npm run check` checks JavaScript syntax and runs the focused tests.
- `YOLINK_MODE=cloud` is the deployment mode. It requires Google sign-in, a dedicated PostgreSQL database, and server-held encryption/session secrets. It fails closed when these are absent. The dedicated database and server secrets are provisioned on the shared EC2 host; owner Google login and the public HTTPS route have been verified.
- This is Jim's private dashboard. `OWNER_GOOGLE_EMAIL` is required in cloud mode; other Google users are rejected, including previously signed sessions. Personal UAC setup is available only through a user-run SSH helper. Jim privately submitted one UAC for each distinct Home; both are stored encrypted and have completed normal read-only dashboard refreshes. Commercial OAuth/API registration is not part of this project.

## Architecture

The single Node 22 container serves the web UI and `GET /api/v1/dashboard`. Google OpenID Connect code flow uses state, PKCE, nonce, signed ID token validation, and an eight-hour HttpOnly/Secure/SameSite cookie backed by a hashed, owner-scoped PostgreSQL session record. Only the configured owner's verified Google account can sign in. The owner restriction is also enforced on each session or native-token request; PostgreSQL row-level security independently scopes queries to the owner's subject. A later personal iOS app can use a separately configured Google native client audience, but native sign-in and end-to-end device acceptance remain unbuilt and unverified.

Each personal YoLink connection and cached snapshot belongs to the owner's Google subject. The private setup helper encrypts credentials with AES-256-GCM and binds them to the owner and connection; its key stays outside the database and container image. No HTTP credential-entry or connection-creation route exists. Setup discovers the actual YoLink Home ID and rechecks it before storage; every poll verifies that same ID. If both houses share one YoLink Home, device assignments split its single connection into Manhattan/East Hampton; newly discovered unmapped devices appear under Unassigned. A second credential is needed only for a distinct actual YoLink Home.

The personal UAC adapter calls only `Home.getGeneralInfo`, `Home.getDeviceList`, and allowlisted `*.getState` methods over HTTPS. It confirms the returned home ID before listing devices, limits to 90 state calls per five-minute cycle per connection, and never returns device net tokens to clients. It does not call control methods, request historical data, or use MQTT. Current YoSmart MQTT documentation does not establish a TLS endpoint, so tokens are never sent to documented plaintext MQTT ports. Device `reportAt` and dashboard `fetchedAt` are distinct; an old report is not presented as a fresh dry reading.

## Shared EC2 deployment

The existing `/Users/jgreco/code/deploy` stack runs PostgreSQL 16 and Nginx Proxy Manager. Home Watch runs as the `yolink-dashboard` service of that shared Compose project and releases through the shared [release-tools](https://github.com/jimgreco/release-tools) flow (see [deploy/README.md](deploy/README.md)). Progress and remaining steps:

1. **Verified:** isolated `yolink_dashboard` database, restricted `yolink_dashboard_app` role, and [migration](db/001_initial.sql). The app pool and role are capped at three connections. No other app database is used.
2. **Running:** `yolink-dashboard` service (profile `yolink`) in the shared `deploy` Compose project on the internal network, exposed only to the proxy at port 4318. Every push to `main` builds an exact-commit arm64 GHCR image and releases it after a verified database backup. It is limited to 128 MiB and 0.35 CPU.
3. **Verified:** HTTPS proxy host and DNS record for `yolink.jim-greco.com`. `PUBLIC_ORIGIN` is configurable for a later custom domain.
4. **Owner handoff completed:** dedicated Google OAuth web client authorized for `https://yolink.jim-greco.com/auth/callback`, using only `openid email`. Generated session/encryption/database secrets already reside in `~/yolink-dashboard/private/runtime.env` on EC2 (0600 file, 0700 directory). The [setup helper and runbook](deploy/README.md) securely install the user-selected Google client download over SSH without showing its secret to the agent.
5. **Owner handoff completed:** two separate personal YoLink Homes using the [private setup instructions](deploy/PERSONAL_SETUP.md). The first checks returned state data for 5 Manhattan and 11 East Hampton devices. Owner-run encrypted recovery backups were completed before and after connection; object metadata was independently verified. This is not a full restore rehearsal or ongoing scheduled backup coverage.

The user approved the bounded EC2 deployment, DNS/proxy changes, database/role creation, Google OAuth configuration, and server-only key generation/storage on September 30. Capacity and proxy conflicts were checked before provisioning; existing services were not restarted. The separately approved Google and personal YoLink handoffs were completed by Jim on October 7–8. Existing PostgreSQL has had connection-capacity pressure, which is why this service has a small pool and no background worker.

**Secret-entry handoff:** no credential belongs in chat, Git, logs, sample fixtures, or browser JavaScript. After explicit personal-UAC approval, Jim creates the personal credential in his YoLink app and enters it himself in `deploy/configure-yolink.command`. Hidden Terminal fields submit over SSH to his EC2 server; the helper never writes the UAC to a local file. Jim reviews the actual Home inventory and house assignments before typing SAVE. The assistant does not enter, submit, or inspect these credentials. The approved owner-run handoff remains required for any future connection.

## API and limitations

`GET /api/health` is a non-sensitive process health response. `GET /api/v1/dashboard` returns only the signed-in user's normalized device data, timestamps, errors, and connection status. Both are read-only. The dashboard refreshes its own API every minute; the optional personal UAC adapter polls at most once per five minutes per connection. The production database is provisioned and its row isolation has been checked using rolled-back synthetic records. Public HTTPS, real owner Google login, and the first read-only refresh of both Homes are verified. Comparing displayed readings with the phone app and exercising real-browser logout remain owner acceptance steps.

Official references: [UAC setup](https://doc.yosmart.com/docs/overall/qsg_uac/), [home methods](https://doc.yosmart.com/docs/account/Home/), [leak sensor state](https://doc.yosmart.com/docs/yolinkapi/LeakSensor/), [YoSmart OAuth app setup](https://doc.yosmart.com/docs/overall/qsg_csid/).

## Session and refresh release — October 7, 2026

Deployed as revision `711552bb1b336e6c6d58c7ffb24badefff9f4112`. Browser sign-out is a same-origin POST and
revokes the stored session before clearing its cookie. **Sign out all browsers**
revokes every browser session for the owner; it does not revoke Google consent,
YoLink credentials, or optional native Google bearer tokens. Replayed and legacy
stateless cookies are rejected, including after another server instance revokes
the record. Existing cookies must sign in again after this release. A dedicated
signed-out page avoids immediately starting another Google login.

Apply additive migration `db/003_browser_sessions.sql` only to
`yolink_dashboard`, then grant the existing restricted role SELECT/INSERT/DELETE
on `dashboard_sessions` using the guarded [activation transaction and retention
plan](deploy/SESSION_ACTIVATION.md), without rerunning bootstrap. Forced row-level
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
The isolated YoLink container is healthy. The private environment file exists
with mode 0600; its contents were not inspected by the assistant. The approved
owner configuration handoffs, public HTTPS and real Google login are complete.
The current personal route is documented by [YoSmart](https://doc.yosmart.com/docs/overall/qsg_uac/)
and is Home-scoped; commercial registration is unnecessary for this design.

Historical October 7 validation: `npm run check` passed 21 tests (the separate activation
fixture test skips in that invocation) when
`HOME_WATCH_TEST_DATABASE_URL` names a fresh loopback-only database whose name
begins `home_watch_test_`. This includes actual PostgreSQL migrations and forced
RLS, two-store session revocation, concurrent refresh claims, failed reads,
Home-ID mismatch, disabled connections and credential replacement. The database
test skips when its explicit local fixture URL is absent; it refuses nonlocal
hosts or production-like database names. Browser fixture inspection covers
390-pixel phone width and both sign-out controls. No real Google or YoLink call
was made by these tests.

The activation SQL has a separate marked, isolated PostgreSQL fixture test.
`HOME_WATCH_ACTIVATION_TEST_DATABASE_URL` must use an ephemeral loopback port,
user `admin`, database `yolink_dashboard`, and database comment
`ops-activation-synthetic-only`. It requires an empty disposable local cluster,
creates only synthetic users and a restricted test role, and checks atomic guard
failure, unchanged baseline rows, exact grants, RLS, replay refusal and wrong-DB
refusal. Never point this test at the shared host.


## Temperature and humidity cards — October 8, 2026

The climate release retains the selected measurements from the existing
`THSensor.getState` response instead of replacing them with its generic
`normal` status. Cards show temperature in Fahrenheit and Celsius, relative
humidity, device-reported high/low alarms, configured temperature/humidity alert
ranges, battery, connectivity and report time. These ranges are sensor settings,
not observed minimum/maximum history. No new API requests or controls are added.
Unknown units are labeled; missing/invalid readings remain unknown. Failed checks
retain prior readings and alarms with explicit last-known labels. A successful
API check does not make an old device report fresh.

Source contract: [YoLink THSensor state](https://doc.yosmart.com/docs/yolinkapi/THSensor/).
The new fields fill in after each Home's next normal five-minute refresh claim;
older cached rows show unavailable measurements until then.

See [the bounded climate release scope](deploy/CLIMATE_RELEASE.md) before
publication. This section describes the prepared change, not a live release.
