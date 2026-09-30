import test from "node:test";
import assert from "node:assert/strict";
import { server } from "../server.mjs";

test("sample server is loopback-ready and labels all dashboard data as sample", async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /SAMPLE MODE/);
    const response = await fetch(`${base}/api/v1/dashboard`);
    const data = await response.json();
    assert.equal(data.mode, "sample");
    assert.deepEqual(
      data.homes.map((home) => home.name),
      ["Manhattan", "East Hampton"],
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
