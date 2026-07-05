const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  computeLeftPercent,
  isUsageWindowLimited,
  reconcileQuotaBlockAfterUsageRefresh,
  resolveEffectiveQuotaStatus
} = require("../dist/quota-status.js");
const { loadState, saveState } = require("../dist/state.js");

const NOW_MS = Date.parse("2026-07-05T08:45:00.000Z");
const RESET_AT = Math.floor(NOW_MS / 1000) + 4 * 60 * 60;

function withIsolatedHome(fn) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cslot-quota-home-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  fs.mkdirSync(path.join(homeDir, ".cslot"), { recursive: true });

  try {
    return fn(homeDir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
}

test("resolveEffectiveQuotaStatus treats local 5h block as zero remaining", () => {
  const status = resolveEffectiveQuotaStatus(
    0,
    RESET_AT,
    39,
    RESET_AT + 1000,
    {
      until: RESET_AT,
      reason: "5h_limited",
      updated_at: "2026-07-05T08:36:20.405Z"
    },
    NOW_MS
  );

  assert.equal(status.fiveHourLeftPercent, 0);
  assert.equal(status.isFiveHourLimited, true);
  assert.equal(status.localBlocked, true);
});

test("resolveEffectiveQuotaStatus clears misleading 100% left when API window is full", () => {
  const status = resolveEffectiveQuotaStatus(100, RESET_AT, 39, RESET_AT + 1000, null, NOW_MS);

  assert.equal(status.fiveHourLeftPercent, 0);
  assert.equal(status.isFiveHourLimited, true);
});

test("reconcileQuotaBlockAfterUsageRefresh clears stale quota block when API reports available", () => {
  withIsolatedHome(() => {
    const accountId = "acct-a";
    saveState({
      state_version: 2,
      account_blocks: {
        [accountId]: {
          until: RESET_AT,
          reason: "5h_limited",
          updated_at: "2026-07-05T08:36:20.405Z"
        }
      },
      usage_cache: {},
      usage_refresh_errors: {},
      scheduler_stats: {}
    });

    reconcileQuotaBlockAfterUsageRefresh(
      accountId,
      {
        accountId,
        plan: "pro",
        fiveHourUsedPercent: 0,
        fiveHourResetAt: RESET_AT,
        weeklyUsedPercent: 39,
        weeklyResetAt: RESET_AT + 1000,
        refreshedAt: new Date(NOW_MS).toISOString()
      },
      NOW_MS
    );

    const state = loadState();
    assert.equal(state.account_blocks[accountId], undefined);
  });
});

test("reconcileQuotaBlockAfterUsageRefresh keeps block aligned with API full window", () => {
  withIsolatedHome(() => {
    const accountId = "acct-b";
    saveState({
      state_version: 2,
      account_blocks: {},
      usage_cache: {},
      usage_refresh_errors: {},
      scheduler_stats: {}
    });

    reconcileQuotaBlockAfterUsageRefresh(
      accountId,
      {
        accountId,
        plan: "pro",
        fiveHourUsedPercent: 100,
        fiveHourResetAt: RESET_AT,
        weeklyUsedPercent: 39,
        weeklyResetAt: RESET_AT + 1000,
        refreshedAt: new Date(NOW_MS).toISOString()
      },
      NOW_MS
    );

    const state = loadState();
    assert.equal(state.account_blocks[accountId].until, RESET_AT);
    assert.equal(state.account_blocks[accountId].reason, "5h_limited");
  });
});

test("isUsageWindowLimited ignores expired reset windows", () => {
  assert.equal(isUsageWindowLimited(100, Math.floor(NOW_MS / 1000) - 10, NOW_MS), false);
  assert.equal(computeLeftPercent(100), 0);
});
