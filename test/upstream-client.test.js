const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildChatGptBackendHeaders,
  buildUpstreamHeaders
} = require("../dist/upstream-client.js");

test("Codex 上游请求保留客户端 User-Agent 并替换本地鉴权", () => {
  const headers = buildUpstreamHeaders(
    {
      authorization: "Bearer local-token",
      "user-agent": "codex-cli/0.146.0",
      "x-session-id": "session-voice"
    },
    "official-token",
    12,
    "account-id"
  );

  assert.equal(headers.authorization, "Bearer official-token");
  assert.equal(headers["user-agent"], "codex-cli/0.146.0");
  assert.equal(headers["x-session-id"], "session-voice");
  assert.equal(headers["chatgpt-account-id"], "account-id");
  assert.equal(headers["content-length"], "12");
});

test("Codex 与 backend 请求缺少 User-Agent 时使用 cslot 兜底值", () => {
  assert.equal(
    buildUpstreamHeaders({}, "official-token")["user-agent"],
    "codex-slot/0.1.1"
  );
  assert.equal(
    buildChatGptBackendHeaders({}, "official-token")["user-agent"],
    "codex-slot/0.1.1"
  );
});
