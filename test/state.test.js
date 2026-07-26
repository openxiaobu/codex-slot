const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const test = require("node:test");

const execFileAsync = promisify(execFile);
const {
  getCachedCodexClientVersion,
  getServiceRunMode,
  loadState,
  saveState,
  setCachedCodexClientVersion,
  setServiceRunMode
} = require("../dist/state.js");

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

    assert.equal(state.state_version, 4);
    assert.equal(state.selected_codex_auth_account_id, null);
    assert.deepEqual(state.scheduler_stats, {});
    assert.equal(state.managed_codex_auth, null);
    assert.equal(state.managed_codex_config, null);
    assert.equal(state.codex_client_version_cache, null);
    assert.equal(state.service_run_mode, null);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    }
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
        selected_codex_auth_account_id: "slot-a",
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
        managed_codex_config: null,
        codex_client_version_cache: {
          version: "0.150.0",
          source: "request",
          updated_at: "2026-07-06T00:00:00.000Z"
        }
      });
    });

    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const tempFiles = fs.readdirSync(cslotDir).filter((item) => item.includes(".tmp"));

    assert.equal(saved.state_version, 4);
    assert.equal(saved.selected_codex_auth_account_id, "slot-a");
    assert.equal(saved.scheduler_stats.a.success_count, 1);
    assert.equal(saved.codex_client_version_cache.version, "0.150.0");
    assert.equal(saved.service_run_mode, null);
    assert.deepEqual(tempFiles, []);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(cslotDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("state 可读写 Codex client_version 成功缓存", () => {
  const homeDir = createIsolatedHome();

  try {
    withHome(homeDir, () => {
      assert.equal(getCachedCodexClientVersion(), null);

      setCachedCodexClientVersion("0.142.5", "fallback");

      assert.equal(getCachedCodexClientVersion(), "0.142.5");
      assert.equal(loadState().codex_client_version_cache.source, "fallback");
    });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("state 可持久化 proxy-only 服务运行模式", () => {
  const homeDir = createIsolatedHome();

  try {
    withHome(homeDir, () => {
      assert.equal(getServiceRunMode(), null);

      setServiceRunMode("proxy_only");
      assert.equal(getServiceRunMode(), "proxy_only");

      setServiceRunMode(null);
      assert.equal(getServiceRunMode(), null);
    });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("state 跨进程并发更新不会丢失其他进程写入的字段", async () => {
  const homeDir = createIsolatedHome();
  const stateModulePath = path.join(__dirname, "..", "dist", "state.js");
  const workerCode = `
    const { updateState } = require(${JSON.stringify(stateModulePath)});
    const workerId = process.argv[1];
    for (let index = 0; index < 20; index += 1) {
      updateState((state) => {
        state.account_blocks[workerId + "-" + index] = {
          until: null,
          reason: "concurrency-test",
          updated_at: "2026-07-26T00:00:00.000Z"
        };
      });
    }
  `;

  try {
    await Promise.all(
      ["a", "b", "c", "d"].map((workerId) =>
        execFileAsync(process.execPath, ["-e", workerCode, workerId], {
          env: {
            ...process.env,
            HOME: homeDir,
            USERPROFILE: homeDir
          }
        })
      )
    );

    const state = withHome(homeDir, () => loadState());
    assert.equal(Object.keys(state.account_blocks).length, 80);
    for (const workerId of ["a", "b", "c", "d"]) {
      assert.equal(state.account_blocks[`${workerId}-19`].reason, "concurrency-test");
    }
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
