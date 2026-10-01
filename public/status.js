export function deviceFreshness(device, now = Date.now()) {
  const reportAt = Date.parse(device.reportAt);
  const checkedAt = Date.parse(device.checkedAt);
  return {
    reportUnknown: !Number.isFinite(reportAt),
    reportStale: Number.isFinite(reportAt) && now - reportAt > 60 * 60 * 1000,
    checkStale: !Number.isFinite(checkedAt) || now - checkedAt > 10 * 60 * 1000,
  };
}
