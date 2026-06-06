const assert = require("node:assert/strict");
const test = require("node:test");

const { createModelProxyDispatcher } = require("../dist/model-proxy-dispatcher.js");

function createProxyResult(source) {
  const body = (async function* stream() {
    yield Buffer.from(source);
  })();

  return {
    type: "proxy",
    statusCode: 200,
    headers: {
      "content-type": "application/json"
    },
    body
  };
}

test("model dispatcher 默认 auth_pool 时走官方账号代理", async () => {
  const calls = [];
  const dispatcher = createModelProxyDispatcher({
    getSelectedModelRoute: () => ({ mode: "auth_pool" }),
    findRelaySlot: () => null,
    proxyCodexWithRetry: async (request) => {
      calls.push(["auth", request.url]);
      return createProxyResult("auth");
    },
    proxyRelaySlot: async () => {
      calls.push(["relay"]);
      return createProxyResult("relay");
    }
  });

  const result = await dispatcher.proxyModelWithRoute({
    method: "GET",
    url: "/v1/models",
    headers: {}
  });

  assert.equal(result.type, "proxy");
  assert.deepEqual(calls, [["auth", "/v1/models"]]);
});

test("model dispatcher 选择 relay_slot 后固定走 relay 且不调用官方账号代理", async () => {
  const calls = [];
  const dispatcher = createModelProxyDispatcher({
    getSelectedModelRoute: () => ({ mode: "relay_slot", relay_slot_id: "relay-a" }),
    findRelaySlot: () => ({
      id: "relay-a",
      name: "relay-a",
      base_url: "https://relay.example.com/v1",
      api_key: "relay-key",
      enabled: true
    }),
    proxyCodexWithRetry: async () => {
      calls.push(["auth"]);
      return createProxyResult("auth");
    },
    proxyRelaySlot: async ({ slot, request }) => {
      calls.push(["relay", slot.id, request.url]);
      return {
        type: "send",
        statusCode: 429,
        payload: {
          error: "limited"
        }
      };
    }
  });

  const result = await dispatcher.proxyModelWithRoute({
    method: "POST",
    url: "/v1/responses",
    headers: {},
    body: Buffer.from("{}")
  });

  assert.equal(result.type, "send");
  assert.equal(result.statusCode, 429);
  assert.deepEqual(calls, [["relay", "relay-a", "/v1/responses"]]);
});
