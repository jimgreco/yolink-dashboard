const events = new Set(['login_rejected', 'request_failed', 'session_revoked',
  'refresh_started', 'refresh_succeeded', 'refresh_failed', 'refresh_discarded']);
const outcomes = new Set(['provider', 'home_mismatch', 'database', 'deadline', 'current', 'all']);
export function recordEvent(event, fields = {}, write = line => console.log(line)) {
  if (!events.has(event)) return;
  const safe = { event, at: new Date().toISOString() };
  if (outcomes.has(fields.reason)) safe.reason = fields.reason;
  for (const key of ['durationMs', 'devices', 'unavailable'])
    if (Number.isFinite(fields[key]) && fields[key] >= 0) safe[key] = Math.floor(fields[key]);
  // Never include names, subjects, cookies, OAuth codes, tokens, URLs or errors.
  write(JSON.stringify(safe));
}
