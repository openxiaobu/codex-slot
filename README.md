# codex-slot

`codex-slot` is a local multi-account / multi-workspace switcher for Codex.

[中文文档](./docs/zh-CN.md)

## Features

- Reuse the official `~/.codex` login state
- Manage multiple accounts or workspaces as separate slots
- Refresh and cache the latest usage from the official usage endpoint
- Expose a local provider endpoint for Codex
- Apply local block rules for temporary, 5-hour, and weekly limits
- Automatically switch `~/.codex/config.toml` to the `cslot` provider while the local proxy is running (and restore it on stop)

## Installation

```bash
npm i -g codex-slot
```

Verify:

```bash
codex-slot --help
```

This repository is the source repository.
GitHub installation from the repository URL is not supported.

## Quick Start

Import your current Codex login state:

```bash
codex-slot import current ~
```

`import` copies the official login state into `~/.cslot/homes/<name>` instead of referencing the source HOME directly.

Check latest usage:

```bash
codex-slot status
```

By default, `status` will:

- Refresh usage for all managed accounts
- Render a compact table with:
  - Remaining 5-hour / weekly quotas
  - Reset times
  - A status column with local block reasons and countdowns (for example: `5h_limited(2h27m)`)
- Enter an interactive mode where you can toggle `enabled` for accounts:
  - Up/Down: move selection
  - Space: toggle `[x]` enabled / `[ ]` disabled and save immediately
  - Enter / `q`: exit the interactive mode

If you only want a non-interactive snapshot of the current state:

```bash
codex-slot status --no-interactive
```

Start the local proxy:

```bash
codex-slot start
codex-slot start --port 4399
```

`start` will automatically write the required provider config into `~/.codex/config.toml`:

```bash
codex-slot start
```

## Commands

```bash
codex-slot add <name>
codex-slot del <name>
codex-slot import <name> [HOME]
codex-slot status
codex-slot start [--port <port>]
codex-slot stop
```

## How `status` Works

`codex-slot status` does not render stale data from the official `registry.json` cache.

Instead it:

1. Reads `access_token`, `refresh_token`, and `account_id` from the official Codex login state
2. Requests `https://chatgpt.com/backend-api/wham/usage`
3. Stores the latest result in `~/.cslot/state.json`
4. Renders the latest local cache

## Managed Codex Config

`codex-slot start` writes or updates a provider block like this, based on the current `~/.cslot/config.yaml`:

```toml
[model_providers.cslot]
name = "cslot"
base_url = "http://127.0.0.1:4389/v1"
http_headers = { Authorization = "Bearer cslot-defaultkey" }
wire_api = "responses"
```

Behavior:

- If global `model_provider` or `# model_provider = ...` exists, it is normalized to `model_provider = "cslot"`
- If `[model_providers.cslot]` already exists, only that provider block is replaced with the fresh one above
- Other providers and settings in `config.toml` are left untouched
- If you start with `--port`, the port is saved to `~/.cslot/config.yaml`
- `cslot stop` comments out the active `model_provider = "cslot"` line and keeps the rest of the file unchanged

## Data Directory

`codex-slot` uses:

- `~/.cslot/config.yaml`
- `~/.cslot/state.json`
- `~/.cslot/cslot.pid`
- `~/.cslot/logs/service.log`

If you previously used `~/.codexsw`, it is migrated automatically.

## Limit Handling

- Weekly limit: blocked until the weekly reset time
- 5-hour limit: blocked until the 5-hour reset time
- Temporary limit: blocked for 5 minutes

## Repository

- GitHub: https://github.com/openxiaobu/codex-slot
- Issues: https://github.com/openxiaobu/codex-slot/issues

## Development

```bash
npm install
npm run build
npm run check
```
