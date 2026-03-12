# codexl

Local multi-account / multi-workspace switcher for Codex.

`codexl` 是一个本地 `Codex` 多账号 / 多工作空间切换器。

## Overview

English:

- Reuse the official `~/.codex` login state
- Manage multiple accounts or workspaces as separate slots
- Fetch the latest usage from the official usage endpoint
- Expose a local provider endpoint for Codex
- Apply local cooldown rules for temporary, 5-hour, and weekly limits

中文：

- 复用官方 `~/.codex` 登录态
- 将多个账号或工作空间作为独立槽位管理
- 直接调用官方 usage 接口获取最新额度
- 暴露本地 provider 给 `Codex` 使用
- 对临时限流、5 小时限制、周限制做本地熔断

## Install

```bash
npm i -g codexl
```

Verify:

```bash
codexl --help
```

## Quick Start

1. Import your current Codex login state

```bash
codexl import current ~
```

2. Check latest usage

```bash
codexl status
```

3. Start the local proxy

```bash
codexl start
```

Custom port:

```bash
codexl start --port 4399
```

4. Show current local endpoint and key

```bash
codexl get
```

5. Write provider config into `~/.codex/config.toml`

```bash
codexl config
```

## Commands

```bash
codexl add <name>
codexl del <name>
codexl import <name> [HOME]
codexl status
codexl start [--port <port>]
codexl stop
codexl get
codexl config [codexPath]
```

More details: [HELP.md](./HELP.md)

## How `status` Works

English:

1. Read `access_token` / `refresh_token` / `account_id` from the official Codex login state
2. Request `https://chatgpt.com/backend-api/wham/usage`
3. Store the latest result in `~/.codexl/state.json`
4. Render the latest local cache

中文：

1. 从官方登录态中读取 `access_token` / `refresh_token` / `account_id`
2. 请求 `https://chatgpt.com/backend-api/wham/usage`
3. 将最新结果写入 `~/.codexl/state.json`
4. 最后读取本地最新缓存进行展示

## Generated Codex Config

`codexl config` writes a managed provider block like this:

```toml
# >>> codexl managed start >>>
[model_providers.codexl]
name = "codexl"
base_url = "http://127.0.0.1:4389/v1"
http_headers = { Authorization = "Bearer codexl-defaultkey" }
wire_api = "responses"
# <<< codexl managed end <<<
```

Rules:

- If `[model_providers.codexl]` already exists, it is replaced
- If global `model_provider` exists, it is changed to `codexl`
- If commented `# model_provider = ...` exists, it is reopened as `model_provider = "codexl"`
- Global `model` is kept unchanged
- If you start with `--port`, the port is saved to `~/.codexl/config.yaml`, and later `get` / `config` will use that port

## Data Directory

`codexl` uses:

- `~/.codexl/config.yaml`
- `~/.codexl/state.json`
- `~/.codexl/codexl.pid`
- `~/.codexl/logs/service.log`

If you previously used `~/.codexsw`, it will be migrated automatically.

## Limit Handling

English:

- Weekly limit: blocked until weekly reset time
- 5-hour limit: blocked until 5-hour reset time
- Temporary limit: blocked for 5 minutes

中文：

- 周限制：禁用到周窗口重置时间
- 5 小时限制：禁用到 5 小时窗口重置时间
- 临时限流：先禁用 5 分钟

## Repository

- GitHub: https://github.com/openxiaobu/codexl
- Issues: https://github.com/openxiaobu/codexl/issues

## Development

```bash
npm install
npm run build
npm run check
```
