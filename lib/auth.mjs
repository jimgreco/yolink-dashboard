import {
  createHash,
  createHmac,
  createPublicKey,
  createVerify,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const GOOGLE_KEYS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const flows = new Map();
let cachedKeys = null;
let keysUntil = 0;

const base64url = (data) => Buffer.from(data).toString("base64url");
const sha256 = (data) => createHash("sha256").update(data).digest();
const random = () => randomBytes(32).toString("base64url");

export function parseCookies(header = "") {
  return Object.fromEntries(
    (header || "")
      .split(";")
      .map((part) => {
        const i = part.indexOf("=");
        return i < 0 ? [] : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
      })
      .filter((item) => item.length === 2),
  );
}

function safeEqual(a, b) {
  const one = Buffer.from(a || "");
  const two = Buffer.from(b || "");
  return one.length === two.length && timingSafeEqual(one, two);
}

export function authConfig(env) {
  const required = [
    "PUBLIC_ORIGIN",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "SESSION_SECRET",
  ];
  for (const key of required) if (!env[key]) throw new Error(`Missing ${key}`);
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error("PUBLIC_ORIGIN must be an HTTPS origin");
  }
  if (Buffer.byteLength(env.SESSION_SECRET) < 32)
    throw new Error("SESSION_SECRET must be at least 32 bytes");
  return {
    origin: origin.origin,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    sessionSecret: env.SESSION_SECRET,
    nativeAudiences: (env.GOOGLE_NATIVE_CLIENT_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

async function googleKeys(fetcher, force = false) {
  if (!force && cachedKeys && Date.now() < keysUntil) return cachedKeys;
  const response = await fetcher(GOOGLE_KEYS, {
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Google signing keys unavailable");
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error("Invalid Google signing keys");
  cachedKeys = body.keys;
  keysUntil = Date.now() + 60 * 60 * 1000;
  return cachedKeys;
}

export async function verifyGoogleIdToken(
  token,
  config,
  { nonce, audiences, fetcher = fetch } = {},
) {
  const parts = token?.split(".");
  if (parts?.length !== 3) throw new Error("Invalid identity token");
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url"));
  } catch {
    throw new Error("Invalid identity token");
  }
  if (header.alg !== "RS256" || !header.kid)
    throw new Error("Unsupported identity signature");
  let key = (await googleKeys(fetcher)).find(
    (item) => item.kid === header.kid && item.kty === "RSA",
  );
  if (!key)
    key = (await googleKeys(fetcher, true)).find(
      (item) => item.kid === header.kid && item.kty === "RSA",
    );
  if (!key) throw new Error("Unknown Google signing key");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  if (
    !verifier.verify(
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(parts[2], "base64url"),
    )
  ) {
    throw new Error("Invalid identity signature");
  }
  const expected = audiences || [config.clientId];
  if (
    !["accounts.google.com", "https://accounts.google.com"].includes(
      claims.iss,
    ) ||
    !expected.includes(claims.aud) ||
    typeof claims.exp !== "number" ||
    claims.exp <= Date.now() / 1000 ||
    typeof claims.iat !== "number" ||
    claims.iat > Date.now() / 1000 + 60 ||
    !claims.sub ||
    claims.email_verified !== true ||
    !claims.email ||
    (nonce && claims.nonce !== nonce)
  ) {
    throw new Error("Identity not authorized");
  }
  return { sub: claims.sub, email: claims.email };
}

export function beginLogin(config) {
  for (const [key, value] of flows)
    if (value.expires < Date.now()) flows.delete(key);
  if (flows.size >= 512) flows.delete(flows.keys().next().value);
  const state = random();
  const nonce = random();
  const verifier = random();
  const browser = random();
  flows.set(state, {
    nonce,
    verifier,
    browserHash: base64url(sha256(browser)),
    expires: Date.now() + 10 * 60 * 1000,
  });
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${config.origin}/auth/callback`,
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
    code_challenge: base64url(sha256(verifier)),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return {
    url: `${GOOGLE_AUTH}?${params}`,
    cookie: `yl_flow=${browser}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600`,
  };
}

function signSession(identity, config) {
  const payload = base64url(
    JSON.stringify({
      sub: identity.sub,
      email: identity.email,
      exp: Date.now() + 8 * 60 * 60 * 1000,
    }),
  );
  const signature = createHmac("sha256", config.sessionSecret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export async function completeLogin(
  url,
  cookieHeader,
  config,
  fetcher = fetch,
) {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const flow = flows.get(state);
  if (state) flows.delete(state);
  const browser = parseCookies(cookieHeader).yl_flow;
  if (
    !state ||
    !code ||
    !flow ||
    flow.expires < Date.now() ||
    !safeEqual(base64url(sha256(browser || "")), flow.browserHash)
  ) {
    throw new Error("Sign-in expired or invalid");
  }
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: `${config.origin}/auth/callback`,
    code_verifier: flow.verifier,
    grant_type: "authorization_code",
  });
  const response = await fetcher(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Google sign-in failed");
  const tokenSet = await response.json();
  const identity = await verifyGoogleIdToken(tokenSet.id_token, config, {
    nonce: flow.nonce,
    fetcher,
  });
  return `yl_session=${signSession(identity, config)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`;
}

export async function authenticate(request, config, fetcher = fetch) {
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ") && config.nativeAudiences.length) {
    try {
      return await verifyGoogleIdToken(auth.slice(7), config, {
        audiences: config.nativeAudiences,
        fetcher,
      });
    } catch {
      return null;
    }
  }
  const session = parseCookies(request.headers.cookie).yl_session;
  const parts = session?.split(".");
  if (parts?.length !== 2) return null;
  const signature = createHmac("sha256", config.sessionSecret)
    .update(parts[0])
    .digest("base64url");
  if (!safeEqual(signature, parts[1])) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url"));
    if (payload.exp <= Date.now() || !payload.sub || !payload.email)
      return null;
    return { sub: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}
