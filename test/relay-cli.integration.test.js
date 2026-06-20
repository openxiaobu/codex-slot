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

function createIsolatedHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cslot-relay-home-"));
}

async function runCli(homeDir, args) {
  return await execFileAsync(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      HOME: homeDir
    }
  });
}

test("relay CLI 可以添加、列出、选择和恢复官方账号池", async () => {
  const homeDir = createIsolatedHome();

  try {
    await runCli(homeDir, [
      "relay",
      "add",
      "third",
      "--base-url",
      "https://relay.example.com/v1",
      "--api-key",
      "relay-secret"
    ]);

    const listResult = await runCli(homeDir, ["relay", "list"]);
    assert.match(listResult.stdout, /third/);
    assert.match(listResult.stdout, /https:\/\/relay\.example\.com\/v1/);
    assert.doesNotMatch(listResult.stdout, /relay-secret/);

    await runCli(homeDir, ["relay", "disable", "third"]);
    const disabledResult = await runCli(homeDir, ["relay", "list"]);
    assert.match(disabledResult.stdout, /third  disabled/);

    await runCli(homeDir, ["relay", "enable", "third"]);
    const enabledResult = await runCli(homeDir, ["relay", "list"]);
    assert.match(enabledResult.stdout, /third  enabled/);

    await runCli(homeDir, ["use", "relay", "third"]);
    const statePath = path.join(homeDir, ".cslot", "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(state.selected_model_route, {
      mode: "relay_slot",
      relay_slot_id: "third"
    });

    const currentRelay = await runCli(homeDir, ["current"]);
    assert.match(currentRelay.stdout, /model_route=relay:third/);

    const statusRelay = await runCli(homeDir, ["status", "--no-interactive"]);
    assert.match(statusRelay.stdout, /third\*/);
    assert.match(statusRelay.stdout, /https:\/\/relay\.example\.com\/v1/);
    assert.match(statusRelay.stdout, /model_route=relay:third/);

    await runCli(homeDir, ["use", "auth"]);
    const resetState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(resetState.selected_model_route, {
      mode: "auth_pool"
    });

    const config = YAML.parse(
      fs.readFileSync(path.join(homeDir, ".cslot", "config.yaml"), "utf8")
    );
    assert.equal(config.relay_slots[0].api_key, "relay-secret");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("账号 del 会同步删除同名 relay 槽位并恢复官方账号池", async () => {
  const homeDir = createIsolatedHome();
  const cslotDir = path.join(homeDir, ".cslot");
  const configPath = path.join(cslotDir, "config.yaml");
  const statePath = path.join(cslotDir, "state.json");

  fs.mkdirSync(path.join(cslotDir, "homes", "work"), { recursive: true });
  fs.writeFileSync(
    configPath,
    YAML.stringify({
      version: 1,
      accounts: [
        {
          id: "work",
          name: "work",
          codex_home: path.join(cslotDir, "homes", "work"),
          enabled: true
        }
      ],
      relay_slots: [
        {
          id: "work",
          name: "work",
          base_url: "https://relay.example.com/v1",
          api_key: "relay-secret",
          enabled: true
        }
      ]
    }),
    "utf8"
  );
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        selected_model_route: {
          mode: "relay_slot",
          relay_slot_id: "work"
        }
      },
      null,
      2
    ),
    "utf8"
  );

  try {
    await runCli(homeDir, ["del", "work"]);

    const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

    assert.deepEqual(config.accounts, []);
    assert.deepEqual(config.relay_slots, []);
    assert.deepEqual(state.selected_model_route, {
      mode: "auth_pool"
    });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("账号 rename 会同步重命名同名 relay 槽位并迁移当前模型出口", async () => {
  const homeDir = createIsolatedHome();
  const cslotDir = path.join(homeDir, ".cslot");
  const configPath = path.join(cslotDir, "config.yaml");
  const statePath = path.join(cslotDir, "state.json");

  fs.mkdirSync(path.join(cslotDir, "homes", "work"), { recursive: true });
  fs.writeFileSync(
    configPath,
    YAML.stringify({
      version: 1,
      accounts: [
        {
          id: "work",
          name: "work",
          codex_home: path.join(cslotDir, "homes", "work"),
          enabled: true
        }
      ],
      relay_slots: [
        {
          id: "work",
          name: "work",
          base_url: "https://relay.example.com/v1",
          api_key: "relay-secret",
          enabled: true
        }
      ]
    }),
    "utf8"
  );
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        account_blocks: {},
        usage_cache: {},
        usage_refresh_errors: {},
        scheduler_stats: {},
        managed_codex_auth: null,
        managed_codex_config: null,
        selected_model_route: {
          mode: "relay_slot",
          relay_slot_id: "work"
        }
      },
      null,
      2
    ),
    "utf8"
  );

  try {
    await runCli(homeDir, ["rename", "work", "main"]);

    const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

    assert.equal(config.accounts[0].id, "main");
    assert.equal(config.accounts[0].name, "main");
    assert.equal(config.relay_slots[0].id, "main");
    assert.equal(config.relay_slots[0].name, "main");
    assert.equal(config.relay_slots[0].api_key, "relay-secret");
    assert.deepEqual(state.selected_model_route, {
      mode: "relay_slot",
      relay_slot_id: "main"
    });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
