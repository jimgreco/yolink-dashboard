# Shared EC2 deployment

User approval on September 30 covers the isolated service/database, HTTPS route,
Google sign-in, and server-only credentials. No paid infrastructure is needed.
Jim chose personal-only access on October 1. Commercial YoLink OAuth/API access
is out of scope. Personal UAC creation/use still requires its explicit approval
and the [private user handoff](PERSONAL_SETUP.md).

The release lives under `~/yolink-dashboard/releases/<git-sha>` on EC2. Its own
Compose project uses the existing `deploy_default` network and hostname
`yolink-dashboard:4318`. It has no published host port, a 128 MiB memory limit,
a 0.35 CPU limit, and a read-only container filesystem. The shared stack's
Compose file is not changed. The database is `yolink_dashboard`, owned by the
existing database administrator; the app role has no schema ownership or RLS
bypass and is limited to three connections.

Run `python3 deploy/bootstrap.py` from a release on EC2 to prepare this namespace.
The bootstrap refuses a pre-existing database/role unless its own private marker
exists. Generated database/session/encryption secrets stay in
`~/yolink-dashboard/private/runtime.env` with mode 0600, inside a 0700 directory.
This file must be included in the owner's encrypted backups before any live
YoLink connection is added; losing its encryption key makes stored connections
unrecoverable. No YoLink credential is configured by these scripts.

## Google credential handoff

In the user's ordinary Google Chrome browser, open the existing Google Cloud
project's **Google Auth Platform → Clients**. Create a dedicated OAuth client:

- Application type: **Web application**.
- Name: **Home Watch — YoLink**.
- Authorized redirect URI: `https://yolink.jim-greco.com/auth/callback`.
- This server uses only `openid email`; no Google data API permissions are needed.
- The server requires `OWNER_GOOGLE_EMAIL=jgreco@gmail.com`; all other accounts
  are rejected. `OWNER_GOOGLE_SUB` can additionally pin the verified subject.
- Download its JSON file. Do not paste its contents or secret into chat.

After the server bootstrap, the user double-clicks `configure-google.command` in
this directory and selects that downloaded JSON file. The helper submits the
file directly over pinned-host SSH to the restricted server-side installer.
The installer validates the exact callback, accepts only the two Google fields,
refuses to replace existing Google credentials, and writes mode 0600. It never
echoes the secret or starts the service. The user's local download remains in
the chosen download folder; it is never copied into the repository.

Browser-auth credential collection, when available, is for ordinary sign-in.
It is not an API-secret uploader. If the environment cannot control Chrome,
the user must complete this handoff in their own browser and Terminal.

## Release and checks

Build an image tagged with the full Git SHA on ARM64 EC2. Store
`YOLINK_IMAGE=yolink-dashboard:<sha>` in `~/yolink-dashboard/release.env`.
Validate Compose with `docker-compose --env-file release.env -p yolink-dashboard
-f compose.yaml config --quiet`; never print expanded configuration.

Before starting the service, run the image with its private environment,
`deploy_default` network, and `node --input-type=module` reading `deploy/smoke.mjs`
on stdin. The probe uses actual database permissions, rolls back all synthetic
rows, verifies cloud HTTP gating, and never calls Google or YoLink. Its temporary
Google placeholders are never saved. This is not a real Google login test.

Start only this Compose project after Google setup, then configure Nginx Proxy
Manager for `yolink.jim-greco.com` → `http://yolink-dashboard:4318` with a valid
certificate, forced HTTPS, and no caching. Disable access logging for
`/auth/callback` or log `$uri` without query strings so OAuth codes are not logged.
The Cloudflare DNS A record points to the existing server `18.219.163.101`.
TLS must validate between Cloudflare and the origin (Full strict); do not change
the zone's existing TLS mode or use an unrelated hostname's certificate.

Verify public HTTPS, unauthenticated API 401, owner-only Google login, empty disconnected
state, no sample homes, and existing app health. Browser login and future native
iOS auth remain separate acceptance tests. Stop/rollback only the YoLink Compose
project if a release fails; do not restart or prune the shared stack.
