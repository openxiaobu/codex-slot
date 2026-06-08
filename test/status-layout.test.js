const assert = require("node:assert/strict");
const test = require("node:test");
const {
  renderRelayStatusDetails,
  renderRelayStatusTable,
  renderStatusDetails,
  renderStatusTable
} = require("../dist/status.js");
const {
  renderInteractiveStatusLayout,
  renderInteractiveHelpLines
} = require("../dist/status-command.js");

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

test("relay 状态表展示启用状态和当前模型出口", () => {
  const slots = [
    {
      id: "third",
      name: "third*",
      base_url: "https://relay.example.com/v1",
      api_key: "relay-secret",
      enabled: true
    }
  ];

  const table = renderRelayStatusTable(slots, {
    compact: true,
    maxWidth: 80,
    selectorColumn: {
      enabledById: { third: true },
      cursorRelayId: "third"
    }
  });
  const details = renderRelayStatusDetails(slots[0], { maxWidth: 80, header: false });

  assert.match(table, /RELAY\s+STATUS\s+BASE_URL/);
  assert.match(table, />\[x\]\s+third\*/);
  assert.match(table, /enabled/);
  assert.match(details, /slot\s+third\*/);
  assert.match(details, /base\s+https:\/\/relay\.example\.com\/v1/);
  assert.doesNotMatch(details, /relay-secret/);
});

test("relay 状态表在超宽终端不撑满左侧面板", () => {
  const slots = [
    {
      id: "third",
      name: "third*",
      base_url: "https://relay.example.com/openai-compatible/very/long/path/that/should/not/stretch/the/whole/status/panel/v1",
      api_key: "relay-secret",
      enabled: true
    }
  ];

  const table = renderRelayStatusTable(slots, {
    compact: true,
    maxWidth: 180,
    selectorColumn: {
      enabledById: { third: true },
      cursorRelayId: "third"
    }
  });

  for (const line of table.split("\n")) {
    assert.ok(line.length <= 112, line);
  }
});

test("交互状态面板 help 在窄侧栏内逐行展示", () => {
  const lines = renderInteractiveHelpLines(33);

  assert.ok(lines.length > 3);
  assert.match(lines.join("\n"), /m\s+model route/);

  for (const line of lines) {
    assert.ok(line.length <= 33, line);
  }
});

test("交互状态面板按终端高度裁剪，避免重绘时滚屏破坏画布", () => {
  const lines = renderInteractiveStatusLayout({
    leftLines: ["accounts", "a1", "a2", "relays", "r1"],
    sideLines: ["current", "summary", "help", "q exit"],
    screenWidth: 80,
    screenHeight: 6,
    styled: false
  });

  assert.equal(lines.length, 5);
  assert.deepEqual(lines, ["accounts", "a1", "a2", "relays", "r1"]);
});

test("交互状态面板宽屏双栏使用稳定左栏宽度", () => {
  const lines = renderInteractiveStatusLayout({
    leftLines: ["acct", "z"],
    sideLines: ["current", "help"],
    screenWidth: 120,
    screenHeight: 20,
    styled: false
  });

  const currentColumn = lines[0].indexOf("current");

  assert.equal(currentColumn, 79);
  assert.equal(lines[1].indexOf("help"), currentColumn);
});
