import test from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { authConfig, verifyGoogleIdToken } from "../lib/auth.mjs";

const config = authConfig({
  PUBLIC_ORIGIN: "https://yolink.jim-greco.com",
  GOOGLE_CLIENT_ID: "web-client",
  GOOGLE_CLIENT_SECRET: "test-only",
  SESSION_SECRET: "a-long-test-only-session-secret-32-bytes",
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
      }),
    /32 bytes/,
  );
});
