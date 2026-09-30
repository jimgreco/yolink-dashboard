-- Apply to a dedicated yolink_dashboard database with a dedicated application role.
-- Do not run this against another application's database.
CREATE TABLE IF NOT EXISTS dashboard_users (
  google_sub text PRIMARY KEY,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS yolink_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_sub text NOT NULL REFERENCES dashboard_users(google_sub) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('oauth', 'personal_uac')),
  label text NOT NULL,
  expected_home_id text NOT NULL,
  credential_cipher bytea NOT NULL,
  credential_nonce bytea NOT NULL,
  credential_tag bytea NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_sub, provider, expected_home_id)
);
CREATE INDEX IF NOT EXISTS yolink_connections_owner_idx ON yolink_connections(owner_sub);

CREATE TABLE IF NOT EXISTS dashboard_snapshots (
  owner_sub text NOT NULL REFERENCES dashboard_users(google_sub) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES yolink_connections(id) ON DELETE CASCADE,
  fetched_at timestamptz,
  checked_at timestamptz NOT NULL DEFAULT now(),
  devices jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  limited boolean NOT NULL DEFAULT false,
  PRIMARY KEY (owner_sub, connection_id)
);
CREATE INDEX IF NOT EXISTS dashboard_snapshots_owner_idx ON dashboard_snapshots(owner_sub);

-- Defense in depth for a public Google sign-in surface. Every application query
-- must set app.user_sub inside its transaction. No context means no rows.
ALTER TABLE dashboard_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_users FORCE ROW LEVEL SECURITY;
ALTER TABLE yolink_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE yolink_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE dashboard_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dashboard_user_scope ON dashboard_users;
CREATE POLICY dashboard_user_scope ON dashboard_users
  USING (google_sub = current_setting('app.user_sub', true))
  WITH CHECK (google_sub = current_setting('app.user_sub', true));
DROP POLICY IF EXISTS connection_user_scope ON yolink_connections;
CREATE POLICY connection_user_scope ON yolink_connections
  USING (owner_sub = current_setting('app.user_sub', true))
  WITH CHECK (owner_sub = current_setting('app.user_sub', true));
DROP POLICY IF EXISTS snapshot_user_scope ON dashboard_snapshots;
CREATE POLICY snapshot_user_scope ON dashboard_snapshots
  USING (owner_sub = current_setting('app.user_sub', true))
  WITH CHECK (owner_sub = current_setting('app.user_sub', true));
