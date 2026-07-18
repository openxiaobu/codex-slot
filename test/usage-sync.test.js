const assert = require("node:assert/strict");
const test = require("node:test");
const { mapUsageWindows } = require("../dist/usage-sync.js");

test("mapUsageWindows recognizes a weekly quota stored in primary_window", () => {
  const result = mapUsageWindows({
    primary_window: {
      used_percent: 42,
      reset_at: 1_800_000_000,
      limit_window_seconds: 7 * 24 * 60 * 60
    }
  });

  assert.deepEqual(result, {
    fiveHourUsedPercent: null,
    fiveHourResetAt: null,
    weeklyUsedPercent: 42,
    weeklyResetAt: 1_800_000_000
  });
});

test("mapUsageWindows treats a single primary window without duration as weekly quota", () => {
  const result = mapUsageWindows({
    primary_window: {
      used_percent: 42,
      reset_at: 1_800_000_000
    }
  });

  assert.deepEqual(result, {
    fiveHourUsedPercent: null,
    fiveHourResetAt: null,
    weeklyUsedPercent: 42,
    weeklyResetAt: 1_800_000_000
  });
});

test("mapUsageWindows keeps the legacy primary and secondary window mapping when duration is absent", () => {
  const result = mapUsageWindows({
    primary_window: {
      used_percent: 15,
      reset_at: 1_800_000_000
    },
    secondary_window: {
      used_percent: 35,
      reset_at: 1_800_100_000
    }
  });

  assert.deepEqual(result, {
    fiveHourUsedPercent: 15,
    fiveHourResetAt: 1_800_000_000,
    weeklyUsedPercent: 35,
    weeklyResetAt: 1_800_100_000
  });
});
