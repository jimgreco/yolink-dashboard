import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDevice, pollHome } from "../lib/yolink.mjs";
import { climateView } from "../public/climate.js";

const raw = { deviceId: "climate-fixture", name: "Synthetic room", type: "THSensor", token: "private-net-token" };
const now = Date.parse("2026-10-08T12:00:00Z");
const state = {
  state: "normal", mode: "C", temperature: 22.5, humidity: 48.2, battery: "3",
  tempLimit: { min: 5, max: 30 }, humidityLimit: { min: 20, max: 65 },
  alarm: { highHumidity: false, lowTemp: false }, privateField: "do-not-copy",
};
function device(overrides = {}, payload = {}) {
  return normalizeDevice(raw, { data: { online: true, state: { ...state, ...overrides }, reportAt: now, ...payload } });
}
function view(value, overrides = {}) {
  return climateView({ ...value, checkedAt: new Date(now).toISOString(), ...overrides }, now);
}

test("temperature and humidity survive a normal THSensor state and expose only selected fields", () => {
  const normalized = device();
  assert.equal(normalized.reading, "22.5°C · 48.2% humidity");
  assert.deepEqual(normalized.climate, {
    temperature: 22.5, temperatureUnit: "C", humidity: 48.2,
    temperatureRange: { min: 5, max: 30 }, humidityRange: { min: 20, max: 65 },
    alarms: [], alarmState: "normal",
  });
  const result = view(normalized);
  assert.deepEqual(result.temperature, { primary: "72.5°F", secondary: "22.5°C" });
  assert.equal(result.humidity, "48.2%");
  assert.deepEqual(result.details, [
    ["Temperature alert range", "41°F (5°C) – 86°F (30°C)"],
    ["Humidity alert range", "20% – 65%"],
  ]);
  assert.equal(result.alarmStatus, "No sensor alarms reported");
  assert.equal(result.current, true);
  assert.doesNotMatch(JSON.stringify(normalized), /private-net-token|do-not-copy|privateField/);
});

test("zero, negative temperatures, numeric strings and explicit Fahrenheit keep correct units", () => {
  assert.deepEqual(view(device({ temperature: "0", humidity: "0" })).temperature,
    { primary: "32°F", secondary: "0°C" });
  assert.equal(view(device({ humidity: 0 })).humidity, "0%");
  assert.deepEqual(view(device({ temperature: -20 })).temperature,
    { primary: "-4°F", secondary: "-20°C" });
  assert.deepEqual(view(device({ mode: "F", temperature: 68 })).temperature,
    { primary: "68°F", secondary: "20°C" });
  assert.equal(view(device({ mode: "f", temperature: 0 })).temperature.primary, "0°F");
  assert.equal(view(device({ mode: "C", temperature: -0 })).temperature.secondary, "0°C");
});

test("missing, malformed and out-of-range readings remain unknown instead of turning into zero", () => {
  for (const invalid of [null, undefined, "", "  ", true, false, [], {}, "broken", Infinity, NaN]) {
    const result = view(device({ temperature: invalid, humidity: invalid }));
    assert.equal(result.temperature.primary, "—");
    assert.equal(result.humidity, "—");
    assert.equal(result.status, "Readings unavailable");
    assert.equal(result.current, false);
  }
  for (const invalid of [-1, 101]) assert.equal(view(device({ humidity: invalid })).humidity, "—");
  for (const mode of [undefined, "", "unknown"]) {
    assert.deepEqual(view(device({ mode })).temperature, { primary: "22.5°", secondary: "Unit unknown" });
  }
  const invalidRanges = device({ tempLimit: { min: 30, max: 5 }, humidityLimit: { min: -1, max: 101 } });
  assert.deepEqual(view(invalidRanges).details, []);
  assert.equal(view(device({ temperature: 1e308 })).temperature.primary, "—");
});

test("reported sensor alarms and low battery remain visible, including after a failed state check", () => {
  const previous = device({ state: "alert", battery: null, alarm: {
    lowTemp: true, highHumidity: true, lowHumidity: "true", lowBattery: true, privateAlarm: "do-not-copy",
  } });
  assert.equal(previous.lowBattery, true);
  assert.deepEqual(view(previous).alerts, ["Low temperature", "High humidity"]);
  const failed = normalizeDevice(raw, null, previous);
  assert.deepEqual(failed.climate, previous.climate);
  assert.equal(failed.reportAt, previous.reportAt);
  assert.equal(failed.checkedAt, previous.checkedAt);
  assert.equal(failed.lowBattery, true);
  assert.equal(failed.stateAvailable, false);
  const failedView = view(failed);
  assert.deepEqual(failedView.alerts, ["Last reported: low temperature", "Last reported: high humidity"]);
  assert.equal(failedView.temperature.primary, "72.5°F");
  assert.equal(failedView.status, "Last available readings · check failed");
  assert.equal(failedView.current, false);
  assert.equal(failedView.connectivity, "Last known online");
  assert.deepEqual(view(device({ state: "alert", alarm: {} })).alerts, ["Sensor alarm"]);
  assert.doesNotMatch(JSON.stringify(previous), /privateAlarm|do-not-copy/);
});

test("stale, offline, unknown-time and old cached sensor rows do not imply current measurements", () => {
  const normalized = device();
  for (const [overrides, status] of [
    [{ reportAt: new Date(now - 7200000).toISOString() }, "Older device report"],
    [{ reportAt: null }, "Report time unknown"],
    [{ checkedAt: new Date(now - 7200000).toISOString() }, "Check overdue · last available readings"],
    [{ online: false }, "Offline · last available readings"],
  ]) {
    const result = view(normalized, overrides);
    assert.equal(result.current, false);
    assert.equal(result.status, status);
    assert.equal(result.alarmStatus, "No alarms in last report");
  }
  const legacy = { ...normalized }; delete legacy.climate;
  assert.equal(view(legacy).temperature.primary, "—");
  assert.equal(view(legacy).humidity, "—");
  assert.equal(view(legacy).alarmStatus, "Alarm status not reported");
  assert.equal(view(legacy).status, "Readings unavailable");
});

test("poll includes climate fields using the existing read-only request budget and no net tokens", async () => {
  const methods = [];
  const fetcher = async (url, options) => {
    if (url.endsWith("/token")) return { ok: true, json: async () => ({ access_token: "fixture-access" }) };
    const method = JSON.parse(options.body).method; methods.push(method);
    const data = method === "Home.getGeneralInfo" ? { id: "synthetic-home" }
      : method === "Home.getDeviceList" ? { devices: [raw] }
      : { online: true, reportAt: now, state };
    return { ok: true, json: async () => ({ code: "000000", data }) };
  };
  const home = await pollHome({ name: "Synthetic home", expectedHomeId: "synthetic-home", uaid: "synthetic", secret: "synthetic" }, null, fetcher);
  assert.deepEqual(methods, ["Home.getGeneralInfo", "Home.getDeviceList", "THSensor.getState"]);
  assert.equal(home.devices[0].climate.humidity, 48.2);
  assert.equal(home.devices[0].reading, "22.5°C · 48.2% humidity");
  assert.doesNotMatch(JSON.stringify(home), /private-net-token|fixture-access/);
});
