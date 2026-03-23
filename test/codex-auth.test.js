const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  applyManagedCodexAuth,
  deactivateManagedCodexAuth
} = require("../dist/codex-auth.js");

function createIsolatedHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cslot-auth-home-"));
}

function writeCodexAuthState(homeDir, tokenLabel) {
  const codexDir = path.join(homeDir, ".codex");
  const accountsDir = path.join(codexDir, "accounts");

  fs.mkdirSync(accountsDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "auth.json"),
    `${JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: `${tokenLabel}-access`,
        refresh_token: `${tokenLabel}-refresh`,
        account_id: `${tokenLabel}-account`
      }
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(accountsDir, "registry.json"),
    `${JSON.stringify({
      version: 1,
      active_email: `${tokenLabel}@example.com`,
      accounts: [{ email: `${tokenLabel}@example.com` }]
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(accountsDir, `${tokenLabel}.auth.json`),
    `${JSON.stringify({ token: tokenLabel }, null, 2)}\n`,
    "utf8"
  );
}

/**
 * 写入仅包含顶层 `auth.json` 的简化登录态，用于覆盖无 `registry.json` 的场景。
 *
 * @param homeDir 测试 HOME 目录。
 * @param tokenLabel 令牌标识前缀。
 * @returns 无返回值。
 * @throws 当目录创建或文件写入失败时抛出底层文件系统错误。
 */
function writeAuthOnlyState(homeDir, tokenLabel) {
  const codexDir = path.join(homeDir, ".codex");

  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "auth.json"),
    `${JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: `${tokenLabel}-access`,
        refresh_token: `${tokenLabel}-refresh`,
        account_id: `${tokenLabel}-account`
      }
    }, null, 2)}\n`,
    "utf8"
  );
}

function readFileOrNull(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

test("主 HOME 登录态在 start 接管后可恢复到原始状态", () => {
  const sourceHome = createIsolatedHome();
  const targetHome = createIsolatedHome();
  const targetCodexDir = path.join(targetHome, ".codex");

  writeCodexAuthState(sourceHome, "managed");
  writeCodexAuthState(targetHome, "origin");
  fs.writeFileSync(path.join(targetCodexDir, "accounts", "stale.auth.json"), '{"token":"stale"}\n', "utf8");

  try {
    applyManagedCodexAuth(sourceHome, {
      targetHome,
      sourceAccountId: "slot-a"
    });

    assert.match(readFileOrNull(path.join(targetCodexDir, "auth.json")) ?? "", /managed-access/);
    assert.match(
      readFileOrNull(path.join(targetCodexDir, "accounts", "registry.json")) ?? "",
      /managed@example.com/
    );
    assert.ok(fs.existsSync(path.join(targetCodexDir, "accounts", "managed.auth.json")));

    deactivateManagedCodexAuth();

    assert.match(readFileOrNull(path.join(targetCodexDir, "auth.json")) ?? "", /origin-access/);
    assert.match(
      readFileOrNull(path.join(targetCodexDir, "accounts", "registry.json")) ?? "",
      /origin@example.com/
    );
    assert.ok(fs.existsSync(path.join(targetCodexDir, "accounts", "origin.auth.json")));
    assert.ok(fs.existsSync(path.join(targetCodexDir, "accounts", "stale.auth.json")));
    assert.ok(!fs.existsSync(path.join(targetCodexDir, "accounts", "managed.auth.json")));
  } finally {
    fs.rmSync(sourceHome, { recursive: true, force: true });
    fs.rmSync(targetHome, { recursive: true, force: true });
  }
});

test("来源缺少 registry.json 时也能接管，并在 stop 后恢复目标 HOME", () => {
  const sourceHome = createIsolatedHome();
  const targetHome = createIsolatedHome();
  const targetCodexDir = path.join(targetHome, ".codex");

  writeAuthOnlyState(sourceHome, "managed");
  writeCodexAuthState(targetHome, "origin");
  fs.writeFileSync(path.join(targetCodexDir, "accounts", "stale.auth.json"), '{"token":"stale"}\n', "utf8");

  try {
    applyManagedCodexAuth(sourceHome, {
      targetHome,
      sourceAccountId: "slot-b"
    });

    assert.match(readFileOrNull(path.join(targetCodexDir, "auth.json")) ?? "", /managed-access/);
    assert.equal(readFileOrNull(path.join(targetCodexDir, "accounts", "registry.json")), null);
    assert.ok(!fs.existsSync(path.join(targetCodexDir, "accounts", "origin.auth.json")));
    assert.ok(!fs.existsSync(path.join(targetCodexDir, "accounts", "stale.auth.json")));

    deactivateManagedCodexAuth();

    assert.match(readFileOrNull(path.join(targetCodexDir, "auth.json")) ?? "", /origin-access/);
    assert.match(
      readFileOrNull(path.join(targetCodexDir, "accounts", "registry.json")) ?? "",
      /origin@example.com/
    );
    assert.ok(fs.existsSync(path.join(targetCodexDir, "accounts", "origin.auth.json")));
    assert.ok(fs.existsSync(path.join(targetCodexDir, "accounts", "stale.auth.json")));
  } finally {
    fs.rmSync(sourceHome, { recursive: true, force: true });
    fs.rmSync(targetHome, { recursive: true, force: true });
  }
});
