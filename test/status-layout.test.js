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
  const narrowDetails = renderStatusDetails(statuses[0], { maxWidth: 48 });

  assert.match(compactTable, /SLOT\s+PLAN\s+5H\s+WEEK\s+STATUS/);
  assert.doesNotMatch(compactTable, /EMAIL/);
  assert.match(compactTable, />\[x\]\s+z\*/);
  assert.match(details, /\[ current \]/);
  assert.match(details, /email\s+bk19981127001@gmail.com/);
  assert.match(details, /5h\s+100%\s+reset=/);
  assert.match(details, /week\s+62%\s+reset=/);
  assert.match(narrowTable, /ID\s+P\s+5H\s+WK\s+ST/);
  assert.match(narrowDetails, /\[ current \]/);
  assert.match(narrowDetails, /email\s+bk19981127001@gmail.com/);
  assert.match(narrowDetails, /5h\s+100%\s+reset=/);
  assert.match(narrowDetails, /week\s+62%\s+reset=/);
});
