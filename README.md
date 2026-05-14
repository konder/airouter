# AI Router

本地 AI API 网关 — 把多个上游 LLM provider（订阅 + 按量 key）汇聚成一个统一的 base URL，对外暴露 OpenAI 和 Anthropic 双格式端点。配带 TUI、自动 failover、加权负载均衡、按 group 路由。

## 功能特性

- **双格式端点**：同一个 daemon 同时提供 OpenAI（`/v1/chat/completions`）和 Anthropic（`/v1/messages`）两种 API
- **跨格式转换**：客户端用 OpenAI 格式调用 Anthropic 上游 / 反之亦可，请求、非流式响应、SSE 流均自动互转
- **多上游 + 分组**：每个上游归属一个 `group`（如 `glm` / `claude`），按 group 内权重做负载均衡
- **智能路由**：
  - 客户端 `model` 字段 == group 名 → 命中该 group
  - 客户端 `model` 字段含 `claude` 子串 → 优先 `claude` group（如存在）
  - 否则走 `defaultGroup` 或 `defaultUpstream`
- **健康熔断**：连续失败超阈值 → 标记 unhealthy + 冷却期内不路由，自动试探恢复
- **失败重试**：网络错误 / 5xx / 429 自动换上游重试，4xx 不重试
- **TUI 管理界面**：终端全屏看板，含 Activity 时序图（Braille 字符渲染 token 用量）
- **CLI**：`airouter daemon start/stop/status/restart/logs` + `airouter tui`
- **客户端 fingerprint 透传**：`user-agent` / `anthropic-beta` / `x-stainless-*` 等保留，配合 Claude Code / Cursor 等

## 安装

### 从 GitHub 安装（推荐）

```bash
npm install -g git+https://github.com/konder/airouter.git
```

`prepare` 钩子会自动 `npm run build`，装完即可用 `airouter` 命令。

### 从源码安装

```bash
git clone https://github.com/konder/airouter.git
cd airouter
npm install
npm run build
npm link    # 把 airouter 命令链到 PATH
```

## 快速开始

1. 启动 daemon：

   ```bash
   airouter daemon start
   ```

   首次启动会在 `~/.airouter/` 下创建 `config.yaml`、`airouter.pid`、`airouter.log`。

2. 打开 TUI 配上游：

   ```bash
   airouter tui
   ```

   按 `[a]` 添加上游 — Type / Auth Style 是选项菜单，其它字段是文本框。

3. 客户端指向本地：

   ```bash
   # OpenAI 兼容客户端
   export OPENAI_API_BASE=http://localhost:3000/v1
   export OPENAI_API_KEY=any-string

   # Claude Code / Anthropic SDK
   export ANTHROPIC_BASE_URL=http://localhost:3000
   export ANTHROPIC_API_KEY=any-string
   ```

   本地 daemon 不校验 client key，随便填。

## CLI

```
airouter daemon [start]        启动后台 daemon
airouter daemon stop           停止
airouter daemon status         查看状态
airouter daemon restart        重启
airouter daemon logs [-f]      查看日志（-f 跟随）
airouter tui                   打开终端管理界面
airouter --version             版本
```

运行时文件在 `~/.airouter/`：`config.yaml` / `keys.yaml` / `airouter.pid` / `airouter.log`。

## 客户端鉴权

Daemon 默认对 `/v1/*` 强制鉴权 — 客户端发的 `Authorization: Bearer <key>` 或 `x-api-key: <key>` 必须在 `~/.airouter/keys.yaml` 里。`/admin/*` 不鉴权（监听 127.0.0.1）。

**首次启动**：如果没有 `keys.yaml`，daemon 自动颁发一个 `default` key 并打印到日志：

```
[airouter] No client API keys found — issued default key:
[airouter]   air_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
[airouter] Save it now. Future starts will not print it again.
```

之后通过 TUI 管理：`airouter tui` → `[k]` 进入 keys 页面 → `[a]` 颁发新 key（**完整值只在弹窗显示一次**） / `[d]` 撤销。

> **从老版本升级**：原本 daemon 接受任意字符串作为 key，升级后会拒绝。把客户端的 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 换成日志里那个 `air_xxx`，或自己用 TUI 颁一个新的。

REST：

```bash
curl http://localhost:3000/admin/keys                    # 列出（masked）
curl -X POST http://localhost:3000/admin/keys -d '{"name":"my-laptop"}' -H 'Content-Type: application/json'   # 颁发
curl -X DELETE http://localhost:3000/admin/keys/my-laptop  # 撤销
```

## 配置

`~/.airouter/config.yaml`：

```yaml
server:
  port: 3000
  host: 127.0.0.1

upstreams:
  - name: bailian
    type: openai
    baseurl: https://dashscope.aliyuncs.com/compatible-mode/v1
    key: sk-xxx
    model: qwen-max          # 实际发送给 provider 的 model id
    group: glm               # 同 group 的上游一起做负载均衡
    weight: 1
    enabled: true

routing:
  strategy: load-balance     # load-balance | rules | manual
  defaultGroup: glm          # 没匹配到时的兜底 group
  defaultUpstream: bailian   # manual 策略下的固定上游
  failover:
    enabled: true
    maxRetries: 2
    timeout: 600000
    healthThreshold: 3       # 连续失败 N 次 → unhealthy
    cooldownMs: 30000        # unhealthy 后冷却 N ms 再试探
```

### 上游字段

| 字段 | 说明 | 必填 |
|---|---|---|
| `name` | 唯一标识 | ✓ |
| `type` | `openai` 或 `anthropic` | ✓ |
| `baseurl` | 上游 API 根地址 | ✓ |
| `key` | API key | ✓ |
| `model` | 实际发给 provider 的 model id（覆盖 client 的 model 字段） | ✓ |
| `group` | 逻辑分组，用于路由 | |
| `weight` | 负载均衡权重 | 默认 1 |
| `enabled` | 启用 | 默认 true |
| `authStyle` | 仅 anthropic 类型：`x-api-key`（默认）或 `bearer` | |

> 客户端请求体里的 `model` 字段**不直接发给 provider**，只用来做 group 路由。同 provider 想跑多个 model，给每个 model 配独立 upstream 条目（`group` 取相同名字）。

### 路由策略

| 策略 | 行为 |
|---|---|
| `load-balance` | 在候选 group 内按 weight 加权轮询，相同累计权重时按平均延迟挑更快的 |
| `rules` | 按 header 匹配规则；未命中回退到 load-balance |
| `manual` | 永远走 `defaultUpstream` |

### Group 解析顺序

1. `model` 字段含 `claude` 子串且存在 `claude` group → 走 `claude` group
2. `model` 字段刚好等于某个 group 名 → 走那个 group
3. 配了 `defaultGroup` 且存在 → 走它
4. 否则不限 group，所有 enabled 上游一起候选

## API

### OpenAI 格式

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer any" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm","messages":[{"role":"user","content":"hi"}]}'
```

### Anthropic 格式

```bash
curl http://localhost:3000/v1/messages \
  -H "x-api-key: any" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'
```

### 管理 API

```bash
# 列上游
curl http://localhost:3000/admin/upstreams

# CRUD
curl -X POST   http://localhost:3000/admin/upstreams      -d '{...}' -H 'Content-Type: application/json'
curl -X PATCH  http://localhost:3000/admin/upstreams/NAME -d '{...}' -H 'Content-Type: application/json'
curl -X DELETE http://localhost:3000/admin/upstreams/NAME

# 启用 / 禁用 / 测速
curl -X POST http://localhost:3000/admin/upstreams/NAME/enable
curl -X POST http://localhost:3000/admin/upstreams/NAME/disable
curl -X POST http://localhost:3000/admin/upstreams/NAME/measure

# 路由
curl http://localhost:3000/admin/routing
curl -X POST http://localhost:3000/admin/routing/strategy -d '{"strategy":"manual"}' -H 'Content-Type: application/json'

# 持久化到 yaml
curl -X POST http://localhost:3000/admin/config/save
```

## TUI 按键

| 键 | 功能 |
|---|---|
| `↑/↓` | 选择上游 |
| `a` | 添加 |
| `e` | 编辑 |
| `t` | 启用 / 禁用 |
| `d` | 删除 |
| `m` | 测量延迟 |
| `r` | 切换路由策略 |
| `k` | 进入 client key 管理页 |
| `q` | 退出 |

Keys 页面：`[a]` 颁发，`[d]` 撤销，`[Esc]` 返回。

表单内：`↑/↓` 切字段，`Enter` 进入编辑（`Type` / `Auth Style` 弹选项菜单），`Esc` 取消。

## 调试

```bash
AIROUTER_DEBUG=1 airouter daemon start
airouter daemon logs -f
```

打开后会打印每次请求 / 响应的 header 和 body 截断。

## 开发

```bash
git clone https://github.com/konder/airouter.git
cd airouter
npm install
npm run dev      # 热重载
npm test         # vitest
npm run build    # tsc 输出到 dist/
```

