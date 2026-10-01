# Home Watch

A responsive, read-only YoLink dashboard for Manhattan and East Hampton. The local preview uses **illustrative sample data**. It has never been connected to Jim's YoLink account.

## Current state

- `npm run dev` starts sample mode on `127.0.0.1:4318`. Sample mode never reads credentials or calls YoLink.
- `npm run check` checks JavaScript syntax and runs the focused tests.
- `YOLINK_MODE=cloud` is the deployment mode. It requires Google sign-in, a dedicated PostgreSQL database, and server-held encryption/session secrets. It fails closed when these are absent. The dedicated database and server secrets are provisioned on the shared EC2 host; public service startup awaits the Google credential handoff and HTTPS route.
- The public connection path is pending YoSmart developer registration. No public UAC collection form exists. A narrowly scoped personal UAC adapter is implemented for a separately approved Jim-only pilot; no UAC has been created or used.

## Architecture

The single Node 22 container serves the web UI and `GET /api/v1/dashboard`. Google OpenID Connect code flow uses state, PKCE, nonce, signed ID token validation, and an eight-hour HttpOnly/Secure/SameSite cookie. Any verified Google user may sign in, but server queries use that user's Google subject; PostgreSQL row-level security enforces the same subject per transaction. An unconnected user sees no household data. A later iOS app can consume the versioned API with a separately configured Google native client audience, but native sign-in and end-to-end device acceptance have not been built or tested.

Each YoLink connection and cached snapshot belongs to one Google subject. Credential blobs are designed for AES-256-GCM encryption, with the encryption key held outside the database and container image. No connection-creation route is exposed yet. The planned public flow uses YoSmart OAuth after the vendor confirms current app registration, authorization flow, permissions, multi-home mapping, and any fees. UAC is personal account access, not a substitute for a registered third-party OAuth app.

The personal UAC adapter calls only `Home.getGeneralInfo`, `Home.getDeviceList`, and allowlisted `*.getState` methods over HTTPS. It confirms the returned home ID before listing devices, limits to 90 state calls per five-minute cycle per connection, and never returns device net tokens to clients. It does not call control methods, request historical data, or use MQTT. Current YoSmart MQTT documentation does not establish a TLS endpoint, so tokens are never sent to documented plaintext MQTT ports. Device `reportAt` and dashboard `fetchedAt` are distinct; an old report is not presented as a fresh dry reading.

## Shared EC2 deployment

The existing `/Users/jgreco/code/deploy` stack runs PostgreSQL 16 and Nginx Proxy Manager. Deployment uses an isolated Compose project on its existing internal network. Progress and remaining steps:

1. **Prepared:** isolated `yolink_dashboard` database, restricted `yolink_dashboard_app` role, and [migration](db/001_initial.sql). The app pool and role are capped at three connections. No other app database is used.
2. **Prepared:** separate `yolink-dashboard` Compose project on the internal network, exposed only to the proxy at port 4318, with an exact-commit ARM64 image. It is limited to 128 MiB and 0.35 CPU. The public service has not been started.
3. **Pending:** HTTPS proxy host and DNS record for `yolink.jim-greco.com`. `PUBLIC_ORIGIN` is configurable for a later custom domain.
4. **User handoff pending:** dedicated Google OAuth web client authorized for `https://yolink.jim-greco.com/auth/callback`, using only `openid email`. Generated session/encryption/database secrets already reside in `~/yolink-dashboard/private/runtime.env` on EC2 (0600 file, 0700 directory). The [setup helper and runbook](deploy/README.md) securely install the user-selected Google client download over SSH without showing its secret to the agent.
5. After YoSmart confirms and grants developer app access, a reviewed per-user YoLink OAuth connection flow. Until then, cloud users remain explicitly disconnected.

The user approved the bounded EC2 deployment, DNS/proxy changes, database/role creation, Google OAuth configuration, and server-only key generation/storage on September 30. Capacity and proxy conflicts were checked before provisioning; existing services were not restarted. Live YoLink credential handling still needs its separate approved setup. Existing PostgreSQL has had connection-capacity pressure, which is why this service has a small pool and no background worker.

**Secret-entry handoff:** no credential belongs in chat, Git, logs, sample fixtures, or browser JavaScript. For the public product, the user should authorize YoLink on YoSmart's own confirmed OAuth page once vendor access is ready. For a separately approved personal UAC pilot, Jim should create the personal access credential in the YoLink app and enter it through an approved private handoff at setup time; the agent must not read or handle it before that approval. Confirm whether Manhattan and East Hampton are distinct YoLink *Homes* or devices within one YoLink Home before mapping connections. If distinct, each Home needs a home-associated credential; if one, devices need an explicit house assignment.

## API and limitations

`GET /api/health` is a non-sensitive process health response. `GET /api/v1/dashboard` returns only the signed-in user's normalized device data, timestamps, errors, and connection status. Both are read-only. The dashboard refreshes its own API every minute; the optional personal UAC adapter polls at most once per five minutes per connection. The production database is provisioned and its row isolation has been checked using rolled-back synthetic records. No YoLink data has been fetched, and no public HTTPS deployment or real Google login has been verified.

Official references: [UAC setup](https://doc.yosmart.com/docs/overall/qsg_uac/), [home methods](https://doc.yosmart.com/docs/account/Home/), [leak sensor state](https://doc.yosmart.com/docs/yolinkapi/LeakSensor/), [YoSmart OAuth app setup](https://doc.yosmart.com/docs/overall/qsg_csid/).
