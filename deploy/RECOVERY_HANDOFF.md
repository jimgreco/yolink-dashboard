# Owner-executed YoLink activation handoff

Jim completed this approved procedure before and after connecting both YoLink
Homes on October 8, 2026. The assistant verified metadata for both complete
backup sets: all three objects have AES256 encryption, versions and SHA-256
checksums in the protected existing bucket. The second set was created after
both Home connections were saved. Private object bodies and configuration
values were not inspected by the assistant. This does not establish a full
database restore rehearsal or ongoing scheduled backup coverage.

## Execution boundary

Jim must execute the credential-bearing backup upload himself, even after
approving the plan in chat. The assistant must not invoke `backup-recovery.py`
or its `.command` launcher against production, type its confirmation, capture
its Terminal session, inspect the environment file, or upload that file by
another route. The previous denial of environment inspection remains in force.

Jim likewise creates/selects, enters, and submits his personal YoLink credential
himself using the existing `configure-yolink.command`. Never paste credentials,
configuration, Terminal screenshots, or downloaded secret files into chat.

## Prepared scope

- Source: only the dedicated `yolink_dashboard` custom-format PostgreSQL dump
  and `/home/ec2-user/yolink-dashboard/private/runtime.env` in a one-file archive.
  The configuration contains database/Google credentials, the session secret,
  and the application encryption key. Backing it up is an explicit sensitive
  transfer; its values are never displayed or interpreted by this helper.
- Destination: existing bucket
  `jgreco-db-backups-931115508693-us-east-2`, under a new unique
  `yolink/activation/<UTC timestamp>-<random id>/` prefix for each run.
- Protection: pinned existing SSH identity, verified S3 HTTPS, explicit AES256
  server-side encryption, required versioning and public-access blocking,
  expected AWS account/bucket owner, and create-only object writes. The helper
  does not alter IAM, bucket policies, firewall rules, or backup schedules.
- Boundaries: 4 MiB maximum dump, 64 KiB configuration member, source database
  smaller than 64 MiB; 90-second dump timeout with a two-second lock timeout.
  It obtains existing shared-host release locks for the dump and stops if busy.
  Secret-bearing bytes stay in process memory; no plaintext Mac scratch file
  or downloaded backup is written. Existing and incomplete S3 objects remain.
- Verification: live image is the reviewed `711552b` image; configuration is
  unchanged across the dump; `pg_restore --list` succeeds; uploaded sizes,
  checksums, encryption and versions match; each exact object version is
  downloaded into memory and checked again. This is archive verification,
  **not a database restore rehearsal** or scheduled ongoing backup coverage.

## Approved activation sequence

1. Finish the scoped admin HTTPS and YoLink callback/origin HTTPS settings in
   the coordinated proxy window. Keep port-81 access unchanged. DNS and any
   Nginx credential handoff remain separate from this backup launcher; use the
   [private proxy handoff](PROXY_HANDOFF.md) for those scoped settings.
2. Jim opens `deploy/backup-recovery.command` in Terminal on his Mac, reviews
   its named destination and sensitive contents, and personally types `BACKUP`.
   It uses the Mac's existing AWS login and existing pinned SSH key; no new
   credentials are requested or generated. Stop if the account, permissions,
   live image, resource bounds or private-file metadata do not match. Do not
   work around a denial or widen permissions.
3. Wait for **Verified encrypted recovery backup**. Jim reports only
   **backup done**. If it stops, report its fixed error code only; never print
   SDK errors, archive contents or private configuration. A failed attempt is
   not recovery coverage, even if it left an object in the bucket.
4. Follow [the existing personal setup](PERSONAL_SETUP.md). Jim creates/selects
   the UAC in the YoLink app, opens `deploy/configure-yolink.command`, types
   `CONNECT`, and enters both values in hidden prompts. He reviews the returned
   Home and device names locally, assigns the houses, and personally types
   `SAVE`. One actual YoLink Home needs one credential; use another only for a
   distinct Home. The application enforces read methods; the UAC itself has
   broader provider capabilities. No commercial registration is used.
5. After all Home mappings are saved, Jim repeats the same backup launcher and
   confirmation. This captures the newly encrypted connection records and
   matching private configuration. Each run creates a new versioned prefix.
6. Open the dashboard after its five-minute API buffer. Compare device status
   and report timestamps against the YoLink app, then accept current-session
   and all-session logout. Report success/failure without private device details.

The assistant may verify object metadata and public health after Jim's handoff.
It must not download private recovery object bodies or read credential values.

## Local verification

`python3 -m unittest discover -s test -p 'recovery_handoff_test.py' -v`
uses synthetic credentials, an in-memory fake S3 service, and no SSH or network.
It covers encryption/version/checksum verification, archive member restrictions,
configuration drift, corrupted downloads, missing versions, public-bucket
rejection, size/format limits, interactive cancellation and error redaction.
