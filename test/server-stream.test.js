const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { streamProxyResponse } = require("../dist/server.js");

/**
 * 构造一个最小可用的 fake reply.raw：真实场景下它是 Node 的
 * http.ServerResponse（一个 EventEmitter）。若 streamProxyResponse 没有监听
 * "error" 事件，emit("error", ...) 在没有监听者时会同步抛出，从而杀死整个
 * 进程；这里用它来确定性地复现并验证修复。
 */
function createFakeReply({ onWrite } = {}) {
  const raw = new EventEmitter();
  raw.destroyed = false;
  raw.writeHead = () => {};
  raw.write = (chunk) => {
    onWrite?.(chunk, raw);
    return true;
  };
  raw.end = () => {};
  raw.destroy = (error) => {
    raw.destroyed = true;
    raw.destroyError = error;
  };

  return {
    raw,
    hijack: () => {},
    code: () => ({ send: () => {}, header: () => {} }),
    send: () => {},
    header: () => {},
    hijacked: false
  };
}

async function* chunksThenNeverEnd() {
  yield Buffer.from("chunk-1");
  // 模拟下游 socket 在客户端断开后仍持续收到上游数据的场景：
  // 只要 write 之后触发了 socket "error"，循环应尽快停止，不再继续写入。
  for (let index = 0; index < 50; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    yield Buffer.from(`chunk-${index + 2}`);
  }
}

test("下游 socket 触发 error 事件时不会抛出未捕获异常", async () => {
  let errorEmitted = false;
  const reply = createFakeReply({
    onWrite: (_chunk, raw) => {
      if (!errorEmitted) {
        errorEmitted = true;
        setImmediate(() => raw.emit("error", new Error("simulated socket error")));
      }
    }
  });

  // 若 streamProxyResponse 未监听 raw 的 "error" 事件，这里的 emit 会
  // 同步抛出且无法被 await 捕获，Node 测试进程会直接崩溃退出。
  await streamProxyResponse(reply, {
    statusCode: 200,
    headers: { "content-type": "text/event-stream" },
    body: chunksThenNeverEnd()
  });

  assert.equal(errorEmitted, true);
});
