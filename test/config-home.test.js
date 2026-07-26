const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const test = require("node:test");

const execFileAsync = promisify(execFile);
const {
  getUserHomeDir,
  loadConfig
} = require("../dist/config.js");

test("getUserHomeDir 会裁剪 HOME 尾随空格", () => {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const expectedHome = os.homedir();

  try {
    process.env.HOME = `${expectedHome} `;
    delete process.env.USERPROFILE;

    assert.equal(getUserHomeDir(), expectedHome);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
});

test("cslot 配置与基础目录默认使用私有权限", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cslot-config-home-"));
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = homeDir;
    loadConfig();

    if (process.platform !== "win32") {
      const cslotDir = path.join(homeDir, ".cslot");
      assert.equal(fs.statSync(cslotDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(cslotDir, "homes")).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(cslotDir, "logs")).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(cslotDir, "config.yaml")).mode & 0o777, 0o600);
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("config 跨进程并发更新不会覆盖其他进程新增账号", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cslot-config-concurrency-"));
  const configModulePath = path.join(__dirname, "..", "dist", "config.js");
  const workerCode = `
    const { updateConfig } = require(${JSON.stringify(configModulePath)});
    const workerId = process.argv[1];
    for (let index = 0; index < 10; index += 1) {
      updateConfig((config) => {
        const id = workerId + "-" + index;
        config.accounts.push({
          id,
          name: id,
          codex_home: "/tmp/" + id,
          enabled: true
        });
      });
    }
  `;
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = homeDir;
    loadConfig();
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

    const config = loadConfig();
    assert.equal(config.accounts.length, 40);
    assert.equal(config.accounts.some((account) => account.id === "d-9"), true);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
