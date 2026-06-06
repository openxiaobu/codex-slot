import {
  addRelaySlot,
  findRelaySlot,
  listRelaySlots,
  removeRelaySlot,
  renameRelaySlot,
  setRelaySlotEnabled
} from "./relay-store";
import {
  getSelectedCodexAuthAccountId,
  getSelectedModelRoute,
  setSelectedModelRoute
} from "./state";
import { bi } from "./text";

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return "****";
  }

  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function formatModelRoute(): string {
  const route = getSelectedModelRoute();

  if (route.mode === "relay_slot") {
    return `relay:${route.relay_slot_id}`;
  }

  return "auth_pool";
}

/**
 * 新增 OpenAI-compatible relay slot。
 *
 * @param name relay slot 名称。
 * @param options relay 参数，必须包含 baseUrl 与 apiKey。
 * @returns 无返回值。
 * @throws 当 slot 已存在、URL 非法或配置写入失败时抛出异常。
 */
export function handleRelayAdd(
  name: string,
  options: { baseUrl: string; apiKey: string }
): void {
  const slot = addRelaySlot({
    name,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey
  });

  console.log(bi(`已添加中转槽位: ${slot.name}`, `Relay slot added: ${slot.name}`));
}

/**
 * 列出 OpenAI-compatible relay slot。
 *
 * @returns 无返回值。
 * @throws 当配置读取失败时抛出异常。
 */
export function handleRelayList(): void {
  const slots = listRelaySlots();
  const route = getSelectedModelRoute();

  if (slots.length === 0) {
    console.log(bi("当前没有中转槽位。", "No relay slots found."));
    return;
  }

  for (const slot of slots) {
    const selected =
      route.mode === "relay_slot" && route.relay_slot_id === slot.id ? "*" : " ";
    const enabled = slot.enabled ? "enabled" : "disabled";

    console.log(
      `${selected} ${slot.name}  ${enabled}  ${slot.base_url}  key=${maskApiKey(slot.api_key)}`
    );
  }
}

/**
 * 删除 OpenAI-compatible relay slot。
 *
 * @param name relay slot 名称。
 * @returns 无返回值。
 * @throws 当配置写入失败时抛出异常。
 */
export function handleRelayRemove(name: string): void {
  const removed = removeRelaySlot(name);

  if (!removed) {
    console.log(bi(`未找到中转槽位: ${name}`, `Relay slot not found: ${name}`));
    return;
  }

  console.log(bi(`已删除中转槽位: ${name}`, `Relay slot removed: ${name}`));
}

/**
 * 重命名 OpenAI-compatible relay slot。
 *
 * @param oldName 原 slot 名称。
 * @param newName 新 slot 名称。
 * @returns 无返回值。
 * @throws 当旧 slot 不存在、新 slot 已存在或写入失败时抛出异常。
 */
export function handleRelayRename(oldName: string, newName: string): void {
  const slot = renameRelaySlot(oldName, newName);
  console.log(bi(`已重命名中转槽位: ${oldName} -> ${slot.name}`, `Relay slot renamed: ${oldName} -> ${slot.name}`));
}

/**
 * 启用或禁用 OpenAI-compatible relay slot。
 *
 * @param name relay slot 名称。
 * @param enabled 是否启用。
 * @returns 无返回值。
 * @throws 当 slot 不存在或写入失败时抛出异常。
 */
function handleRelayEnabled(name: string, enabled: boolean): void {
  const slot = setRelaySlotEnabled(name, enabled);
  console.log(
    enabled
      ? bi(`已启用中转槽位: ${slot.name}`, `Relay slot enabled: ${slot.name}`)
      : bi(`已禁用中转槽位: ${slot.name}`, `Relay slot disabled: ${slot.name}`)
  );
}

/**
 * 启用 OpenAI-compatible relay slot。
 *
 * @param name relay slot 名称。
 * @returns 无返回值。
 * @throws 当 slot 不存在或写入失败时抛出异常。
 */
export function handleRelayEnable(name: string): void {
  handleRelayEnabled(name, true);
}

/**
 * 禁用 OpenAI-compatible relay slot。
 *
 * @param name relay slot 名称。
 * @returns 无返回值。
 * @throws 当 slot 不存在或写入失败时抛出异常。
 */
export function handleRelayDisable(name: string): void {
  handleRelayEnabled(name, false);
}

/**
 * 将模型请求固定到指定 relay slot。
 *
 * @param name relay slot 名称。
 * @returns 无返回值。
 * @throws 当 relay slot 不存在或状态写入失败时抛出异常。
 */
export function handleUseRelay(name: string): void {
  const slot = findRelaySlot(name);

  if (!slot) {
    throw new Error(bi(`未找到中转槽位 ${name}`, `Relay slot not found: ${name}`));
  }

  if (!slot.enabled) {
    throw new Error(bi(`中转槽位 ${name} 已禁用`, `Relay slot is disabled: ${name}`));
  }

  setSelectedModelRoute({
    mode: "relay_slot",
    relay_slot_id: slot.id
  });
  console.log(bi(`模型请求已固定到中转槽位: ${slot.name}`, `Model route fixed to relay slot: ${slot.name}`));
}

/**
 * 恢复模型请求到官方账号自动调度池。
 *
 * @returns 无返回值。
 * @throws 当状态写入失败时抛出异常。
 */
export function handleUseAuthPool(): void {
  setSelectedModelRoute({
    mode: "auth_pool"
  });
  console.log(bi("模型请求已恢复官方账号池。", "Model route restored to auth pool."));
}

/**
 * 输出当前模型出口与 Codex App 登录态选择。
 *
 * @returns 无返回值。
 * @throws 当状态读取失败时抛出异常。
 */
export function handleCurrent(): void {
  console.log(`model_route=${formatModelRoute()}`);
  console.log(`codex_auth=${getSelectedCodexAuthAccountId() ?? "none"}`);
}
