import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDevice, pollHome } from "../lib/yolink.mjs";

test("leak and battery levels are normalized without exposing device net tokens", () => {
  const device = normalizeDevice(
    {
      deviceId: "a",
      name: "Basement",
      type: "LeakSensor",
      token: "do-not-expose",
    },
    {
      data: {
        online: true,
        state: { state: "alert", battery: "1" },
        reportAt: 1734595441905,
      },
    },
  );
  assert.equal(device.leaking, true);
  assert.equal(device.lowBattery, true);
  assert.equal(device.batteryBars, 1);
  assert.equal(device.reading, "Water detected");
  assert.equal(JSON.stringify(device).includes("do-not-expose"), false);
  assert.equal(device.reportAt, "2024-12-19T08:04:01.905Z");
});

test("a failed state check does not silently clear a prior leak alert", () => {
  const raw = {
    deviceId: "a",
    name: "Basement",
    type: "LeakSensor",
    token: "private",
  };
  const previous = normalizeDevice(raw, {
    data: {
      online: true,
      state: { state: "alert", battery: 2 },
      reportAt: Date.now() - 3600000,
    },
  });
  const failed = normalizeDevice(raw, null, previous);
  assert.equal(failed.leaking, true);
  assert.equal(failed.stateAvailable, false);
  assert.equal(failed.reportAt, previous.reportAt);
});

test("home ID mismatch stops before device list or state requests", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, body: options.body?.toString() });
    const payload = url.endsWith("/token")
      ? { access_token: "test-token" }
      : { code: "000000", data: { id: "unexpected-home" } };
    return { ok: true, json: async () => payload };
  };
  await assert.rejects(
    () =>
      pollHome(
        {
          name: "Manhattan",
          expectedHomeId: "expected-home",
          uaid: "id",
          secret: "secret",
        },
        null,
        fetcher,
      ),
    /home ID/,
  );
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].body).method, "Home.getGeneralInfo");
});

test("poll uses only read methods and strips net tokens from normalized output", async () => {
  const methods = [];
  const fetcher = async (url, options) => {
    assert.equal(new URL(url).protocol, "https:");
    assert.equal(options.redirect, "error");
    if (url.endsWith("/token"))
      return { ok: true, json: async () => ({ access_token: "token" }) };
    const method = JSON.parse(options.body).method;
    methods.push(method);
    const data =
      method === "Home.getGeneralInfo"
        ? { id: "home-1" }
        : method === "Home.getDeviceList"
          ? {
              devices: [
                {
                  deviceId: "device-1",
                  token: "net-secret",
                  name: "Kitchen",
                  type: "LeakSensor",
                },
              ],
            }
          : {
              online: true,
              state: { state: "normal", battery: 4 },
              reportAt: Date.now(),
            };
    return { ok: true, json: async () => ({ code: "000000", data }) };
  };
  const home = await pollHome(
    {
      name: "Manhattan",
      expectedHomeId: "home-1",
      uaid: "id",
      secret: "secret",
    },
    null,
    fetcher,
  );
  assert.deepEqual(methods, [
    "Home.getGeneralInfo",
    "Home.getDeviceList",
    "LeakSensor.getState",
  ]);
  assert.equal(home.devices.length, 1);
  assert.equal(home.devices[0].reading, "Dry");
  assert.equal(JSON.stringify(home).includes("net-secret"), false);
});


test("refresh cycle deadline prevents further provider calls", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(pollHome({expectedHomeId:"synthetic"}, null, async()=>{calls++}, {signal:controller.signal}));
  assert.equal(calls,0);
});
