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

function createBaseDependencies(overrides = {}) {
  return {
    loadConfig: () => ({
      version: 1,
      server: {
        host: "127.0.0.1",
        port: 4399,
        api_key: "test-key",
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
    sendCodexResponsesRequest: async () => createResponse(200, "ok"),
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

test("proxy retry service 在 401 后刷新 token 并重试成功", async () => {
  const sentTokens = [];
  const recorded = [];
  const service = createProxyRetryService(
    createBaseDependencies({
      sendCodexResponsesRequest: async (options) => {
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
