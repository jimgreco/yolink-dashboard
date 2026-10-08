const TOKEN_URL = "https://api.yosmart.com/open/yolink/token";
const API_URL = "https://api.yosmart.com/open/yolink/v2/api";
const SUCCESS = "000000";
const MIN_GAP_MS = 250;
const MAX_STATES_PER_CYCLE = 90;

// Explicitly read-only. Never accept an API method from an HTTP request or device data.
export const STATE_TYPES = new Set([
  "LeakSensor",
  "DoorSensor",
  "MotionSensor",
  "THSensor",
  "Hub",
  "CellularHub",
  "SpeakerHub",
  "COSmokeSensor",
  "PowerFailureAlarm",
  "WaterDepthSensor",
  "WaterLeakController",
  "WaterMeterController",
  "Outlet",
  "MultiOutlet",
  "Switch",
  "GarageDoor",
  "Lock",
  "LockV2",
  "VibrationSensor",
  "SoilThcSensor",
  "Thermostat",
  "Siren",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const text = (value) => (typeof value === "string" ? value.trim() : "");
const measurement = (value) => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const humidity = (value) => {
  const number = measurement(value);
  return number !== null && number >= 0 && number <= 100 ? number : null;
};
function limits(value, parse = measurement) {
  const min = parse(object(value).min);
  const max = parse(object(value).max);
  return min !== null && max !== null && min <= max ? { min, max } : null;
}

function climateState(state) {
  // THSensor.getState documents mode C. Honor an explicit F response too;
  // missing/unrecognized units stay unknown instead of guessing a conversion.
  const unit = text(state.mode).toUpperCase();
  const alarm = object(state.alarm);
  return {
    temperature: measurement(state.temperature),
    temperatureUnit: ["C", "F"].includes(unit) ? unit : null,
    humidity: humidity(state.humidity),
    temperatureRange: limits(state.tempLimit),
    humidityRange: limits(state.humidityLimit, humidity),
    alarms: ["lowTemp", "highTemp", "lowHumidity", "highHumidity"]
      .filter((key) => alarm[key] === true),
    alarmState: ["normal", "alert"].includes(state.state) ? state.state : null,
  };
}

export function timestamp(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  const ms = Number.isFinite(numeric)
    ? numeric < 1e11
      ? numeric * 1000
      : numeric
    : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

export function normalizeDevice(device, response, previous = null) {
  if (!response && previous)
    return {
      ...previous,
      id: text(device.deviceId),
      name: text(device.name) || previous.name,
      type: text(device.type) || previous.type,
      stateAvailable: false,
    };
  const payload = object(response?.data);
  const state = object(payload.state);
  const type = text(device.type);
  const isLeak = type === "LeakSensor";
  const batteryValue = state.battery ?? payload.battery;
  const battery = Number(batteryValue);
  const batteryBars =
    batteryValue !== undefined &&
    batteryValue !== null &&
    batteryValue !== "" &&
    Number.isInteger(battery) &&
    battery >= 0 &&
    battery <= 4
      ? battery
      : null;
  const online = typeof payload.online === "boolean" ? payload.online : null;
  const stateValue = text(state.state || payload.state);
  const leaking = isLeak && stateValue.toLowerCase() === "alert";
  const lowBattery = (batteryBars !== null && batteryBars <= 1) ||
    (type === "THSensor" && object(state.alarm).lowBattery === true);
  const climate = type === "THSensor" ? climateState(state) : null;
  let reading = "State available";
  if (isLeak)
    reading = leaking
      ? "Water detected"
      : stateValue === "normal"
        ? "Dry"
        : "Leak state unknown";
  else if (climate) {
    const values = [];
    if (climate.temperature !== null)
      values.push(`${climate.temperature}°${climate.temperatureUnit || " (unit unknown)"}`);
    if (climate.humidity !== null) values.push(`${climate.humidity}% humidity`);
    reading = values.join(" · ") || "Readings unavailable";
  }
  else if (stateValue) reading = stateValue.replaceAll("_", " ");
  else if (state.temperature !== undefined) reading = `${state.temperature}°`;
  else if (state.currentTemperature !== undefined)
    reading = `${state.currentTemperature}°`;
  else if (response == null) reading = "State unavailable";

  return {
    id: text(device.deviceId),
    name: text(device.name) || type || "Unnamed device",
    type: type || "Unknown",
    kind: isLeak
      ? "leak"
      : /hub/i.test(type)
        ? "hub"
        : /door|lock|garage/i.test(type)
          ? "entry"
          : /temperature|THSensor|thermostat/i.test(type)
            ? "climate"
            : "device",
    online,
    batteryBars,
    leaking,
    lowBattery,
    reading,
    ...(climate ? { climate } : {}),
    reportAt: timestamp(payload.reportAt) ?? previous?.reportAt ?? null,
    checkedAt: response
      ? new Date().toISOString()
      : (previous?.checkedAt ?? null),
    stateAvailable: Boolean(response),
    stateChangedAt: timestamp(state.stateChangedAt) ?? null,
  };
}

async function jsonRequest(fetcher, url, options) {
  const response = await fetcher(url, {
    ...options,
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`YoLink HTTPS request failed (${response.status})`);
  return response.json();
}

async function accessToken(connection, fetcher) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: connection.uaid,
    client_secret: connection.secret,
  });
  const response = await jsonRequest(fetcher, TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!text(response.access_token))
    throw new Error("YoLink did not return an access token");
  return response.access_token;
}

async function call(fetcher, bearer, method, device) {
  if (
    method !== "Home.getGeneralInfo" &&
    method !== "Home.getDeviceList" &&
    !(
      device &&
      STATE_TYPES.has(device.type) &&
      method === `${device.type}.getState`
    )
  ) {
    throw new Error("Disallowed YoLink method");
  }
  const packet = { method, time: Date.now() };
  if (device) {
    packet.targetDevice = device.deviceId;
    packet.token = device.token;
    packet.params = {};
  }
  const response = await jsonRequest(fetcher, API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(packet),
  });
  if (response.code !== SUCCESS)
    throw new Error(`YoLink ${method} returned a non-success code`);
  return response;
}

export async function discoverHome(connection, fetcher = fetch) {
  const token = await accessToken(connection, fetcher);
  const info = await call(fetcher, token, "Home.getGeneralInfo");
  const homeId = text(info.data?.id);
  if (!homeId) throw new Error("YoLink did not return a Home ID");
  if (connection.expectedHomeId && homeId !== connection.expectedHomeId) {
    // Do not fetch or display another home's device list after a mapping mismatch.
    throw new Error(
      `${connection.name} home ID does not match its configured connection`,
    );
  }
  await sleep(MIN_GAP_MS);
  const listed = await call(fetcher, token, "Home.getDeviceList");
  const rawDevices = Array.isArray(listed.data?.devices)
    ? listed.data.devices
    : [];
  return { homeId, token, rawDevices };
}

export async function inspectPersonalHome(connection, fetcher = fetch) {
  const { homeId, rawDevices } = await discoverHome(connection, fetcher);
  return {
    homeId,
    devices: rawDevices.map(device => ({
      id: text(device.deviceId), name: text(device.name), type: text(device.type),
    })).filter(device => device.id),
  };
}

export async function pollHome(connection, previous = null, fetcher = fetch, { signal = AbortSignal.timeout(120000) } = {}) {
  const transport = fetcher;
  fetcher = (url, options) => {
    signal.throwIfAborted();
    return transport(url, { ...options, signal: AbortSignal.any([signal, options.signal]) });
  };
  signal.throwIfAborted();
  if (!text(connection.expectedHomeId)) throw new Error("A verified Home ID is required");
  const { token, rawDevices } = await discoverHome(connection, fetcher);
  const oldById = new Map((previous?.devices || []).map((d) => [d.id, d]));
  const devices = [];
  let stateCalls = 0;
  for (const raw of rawDevices) {
    signal.throwIfAborted();
    const prior = oldById.get(raw.deviceId);
    if (
      !STATE_TYPES.has(raw.type) ||
      !text(raw.deviceId) ||
      !text(raw.token) ||
      stateCalls >= MAX_STATES_PER_CYCLE
    ) {
      devices.push({
        ...normalizeDevice(raw, null, prior),
        stateAvailable: false,
      });
      continue;
    }
    await sleep(MIN_GAP_MS);
    stateCalls++;
    try {
      const state = await call(fetcher, token, `${raw.type}.getState`, raw);
      devices.push(normalizeDevice(raw, state, prior));
    } catch {
      signal.throwIfAborted();
      devices.push({
        ...normalizeDevice(raw, null, prior),
        stateAvailable: false,
      });
    }
  }
  return {
    id: connection.name.toLowerCase().replaceAll(" ", "-"),
    name: connection.name,
    devices,
    fetchedAt: new Date().toISOString(),
    error: null,
    limited: rawDevices.length > MAX_STATES_PER_CYCLE,
  };
}
