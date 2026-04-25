const assert = require("node:assert/strict");
const test = require("node:test");

const { rankAccountStatuses } = require("../dist/scheduler-strategy.js");

function createStatus(overrides) {
  return {
    id: overrides.id,
    name: overrides.id,
    enabled: true,
    exists: true,
    plan: "plus",
    fiveHourLeftPercent: 70,
    fiveHourResetsAt: overrides.now + 2 * 60 * 60,
    weeklyLeftPercent: 50,
    weeklyResetsAt: overrides.now + 3 * 24 * 60 * 60,
    isFiveHourLimited: false,
    isWeeklyLimited: false,
    isAvailable: true,
    sourcePath: `/tmp/${overrides.id}`,
    ...overrides
  };
}

test("纯调度策略优先避免周窗口额度浪费", () => {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const decisions = rankAccountStatuses(
    [
      createStatus({
        id: "five-hour-soon",
        now,
        fiveHourLeftPercent: 95,
        fiveHourResetsAt: now + 30 * 60,
        weeklyLeftPercent: 90,
        weeklyResetsAt: now + 6 * 24 * 60 * 60
      }),
      createStatus({
        id: "weekly-soon",
        now,
        fiveHourLeftPercent: 60,
        fiveHourResetsAt: now + 2 * 60 * 60,
        weeklyLeftPercent: 50,
        weeklyResetsAt: now + 24 * 60 * 60
      })
    ],
    {},
    nowMs
  );

  assert.equal(decisions[0].status.id, "weekly-soon");
  assert.ok(decisions[0].breakdown.weeklyWaste > decisions[0].breakdown.fiveHourWaste);
});

test("纯调度策略在周额度低时抑制 5 小时快重置账号", () => {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const decisions = rankAccountStatuses(
    [
      createStatus({
        id: "low-week-fast-five-hour",
        now,
        fiveHourLeftPercent: 90,
        fiveHourResetsAt: now + 20 * 60,
        weeklyLeftPercent: 4,
        weeklyResetsAt: now + 4 * 24 * 60 * 60
      }),
      createStatus({
        id: "healthy-week",
        now,
        fiveHourLeftPercent: 70,
        fiveHourResetsAt: now + 2 * 60 * 60,
        weeklyLeftPercent: 40,
        weeklyResetsAt: now + 4 * 24 * 60 * 60
      })
    ],
    {},
    nowMs
  );

  assert.equal(decisions[0].status.id, "healthy-week");
});

test("纯调度策略在额度相近时优先分散到较少使用账号", () => {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const decisions = rankAccountStatuses(
    [
      createStatus({ id: "recent-heavy", now }),
      createStatus({ id: "less-used", now })
    ],
    {
      "recent-heavy": {
        success_count: 10,
        last_success_at: new Date(nowMs).toISOString()
      },
      "less-used": {
        success_count: 0,
        last_success_at: null
      }
    },
    nowMs
  );

  assert.equal(decisions[0].status.id, "less-used");
  assert.ok(decisions[0].breakdown.spread > decisions[1].breakdown.spread);
});
