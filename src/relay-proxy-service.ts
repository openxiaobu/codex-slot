import type { IncomingHttpHeaders } from "node:http";
import { request } from "undici";
import type { RelaySlot } from "./types";

interface RelayProxyRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body?: Buffer;
}

interface UpstreamRelayResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer | Uint8Array | string> & {
    text: () => Promise<string>;
  };
}

interface RelayProxyDependencies {
  sendRelayRequest: typeof sendRelayRequest;
}

export type RelayProxyResult =
  | {
      type: "proxy";
      statusCode: number;
      headers: Record<string, string>;
      body: AsyncIterable<Buffer | Uint8Array | string>;
    }
  | {
      type: "send";
      statusCode: number;
      headers?: Record<string, string>;
      payload: unknown;
    };

/**
 * 构造 OpenAI-compatible relay 上游请求头。
 *
 * 业务含义：
 * 1. 客户端发给本地 cslot 的 Authorization 不代表 relay 凭据，不能透传。
 * 2. relay 模式只使用 relay slot 自己的 api_key 鉴权，并保留其余兼容请求头。
 *
 * @param requestHeaders 客户端发到本地服务的原始请求头。
 * @param apiKey relay slot 的 API key。
 * @param bodyLength 请求体字节长度；无 body 时不写 content-length。
 * @returns 可发往 relay 上游的请求头。
 * @throws 无显式抛出。
 */
export function buildRelayHeaders(
  requestHeaders: IncomingHttpHeaders,
  apiKey: string,
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

  headers.authorization = `Bearer ${apiKey}`;

  if (typeof bodyLength === "number") {
    headers["content-length"] = String(bodyLength);
  }

  headers["user-agent"] = "codex-slot/0.1.1";
  return headers;
}

/**
 * 将本地 `/v1/*` 请求解析成 relay base_url 后的相对路径。
 *
 * @param url 本地代理收到的 URL。
 * @returns relay 上游相对 path 与 query；不属于 `/v1/*` 时返回 `null`。
 * @throws URL 解析失败时透传异常。
 */
function resolveRelayPath(url: string): string | null {
  const parsedUrl = new URL(url, "http://127.0.0.1");
  const openAiPrefix = "/v1";

  if (!parsedUrl.pathname.startsWith(`${openAiPrefix}/`)) {
    return null;
  }

  return `${parsedUrl.pathname.slice(openAiPrefix.length)}${parsedUrl.search}`;
}

/**
 * 提取上游响应中允许透传给客户端的响应头。
 *
 * @param headers 上游响应头对象。
 * @returns 可透传响应头。
 * @throws 无显式抛出。
 */
function pickResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const picked: Record<string, string> = {};
  const contentType = headers["content-type"];
  const cacheControl = headers["cache-control"];

  if (typeof contentType === "string") {
    picked["content-type"] = contentType;
  }

  if (typeof cacheControl === "string") {
    picked["cache-control"] = cacheControl;
  }

  return picked;
}

function buildSendResult(
  statusCode: number,
  payload: unknown,
  headers?: Record<string, string>
): RelayProxyResult {
  return {
    type: "send",
    statusCode,
    payload,
    headers
  };
}

/**
 * 向 OpenAI-compatible relay 上游发送一次请求。
 *
 * @param options relay 请求参数。
 * @returns undici 上游响应对象。
 * @throws 当网络层或 undici 请求失败时透传底层异常。
 */
export async function sendRelayRequest(options: {
  baseUrl: string;
  method: string;
  pathWithQuery: string;
  headers: Record<string, string>;
  body?: Buffer;
}) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const pathWithQuery = options.pathWithQuery.startsWith("/")
    ? options.pathWithQuery
    : `/${options.pathWithQuery}`;

  return await request(`${baseUrl}${pathWithQuery}`, {
    method: options.method,
    headers: options.headers,
    body: options.body && options.body.length > 0 ? options.body : undefined
  });
}

/**
 * 创建 relay 模型代理服务。
 *
 * 业务含义：
 * 1. relay slot 是手动固定的模型出口，不参与官方账号自动调度。
 * 2. relay 上游返回 401/429/5xx 时原样返回给客户端，不回退到官方账号。
 *
 * @param overrides 可选依赖覆盖项。
 * @returns relay 代理服务实例。
 * @throws 无显式抛出。
 */
export function createRelayProxyService(overrides?: Partial<RelayProxyDependencies>): {
  proxyRelaySlot: (options: {
    slot: RelaySlot;
    request: RelayProxyRequest;
  }) => Promise<RelayProxyResult>;
} {
  const dependencies: RelayProxyDependencies = {
    sendRelayRequest,
    ...overrides
  };

  return {
    async proxyRelaySlot(options): Promise<RelayProxyResult> {
      const pathWithQuery = resolveRelayPath(options.request.url);

      if (!pathWithQuery) {
        return buildSendResult(404, {
          error: {
            message: "Unsupported relay proxy path",
            type: "unsupported_relay_proxy_path"
          }
        });
      }

      const bodyLength =
        options.request.body && options.request.body.length > 0
          ? options.request.body.length
          : undefined;
      let upstream: UpstreamRelayResponse;

      try {
        upstream = await dependencies.sendRelayRequest({
          baseUrl: options.slot.base_url,
          method: options.request.method.toUpperCase(),
          pathWithQuery,
          headers: buildRelayHeaders(options.request.headers, options.slot.api_key, bodyLength),
          body: options.request.body
        });
      } catch (error) {
        return buildSendResult(502, {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: "relay_request_failed"
          }
        });
      }

      return {
        type: "proxy",
        statusCode: upstream.statusCode,
        headers: pickResponseHeaders(upstream.headers),
        body: upstream.body
      };
    }
  };
}

export const { proxyRelaySlot } = createRelayProxyService();
