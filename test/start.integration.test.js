const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const test = require("node:test");
const YAML = require("yaml");

const execFileAsync = promisify(execFile);
const cliPath = path.join(__dirname, "..", "dist", "cli.js");

/**
 * 为每个集成测试创建独立 HOME，避免污染当前用户真实配置。
 *
 * @returns 隔离 HOME 的绝对路径。
 * @throws 当临时目录创建失败时抛出文件系统错误。
 */
function createIsolatedHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cslot-home-"));
}

/**
 * 基于隔离 HOME 生成 CLI 运行环境变量。
 *
 * @param homeDir 测试专用 HOME 目录。
 * @returns 可用于子进程执行的环境变量对象。
 * @throws 无显式抛出。
 */
function createCliEnv(homeDir) {
  return {
    ...process.env,
    HOME: homeDir
  };
}

/**
 * 运行一次 CLI 命令，并在失败时保留 stdout/stderr 便于断言。
 *
 * @param homeDir 测试专用 HOME 目录。
 * @param args CLI 参数列表。
 * @returns CLI 标准输出与标准错误。
 * @throws 当 CLI 命令执行失败时透传子进程异常。
 */
async function runCli(homeDir, args) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    env: createCliEnv(homeDir)
  });
}

/**
 * 轮询本地健康检查，确认后台服务已经对外提供服务。
 *
 * @param port 待探测端口。
 * @returns Promise，健康检查成功时返回。
 * @throws 当超时后仍未通过健康检查时抛出异常。
 */
async function waitForHealth(port) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500)
      });

      if (response.ok) {
        const payload = await response.json();

        if (payload.ok === true) {
          return;
        }
      }
    } catch {
      // 后台服务尚未就绪时允许继续轮询。
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`等待端口 ${port} 健康检查超时`);
}

/**
 * 读取隔离 HOME 下的 cslot 配置文件。
 *
 * @param homeDir 测试专用 HOME 目录。
 * @returns 已解析的配置对象。
 * @throws 当配置文件不存在或 YAML 非法时抛出异常。
 */
function readCslotConfig(homeDir) {
  const configPath = path.join(homeDir, ".cslot", "config.yaml");
  return YAML.parse(fs.readFileSync(configPath, "utf8"));
}

/**
 * 读取隔离 HOME 下的 Codex 配置文本，供断言 provider 接管结果。
 *
 * @param homeDir 测试专用 HOME 目录。
 * @returns `config.toml` 原始文本。
 * @throws 当配置文件不存在时抛出文件系统错误。
 */
function readCodexConfig(homeDir) {
  const configPath = path.join(homeDir, ".codex", "config.toml");
  return fs.readFileSync(configPath, "utf8");
}

/**
 * 启动一个临时 HTTP 服务占用指定端口，模拟默认端口冲突。
 *
 * @param port 需要占用的端口。
 * @returns Promise，成功时返回 server 实例。
 * @throws 当端口监听失败时抛出底层错误。
 */
function occupyPort(port) {
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end("occupied");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/**
 * 关闭临时占端口服务。
 *
 * @param server 已启动的 HTTP server。
 * @returns Promise，关闭完成后返回。
 * @throws 当关闭失败时抛出底层错误。
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

/**
 * 启动一个临时上游服务，供代理集成测试验证 2xx/4xx 转发稳定性。
 *
 * @param handler 请求处理函数。
 * @returns Promise，成功时返回已监听的 server 与端口。
 * @throws 当监听失败时抛出底层错误。
 */
function startUpstreamServer(handler) {
  const server = http.createServer(handler);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      resolve({
        server,
        port: address && typeof address === "object" ? address.port : 0
      });
    });
  });
}

/**
 * 为代理测试准备最小可用的受管账号与本地配置。
 *
 * @param homeDir 测试专用 HOME 目录。
 * @param upstreamPort 假上游服务端口。
 * @returns 无返回值。
 * @throws 当目录或配置写入失败时抛出文件系统错误。
 */
function prepareManagedProxyFixture(homeDir, upstreamPort) {
  const cslotDir = path.join(homeDir, ".cslot");
  const managedHome = path.join(cslotDir, "homes", "slot-a");
  const managedCodexDir = path.join(managedHome, ".codex");

  fs.mkdirSync(managedCodexDir, { recursive: true });
  fs.writeFileSync(
    path.join(managedCodexDir, "auth.json"),
    JSON.stringify(
      {
        auth_mode: "chatgpt",
        tokens: {
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          account_id: "test-account-id"
        }
      },
      null,
      2
    ),
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
        api_key: "cslot-test-key",
        body_limit_mb: 512
      },
      upstream: {
        codex_base_url: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
        auth_base_url: "https://auth.openai.com",
        oauth_client_id: "app_EMoamEEZ73f0CkXaXp7hrann"
      },
      accounts: [
        {
          id: "slot-a",
          name: "slot-a",
          codex_home: managedHome,
          enabled: true
        }
      ]
    }),
    "utf8"
  );
}

/**
 * 检查指定端口当前是否可监听，用于让集成测试兼容真实环境里已有的本地占用。
 *
 * @param port 待检查端口。
 * @returns Promise，可用时返回 `true`，被占用时返回 `false`。
 * @throws 无显式抛出。
 */
function isPortFree(port) {
  const server = http.createServer();

  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

test("默认启动会把实际端口与 api_key 同步到单一 provider 配置", async () => {
  const homeDir = createIsolatedHome();

  try {
    const { stdout } = await runCli(homeDir, ["start"]);
    const baseUrlMatch = stdout.match(/base_url=http:\/\/127\.0\.0\.1:(\d+)\/v1/);
    assert.ok(baseUrlMatch);
    const actualPort = Number(baseUrlMatch[1]);

    await waitForHealth(actualPort);

    const cslotConfig = readCslotConfig(homeDir);
    const codexConfig = readCodexConfig(homeDir);

    assert.equal(cslotConfig.server.port, actualPort);
    assert.match(cslotConfig.server.api_key, /^cslot-/);
    assert.match(codexConfig, /\[model_providers\.cslot\]/);
    assert.match(codexConfig, new RegExp(`base_url = "http://127\\.0\\.0\\.1:${actualPort}/v1"`));
    assert.match(
      codexConfig,
      new RegExp(`experimental_bearer_token = "${cslotConfig.server.api_key}"`)
    );
    assert.match(codexConfig, /\[model_providers\.cslot\.http_headers\]/);
    assert.match(
      codexConfig,
      new RegExp(`Authorization = "Bearer ${cslotConfig.server.api_key}"`)
    );
  } finally {
    await runCli(homeDir, ["stop"]).catch(() => {});
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("当 4399 被占用时自动顺延，并把实际端口同步写回配置", async (t) => {
  if (!(await isPortFree(4399))) {
    t.skip("当前环境中的 4399 已被外部占用，无法构造可控冲突场景。");
    return;
  }

  const homeDir = createIsolatedHome();
  const occupiedServer = await occupyPort(4399);

  try {
    const { stdout } = await runCli(homeDir, ["start"]);
    assert.match(stdout, /自动切换到 4400|Automatically switched to 4400/);

    await waitForHealth(4400);

    const cslotConfig = readCslotConfig(homeDir);
    const codexConfig = readCodexConfig(homeDir);

    assert.equal(cslotConfig.server.port, 4400);
    assert.match(codexConfig, /base_url = "http:\/\/127\.0\.0\.1:4400\/v1"/);
    assert.match(
      codexConfig,
      new RegExp(`experimental_bearer_token = "${cslotConfig.server.api_key}"`)
    );
    assert.match(codexConfig, /\[model_providers\.cslot\.http_headers\]/);
    assert.match(
      codexConfig,
      new RegExp(`Authorization = "Bearer ${cslotConfig.server.api_key}"`)
    );
  } finally {
    await runCli(homeDir, ["stop"]).catch(() => {});
    await closeServer(occupiedServer);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("代理转发 400 后服务仍保持存活", async () => {
  const homeDir = createIsolatedHome();
  const { server: upstreamServer, port: upstreamPort } = await startUpstreamServer((req, res) => {
    if (req.url !== "/backend-api/codex/responses") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "bad request" } }));
  });

  try {
    prepareManagedProxyFixture(homeDir, upstreamPort);

    const { stdout } = await runCli(homeDir, ["start"]);
    const portMatch = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    assert.ok(portMatch);
    const proxyPort = Number(portMatch[1]);

    await waitForHealth(proxyPort);

    const cslotConfig = readCslotConfig(homeDir);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cslotConfig.server.api_key}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: "test-model", input: "hello" })
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /bad request/);

    await waitForHealth(proxyPort);
  } finally {
    await runCli(homeDir, ["stop"]).catch(() => {});
    await closeServer(upstreamServer);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("代理转发 200 后服务仍保持存活", async () => {
  const homeDir = createIsolatedHome();
  const { server: upstreamServer, port: upstreamPort } = await startUpstreamServer((req, res) => {
    if (req.url !== "/backend-api/codex/responses") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    prepareManagedProxyFixture(homeDir, upstreamPort);

    const { stdout } = await runCli(homeDir, ["start"]);
    const portMatch = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    assert.ok(portMatch);
    const proxyPort = Number(portMatch[1]);

    await waitForHealth(proxyPort);

    const cslotConfig = readCslotConfig(homeDir);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cslotConfig.server.api_key}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: "test-model", input: "hello" })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    await waitForHealth(proxyPort);
  } finally {
    await runCli(homeDir, ["stop"]).catch(() => {});
    await closeServer(upstreamServer);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
