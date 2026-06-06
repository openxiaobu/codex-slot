const assert = require("node:assert/strict");
const test = require("node:test");

const { createRelayProxyService } = require("../dist/relay-proxy-service.js");

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

test("relay proxy 使用 relay slot 的 base_url 与 api_key 转发 /v1 请求", async () => {
  const sent = [];
  const service = createRelayProxyService({
    sendRelayRequest: async (options) => {
      sent.push(options);
      return createResponse(200, JSON.stringify({ data: [] }), {
        "content-type": "application/json"
      });
    }
  });

  const result = await service.proxyRelaySlot({
    slot: {
      id: "relay-a",
      name: "relay-a",
      base_url: "https://relay.example.com/v1",
      api_key: "relay-key",
      enabled: true
    },
    request: {
      method: "GET",
      url: "/v1/models?client=codex",
      headers: {
        authorization: "Bearer local-token",
        "x-client": "codex"
      }
    }
  });

  assert.equal(result.type, "proxy");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].baseUrl, "https://relay.example.com/v1");
  assert.equal(sent[0].pathWithQuery, "/models?client=codex");
  assert.equal(sent[0].headers.authorization, "Bearer relay-key");
  assert.equal(sent[0].headers["x-client"], "codex");
});

test("relay proxy 返回上游错误且不执行任何账号回退", async () => {
  let attempts = 0;
  const service = createRelayProxyService({
    sendRelayRequest: async () => {
      attempts += 1;
      return createResponse(429, JSON.stringify({ error: "limited" }), {
        "content-type": "application/json"
      });
    }
  });

  const result = await service.proxyRelaySlot({
    slot: {
      id: "relay-a",
      name: "relay-a",
      base_url: "https://relay.example.com/v1",
      api_key: "relay-key",
      enabled: true
    },
    request: {
      method: "POST",
      url: "/v1/responses",
      headers: {},
      body: Buffer.from("{}")
    }
  });

  assert.equal(result.type, "proxy");
  assert.equal(result.statusCode, 429);
  assert.equal(attempts, 1);
});

test("relay proxy 网络异常时返回明确错误", async () => {
  const service = createRelayProxyService({
    sendRelayRequest: async () => {
      throw new Error("connect ECONNREFUSED");
    }
  });

  const result = await service.proxyRelaySlot({
    slot: {
      id: "relay-a",
      name: "relay-a",
      base_url: "https://relay.example.com/v1",
      api_key: "relay-key",
      enabled: true
    },
    request: {
      method: "GET",
      url: "/v1/models",
      headers: {}
    }
  });

  assert.equal(result.type, "send");
  assert.equal(result.statusCode, 502);
  assert.equal(result.payload.error.type, "relay_request_failed");
  assert.match(result.payload.error.message, /ECONNREFUSED/);
});
