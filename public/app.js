import { deviceFreshness } from "/status.js";
const byId = (id) => document.getElementById(id);
const make = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
};
const append = (parent, ...children) => {
  for (const child of children) parent.append(child);
  return parent;
};
const age = (iso) => (iso ? Math.max(0, Date.now() - Date.parse(iso)) : null);
const stale = (device) => deviceFreshness(device).reportStale;
let dashboard = null;
let filter = "all";

function timeAgo(iso) {
  const elapsed = age(iso);
  if (elapsed === null || !Number.isFinite(elapsed)) return "Time unknown";
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function issues(device) {
  const result = [];
  if (device.leaking)
    result.push({
      kind: "alert",
      label: "Leak alert",
      detail: "Water detected",
      symbol: "!",
    });
  if (device.online === false)
    result.push({
      kind: "offline",
      label: "Offline",
      detail: "Device is offline",
      symbol: "×",
    });
  if (device.lowBattery)
    result.push({
      kind: "battery",
      label: "Low battery",
      detail: `${device.batteryBars} of 4 bars`,
      symbol: "▰",
    });
  if (!device.stateAvailable && device.online !== false)
    result.push({
      kind: "unknown",
      label: "State unavailable",
      detail: "Current state could not be checked",
      symbol: "?",
    });
  if (stale(device) && device.online !== false)
    result.push({
      kind: "stale",
      label: "Old report",
      detail: "Latest device report is over an hour old",
      symbol: "◷",
    });
  if (deviceFreshness(device).reportUnknown)
    result.push({ kind: "unknown", label: "Report time unknown", detail: "The device did not provide a report time", symbol: "?" });
  if (deviceFreshness(device).checkStale && device.stateAvailable)
    result.push({ kind: "stale", label: "Check overdue", detail: "No successful state check in the last ten minutes", symbol: "◷" });
  return result;
}

function displayKind(type) {
  return (
    {
      LeakSensor: "Leak sensor",
      DoorSensor: "Door sensor",
      THSensor: "Temperature sensor",
      GarageDoor: "Garage door",
      Hub: "Hub",
      CellularHub: "Cellular hub",
      SpeakerHub: "Speaker hub",
    }[type] || type.replace(/([a-z])([A-Z])/g, "$1 $2")
  );
}

function renderSummary(homes) {
  const devices = homes.flatMap((home) => home.devices || []);
  const attention = devices.filter(
    (device) => issues(device).length > 0,
  ).length;
  byId("attention-count").textContent =
    dashboard.mode === "cloud" && !homes.length ? "—" : attention;
  byId("device-count").textContent = devices.length;
  byId("home-count").textContent = homes.filter(
    (home) => home.id !== "unassigned",
  ).length;
  byId("attention-copy").textContent =
    attention === 1 ? "Device to check" : "Devices to check";
  byId("device-copy").textContent = "Across your homes";
  byId("attention-label").textContent =
    `${attention} ${attention === 1 ? "device" : "devices"}`;
}

function renderAttention(homes) {
  const container = byId("attention-list");
  container.replaceChildren();
  const items = homes.flatMap((home) =>
    (home.devices || []).flatMap((device) =>
      issues(device).map((issue) => ({ home, device, issue })),
    ),
  );
  const order = { alert: 0, offline: 1, battery: 2, unknown: 3, stale: 4 };
  items.sort((a, b) => order[a.issue.kind] - order[b.issue.kind]);
  if (!items.length) {
    append(
      container,
      make(
        "div",
        "no-issues",
        dashboard.mode === "cloud" && !homes.length
          ? "No devices are connected yet, so live status is unavailable."
          : "No device issues in the latest available view.",
      ),
    );
    return;
  }
  for (const { home, device, issue } of items) {
    const row = make("div", "attention-item");
    const icon = make("span", `attention-symbol ${issue.kind}`, issue.symbol);
    icon.setAttribute("aria-hidden", "true");
    const description = make("div", "attention-text");
    append(
      description,
      make("strong", "", device.name),
      make(
        "small",
        "",
        `${home.name} · ${issue.detail}${device.reportAt ? ` · Reported ${timeAgo(device.reportAt)}` : ""}`,
      ),
    );
    append(
      row,
      icon,
      description,
      make("span", `issue-tag ${issue.kind}`, issue.label),
    );
    container.append(row);
  }
}

function matches(device) {
  return (
    filter === "all" ||
    (filter === "attention" && issues(device).length > 0) ||
    (filter === "leak" && device.kind === "leak")
  );
}

function renderDevice(device) {
  const freshness = deviceFreshness(device);
  const current = !freshness.reportStale && !freshness.checkStale && !freshness.reportUnknown;
  const row = make("div", "device-row");
  const identity = make("div", "device-name-wrap");
  const icon = make(
    "span",
    `device-icon ${device.kind}`,
    device.kind === "leak"
      ? "H₂O"
      : device.kind === "hub"
        ? "HUB"
        : device.kind === "entry"
          ? "ENT"
          : "DEV",
  );
  icon.setAttribute("aria-hidden", "true");
  const title = make("div", "");
  append(
    title,
    make("div", "device-name", device.name),
    make("div", "device-type", displayKind(device.type)),
  );
  append(identity, icon, title);
  const statusType = device.leaking
    ? "alert"
    : device.online === false
      ? "offline"
      : !device.stateAvailable || !current
        ? "unknown"
        : "";
  const reading = make("div", `device-reading ${statusType}`);
  const statusText = device.leaking
    ? device.stateAvailable && current
      ? "Water detected"
      : "Last alert: water"
    : device.online === false
      ? "Offline"
      : !device.stateAvailable
        ? "State unknown"
        : !current
          ? `Last report: ${device.reading || "Available"}`
          : device.reading || "Available";
  append(reading, make("span", "status-dot"), make("span", "", statusText));
  const battery = make(
    "div",
    `battery-cell ${device.lowBattery ? "low" : device.batteryBars === null ? "none" : ""}`,
    device.batteryBars === null
      ? "Battery —"
      : `Battery ${device.batteryBars}/4`,
  );
  const reported = make(
    "div",
    `reported-cell ${stale(device) ? "stale" : ""}`,
    device.reportAt
      ? `Reported ${timeAgo(device.reportAt)}`
      : "Report time unknown",
  );
  append(row, identity, reading, battery, reported);
  return row;
}

function renderHomes(homes) {
  const container = byId("homes");
  container.replaceChildren();
  if (!homes.length) {
    append(
      container,
      make(
        "div",
        "empty-home",
        "Your personal YoLink connection is not set up yet. Add it privately from your Mac; no live device data is available.",
      ),
    );
    return;
  }
  for (const home of homes) {
    const devices = (home.devices || []).filter(matches);
    const panel = make("section", "home-panel");
    panel.id = home.id;
    const head = make("div", "home-head");
    const ident = make("div", "home-ident");
    const symbol = make("span", `home-symbol ${home.id}`, "⌂");
    symbol.setAttribute("aria-hidden", "true");
    const title = make("div", "");
    append(
      title,
      make("h3", "", home.name),
      make(
        "p",
        "",
        home.error
          ? "Unable to update this home"
          : home.fetchedAt
            ? `Checked ${timeAgo(home.fetchedAt)}`
            : "Waiting for first check",
      ),
    );
    append(ident, symbol, title);
    append(
      head,
      ident,
      make(
        "span",
        "home-count",
        `${devices.length} ${devices.length === 1 ? "device" : "devices"}`,
      ),
    );
    panel.append(head);
    if (home.error)
      append(
        panel,
        make(
          "div",
          "home-error",
          `${home.error}. Showing the last available state, if any.`,
        ),
      );
    if (home.limited)
      append(
        panel,
        make(
          "div",
          "home-error",
          "Some device states could not be checked within YoLink’s rate limit.",
        ),
      );
    if (!devices.length)
      append(
        panel,
        make(
          "div",
          "empty-home",
          filter === "all"
            ? "No devices listed for this home."
            : "No devices match this filter.",
        ),
      );
    for (const device of devices) panel.append(renderDevice(device));
    container.append(panel);
  }
}

function render() {
  if (!dashboard) return;
  const sample = dashboard.mode === "sample";
  byId("sample-banner").hidden = !sample;
  byId("connection-banner").hidden =
    sample || dashboard.connectionStatus !== "personal_setup_required";
  byId("signout").hidden = sample;
  const homes = dashboard.homes || [];
  byId("freshness-title").textContent = sample
    ? "Sample preview"
    : dashboard.connectionStatus === "personal_setup_required"
      ? "Not connected"
      : dashboard.loading
        ? "Connecting…"
        : dashboard.updatedAt
          ? `Checked ${timeAgo(dashboard.updatedAt)}`
          : "No live check yet";
  byId("freshness-detail").textContent = sample
    ? "Times shown are illustrative"
    : dashboard.connectionStatus === "personal_setup_required"
      ? "No live YoLink data"
      : "Device reports have separate times";
  renderSummary(homes);
  renderAttention(homes);
  renderHomes(homes);
}

async function load() {
  try {
    const response = await fetch("/api/v1/dashboard", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status === 401) {
      location.assign("/auth/start");
      return;
    }
    if (!response.ok) throw new Error("Dashboard unavailable");
    dashboard = await response.json();
    render();
  } catch {
    byId("attention-list").replaceChildren(
      make(
        "div",
        "fatal",
        "The dashboard could not load. Please try again later.",
      ),
    );
    byId("homes").replaceChildren();
    byId("freshness-title").textContent = "Unable to load";
    byId("freshness-detail").textContent = "No current device information";
  }
}

document.querySelectorAll("[data-filter]").forEach((button) =>
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((item) => {
      const selected = item === button;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    render();
  }),
);

await load();
setInterval(load, 60000);
