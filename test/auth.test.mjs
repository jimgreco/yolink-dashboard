import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { authenticate, authConfig, verifyGoogleIdToken } from "../lib/auth.mjs";

const config = authConfig({
  PUBLIC_ORIGIN: "https://yolink.jim-greco.com",
  GOOGLE_CLIENT_ID: "web-client",
  GOOGLE_CLIENT_SECRET: "test-only",
  SESSION_SECRET: "a-long-test-only-session-secret-32-bytes",
  OWNER_GOOGLE_EMAIL: "person@example.com",
});

test("Google tokens need a valid signature, audience, verified email, and nonce", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "test-key",
    kty: "RSA",
  };
  const fetcher = async () => ({
    ok: true,
    json: async () => ({ keys: [jwk] }),
  });
  const signed = (extra = {}) => {
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "test-key" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "https://accounts.google.com",
        aud: "web-client",
        sub: "google-sub",
        email: "person@example.com",
        email_verified: true,
        nonce: "expected",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...extra,
      }),
    ).toString("base64url");
    const verifier = createSign("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    return `${header}.${payload}.${verifier.sign(privateKey).toString("base64url")}`;
  };
  assert.deepEqual(
    await verifyGoogleIdToken(signed(), config, { nonce: "expected", fetcher }),
    { sub: "google-sub", email: "person@example.com" },
  );
  await assert.rejects(
    () =>
      verifyGoogleIdToken(signed({ aud: "other-app" }), config, {
        nonce: "expected",
        fetcher,
      }),
    /authorized/,
  );
  await assert.rejects(() => verifyGoogleIdToken(signed({ email: "outsider@example.com" }), config, { nonce: "expected", fetcher }), /authorized/);
  await assert.rejects(() => verifyGoogleIdToken(signed(), { ...config, ownerSub: "different-subject" }, { nonce: "expected", fetcher }), /authorized/);
  assert.equal(await authenticate({ headers: { authorization: `Bearer ${signed({ aud: "native-client", email: "outsider@example.com" })}` } }, { ...config, nativeAudiences: ["native-client"] }, fetcher), null);
  await assert.rejects(
    () =>
      verifyGoogleIdToken(signed({ email_verified: false }), config, {
        nonce: "expected",
        fetcher,
      }),
    /authorized/,
  );
  await assert.rejects(
    () =>
      verifyGoogleIdToken(signed({ nonce: "wrong" }), config, {
        nonce: "expected",
        fetcher,
      }),
    /authorized/,
  );
});

test("cloud auth refuses a non-HTTPS origin or weak session key", () => {
  assert.throws(
    () =>
      authConfig({
        ...{
          PUBLIC_ORIGIN: "http://example.com",
          GOOGLE_CLIENT_ID: "id",
          GOOGLE_CLIENT_SECRET: "secret",
          SESSION_SECRET: "long-enough-test-secret-that-is-32b",
          OWNER_GOOGLE_EMAIL: "person@example.com",
        },
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      authConfig({
        PUBLIC_ORIGIN: "https://example.com",
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        SESSION_SECRET: "short",
        OWNER_GOOGLE_EMAIL: "person@example.com",
      }),
    /32 bytes/,
  );
});

test("private auth fails closed without one owner and rejects old non-owner sessions", async () => {
  const env = { PUBLIC_ORIGIN: "https://example.com", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "test-only", SESSION_SECRET: "a-test-session-secret-over-32-bytes" };
  assert.throws(() => authConfig(env), /OWNER_GOOGLE_EMAIL/);
  assert.throws(() => authConfig({ ...env, OWNER_GOOGLE_EMAIL: "a@example.com,b@example.com" }), /one Google/);
  function request(email, exp = Date.now() + 60000) {
    const payload = Buffer.from(JSON.stringify({ sub: "google-sub", email, exp })).toString("base64url");
    const signature = createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
    return { headers: { cookie: `yl_session=${payload}.${signature}` } };
  }
  assert.deepEqual(await authenticate(request("person@example.com"), config), { sub: "google-sub", email: "person@example.com" });
  assert.equal(await authenticate(request("outsider@example.com"), config), null);
  assert.equal(await authenticate(request("person@example.com", null), config), null);
  assert.equal(await authenticate(request("person@example.com"), { ...config, ownerEmail: "replacement@example.com" }), null);
});
