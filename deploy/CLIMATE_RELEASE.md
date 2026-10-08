# Temperature and humidity release — October 8, 2026

Prepared locally for Jim's requested sensor details. The parent must reserve a
new shared-host slot and coordinate this exact scope before any production write.
The earlier proxy window is released. No further owner credential submission or
configuration change is needed for this app update.

## Behavior and validation

The current live revision is `711552bb1b336e6c6d58c7ffb24badefff9f4112`. Its
normalizer reduces all 13 THSensor devices to a generic state and drops their
temperature and humidity. The candidate keeps a selected, validated climate
object from the existing `THSensor.getState` response and renders its readings,
configured alert ranges and reported alarms. Fahrenheit and Celsius are labeled;
missing measurements or unknown units are never guessed. Cached readings and
alarms survive failures with last-known labels. The API allowlist, request budget,
owner restriction, durable sessions and database policy are unchanged.

`npm run check` passes 27 checks with the existing local Playwright module
provided through `HOME_WATCH_PLAYWRIGHT_MODULE`. This includes synthetic browser
coverage at 320, 390, 640, 768, 820, 1024 and 1440 pixels. The two existing
PostgreSQL fixture tests are skipped without their isolated fixture URLs; this
change adds no schema, query or authorization modification. Provider fixtures
verify the same three read methods, units, null/zero/negative values, malformed
fields, alarms, missing report times and failure retention. No real provider
request or device-control call is part of these tests.

## Exact bounded host scope

Use the full candidate source commit, source archive digest and ARM64 image
digest recorded in the task's `release-manifest.json`. The image is built and
smoke-tested locally; transfer only that reviewed artifact by pinned SSH using
`.ssh/ec2-deploy-20261004`. Keep the known-host checks. Do not open private runtime
configuration or inspect browser sessions, access logs or credential values.

Within the parent-assigned slot, acquire the existing shared release locks and
verify the isolated app still uses the expected prior image and is healthy.
Load the candidate image, retain the prior image/release reference, update only
the exact `YOLINK_IMAGE` pin in this app's release reference and recreate only
the `yolink-dashboard` service in the `yolink-dashboard` Compose project. Keep
128 MiB, 0.35 CPU, 64 PIDs, the 16 MiB tmpfs, read-only filesystem, existing
private network, no published host port and the three-connection database pool.
Do not restart the database or proxy, rerun bootstrap, change DNS/firewall/TLS,
apply migrations, alter grants or credentials, delete data, or prune images.

Check the exact running image and container health, public HTTPS health 200,
signed-out API 401, and climate asset presence. After Jim opens the owner
dashboard, let the ordinary five-minute refresh claim run. Verify only aggregate
THSensor climate-field presence and successful snapshots; Jim compares units,
readings and alarms with the phone app. Do not reset the refresh timer or make
extra provider calls to force acceptance. Initial old snapshots may show dashes
until the next refresh.

## Recovery and rollback

Jim completed the post-connection recovery set at
`yolink/activation/20261008T174359Z-f365b368adb1414aa0fe43f98a7f7b2e/` in the
existing protected S3 bucket. All three objects have verified version, checksum
and AES256 metadata; no private object bodies were inspected by the assistant.
No schema or key change requires another sensitive transfer for this release.

If the candidate fails acceptance, restore only the previous durable-session
image pin `711552bb1b336e6c6d58c7ffb24badefff9f4112` and recreate only this app.
That image tolerates the additive JSON snapshot fields. Never roll back to a
pre-session image, restore/delete real data, or remove the retained artifacts.
Current/all-browser logout and real-device acceptance remain separate owner
checks; this update does not claim those unreported checks passed.
