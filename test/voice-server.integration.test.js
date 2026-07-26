const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;
const YAML = require("yaml");

const servePath = path.join(__dirname, "..", "dist", "serve.js");

/**
 * 启动临时 HTTP server 并返回实际监听端口。
 *
 * @param server 待启动的 Node HTTP server。
 * @returns 实际监听端口。
 * @throws 当监听失败时抛出底层错误。
 */
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

/**
 * 关闭仍在监听的临时 HTTP server。
 *
 * @param server 待关闭 server。
 * @returns Promise，在 server 完全关闭后结束。
 * @throws 当关闭过程失败时抛出错误。
 */
async function closeServer(server) {
  if (!server.listening) {
    return;
  }

  server.close();
  await once(server, "close");
}

/**
 * 申请一个当前可用的 loopback 端口。
 *
 * @returns 可供 cslot 子进程监听的端口。
 * @throws 当临时 server 启停失败时抛出错误。
 */
async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

/**
 * 轮询 cslot 健康检查直到服务就绪。
 *
 * @param port cslot 子进程监听端口。
 * @returns Promise，在健康检查成功后结束。
 * @throws 5 秒内未就绪时抛出超时错误。
 */
async function waitForHealth(port) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(300)
      });
      if (response.ok) {
        return;
      }
    } catch {
      // 子进程端口尚未开始监听时继续轮询。
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Voice cslot server health check timed out");
}

/**
 * 写入运行 Voice 代理所需的最小隔离 HOME。
 *
 * @param homeDir 测试专用 HOME。
 * @param upstreamPort 假 ChatGPT backend 端口。
 * @param localPort cslot 子进程端口。
 * @param bodyLimitMb 可选请求体上限，默认使用生产配置值。
 * @returns 无返回值。
 * @throws 当目录或文件写入失败时抛出错误。
 */
function prepareVoiceHome(homeDir, upstreamPort, localPort, bodyLimitMb = 512) {
  const cslotDir = path.join(homeDir, ".cslot");
  const accountHome = path.join(cslotDir, "homes", "voice-a");
  const accountCodexDir = path.join(accountHome, ".codex");

  fs.mkdirSync(accountCodexDir, { recursive: true });
  fs.writeFileSync(
    path.join(accountCodexDir, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "server-integration-token",
        refresh_token: "server-integration-refresh",
        account_id: "server-integration-account"
      }
    }),
    "utf8"
  );
  fs.mkdirSync(cslotDir, { recursive: true });
  fs.writeFileSync(
    path.join(cslotDir, "config.yaml"),
    YAML.stringify({
      version: 1,
      server: {
        host: "127.0.0.1",
        port: localPort,
        body_limit_mb: bodyLimitMb
      },
      upstream: {
        codex_base_url: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
        chatgpt_base_url: `http://127.0.0.1:${upstreamPort}/backend-api`,
        auth_base_url: "https://auth.example.test",
        oauth_client_id: "test-client"
      },
      accounts: [
        {
          id: "voice-a",
          name: "voice-a",
          codex_home: accountHome,
          enabled: true
        }
      ],
      relay_slots: [
        {
          id: "relay-a",
          name: "relay-a",
          base_url: "http://127.0.0.1:1/v1",
          api_key: "relay-test-key",
          enabled: true
        }
      ]
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(cslotDir, "state.json"),
    JSON.stringify({
      state_version: 4,
      selected_model_route: {
        mode: "relay_slot",
        relay_slot_id: "relay-a"
      }
    }),
    "utf8"
  );
}

/**
 * 构造 Codex App 当前 `/v1/live` 使用的 multipart 请求体。
 *
 * @returns Content-Type 与完整请求 body。
 * @throws 无显式抛出。
 */
function createVoiceMultipart() {
  const boundary = "server-voice-boundary";

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.from(
      `--${boundary}\r\n` +
      "Content-Disposition: form-data; name=\"sdp\"\r\n" +
      "Content-Type: application/sdp\r\n\r\n" +
      "v=offer\r\n\r\n" +
      `--${boundary}\r\n` +
      "Content-Disposition: form-data; name=\"session\"\r\n" +
      "Content-Type: application/json\r\n\r\n" +
      "{\"id\":\"local-session\",\"model\":\"gpt-realtime\",\"delegation\":{\"type\":\"client\"}}\r\n" +
      `--${boundary}--\r\n`
    )
  };
}

test("cslot server 在 relay 模式下仍用官方账号完整转发 Voice call 与 Frameless sideband", async (t) => {
  let upstreamHttpRequest = null;
  let upstreamWebSocketRequest = null;
  const upstreamServer = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      upstreamHttpRequest = {
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8")
      };
      response.writeHead(200, {
        "content-type": "application/sdp",
        location: "/v1/live/rtc_server_integration"
      });
      response.end("v=answer\r\n");
    });
  });
  const upstreamWebSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false
  });

  upstreamServer.on("upgrade", (request, socket, head) => {
    upstreamWebSocketRequest = request;
    upstreamWebSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      upstreamWebSocketServer.emit("connection", webSocket, request);
    });
  });
  upstreamWebSocketServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      socket.send(`server-echo:${data.toString("utf8")}`);
    });
  });

  const upstreamPort = await listen(upstreamServer);
  const localPort = await reservePort();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cslot-voice-server-"));
  prepareVoiceHome(homeDir, upstreamPort, localPort);

  const child = spawn(process.execPath, [servePath, "--port", String(localPort)], {
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let childStderr = "";
  child.stderr.on("data", (chunk) => {
    childStderr += chunk.toString("utf8");
  });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    upstreamWebSocketServer.close();
    await closeServer(upstreamServer);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  await waitForHealth(localPort);
  const multipart = createVoiceMultipart();
  const callResponse = await fetch(`http://127.0.0.1:${localPort}/v1/live`, {
    method: "POST",
    headers: {
      "content-type": multipart.contentType,
      "user-agent": "codex-cli/0.146.0",
      "openai-alpha": "quicksilver=v1",
      "originator": "codex_work_desktop",
      "session-id": "call-codex-session",
      "thread-id": "call-thread",
      "x-oai-attestation": "call-attestation",
      "x-session-id": "call-session"
    },
    body: multipart.body
  });

  if (callResponse.status !== 200) {
    assert.fail(
      `Voice call failed with ${callResponse.status}: ${await callResponse.text()}\n${childStderr}`
    );
  }
  assert.equal(
    callResponse.headers.get("location"),
    "/v1/live/rtc_server_integration"
  );
  assert.equal(await callResponse.text(), "v=answer\r\n");
  assert.equal(
    upstreamHttpRequest.url,
    "/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas"
  );
  assert.equal(
    upstreamHttpRequest.headers.authorization,
    "Bearer server-integration-token"
  );
  assert.equal(
    upstreamHttpRequest.headers["chatgpt-account-id"],
    "server-integration-account"
  );
  assert.equal(upstreamHttpRequest.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(upstreamHttpRequest.body), {
    sdp: "v=offer\r\n",
    session: {
      model: "gpt-realtime",
      delegation: { type: "client" }
    }
  });

  const client = new WebSocket(
    `ws://127.0.0.1:${localPort}/v1/live/rtc_server_integration`,
    {
      headers: {
        "session-id": "different-codex-session",
        "thread-id": "different-thread",
        "x-oai-attestation": "different-sideband-attestation",
        "x-session-id": "different-sideband-session"
      },
      perMessageDeflate: false
    }
  );
  const messagePromise = once(client, "message");

  await once(client, "open");
  client.send("from-server-integration");
  const [message] = await messagePromise;

  assert.equal(
    message.toString("utf8"),
    "server-echo:from-server-integration"
  );
  assert.equal(
    upstreamWebSocketRequest.url,
    "/backend-api/codex/rtc_server_integration"
  );
  assert.equal(
    upstreamWebSocketRequest.headers.authorization,
    "Bearer server-integration-token"
  );
  assert.equal(
    upstreamWebSocketRequest.headers["openai-alpha"],
    "quicksilver=v1"
  );
  assert.equal(
    upstreamWebSocketRequest.headers.originator,
    "codex_work_desktop"
  );
  assert.equal(
    upstreamWebSocketRequest.headers["session-id"],
    "call-codex-session"
  );
  assert.equal(
    upstreamWebSocketRequest.headers["thread-id"],
    "call-thread"
  );
  assert.equal(
    upstreamWebSocketRequest.headers["x-oai-attestation"],
    "call-attestation"
  );
  assert.equal(
    upstreamWebSocketRequest.headers["x-session-id"],
    "call-session"
  );

  client.close();
  await once(client, "close");
});

test("Voice HTTP 请求体超过配置上限时返回 413 且不会访问官方上游", async (t) => {
  let upstreamRequestCount = 0;
  const upstreamServer = http.createServer((_request, response) => {
    upstreamRequestCount += 1;
    response.statusCode = 200;
    response.end("unexpected");
  });
  const upstreamPort = await listen(upstreamServer);
  const localPort = await reservePort();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cslot-voice-limit-"));
  prepareVoiceHome(homeDir, upstreamPort, localPort, 0.0001);

  const child = spawn(process.execPath, [servePath, "--port", String(localPort)], {
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await closeServer(upstreamServer);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  await waitForHealth(localPort);
  const response = await fetch(`http://127.0.0.1:${localPort}/v1/live`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream"
    },
    body: Buffer.alloc(1024, 1)
  });

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.type, "request_body_too_large");
  assert.equal(upstreamRequestCount, 0);
  await waitForHealth(localPort);
});
