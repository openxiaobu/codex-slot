# codexl 中文文档

[English README](../README.md)

## 简介

`codexl` 是一个本地 `Codex` 多账号 / 多工作空间切换器。

它的目标是：

- 复用官方 `~/.codex` 登录态
- 将多个账号或工作空间作为独立槽位管理
- 调用官方 usage 接口获取最新额度
- 通过本地 provider 给 `Codex` 使用
- 对临时限流、5 小时限制、周限制做本地熔断

## 安装

```bash
npm i -g @openxiaobu/codexl
```

验证：

```bash
codexl --help
```

这个 GitHub 仓库仅用于维护源码与文档，不支持直接从仓库 URL 安装。

## 快速开始

导入当前默认 `codex` 登录态：

```bash
codexl import current ~
```

`import` 会把官方登录态复制到 `~/.codexl/homes/<name>`，而不是直接引用原始 HOME。

查看最新额度：

```bash
codexl status
```

启动本地代理：

```bash
codexl start
codexl start --port 4399
```

`start` 会自动把需要的 provider 配置写入 `~/.codex/config.toml`：

```bash
codexl start
```

## 命令

```bash
codexl add <name>
codexl del <name>
codexl import <name> [HOME]
codexl status
codexl start [--port <port>]
codexl stop
```

## `status` 的数据来源

`codexl status` 不是直接展示官方 `registry.json` 的旧缓存，而是：

1. 从官方登录态读取 `access_token`、`refresh_token`、`account_id`
2. 请求 `https://chatgpt.com/backend-api/wham/usage`
3. 将最新结果写入 `~/.codexl/state.json`
4. 最后读取本地最新缓存并展示

## `start` 会写什么配置

`codexl start` 默认会向 `~/.codex/config.toml` 写入：

```toml
# >>> codexl managed start >>>
[model_providers.codexl]
name = "codexl"
base_url = "http://127.0.0.1:4389/v1"
http_headers = { Authorization = "Bearer codexl-defaultkey" }
wire_api = "responses"
# <<< codexl managed end <<<
```

规则：

- 如果已有 `[model_providers.codexl]`，会直接替换
- 如果全局 `model_provider` 已存在，会改成 `codexl`
- 如果只有注释的 `# model_provider = ...`，也会被打开并改成 `codexl`
- 全局 `model` 不会改
- 如果通过 `codexl start --port <端口>` 指定端口，会把端口写入 `~/.codexl/config.yaml`
- `codexl stop` 只会把当前生效的 `model_provider = "codexl"` 注释掉，其他配置保持不变

## 本地目录

- 配置文件：`~/.codexl/config.yaml`
- 状态缓存：`~/.codexl/state.json`
- 服务 PID：`~/.codexl/codexl.pid`
- 服务日志：`~/.codexl/logs/service.log`

如果你之前使用的是 `~/.codexsw`，启动时会自动迁移到 `~/.codexl`。

## 限流策略

- 周限制：禁用到周窗口重置时间
- 5 小时限制：禁用到 5 小时窗口重置时间
- 临时限流：先禁用 5 分钟
