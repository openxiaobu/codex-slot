# codexl

`codexl` 是一个本地 `Codex` 多账号 / 多工作空间切换器。

它的目标很简单：

- 复用官方 `~/.codex` 登录态
- 为多个账号或工作空间单独建槽位
- 直接调用官方 usage 接口获取最新额度
- 在本地代理里自动挑选可用账号
- 当账号命中限制时，按 5 分钟、5 小时、周限制做本地熔断

## Features

- 多账号或多工作空间隔离登录
- 默认只读官方 `~/.codex` 登录态与基础账号信息
- 最新额度只写入 `~/.codexl/state.json`
- 本地代理兼容 `Responses API` 风格入口
- 自动写入 `~/.codex/config.toml`

GitHub:

- Repository: https://github.com/openxiaobu/codexl
- Issues: https://github.com/openxiaobu/codexl/issues

## Quick Start

安装：

```bash
npm i -g openxiaobu/codexl
```

确认命令可用：

```bash
codexl --help
```

说明：

- GitHub 安装直接使用仓库中已构建的 `dist/`，不依赖本地 TypeScript。

导入当前默认 `codex` 登录态：

```bash
codexl import current ~
```

新增其他账号或工作空间：

```bash
codexl add ws1
codexl add ws2
```

刷新并查看最新额度：

```bash
codexl status
```

启动本地代理：

```bash
codexl start
codexl start --port 4399
```

获取当前代理地址和 key：

```bash
codexl get
```

自动写入 `codex` 配置：

```bash
codexl config
```

## Commands

```bash
codexl add <name>
codexl del <name>
codexl import <name> [HOME]
codexl status
codexl start [--port 端口]
codexl stop
codexl get
codexl config [codexPath]
```

命令说明见 [HELP.md](./HELP.md)。

## What `status` Reads

`codexl status` 的数据来源不是官方 `registry.json` 缓存，而是：

1. 从官方登录态读取 `access_token` / `refresh_token` / `account_id`
2. 调用 `https://chatgpt.com/backend-api/wham/usage`
3. 将最新结果写入 `~/.codexl/state.json`
4. 最后读取 `~/.codexl/state.json` 展示

因此：

- 官方 `~/.codex` 主要用于读取登录态
- `~/.codexl` 才是 `codexl` 自己的配置和状态目录

## Generated Codex Config

`codexl config` 默认会向 `~/.codex/config.toml` 写入一段托管配置：

```toml
# >>> codexl managed start >>>
[model_providers.codexl]
name = "codexl"
base_url = "http://127.0.0.1:4389/v1"
http_headers = { Authorization = "Bearer codexl-defaultkey" }
wire_api = "responses"
# <<< codexl managed end <<<
```

如果已有旧的 `[model_providers.codexl]` 配置，`codexl config` 会直接替换成新的托管块。

如果已经存在全局 `model_provider`，`codexl config` 会将其改成 `codexl`。

如果存在被注释的 `# model_provider = ...`，`codexl config` 也会直接打开并改成 `model_provider = "codexl"`。

全局 `model` 不会被修改。

如果原来没有全局 `model_provider`，`codexl config` 会自动补上一行：

```toml
model_provider = "codexl"
```

如果你通过 `codexl start --port <端口>` 指定端口，这个端口会写回 `~/.codexl/config.yaml`，后续 `codexl get` 和 `codexl config` 会使用该端口。

## Data Directory

`codexl` 默认使用：

- 配置文件：`~/.codexl/config.yaml`
- 状态缓存：`~/.codexl/state.json`
- 服务 PID：`~/.codexl/codexl.pid`
- 服务日志：`~/.codexl/logs/service.log`

如果你之前用的是 `~/.codexsw`，启动时会自动迁移到 `~/.codexl`。

## Limit Handling

当上游返回限制信号时：

- 周限制：禁用到周窗口重置时间
- 5 小时限制：禁用到 5 小时窗口重置时间
- 模糊限流：先本地禁用 5 分钟

本地熔断状态会持久化到 `~/.codexl/state.json`。

## Development

```bash
npm install
npm run build
npm run check
```
