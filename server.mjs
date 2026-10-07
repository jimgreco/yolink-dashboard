import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authConfig,
  authenticate,
  beginLogin,
  completeLogin,
} from "./lib/auth.mjs";
import { recordEvent } from "./lib/observability.mjs";
import { sampleDashboard } from "./lib/sample.mjs";
import { createStore } from "./lib/store.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const mode = process.env.YOLINK_MODE || "sample";
if (!["sample", "cloud"].includes(mode))
  throw new Error("YOLINK_MODE must be sample or cloud");
const live = mode === "cloud";
const port = Number(process.env.PORT || 4318);
const host = live ? "0.0.0.0" : "127.0.0.1";
let config = null;
let store = null;
const sample = sampleDashboard();

if (live) {
  config = authConfig(process.env);
  store = await createStore(
    process.env.DATABASE_URL,
    process.env.YOLINK_ENCRYPTION_KEY,
  );
}

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function reply(
  response,
  status,
  body,
  contentType = "text/plain; charset=utf-8",
  extra = {},
) {
  response.writeHead(status, {
    ...headers,
    "content-type": contentType,
    ...extra,
  });
  response.end(body);
}

function staticFile(pathname) {
  const name =
    pathname === "/"
      ? "index.html"
      : pathname === "/app.js"
        ? "app.js"
        : pathname === "/styles.css"
          ? "styles.css"
          : pathname === "/status.js"
            ? "status.js"
          : null;
  if (!name) return null;
  const type = name.endsWith(".html")
    ? "text/html; charset=utf-8"
    : name.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/javascript; charset=utf-8";
  return { data: readFileSync(join(root, "public", name)), type };
}

export function createDashboardServer({ mode = "sample", config = null, store = null, fetcher = fetch, emit = recordEvent } = {}) {
const live = mode === "cloud";
return createServer(async (request, response) => {
  try {
    const url = new URL(
      request.url,
      live ? config.origin : `http://${host}:${port}`,
    );
    if (live && ["/auth/logout", "/auth/logout/all"].includes(url.pathname)) {
      if (request.method !== "POST") return reply(response, 405, "Use the sign-out button");
      if (request.headers.origin !== config.origin ||
          (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin"))
        return reply(response, 403, "Same-origin request required");
      const identity = await authenticate(request, config, fetcher, store);
      if (!identity?.sessionId) return reply(response, 401, "Sign-in required");
      const all = url.pathname === "/auth/logout/all";
      await store.revokeSession(identity, all);
      emit("session_revoked", { reason: all ? "all" : "current" });
      return reply(response, 303, "", "text/plain; charset=utf-8", {
        location: "/signed-out",
        "set-cookie": "yl_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
      });
    }
    if (request.method !== "GET")
      return reply(response, 405, "Method not allowed");
    if (url.pathname === "/api/health") {
      if (live) await store.health();
      return reply(
        response,
        200,
        JSON.stringify({ status: "ok", mode }),
        "application/json; charset=utf-8",
      );
    }

    if (live && url.pathname === "/signed-out") return reply(response, 200,
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Signed out</title><p>You are signed out of Home Watch.</p><a href="/auth/start">Sign in</a></html>',
      "text/html; charset=utf-8");
    if (live && url.pathname === "/auth/start") {
      const login = beginLogin(config);
      return reply(response, 302, "", "text/plain; charset=utf-8", {
        location: login.url,
        "set-cookie": login.cookie,
      });
    }
    if (live && url.pathname === "/auth/callback") {
      try {
        const sessionCookie = await completeLogin(
          url,
          request.headers.cookie,
          config, fetcher, store,
        );
        return reply(response, 302, "", "text/plain; charset=utf-8", {
          location: "/",
          "set-cookie": [
            sessionCookie,
            "yl_flow=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0",
          ],
        });
      } catch {
        emit("login_rejected");
        return reply(
          response,
          403,
          "This private dashboard is available only to its owner. Sign in with the configured Google account at /auth/start.",
        );
      }
    }
    const identity = live ? await authenticate(request, config, fetcher, store) : null;
    if (live && !identity) {
      if (url.pathname.startsWith("/api/"))
        return reply(
          response,
          401,
          JSON.stringify({ error: "Sign-in required" }),
          "application/json; charset=utf-8",
        );
      return reply(response, 302, "", "text/plain; charset=utf-8", {
        location: "/auth/start",
      });
    }
    if (url.pathname === "/api/v1/dashboard") {
      if (!live)
        return reply(
          response,
          200,
          JSON.stringify(sample),
          "application/json; charset=utf-8",
        );
      await store.ensureUser(identity);
      await store.refreshIfDue(identity);
      return reply(
        response,
        200,
        JSON.stringify(await store.snapshot(identity)),
        "application/json; charset=utf-8",
      );
    }
    const asset = staticFile(url.pathname);
    if (asset) return reply(response, 200, asset.data, asset.type,
      // Same-origin forms need a non-opaque Origin. OAuth callback responses
      // retain no-referrer; this page policy never sends a referrer off-origin.
      url.pathname === "/" ? { "referrer-policy": "same-origin" } : {});
    return reply(response, 404, "Not found");
  } catch {
    emit("request_failed");
    if (!response.headersSent) reply(response, 503, "Service unavailable");
  }
});
}
export const server = createDashboardServer({ mode, config, store });

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(port, host, () => {
    console.log(`YoLink dashboard ${mode} listening on http://${host}:${port}`);
  });
}
