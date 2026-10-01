-- Apply only to the dedicated yolink_dashboard database.
-- One YoLink Home may contain devices at both physical houses.
ALTER TABLE yolink_connections
  ADD COLUMN IF NOT EXISTS device_houses jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(device_houses) = 'object');
