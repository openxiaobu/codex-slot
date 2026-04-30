const assert = require("node:assert/strict");
const test = require("node:test");
const {
  renderStatusDetails,
  renderStatusTable
} = require("../dist/status.js");

test("紧凑状态表只展示切换所需核心列，详情区补充 reset 与 email", () => {
  const statuses = [
    {
      id: "z",
      name: "z*",
      email: "bk19981127001@gmail.com",
      enabled: true,
      exists: true,
      plan: "team",
      fiveHourLeftPercent: 100,
      fiveHourResetsAt: 1_763_462_909,
      weeklyLeftPercent: 62,
      weeklyResetsAt: 1_763_500_000,
      isFiveHourLimited: false,
      isWeeklyLimited: false,
      localBlockReason: undefined,
      localBlockUntil: null,
      refreshErrorCode: null,
      refreshErrorMessage: null,
      isAvailable: true,
      sourcePath: "/tmp/z"
    }
  ];

  const compactTable = renderStatusTable(statuses, {
    compact: true,
    selectorColumn: {
      enabledById: { z: true },
      cursorAccountId: "z"
    }
  });
  const details = renderStatusDetails(statuses[0]);
  const narrowTable = renderStatusTable(statuses, {
    compact: true,
    maxWidth: 48,
    selectorColumn: {
      enabledById: { z: true },
      cursorAccountId: "z"
    }
  });
  const narrowDetails = renderStatusDetails(statuses[0], { maxWidth: 48, header: false });

  assert.match(compactTable, /SLOT\s+PLAN\s+5H\s+WEEK\s+STATUS/);
  assert.doesNotMatch(compactTable, /EMAIL/);
  assert.match(compactTable, />\[x\]\s+z\*/);
  assert.match(details, /\[ current \]/);
  assert.match(details, /email\s+bk19981127001@gmail.com/);
  assert.match(details, /5h\s+100%\s+reset=/);
  assert.match(details, /week\s+62%\s+reset=/);
  assert.match(narrowTable, /ID\s+P\s+5H\s+WK\s+ST/);
  assert.doesNotMatch(narrowDetails, /\[ current \]/);
  assert.match(narrowDetails, /slot\s+z\*\s+plan=team/);
  assert.match(narrowDetails, /email\s+bk19981127001@gmail.com/);
  assert.match(narrowDetails, /5h\s+100%\s+reset=/);
  assert.match(narrowDetails, /week\s+62%\s+reset=/);
});

test("紧凑状态表在宽终端展示完整账号名", () => {
  const statuses = [
    {
      id: "long",
      name: "1+001（26.05.30）*",
      email: "bk19981127001+001@gmail.com",
      enabled: true,
      exists: true,
      plan: "plus",
      fiveHourLeftPercent: 90,
      fiveHourResetsAt: 1_763_462_909,
      weeklyLeftPercent: 98,
      weeklyResetsAt: 1_763_500_000,
      isFiveHourLimited: false,
      isWeeklyLimited: false,
      localBlockReason: undefined,
      localBlockUntil: null,
      refreshErrorCode: null,
      refreshErrorMessage: null,
      isAvailable: true,
      sourcePath: "/tmp/long"
    }
  ];

  const compactTable = renderStatusTable(statuses, {
    compact: true,
    maxWidth: 120,
    selectorColumn: {
      enabledById: { long: true },
      cursorAccountId: "long"
    }
  });

  assert.match(compactTable, /1\+001（26\.05\.30）\*/);
  assert.doesNotMatch(compactTable, /1\+001（26\.05\.3…/);
});

test("紧凑状态表在窄终端按显示宽度截断账号名", () => {
  const statuses = [
    {
      id: "long",
      name: "1+001（26.05.30）*",
      email: "bk19981127001+001@gmail.com",
      enabled: true,
      exists: true,
      plan: "plus",
      fiveHourLeftPercent: 90,
      fiveHourResetsAt: 1_763_462_909,
      weeklyLeftPercent: 98,
      weeklyResetsAt: 1_763_500_000,
      isFiveHourLimited: false,
      isWeeklyLimited: false,
      localBlockReason: undefined,
      localBlockUntil: null,
      refreshErrorCode: null,
      refreshErrorMessage: null,
      isAvailable: true,
      sourcePath: "/tmp/long"
    }
  ];

  const narrowTable = renderStatusTable(statuses, {
    compact: true,
    maxWidth: 48,
    selectorColumn: {
      enabledById: { long: true },
      cursorAccountId: "long"
    }
  });

  assert.match(narrowTable, /1\+001.*…/);
  assert.doesNotMatch(narrowTable, /1\+001（26\.05\.30）\*/);
});
