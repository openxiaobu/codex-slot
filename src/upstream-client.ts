import type { IncomingHttpHeaders } from "node:http";
import { request } from "undici";

/**
 * 构造发往上游的请求头，并移除仅属于本地代理链路的头信息。
 *
 * 业务含义：
 * 1. 本地服务只监听 loopback 地址，转发时必须替换为真实上游 access token。
 * 2. body 会在本地先读取成 Buffer 以支持失败后切换账号重试，因此这里重算 content-length。
 *
 * @param requestHeaders 客户端发到本地服务的原始请求头。
 * @param accessToken 当前候选账号可用的上游访问令牌。
 * @param bodyLength 请求体字节长度。
 * @param accountIdHeader 可选的 ChatGPT 账号标识头。
 * @returns 可直接传给上游请求的请求头对象。
 * @throws 无显式抛出。
 */
export function buildUpstreamHeaders(
  requestHeaders: IncomingHttpHeaders,
  accessToken: string,
  bodyLength?: number,
  accountIdHeader?: string
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [headerName, headerValue] of Object.entries(requestHeaders)) {
    const normalizedName = headerName.toLowerCase();

    if (
      headerValue == null ||
      normalizedName === "authorization" ||
      normalizedName === "host" ||
      normalizedName === "connection" ||
      normalizedName === "content-length"
    ) {
      continue;
    }

    headers[normalizedName] = Array.isArray(headerValue)
      ? headerValue.join(", ")
      : headerValue;
  }

  headers.authorization = `Bearer ${accessToken}`;

  if (!headers.accept) {
    headers.accept = "text/event-stream, application/json";
  }

  if (typeof bodyLength === "number") {
    headers["content-length"] = String(bodyLength);
  }

  headers["user-agent"] = "codex-slot/0.1.1";

  if (accountIdHeader) {
    headers["chatgpt-account-id"] = accountIdHeader;
  }

  return headers;
}

/**
 * 向 Codex-compatible 上游发送一次通用请求。
 *
 * 业务含义：
 * 1. 本地 `/v1/*` 或旧 `/backend-api/codex/*` 路由都应复用同一条上游转发逻辑，避免再按接口逐个补洞。
 * 2. 路由后缀与 query 原样拼接到 `codexBaseUrl` 后，仅由 cslot 负责替换官方 access token 与账号头。
 *
 * @param options 上游请求参数，包含方法、目标 path/query、原始请求头以及可选 body。
 * @returns undici 上游响应对象。
 * @throws 当网络层或 undici 请求失败时透传底层异常。
 */
export async function sendCodexRequest(options: {
  codexBaseUrl: string;
  method: string;
  pathWithQuery: string;
  requestHeaders: IncomingHttpHeaders;
  accessToken: string;
  accountIdHeader?: string;
  body?: Buffer;
}) {
  const baseUrl = options.codexBaseUrl.replace(/\/+$/, "");
  const pathWithQuery = options.pathWithQuery.startsWith("/")
    ? options.pathWithQuery
    : `/${options.pathWithQuery}`;
  const bodyLength = options.body && options.body.length > 0 ? options.body.length : undefined;

  return await request(`${baseUrl}${pathWithQuery}`, {
    method: options.method,
    headers: buildUpstreamHeaders(
      options.requestHeaders,
      options.accessToken,
      bodyLength,
      options.accountIdHeader
    ),
    body: options.body && options.body.length > 0 ? options.body : undefined
  });
}

/**
 * 向 Codex responses 上游发送一次请求。
 *
 * 业务含义：
 * 1. 该 Adapter 隔离 undici 与上游 URL 细节，代理重试服务不直接依赖 HTTP 客户端实现。
 * 2. 调用方负责决定 access token、账号切换与失败策略。
 *
 * @param options 上游请求参数。
 * @returns undici 上游响应对象。
 * @throws 当网络层或 undici 请求失败时透传底层异常。
 */
export async function sendCodexResponsesRequest(options: {
  codexBaseUrl: string;
  requestHeaders: IncomingHttpHeaders;
  accessToken: string;
  accountIdHeader?: string;
  body: Buffer;
}) {
  return await sendCodexRequest({
    codexBaseUrl: options.codexBaseUrl,
    method: "POST",
    pathWithQuery: "/responses",
    requestHeaders: options.requestHeaders,
    accessToken: options.accessToken,
    accountIdHeader: options.accountIdHeader,
    body: options.body
  });
}

/**
 * 构造发往 ChatGPT backend API 的通用请求头。
 *
 * 业务含义：
 * 1. 该方法服务于非模型兼容接口，例如 Browser Use 的安全检查接口。
 * 2. 调用方残留的 Authorization 不能透传给上游，必须替换为当前调度账号的官方 access token。
 *
 * @param requestHeaders 客户端发到本地服务的原始请求头。
 * @param accessToken 当前候选账号可用的上游访问令牌。
 * @param accountIdHeader 可选的 ChatGPT 账号标识头。
 * @param bodyLength 可选请求体长度；无请求体时不写 content-length。
 * @returns 可直接传给 ChatGPT backend 的请求头对象。
 * @throws 无显式抛出。
 */
export function buildChatGptBackendHeaders(
  requestHeaders: IncomingHttpHeaders,
  accessToken: string,
  accountIdHeader?: string,
  bodyLength?: number
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [headerName, headerValue] of Object.entries(requestHeaders)) {
    const normalizedName = headerName.toLowerCase();

    if (
      headerValue == null ||
      normalizedName === "authorization" ||
      normalizedName === "host" ||
      normalizedName === "connection" ||
      normalizedName === "content-length"
    ) {
      continue;
    }

    headers[normalizedName] = Array.isArray(headerValue)
      ? headerValue.join(", ")
      : headerValue;
  }

  headers.authorization = `Bearer ${accessToken}`;

  if (!headers.accept) {
    headers.accept = "application/json";
  }

  headers["user-agent"] = "codex-slot/0.1.1";

  if (typeof bodyLength === "number") {
    headers["content-length"] = String(bodyLength);
  }

  if (accountIdHeader) {
    headers["chatgpt-account-id"] = accountIdHeader;
  }

  return headers;
}

/**
 * 向 ChatGPT backend API 发送一次通用请求。
 *
 * 业务含义：
 * 1. 该 Adapter 只负责安全地拼接 backend 基地址、路由和鉴权头。
 * 2. 允许代理哪些 backend 路由由更上层策略控制，避免这里承担访问控制职责。
 *
 * @param options 上游请求参数。
 * @returns undici 上游响应对象。
 * @throws 当网络层或 undici 请求失败时透传底层异常。
 */
export async function sendChatGptBackendRequest(options: {
  chatGptBaseUrl: string;
  method: string;
  pathWithQuery: string;
  requestHeaders: IncomingHttpHeaders;
  accessToken: string;
  accountIdHeader?: string;
  body?: Buffer;
}) {
  const baseUrl = options.chatGptBaseUrl.replace(/\/+$/, "");
  const pathWithQuery = options.pathWithQuery.startsWith("/")
    ? options.pathWithQuery
    : `/${options.pathWithQuery}`;
  const bodyLength = options.body && options.body.length > 0 ? options.body.length : undefined;

  return await request(`${baseUrl}${pathWithQuery}`, {
    method: options.method,
    headers: buildChatGptBackendHeaders(
      options.requestHeaders,
      options.accessToken,
      options.accountIdHeader,
      bodyLength
    ),
    body: options.body && options.body.length > 0 ? options.body : undefined
  });
}
