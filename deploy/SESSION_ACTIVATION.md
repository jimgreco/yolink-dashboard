# Browser-session activation packet — October 7, 2026

Prepared locally; no production grants, schema changes, credential access,
provider requests or service activation have occurred. This packet requires the
parent's exact release approval and shared-host slot before execution.

## Verified baseline and exact diff

Read-only production catalog inspection found migration 002's `device_houses`
column present, `dashboard_sessions` absent and the app role connection limit 3.
No YoLink container is running. Private `runtime.env` exists with mode 0600;
its configuration values remain unverified. Do not rerun `bootstrap.py`: it has
broader namespace/configuration behavior and reads the private environment.

`apply-browser-sessions.sql` is a standalone transaction that:

1. Requires database `yolink_dashboard`, current user/database owner `admin`,
   the existing restricted `yolink_dashboard_app` role (limit 3, no memberships),
   the three admin-owned forced-RLS baseline tables and migration 002's column.
   It refuses an existing sessions table; replay/drift requires inspection.
2. Applies the exact `db/003_browser_sessions.sql` contents: creates
   `public.dashboard_sessions(owner_sub, token_hash, expires_at, created_at)`,
   with primary key `(owner_sub, token_hash)`, a 64-character lowercase SHA-256
   check and owner foreign key. Both RLS flags are set. The sole policy binds
   reads and writes to transaction-local `app.user_sub`.
3. Revokes any default PUBLIC/app grants on **only the newly created table**,
   then grants the existing app role only `SELECT, INSERT, DELETE`. It checks
   that UPDATE/TRUNCATE/REFERENCES/TRIGGER are unavailable and RLS is forced.
   No role password, role attributes, existing-table grant or user data changes.

Locks time out after 2 seconds; each statement times out after 15 seconds.
Any pre-commit error aborts the transaction. The final result contains only
catalog flags. No row scan, restore, cleanup, key rotation or schema 001/002
reapplication is part of this activation.

## Bounded execution after approval

Use the exact approved full commit/image SHA; retain its source and prior
release references. Transfer only that reviewed release through the established
pinned SSH route and new `ec2-deploy-20261004` identity. From its release directory
on the host, the complete database action is:

```sh
docker exec -i shared_db psql -X -v ON_ERROR_STOP=1 \
  -U admin -d yolink_dashboard < deploy/apply-browser-sessions.sql
```

Do not substitute another database, role or migration. Do not print expanded
Compose configuration or open the private environment. On any failed guard,
stop and return the exact non-sensitive mismatch; do not relax it or run broader
bootstrap. A disconnected/uncertain outcome requires a catalog-only inspection
of table, policy and grants before any retry. The script intentionally refuses
replay; it is not a repair tool.

After commit, run the existing `deploy/smoke.mjs` in the exact image using the
approved runtime environment, private network and resource limits. This step
uses app permissions and transient synthetic rows rolled back in one transaction;
it never calls Google or YoLink. It must be separately included in the approved
host scope. Build/run serially within the assigned slot, using the isolated
`yolink-dashboard` Compose project only. Preserve limits: 128 MiB memory,
0.35 CPU, 64 PIDs, 16 MiB tmpfs and three PostgreSQL connections; no published
host port. Do not restart the shared database/stack or prune images.

Start only after the approved private Google/owner configuration handoff and
verified HTTPS route. Accept `/api/health`, unauthenticated API 401, owner-only
login, fresh sign-in after legacy-cookie rejection, current/all-browser logout
and replay rejection. Local synthetic tests do not establish real Google,
physical-home mapping, provider status freshness or alert delivery acceptance.

## Rollback and retention

- Before database COMMIT: `ON_ERROR_STOP` terminates on failure and the
  uncommitted connection transaction rolls back. No recovery delete is needed.
- After database COMMIT but before start: leave the additive table and restricted
  grants in place and keep YoLink stopped. If application/smoke acceptance fails,
  stop only the newly started isolated project. Preserve evidence and forward
  fix against the durable-session contract. **Do not restore an old stateless
  cookie image**, which would remove revocation enforcement.
- Retain original tables/rows, encrypted connection records, snapshots, private
  runtime configuration, encryption/session keys, release references and images.
  Do not DROP the table, revoke accepted grants, restore/delete real data, rotate
  secrets, prune images or rerun bootstrap as rollback. Any later removal needs
  separate exact owner authorization and verified recovery material.
- Normal application behavior remains: browser sessions expire after eight hours;
  a new owner login prunes that owner's expired session rows, and deliberate
  logout deletes current/all owner session rows. No new scheduled cleanup or
  operational retention deletion is introduced. Other data retention is unchanged.
- Browser logout does not revoke Google grants or YoLink UACs. Personal UAC
  creation, secure entry, use and provider revocation remain separate owner
  actions; never use the rejected commercial registration path. Include the DB
  and private encryption key in approved encrypted recovery storage before
  connecting live providers. No new backup credential is generated here.

## One activation decision

Approve the exact source/image and shared-host slot; the additive transaction
and synthetic rollback smoke; owner-controlled Google/owner configuration and
HTTPS handoff; private recovery storage; and, separately, personal UAC creation,
entry/use and real owner acceptance. Keep credential material outside chat and
logs. No live provider or alert test is included implicitly.
