const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const test = require("node:test");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const { VoiceCallBindingStore } = require("../dist/voice-call-binding-store.js");
const {
  buildUpstreamVoiceWebSocketUrl,
  createVoiceWebSocketProxy
} = require("../dist/voice-websocket-proxy.js");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }

  server.close();
  await once(server, "close");
}

function waitForMessages(socket, expectedCount) {
  return new Promise((resolve, reject) => {
    const messages = [];

    socket.on("message", (data) => {
      messages.push(data.toString("utf8"));
      if (messages.length >= expectedCount) {
        resolve(messages);
      }
    });
    socket.once("error", reject);
  });
}

/**
 * 轮询异步清理条件，避免把客户端 close 与服务端 close 回调误认为同一时刻。
 *
 * @param {() => boolean} predicate 完成条件。
 * @param {string} message 超时后的断言说明。
 * @returns {Promise<void>} 条件满足后结束。
 * @throws 条件在 1 秒内未满足时抛出断言错误。
 */
async function waitForCondition(predicate, message) {
  const deadline = Date.now() + 1000;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.fail(message);
}

function createConfig(upstreamPort) {
  return {
    version: 1,
    server: {
      host: "127.0.0.1",
      port: 4399,
      body_limit_mb: 512
    },
    upstream: {
      codex_base_url: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
      chatgpt_base_url: `http://127.0.0.1:${upstreamPort}/backend-api`,
      auth_base_url: "https://auth.example.test",
      oauth_client_id: "test-client"
    },
    accounts: [],
    relay_slots: []
  };
}

test("Voice ChatGPT call 的 sideband 使用 OpenAI transceiver 独立上游", () => {
  assert.equal(
    buildUpstreamVoiceWebSocketUrl(
      "https://chatgpt.com/backend-api/codex",
      {
        callId: "rtc_voice_direct",
        mode: "frameless",
        query: new URLSearchParams()
      }
    ),
    "wss://api.openai.com/v1/live/rtc_voice_direct"
  );
  assert.equal(
    buildUpstreamVoiceWebSocketUrl(
      "https://chatgpt.com/backend-api/codex/",
      {
        callId: "rtc_voice_legacy_direct",
        mode: "legacy",
        query: new URLSearchParams("intent=quicksilver&trace=1")
      }
    ),
    "wss://api.openai.com/v1/realtime?trace=1&intent=quicksilver&call_id=rtc_voice_legacy_direct"
  );
});

test("Voice Frameless sideband 固定使用 call 创建账号并双向转发消息", async (t) => {
  const upstreamServer = http.createServer();
  const upstreamWebSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false
  });
  let upstreamRequest = null;

  upstreamServer.on("upgrade", (request, socket, head) => {
    upstreamRequest = request;
    upstreamWebSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      upstreamWebSocketServer.emit("connection", webSocket, request);
    });
  });
  upstreamWebSocketServer.on("connection", (socket) => {
    socket.send("early-session-event");
    socket.on("message", (data) => {
      socket.send(`echo:${data.toString("utf8")}`);
    });
  });

  const upstreamPort = await listen(upstreamServer);
  const localServer = http.createServer();
  const store = new VoiceCallBindingStore();
  store.remember({
    callId: "rtc_voice_ws",
    accountId: "voice-a",
    codexHome: "/tmp/voice-a",
    createdAt: Date.now()
  });
  const proxy = createVoiceWebSocketProxy(
    localServer,
    store,
    {
      loadConfig: () => createConfig(upstreamPort),
      readAuthFile: () => ({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "official-voice-token",
          refresh_token: "refresh-token",
          account_id: "official-account-id"
        }
      }),
      refreshAccountTokens: async () => {
        throw new Error("refresh should not be called");
      }
    }
  );
  const localPort = await listen(localServer);

  t.after(async () => {
    proxy.close();
    upstreamWebSocketServer.close();
    await closeServer(localServer);
    await closeServer(upstreamServer);
  });

  const client = new WebSocket(
    `ws://127.0.0.1:${localPort}/v1/live/rtc_voice_ws`,
    {
      headers: {
        authorization: "Bearer local-provider-token",
        "user-agent": "codex-cli/0.146.0",
        "x-session-id": "session-voice"
      },
      perMessageDeflate: false
    }
  );
  const receivedMessages = waitForMessages(client, 2);

  await once(client, "open");
  client.send("from-codex-app");

  assert.deepEqual(
    await receivedMessages,
    ["early-session-event", "echo:from-codex-app"]
  );
  assert.equal(upstreamRequest.url, "/backend-api/codex/rtc_voice_ws");
  assert.equal(
    upstreamRequest.headers.authorization,
    "Bearer official-voice-token"
  );
  assert.equal(
    upstreamRequest.headers["chatgpt-account-id"],
    "official-account-id"
  );
  assert.equal(upstreamRequest.headers["user-agent"], "codex-cli/0.146.0");
  assert.equal(upstreamRequest.headers["x-session-id"], "session-voice");

  client.close(1000, "done");
  await once(client, "close");
  await waitForCondition(
    () => store.get("rtc_voice_ws") === null,
    "Voice call binding was not released after WebSocket close"
  );
});

test("Voice legacy sideband 映射 call_id query 且 401 后刷新 token", async (t) => {
  const upstreamServer = http.createServer();
  const upstreamWebSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false
  });
  const attempts = [];

  upstreamServer.on("upgrade", (request, socket, head) => {
    attempts.push({
      url: request.url,
      authorization: request.headers.authorization
    });

    if (request.headers.authorization === "Bearer expired-token") {
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\n" +
        "Content-Length: 0\r\n" +
        "Connection: close\r\n\r\n"
      );
      return;
    }

    upstreamWebSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      upstreamWebSocketServer.emit("connection", webSocket, request);
    });
  });
  upstreamWebSocketServer.on("connection", (socket) => {
    socket.send("legacy-connected");
  });

  const upstreamPort = await listen(upstreamServer);
  const localServer = http.createServer();
  const store = new VoiceCallBindingStore();
  let currentToken = "expired-token";
  store.remember({
    callId: "rtc_voice_legacy_ws",
    accountId: "voice-a",
    codexHome: "/tmp/voice-a",
    createdAt: Date.now()
  });
  const proxy = createVoiceWebSocketProxy(
    localServer,
    store,
    {
      loadConfig: () => createConfig(upstreamPort),
      readAuthFile: () => ({
        auth_mode: "chatgpt",
        tokens: {
          access_token: currentToken,
          refresh_token: "refresh-token",
          account_id: "official-account-id"
        }
      }),
      refreshAccountTokens: async () => {
        currentToken = "refreshed-token";
        return {
          auth_mode: "chatgpt",
          tokens: {
            access_token: currentToken,
            refresh_token: "refresh-token",
            account_id: "official-account-id"
          }
        };
      }
    }
  );
  const localPort = await listen(localServer);

  t.after(async () => {
    proxy.close();
    upstreamWebSocketServer.close();
    await closeServer(localServer);
    await closeServer(upstreamServer);
  });

  const client = new WebSocket(
    `ws://127.0.0.1:${localPort}/v1/realtime?intent=quicksilver&call_id=rtc_voice_legacy_ws&trace=1`,
    { perMessageDeflate: false }
  );
  const receivedMessages = waitForMessages(client, 1);

  await once(client, "open");
  assert.deepEqual(await receivedMessages, ["legacy-connected"]);
  assert.deepEqual(attempts, [
    {
      url: "/backend-api/codex?trace=1&intent=quicksilver&call_id=rtc_voice_legacy_ws",
      authorization: "Bearer expired-token"
    },
    {
      url: "/backend-api/codex?trace=1&intent=quicksilver&call_id=rtc_voice_legacy_ws",
      authorization: "Bearer refreshed-token"
    }
  ]);

  client.close();
  await once(client, "close");

  store.remember({
    callId: "rtc_voice_v2_ws",
    accountId: "voice-a",
    codexHome: "/tmp/voice-a",
    createdAt: Date.now()
  });
  const v2Client = new WebSocket(
    `ws://127.0.0.1:${localPort}/v1/realtime?call_id=rtc_voice_v2_ws&trace=2`,
    { perMessageDeflate: false }
  );
  const v2Messages = waitForMessages(v2Client, 1);

  await once(v2Client, "open");
  assert.deepEqual(await v2Messages, ["legacy-connected"]);
  assert.deepEqual(attempts.at(-1), {
    url: "/backend-api/codex?trace=2&call_id=rtc_voice_v2_ws",
    authorization: "Bearer refreshed-token"
  });

  v2Client.close();
  await once(v2Client, "close");
});

test("Voice sideband 缺少 call 绑定时在 101 前返回 404", async (t) => {
  const localServer = http.createServer();
  const store = new VoiceCallBindingStore();
  const proxy = createVoiceWebSocketProxy(
    localServer,
    store,
    {
      loadConfig: () => createConfig(65535),
      readAuthFile: () => null,
      refreshAccountTokens: async () => {
        throw new Error("refresh should not be called");
      }
    }
  );
  const localPort = await listen(localServer);

  t.after(async () => {
    proxy.close();
    await closeServer(localServer);
  });

  const client = new WebSocket(
    `ws://127.0.0.1:${localPort}/v1/live/rtc_missing_binding`
  );
  client.on("error", () => {
    // `ws` 在非 101 响应后终止 CONNECTING 连接时会同步报告预期错误。
  });
  const [, response] = await once(client, "unexpected-response");

  assert.equal(response.statusCode, 404);
  response.resume();
  client.terminate();

  const invalidClient = new WebSocket(
    `ws://127.0.0.1:${localPort}/v1/live/not-a-call-id`
  );
  invalidClient.on("error", () => {
    // 非 101 的预期响应会让 `ws` 报告连接未建立。
  });
  const [, invalidResponse] = await once(
    invalidClient,
    "unexpected-response"
  );

  assert.equal(invalidResponse.statusCode, 400);
  invalidResponse.resume();
  invalidClient.terminate();
});
