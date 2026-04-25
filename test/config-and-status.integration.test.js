const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const test = require("node:test");
const YAML = require("yaml");

const execFileAsync = promisify(execFile);
const cliPath = path.join(__dirname, "..", "dist", "cli.js");
const {
  applyManagedCodexConfig,
  deactivateManagedCodexConfig
} = require("../dist/codex-config.js");

function createIsolatedHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cslot-home-"));
}

function createCliEnv(homeDir) {
  return {
    ...process.env,
    HOME: homeDir
  };
}

async function runCli(homeDir, args) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    env: createCliEnv(homeDir)
  });
}

function withHome(homeDir, fn) {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    return fn();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
      return;
    }

    process.env.HOME = previousHome;
  }
}

function createManagedConfig(port, apiKey) {
  return {
    version: 1,
    server: {
      host: "127.0.0.1",
      port,
      api_key: apiKey,
      body_limit_mb: 512
    },
    upstream: {
      codex_base_url: "https://chatgpt.com/backend-api/codex",
      auth_base_url: "https://auth.openai.com",
      oauth_client_id: "app_EMoamEEZ73f0CkXaXp7hrann"
    },
    accounts: []
  };
}

test("重复接管会稳定重排 cslot 配置，并在 stop 时保留运行期间的其他配置修改", () => {
  const homeDir = createIsolatedHome();
  const codexDir = path.join(homeDir, ".codex");
  const configPath = path.join(codexDir, "config.toml");
  const originalContent = [
    'model_provider = "openai"',
    "",
    "[model_providers.openai]",
    'name = "openai"',
    'base_url = "https://api.openai.com/v1"',
    "",
    "[model_providers.cslot]",
    'name = "legacy-cslot"',
    'base_url = "http://127.0.0.1:3999/v1"',
    'experimental_bearer_token = "legacy-token"',
    "[model_providers.cslot.http_headers]",
    'Authorization = "Bearer legacy-token"',
    "",
    "[model_providers.other]",
    'name = "other"',
    'base_url = "https://example.com/v1"'
  ].join("\n");

  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(configPath, originalContent, "utf8");

  try {
    withHome(homeDir, () => {
      applyManagedCodexConfig(configPath, {
        silent: true,
        config: createManagedConfig(4399, "cslot-first-token")
      });
      applyManagedCodexConfig(configPath, {
        silent: true,
        config: createManagedConfig(4400, "cslot-second-token")
      });

      const nextContent = fs.readFileSync(configPath, "utf8");

      assert.equal((nextContent.match(/model_provider = "cslot"/g) ?? []).length, 1);
      assert.equal((nextContent.match(/\[model_providers\.cslot\]/g) ?? []).length, 1);
      assert.equal((nextContent.match(/\[model_providers\.cslot\.http_headers\]/g) ?? []).length, 1);
      assert.match(nextContent, /base_url = "http:\/\/127\.0\.0\.1:4400\/v1"/);
      assert.match(nextContent, /experimental_bearer_token = "cslot-second-token"/);
      assert.match(nextContent, /Authorization = "Bearer cslot-second-token"/);
      assert.ok(
        nextContent.indexOf("[model_providers.other]") <
          nextContent.indexOf("# >>> cslot provider:cslot >>>")
      );
      assert.ok(nextContent.trimEnd().endsWith("# <<< cslot provider:cslot <<<"));

      fs.writeFileSync(
        configPath,
        nextContent.replace(
          'base_url = "https://example.com/v1"',
          'base_url = "https://changed.example.com/v1"'
        ) + '\n[feature_flags]\nenabled = true\n',
        "utf8"
      );

      deactivateManagedCodexConfig();
    });

    const restoredContent = fs.readFileSync(configPath, "utf8");
    assert.match(restoredContent, /model_provider = "openai"/);
    assert.match(restoredContent, /\[model_providers\.cslot\][\s\S]*legacy-cslot/);
    assert.match(restoredContent, /\[model_providers\.cslot\.http_headers\]\nAuthorization = "Bearer legacy-token"/);
    assert.match(restoredContent, /base_url = "https:\/\/changed\.example\.com\/v1"/);
    assert.match(restoredContent, /\[feature_flags\]\nenabled = true/);
    assert.ok(
      restoredContent.indexOf("[model_providers.cslot]") <
        restoredContent.indexOf("[model_providers.other]")
    );
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("stop 遇到运行期间用户自己写入的 model_provider 与 cslot provider 时不覆盖用户内容", () => {
  const homeDir = createIsolatedHome();
  const codexDir = path.join(homeDir, ".codex");
  const configPath = path.join(codexDir, "config.toml");
  const originalContent = [
    "[model_providers.openai]",
    'name = "openai"',
    'base_url = "https://api.openai.com/v1"'
  ].join("\n");

  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(configPath, originalContent, "utf8");

  try {
    withHome(homeDir, () => {
      applyManagedCodexConfig(configPath, {
        silent: true,
        config: createManagedConfig(4399, "cslot-first-token")
      });

      const managedContent = fs.readFileSync(configPath, "utf8");
      fs.writeFileSync(
        configPath,
        [
          'model_provider = "openai"',
          "",
          managedContent,
          "",
          "[model_providers.cslot]",
          'name = "manual-cslot"',
          'base_url = "https://manual.example.com/v1"',
          'experimental_bearer_token = "manual-token"',
          "[model_providers.cslot.http_headers]",
          'Authorization = "Bearer manual-token"'
        ].join("\n"),
        "utf8"
      );

      deactivateManagedCodexConfig();
    });

    const restoredContent = fs.readFileSync(configPath, "utf8");
    assert.equal((restoredContent.match(/model_provider = "openai"/g) ?? []).length, 1);
    assert.equal((restoredContent.match(/\[model_providers\.cslot\]/g) ?? []).length, 1);
    assert.equal((restoredContent.match(/\[model_providers\.cslot\.http_headers\]/g) ?? []).length, 1);
    assert.match(restoredContent, /manual-cslot/);
    assert.match(restoredContent, /Authorization = "Bearer manual-token"/);
    assert.doesNotMatch(restoredContent, /cslot-first-token/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("status 遇到不可用工作空间时展示账号状态而不是输出控制台错误", async () => {
  const homeDir = createIsolatedHome();
  const cslotDir = path.join(homeDir, ".cslot");
  const brokenWorkspace = path.join(homeDir, "broken-workspace");
  const configPath = path.join(cslotDir, "config.yaml");

  fs.mkdirSync(cslotDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    YAML.stringify({
      version: 1,
      server: {
        host: "127.0.0.1",
        port: 4399,
        api_key: "cslot-test-token",
        body_limit_mb: 512
      },
      upstream: {
        codex_base_url: "https://chatgpt.com/backend-api/codex",
        auth_base_url: "https://auth.openai.com",
        oauth_client_id: "app_EMoamEEZ73f0CkXaXp7hrann"
      },
      accounts: [
        {
          id: "broken",
          name: "broken",
          codex_home: brokenWorkspace,
          enabled: true
        }
      ]
    }),
    "utf8"
  );

  try {
    const { stdout, stderr } = await runCli(homeDir, ["status", "--no-interactive"]);

    assert.equal(stderr.trim(), "");
    assert.match(stdout, /broken/);
    assert.match(stdout, /workspace_invalid/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("调度算法优先消耗快重置的周额度，并在周额度健康时消耗 5 小时余额", () => {
  const homeDir = createIsolatedHome();
  const cslotDir = path.join(homeDir, ".cslot");
  const now = Math.floor(Date.now() / 1000);
  const scenarios = [
    {
      expected: "weekly-reset-soon",
      accounts: [
        {
          id: "five-hour-reset-soon",
          fiveHourUsedPercent: 5,
          fiveHourResetAt: now + 60 * 60,
          weeklyUsedPercent: 10,
          weeklyResetAt: now + 6 * 24 * 60 * 60
        },
        {
          id: "weekly-reset-soon",
          fiveHourUsedPercent: 20,
          fiveHourResetAt: now + 2 * 60 * 60,
          weeklyUsedPercent: 50,
          weeklyResetAt: now + 24 * 60 * 60
        }
      ],
      scheduler_stats: {}
    },
    {
      expected: "healthy-five-hour",
      accounts: [
        {
          id: "low-week-fast-five-hour",
          fiveHourUsedPercent: 10,
          fiveHourResetAt: now + 30 * 60,
          weeklyUsedPercent: 90,
          weeklyResetAt: now + 4 * 24 * 60 * 60
        },
        {
          id: "healthy-five-hour",
          fiveHourUsedPercent: 20,
          fiveHourResetAt: now + 2 * 60 * 60,
          weeklyUsedPercent: 35,
          weeklyResetAt: now + 4 * 24 * 60 * 60
        }
      ],
      scheduler_stats: {}
    },
    {
      expected: "healthy-week",
      accounts: [
        {
          id: "critical-week",
          fiveHourUsedPercent: 20,
          fiveHourResetAt: now + 60 * 60,
          weeklyUsedPercent: 96,
          weeklyResetAt: now + 3 * 24 * 60 * 60
        },
        {
          id: "healthy-week",
          fiveHourUsedPercent: 30,
          fiveHourResetAt: now + 3 * 60 * 60,
          weeklyUsedPercent: 20,
          weeklyResetAt: now + 3 * 24 * 60 * 60
        }
      ],
      scheduler_stats: {}
    },
    {
      expected: "less-used",
      accounts: [
        {
          id: "recent-heavy",
          fiveHourUsedPercent: 30,
          fiveHourResetAt: now + 2 * 60 * 60,
          weeklyUsedPercent: 30,
          weeklyResetAt: now + 3 * 24 * 60 * 60
        },
        {
          id: "less-used",
          fiveHourUsedPercent: 30,
          fiveHourResetAt: now + 2 * 60 * 60,
          weeklyUsedPercent: 30,
          weeklyResetAt: now + 3 * 24 * 60 * 60
        }
      ],
      scheduler_stats: {
        "recent-heavy": {
          success_count: 10,
          last_success_at: new Date().toISOString()
        },
        "less-used": {
          success_count: 0,
          last_success_at: null
        }
      }
    }
  ];

  try {
    for (const scenario of scenarios) {
      const accounts = scenario.accounts.map((account) => {
        const managedHome = path.join(cslotDir, "homes", account.id);
        const managedCodexDir = path.join(managedHome, ".codex");

        fs.mkdirSync(managedCodexDir, { recursive: true });
        fs.writeFileSync(
          path.join(managedCodexDir, "auth.json"),
          JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
              access_token: `${account.id}-access-token`,
              refresh_token: `${account.id}-refresh-token`,
              account_id: `${account.id}-account-id`
            }
          }),
          "utf8"
        );

        return {
          id: account.id,
          name: account.id,
          codex_home: managedHome,
          enabled: true
        };
      });

      fs.mkdirSync(cslotDir, { recursive: true });
      fs.writeFileSync(
        path.join(cslotDir, "config.yaml"),
        YAML.stringify({
          version: 1,
          server: {
            host: "127.0.0.1",
            port: 4399,
            api_key: "cslot-test-token",
            body_limit_mb: 512
          },
          upstream: {
            codex_base_url: "https://chatgpt.com/backend-api/codex",
            auth_base_url: "https://auth.openai.com",
            oauth_client_id: "app_EMoamEEZ73f0CkXaXp7hrann"
          },
          accounts
        }),
        "utf8"
      );
      fs.writeFileSync(
        path.join(cslotDir, "state.json"),
        JSON.stringify(
          {
            account_blocks: {},
            usage_cache: Object.fromEntries(
              scenario.accounts.map((account) => [
                account.id,
                {
                  accountId: account.id,
                  plan: "plus",
                  fiveHourUsedPercent: account.fiveHourUsedPercent,
                  fiveHourResetAt: account.fiveHourResetAt,
                  weeklyUsedPercent: account.weeklyUsedPercent,
                  weeklyResetAt: account.weeklyResetAt,
                  refreshedAt: new Date().toISOString()
                }
              ])
            ),
            usage_refresh_errors: {},
            scheduler_stats: scenario.scheduler_stats,
            managed_codex_auth: null,
            managed_codex_config: null
          },
          null,
          2
        ),
        "utf8"
      );

      withHome(homeDir, () => {
        const { pickBestAccount } = require("../dist/scheduler.js");
        assert.equal(pickBestAccount()?.account.id, scenario.expected);
      });

      fs.rmSync(path.join(cslotDir, "homes"), { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
