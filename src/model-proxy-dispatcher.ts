import type { IncomingHttpHeaders } from "node:http";
import { proxyCodexWithRetry } from "./proxy-retry-service";
import { proxyRelaySlot } from "./relay-proxy-service";
import { findRelaySlot } from "./relay-store";
import { getSelectedModelRoute } from "./state";
import type { ModelRouteSelection, RelaySlot } from "./types";

interface ModelProxyRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body?: Buffer;
}

interface ModelProxyDependencies {
  getSelectedModelRoute: () => ModelRouteSelection;
  findRelaySlot: (slotId: string) => RelaySlot | null;
  proxyCodexWithRetry: typeof proxyCodexWithRetry;
  proxyRelaySlot: typeof proxyRelaySlot;
}

export type ModelProxyResult = Awaited<ReturnType<typeof proxyCodexWithRetry>>;

function buildSendResult(
  statusCode: number,
  payload: unknown,
  headers?: Record<string, string>
): ModelProxyResult {
  return {
    type: "send",
    statusCode,
    payload,
    headers
  };
}

/**
 * 创建 `/v1/*` 模型请求分发器。
 *
 * 业务含义：
 * 1. 默认 `auth_pool` 模式保持原有官方账号自动调度行为。
 * 2. 手动选择 `relay_slot` 后，模型请求固定走该 relay slot。
 * 3. relay 模式不影响 `/backend-api/*` 插件链路，也不会失败回退官方账号。
 *
 * @param overrides 可选依赖覆盖项。
 * @returns 模型请求分发器实例。
 * @throws 无显式抛出。
 */
export function createModelProxyDispatcher(overrides?: Partial<ModelProxyDependencies>): {
  proxyModelWithRoute: (request: ModelProxyRequest) => Promise<ModelProxyResult>;
} {
  const dependencies: ModelProxyDependencies = {
    getSelectedModelRoute,
    findRelaySlot,
    proxyCodexWithRetry,
    proxyRelaySlot,
    ...overrides
  };

  return {
    async proxyModelWithRoute(request: ModelProxyRequest): Promise<ModelProxyResult> {
      const route = dependencies.getSelectedModelRoute();

      if (route.mode !== "relay_slot") {
        return await dependencies.proxyCodexWithRetry(request);
      }

      const slot = dependencies.findRelaySlot(route.relay_slot_id);
      if (!slot) {
        return buildSendResult(503, {
          error: {
            message: `Relay slot not found: ${route.relay_slot_id}`,
            type: "relay_slot_not_found"
          }
        });
      }

      if (!slot.enabled) {
        return buildSendResult(503, {
          error: {
            message: `Relay slot is disabled: ${route.relay_slot_id}`,
            type: "relay_slot_disabled"
          }
        });
      }

      return await dependencies.proxyRelaySlot({
        slot,
        request
      });
    }
  };
}

export const { proxyModelWithRoute } = createModelProxyDispatcher();
