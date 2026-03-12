# codexl CLI Help

安装：

```bash
npm i -g @openxiaobu/codexl
```

## 命令

```bash
codexl add <名字>
codexl del <名字>
codexl import <名字> [HOME]
codexl status
codexl start [--port 端口]
codexl stop
codexl get
codexl config [codex配置目录]
```

## 命令说明

- `codexl add <名字>`
  - 打开官方 `codex login`
  - 用独立 HOME 登录一个账号或工作空间

- `codexl del <名字>`
  - 删除一个已录入账号的配置

- `codexl import <名字> [HOME]`
  - 导入当前或指定 HOME 下已有的官方 `codex` 登录态
  - 例如导入当前默认账号：
  ```bash
  codexl import current ~
  ```

- `codexl status`
  - 先刷新远端最新额度
  - 再写入 `~/.codexl/state.json`
  - 最后展示所有已录入账号/工作空间的 plan、5 小时额度、周额度、重置时间、可用状态

- `codexl start`
  - 后台启动本地代理服务
  - 可选 `--port` 指定端口
  - 指定后会持久化到 `~/.codexl/config.yaml`

- `codexl stop`
  - 停止后台代理服务

- `codexl get`
  - 输出当前本地 `base_url`
  - 输出当前本地 `api_key`

- `codexl config [codex配置目录]`
  - 自动写入 `codex` 的 `config.toml`
  - 默认写入 `~/.codex/config.toml`
  - 也可以传入目录或完整 toml 文件路径
  - 直接把固定 `Authorization` 头写进配置，不依赖环境变量
  - 如果已存在全局 `model_provider`，会改成 `codexl`
  - 如果 `model_provider` 是注释状态，也会直接打开并改成 `codexl`
  - 不会修改当前全局 `model`
  - 如果原来没有全局 `model_provider`，会自动补一行 `model_provider = "codexl"`

## 常用流程

### 1. 导入当前账号

```bash
codexl import current ~
codexl status
```

### 2. 新增其他工作空间或账号

```bash
codexl add ws1
codexl add ws2
codexl status
```

### 3. 启动本地代理并写配置

```bash
codexl start
codexl get
codexl config
```

### 4. 停止本地代理

```bash
codexl stop
```

## 本地文件

- 配置文件：`~/.codexl/config.yaml`
- 熔断状态：`~/.codexl/state.json`
- 最新额度缓存：`~/.codexl/state.json`
- 服务 PID：`~/.codexl/codexl.pid`
- 服务日志：`~/.codexl/logs/service.log`
