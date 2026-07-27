import type { IncomingHttpHeaders, IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, {
  WebSocketServer,
  type RawData
} from "ws";
import { readAuthFile } from "./account-store";
import { loadConfig } from "./config";
import { refreshAccountTokens } from "./usage-sync";
import type { CodexAuthFile, CslotConfig } from "./types";
import {
  VoiceCallBindingStore,
  type VoiceCallBinding
} from "./voice-call-binding-store";

interface VoiceWebSocketProxyDependencies {
  loadConfig: () => CslotConfig;
  readAuthFile: (codexHome: string) => CodexAuthFile | null;
  refreshAccountTokens: typeof refreshAccountTokens;
}

interface VoiceWebSocketRoute {
  callId: string;
  mode: "frameless" | "legacy";
  query: URLSearchParams;
}

interface BufferedWebSocketMessage {
  data: RawData;
  isBinary: boolean;
}

interface BufferedUpstreamSocket {
  socket: WebSocket;
  pendingMessages: BufferedWebSocketMessage[];
  stopBuffering: () => void;
}

const CHATGPT_CODEX_UPSTREAM_ORIGIN = "https://chatgpt.com";
const CHATGPT_CODEX_UPSTREAM_PATH = "/backend-api/codex";
const OPENAI_REALTIME_SIDEBAND_BASE_URL = "https://api.openai.com/v1";

export interface VoiceWebSocketProxy {
  /**
   * 停止接收新的 Voice upgrade，并终止当前代理持有的 WebSocket。
   *
   * @returns 无返回值。
   * @throws 无显式抛出。
   */
  close: () => void;
}

/**
 * 表示上游 WebSocket 握手失败，并携带可选 HTTP 状态码。
 */
class VoiceWebSocketConnectError extends Error {
  /**
   * 创建上游 WebSocket 握手错误。
   *
   * @param message 错误说明。
   * @param statusCode 上游拒绝握手时返回的 HTTP 状态码。
   */
  constructor(
    message: string,
    readonly statusCode?: number
  ) {
    super(message);
    this.name = "VoiceWebSocketConnectError";
  }
}

/**
 * 判断字符串是否为 Codex 官方可识别的 Voice call id。
 *
 * @param callId 待校验的 URL path 或 query 值。
 * @returns `rtc_` 前缀或 UUID 形态时返回 `true`。
 * @throws 无显式抛出。
 */
function isVoiceCallId(callId: string): boolean {
  return (
    /^rtc_[A-Za-z0-9._~-]+$/.test(callId) ||
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(callId)
  );
}

/**
 * 判断 upgrade URL 是否明确指向 cslot 的 Voice 路由空间。
 *
 * @param requestUrl Node upgrade 请求 URL。
 * @returns Voice path 返回 `true`，其他潜在 WebSocket 使用方返回 `false`。
 * @throws 无显式抛出；非法 URL 返回 `false`。
 */
function isVoiceWebSocketPath(requestUrl: string | undefined): boolean {
  if (!requestUrl) {
    return false;
  }

  try {
    const pathname = new URL(requestUrl, "http://127.0.0.1").pathname;
    return (
      pathname === "/v1/live" ||
      pathname.startsWith("/v1/live/") ||
      pathname === "/v1/realtime" ||
      pathname.startsWith("/backend-api/codex/")
    );
  } catch {
    return false;
  }
}

/**
 * 识别 Codex Voice sideband WebSocket 的当前与兼容 URL 形态。
 *
 * @param requestUrl Node upgrade 请求 URL。
 * @returns call id、协议模式与 query；不属于 Voice upgrade 时返回 `null`。
 * @throws 无显式抛出；非法 URL 或 call id 统一返回 `null`。
 */
function resolveVoiceWebSocketRoute(
  requestUrl: string | undefined
): VoiceWebSocketRoute | null {
  if (!requestUrl) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(requestUrl, "http://127.0.0.1");
  } catch {
    return null;
  }

  if (url.pathname.startsWith("/v1/live/")) {
    const encodedCallId = url.pathname.slice("/v1/live/".length);

    try {
      const callId = decodeURIComponent(encodedCallId);
      if (!encodedCallId.includes("/") && isVoiceCallId(callId)) {
        return {
          callId,
          mode: "frameless",
          query: new URLSearchParams(url.search)
        };
      }
    } catch {
      return null;
    }
  }

  if (url.pathname === "/v1/realtime") {
    const callId = url.searchParams.get("call_id");
    if (callId && isVoiceCallId(callId)) {
      return {
        callId,
        mode: "legacy",
        query: new URLSearchParams(url.search)
      };
    }
  }

  if (url.pathname.startsWith("/backend-api/codex/")) {
    const encodedCallId = url.pathname.slice("/backend-api/codex/".length);

    try {
      const callId = decodeURIComponent(encodedCallId);
      if (!encodedCallId.includes("/") && isVoiceCallId(callId)) {
        return {
          callId,
          mode: "frameless",
          query: new URLSearchParams(url.search)
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * 将 Voice HTTP call base URL 转换成绑定 call id 的上游 sideband URL。
 *
 * 业务含义：
 * 1. ChatGPT 登录态通过 `/backend-api/codex/realtime/calls` 创建 WebRTC call。
 * 2. 官方 Codex 随后使用 `api.openai.com/v1` 的 WebSocket transceiver 加入同一个 call，
 *    不能把 sideband 继续连接到 ChatGPT backend，否则上游会拒绝握手。
 * 3. 自定义或测试 upstream 保留原有同源拼接行为。
 *
 * @param codexBaseUrl 配置中的 ChatGPT Codex backend base URL。
 * @param route 本地 Voice WebSocket 路由。
 * @returns `ws:` 或 `wss:` 上游 URL。
 * @throws 当 base URL 非法或协议不受支持时抛出错误。
 */
export function buildUpstreamVoiceWebSocketUrl(
  codexBaseUrl: string,
  route: VoiceWebSocketRoute
): string {
  const configuredUrl = new URL(codexBaseUrl);
  const usesChatGptCallBackend =
    configuredUrl.origin === CHATGPT_CODEX_UPSTREAM_ORIGIN &&
    configuredUrl.pathname.replace(/\/+$/, "") === CHATGPT_CODEX_UPSTREAM_PATH;
  const url = usesChatGptCallBackend
    ? new URL(OPENAI_REALTIME_SIDEBAND_BASE_URL)
    : configuredUrl;

  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Unsupported Voice upstream protocol: ${url.protocol}`);
  }

  if (route.mode === "frameless") {
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = usesChatGptCallBackend
      ? `${basePath}/live/${encodeURIComponent(route.callId)}`
      : `${basePath}/${encodeURIComponent(route.callId)}`;
    for (const [name, value] of route.query) {
      if (name !== "call_id") {
        url.searchParams.append(name, value);
      }
    }
  } else {
    if (usesChatGptCallBackend) {
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime`;
    }
    for (const [name, value] of route.query) {
      if (name !== "call_id" && name !== "intent") {
        url.searchParams.append(name, value);
      }
    }
    const intent = route.query.get("intent");
    if (intent) {
      url.searchParams.set("intent", intent);
    }
    url.searchParams.set("call_id", route.callId);
  }

  return url.toString();
}

/**
 * 构造上游 Voice WebSocket 握手头。
 *
 * @param requestHeaders Codex App 发给本地 sideband 的原始握手头。
 * @param callHeaders 创建当前 call 时固定的会话安全头。
 * @param accessToken call 绑定账号的当前 access token。
 * @param accountIdHeader 可选 ChatGPT account id。
 * @returns 可交给 `ws` 客户端的安全握手头。
 * @throws 无显式抛出。
 */
function buildVoiceWebSocketHeaders(
  requestHeaders: IncomingHttpHeaders,
  callHeaders: Record<string, string> | undefined,
  accessToken: string,
  accountIdHeader?: string
): Record<string, string> {
  const hopByHopHeaders = new Set([
    "authorization",
    "chatgpt-account-id",
    "connection",
    "content-length",
    "expect",
    "host",
    "sec-websocket-accept",
    "sec-websocket-extensions",
    "sec-websocket-key",
    "sec-websocket-protocol",
    "sec-websocket-version",
    "upgrade"
  ]);
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(requestHeaders)) {
    const normalizedName = name.toLowerCase();
    if (value == null || hopByHopHeaders.has(normalizedName)) {
      continue;
    }

    headers[normalizedName] = Array.isArray(value) ? value.join(", ") : value;
  }

  for (const [name, value] of Object.entries(callHeaders ?? {})) {
    headers[name.toLowerCase()] = value;
  }

  headers.authorization = `Bearer ${accessToken}`;
  if (!headers["user-agent"]) {
    headers["user-agent"] = "codex-slot/0.1.1";
  }
  if (accountIdHeader) {
    headers["chatgpt-account-id"] = accountIdHeader;
  }

  return headers;
}

/**
 * 解析客户端 WebSocket 子协议列表。
 *
 * @param header `Sec-WebSocket-Protocol` 原始头值。
 * @returns 去除空白和空项后的子协议数组。
 * @throws 无显式抛出。
 */
function resolveWebSocketProtocols(
  header: string | string[] | undefined
): string[] {
  const value = Array.isArray(header) ? header.join(",") : header;
  return value
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
}

/**
 * 创建单次上游 WebSocket 连接，并暂存本地握手完成前到达的消息。
 *
 * @param url 上游 sideband URL。
 * @param headers 已替换账号鉴权的握手头。
 * @param protocols 客户端声明的 WebSocket 子协议。
 * @returns 已完成握手的上游连接及其待转发消息。
 * @throws 上游网络错误或非 101 响应时抛出 `VoiceWebSocketConnectError`。
 */
async function connectUpstreamVoiceWebSocket(
  url: string,
  headers: Record<string, string>,
  protocols: string[]
): Promise<BufferedUpstreamSocket> {
  const socket = new WebSocket(
    url,
    protocols.length > 0 ? protocols : undefined,
    {
      headers,
      perMessageDeflate: false
    }
  );
  const pendingMessages: BufferedWebSocketMessage[] = [];

  /**
   * 在本地 WebSocket 完成 101 握手前缓存上游主动发送的 session 事件。
   *
   * @param data 上游消息载荷。
   * @param isBinary 是否为二进制消息。
   * @returns 无返回值。
   */
  const bufferMessage = (data: RawData, isBinary: boolean): void => {
    pendingMessages.push({ data, isBinary });
  };

  socket.on("message", bufferMessage);
  socket.on("error", () => {
    // 保留常驻 error listener，避免握手成功与双向桥接安装之间的极短窗口出现未捕获异常。
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    /**
     * 结束上游握手 Promise，并防止多个终态事件重复完成。
     *
     * @param error 可选握手错误；缺失时表示连接成功。
     * @returns 无返回值。
     */
    const settle = (error?: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (error) {
        socket.terminate();
        reject(error);
      } else {
        resolve();
      }
    };

    socket.once("open", () => settle());
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      settle(
        new VoiceWebSocketConnectError(
          `Voice upstream rejected WebSocket upgrade with ${response.statusCode}`,
          response.statusCode
        )
      );
    });
    socket.once("error", (error) => {
      settle(
        error instanceof Error
          ? error
          : new VoiceWebSocketConnectError(String(error))
      );
    });
  });

  return {
    socket,
    pendingMessages,
    stopBuffering: () => socket.off("message", bufferMessage)
  };
}

/**
 * 使用 call 绑定账号连接上游，401 时刷新 token 后仅重试一次握手。
 *
 * @param dependencies WebSocket 代理依赖。
 * @param binding HTTP call 创建阶段保存的账号绑定。
 * @param route 当前 sideband 路由。
 * @param requestHeaders 本地 WebSocket 握手头。
 * @param protocols 客户端子协议列表。
 * @returns 已连接并缓存早期消息的上游 WebSocket。
 * @throws 登录态缺失、刷新失败或上游握手失败时抛出错误。
 */
async function connectBoundVoiceWebSocket(
  dependencies: VoiceWebSocketProxyDependencies,
  binding: VoiceCallBinding,
  route: VoiceWebSocketRoute,
  requestHeaders: IncomingHttpHeaders,
  protocols: string[]
): Promise<BufferedUpstreamSocket> {
  const config = dependencies.loadConfig();
  const upstreamUrl = buildUpstreamVoiceWebSocketUrl(
    config.upstream.codex_base_url,
    route
  );
  let auth = dependencies.readAuthFile(binding.codexHome);
  let accessToken = auth?.tokens?.access_token;

  if (!accessToken) {
    throw new VoiceWebSocketConnectError(
      `Voice account ${binding.accountId} is missing access_token`
    );
  }

  try {
    return await connectUpstreamVoiceWebSocket(
      upstreamUrl,
      buildVoiceWebSocketHeaders(
        requestHeaders,
        binding.sidebandHeaders,
        accessToken,
        auth?.tokens?.account_id
      ),
      protocols
    );
  } catch (error) {
    if (
      !(error instanceof VoiceWebSocketConnectError) ||
      error.statusCode !== 401
    ) {
      throw error;
    }
  }

  const refreshed = await dependencies.refreshAccountTokens(binding.accountId);
  accessToken = refreshed.tokens?.access_token;
  auth = dependencies.readAuthFile(binding.codexHome) ?? refreshed;

  if (!accessToken) {
    throw new VoiceWebSocketConnectError(
      `Voice account ${binding.accountId} refresh returned no access_token`
    );
  }

  return await connectUpstreamVoiceWebSocket(
    upstreamUrl,
    buildVoiceWebSocketHeaders(
      requestHeaders,
      binding.sidebandHeaders,
      accessToken,
      auth?.tokens?.account_id
    ),
    protocols
  );
}

/**
 * 判断 close code 是否可以安全转发到另一端。
 *
 * @param code WebSocket close event 的状态码。
 * @returns 可用于 `WebSocket.close` 时返回原值，否则返回 1001。
 * @throws 无显式抛出。
 */
function normalizeCloseCode(code: number): number {
  if (
    code === 1000 ||
    (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
  ) {
    return code;
  }

  return 1001;
}

/**
 * 按 WebSocket 规范把 close reason 截断到最多 123 个 UTF-8 字节。
 *
 * @param reason close event 提供的原始 reason Buffer。
 * @returns 不会截断 Unicode 字符且可安全传给 `WebSocket.close` 的文本。
 * @throws 无显式抛出。
 */
function normalizeCloseReason(reason: Buffer): string {
  let normalized = "";

  for (const character of reason.toString("utf8")) {
    if (Buffer.byteLength(normalized + character, "utf8") > 123) {
      break;
    }

    normalized += character;
  }

  return normalized;
}

/**
 * 将一条消息转发到仍处于 OPEN 状态的目标 WebSocket。
 *
 * @param target 目标 WebSocket。
 * @param data 原始消息载荷。
 * @param isBinary 是否为二进制消息。
 * @returns 无返回值。
 * @throws 无显式抛出；异步发送错误会关闭目标连接。
 */
function forwardWebSocketMessage(
  target: WebSocket,
  data: RawData,
  isBinary: boolean
): void {
  if (target.readyState !== WebSocket.OPEN) {
    return;
  }

  target.send(data, { binary: isBinary }, (error) => {
    if (error && target.readyState === WebSocket.OPEN) {
      target.close(1011, "Voice proxy send failed");
    }
  });
}

/**
 * 在本地 Codex App 与 ChatGPT sideband 之间建立双向消息和关闭桥接。
 *
 * @param localSocket 已由本地 HTTP server 接受的 WebSocket。
 * @param upstream 已完成上游握手并缓存早期消息的连接。
 * @param callId 当前 Voice call id。
 * @param bindingStore call 级账号绑定存储。
 * @param upstreamSockets 当前代理持有的上游连接集合。
 * @returns 无返回值。
 * @throws 无显式抛出。
 */
function bridgeVoiceWebSockets(
  localSocket: WebSocket,
  upstream: BufferedUpstreamSocket,
  callId: string,
  bindingStore: VoiceCallBindingStore,
  upstreamSockets: Set<WebSocket>
): void {
  const upstreamSocket = upstream.socket;
  let finished = false;

  /**
   * 只执行一次会话清理，释放账号绑定与连接引用。
   *
   * @returns 无返回值。
   */
  const finish = (): void => {
    if (finished) {
      return;
    }

    finished = true;
    bindingStore.release(callId);
    upstreamSockets.delete(upstreamSocket);
  };

  upstream.stopBuffering();

  localSocket.on("message", (data, isBinary) => {
    forwardWebSocketMessage(upstreamSocket, data, isBinary);
  });
  upstreamSocket.on("message", (data, isBinary) => {
    forwardWebSocketMessage(localSocket, data, isBinary);
  });

  localSocket.on("close", (code, reason) => {
    finish();
    if (
      upstreamSocket.readyState === WebSocket.OPEN ||
      upstreamSocket.readyState === WebSocket.CONNECTING
    ) {
      upstreamSocket.close(
        normalizeCloseCode(code),
        normalizeCloseReason(reason)
      );
    }
  });
  upstreamSocket.on("close", (code, reason) => {
    finish();
    if (
      localSocket.readyState === WebSocket.OPEN ||
      localSocket.readyState === WebSocket.CONNECTING
    ) {
      localSocket.close(
        normalizeCloseCode(code),
        normalizeCloseReason(reason)
      );
    }
  });

  localSocket.on("error", () => {
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.close(1011, "Voice local socket failed");
    }
  });
  upstreamSocket.on("error", () => {
    if (localSocket.readyState === WebSocket.OPEN) {
      localSocket.close(1011, "Voice upstream socket failed");
    }
  });

  for (const message of upstream.pendingMessages) {
    forwardWebSocketMessage(localSocket, message.data, message.isBinary);
  }

  if (upstreamSocket.readyState === WebSocket.CLOSED) {
    localSocket.close(1011, "Voice upstream closed during setup");
  }
}

/**
 * 在 WebSocket 101 握手前向客户端返回结构化 HTTP 错误。
 *
 * @param socket 原始 upgrade TCP socket。
 * @param statusCode HTTP 错误状态码。
 * @param type 稳定错误类型。
 * @param message 错误说明。
 * @returns 无返回值。
 * @throws 无显式抛出；已销毁 socket 会被直接忽略。
 */
function writeUpgradeError(
  socket: Duplex,
  statusCode: number,
  type: string,
  message: string
): void {
  if (socket.destroyed) {
    return;
  }

  const payload = JSON.stringify({
    error: {
      message,
      type
    }
  });
  const statusText = statusCode === 404
    ? "Not Found"
    : statusCode === 400
      ? "Bad Request"
      : "Bad Gateway";

  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
    "Content-Type: application/json; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
    "Connection: close\r\n\r\n" +
    payload
  );
}

/**
 * 在 Node HTTP server 上注册 Codex Voice sideband upgrade 代理。
 *
 * @param server Fastify 使用的底层 HTTP server。
 * @param bindingStore 与 Voice HTTP call 服务共享的账号绑定存储。
 * @param overrides 可选依赖覆盖项，供自动化测试注入。
 * @returns 可在服务关闭时清理 listener 与连接的代理句柄。
 * @throws 无显式抛出；单次 upgrade 错误通过 HTTP 或 WebSocket close 返回。
 */
export function createVoiceWebSocketProxy(
  server: HttpServer,
  bindingStore: VoiceCallBindingStore,
  overrides?: Partial<VoiceWebSocketProxyDependencies>
): VoiceWebSocketProxy {
  const dependencies: VoiceWebSocketProxyDependencies = {
    loadConfig,
    readAuthFile,
    refreshAccountTokens,
    ...overrides
  };
  const selectedProtocols = new WeakMap<IncomingMessage, string>();
  const webSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (_protocols, request) => selectedProtocols.get(request) || false
  });
  const upstreamSockets = new Set<WebSocket>();

  /**
   * 处理单次 Voice upgrade：校验 call 绑定、连接上游并接受本地 WebSocket。
   *
   * @param request Node upgrade 请求。
   * @param socket 原始 TCP socket。
   * @param head HTTP parser 已读取的 upgrade 后首段数据。
   * @returns Promise，在连接完成或错误响应写回后结束。
   * @throws 无显式抛出；内部错误统一转换为 502。
   */
  const handleVoiceUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> => {
    const route = resolveVoiceWebSocketRoute(request.url);
    if (!route) {
      if (isVoiceWebSocketPath(request.url)) {
        writeUpgradeError(
          socket,
          400,
          "invalid_voice_websocket_request",
          "Voice WebSocket request is missing a valid call id"
        );
      }
      return;
    }

    const binding = bindingStore.get(route.callId);
    if (!binding) {
      writeUpgradeError(
        socket,
        404,
        "voice_call_binding_not_found",
        "Voice call binding is missing or expired"
      );
      return;
    }

    const protocols = resolveWebSocketProtocols(
      request.headers["sec-websocket-protocol"]
    );
    let upstream: BufferedUpstreamSocket;

    try {
      upstream = await connectBoundVoiceWebSocket(
        dependencies,
        binding,
        route,
        request.headers,
        protocols
      );
    } catch (error) {
      const upstreamStatus = error instanceof VoiceWebSocketConnectError
        ? error.statusCode ?? "transport"
        : "unexpected";
      console.error(
        `cslot voice sideband connection failed: mode=${route.mode} status=${upstreamStatus}`
      );
      writeUpgradeError(
        socket,
        502,
        "voice_upstream_websocket_failed",
        error instanceof Error ? error.message : String(error)
      );
      return;
    }

    if (socket.destroyed) {
      upstream.socket.terminate();
      return;
    }

    upstreamSockets.add(upstream.socket);
    if (upstream.socket.protocol) {
      selectedProtocols.set(request, upstream.socket.protocol);
    }

    try {
      webSocketServer.handleUpgrade(request, socket, head, (localSocket) => {
        selectedProtocols.delete(request);
        webSocketServer.emit("connection", localSocket, request);
        bridgeVoiceWebSockets(
          localSocket,
          upstream,
          route.callId,
          bindingStore,
          upstreamSockets
        );
      });
    } catch (error) {
      selectedProtocols.delete(request);
      upstreamSockets.delete(upstream.socket);
      upstream.socket.terminate();
      writeUpgradeError(
        socket,
        400,
        "voice_local_websocket_failed",
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  /**
   * 将 Node upgrade 事件交给异步 Voice 处理器，并兜底处理未预期异常。
   *
   * @param request Node upgrade 请求。
   * @param socket 原始 TCP socket。
   * @param head HTTP parser 已读取的数据。
   * @returns 无返回值。
   */
  const upgradeListener = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void => {
    void handleVoiceUpgrade(request, socket, head).catch((error) => {
      writeUpgradeError(
        socket,
        502,
        "voice_websocket_proxy_failed",
        error instanceof Error ? error.message : String(error)
      );
    });
  };

  server.on("upgrade", upgradeListener);

  return {
    close: () => {
      server.off("upgrade", upgradeListener);

      for (const socket of webSocketServer.clients) {
        socket.terminate();
      }
      for (const socket of upstreamSockets) {
        socket.terminate();
      }

      upstreamSockets.clear();
      webSocketServer.close();
    }
  };
}
