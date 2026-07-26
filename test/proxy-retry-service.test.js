const assert = require("node:assert/strict");
const test = require("node:test");

const { createProxyRetryService } = require("../dist/proxy-retry-service.js");

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

async function readProxyBody(result) {
  let text = "";
  for await (const chunk of result.body) {
    text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  }
  return text;
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
    sendCodexRequest: async () => createResponse(200, "ok"),
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
    getCachedCodexClientVersion: () => null,
    setCachedCodexClientVersion: () => {},
    ...overrides
  };
}

test("proxy retry service 在 401 后刷新 token 并重试成功", async () => {
  const sentTokens = [];
  const recorded = [];
  const service = createProxyRetryService(
    createBaseDependencies({
      sendCodexRequest: async (options) => {
        sentTokens.push(options.accessToken);
        return sentTokens.length === 1
          ? createResponse(401, "expired")
          : createResponse(200, "ok", { "content-type": "application/json" });
      },
      recordAccountScheduleSuccess: (accountId) => recorded.push(accountId)
    })
  );

  const result = await service.proxyResponsesWithRetry({}, Buffer.from("{}"));

  assert.equal(result.type, "proxy");
  assert.deepEqual(sentTokens, ["old-access", "new-access"]);
  assert.deepEqual(recorded, ["slot-a"]);
});

test("proxy retry service 刷新后仍为 401 时熔断当前账号并切换下一账号", async () => {
  const sent = [];
  const blocked = [];
  const recorded = [];
  const service = createProxyRetryService(
    createBaseDependencies({
      listCandidateAccounts: () => [
        createCandidate("slot-a"),
        createCandidate("slot-b")
      ],
      sendCodexRequest: async (options) => {
        sent.push({
          token: options.accessToken,
          accountId: options.accountIdHeader
        });
        return options.accountIdHeader === "slot-b-account"
          ? createResponse(200, "ok", { "content-type": "application/json" })
          : createResponse(401, "unauthorized");
      },
      readAuthFile: (codexHome) => {
        const accountId = codexHome.endsWith("slot-b")
          ? "slot-b-account"
          : "slot-a-account";
        return {
          auth_mode: "chatgpt",
          tokens: {
            access_token: `old-${accountId}`,
            refresh_token: `refresh-${accountId}`,
            account_id: accountId
          }
        };
      },
      refreshAccountTokens: async (accountId) => ({
        auth_mode: "chatgpt",
        tokens: {
          access_token: `new-${accountId}`,
          refresh_token: `refresh-${accountId}`,
          account_id: `${accountId}-account`
        }
      }),
      setAccountBlock: (accountId, _until, reason) => {
        blocked.push({ accountId, reason });
      },
      recordAccountScheduleSuccess: (accountId) => recorded.push(accountId)
    })
  );

  const result = await service.proxyResponsesWithRetry({}, Buffer.from("{}"));

  assert.equal(result.type, "proxy");
  assert.deepEqual(
    sent.map((item) => item.token),
    ["old-slot-a-account", "new-slot-a", "old-slot-b-account"]
  );
  assert.deepEqual(blocked, [
    {
      accountId: "slot-a",
      reason: "invalid_account_auth"
    }
  ]);
  assert.deepEqual(recorded, ["slot-b"]);
});

test("proxy retry service 在没有候选账号时返回明确错误", async () => {
  const service = createProxyRetryService(
    createBaseDependencies({
      listCandidateAccounts: () => []
    })
  );

  const result = await service.proxyResponsesWithRetry({}, Buffer.from("{}"));

  assert.equal(result.type, "send");
  assert.equal(result.statusCode, 503);
  assert.equal(result.payload.error.type, "no_available_account");
});

test("proxy retry service 支持转发通用 /v1/models 路径", async () => {
  const seen = [];
  const service = createProxyRetryService(
    createBaseDependencies({
      sendCodexRequest: async (options) => {
        seen.push({
          method: options.method,
          pathWithQuery: options.pathWithQuery
        });
        return createResponse(200, '{"models":[]}', { "content-type": "application/json" });
      }
    })
  );

  const result = await service.proxyCodexWithRetry({
    method: "GET",
    url: "/v1/models?client_version=0.130.0",
    headers: {}
  });

  assert.equal(result.type, "proxy");
  assert.deepEqual(seen, [
    {
      method: "GET",
      pathWithQuery: "/models?client_version=0.130.0"
    }
  ]);
});

test("proxy retry service 为裸 /v1/models 使用缓存的 Codex client_version 并返回 OpenAI-compatible 列表", async () => {
  const seen = [];
  const service = createProxyRetryService(
    createBaseDependencies({
      getCachedCodexClientVersion: () => "0.142.5",
      sendCodexRequest: async (options) => {
        seen.push({
          method: options.method,
          pathWithQuery: options.pathWithQuery,
          acceptEncoding: options.requestHeaders["accept-encoding"]
        });
        return createResponse(
          200,
          JSON.stringify({
            models: [
              {
                slug: "gpt-5.5",
                display_name: "GPT-5.5",
                visibility: "list",
                supported_in_api: true
              },
              {
                slug: "gpt-5.3-codex-spark",
                display_name: "GPT-5.3-Codex-Spark",
                visibility: "list",
                supported_in_api: false
              },
              {
                slug: "codex-auto-review",
                display_name: "Codex Auto Review",
                visibility: "hide",
                supported_in_api: true
              }
            ]
          }),
          { "content-type": "application/json" }
        );
      }
    })
  );

  const result = await service.proxyCodexWithRetry({
    method: "GET",
    url: "/v1/models",
    headers: {
      "accept-encoding": "gzip, br"
    }
  });

  assert.equal(result.type, "send");
  assert.equal(result.statusCode, 200);
  assert.deepEqual(seen, [
    {
      method: "GET",
      pathWithQuery: "/models?client_version=0.142.5",
      acceptEncoding: undefined
    }
  ]);
  assert.deepEqual(result.payload, {
    object: "list",
    data: [
      {
        id: "gpt-5.5",
        object: "model",
        created: 0,
        owned_by: "openai"
      },
      {
        id: "gpt-5.3-codex-spark",
        object: "model",
        created: 0,
        owned_by: "openai"
      }
    ]
  });
});

test("proxy retry service 在缓存缺失时使用内置兜底 Codex client_version，成功后写入缓存", async () => {
  const cached = [];
  const service = createProxyRetryService(
    createBaseDependencies({
      getCachedCodexClientVersion: () => null,
      setCachedCodexClientVersion: (version, source) => cached.push({ version, source }),
      sendCodexRequest: async (options) => {
        assert.equal(options.pathWithQuery, "/models?client_version=0.142.5");
        return createResponse(200, '{"models":[]}', { "content-type": "application/json" });
      }
    })
  );

  const result = await service.proxyCodexWithRetry({
    method: "GET",
    url: "/v1/models",
    headers: {}
  });

  assert.equal(result.type, "send");
  assert.equal(result.statusCode, 200);
  assert.deepEqual(cached, [
    {
      version: "0.142.5",
      source: "fallback"
    }
  ]);
});

test("proxy retry service 记录显式 client_version 成功请求但保持 Codex 原始 models 响应", async () => {
  const cached = [];
  const service = createProxyRetryService(
    createBaseDependencies({
      setCachedCodexClientVersion: (version, source) => cached.push({ version, source }),
      sendCodexRequest: async (options) => {
        assert.equal(options.pathWithQuery, "/models?client_version=0.150.0");
        return createResponse(200, '{"models":[{"slug":"gpt-5.5"}]}', { "content-type": "application/json" });
      }
    })
  );

  const result = await service.proxyCodexWithRetry({
    method: "GET",
    url: "/v1/models?client_version=0.150.0",
    headers: {}
  });

  assert.equal(result.type, "proxy");
  assert.equal(result.statusCode, 200);
  assert.equal(await readProxyBody(result), '{"models":[{"slug":"gpt-5.5"}]}');
  assert.deepEqual(cached, [
    {
      version: "0.150.0",
      source: "request"
    }
  ]);
});
