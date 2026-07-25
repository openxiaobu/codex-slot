const assert = require("node:assert/strict");
const test = require("node:test");

const { VoiceCallBindingStore } = require("../dist/voice-call-binding-store.js");
const { createVoiceProxyService } = require("../dist/voice-proxy-service.js");

function createAccount(id) {
  return {
    id,
    name: id,
    codex_home: `/tmp/${id}`,
    enabled: true
  };
}

function createBody(text) {
  const iterable = (async function* body() {
    yield Buffer.from(text);
  })();

  iterable.text = async () => text;
  return iterable;
}

function createResponse(statusCode, text, headers = {}) {
  return {
    statusCode,
    headers,
    body: createBody(text)
  };
}

function createMultipartBody(sdp, session, boundary = "voice-test-boundary") {
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.from(
      `--${boundary}\r\n` +
      "Content-Disposition: form-data; name=\"sdp\"\r\n" +
      "Content-Type: application/sdp\r\n\r\n" +
      `${sdp}\r\n` +
      `--${boundary}\r\n` +
      "Content-Disposition: form-data; name=\"session\"\r\n" +
      "Content-Type: application/json\r\n\r\n" +
      `${JSON.stringify(session)}\r\n` +
      `--${boundary}--\r\n`
    )
  };
}

function createBaseDependencies(overrides = {}) {
  const accounts = [createAccount("voice-a")];

  return {
    loadConfig: () => ({
      version: 1,
      server: {
        host: "127.0.0.1",
        port: 4399,
        body_limit_mb: 512
      },
      upstream: {
        codex_base_url: "https://chatgpt.example.test/backend-api/codex",
        chatgpt_base_url: "https://chatgpt.example.test/backend-api",
        auth_base_url: "https://auth.example.test",
        oauth_client_id: "test-client"
      },
      accounts,
      relay_slots: []
    }),
    listCandidateAccounts: () => [],
    readAuthFile: (codexHome) => ({
      auth_mode: "chatgpt",
      tokens: {
        access_token: `token-for-${codexHome.split("/").at(-1)}`,
        refresh_token: "refresh-token",
        account_id: `account-for-${codexHome.split("/").at(-1)}`
      }
    }),
    sendCodexRequest: async () => createResponse(
      200,
      "v=answer\r\n",
      {
        "content-type": "application/sdp",
        location: "/v1/live/rtc_voice_test"
      }
    ),
    refreshAccountTokens: async () => ({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "refreshed-token",
        refresh_token: "refresh-token",
        account_id: "account-for-voice-a"
      }
    }),
    now: () => 123456789,
    ...overrides
  };
}

function createBindingStore() {
  return new VoiceCallBindingStore(
    15 * 60 * 1000,
    1024,
    () => 123456789
  );
}

test("Voice /v1/live 把公共 multipart 转成 backend JSON 并记录账号绑定", async () => {
  const sent = [];
  const store = createBindingStore();
  const service = createVoiceProxyService(
    store,
    createBaseDependencies({
      sendCodexRequest: async (options) => {
        sent.push(options);
        return createResponse(
          200,
          "v=answer\r\n",
          {
            "content-type": "application/sdp",
            "content-length": "10",
            location: "/v1/live/rtc_voice_test",
            "x-request-id": "request-voice"
          }
        );
      }
    })
  );
  const multipart = createMultipartBody(
    "v=offer\r\n",
    {
      id: "session-local-only",
      model: "gpt-realtime",
      delegation: { type: "client" }
    }
  );

  const result = await service.proxyVoiceCall({
    method: "POST",
    url: "/v1/live",
    headers: {
      "content-type": multipart.contentType,
      "user-agent": "codex-cli/0.146.0"
    },
    body: multipart.body
  });

  assert.equal(result.type, "proxy");
  assert.equal(result.headers.location, "/v1/live/rtc_voice_test");
  assert.equal(result.headers["content-length"], "10");
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].pathWithQuery,
    "/realtime/calls?intent=quicksilver&architecture=avas"
  );
  assert.equal(sent[0].requestHeaders["content-type"], "application/json");
  assert.equal(sent[0].requestHeaders["user-agent"], "codex-cli/0.146.0");
  assert.deepEqual(JSON.parse(sent[0].body.toString("utf8")), {
    sdp: "v=offer\r\n",
    session: {
      model: "gpt-realtime",
      delegation: { type: "client" }
    }
  });
  assert.deepEqual(store.get("rtc_voice_test"), {
    callId: "rtc_voice_test",
    accountId: "voice-a",
    codexHome: "/tmp/voice-a",
    createdAt: 123456789
  });
});

test("Voice 即使普通 Codex 调度器没有候选，也会尝试已启用登录账号", async () => {
  const attempts = [];
  const store = createBindingStore();
  const service = createVoiceProxyService(
    store,
    createBaseDependencies({
      listCandidateAccounts: () => [],
      sendCodexRequest: async (options) => {
        attempts.push(options.accessToken);
        return createResponse(
          200,
          "v=answer\r\n",
          { location: "/v1/live/rtc_voice_fallback" }
        );
      }
    })
  );
  const multipart = createMultipartBody("v=offer\r\n", { model: "gpt-realtime" });

  const result = await service.proxyVoiceCall({
    method: "POST",
    url: "/v1/live",
    headers: { "content-type": multipart.contentType },
    body: multipart.body
  });

  assert.equal(result.type, "proxy");
  assert.deepEqual(attempts, ["token-for-voice-a"]);
  assert.equal(store.get("rtc_voice_fallback").accountId, "voice-a");
});

test("Voice call 创建遇到 401 时刷新同一账号 token 后重试", async () => {
  const tokens = [];
  let currentToken = "expired-token";
  const store = createBindingStore();
  const service = createVoiceProxyService(
    store,
    createBaseDependencies({
      readAuthFile: () => ({
        auth_mode: "chatgpt",
        tokens: {
          access_token: currentToken,
          refresh_token: "refresh-token",
          account_id: "account-for-voice-a"
        }
      }),
      refreshAccountTokens: async () => {
        currentToken = "refreshed-token";
        return {
          auth_mode: "chatgpt",
          tokens: {
            access_token: currentToken,
            refresh_token: "refresh-token",
            account_id: "account-for-voice-a"
          }
        };
      },
      sendCodexRequest: async (options) => {
        tokens.push(options.accessToken);
        return tokens.length === 1
          ? createResponse(401, "expired")
          : createResponse(
              200,
              "v=answer\r\n",
              { location: "/v1/live/rtc_voice_refreshed" }
            );
      }
    })
  );
  const multipart = createMultipartBody("v=offer\r\n", { model: "gpt-realtime" });

  const result = await service.proxyVoiceCall({
    method: "POST",
    url: "/v1/live",
    headers: { "content-type": multipart.contentType },
    body: multipart.body
  });

  assert.equal(result.type, "proxy");
  assert.deepEqual(tokens, ["expired-token", "refreshed-token"]);
  assert.equal(store.get("rtc_voice_refreshed").accountId, "voice-a");
});

test("Voice call 创建在账号受限时切换到下一个已启用账号", async () => {
  const accounts = [createAccount("voice-a"), createAccount("voice-b")];
  const attempts = [];
  const store = createBindingStore();
  const service = createVoiceProxyService(
    store,
    createBaseDependencies({
      loadConfig: () => ({
        ...createBaseDependencies().loadConfig(),
        accounts
      }),
      sendCodexRequest: async (options) => {
        attempts.push(options.accessToken);
        return attempts.length === 1
          ? createResponse(429, "voice limited")
          : createResponse(
              200,
              "v=answer\r\n",
              { location: "/v1/live/rtc_voice_second" }
            );
      }
    })
  );
  const multipart = createMultipartBody("v=offer\r\n", { model: "gpt-realtime" });

  const result = await service.proxyVoiceCall({
    method: "POST",
    url: "/v1/live",
    headers: { "content-type": multipart.contentType },
    body: multipart.body
  });

  assert.equal(result.type, "proxy");
  assert.deepEqual(attempts, ["token-for-voice-a", "token-for-voice-b"]);
  assert.equal(store.get("rtc_voice_second").accountId, "voice-b");
});

test("Voice 兼容旧版 application/sdp /v1/realtime/calls", async () => {
  const sent = [];
  const store = createBindingStore();
  const service = createVoiceProxyService(
    store,
    createBaseDependencies({
      sendCodexRequest: async (options) => {
        sent.push(options);
        return createResponse(
          200,
          "v=answer\r\n",
          { location: "/v1/realtime/calls/rtc_voice_legacy" }
        );
      }
    })
  );

  const result = await service.proxyVoiceCall({
    method: "POST",
    url: "/v1/realtime/calls",
    headers: { "content-type": "application/sdp" },
    body: Buffer.from("v=offer\r\n")
  });

  assert.equal(result.type, "proxy");
  assert.equal(sent[0].pathWithQuery, "/realtime/calls");
  assert.equal(sent[0].body.toString("utf8"), "v=offer\r\n");
  assert.equal(store.get("rtc_voice_legacy").accountId, "voice-a");
});

test("Voice 上游缺少 Location 时返回 502 且不创建绑定", async () => {
  const store = createBindingStore();
  const service = createVoiceProxyService(
    store,
    createBaseDependencies({
      sendCodexRequest: async () => createResponse(200, "v=answer\r\n")
    })
  );
  const multipart = createMultipartBody("v=offer\r\n", { model: "gpt-realtime" });

  const result = await service.proxyVoiceCall({
    method: "POST",
    url: "/v1/live",
    headers: { "content-type": multipart.contentType },
    body: multipart.body
  });

  assert.equal(result.type, "send");
  assert.equal(result.statusCode, 502);
  assert.equal(result.payload.error.type, "voice_call_location_missing");
  assert.equal(store.size(), 0);
});

test("Voice multipart 非法时在请求上游前返回 400", async () => {
  let attempts = 0;
  const store = createBindingStore();
  const service = createVoiceProxyService(
    store,
    createBaseDependencies({
      sendCodexRequest: async () => {
        attempts += 1;
        return createResponse(200, "unexpected");
      }
    })
  );

  const result = await service.proxyVoiceCall({
    method: "POST",
    url: "/v1/live",
    headers: {
      "content-type": "multipart/form-data; boundary=missing-fields"
    },
    body: Buffer.from("--missing-fields--\r\n")
  });

  assert.equal(result.type, "send");
  assert.equal(result.statusCode, 400);
  assert.equal(result.payload.error.type, "invalid_voice_call_request");
  assert.equal(attempts, 0);
});

test("Voice call 绑定按 TTL 过期并限制最大数量", () => {
  let now = 1000;
  const store = new VoiceCallBindingStore(100, 2, () => now);

  store.remember({
    callId: "rtc_first",
    accountId: "voice-a",
    codexHome: "/tmp/voice-a",
    createdAt: now
  });
  now += 1;
  store.remember({
    callId: "rtc_second",
    accountId: "voice-a",
    codexHome: "/tmp/voice-a",
    createdAt: now
  });
  now += 1;
  store.remember({
    callId: "rtc_third",
    accountId: "voice-a",
    codexHome: "/tmp/voice-a",
    createdAt: now
  });

  assert.equal(store.get("rtc_first"), null);
  assert.equal(store.size(), 2);

  now += 100;
  assert.equal(store.get("rtc_second"), null);
  assert.equal(store.get("rtc_third"), null);
});
