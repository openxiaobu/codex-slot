"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = startServer;
const fastify_1 = __importDefault(require("fastify"));
const undici_1 = require("undici");
const account_store_1 = require("./account-store");
const config_1 = require("./config");
const status_1 = require("./status");
const scheduler_1 = require("./scheduler");
const state_1 = require("./state");
const usage_sync_1 = require("./usage-sync");
function getBearerToken(headerValue) {
    if (!headerValue) {
        return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(headerValue);
    return match?.[1] ?? null;
}
/**
 * 根据错误文本与当前账号状态，决定本地禁用时长。
 *
 * 业务规则：
 * 1. 周限制优先，直到周窗口重置时间。
 * 2. 5 小时额度限制次之，直到 5 小时窗口重置时间。
 * 3. 未能明确识别时，按 5 分钟临时熔断处理。
 *
 * @param picked 当前被选中的账号及状态。
 * @param errorText 上游返回的错误文本。
 * @returns 本地禁用窗口与原因。
 */
function resolveBlockWindow(picked, errorText) {
    const lowerText = errorText.toLowerCase();
    if (lowerText.includes("weekly") ||
        lowerText.includes("7 day") ||
        lowerText.includes("7-day") ||
        picked.status.isWeeklyLimited) {
        return {
            until: picked.status.weeklyResetsAt ?? Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
            reason: "weekly_limited"
        };
    }
    if (lowerText.includes("5 hour") ||
        lowerText.includes("5-hour") ||
        lowerText.includes("5h") ||
        lowerText.includes("usage limit") ||
        picked.status.isFiveHourLimited) {
        return {
            until: picked.status.fiveHourResetsAt ?? Math.floor(Date.now() / 1000) + 5 * 60,
            reason: "five_hour_limited"
        };
    }
    return {
        until: Math.floor(Date.now() / 1000) + 5 * 60,
        reason: "temporary_5m_limit"
    };
}
/**
 * 启动一个极轻量本地服务，供后续接入代理或脚本化查询使用。
 *
 * 当前阶段服务用途：
 * 1. 暴露健康检查。
 * 2. 暴露账号状态与当前推荐账号。
 * 3. 为后续真正的 OpenAI-compatible proxy 预留入口。
 *
 * @param port 本地监听端口。
 * @returns Fastify 实例，便于调用方在测试或脚本中复用。
 * @throws 当端口占用或服务启动失败时抛出异常。
 */
async function startServer(port) {
    const config = (0, config_1.loadConfig)();
    const app = (0, fastify_1.default)({ logger: false });
    app.addHook("onRequest", async (request, reply) => {
        if (request.url === "/health") {
            return;
        }
        const bearer = getBearerToken(request.headers.authorization);
        if (bearer !== config.server.api_key) {
            reply.code(401);
            throw new Error("invalid local api key");
        }
    });
    app.get("/health", async () => {
        return { ok: true };
    });
    app.post("/refresh", async () => {
        const results = await refreshAccountUsageForBestEffort();
        return { refreshed: results };
    });
    app.get("/accounts", async () => {
        return {
            accounts: (0, status_1.collectAccountStatuses)(),
            selected: (0, scheduler_1.pickBestAccount)()
        };
    });
    const proxyHandler = async (requestMessage, reply) => {
        const candidates = (0, scheduler_1.listCandidateAccounts)();
        if (candidates.length === 0) {
            reply.code(503);
            reply.send({
                error: {
                    message: "当前没有可用账号",
                    type: "no_available_account"
                }
            });
            return;
        }
        let lastErrorPayload = {
            error: {
                message: "所有账号都请求失败",
                type: "all_accounts_failed"
            }
        };
        let lastStatusCode = 503;
        for (const picked of candidates) {
            try {
                await (0, usage_sync_1.refreshAccountUsage)(picked.account.id);
            }
            catch {
                // 刷新失败时继续使用本地缓存，不中断请求链路。
            }
            const auth = (0, account_store_1.readAuthFile)(picked.account.codex_home);
            let accessToken = auth?.tokens?.access_token;
            const accountIdHeader = auth?.tokens?.account_id;
            if (!accessToken) {
                lastErrorPayload = {
                    error: {
                        message: `账号 ${picked.account.id} 缺少 access_token`,
                        type: "invalid_account_auth"
                    }
                };
                lastStatusCode = 503;
                continue;
            }
            const sendUpstream = async () => await (0, undici_1.request)(`${config.upstream.codex_base_url}/responses`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${accessToken}`,
                    accept: "text/event-stream, application/json",
                    "content-type": "application/json",
                    "user-agent": "codexl/0.1.0",
                    ...(accountIdHeader ? { "chatgpt-account-id": accountIdHeader } : {})
                },
                body: JSON.stringify(requestMessage)
            });
            let upstream = await sendUpstream();
            if (upstream.statusCode === 401) {
                const refreshed = await (0, usage_sync_1.refreshAccountTokens)(picked.account.id);
                accessToken = refreshed.tokens?.access_token ?? accessToken;
                upstream = await sendUpstream();
            }
            if (upstream.statusCode === 429 || upstream.statusCode === 403) {
                const errorText = await upstream.body.text();
                const block = resolveBlockWindow(picked, errorText);
                (0, state_1.setAccountBlock)(picked.account.id, block.until, block.reason);
                lastStatusCode = upstream.statusCode;
                lastErrorPayload = {
                    error: {
                        message: `账号 ${picked.account.id} 受限: ${errorText}`,
                        type: "account_rate_limited"
                    }
                };
                continue;
            }
            if (upstream.statusCode >= 400) {
                const errorText = await upstream.body.text();
                const lowerText = errorText.toLowerCase();
                if (lowerText.includes("usage limit") || lowerText.includes("try again later")) {
                    const block = resolveBlockWindow(picked, errorText);
                    (0, state_1.setAccountBlock)(picked.account.id, block.until, block.reason);
                    lastStatusCode = upstream.statusCode;
                    lastErrorPayload = {
                        error: {
                            message: `账号 ${picked.account.id} 命中额度限制: ${errorText}`,
                            type: "account_usage_limited"
                        }
                    };
                    continue;
                }
                reply.raw.writeHead(upstream.statusCode, {
                    "content-type": "application/json"
                });
                reply.raw.end(errorText);
                return;
            }
            const headers = {};
            const contentType = upstream.headers["content-type"];
            const cacheControl = upstream.headers["cache-control"];
            if (typeof contentType === "string") {
                headers["content-type"] = contentType;
            }
            if (typeof cacheControl === "string") {
                headers["cache-control"] = cacheControl;
            }
            headers.connection = "keep-alive";
            reply.raw.writeHead(upstream.statusCode, headers);
            for await (const chunk of upstream.body) {
                reply.raw.write(chunk);
            }
            reply.raw.end();
            return;
        }
        reply.code(lastStatusCode);
        reply.send(lastErrorPayload);
    };
    app.post("/v1/responses", async (request, reply) => {
        await proxyHandler(request.body, reply);
    });
    app.post("/backend-api/codex/responses", async (request, reply) => {
        await proxyHandler(request.body, reply);
    });
    await app.listen({
        host: config.server.host,
        port: Number.isFinite(port) ? port : config.server.port
    });
}
async function refreshAccountUsageForBestEffort() {
    const statuses = (0, status_1.collectAccountStatuses)();
    const refreshed = [];
    for (const status of statuses) {
        try {
            const item = await (0, usage_sync_1.refreshAccountUsage)(status.id);
            refreshed.push(item);
        }
        catch (error) {
            refreshed.push({
                accountId: status.id,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }
    return refreshed;
}
