import test from "node:test";
import assert from "node:assert/strict";
import { preparePersonalConnection } from "../lib/personal-setup.mjs";
import { dashboardFromRows, decryptCredential } from "../lib/store.mjs";
import { deviceFreshness } from "../public/status.js";

const key = Buffer.alloc(32, 5);
const credential = { uaid: "fixture-uaid", secret: "fixture-secret", approved: true };
function mockYoLink(homeId = "actual-home") {
  const calls = [];
  return {
    calls,
    fetcher: async (url, options) => {
      assert.equal(new URL(url).protocol, "https:");
      assert.equal(options.redirect, "error");
      if (url.endsWith("/token")) return { ok: true, json: async () => ({ access_token: "fixture-access-token" }) };
      const method = JSON.parse(options.body).method;
      calls.push(method);
      const data = method === "Home.getGeneralInfo" ? { id: homeId } : { devices: [{ deviceId: "a", name: "Kitchen", type: "LeakSensor", token: "fixture-net-token" }, { deviceId: "b", name: "Garage", type: "DoorSensor" }] };
      return { ok: true, json: async () => ({ code: "000000", data }) };
    },
  };
}

test("personal setup requires approval before any network call and strips tokens from discovery", async () => {
  const api = mockYoLink();
  await assert.rejects(preparePersonalConnection({ ...credential, approved: false, action: "inspect" }, key.toString("base64"), api.fetcher), /approval/);
  assert.deepEqual(api.calls, []);
  const inspected = await preparePersonalConnection({ ...credential, action: "inspect" }, key.toString("base64"), api.fetcher);
  assert.equal(inspected.homeId, "actual-home");
  assert.deepEqual(api.calls, ["Home.getGeneralInfo", "Home.getDeviceList"]);
  assert.equal(JSON.stringify(inspected).includes("token"), false);
  assert.equal(JSON.stringify(inspected).includes("secret"), false);
});

test("personal setup re-verifies the confirmed Home and encrypts the credential for its owner", async () => {
  const api = mockYoLink();
  const input = { ...credential, action: "connect", ownerSub: "owner", label: "Both houses", deviceHouses: { a: "Manhattan", b: "East Hampton" }, expectedHomeId: "actual-home" };
  const record = await preparePersonalConnection(input, key.toString("base64"), api.fetcher);
  assert.equal(JSON.stringify(record).includes("fixture-secret"), false);
  assert.deepEqual(decryptCredential({ id: record.id, owner_sub: "owner", provider: "personal_uac", credential_cipher: Buffer.from(record.cipher, "hex"), credential_nonce: Buffer.from(record.nonce, "hex"), credential_tag: Buffer.from(record.tag, "hex") }, key), { uaid: credential.uaid, secret: credential.secret });
  const wrong = mockYoLink("another-home");
  await assert.rejects(preparePersonalConnection(input, key.toString("base64"), wrong.fetcher), /home ID/);
  assert.deepEqual(wrong.calls, ["Home.getGeneralInfo"]);
  await assert.rejects(preparePersonalConnection({ ...input, deviceHouses: { unknown: "Manhattan" } }, key.toString("base64"), api.fetcher), /assignment/);
});

test("one actual YoLink Home can serve both houses without duplicate connections; new devices remain unassigned", () => {
  const dashboard = dashboardFromRows([{ id: "only-connection", label: "Both houses", device_houses: { a: "Manhattan", b: "East Hampton" }, devices: [{ id: "a" }, { id: "b" }, { id: "new" }], fetched_at: "2026-10-01T12:00:00Z" }]);
  assert.deepEqual(dashboard.homes.map(home => [home.name, home.devices.map(device => device.id)]), [["Manhattan", ["a"]], ["East Hampton", ["b"]], ["Unassigned", ["new"]]]);
  assert.equal(dashboard.connectionStatus, "connected");
  assert.equal(dashboardFromRows([]).connectionStatus, "personal_setup_required");
  const separate = dashboardFromRows([{ id: "one", label: "Manhattan", devices: [], fetched_at: "2026-10-01T12:00:00Z" }, { id: "two", label: "East Hampton", devices: [], fetched_at: "2026-10-01T10:00:00Z" }]);
  assert.equal(separate.updatedAt, "2026-10-01T10:00:00.000Z");
});

test("a fresh HTTPS check cannot make an old or missing device report fresh", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  assert.deepEqual(deviceFreshness({ reportAt: "2026-10-01T10:00:00Z", checkedAt: new Date(now).toISOString() }, now), { reportUnknown: false, reportStale: true, checkStale: false });
  assert.deepEqual(deviceFreshness({ reportAt: null, checkedAt: new Date(now).toISOString() }, now), { reportUnknown: true, reportStale: false, checkStale: false });
  assert.equal(deviceFreshness({ reportAt: "2026-10-01T10:00:00Z", checkedAt: "2026-10-01T11:00:00Z" }, now).checkStale, true);
});
