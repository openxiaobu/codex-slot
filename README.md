# codex-slot

`codex-slot` is a local multi-account / multi-workspace switcher for Codex.

[中文文档](./docs/zh-CN.md)

## Overview

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

1. Import your current Codex login state:

```bash
codex-slot import current ~
```

`import` copies the official login state into `~/.cslot/homes/<name>` instead of referencing the source HOME directly.
`current` is only an example slot name, not a built-in account or workspace.

2. Check the latest usage:

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

3. Start the local proxy:

```bash
codex-slot start
codex-slot start --port 4399
```

`start` will automatically write the required provider config into `~/.codex/config.toml`.
It prefers port `4399` by default and will switch to the next available port automatically when `4399` is busy:
Each start also generates a fresh local `api_key` and syncs it into the managed provider config.

```bash
codex-slot start
```

## Commands

```bash
codex-slot add <name>
codex-slot del <name>
codex-slot rename <oldName> <newName>
codex-slot import <name> [HOME]
codex-slot status
codex-slot start [--port <port>]
codex-slot stop
```

Common patterns:

- `cslot import work ~/workspace-home`
- `cslot rename work work-main`
- `cslot start`

## Architecture

The project is intentionally split by responsibility:

- `src/cli.ts`: CLI bootstrap and command registration only
- `src/account-commands.ts`: account import, login, remove command handlers
- `src/account-commands.ts`: also owns slot rename command handling
- `src/service-control.ts`: background service lifecycle management
- `src/status-command.ts`: usage refresh output and interactive toggle UI
- `src/codex-config.ts`: managed `~/.codex/config.toml` apply/restore logic
- `src/account-store.ts`, `src/usage-sync.ts`, `src/scheduler.ts`, `src/status.ts`: core domain and runtime logic
- `src/text.ts`: shared bilingual text and locale-independent formatting helpers

This keeps the CLI entry thin while preserving stable behavior in the lower-level modules.

## How `status` Works

`codex-slot status` does not render stale data from the official `registry.json` cache.

Instead it:

1. Reads `access_token`, `refresh_token`, and `account_id` from the official Codex login state
2. Requests `https://chatgpt.com/backend-api/wham/usage`
3. Stores the latest result in `~/.cslot/state.json`
4. Renders the latest local cache

## Managed Codex Config

`codex-slot start` writes or updates a managed provider block like this, based on the current `~/.cslot/config.yaml`:

```toml
[model_providers.cslot]
name = "cslot"
base_url = "http://127.0.0.1:4399/v1"
http_headers = { Authorization = "Bearer <your-local-api-key>" }
wire_api = "responses"
```

Behavior:

- A managed marker block is inserted for `model_provider = "cslot"` and `[model_providers.cslot]`
- On `cslot stop`, the original `model_provider` line and original `[model_providers.cslot]` block are restored from the saved snapshot
- Other providers and settings in `config.toml` are left untouched
- If you start with `--port`, the port is saved to `~/.cslot/config.yaml`
- If you start without `--port`, `4399` is preferred first and the next free port is chosen automatically on conflict
- Every `start` rotates the local `api_key`, and the new value is written to both `~/.cslot/config.yaml` and the managed provider block

## Data Directory

`codex-slot` uses:

- `~/.cslot/config.yaml`
- `~/.cslot/state.json`
- `~/.cslot/cslot.pid`
- `~/.cslot/logs/service.log`

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
