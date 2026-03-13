# codex-slot 中文文档

[English README](../README.md)

## 概览

`codex-slot` 是一个本地 `Codex` 多账号 / 多工作空间切换器。

它的目标是：

- 复用官方 `~/.codex` 登录态
- 将多个账号或工作空间作为独立槽位管理
- 在需要时手动刷新 usage 缓存用于状态展示
- 通过本地 provider 给 `Codex` 使用
- 对临时限流、5 小时限制、周限制做本地熔断

## 安装

```bash
npm i -g codex-slot
```

验证：

```bash
codex-slot --help
```

这个 GitHub 仓库仅用于维护源码与文档，不支持直接从仓库 URL 安装。

## 快速开始

1. 导入当前默认 `codex` 登录态：

```bash
codex-slot import current ~
```

`import` 会把官方登录态复制到 `~/.cslot/homes/<name>`，而不是直接引用原始 HOME。
这里的 `current` 只是示例槽位名，不是系统内置账号。

2. 查看最新额度：

```bash
codex-slot status
```

默认会在打印状态表后进入交互模式：

- ↑/↓：选择账号
- 空格：切换启用/禁用（`[x]` 启用，`[ ]` 禁用），并立即保存
- 回车 / `q`：退出交互并回到命令行

若只想输出当前状态，用：

```bash
codex-slot status --no-interactive
```

3. 启动本地代理：

```bash
codex-slot start
codex-slot start --port 4399
```

`start` 会自动把需要的 provider 配置写入 `~/.codex/config.toml`：

```bash
codex-slot start
```

## 命令

```bash
codex-slot add <name>
codex-slot del <name>
codex-slot rename <oldName> <newName>
codex-slot import <name> [HOME]
codex-slot status
codex-slot start [--port <port>]
codex-slot stop
```

常见用法：

- `cslot import work ~/workspace-home`
- `cslot rename work work-main`
- `cslot start`

## 架构

当前项目按职责拆分，避免继续把逻辑堆在单个 CLI 文件里：

- `src/cli.ts`：仅负责 CLI 启动与命令注册
- `src/account-commands.ts`：账号导入、登录、删除命令处理
- `src/account-commands.ts`：同时负责槽位重命名命令处理
- `src/service-control.ts`：后台服务生命周期管理
- `src/status-command.ts`：额度刷新输出与交互式启用开关界面
- `src/codex-config.ts`：受管 `~/.codex/config.toml` 写入与恢复逻辑
- `src/account-store.ts`、`src/usage-sync.ts`、`src/scheduler.ts`、`src/status.ts`：核心领域与运行时逻辑
- `src/text.ts`：共享的中英双语文本与去 locale 化格式化工具

这样可以把 CLI 入口保持得足够薄，同时把易变逻辑下沉到更稳定的模块里。

## `status` 的数据来源

`codex-slot status` 会主动刷新一次 usage，再展示本地最新状态：

1. 从官方登录态读取 `access_token`、`refresh_token`、`account_id`
2. 请求 `https://chatgpt.com/backend-api/wham/usage`
3. 将最新结果写入 `~/.cslot/state.json`
4. 最后读取本地最新缓存并展示

代理转发链路本身不会为了发请求而同步刷新 usage。
实际切换依据是当前本地可用状态与真实请求结果：

- 优先从可用账号里直接发请求
- 若命中 `403`、`429`、`usage limit`，立即标记该账号并切换下一个
- 若请求失败、token 刷新失败或上游 `5xx`，也会做短时熔断，避免连续撞到同一个异常账号

## `start` 会写什么配置

`codex-slot start` 会向 `~/.codex/config.toml` 写入受控的 `cslot` provider 配置：

```toml
[model_providers.cslot]
name = "cslot"
base_url = "http://127.0.0.1:4389/v1"
http_headers = { Authorization = "Bearer <你的本地-api-key>" }
wire_api = "responses"
```

规则：

- 会插入带标记的受管块，分别接管 `model_provider = "cslot"` 与 `[model_providers.cslot]`
- `cslot stop` 会按快照恢复接管前的原始 `model_provider` 行和原始 `[model_providers.cslot]` 配置块
- `config.toml` 里其他 provider 和配置保持不变
- 全局 `model` 不会改
- 如果通过 `cslot start --port <端口>` 指定端口，会把端口写入 `~/.cslot/config.yaml`

## 本地目录

- 配置文件：`~/.cslot/config.yaml`
- 状态缓存：`~/.cslot/state.json`
- 服务 PID：`~/.cslot/cslot.pid`
- 服务日志：`~/.cslot/logs/service.log`

## 限流策略

- 周限制：禁用到周窗口重置时间
- 5 小时限制：禁用到 5 小时窗口重置时间
- 临时限流：先禁用 5 分钟
- 请求失败：先禁用 60 秒
- 上游 `5xx`：先禁用 60 秒
- token 刷新失败 / 认证缺失：先禁用 10 分钟
