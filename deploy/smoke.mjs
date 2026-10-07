// Run inside a temporary, unexposed production-image container on EC2.
// No external provider calls. All database fixtures roll back.
import assert from "node:assert/strict";
import { createHmac, randomUUID, randomBytes } from "node:crypto";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  const { rows: [role] } = await client.query("SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user");
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
  const { rows: policies } = await client.query("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname=ANY($1)", [["dashboard_users", "yolink_connections", "dashboard_snapshots", "dashboard_sessions"]]);
  assert.equal(policies.length, 4);
  assert(policies.every(row => row.relrowsecurity && row.relforcerowsecurity));
  const {rows: [grants]} = await client.query("SELECT has_table_privilege(current_user,'public.dashboard_sessions','SELECT') AS read, has_table_privilege(current_user,'public.dashboard_sessions','INSERT') AS insert, has_table_privilege(current_user,'public.dashboard_sessions','DELETE') AS delete, has_table_privilege(current_user,'public.dashboard_sessions','UPDATE') AS update, has_table_privilege(current_user,'public.dashboard_sessions','TRUNCATE') AS truncate");
  assert.deepEqual(grants, {read:true, insert:true, delete:true, update:false, truncate:false});
  await client.query("BEGIN");
  const first = `smoke-${randomUUID()}`;
  const second = `smoke-${randomUUID()}`;
  await client.query("SELECT set_config('app.user_sub',$1,true)", [first]);
  await client.query("INSERT INTO dashboard_users(google_sub,email) VALUES($1,'smoke@example.invalid')", [first]);
  assert.equal((await client.query("SELECT google_sub FROM dashboard_users")).rowCount, 1);
  const sessionHash = randomBytes(32).toString("hex");
  await client.query("INSERT INTO dashboard_sessions(owner_sub,token_hash,expires_at) VALUES($1,$2,now()+interval '8 hours')", [first,sessionHash]);
  assert.equal((await client.query("SELECT token_hash FROM dashboard_sessions")).rowCount, 1);
  await client.query("SELECT set_config('app.user_sub',$1,true)", [second]);
  assert.equal((await client.query("SELECT token_hash FROM dashboard_sessions")).rowCount, 0);
  assert.equal((await client.query("DELETE FROM dashboard_sessions")).rowCount, 0);
  assert.equal((await client.query("SELECT google_sub FROM dashboard_users")).rowCount, 0);
  await client.query("SAVEPOINT reject_cross_user");
  await assert.rejects(client.query("INSERT INTO dashboard_users(google_sub,email) VALUES($1,'smoke@example.invalid')", [first]), error => error.code === "42501");
  await client.query("ROLLBACK TO SAVEPOINT reject_cross_user");
  await client.query("SELECT set_config('app.user_sub',$1,true)", [first]);
  assert.equal((await client.query("DELETE FROM dashboard_sessions WHERE token_hash=$1",[sessionHash])).rowCount, 1);
  await client.query("ROLLBACK");
  assert.equal((await client.query("SELECT google_sub FROM dashboard_users")).rowCount, 0);
  console.log("PASS: dedicated restricted role; enforced RLS; session insert/read/delete grants; own-row visibility; cross-user read/write blocked; no context denied; fixtures rolled back.");
} finally {
  client.release();
  await pool.end();
}

// These placeholders exist only in this temporary test process and never
// become deployment configuration or reach Google's servers.
process.env.GOOGLE_CLIENT_ID ||= "deployment-smoke.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ||= "deployment-smoke-placeholder";
process.env.OWNER_GOOGLE_EMAIL ||= "owner@example.invalid";
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
  const signedRequest = email => {
    const payload = Buffer.from(JSON.stringify({ sub: "temporary-smoke-subject", email, exp: Date.now() + 60000 })).toString("base64url");
    const signature = createHmac("sha256", process.env.SESSION_SECRET).update(payload).digest("base64url");
    return { headers: { cookie: `yl_session=${payload}.${signature}` }, redirect: "manual" };
  };
  const outsider = await fetch(`${origin}/api/v1/dashboard`, signedRequest("outsider@example.invalid"));
  assert.equal(outsider.status, 401);
  // Legacy stateless owner cookies must fail closed; a real browser login is separate acceptance.
  const ownerPage = await fetch(origin, signedRequest(process.env.OWNER_GOOGLE_EMAIL));
  assert.equal(ownerPage.status, 302);
  assert.equal(ownerPage.headers.get("location"), "/auth/start");
  const invalid = await fetch(`${origin}/auth/callback?state=invalid&code=invalid`, { redirect: "manual" });
  assert.equal(invalid.status, 403);
  const methods = await fetch(`${origin}/api/v1/dashboard`, { method: "POST" });
  assert.equal(methods.status, 405);
  const { dashboardFromRows } = await import("./lib/store.mjs");
  const disconnected = dashboardFromRows([]);
  assert.deepEqual(disconnected.homes, []);
  assert.equal(disconnected.connectionStatus, "personal_setup_required");
  console.log("PASS: cloud database health; unauthenticated and signed non-owner API denied; legacy owner cookie rejected; invalid OAuth callback rejected; write HTTP method rejected; disconnected state has no sample homes. No synthetic owner record created.");
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
process.exit(0);
