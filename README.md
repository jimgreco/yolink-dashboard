# Home Watch

A responsive, read-only YoLink dashboard for Manhattan and East Hampton. The local preview uses **illustrative sample data**. It has never been connected to Jim's YoLink account.

## Current state

- `npm run dev` starts sample mode on `127.0.0.1:4318`. Sample mode never reads credentials or calls YoLink.
- `npm run check` checks JavaScript syntax and runs the focused tests.
- `YOLINK_MODE=cloud` is the deployment mode. It requires Google sign-in, a dedicated PostgreSQL database, and server-held encryption/session secrets. It fails closed when these are absent. It has **not** been configured or deployed.
- The public connection path is pending YoSmart developer registration. No public UAC collection form exists. A narrowly scoped personal UAC adapter is implemented for a separately approved Jim-only pilot; no UAC has been created or used.

## Architecture

The single Node 22 container serves the web UI and `GET /api/v1/dashboard`. Google OpenID Connect code flow uses state, PKCE, nonce, signed ID token validation, and an eight-hour HttpOnly/Secure/SameSite cookie. Any verified Google user may sign in, but server queries use that user's Google subject; PostgreSQL row-level security enforces the same subject per transaction. An unconnected user sees no household data. A later iOS app can consume the versioned API with a separately configured Google native client audience, but native sign-in and end-to-end device acceptance have not been built or tested.

Each YoLink connection and cached snapshot belongs to one Google subject. Credential blobs are designed for AES-256-GCM encryption, with the encryption key held outside the database and container image. No connection-creation route is exposed yet. The planned public flow uses YoSmart OAuth after the vendor confirms current app registration, authorization flow, permissions, multi-home mapping, and any fees. UAC is personal account access, not a substitute for a registered third-party OAuth app.

The personal UAC adapter calls only `Home.getGeneralInfo`, `Home.getDeviceList`, and allowlisted `*.getState` methods over HTTPS. It confirms the returned home ID before listing devices, limits to 90 state calls per five-minute cycle per connection, and never returns device net tokens to clients. It does not call control methods, request historical data, or use MQTT. Current YoSmart MQTT documentation does not establish a TLS endpoint, so tokens are never sent to documented plaintext MQTT ports. Device `reportAt` and dashboard `fetchedAt` are distinct; an old report is not presented as a fresh dry reading.

## Proposed shared EC2 fit

The existing `/Users/jgreco/code/deploy` stack runs PostgreSQL 16 and Nginx Proxy Manager. Its app-specific Compose profiles are a suitable pattern. The proposed production changes, **not yet applied**, are:

1. An isolated `yolink_dashboard` database and restricted `yolink_dashboard_app` role in `shared_db`; run [the migration](db/001_initial.sql). The app pool is capped at three connections. No other app database is used.
2. A separate `yolink` Compose profile/container on the internal Compose network, exposed only to the proxy at port 4318. Build an exact-commit ARM64 image and deploy only this profile so unrelated services are not restarted.
3. An HTTPS proxy host and DNS record for `yolink.jim-greco.com`. `PUBLIC_ORIGIN` is configurable for a later custom domain.
4. A Google OAuth web client authorized for `https://yolink.jim-greco.com/auth/callback` with only `openid email`. Keep its client secret, a random session secret, a random 32-byte encryption key, and the database URL in a private server environment file outside Git and the image.
5. After YoSmart confirms and grants developer app access, a reviewed per-user YoLink OAuth connection flow. Until then, cloud users remain explicitly disconnected.

Cloud deployment, DNS/proxy changes, database/role creation, Google OAuth configuration, key generation/storage, and any YoLink credential handling require a concrete action-time approval. The currently tracked Compose file does not prove live EC2 capacity, proxy configuration, available subdomain, or Google client setup; verify those before changing them. Existing PostgreSQL has had connection-capacity pressure, which is why this service has a small pool and no background worker.

**Secret-entry handoff:** no credential belongs in chat, Git, logs, sample fixtures, or browser JavaScript. For the public product, the user should authorize YoLink on YoSmart's own confirmed OAuth page once vendor access is ready. For a separately approved personal UAC pilot, Jim should create the personal access credential in the YoLink app and enter it through an approved private handoff at setup time; the agent must not read or handle it before that approval. Confirm whether Manhattan and East Hampton are distinct YoLink *Homes* or devices within one YoLink Home before mapping connections. If distinct, each Home needs a home-associated credential; if one, devices need an explicit house assignment.

## API and limitations

`GET /api/health` is a non-sensitive process health response. `GET /api/v1/dashboard` returns only the signed-in user's normalized device data, timestamps, errors, and connection status. Both are read-only. The dashboard refreshes its own API every minute; the optional personal UAC adapter polls at most once per five minutes per connection. No YoLink data has been fetched, no production database query has run, and no cloud deployment or real Google login has been verified.

Official references: [UAC setup](https://doc.yosmart.com/docs/overall/qsg_uac/), [home methods](https://doc.yosmart.com/docs/account/Home/), [leak sensor state](https://doc.yosmart.com/docs/yolinkapi/LeakSensor/), [YoSmart OAuth app setup](https://doc.yosmart.com/docs/overall/qsg_csid/).
