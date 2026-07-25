export interface VoiceCallBinding {
  callId: string;
  accountId: string;
  codexHome: string;
  createdAt: number;
}

const DEFAULT_BINDING_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BINDINGS = 1024;

/**
 * 保存 Voice call 与官方账号之间的进程内绑定关系。
 *
 * 业务含义：
 * 1. WebRTC call 由 HTTP 请求创建，sideband WebSocket 随后通过 call id 加入同一会话。
 * 2. 两段请求必须固定使用同一个官方账号，不能再次经过多账号调度。
 * 3. 绑定只服务于短生命周期的本地 Voice 会话，不写入磁盘。
 */
export class VoiceCallBindingStore {
  private readonly bindings = new Map<string, VoiceCallBinding>();

  /**
   * 创建 Voice call 绑定存储。
   *
   * @param ttlMs 单条绑定的存活毫秒数；必须大于 0。
   * @param maxBindings 最多保留的绑定数量；达到上限时淘汰最早创建的绑定。
   * @param now 返回当前 Unix 毫秒时间戳的函数，默认使用 `Date.now`。
   * @throws 当 `ttlMs` 或 `maxBindings` 不是正数时抛出参数错误。
   */
  constructor(
    private readonly ttlMs = DEFAULT_BINDING_TTL_MS,
    private readonly maxBindings = DEFAULT_MAX_BINDINGS,
    private readonly now: () => number = Date.now
  ) {
    if (ttlMs <= 0 || maxBindings <= 0) {
      throw new Error("Voice call binding limits must be positive");
    }
  }

  /**
   * 记录一次成功创建的 Voice call 账号绑定。
   *
   * @param binding 待保存的 call id、账号、账号 HOME 与创建时间。
   * @returns 无返回值。
   * @throws 无显式抛出。
   */
  remember(binding: VoiceCallBinding): void {
    this.pruneExpired();

    if (!this.bindings.has(binding.callId) && this.bindings.size >= this.maxBindings) {
      const oldestCallId = this.bindings.keys().next().value as string | undefined;
      if (oldestCallId) {
        this.bindings.delete(oldestCallId);
      }
    }

    this.bindings.delete(binding.callId);
    this.bindings.set(binding.callId, binding);
  }

  /**
   * 按 call id 读取仍有效的账号绑定。
   *
   * @param callId 上游 `Location` 响应头中返回的 Voice call id。
   * @returns 有效绑定；不存在或已过期时返回 `null`。
   * @throws 无显式抛出。
   */
  get(callId: string): VoiceCallBinding | null {
    this.pruneExpired();
    return this.bindings.get(callId) ?? null;
  }

  /**
   * 在 Voice sideband 会话结束后释放指定绑定。
   *
   * @param callId 已结束会话的 Voice call id。
   * @returns 删除成功时返回 `true`，绑定不存在时返回 `false`。
   * @throws 无显式抛出。
   */
  release(callId: string): boolean {
    return this.bindings.delete(callId);
  }

  /**
   * 返回当前仍有效的绑定数量，供测试和运行状态诊断使用。
   *
   * @returns 未过期绑定数量。
   * @throws 无显式抛出。
   */
  size(): number {
    this.pruneExpired();
    return this.bindings.size;
  }

  /**
   * 清理超过 TTL 的绑定，避免未建立 WebSocket 的 call 长期占用内存。
   *
   * @returns 无返回值。
   * @throws 无显式抛出。
   */
  private pruneExpired(): void {
    const expiredBefore = this.now() - this.ttlMs;

    for (const [callId, binding] of this.bindings) {
      if (binding.createdAt <= expiredBefore) {
        this.bindings.delete(callId);
      }
    }
  }
}
