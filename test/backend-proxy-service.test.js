const assert = require("node:assert/strict");
const test = require("node:test");

const { createBackendProxyService } = require("../dist/backend-proxy-service.js");

function createCandidate(id) {
  return {
    account: {
      id,
      name: id,
      codex_home: `/tmp/${id}`,
      enabled: true
    },
    status: {
      id,
      name: id,
      enabled: true,
      exists: true,
      plan: "plus",
      fiveHourLeftPercent: 50,
      fiveHourResetsAt: null,
      weeklyLeftPercent: 50,
      weeklyResetsAt: null,
      isFiveHourLimited: false,
      isWeeklyLimited: false,
      isAvailable: true,
      sourcePath: `/tmp/${id}`
    },
    reason: "test"
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

function createBaseDependencies(overrides = {}) {
  return {
    loadConfig: () => ({
      version: 1,
      server: {
        host: "127.0.0.1",
        port: 4399,
        body_limit_mb: 512
      },
      upstream: {
        codex_base_url: "https://example.test/backend-api/codex",
        chatgpt_base_url: "https://example.test/backend-api",
        auth_base_url: "https://auth.example.test",
        oauth_client_id: "test-client"
      },
      accounts: []
    }),
    listCandidateAccounts: () => [createCandidate("slot-a")],
    readAuthFile: () => ({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "old-access",
        refresh_token: "refresh-token",
        account_id: "account-id"
      }
    }),
    sendChatGptBackendRequest: async () => createResponse(200, "ok"),
    refreshAccountTokens: async () => ({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "new-access",
        refresh_token: "refresh-token",
        account_id: "account-id"
      }
    }),
    setAccountBlock: () => {},
    recordAccountScheduleSuccess: () => {},
    ...overrides
  };
}

test("backend proxy 透传 backend 路由，并保留 query 透传给上游", async () => {
  const sent = [];
  const recorded = [];
  const service = createBackendProxyService(
    createBaseDependencies({
      sendChatGptBackendRequest: async (options) => {
        sent.push(options);
        return createResponse(200, JSON.stringify({ allowed: true }), {
          "content-type": "application/json"
        });
      },
      recordAccountScheduleSuccess: (accountId) => recorded.push(accountId)
    })
  );

  const result = await service.proxyChatGptBackendWithRetry({
    method: "GET",
    url: "/backend-api/aura/site_status?site_url=https%3A%2F%2Flocal.aihelp.net%2Fdashboard%2F&url_request_source=codex_browser_use",
    headers: {
      authorization: "Bearer local-key"
    }
  });

  assert.equal(result.type, "proxy");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].accessToken, "old-access");
  assert.equal(sent[0].accountIdHeader, "account-id");
  assert.equal(sent[0].pathWithQuery, "/aura/site_status?site_url=https%3A%2F%2Flocal.aihelp.net%2Fdashboard%2F&url_request_source=codex_browser_use");
  assert.deepEqual(recorded, ["slot-a"]);
});

test("backend proxy 在 401 后刷新 token 并重试", async () => {
  const sentTokens = [];
  const service = createBackendProxyService(
    createBaseDependencies({
      sendChatGptBackendRequest: async (options) => {
        sentTokens.push(options.accessToken);
        return sentTokens.length === 1
          ? createResponse(401, "expired")
          : createResponse(200, "ok", { "content-type": "application/json" });
      }
    })
  );

  const result = await service.proxyChatGptBackendWithRetry({
    method: "GET",
    url: "/backend-api/aura/site_status?site_url=https%3A%2F%2Fexample.com",
    headers: {}
  });

  assert.equal(result.type, "proxy");
  assert.deepEqual(sentTokens, ["old-access", "new-access"]);
});

test("backend proxy 透传任意 backend 路由", async () => {
  const sent = [];
  const service = createBackendProxyService(
    createBaseDependencies({
      sendChatGptBackendRequest: async (options) => {
        sent.push(options);
        return createResponse(200, JSON.stringify({ user: true }), {
          "content-type": "application/json"
        });
      }
    })
  );

  const result = await service.proxyChatGptBackendWithRetry({
    method: "GET",
    url: "/backend-api/me",
    headers: {}
  });

  assert.equal(result.type, "proxy");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pathWithQuery, "/me");
});

test("backend proxy 透传非 GET 请求与请求体", async () => {
  const sent = [];
  const body = Buffer.from(JSON.stringify({ value: 1 }));
  const service = createBackendProxyService(
    createBaseDependencies({
      sendChatGptBackendRequest: async (options) => {
        sent.push(options);
        return createResponse(200, JSON.stringify({ ok: true }), {
          "content-type": "application/json"
        });
      }
    })
  );

  const result = await service.proxyChatGptBackendWithRetry({
    method: "POST",
    url: "/backend-api/custom/action?debug=1",
    headers: {
      "content-type": "application/json"
    },
    body
  });

  assert.equal(result.type, "proxy");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].pathWithQuery, "/custom/action?debug=1");
  assert.equal(sent[0].body, body);
});

test("backend proxy 拒绝非 backend-api 代理路径", async () => {
  const service = createBackendProxyService(createBaseDependencies());

  const result = await service.proxyChatGptBackendWithRetry({
    method: "GET",
    url: "/not-backend-api/me",
    headers: {}
  });

  assert.equal(result.type, "send");
  assert.equal(result.statusCode, 404);
  assert.equal(result.payload.error.type, "unsupported_backend_proxy_path");
});
