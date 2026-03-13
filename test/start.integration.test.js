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

test("默认启动使用 4399，并将端口与 api_key 同步到单一 provider 配置", async () => {
  const homeDir = createIsolatedHome();

  try {
    const { stdout } = await runCli(homeDir, ["start"]);
    assert.match(stdout, /http:\/\/127\.0\.0\.1:4399\/v1/);

    await waitForHealth(4399);

    const cslotConfig = readCslotConfig(homeDir);
    const codexConfig = readCodexConfig(homeDir);

    assert.equal(cslotConfig.server.port, 4399);
    assert.match(cslotConfig.server.api_key, /^cslot-/);
    assert.match(codexConfig, /\[model_providers\.cslot\]/);
    assert.match(codexConfig, /base_url = "http:\/\/127\.0\.0\.1:4399\/v1"/);
    assert.match(
      codexConfig,
      new RegExp(`http_headers = \\{ Authorization = "Bearer ${cslotConfig.server.api_key}" \\}`)
    );
    assert.doesNotMatch(codexConfig, /\[model_providers\.cslot\.http_headers\]/);
  } finally {
    await runCli(homeDir, ["stop"]).catch(() => {});
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("当 4399 被占用时自动顺延，并把实际端口同步写回配置", async () => {
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
      new RegExp(`http_headers = \\{ Authorization = "Bearer ${cslotConfig.server.api_key}" \\}`)
    );
  } finally {
    await runCli(homeDir, ["stop"]).catch(() => {});
    await closeServer(occupiedServer);
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
