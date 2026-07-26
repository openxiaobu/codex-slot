const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const YAML = require("yaml");

const {
  removeAccount,
  renameAccount
} = require("../dist/app/account-service.js");
const { loadConfig } = require("../dist/config.js");
const { loadState } = require("../dist/state.js");

test("账号 rename 与 delete 会同步全部账号 id 状态引用", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cslot-account-state-"));
  const cslotDir = path.join(homeDir, ".cslot");
  const accountHome = path.join(homeDir, "custom-account-home");
  const previousHome = process.env.HOME;

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
        auth_base_url: "https://auth.openai.com",
        oauth_client_id: "test-client"
      },
      accounts: [
        {
          id: "old",
          name: "old",
          codex_home: accountHome,
          enabled: true
        }
      ],
      relay_slots: []
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(cslotDir, "state.json"),
    `${JSON.stringify({
      state_version: 4,
      selected_codex_auth_account_id: "old",
      selected_model_route: {
        mode: "auth_pool"
      },
      account_blocks: {
        old: {
          until: null,
          reason: "test",
          updated_at: "2026-07-26T00:00:00.000Z"
        }
      },
      usage_cache: {
        old: {
          accountId: "old",
          plan: "plus",
          fiveHourUsedPercent: 10,
          fiveHourResetAt: null,
          weeklyUsedPercent: 20,
          weeklyResetAt: null,
          refreshedAt: "2026-07-26T00:00:00.000Z"
        }
      },
      usage_refresh_errors: {
        old: {
          accountId: "old",
          code: "refresh_failed",
          message: "test",
          updatedAt: "2026-07-26T00:00:00.000Z"
        }
      },
      scheduler_stats: {
        old: {
          success_count: 2,
          last_success_at: null
        }
      },
      managed_codex_auth: {
        target_home: homeDir,
        source_account_id: "old",
        original_auth_file: null,
        original_registry_file: null,
        original_account_auth_files: {}
      },
      managed_codex_config: null,
      codex_client_version_cache: null,
      service_run_mode: null
    }, null, 2)}\n`,
    "utf8"
  );

  try {
    process.env.HOME = homeDir;

    renameAccount("old", "new");
    const renamedState = loadState();
    assert.equal(loadConfig().accounts[0].id, "new");
    assert.equal(renamedState.selected_codex_auth_account_id, "new");
    assert.equal(renamedState.account_blocks.new.reason, "test");
    assert.equal(renamedState.usage_cache.new.accountId, "new");
    assert.equal(renamedState.usage_refresh_errors.new.accountId, "new");
    assert.equal(renamedState.scheduler_stats.new.success_count, 2);
    assert.equal(renamedState.managed_codex_auth.source_account_id, "new");
    assert.equal("old" in renamedState.usage_refresh_errors, false);

    removeAccount("new");
    const removedState = loadState();
    assert.deepEqual(loadConfig().accounts, []);
    assert.equal(removedState.selected_codex_auth_account_id, null);
    assert.equal("new" in removedState.account_blocks, false);
    assert.equal("new" in removedState.usage_cache, false);
    assert.equal("new" in removedState.usage_refresh_errors, false);
    assert.equal("new" in removedState.scheduler_stats, false);
    assert.equal(removedState.managed_codex_auth.source_account_id, null);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
