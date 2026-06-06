import { loadConfig, saveConfig } from "./config";
import { getSelectedModelRoute, setSelectedModelRoute, updateState } from "./state";
import { bi } from "./text";
import type { RelaySlot } from "./types";

/**
 * 列出所有 OpenAI-compatible relay 槽位。
 *
 * @returns 当前配置中的 relay slot 列表。
 * @throws 当配置读取失败时抛出异常。
 */
export function listRelaySlots(): RelaySlot[] {
  return loadConfig().relay_slots;
}

/**
 * 查找指定 relay slot。
 *
 * @param slotId relay slot 标识。
 * @returns 命中时返回 slot；不存在时返回 `null`。
 * @throws 当配置读取失败时抛出异常。
 */
export function findRelaySlot(slotId: string): RelaySlot | null {
  return listRelaySlots().find((item) => item.id === slotId) ?? null;
}

/**
 * 新增一个 OpenAI-compatible relay slot。
 *
 * @param input relay slot 配置。
 * @returns 新增后的 relay slot。
 * @throws 当同名 slot 已存在或配置写入失败时抛出异常。
 */
export function addRelaySlot(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
}): RelaySlot {
  const config = loadConfig();

  if (config.relay_slots.some((item) => item.id === input.name)) {
    throw new Error(bi(`中转槽位 ${input.name} 已存在`, `Relay slot already exists: ${input.name}`));
  }

  try {
    new URL(input.baseUrl);
  } catch {
    throw new Error(bi(`中转 base_url 非法: ${input.baseUrl}`, `Invalid relay base_url: ${input.baseUrl}`));
  }

  const slot: RelaySlot = {
    id: input.name,
    name: input.name,
    base_url: input.baseUrl,
    api_key: input.apiKey,
    enabled: true,
    imported_at: new Date().toISOString()
  };

  config.relay_slots.push(slot);
  saveConfig(config);
  return slot;
}

/**
 * 删除指定 relay slot，并在当前模型出口指向它时恢复官方账号池。
 *
 * @param slotId relay slot 标识。
 * @returns 被删除的 slot；不存在时返回 `null`。
 * @throws 当配置或状态写入失败时抛出异常。
 */
export function removeRelaySlot(slotId: string): RelaySlot | null {
  const config = loadConfig();
  const index = config.relay_slots.findIndex((item) => item.id === slotId);

  if (index < 0) {
    return null;
  }

  const [removed] = config.relay_slots.splice(index, 1);
  saveConfig(config);

  const route = getSelectedModelRoute();
  if (route.mode === "relay_slot" && route.relay_slot_id === slotId) {
    setSelectedModelRoute({ mode: "auth_pool" });
  }

  return removed;
}

/**
 * 重命名 relay slot，并迁移当前模型出口选择。
 *
 * @param oldName 原 slot 标识。
 * @param newName 新 slot 标识。
 * @returns 重命名后的 relay slot。
 * @throws 当旧 slot 不存在、新 slot 已存在或写入失败时抛出异常。
 */
export function renameRelaySlot(oldName: string, newName: string): RelaySlot {
  const config = loadConfig();
  const index = config.relay_slots.findIndex((item) => item.id === oldName);

  if (index < 0) {
    throw new Error(bi(`未找到中转槽位 ${oldName}`, `Relay slot not found: ${oldName}`));
  }

  if (config.relay_slots.some((item) => item.id === newName)) {
    throw new Error(bi(`中转槽位 ${newName} 已存在`, `Relay slot already exists: ${newName}`));
  }

  const renamed: RelaySlot = {
    ...config.relay_slots[index],
    id: newName,
    name: newName
  };

  config.relay_slots[index] = renamed;
  saveConfig(config);

  updateState((state) => {
    if (
      state.selected_model_route?.mode === "relay_slot" &&
      state.selected_model_route.relay_slot_id === oldName
    ) {
      state.selected_model_route = {
        mode: "relay_slot",
        relay_slot_id: newName
      };
    }
  });

  return renamed;
}

/**
 * 更新 relay slot 启用状态。
 *
 * @param slotId relay slot 标识。
 * @param enabled 是否启用。
 * @returns 更新后的 relay slot。
 * @throws 当 slot 不存在或配置写入失败时抛出异常。
 */
export function setRelaySlotEnabled(slotId: string, enabled: boolean): RelaySlot {
  const config = loadConfig();
  const index = config.relay_slots.findIndex((item) => item.id === slotId);

  if (index < 0) {
    throw new Error(bi(`未找到中转槽位 ${slotId}`, `Relay slot not found: ${slotId}`));
  }

  const updated: RelaySlot = {
    ...config.relay_slots[index],
    enabled
  };

  config.relay_slots[index] = updated;
  saveConfig(config);
  return updated;
}
