const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const YAML = require("yaml");
const {
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher
} = require("undici");
const {
  mapUsageWindows,
  refreshAccountTokens,
  refreshAccountUsage
} = require("../dist/usage-sync.js");

/**
 * 写入 token 与 usage 刷新测试所需的隔离账号配置。
 *
 * @param homeDir 测试专用 HOME。
 * @returns 受管账号 HOME 路径。
 * @throws 当目录或文件写入失败时抛出文件系统错误。
 */
function prepareUsageFixture(homeDir) {
  const cslotDir = path.join(homeDir, ".cslot");
  const accountHome = path.join(cslotDir, "homes", "slot-a");
  const codexDir = path.join(accountHome, ".codex");

  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "old-access",
        refresh_token: "refresh-token",
        account_id: "account-id"
      }
    }),
    "utf8"
  );
  fs.mkdirSync(cslotDir, { recursive: true });
  fs.writeFileSync(
    path.join(cslotDir, "config.yaml"),
    YAML.stringify({
      version: 1,
      server: {
        host: "127.0.0.1",
        port: 4399,
        body_limit_mb: 512
      },
      upstream: {
        codex_base_url: "https://chatgpt.com/backend-api/codex",
        chatgpt_base_url: "https://chatgpt.com/backend-api",
        auth_base_url: "https://auth.example.test",
        oauth_client_id: "test-client"
      },
      accounts: [
        {
          id: "slot-a",
          name: "slot-a",
          codex_home: accountHome,
          enabled: true
        }
      ],
      relay_slots: []
    }),
    "utf8"
  );

  return accountHome;
}

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

test("同进程并发 token 刷新只调用一次 OAuth 并原子复用结果", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cslot-token-refresh-"));
  const accountHome = prepareUsageFixture(homeDir);
  const previousHome = process.env.HOME;
  const previousDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();

  mockAgent.disableNetConnect();
  mockAgent
    .get("https://auth.example.test")
    .intercept({
      path: "/oauth/token",
      method: "POST"
    })
    .reply(200, {
      access_token: "new-access",
      refresh_token: "new-refresh",
      id_token: "new-id"
    });

  try {
    process.env.HOME = homeDir;
    setGlobalDispatcher(mockAgent);
    const results = await Promise.all([
      refreshAccountTokens("slot-a"),
      refreshAccountTokens("slot-a"),
      refreshAccountTokens("slot-a")
    ]);

    assert.deepEqual(
      results.map((auth) => auth.tokens.access_token),
      ["new-access", "new-access", "new-access"]
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(accountHome, ".codex", "auth.json"), "utf8")).tokens.access_token,
      "new-access"
    );
    if (process.platform !== "win32") {
      assert.equal(
        fs.statSync(path.join(accountHome, ".codex", "auth.json")).mode & 0o777,
        0o600
      );
    }
    mockAgent.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(previousDispatcher);
    await mockAgent.close();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("usage 连续 401 时最多刷新一次 token 后明确失败", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cslot-usage-401-"));
  prepareUsageFixture(homeDir);
  const previousHome = process.env.HOME;
  const previousDispatcher = getGlobalDispatcher();
  const mockAgent = new MockAgent();

  mockAgent.disableNetConnect();
  mockAgent
    .get("https://chatgpt.com")
    .intercept({
      path: "/backend-api/wham/usage",
      method: "GET"
    })
    .reply(401, { error: "expired" })
    .times(2);
  mockAgent
    .get("https://auth.example.test")
    .intercept({
      path: "/oauth/token",
      method: "POST"
    })
    .reply(200, {
      access_token: "new-access",
      refresh_token: "new-refresh"
    });

  try {
    process.env.HOME = homeDir;
    setGlobalDispatcher(mockAgent);

    await assert.rejects(
      refreshAccountUsage("slot-a"),
      /token 刷新后仍返回 HTTP 401|HTTP 401 after token refresh/
    );
    mockAgent.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(previousDispatcher);
    await mockAgent.close();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
