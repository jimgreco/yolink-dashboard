-- Run only in the approved shared-host slot, as admin against yolink_dashboard.
-- No credentials, existing application rows, role attributes or other databases change.
-- ON_ERROR_STOP is required in the psql invocation; BEGIN makes errors atomic.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path = public, pg_catalog;
DO $guard$
BEGIN
  IF current_database() <> 'yolink_dashboard' OR current_user <> 'admin' THEN
    RAISE EXCEPTION 'Session activation requires the dedicated database and admin role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba
                 WHERE d.datname=current_database() AND r.rolname='admin') THEN
    RAISE EXCEPTION 'Unexpected database owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='yolink_dashboard_app'
                 AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
                 AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls
                 AND rolconnlimit=3)
     OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
                WHERE r.rolname='yolink_dashboard_app') THEN
    RAISE EXCEPTION 'Unexpected existing application role contract';
  END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_roles r ON r.oid=c.relowner
      WHERE n.nspname='public' AND c.relname IN
        ('dashboard_users','yolink_connections','dashboard_snapshots')
      AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity
      AND r.rolname='admin') <> 3
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='yolink_connections'
                    AND column_name='device_houses' AND data_type='jsonb'
                    AND is_nullable='NO') THEN
    RAISE EXCEPTION 'Expected dedicated schema through migration 002';
  END IF;
  IF to_regclass('public.dashboard_sessions') IS NOT NULL THEN
    RAISE EXCEPTION 'Session table already exists; inspect metadata instead of replaying activation';
  END IF;
END
$guard$;

-- BEGIN exact db/003_browser_sessions.sql (enforced by a local test)
-- Dedicated yolink_dashboard only. Additive; legacy stateless cookies fail closed.
CREATE TABLE IF NOT EXISTS dashboard_sessions (
  owner_sub text NOT NULL REFERENCES dashboard_users(google_sub) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_sub, token_hash)
);
ALTER TABLE dashboard_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_user_scope ON dashboard_sessions;
CREATE POLICY session_user_scope ON dashboard_sessions
  USING (owner_sub = current_setting('app.user_sub', true))
  WITH CHECK (owner_sub = current_setting('app.user_sub', true));
-- END exact db/003_browser_sessions.sql

-- Restrict only this new table, including any administrator default privileges.
REVOKE ALL ON TABLE public.dashboard_sessions FROM PUBLIC;
REVOKE ALL ON TABLE public.dashboard_sessions FROM yolink_dashboard_app;
GRANT SELECT, INSERT, DELETE ON TABLE public.dashboard_sessions TO yolink_dashboard_app;

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.dashboard_sessions'::regclass
                 AND relrowsecurity AND relforcerowsecurity)
     OR (SELECT count(*) FROM pg_policy WHERE polrelid='public.dashboard_sessions'::regclass) <> 1
     OR NOT has_table_privilege('yolink_dashboard_app','public.dashboard_sessions','SELECT')
     OR NOT has_table_privilege('yolink_dashboard_app','public.dashboard_sessions','INSERT')
     OR NOT has_table_privilege('yolink_dashboard_app','public.dashboard_sessions','DELETE')
     OR has_table_privilege('yolink_dashboard_app','public.dashboard_sessions','UPDATE')
     OR has_table_privilege('yolink_dashboard_app','public.dashboard_sessions','TRUNCATE')
     OR has_table_privilege('yolink_dashboard_app','public.dashboard_sessions','REFERENCES')
     OR has_table_privilege('yolink_dashboard_app','public.dashboard_sessions','TRIGGER') THEN
    RAISE EXCEPTION 'Session isolation/grant verification failed';
  END IF;
END
$verify$;
COMMIT;
-- Catalog-only acceptance. No user/session/credential rows are returned.
SELECT 'browser_sessions_ready' AS result,
       relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
FROM pg_class WHERE oid='public.dashboard_sessions'::regclass;
