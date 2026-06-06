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

function createManagedConfig(port) {
  return {
    version: 1,
    server: {
      host: "127.0.0.1",
      port,
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

test("重复接管会稳定重排 cslot 配置，并在 stop 时仅移除 cslot 接管痕迹", () => {
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
        config: createManagedConfig(4399)
      });
      applyManagedCodexConfig(configPath, {
        silent: true,
        config: createManagedConfig(4400)
      });

      const nextContent = fs.readFileSync(configPath, "utf8");

      assert.equal((nextContent.match(/model_provider = "cslot"/g) ?? []).length, 1);
      assert.equal((nextContent.match(/\[model_providers\.cslot\]/g) ?? []).length, 1);
      assert.match(nextContent, /base_url = "http:\/\/127\.0\.0\.1:4400\/v1"/);
      assert.match(nextContent, /requires_openai_auth = true/);
      assert.doesNotMatch(nextContent, /experimental_bearer_token/);
      assert.doesNotMatch(nextContent, /\[model_providers\.cslot\.http_headers\]/);
      assert.doesNotMatch(nextContent, /Authorization = "Bearer/);
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
    assert.doesNotMatch(restoredContent, /# >>> cslot/);
    assert.doesNotMatch(restoredContent, /model_provider = "cslot"/);
    assert.doesNotMatch(restoredContent, /\[model_providers\.cslot\]/);
    assert.doesNotMatch(restoredContent, /\[model_providers\.cslot\.http_headers\]/);
    assert.match(restoredContent, /base_url = "https:\/\/changed\.example\.com\/v1"/);
    assert.match(restoredContent, /\[feature_flags\]\nenabled = true/);
    assert.ok(
      restoredContent.indexOf("[model_providers.openai]") <
        restoredContent.indexOf("[model_providers.other]")
    );
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("stop 会移除运行期间残留的无标记 cslot 配置块", () => {
  const homeDir = createIsolatedHome();
  const codexDir = path.join(homeDir, ".codex");
  const configPath = path.join(codexDir, "config.toml");
  const originalContent = [
    'model_provider = "openai"',
    "",
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
        config: createManagedConfig(4399)
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
    assert.equal((restoredContent.match(/\[model_providers\.cslot\]/g) ?? []).length, 0);
    assert.equal((restoredContent.match(/\[model_providers\.cslot\.http_headers\]/g) ?? []).length, 0);
    assert.doesNotMatch(restoredContent, /experimental_bearer_token/);
    assert.doesNotMatch(restoredContent, /Authorization = "Bearer/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("快照记录为 cslot 时，stop 仍然只做去 cslot 化而不回填 cslot", () => {
  const homeDir = createIsolatedHome();
  const codexDir = path.join(homeDir, ".codex");
  const configPath = path.join(codexDir, "config.toml");
  const originalContent = [
    'model_provider = "cslot"',
    "",
    "[model_providers.cslot]",
    'name = "cslot"',
    'base_url = "http://127.0.0.1:4399/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "",
    "[model_providers.azure]",
    'name = "Azure"',
    'base_url = "https://example.azure.com/openai"'
  ].join("\n");

  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(configPath, originalContent, "utf8");

  try {
    withHome(homeDir, () => {
      applyManagedCodexConfig(configPath, {
        silent: true,
        config: createManagedConfig(4399)
      });

      deactivateManagedCodexConfig();
    });

    const restoredContent = fs.readFileSync(configPath, "utf8");
    assert.doesNotMatch(restoredContent, /model_provider = "cslot"/);
    assert.doesNotMatch(restoredContent, /\[model_providers\.cslot\]/);
    assert.match(restoredContent, /\[model_providers\.azure\]/);
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

test("usage 兼容别名可用，并在 help 中展示", async () => {
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
    const { stdout: helpStdout } = await runCli(homeDir, ["--help"]);
    assert.match(helpStdout, /usage/);
    assert.match(helpStdout, /cslot relay add third --base-url https:\/\/relay\.example\.com\/v1 --api-key <key>/);
    assert.match(helpStdout, /cslot relay list/);
    assert.match(helpStdout, /cslot use relay third/);
    assert.match(helpStdout, /cslot use auth/);
    assert.match(helpStdout, /cslot current/);
    assert.doesNotMatch(helpStdout, /中转命令 \/ Relay commands:/);
    assert.doesNotMatch(helpStdout, /中文: 新增 OpenAI-compatible 中转槽位。/);
    assert.doesNotMatch(helpStdout, /English: Add an OpenAI-compatible relay slot./);

    const { stdout, stderr } = await runCli(homeDir, ["usage", "--no-interactive"]);

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
