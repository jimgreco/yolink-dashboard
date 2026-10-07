import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('../deploy/apply-browser-sessions.sql', import.meta.url), 'utf8');
test('activation embeds the exact reviewed session migration', async () => {
  const migration = await readFile(new URL('../db/003_browser_sessions.sql', import.meta.url), 'utf8');
  assert.equal(script.split('-- BEGIN exact db/003_browser_sessions.sql (enforced by a local test)\n')[1]
    .split('-- END exact db/003_browser_sessions.sql')[0], migration);
});

const databaseUrl = process.env.HOME_WATCH_ACTIVATION_TEST_DATABASE_URL;
test('guarded activation is atomic, additive, restricted and replay safe in local PostgreSQL', { skip: !databaseUrl }, async () => {
  const parsed = new URL(databaseUrl);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, '/yolink_dashboard');
  assert.equal(parsed.username, 'admin');
  assert.ok(parsed.port && !['5432', '55467'].includes(parsed.port));
  const pg = (await import('pg')).default;
  const admin = new pg.Client({ connectionString: parsed.href });
  await admin.connect();
  let app;
  try {
    // An explicitly marked disposable cluster/database is required before any writes.
    const marker = await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()");
    assert.equal(marker.rows[0].marker, 'ops-activation-synthetic-only');
    for (const file of ['001_initial.sql', '002_personal_houses.sql'])
      await admin.query(await readFile(new URL('../db/' + file, import.meta.url), 'utf8'));
    await admin.query("CREATE ROLE yolink_dashboard_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3");
    await admin.query('GRANT USAGE ON SCHEMA public TO yolink_dashboard_app; GRANT SELECT,INSERT,UPDATE ON dashboard_users,dashboard_snapshots TO yolink_dashboard_app; GRANT SELECT ON yolink_connections TO yolink_dashboard_app; GRANT UPDATE(last_attempt_at) ON yolink_connections TO yolink_dashboard_app');
    await admin.query("INSERT INTO dashboard_users(google_sub,email) VALUES ('synthetic-activation-owner','owner@example.invalid'),('synthetic-activation-other','other@example.invalid')");
    const before = await admin.query('SELECT * FROM dashboard_users ORDER BY google_sub');
    // A bad role contract must stop before CREATE/GRANT and roll back cleanly.
    await admin.query('ALTER ROLE yolink_dashboard_app CONNECTION LIMIT 4');
    await assert.rejects(admin.query(script), /Unexpected existing application role contract/);
    await admin.query('ROLLBACK');
    assert.equal((await admin.query("SELECT to_regclass('public.dashboard_sessions') AS name")).rows[0].name, null);
    await admin.query('ALTER ROLE yolink_dashboard_app CONNECTION LIMIT 3');
    // Even broad default privileges on this new table are narrowed by activation.
    await admin.query('ALTER DEFAULT PRIVILEGES FOR ROLE admin IN SCHEMA public GRANT ALL ON TABLES TO yolink_dashboard_app');
    await admin.query(script);
    assert.deepEqual((await admin.query('SELECT * FROM dashboard_users ORDER BY google_sub')).rows, before.rows);
    const grants = await admin.query("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='dashboard_sessions' AND grantee='yolink_dashboard_app' ORDER BY privilege_type");
    assert.deepEqual(grants.rows.map(r => r.privilege_type), ['DELETE', 'INSERT', 'SELECT']);
    parsed.username = 'yolink_dashboard_app';
    app = new pg.Client({ connectionString: parsed.href });
    await app.connect();
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.user_sub','synthetic-activation-owner',true)");
    const hash = 'a'.repeat(64);
    await app.query("INSERT INTO dashboard_sessions(owner_sub,token_hash,expires_at) VALUES ('synthetic-activation-owner',$1,now()+interval '8 hours')", [hash]);
    assert.equal((await app.query('SELECT * FROM dashboard_sessions')).rowCount, 1);
    await app.query("SELECT set_config('app.user_sub','synthetic-activation-other',true)");
    assert.equal((await app.query('SELECT * FROM dashboard_sessions')).rowCount, 0);
    await app.query('SAVEPOINT reject_cross_owner');
    await assert.rejects(app.query("INSERT INTO dashboard_sessions(owner_sub,token_hash,expires_at) VALUES ('synthetic-activation-owner',$1,now()+interval '8 hours')", ['b'.repeat(64)]), e => e.code === '42501');
    await app.query('ROLLBACK TO SAVEPOINT reject_cross_owner');
    assert.equal((await app.query('DELETE FROM dashboard_sessions')).rowCount, 0);
    await app.query("SELECT set_config('app.user_sub','synthetic-activation-owner',true)");
    await app.query('SAVEPOINT reject_update');
    await assert.rejects(app.query("UPDATE dashboard_sessions SET expires_at=now()"), e => e.code === '42501');
    await app.query('ROLLBACK TO SAVEPOINT reject_update');
    assert.equal((await app.query('DELETE FROM dashboard_sessions')).rowCount, 1);
    await app.query('ROLLBACK');
    assert.equal((await app.query('SELECT * FROM dashboard_sessions')).rowCount, 0);
    // Repeat is refused without silently recreating policy/grants or touching data.
    await assert.rejects(admin.query(script), /already exists/);
    await admin.query('ROLLBACK');
    assert.deepEqual((await admin.query('SELECT * FROM dashboard_users ORDER BY google_sub')).rows, before.rows);
    assert.equal((await admin.query('SELECT count(*) FROM dashboard_sessions')).rows[0].count, '0');
    // A different database fails before any schema access/mutation.
    parsed.username = 'admin'; parsed.pathname = '/postgres';
    const wrong = new pg.Client({ connectionString: parsed.href });
    await wrong.connect();
    try {
      await assert.rejects(wrong.query(script), /dedicated database and admin role/);
      await wrong.query('ROLLBACK');
      assert.equal((await wrong.query("SELECT to_regclass('public.dashboard_sessions') AS name")).rows[0].name, null);
    } finally { await wrong.end(); }
  } finally { if (app) await app.end(); await admin.end(); }
});
