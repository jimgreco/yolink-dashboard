import test from "node:test";
import assert from "node:assert/strict";
import {
  createStore,
  dashboardFromRows,
  decryptCredential,
  encryptCredential,
  encryptionKey,
} from "../lib/store.mjs";

test("store uses the signed-in Google subject for every user query", async () => {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
    connect: async () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [] };
      },
      release() {},
    }),
    end: async () => {},
  };
  const store = await createStore(
    "postgres://unused",
    Buffer.alloc(32, 7).toString("base64"),
    { pool },
  );
  const user = { sub: "google-sub-A", email: "a@example.com" };
  await store.ensureUser(user);
  await store.snapshot(user);
  await store.refreshIfDue(user);
  const identityStatements = queries.filter((item) =>
    item.sql.includes("set_config('app.user_sub'"),
  );
  assert.equal(identityStatements.length, 3);
  for (const item of identityStatements)
    assert.deepEqual(item.params, [user.sub]);
  assert.match(
    queries.find((item) => item.sql.includes("LEFT JOIN dashboard_snapshots"))
      .sql,
    /WHERE c\.owner_sub=\$1/,
  );
  assert.match(
    queries.find((item) => item.sql.includes("last_attempt_at=now()")).sql,
    /WHERE owner_sub=\$1/,
  );
});

test("snapshot exposes no credential fields", () => {
  const dashboard = dashboardFromRows([
    {
      id: "1",
      label: "Manhattan",
      devices: [],
      credential_cipher: "secret",
      fetched_at: null,
    },
  ]);
  assert.equal(dashboard.connectionStatus, "connected");
  assert.equal(JSON.stringify(dashboard).includes("secret"), false);
  assert.throws(() => encryptionKey("too-short"));
});

test("credential encryption is bound to its user and connection", () => {
  const key = encryptionKey(Buffer.alloc(32, 7).toString("base64"));
  const row = {
    id: "connection-a",
    owner_sub: "google-sub-a",
    provider: "personal_uac",
    ...encryptCredential(
      { uaid: "fake-id", secret: "fake-secret" },
      key,
      "google-sub-a",
      "connection-a",
      "personal_uac",
    ),
  };
  assert.deepEqual(decryptCredential(row, key), {
    uaid: "fake-id",
    secret: "fake-secret",
  });
  assert.throws(() => decryptCredential({ ...row, owner_sub: "google-sub-b" }, key));
});
