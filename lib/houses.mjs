export const HOUSES = ["Manhattan", "East Hampton"];

export function groupHomes(rows) {
  const groups = new Map();
  function group(name, row) {
    if (!groups.has(name)) groups.set(name, { name, devices: [], sources: new Map() });
    const result = groups.get(name);
    result.sources.set(String(row.id), row);
    return result;
  }
  for (const row of rows) {
    if (HOUSES.includes(row.label)) group(row.label, row);
    if (row.label === "Both houses") for (const name of HOUSES) group(name, row);
    for (const device of Array.isArray(row.devices) ? row.devices : []) {
      const assigned = Object.hasOwn(row.device_houses || {}, device.id) ? row.device_houses[device.id] : null;
      const name = HOUSES.includes(assigned) ? assigned : HOUSES.includes(row.label) ? row.label : "Unassigned";
      group(name, row).devices.push(device);
    }
  }
  return [...groups.values()].map(({ name, devices, sources }) => {
    const rows = [...sources.values()];
    const times = rows.map(row => row.fetched_at ? new Date(row.fetched_at).toISOString() : null);
    return {
      id: name.toLowerCase().replaceAll(" ", "-"), name, devices,
      fetchedAt: times.every(Boolean) ? times.sort()[0] : null,
      error: rows.some(row => row.error) ? [...new Set(rows.filter(row => row.error).map(row => row.error))].join("; ") : null,
      limited: rows.some(row => row.limited),
    };
  }).sort((a, b) => [...HOUSES, "Unassigned"].indexOf(a.name) - [...HOUSES, "Unassigned"].indexOf(b.name));
}

export function validateHouseMapping(label, assignments, devices) {
  if (![...HOUSES, "Both houses"].includes(label)) throw new Error("Choose Manhattan, East Hampton, or Both houses");
  if (!assignments || typeof assignments !== "object" || Array.isArray(assignments)) throw new Error("Invalid house assignments");
  const known = new Set(devices.map(device => device.id));
  for (const [id, house] of Object.entries(assignments)) {
    if (!known.has(id) || !HOUSES.includes(house)) throw new Error("Invalid house assignment");
  }
  if (label !== "Both houses" && Object.keys(assignments).length) throw new Error("Per-device assignments require Both houses");
  return { label, deviceHouses: assignments };
}
