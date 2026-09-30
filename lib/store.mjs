import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { pollHome } from "./yolink.mjs";

const refreshes = new Map();

export function encryptionKey(value) {
  const key = Buffer.from(value || "", "base64");
  if (key.length !== 32)
    throw new Error(
      "YOLINK_ENCRYPTION_KEY must be 32 random bytes encoded as base64",
    );
  return key;
}

export function encryptCredential(value, key, ownerSub, connectionId, provider) {
  const nonce = randomBytes(12);
  const encoder = createCipheriv("aes-256-gcm", key, nonce);
  encoder.setAAD(Buffer.from(`${ownerSub}:${connectionId}:${provider}`));
  const cipher = Buffer.concat([
    encoder.update(JSON.stringify(value), "utf8"),
    encoder.final(),
  ]);
  return {
    credential_cipher: cipher,
    credential_nonce: nonce,
    credential_tag: encoder.getAuthTag(),
  };
}

export function decryptCredential(row, key) {
  const decoder = createDecipheriv("aes-256-gcm", key, row.credential_nonce);
  decoder.setAAD(Buffer.from(`${row.owner_sub}:${row.id}:${row.provider}`));
  decoder.setAuthTag(row.credential_tag);
  return JSON.parse(
    Buffer.concat([
      decoder.update(row.credential_cipher),
      decoder.final(),
    ]).toString("utf8"),
  );
}

export function dashboardFromRows(rows) {
  const homes = rows.map((row) => ({
    id: String(row.id),
    name: row.label,
    devices: Array.isArray(row.devices) ? row.devices : [],
    fetchedAt: row.fetched_at ? new Date(row.fetched_at).toISOString() : null,
    error: row.error || null,
    limited: Boolean(row.limited),
  }));
  return {
    mode: "cloud",
    updatedAt: homes.reduce(
      (latest, home) =>
        !home.fetchedAt
          ? latest
          : !latest || home.fetchedAt > latest
            ? home.fetchedAt
            : latest,
      null,
    ),
    homes,
    connectionStatus: homes.length ? "connected" : "pending_vendor_access",
  };
}

export async function createStore(databaseUrl, keyValue, options = {}) {
  if (!databaseUrl) throw new Error("Missing DATABASE_URL");
  const key = encryptionKey(keyValue);
  const pool =
    options.pool ||
    new (await import("pg")).default.Pool({
      connectionString: databaseUrl,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  await pool.query("SELECT 1");

  async function withUser(sub, action) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_sub',$1,true)", [sub]);
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function ensureUser(identity) {
    await withUser(identity.sub, (client) =>
      client.query(
        `INSERT INTO dashboard_users(google_sub,email) VALUES($1,$2)
       ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,last_seen_at=now()`,
        [identity.sub, identity.email],
      ),
    );
  }

  async function snapshot(identity) {
    const { rows } = await withUser(identity.sub, (client) =>
      client.query(
        `SELECT c.id,c.label,s.fetched_at,s.devices,s.error,s.limited
       FROM yolink_connections c
       LEFT JOIN dashboard_snapshots s ON s.connection_id=c.id AND s.owner_sub=c.owner_sub
       WHERE c.owner_sub=$1 AND c.enabled=true ORDER BY c.created_at`,
        [identity.sub],
      ),
    );
    return dashboardFromRows(rows);
  }

  async function refreshIfDue(identity) {
    const { rows } = await withUser(identity.sub, (client) =>
      client.query(
        `UPDATE yolink_connections SET last_attempt_at=now()
       WHERE owner_sub=$1 AND provider='personal_uac' AND enabled=true
         AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '5 minutes')
       RETURNING id,owner_sub,provider,label,expected_home_id,credential_cipher,credential_nonce,credential_tag`,
        [identity.sub],
      ),
    );
    for (const row of rows) {
      const keyName = `${identity.sub}:${row.id}`;
      if (refreshes.has(keyName)) continue;
      const task = (async () => {
        let devices = [];
        let fetchedAt = null;
        let error = null;
        let limited = false;
        let clearSnapshot = false;
        try {
          const credential = decryptCredential(row, key);
          if (
            typeof credential.uaid !== "string" ||
            typeof credential.secret !== "string"
          ) {
            throw new Error("Invalid stored credential");
          }
          const previous = await withUser(identity.sub, (client) =>
            client.query(
              `SELECT devices FROM dashboard_snapshots WHERE owner_sub=$1 AND connection_id=$2`,
              [identity.sub, row.id],
            ),
          );
          const home = await pollHome(
            {
              name: row.label,
              expectedHomeId: row.expected_home_id,
              uaid: credential.uaid,
              secret: credential.secret,
            },
            { devices: previous.rows[0]?.devices || [] },
          );
          devices = home.devices;
          fetchedAt = home.fetchedAt;
          limited = home.limited;
        } catch (failure) {
          clearSnapshot = failure.message.includes("home ID does not match");
          error = clearSnapshot ? "Home connection mismatch" : "Refresh failed";
        }
        await withUser(identity.sub, (client) =>
          client.query(
            `INSERT INTO dashboard_snapshots(owner_sub,connection_id,fetched_at,devices,error,limited)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(owner_sub,connection_id) DO UPDATE SET
             checked_at=now(),fetched_at=CASE WHEN $7 THEN NULL ELSE coalesce(excluded.fetched_at,dashboard_snapshots.fetched_at) END,
             devices=CASE WHEN $7 THEN '[]'::jsonb WHEN excluded.fetched_at IS NULL THEN dashboard_snapshots.devices ELSE excluded.devices END,
             error=excluded.error,limited=excluded.limited`,
            [
              identity.sub,
              row.id,
              fetchedAt,
              JSON.stringify(devices),
              error,
              limited,
              clearSnapshot,
            ],
          ),
        );
      })();
      refreshes.set(keyName, task);
      void task.catch(() => {}).finally(() => refreshes.delete(keyName));
    }
  }

  return {
    ensureUser,
    snapshot,
    refreshIfDue,
    health: () => pool.query("SELECT 1"),
    close: () => pool.end(),
  };
}
