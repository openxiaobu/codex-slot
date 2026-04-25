import type { IncomingHttpHeaders } from "node:http";
import { request } from "undici";

/**
 * 构造发往上游的请求头，并移除仅属于本地代理链路的头信息。
 *
 * 业务含义：
 * 1. 本地服务使用独立 api_key 鉴权，转发时必须替换为真实上游 access token。
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
  bodyLength: number,
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

  headers["content-length"] = String(bodyLength);
  headers["user-agent"] = "codex-slot/0.1.1";

  if (accountIdHeader) {
    headers["chatgpt-account-id"] = accountIdHeader;
  }

  return headers;
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
  return await request(`${options.codexBaseUrl}/responses`, {
    method: "POST",
    headers: buildUpstreamHeaders(
      options.requestHeaders,
      options.accessToken,
      options.body.length,
      options.accountIdHeader
    ),
    body: options.body
  });
}
