const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadState, saveState } = require("../dist/state.js");

function createIsolatedHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cslot-home-"));
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

test("state 读取旧格式时自动补齐当前 schema 字段", () => {
  const homeDir = createIsolatedHome();
  const cslotDir = path.join(homeDir, ".cslot");
  const statePath = path.join(cslotDir, "state.json");

  fs.mkdirSync(cslotDir, { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      account_blocks: {},
      usage_cache: {},
      usage_refresh_errors: {}
    }),
    "utf8"
  );

  try {
    const state = withHome(homeDir, () => loadState());

    assert.equal(state.state_version, 1);
    assert.deepEqual(state.scheduler_stats, {});
    assert.equal(state.managed_codex_auth, null);
    assert.equal(state.managed_codex_config, null);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("state 保存时写入版本并通过临时文件原子替换", () => {
  const homeDir = createIsolatedHome();
  const cslotDir = path.join(homeDir, ".cslot");
  const statePath = path.join(cslotDir, "state.json");

  try {
    withHome(homeDir, () => {
      saveState({
        state_version: 1,
        account_blocks: {},
        usage_cache: {},
        usage_refresh_errors: {},
        scheduler_stats: {
          a: {
            success_count: 1,
            last_success_at: null
          }
        },
        managed_codex_auth: null,
        managed_codex_config: null
      });
    });

    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const tempFiles = fs.readdirSync(cslotDir).filter((item) => item.includes(".tmp"));

    assert.equal(saved.state_version, 1);
    assert.equal(saved.scheduler_stats.a.success_count, 1);
    assert.deepEqual(tempFiles, []);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
