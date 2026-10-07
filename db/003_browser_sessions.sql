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
