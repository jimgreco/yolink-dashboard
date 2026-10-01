import { preparePersonalConnection } from "./personal-setup.mjs";
try {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 131072) throw new Error("Setup input too large");
  }
  const result = await preparePersonalConnection(JSON.parse(raw), process.env.YOLINK_ENCRYPTION_KEY);
  process.stdout.write(JSON.stringify(result));
} catch {
  // Never expose provider errors, credentials, input, or stack traces.
  process.stderr.write("Personal setup failed: check approval, credentials, Home ID, and house assignments. No connection was saved.\n");
  process.exitCode = 1;
}
