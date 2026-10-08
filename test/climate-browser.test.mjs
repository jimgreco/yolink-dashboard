import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createDashboardServer } from "../server.mjs";
import { normalizeDevice } from "../lib/yolink.mjs";

// Optional local browser validation. Use an existing Playwright installation;
// no dependency download, persistent browser profile or external service needed.
const modulePath = process.env.HOME_WATCH_PLAYWRIGHT_MODULE;
test("climate cards render real labels and fallback states without overflow on phone and desktop", {
  skip: !modulePath, timeout: 60000,
}, async () => {
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const app = createDashboardServer();
  let browser;
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const now = Date.now();
  const sensor = (id, state, reportAt = now) => normalizeDevice(
    { deviceId: id, name: `Synthetic sensor ${id}`, type: "THSensor", token: "private-fixture-token" },
    { data: { online: true, reportAt, state: { mode: "C", state: "normal", battery: 3, ...state } } },
  );
  const current = sensor("current", { temperature: 22.5, humidity: 68.2, state: "alert",
    tempLimit: { min: 5, max: 30 }, humidityLimit: { min: 20, max: 65 }, alarm: { highHumidity: true } });
  const stale = normalizeDevice({ deviceId: "stale", type: "THSensor" }, null,
    sensor("stale", { temperature: -5, humidity: 25, state: "alert", alarm: { lowTemp: true } }, now - 7200000));
  const unknownUnit = sensor("unknown-unit", { temperature: 18, humidity: 0, mode: null }, null);
  const missing = sensor("missing", { temperature: null, humidity: null });
  const legacy = { ...current, id: "legacy", name: "Synthetic old cached sensor" };
  delete legacy.climate;
  const dashboard = { mode: "sample", updatedAt: new Date(now).toISOString(), homes: [{
    id: "manhattan", name: "Manhattan", fetchedAt: new Date(now).toISOString(),
    error: null, limited: false, devices: [current, stale, unknownUnit, missing, legacy],
  }] };
  try {
    browser = await chromium.launch({ headless: true });
    for (const width of [1440, 1024, 820, 768, 640, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 1100 } });
      const failures = [];
      page.on("pageerror", error => failures.push(error.message));
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin !== base) {
          failures.push("Unexpected external request"); await route.abort(); return;
        }
        if (url.pathname === "/api/v1/dashboard") {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dashboard) });
        } else await route.continue();
      });
      await page.goto(base);
      await page.locator(".climate-row").first().waitFor();
      const rows = page.locator(".climate-row");
      assert.equal(await rows.count(), 5);
      assert.match(await rows.nth(0).innerText(), /72\.5°F/);
      assert.match(await rows.nth(0).innerText(), /22\.5°C/);
      assert.match(await rows.nth(0).innerText(), /68\.2%/);
      assert.match(await rows.nth(0).innerText(), /High humidity/);
      assert.match(await rows.nth(0).innerText(), /Temperature alert range: 41°F \(5°C\) – 86°F \(30°C\)/);
      assert.match(await rows.nth(1).innerText(), /Last available readings · check failed/);
      assert.match(await rows.nth(1).innerText(), /Last reported: low temperature/);
      assert.match(await rows.nth(1).innerText(), /Last known online/);
      assert.match(await rows.nth(2).innerText(), /Unit unknown/);
      assert.match(await rows.nth(2).innerText(), /Report time unknown/);
      assert.match(await rows.nth(2).innerText(), /0%/);
      assert.deepEqual(await rows.nth(3).locator(".metric-value").allTextContents(), ["—", "—"]);
      assert.deepEqual(await rows.nth(4).locator(".metric-value").allTextContents(), ["—", "—"]);
      assert.match(await page.locator("#attention-list").innerText(), /High humidity/);
      assert.doesNotMatch(await page.locator("body").innerText(), /private-fixture-token/);
      const overflow = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth > innerWidth,
        cards: [...document.querySelectorAll(".climate-row")].some(node => node.scrollWidth > node.clientWidth),
      }));
      assert.deepEqual(overflow, { document: false, cards: false }, `Overflow at ${width}px`);
      assert.deepEqual(failures, []);
      if (process.env.HOME_WATCH_UI_EVIDENCE_DIR && [1440, 390].includes(width)) {
        await mkdir(process.env.HOME_WATCH_UI_EVIDENCE_DIR, { recursive: true });
        await page.locator(".home-panel").screenshot({ path: join(process.env.HOME_WATCH_UI_EVIDENCE_DIR, `climate-${width}.png`) });
      }
      await page.close();
    }
  } finally {
    await browser?.close();
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
  }
});
