import { deviceFreshness } from "./status.js";

const number = (value) => Number.isFinite(value) ? value : null;
const rounded = (value) => String(Number(value.toFixed(1)));
const alarmLabels = {
  lowTemp: "Low temperature",
  highTemp: "High temperature",
  lowHumidity: "Low humidity",
  highHumidity: "High humidity",
};

function temperature(value, unit) {
  if (number(value) === null) return { primary: "—", secondary: "Not reported" };
  if (!["C", "F"].includes(unit))
    return { primary: `${rounded(value)}°`, secondary: "Unit unknown" };
  const celsius = unit === "C" ? value : (value - 32) * 5 / 9;
  const fahrenheit = unit === "F" ? value : value * 9 / 5 + 32;
  if (!Number.isFinite(celsius) || !Number.isFinite(fahrenheit))
    return { primary: "—", secondary: "Not reported" };
  return { primary: `${rounded(fahrenheit)}°F`, secondary: `${rounded(celsius)}°C` };
}

function range(value, format) {
  if (!value || number(value.min) === null || number(value.max) === null || value.min > value.max)
    return null;
  return `${format(value.min)} – ${format(value.max)}`;
}

export function climateView(device, now = Date.now()) {
  const climate = device.climate || {};
  const freshness = deviceFreshness(device, now);
  const current = device.stateAvailable === true && device.online !== false &&
    !freshness.reportUnknown && !freshness.reportStale && !freshness.checkStale;
  const active = (Array.isArray(climate.alarms) ? climate.alarms : [])
    .filter(key => Object.hasOwn(alarmLabels, key)).map(key => alarmLabels[key]);
  if (!active.length && climate.alarmState === "alert") active.push("Sensor alarm");
  const alerts = active.map(label => current ? label : `Last reported: ${label.toLowerCase()}`);
  const value = number(climate.humidity);
  const humidity = value !== null && value >= 0 && value <= 100 ? `${rounded(value)}%` : "—";
  let status = "Latest reported readings";
  if (!device.stateAvailable) status = "Last available readings · check failed";
  else if (device.online === false) status = "Offline · last available readings";
  else if (freshness.reportUnknown) status = "Report time unknown";
  else if (freshness.reportStale) status = "Older device report";
  else if (freshness.checkStale) status = "Check overdue · last available readings";
  if (number(climate.temperature) === null && humidity === "—") status = "Readings unavailable";
  const details = [];
  const temperatures = range(climate.temperatureRange, value => {
    const formatted = temperature(value, climate.temperatureUnit);
    return `${formatted.primary} (${formatted.secondary})`;
  });
  const humidities = range(climate.humidityRange, value => `${rounded(value)}%`);
  if (temperatures) details.push(["Temperature alert range", temperatures]);
  if (humidities) details.push(["Humidity alert range", humidities]);
  return {
    temperature: temperature(climate.temperature, climate.temperatureUnit),
    humidity, alerts, details, status,
    current: current && (number(climate.temperature) !== null || humidity !== "—"),
    connectivity: typeof device.online !== "boolean" ? "Connectivity unknown"
      : !device.stateAvailable || freshness.checkStale
        ? device.online ? "Last known online" : "Last known offline"
        : device.online ? "Online" : "Offline",
    alarmStatus: alerts.length ? alerts.join(" · ") : climate.alarmState === "normal"
      ? current ? "No sensor alarms reported" : "No alarms in last report"
      : "Alarm status not reported",
  };
}
