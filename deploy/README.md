# Shared EC2 deployment

User approval on September 30 covers the isolated service/database, HTTPS route,
Google sign-in, and server-only credentials. No paid infrastructure is needed.
Jim chose personal-only access on October 1. Commercial YoLink OAuth/API access
is out of scope. Personal UAC creation/use still requires its explicit approval
and the [private user handoff](PERSONAL_SETUP.md).

The service `yolink-dashboard` runs in the shared `deploy` Compose project
(profile `yolink`, defined in `~/deploy/yolink.compose.yml` on the host and in
`jimgreco/consolidated-deploy`), reachable only as `yolink-dashboard:4318` on the
`deploy_default` network. It has no published host port, a 128 MiB memory limit,
a 0.35 CPU limit, and a read-only container filesystem. The database is
`yolink_dashboard`, owned by the existing database administrator; the app role
has no schema ownership or RLS bypass and is limited to three connections.

The namespace was provisioned once on September 30 (database, role and secrets).
Generated database/session/encryption secrets stay in
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

Releases use the shared [release-tools](https://github.com/jimgreco/release-tools)
flow, like every other app on the host. Pull requests run
`.github/workflows/verify.yml`. A push to `main` runs verify, builds the arm64
image `ghcr.io/jimgreco/yolink-dashboard:<sha>` and releases it with
`.github/release/server.json`: a verified `pg_dump` of `yolink_dashboard`, then
only this service is recreated and must report `build == <sha>` from
`/api/health`, inside the container and at `https://yolink.jim-greco.com/api/health`.
A failed health check rolls back to the previous image.

The release never changes schema. A future migration is still an owner-approved,
additive step applied before the release that needs it (see
[session activation](SESSION_ACTIVATION.md) for the pattern).

To recreate the service by hand, reuse the exact `-f` chain recorded on the
running container (`com.docker.compose.project.config_files`); a bare
`docker-compose up` in `~/deploy` omits the release override.

Secrets stay in `~/yolink-dashboard/private/runtime.env` (0600, in a 0700
directory), which the shared Compose service reads as its `env_file`.

The optional `deploy/smoke.mjs` probe runs an image with its private environment
on `deploy_default` and `node --input-type=module` reading the script on stdin.
It uses actual database permissions, rolls back all synthetic rows, verifies
cloud HTTP gating, and never calls Google or YoLink. This is not a real Google login test.

Nginx Proxy Manager routes `yolink.jim-greco.com` → `http://yolink-dashboard:4318` with a valid
certificate, forced HTTPS, and no caching. Disable access logging for
`/auth/callback` or log `$uri` without query strings so OAuth codes are not logged.
The Cloudflare DNS A record points to the existing server `18.219.163.101`.
TLS must validate between Cloudflare and the origin (Full strict); do not change
the zone's existing TLS mode or use an unrelated hostname's certificate.

Verify public HTTPS, unauthenticated API 401, owner-only Google login, empty disconnected
state, no sample homes, and existing app health. Browser login and future native
iOS auth remain separate acceptance tests. A failed release rolls back only this service; do not restart or prune the shared stack.

