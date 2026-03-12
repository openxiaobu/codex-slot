# codexl

`codexl` is a local multi-account / multi-workspace switcher for Codex.

[中文文档](./docs/zh-CN.md)

## Features

- Reuse the official `~/.codex` login state
- Manage multiple accounts or workspaces as separate slots
- Fetch the latest usage from the official usage endpoint
- Expose a local provider endpoint for Codex
- Apply local block rules for temporary, 5-hour, and weekly limits
- Automatically switch `~/.codex/config.toml` to the `codexl` provider while the local proxy is running

## Installation

```bash
npm i -g @openxiaobu/codexl
```

Verify:

```bash
codexl --help
```

This repository is the source repository.
GitHub installation from the repository URL is not supported.

## Quick Start

Import your current Codex login state:

```bash
codexl import current ~
```

`import` copies the official login state into `~/.codexl/homes/<name>` instead of referencing the source HOME directly.

Check latest usage:

```bash
codexl status
```

Start the local proxy:

```bash
codexl start
codexl start --port 4399
```

`start` will automatically write the required provider config into `~/.codex/config.toml`:

```bash
codexl start
```

## Commands

```bash
codexl add <name>
codexl del <name>
codexl import <name> [HOME]
codexl status
codexl start [--port <port>]
codexl stop
```

## How `status` Works

`codexl status` does not render stale data from the official `registry.json` cache.

Instead it:

1. Reads `access_token`, `refresh_token`, and `account_id` from the official Codex login state
2. Requests `https://chatgpt.com/backend-api/wham/usage`
3. Stores the latest result in `~/.codexl/state.json`
4. Renders the latest local cache

## Managed Codex Config

`codexl start` writes a managed provider block like this:

```toml
# >>> codexl managed start >>>
[model_providers.codexl]
name = "codexl"
base_url = "http://127.0.0.1:4389/v1"
http_headers = { Authorization = "Bearer codexl-defaultkey" }
wire_api = "responses"
# <<< codexl managed end <<<
```

Behavior:

- If `[model_providers.codexl]` already exists, it is replaced
- If global `model_provider` exists, it is changed to `codexl`
- If commented `# model_provider = ...` exists, it is reopened as `model_provider = "codexl"`
- Global `model` is kept unchanged
- If you start with `--port`, the port is saved to `~/.codexl/config.yaml`
- `codexl stop` comments out the active `model_provider = "codexl"` line and keeps the rest of the file unchanged

## Data Directory

`codexl` uses:

- `~/.codexl/config.yaml`
- `~/.codexl/state.json`
- `~/.codexl/codexl.pid`
- `~/.codexl/logs/service.log`

If you previously used `~/.codexsw`, it is migrated automatically.

## Limit Handling

- Weekly limit: blocked until the weekly reset time
- 5-hour limit: blocked until the 5-hour reset time
- Temporary limit: blocked for 5 minutes

## Repository

- GitHub: https://github.com/openxiaobu/codexl
- Issues: https://github.com/openxiaobu/codexl/issues

## Development

```bash
npm install
npm run build
npm run check
```
