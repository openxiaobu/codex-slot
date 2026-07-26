import type { IncomingHttpHeaders } from "node:http";
import { readAuthFile } from "./account-store";
import { loadConfig } from "./config";
import { listCandidateAccounts } from "./scheduler";
import { bi } from "./text";
import { sendCodexRequest } from "./upstream-client";
import {
  buildNetworkUnavailablePayload,
  isNetworkUnavailableError
} from "./upstream-error-policy";
import { refreshAccountTokens } from "./usage-sync";
import type {
  CodexAuthFile,
  CslotConfig,
  ManagedAccount,
  SchedulerPick
} from "./types";
import {
  VoiceCallBindingStore
} from "./voice-call-binding-store";

interface VoiceProxyRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body?: Buffer;
}

interface UpstreamVoiceResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer | Uint8Array | string> & {
    text: () => Promise<string>;
  };
}

interface VoiceProxyDependencies {
  loadConfig: () => CslotConfig;
  listCandidateAccounts: () => SchedulerPick[];
  readAuthFile: (codexHome: string) => CodexAuthFile | null;
  sendCodexRequest: typeof sendCodexRequest;
  refreshAccountTokens: typeof refreshAccountTokens;
  now: () => number;
}

interface ResolvedVoiceRequest {
  pathWithQuery: string;
  headers: IncomingHttpHeaders;
  body?: Buffer;
}

interface MultipartVoicePayload {
  sdp: string;
  session: Record<string, unknown>;
}

const VOICE_SIDEBAND_SESSION_HEADERS = new Set([
  "openai-alpha",
  "originator",
  "session-id",
  "thread-id",
  "user-agent",
  "x-codex-installation-id",
  "x-oai-attestation",
  "x-session-id"
]);

export type VoiceProxyResult =
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
 * 按大小写不敏感方式读取请求或响应头的单值文本。
 *
 * @param headers Node 请求头或 undici 响应头对象。
 * @param targetName 目标头名称。
 * @returns 第一个可用文本值；不存在时返回 `undefined`。
 * @throws 无显式抛出。
 */
function readHeaderValue(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  targetName: string
): string | undefined {
  const normalizedTarget = targetName.toLowerCase();

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== normalizedTarget || value == null) {
      continue;
    }

    return Array.isArray(value) ? value[0] : value;
  }

  return undefined;
}

/**
 * 覆盖指定请求头，同时移除不同大小写形式的旧值。
 *
 * @param headers 原始请求头。
 * @param targetName 待覆盖的头名称。
 * @param value 新的单值文本。
 * @returns 已覆盖目标字段的请求头浅拷贝。
 * @throws 无显式抛出。
 */
function replaceRequestHeader(
  headers: IncomingHttpHeaders,
  targetName: string,
  value: string
): IncomingHttpHeaders {
  const normalizedTarget = targetName.toLowerCase();
  const replaced: IncomingHttpHeaders = {};

  for (const [name, headerValue] of Object.entries(headers)) {
    if (name.toLowerCase() !== normalizedTarget) {
      replaced[name] = headerValue;
    }
  }

  replaced[normalizedTarget] = value;
  return replaced;
}

/**
 * 固定创建 Voice call 时使用的 sideband 会话头。
 *
 * 业务含义：
 * 1. 官方 Voice HTTP call 与后续 sideband WebSocket 必须复用同一组 attestation 和 session 身份。
 * 2. 这里只保存进程内短期握手所需字段，不保存 Authorization、账号头或其他客户端请求内容。
 *
 * @param headers 创建 Voice call 时由 Codex App 发送的请求头。
 * @returns 可在同一 call 的 sideband 握手中重放的会话头；缺失字段不会被补造。
 * @throws 无显式抛出。
 */
function captureVoiceSidebandHeaders(
  headers: IncomingHttpHeaders
): Record<string, string> {
  const captured: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (value == null || !VOICE_SIDEBAND_SESSION_HEADERS.has(normalizedName)) {
      continue;
    }

    captured[normalizedName] = Array.isArray(value) ? value.join(", ") : value;
  }

  return captured;
}

/**
 * 从 multipart Content-Type 中提取 boundary。
 *
 * @param contentType 客户端请求的 Content-Type。
 * @returns 合法 boundary；不是 multipart 或 boundary 缺失时返回 `null`。
 * @throws 无显式抛出。
 */
function resolveMultipartBoundary(contentType: string | undefined): string | null {
  if (!contentType || !/^multipart\/form-data(?:;|$)/i.test(contentType)) {
    return null;
  }

  const match = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  return match?.[1] ?? match?.[2] ?? null;
}

/**
 * 解析 Codex 公共 Realtime API 发送的 multipart SDP 与 session。
 *
 * @param body 完整 multipart 请求体。
 * @param boundary Content-Type 中声明的 multipart boundary。
 * @returns SDP 文本与 session JSON 对象。
 * @throws 当 multipart 结构、字段或 session JSON 非法时抛出错误。
 */
function parseMultipartVoicePayload(
  body: Buffer,
  boundary: string
): MultipartVoicePayload {
  const delimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  const values = new Map<string, Buffer>();
  let cursor = body.indexOf(delimiter);

  if (cursor !== 0) {
    throw new Error("multipart body does not start with its boundary");
  }

  while (cursor >= 0) {
    cursor += delimiter.length;

    if (body.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) {
      break;
    }

    if (!body.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) {
      throw new Error("multipart boundary is not followed by CRLF");
    }

    const headersStart = cursor + 2;
    const headersEnd = body.indexOf(Buffer.from("\r\n\r\n"), headersStart);
    if (headersEnd < 0) {
      throw new Error("multipart part headers are incomplete");
    }

    const partHeaders = body.subarray(headersStart, headersEnd).toString("utf8");
    const disposition = partHeaders
      .split("\r\n")
      .find((line) => /^content-disposition:/i.test(line));
    const nameMatch = disposition?.match(/\bname=(?:"([^"]+)"|([^;\s]+))/i);
    const fieldName = nameMatch?.[1] ?? nameMatch?.[2];
    if (!fieldName) {
      throw new Error("multipart part is missing a field name");
    }

    const contentStart = headersEnd + 4;
    const contentEnd = body.indexOf(nextDelimiter, contentStart);
    if (contentEnd < 0) {
      throw new Error("multipart part is missing its closing boundary");
    }

    values.set(fieldName, body.subarray(contentStart, contentEnd));
    cursor = contentEnd + 2;
  }

  const sdp = values.get("sdp")?.toString("utf8");
  const sessionText = values.get("session")?.toString("utf8");
  if (!sdp || !sessionText) {
    throw new Error("multipart body must contain non-empty sdp and session fields");
  }

  const session = JSON.parse(sessionText) as unknown;
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw new Error("multipart session field must be a JSON object");
  }

  const normalizedSession = { ...(session as Record<string, unknown>) };
  delete normalizedSession.id;

  return {
    sdp,
    session: normalizedSession
  };
}

/**
 * 为 ChatGPT backend Voice call 补齐 AVAS query 参数。
 *
 * @param search 原始请求 query。
 * @param includeAvasParams 是否需要补齐 quicksilver 与 AVAS 参数。
 * @returns 以 `?` 开头的 query；没有参数时返回空字符串。
 * @throws 无显式抛出。
 */
function buildVoiceCallQuery(search: string, includeAvasParams: boolean): string {
  const params = new URLSearchParams(search);

  if (includeAvasParams) {
    if (!params.has("intent")) {
      params.set("intent", "quicksilver");
    }
    if (!params.has("architecture")) {
      params.set("architecture", "avas");
    }
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * 将本地公共 Realtime call 请求转换为 ChatGPT backend 请求。
 *
 * 业务含义：
 * 1. Codex App 对自定义 `/v1` provider 使用公共 API multipart 形态。
 * 2. ChatGPT 登录态上游要求 `/realtime/calls` JSON 形态。
 * 3. 旧版 `/v1/realtime/calls` 与历史 backend 入口继续兼容。
 *
 * @param request 本地 Voice call 创建请求。
 * @returns 可直接发送给 `codex_base_url` 的 path、请求头与 body。
 * @throws 当请求路径、方法、Content-Type 或 multipart 内容不合法时抛出错误。
 */
function resolveVoiceRequest(request: VoiceProxyRequest): ResolvedVoiceRequest {
  if (request.method.toUpperCase() !== "POST") {
    throw new Error("Voice call creation only supports POST");
  }

  const parsedUrl = new URL(request.url, "http://127.0.0.1");
  const isPublicLive = parsedUrl.pathname === "/v1/live";
  const isPublicRealtime = parsedUrl.pathname === "/v1/realtime/calls";
  const isBackendRealtime = parsedUrl.pathname === "/backend-api/codex/realtime/calls";

  if (!isPublicLive && !isPublicRealtime && !isBackendRealtime) {
    throw new Error("Unsupported Voice call creation path");
  }

  const body = request.body ?? Buffer.alloc(0);
  const contentType = readHeaderValue(request.headers, "content-type");
  const boundary = resolveMultipartBoundary(contentType);

  if (boundary) {
    const payload = parseMultipartVoicePayload(body, boundary);
    const backendBody = Buffer.from(JSON.stringify(payload));

    return {
      pathWithQuery: `/realtime/calls${buildVoiceCallQuery(parsedUrl.search, true)}`,
      headers: replaceRequestHeader(request.headers, "content-type", "application/json"),
      body: backendBody
    };
  }

  if (isPublicLive) {
    throw new Error("/v1/live requires a multipart/form-data body");
  }

  if (
    isPublicRealtime &&
    contentType &&
    !/^application\/sdp(?:;|$)/i.test(contentType)
  ) {
    throw new Error("/v1/realtime/calls requires application/sdp or multipart/form-data");
  }

  return {
    pathWithQuery: `/realtime/calls${buildVoiceCallQuery(parsedUrl.search, false)}`,
    headers: request.headers,
    body
  };
}

/**
 * 返回 Voice 创建 call 时允许透传给 Codex App 的响应头。
 *
 * @param headers 上游响应头。
 * @returns 包含 SDP 类型、call Location 与诊断字段的安全响应头。
 * @throws 无显式抛出。
 */
function pickVoiceResponseHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const allowedHeaders = [
    "content-type",
    "content-length",
    "cache-control",
    "location",
    "openai-processing-ms",
    "openai-version",
    "x-request-id"
  ];
  const picked: Record<string, string> = {};

  for (const headerName of allowedHeaders) {
    const value = readHeaderValue(headers, headerName);
    if (value !== undefined) {
      picked[headerName] = value;
    }
  }

  return picked;
}

/**
 * 按 Codex 官方规则从 Location 响应头中提取 Voice call id。
 *
 * @param location 上游 call 创建响应的 Location。
 * @returns `rtc_` 前缀或 UUID 形态的 call id；无法识别时返回 `null`。
 * @throws 无显式抛出。
 */
function resolveCallId(location: string | undefined): string | null {
  if (!location) {
    return null;
  }

  const segments = location.split("?")[0].split("/").reverse();

  for (const segment of segments) {
    if (/^rtc_[A-Za-z0-9._~-]+$/.test(segment)) {
      return segment;
    }

    if (
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(segment)
    ) {
      return segment;
    }
  }

  return null;
}

/**
 * 构造 Voice 代理错误响应。
 *
 * @param statusCode 返回给本地客户端的 HTTP 状态码。
 * @param type 稳定错误类型。
 * @param message 面向用户的错误说明。
 * @returns Voice send 结果。
 * @throws 无显式抛出。
 */
function buildVoiceError(
  statusCode: number,
  type: string,
  message: string
): VoiceProxyResult {
  return {
    type: "send",
    statusCode,
    payload: {
      error: {
        message,
        type
      }
    }
  };
}

/**
 * 组合 Voice 专用候选账号顺序。
 *
 * 业务含义：
 * 1. 优先沿用普通调度器的健康账号排序。
 * 2. Voice 使用独立的 ChatGPT Realtime 能力；即使 Codex 文本额度受限，也应兜底尝试其他已启用登录态。
 *
 * @param dependencies Voice 代理依赖。
 * @returns 去重后的已启用账号列表。
 * @throws 当配置读取失败时透传错误；普通调度器失败时自动回退配置顺序。
 */
function listVoiceCandidateAccounts(
  dependencies: VoiceProxyDependencies
): ManagedAccount[] {
  const configuredAccounts = dependencies.loadConfig().accounts.filter((account) => account.enabled);
  let scheduledAccounts: ManagedAccount[] = [];

  try {
    scheduledAccounts = dependencies.listCandidateAccounts().map((picked) => picked.account);
  } catch {
    scheduledAccounts = [];
  }

  const candidates = new Map<string, ManagedAccount>();
  for (const account of [...scheduledAccounts, ...configuredAccounts]) {
    if (account.enabled && !candidates.has(account.id)) {
      candidates.set(account.id, account);
    }
  }

  return [...candidates.values()];
}

/**
 * 使用指定账号向 ChatGPT backend 创建一次 Voice call。
 *
 * @param dependencies Voice 代理依赖。
 * @param account 当前固定候选账号。
 * @param accessToken 当前账号 access token。
 * @param request 已转换的 backend Voice 请求。
 * @returns 上游响应。
 * @throws 当网络或 undici 请求失败时透传错误。
 */
async function sendVoiceCallWithAccount(
  dependencies: VoiceProxyDependencies,
  account: ManagedAccount,
  accessToken: string,
  request: ResolvedVoiceRequest
): Promise<UpstreamVoiceResponse> {
  const config = dependencies.loadConfig();
  const auth = dependencies.readAuthFile(account.codex_home);

  return await dependencies.sendCodexRequest({
    codexBaseUrl: config.upstream.codex_base_url,
    method: "POST",
    pathWithQuery: request.pathWithQuery,
    requestHeaders: request.headers,
    accessToken,
    accountIdHeader: auth?.tokens?.account_id,
    body: request.body
  });
}

/**
 * 创建 Voice HTTP call 代理服务。
 *
 * @param bindingStore HTTP call 与 sideband WebSocket 共用的账号绑定存储。
 * @param overrides 可选依赖覆盖项，供自动化测试注入。
 * @returns 提供 `proxyVoiceCall` 方法的服务。
 * @throws 无显式抛出。
 */
export function createVoiceProxyService(
  bindingStore: VoiceCallBindingStore,
  overrides?: Partial<VoiceProxyDependencies>
): {
  proxyVoiceCall: (request: VoiceProxyRequest) => Promise<VoiceProxyResult>;
} {
  const dependencies: VoiceProxyDependencies = {
    loadConfig,
    listCandidateAccounts,
    readAuthFile,
    sendCodexRequest,
    refreshAccountTokens,
    now: Date.now,
    ...overrides
  };

  /**
   * 创建 Voice call，并把成功账号与上游 call id 绑定。
   *
   * @param request 本地 `/v1/live`、`/v1/realtime/calls` 或兼容 backend 请求。
   * @returns 可由 Fastify 直接发送或流式透传的 Voice 响应。
   * @throws 无显式抛出；请求、账号与上游错误统一转换为结构化结果。
   */
  const proxyVoiceCall = async (
    request: VoiceProxyRequest
  ): Promise<VoiceProxyResult> => {
    let resolvedRequest: ResolvedVoiceRequest;

    try {
      resolvedRequest = resolveVoiceRequest(request);
    } catch (error) {
      return buildVoiceError(
        400,
        "invalid_voice_call_request",
        error instanceof Error ? error.message : String(error)
      );
    }

    const candidates = listVoiceCandidateAccounts(dependencies);
    if (candidates.length === 0) {
      return buildVoiceError(
        503,
        "no_available_voice_account",
        bi("当前没有已启用的 Voice 登录账号", "No enabled Voice account")
      );
    }

    let lastError: VoiceProxyResult = buildVoiceError(
      503,
      "all_voice_accounts_failed",
      bi("所有 Voice 账号都请求失败", "All Voice accounts failed")
    );

    for (const account of candidates) {
      const auth = dependencies.readAuthFile(account.codex_home);
      let accessToken = auth?.tokens?.access_token;

      if (!accessToken) {
        lastError = buildVoiceError(
          503,
          "invalid_voice_account_auth",
          bi(
            `Voice 账号 ${account.id} 缺少 access_token`,
            `Voice account ${account.id} is missing access_token`
          )
        );
        continue;
      }

      let upstream: UpstreamVoiceResponse;

      try {
        upstream = await sendVoiceCallWithAccount(
          dependencies,
          account,
          accessToken,
          resolvedRequest
        );
      } catch (error) {
        lastError = isNetworkUnavailableError(error)
          ? {
              type: "send",
              statusCode: 503,
              payload: buildNetworkUnavailablePayload(account.id, error)
            }
          : buildVoiceError(
              503,
              "voice_account_request_failed",
              bi(
                `Voice 账号 ${account.id} 请求上游失败: ${error instanceof Error ? error.message : String(error)}`,
                `Voice account ${account.id} failed: ${error instanceof Error ? error.message : String(error)}`
              )
            );
        continue;
      }

      if (upstream.statusCode === 401) {
        await upstream.body.text();

        try {
          const refreshed = await dependencies.refreshAccountTokens(account.id);
          accessToken = refreshed.tokens?.access_token ?? accessToken;
          upstream = await sendVoiceCallWithAccount(
            dependencies,
            account,
            accessToken,
            resolvedRequest
          );
        } catch (error) {
          lastError = buildVoiceError(
            503,
            "voice_token_refresh_failed",
            bi(
              `Voice 账号 ${account.id} 刷新 token 失败: ${error instanceof Error ? error.message : String(error)}`,
              `Voice account ${account.id} token refresh failed: ${error instanceof Error ? error.message : String(error)}`
            )
          );
          continue;
        }
      }

      if (
        upstream.statusCode === 401 ||
        upstream.statusCode === 403 ||
        upstream.statusCode === 429 ||
        upstream.statusCode >= 500
      ) {
        const errorText = await upstream.body.text();
        lastError = buildVoiceError(
          upstream.statusCode,
          "voice_account_upstream_failed",
          bi(
            `Voice 账号 ${account.id} 上游返回 ${upstream.statusCode}: ${errorText}`,
            `Voice account ${account.id} returned ${upstream.statusCode}: ${errorText}`
          )
        );
        continue;
      }

      if (upstream.statusCode >= 400) {
        return {
          type: "proxy",
          statusCode: upstream.statusCode,
          headers: pickVoiceResponseHeaders(upstream.headers),
          body: upstream.body
        };
      }

      const responseHeaders = pickVoiceResponseHeaders(upstream.headers);
      const callId = resolveCallId(responseHeaders.location);
      if (!callId) {
        await upstream.body.text();
        return buildVoiceError(
          502,
          "voice_call_location_missing",
          bi(
            "Voice 上游响应缺少有效的 Location call id",
            "Voice upstream response is missing a valid Location call id"
          )
        );
      }

      bindingStore.remember({
        callId,
        accountId: account.id,
        codexHome: account.codex_home,
        createdAt: dependencies.now(),
        sidebandHeaders: captureVoiceSidebandHeaders(resolvedRequest.headers)
      });

      return {
        type: "proxy",
        statusCode: upstream.statusCode,
        headers: responseHeaders,
        body: upstream.body
      };
    }

    return lastError;
  };

  return {
    proxyVoiceCall
  };
}
