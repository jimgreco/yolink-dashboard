import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { pollHome } from "./yolink.mjs";
import { recordEvent } from "./observability.mjs";
import { groupHomes } from "./houses.mjs";

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
  const homes = groupHomes(rows);
  return {
    mode: "cloud",
    updatedAt: homes.length && homes.every(home => home.fetchedAt) ? homes.map(home => home.fetchedAt).sort()[0] : null,
    homes,
    connectionStatus: rows.length ? "connected" : "personal_setup_required",
  };
}

export async function createStore(databaseUrl, keyValue, options = {}) {
  if (!databaseUrl) throw new Error("Missing DATABASE_URL");
  const key = encryptionKey(keyValue);
  const refreshes = new Map();
  const poll = options.pollHome || pollHome;
  const emit = options.emit || recordEvent;
  const pool =
    options.pool ||
    new (await import("pg")).default.Pool({
      connectionString: databaseUrl,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      query_timeout: 6000,
    });
  await pool.query("SELECT token_hash FROM dashboard_sessions LIMIT 0");

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

  async function createSession(identity, tokenHash, expiresAt) {
    await withUser(identity.sub, async client => {
      await client.query(`INSERT INTO dashboard_users(google_sub,email) VALUES($1,$2)
        ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,last_seen_at=now()`, [identity.sub,identity.email]);
      await client.query('DELETE FROM dashboard_sessions WHERE owner_sub=$1 AND expires_at<=now()', [identity.sub]);
      await client.query('INSERT INTO dashboard_sessions(owner_sub,token_hash,expires_at) VALUES($1,$2,$3)',
        [identity.sub,tokenHash,new Date(expiresAt)]);
    });
  }
  async function isSessionActive(identity, tokenHash) {
    const result = await withUser(identity.sub, client => client.query(
      'SELECT 1 FROM dashboard_sessions WHERE owner_sub=$1 AND token_hash=$2 AND expires_at>now()', [identity.sub,tokenHash]));
    return result.rows.length === 1;
  }
  async function revokeSession(identity, all = false) {
    await withUser(identity.sub, client => client.query(
      all ? 'DELETE FROM dashboard_sessions WHERE owner_sub=$1' :
        'DELETE FROM dashboard_sessions WHERE owner_sub=$1 AND token_hash=$2',
      all ? [identity.sub] : [identity.sub,identity.sessionId]));
  }

  async function snapshot(identity) {
    const { rows } = await withUser(identity.sub, (client) =>
      client.query(
        `SELECT c.id,c.label,c.device_houses,s.fetched_at,s.devices,s.error,s.limited
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
       RETURNING id,owner_sub,provider,label,expected_home_id,credential_cipher,credential_nonce,credential_tag,last_attempt_at::text AS attempt_id`,
        [identity.sub],
      ),
    );
    for (const row of rows) {
      const keyName = `${identity.sub}:${row.id}`;
      if (refreshes.has(keyName)) continue;
      const task = (async () => {
        const started = Date.now();
        emit("refresh_started");
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
          const home = await poll(
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
        const result = await withUser(identity.sub, async client => {
          // Prevent late results overwriting a disabled, replaced or newer connection.
          const current = await client.query(`SELECT id FROM yolink_connections
            WHERE owner_sub=$1 AND id=$2 AND enabled=true
              AND last_attempt_at=$3::timestamptz AND credential_tag=$4
              AND expected_home_id=$5 AND provider='personal_uac' FOR UPDATE`,
            [identity.sub,row.id,row.attempt_id,row.credential_tag,row.expected_home_id]);
          if (!current.rows.length) return false;
          await client.query(
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
          );
          return true;
        });
        emit(!result ? "refresh_discarded" : error ? "refresh_failed" : "refresh_succeeded", {
          reason: error ? (clearSnapshot ? "home_mismatch" : "provider") : undefined,
          durationMs: Date.now()-started, devices: devices.length,
          unavailable: devices.filter(device => device.stateAvailable === false).length,
        });
      })();
      refreshes.set(keyName, task);
      void task.catch(() => emit("refresh_failed", { reason: "database" })).finally(() => refreshes.delete(keyName));
    }
  }

  return {
    ensureUser, createSession, isSessionActive, revokeSession,
    snapshot,
    refreshIfDue,
    health: () => pool.query("SELECT token_hash FROM dashboard_sessions LIMIT 0"),
    waitForRefreshes: () => Promise.allSettled([...refreshes.values()]),
    close: async () => { await Promise.allSettled([...refreshes.values()]); await pool.end(); },
  };
}
