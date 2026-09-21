# 协议记录（实测）

本文件把开发期间的实测结论固化下来，方便后续维护与实现 M3。所有内容都来自本机 codex-cli **0.154.0** 的真实抓包/运行，不是推测。

---

## 1. `codex exec --json` 事件流

实测样本（含良性提示、工具执行、失败）：

```jsonl
{"type":"thread.started","thread_id":"01a09e1d-9485-7233-a55d-3663e4a4192e"}
{"type":"notice","level":"warn","message":"Model metadata for `deepseek-chat` not found. ..."}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"\"...powershell.exe\" -Command 'echo hi'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"...","aggregated_output":"hi\r\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"reasoning","text":"已拿到命令输出。"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"执行完毕，检测到标记。"}}
{"type":"turn.completed","usage":{"input_tokens":333,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":21,"reasoning_output_tokens":0}}
{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 ...)"}
{"type":"turn.failed","error":{"message":"unexpected status 401 ..."}}
```

要点：

- 事件类型：`thread.started` / `turn.started` / `turn.completed` / `turn.failed` / `error` / `item.started` / `item.updated` / `item.completed`
- `item.type`：`agent_message` / `reasoning` / `command_execution` / `file_change` / `mcp_tool_call` / `dynamic_tool_call` / `todo_list` / `web_search` / `error`
- **usage 形状**是 `input_tokens / cached_input_tokens / cache_write_input_tokens / output_tokens / reasoning_output_tokens`，没有 `total_tokens`（应用里自己相加）。
- `item.started` 与 `item.completed` 共用同一个 `item.id`，UI 必须按 id 就地合并（`src/core/eventParser.ts` + `src/renderer/src/utils/activity.ts`）。
- **`codex exec` 不接受 `-a/--ask-for-approval`**（只有顶层 `codex` 有），实测报 `unexpected argument '-a' found`。非交互模式下审批请求被自动拒绝并回喂模型。
- **只读沙箱下被拒绝的动作完全不产生 `command_execution` 条目**。拒绝信息只出现在回传给模型的工具输出里：

  ```
  exec_command failed: CreateProcess { message: "Rejected(\"...\" rejected: blocked by policy)" }
  ```

  因此应用在**桥**这一层嗅探该文本并补发 `denied` 通知（`src/core/bridge/server.ts` 的 `extractDenial`）。

---

## 2. Codex → `/v1/responses` 请求体

抓包样本：`test/fixtures/codex-responses-request.json`（51 KB，含完整 Codex 系统提示）。

顶层字段（实测全量）：

| 字段 | 说明 |
| --- | --- |
| `model` | 模型名 |
| `instructions` | 系统提示（约 17 KB） |
| `input[]` | 条目数组，`type` ∈ `message`(role=developer/user/assistant) / `function_call` / `function_call_output` / `custom_tool_call` / `custom_tool_call_output` / `reasoning` / `web_search_call` |
| `tools[]` | 见下 |
| `tool_choice` | `auto` |
| `parallel_tool_calls` | `true` |
| `reasoning` | `{ "summary": "auto" }` |
| `store` | `false` |
| `stream` | `true` |
| `include` | `["reasoning.encrypted_content"]` |
| `prompt_cache_key` | 会话 id |
| `client_metadata` | 会话/轮次元数据 |

`tools[]` 里存在三种 `type`：

```jsonc
{ "type": "function", "name": "exec_command", "description": "...", "strict": false,
  "parameters": { "type": "object", "properties": { "cmd": {...}, ... }, "required": ["cmd"], "additionalProperties": false } }

{ "type": "namespace", "name": "multi_agent_v1", "description": "...",
  "tools": [ { "type": "function", "name": "spawn_agent", ... } ] }

{ "type": "web_search", "external_web_access": false }
```

实测该请求共 14 个顶层工具、扁平化后 20 个函数（含 `multi_agent_v1` 5 个、`mcp__cua_repl` 2 个、`mcp__node_repl` 3 个嵌套函数）。

请求头里有用的信息：`accept: text/event-stream`、`authorization: Bearer <env_key>`、`session-id` / `thread-id`、`x-codex-beta-features: remote_compaction_v2`。

---

## 3. Chat Completions 的约束（决定了翻译策略）

- 函数名必须匹配 `^[a-zA-Z0-9_-]{1,64}$` —— **不允许点号**，所以 `namespace` 工具要扁平化成 `multi_agent_v1__spawn_agent`，回程用 `{ name: "spawn_agent", namespace: "multi_agent_v1" }` 还原。
- `web_search` 这类内置工具无法用函数等价表达，直接不声明（模型自然就不会调用）。
- `temperature` 不在 codex 的配置项里，只有桥能在转发时注入。
- 相邻同角色消息（真实请求里有两条连续的 `user`）在组装时被合并，避免部分兼容实现不接受。
- `deepseek-reasoner` 的思考内容走 `delta.reasoning_content`，被映射成 Responses 的 reasoning 条目（`response.reasoning_summary_text.delta` + `summary: [{type:"summary_text"}]`）。

---

## 4. 回程：Chat SSE → Responses SSE

应用按下列顺序下发（`src/core/bridge/stream.ts`）：

```
response.created
response.output_item.added            (reasoning | message | function_call)
response.reasoning_summary_text.delta (思考，增量)
response.output_text.delta            (正文，增量)
response.function_call_arguments.delta
response.output_item.done
response.completed                    (含完整 output[] 与 usage)
response.failed                       (错误路径)
```

每个事件都带单调递增的 `sequence_number`；`output[]` 的顺序为 `reasoning → message → function_call`。

**工具调用刻意缓冲到收流结束再下发**：DeepSeek 的函数名可能分片到达，提前发 `output_item.added` 会发出空名字的条目。

---

## 5. `app-server` 协议（已实现，用于逐动作审批）

```powershell
codex app-server --help                       # stdio JSON-RPC（--listen stdio:// 为默认）
codex app-server generate-json-schema --experimental --out <dir>
```

### 5.1 帧格式与握手（实测）

- **帧格式：换行分隔的 JSON**（每行一个 JSON 对象，没有 `Content-Length` 头）。通知额外带一个 `emittedAtMs` 字段。
- 握手：
  ```jsonc
  -> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"codex-desktop","version":"0.1.0"},"capabilities":{"experimentalApi":true}}}
  <- {"id":1,"result":{"userAgent":"codex-desktop/0.154.0 (Windows ...)","codexHome":"...","platformFamily":"windows","platformOs":"windows"}}
  -> {"jsonrpc":"2.0","method":"initialized"}
  ```
- 建会话与跑一轮：
  ```jsonc
  -> {"id":2,"method":"thread/start","params":{"cwd":"...","model":"deepseek-chat","modelProvider":"deepseek","sandbox":"read-only","approvalPolicy":"on-request"}}
  <- {"id":2,"result":{"thread":{"id":"01a09e22-..."}, "approvalPolicy":"on-request", "sandbox":"read-only", ...}}
  -> {"id":3,"method":"turn/start","params":{"threadId":"01a09e22-...","input":[{"type":"text","text":"..."}]}}
  <- {"id":3,"result":{"turn":{"id":"..."}}}
  -> {"method":"turn/interrupt","params":{"threadId":"...","turnId":"..."}}     // 打断
  ```
- 枚举：`sandbox` = `read-only | workspace-write | danger-full-access`；`approvalPolicy` = `untrusted | on-request | never`（或 `{granular:{...}}` 对象）。

### 5.2 审批通道（服务端 → 客户端请求）

| 方法 | 关键参数 | 决定值 |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | `itemId, threadId, turnId, command, cwd, reason, approvalId, availableDecisions` | `accept` / `acceptForSession` / `decline` / `cancel` |
| `item/fileChange/requestApproval` | `itemId, threadId, turnId, reason, grantRoot` | `accept` / `acceptForSession` / `decline` / `cancel` |
| `item/permissions/requestApproval` | 权限提升相关字段 | 同族 |
| `execCommandApproval` / `applyPatchApproval` | 旧版协议，字段不同（`applyPatchApproval` 带补丁全文） | 同族 |

应答方式就是普通的 JSON-RPC 响应：`{"jsonrpc":"2.0","id":<请求 id>,"result":{"decision":"accept"}}`。

界面按钮 → 线上取值的映射：**允许一次 = `accept`，总是允许 = `acceptForSession`，拒绝 = `decline`**。

对不支持的其它服务端请求（`currentTime/read`、`item/tool/call`、`mcpServer/elicitation/request` 等）必须回 `{"error":{"code":-32601,...}}`，否则 codex 会一直等。

### 5.3 事件通知（v2 ThreadItem）

条目类型是 camelCase：`agentMessage` / `reasoning` / `commandExecution` / `fileChange` / `mcpToolCall` / `dynamicToolCall` / `functionCallOutput` / `webSearch` / `plan` / `imageView` / `sleep` …

| 方法 | 用途 |
| --- | --- |
| `turn/started`、`turn/completed`（`turn.status` = `completed\|interrupted\|failed\|inProgress`） | 轮次生命周期 |
| `item/started`、`item/completed` | 条目快照 |
| `item/agentMessage/delta` | 正文流式增量 |
| `item/reasoning/summaryTextDelta`、`item/reasoning/textDelta` | 思考流式增量 |
| `item/commandExecution/outputDelta` | 命令输出流式增量 |
| `item/fileChange/patchUpdated`、`turn/diff/updated` | 补丁 / 整轮 diff（审批预览用的就是它） |
| `thread/tokenUsage/updated` | token 用量 |
| `serverRequest/resolved` | 某个审批已被解决 |

注意：`Turn` 对象里**没有** `usage` 字段，token 用量只从 `thread/tokenUsage/updated` 拿。

### 5.4 上下文连贯与压缩（追加实现）

| 需求 | 方法 | 实测要点 |
| --- | --- | --- |
| 同一会话多轮共享上下文 | 常驻进程 + 复用同一个 `threadId`，每轮只发 `turn/start` | thread 活着，历史自动延续 |
| 重启/换会话后续接 | `thread/resume`，**只要求 `threadId`**（实测），可另带 `cwd/model/modelProvider/sandbox/approvalPolicy` | 重启后 thread id 不变，上下文仍在 |
| 手动压缩上下文 | `thread/compact/start`，同样只要求 `threadId` | 压缩后旧对话被摘要化，thread 继续沿用 |
| 上下文占用可视化 | 通知 `thread/tokenUsage/updated` 的 `tokenUsage` | 结构是 `{last, total, modelContextWindow}`，**不是**扁平 token 字段 |

`turn/completed` 的 `turn` 对象里**没有** usage 字段，token 用量只从 `thread/tokenUsage/updated` 拿。`last` 是最近一次请求的量，`total` 是线程累计；要算准「这一轮用了多少」，第一次用 `last`，之后按 `total` 的增量累加。

### 5.5 上下文长度的配置键（用 `--strict-config` 实测）

```powershell
# 未知键会立刻报错，可用它当判别器：
codex exec --strict-config -c definitely_bogus_key=1 ...
#   -> Error loading config.toml: unknown configuration field `definitely_bogus_key`
```

| 键 | 0.154.0 是否接受 | 说明 |
| --- | --- | --- |
| `model_context_window` | ✅ | 第三方模型必须显式声明，否则 codex 用兜底元数据算压缩时机 |
| `model_auto_compact_token_limit` | ✅ | 自动压缩阈值 |
| `sandbox_mode` | ✅ | `codex exec resume` 没有 `-s` 参数，只能用它传沙箱 |
| `approval_policy` | ✅ | exec 下 `never`；app-server 下 `on-request` |
| `model_max_output_tokens` | ❌ | 不是合法键（0.154.0 已无此字段） |

TOML 语法注意：以上都是**顶层键**，必须写在任何 `[table]` 之前。

### 5.6 两个实测踩到的坑

1. **过期进程的 close 事件会清掉新进程的引用**：`dispose()` 杀旧进程后立刻 spawn 新进程，旧进程的 `close` 是异步到达的；若不校验来源，`this.child` 会被置空，表现为「换工作区后第一次任务握手失败、静默回退到 exec」。修法：`handleExit(source, …)` 先判断 `this.child === source`。
2. **沙箱拒绝的文案形态会变**：有时是 codex 层的 `Rejected("... blocked by policy")`，有时是操作系统层的 `Access to the path ... is denie\r\nd.`（PowerShell 会在单词中间换行）。必须先把空白折叠再匹配正则，否则漏报。

### 5.7 本应用的实现

`src/core/appServerEngine.ts`：JSONL 收发、握手、常驻进程 + `thread/start` / `thread/resume` + `turn/start`、通知→`HarnessEvent` 映射、审批请求→`approval.request` 等待用户点击、`thread/compact/start` 压缩、`turn/interrupt` 做取消。

安全设计：

- **握手失败自动回退**：`start()` 返回 `false` 表示「还没执行任何动作就失败了」，`Orchestrator` 会改用 exec 引擎继续跑并提示用户，任务不会白白失败。
- **取消时自动拒绝待审批**：否则 codex 会一直等我们的响应。
- **进程退出视为拒绝**：避免界面卡在「等待审批」状态。
- **打断不杀进程**：`turn/interrupt` 优先，thread 保留以便继续对话；8 秒没收尾才强杀兜底。
- **空闲回收**：常驻进程会占住工作目录（cwd），空闲 10 分钟自动回收，下次提问自动 `thread/resume`。

端到端验证：`npm run test:approval`（22 项断言，覆盖允许一次 / 拒绝 / 总是允许对真实文件系统的影响）、`npm run test:continuity`（19 项断言，覆盖两种引擎的续接、重启续接、会话隔离、上下文窗口声明）。

---

## 6. 复现这些结论

```powershell
# 重新抓 codex 的真实请求体：用一个本地 stub 接住 /v1/responses 请求并保存 body
# （开发时用的脚本已清理，可按 test/fixtures/codex-responses-request.json 的结构对照）

# 重新导出 app-server 协议 schema
codex app-server generate-json-schema --experimental --out .\schema

# 跑全部测试
npm test
```
