// Run inside a temporary, unexposed production-image container on EC2.
// No external provider calls. All database fixtures roll back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  const { rows: [role] } = await client.query("SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user");
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
  const { rows: policies } = await client.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname=ANY($1)", [["dashboard_users", "yolink_connections", "dashboard_snapshots"]]);
  assert.equal(policies.length, 3);
  assert(policies.every(row => row.relrowsecurity && row.relforcerowsecurity));
  await client.query("BEGIN");
  const first = `smoke-${randomUUID()}`;
  const second = `smoke-${randomUUID()}`;
  await client.query("SELECT set_config('app.user_sub',$1,true)", [first]);
  await client.query("INSERT INTO dashboard_users(google_sub,email) VALUES($1,'smoke@example.invalid')", [first]);
  assert.equal((await client.query("SELECT google_sub FROM dashboard_users")).rowCount, 1);
  await client.query("SELECT set_config('app.user_sub',$1,true)", [second]);
  assert.equal((await client.query("SELECT google_sub FROM dashboard_users")).rowCount, 0);
  await client.query("SAVEPOINT reject_cross_user");
  await assert.rejects(client.query("INSERT INTO dashboard_users(google_sub,email) VALUES($1,'smoke@example.invalid')", [first]), error => error.code === "42501");
  await client.query("ROLLBACK TO SAVEPOINT reject_cross_user");
  await client.query("ROLLBACK");
  assert.equal((await client.query("SELECT google_sub FROM dashboard_users")).rowCount, 0);
  console.log("PASS: dedicated restricted role; enforced RLS; own-row visibility; cross-user read/write blocked; no context denied; fixtures rolled back.");
} finally {
  client.release();
  await pool.end();
}

// These placeholders exist only in this temporary test process and never
// become deployment configuration or reach Google's servers.
process.env.GOOGLE_CLIENT_ID ||= "deployment-smoke.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "deployment-smoke-placeholder";
const { server } = await import("./server.mjs");
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const health = await fetch(`${origin}/api/health`);
  assert.deepEqual(await health.json(), { status: "ok", mode: "cloud" });
  const api = await fetch(`${origin}/api/v1/dashboard`, { redirect: "manual" });
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { error: "Sign-in required" });
  const page = await fetch(origin, { redirect: "manual" });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/auth/start");
  const invalid = await fetch(`${origin}/auth/callback?state=invalid&code=invalid`, { redirect: "manual" });
  assert.equal(invalid.status, 403);
  const methods = await fetch(`${origin}/api/v1/dashboard`, { method: "POST" });
  assert.equal(methods.status, 405);
  const { dashboardFromRows } = await import("./lib/store.mjs");
  const disconnected = dashboardFromRows([]);
  assert.deepEqual(disconnected.homes, []);
  assert.equal(disconnected.connectionStatus, "pending_vendor_access");
  console.log("PASS: cloud database health; unauthenticated API denied; page requires sign-in; invalid OAuth callback rejected; write HTTP method rejected; disconnected state has no sample homes.");
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
process.exit(0);
