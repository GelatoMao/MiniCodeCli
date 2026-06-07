# mini-code-cli 完整代码学习指南

> 基于源码精读，覆盖架构设计、核心模块、数据流与关键实现细节。

---

## 目录

1. [项目整体架构](#1-项目整体架构)
2. [monorepo 结构与包关系](#2-monorepo-结构与包关系)
3. [核心模块：Agent Loop（代理循环）](#3-核心模块agent-loop代理循环)
4. [核心模块：LoopState（会话状态）](#4-核心模块loopstate会话状态)
5. [核心模块：Loop Guard（死循环断路器）](#5-核心模块loop-guard死循环断路器)
6. [核心模块：Tool Execution（工具执行）](#6-核心模块tool-execution工具执行)
7. [核心模块：工具集（Tools）](#7-核心模块工具集tools)
8. [核心模块：权限系统（Permissions）](#8-核心模块权限系统permissions)
9. [核心模块：Provider Registry（模型注册表）](#9-核心模块provider-registry模型注册表)
10. [核心模块：工具结果截断（Truncation）](#10-核心模块工具结果截断truncation)
11. [UI 层：CLI 入口与终端渲染](#11-ui-层cli-入口与终端渲染)
12. [UI 层：ChatInput 渲染引擎](#12-ui-层chatinput-渲染引擎)
13. [UI 层：输入处理 Hook](#13-ui-层输入处理-hook)
14. [辅助模块：Progress Reporter（进度侧信道）](#14-辅助模块progress-reporter进度侧信道)
15. [完整数据流时序图](#15-完整数据流时序图)
16. [关键设计决策与模式总结](#16-关键设计决策与模式总结)

---

## 1. 项目整体架构

```
mini-code-cli/
├── packages/
│   ├── core/          ← 业务逻辑：agent loop、工具、权限、provider
│   │   └── src/
│   │       ├── agent/         ← loop.ts / loop-state.ts / loop-guard.ts / tool-execution.ts
│   │       ├── tools/         ← index.ts / truncate.ts / shell.ts / shell-provider.ts / shell-utils.ts
│   │       ├── permissions/   ← index.ts / session-store.ts
│   │       ├── providers/     ← registry.ts
│   │       ├── config/        ← index.ts
│   │       ├── types/         ← index.ts
│   │       └── utils.ts
│   └── cli/           ← UI 层：Ink 渲染、输入框、CLI 入口
│       └── src/
│           ├── index.ts       ← CLI 入口 + yargs 参数解析
│           ├── app.tsx        ← Ink render 入口
│           └── ui/
│               ├── components/    ← App.tsx / ChatInput.tsx
│               ├── chat-input/    ← cells.ts / palette.ts / reducer.ts / text-helpers.ts
│               ├── hooks/         ← use-prompt-input.ts
│               ├── display-types.ts
│               ├── stdout-writer.ts
│               └── text-width.ts
└── docs/              ← 任务文档（task01~task08）
```

**设计哲学：** `core` 是纯逻辑包，不依赖任何 UI 框架；`cli` 依赖 `core`，负责渲染和用户交互。两者通过 `AgentCallbacks` 接口（`packages/core/src/types/index.ts`）解耦。

---

## 2. monorepo 结构与包关系

| 包名 | 路径 | 职责 |
|------|------|------|
| `@mini-code-cli/core` | `packages/core` | Agent Loop、工具执行、权限、AI SDK 集成 |
| `@mini-code-cli/cli` | `packages/cli` | Ink UI、CLI 参数解析、终端渲染 |

**工具链：**
- **包管理：** pnpm workspace（`pnpm-workspace.yaml`，pnpm@10.7.1）
- **构建：** esbuild（`packages/cli/esbuild.config.js`）+ TypeScript（`tsconfig.base.json`）
- **测试：** vitest（`packages/core/tests/`）
- **代码规范：** commitlint（`commitlint.config.js`）+ husky（`.husky/`，commit 规范检查）
- **Node.js 要求：** >= 20.19.0（`package.json` → `engines.node`）

---

## 3. 核心模块：Agent Loop（代理循环）

**文件：** `packages/core/src/agent/loop.ts`

### 3.1 核心概念：ReAct 循环

Agent Loop 实现了 **ReAct（Reason + Act）** 模式：
- 模型输出文字 → 直接流式展示（`text-delta`）
- 模型决定调用工具 → 执行工具 → 将结果反馈给模型 → 继续推理

```
用户输入
   │
   ▼
agentLoop()                                   ← loop.ts:260
   │
   └── while 循环
         │
         ├── runTurn()                         ← loop.ts:190
         │     ├── repairOrphanToolCalls()     ← tool-result-sanitize.ts:76
         │     ├── streamText(messages, tools) ← AI SDK（ai 包）
         │     ├── streamChunksToUI()          ← loop.ts:85
         │     └── collectTurnResponse()       ← loop.ts:128
         │
         ├── finishReason = 'stop'    → break（正常结束）
         ├── finishReason = 'tool-calls' → processToolCalls() → continue  ← tool-execution.ts:454
         └── finishReason = 'length' → 推入续写提示 → continue（最多3次）
```

### 3.2 关键函数详解

#### `buildTools()` — `loop.ts:66`
```typescript
// packages/core/src/agent/loop.ts:66
function buildTools(_options: AgentOptions): Record<string, any> {
  return { ...toolRegistry }
}
```
构建传给 `streamText` 的工具集。工具来源：`packages/core/src/tools/index.ts`。目前是静态注册表，注释中预留了 task 工具（sub-agent）和 MCP 工具的扩展点。

#### `streamChunksToUI()` — `loop.ts:85`
消费 `fullStream` 异步迭代器，按 chunk 类型分发：

| chunk.type | 行为 | 涉及代码 |
|-----------|------|---------|
| `text-delta` | 调用 `callbacks.onTextDelta` → 流式显示给用户 | `loop.ts:96` |
| `tool-call` | 先注册 progress reporter，再调用 `callbacks.onToolCall` | `loop.ts:98~108`，`progress.ts:38` |
| `tool-result` | 清理 progress reporter，调用 `callbacks.onToolResult`（auto-execute 工具） | `loop.ts:109~113`，`progress.ts:48` |
| `error` | **re-throw**，让外层 catch 捕获真实错误（而非泛型的 NoOutputGeneratedError） | `loop.ts:87~93` |

> **关键设计：** 必须在 `tool-call` 事件时（执行开始前）注册 progress reporter（`loop.ts:101~103`），否则首批进度消息会丢失。

#### `collectTurnResponse()` — `loop.ts:128`
在 `fullStream` 消耗完后调用，收集 `response.messages` 和 `usage`：
1. 调用 `truncateToolResultsInMessages()`（`tool-result-sanitize.ts:183`）→ 截断 auto-execute 工具的超长结果
2. 将消息追加到 `state.messages`（维护完整会话历史）
3. 累加 token 用量，通知 UI（`loop.ts:139~148`）

#### `runTurn()` — `loop.ts:190`
单轮 LLM 调用的完整生命周期：
```
repairOrphanToolCalls() → streamText() → streamChunksToUI() → collectTurnResponse()
```
每个阶段都有独立的 try-catch，区分 abort（用户中断，`loop.ts:174`）和真实错误。

#### `agentLoop()` — `loop.ts:260`

```typescript
// packages/core/src/agent/loop.ts:290~344
while (options.maxTurns === undefined || turn < options.maxTurns) {
  // 1. 执行一轮
  const outcome = await runTurn(...)

  // 2. 按 finishReason 路由
  if (outcome.finishReason === 'tool-calls') {
    continuationAttempts = 0  // 模型在取得进展，重置续写计数器
    await processToolCalls(toolCalls, state, options, callbacks)
    continue
  }
  if (outcome.finishReason === 'length') {
    if (continuationAttempts < MAX_CONTINUATIONS) {
      // 续写提示进 state.messages 但不进 UI
      state.messages.push({ role: 'user', content: '续写提示...' })
      continue
    }
  }
  break  // stop / content-filter / 超限
}
```

**`TurnOutcome` 判别联合类型（`loop.ts:158`）：**
```typescript
type TurnOutcome =
  | { kind: 'done'; finishReason: string; result: StreamResult }
  | { kind: 'error' }    // 已通过 callbacks.onError 上报，break 循环
  | { kind: 'aborted' }  // 用户中断，不报错，break 循环
```

**`StreamResult` 接口：** `packages/core/src/agent/stream-utils.ts:25`

### 3.3 isAbortError：两层防御 — `loop.ts:174`

```typescript
// packages/core/src/agent/loop.ts:174
function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true          // 最可靠：直接检查信号标志
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (/aborted|AbortError/i.test(err.message)) return true  // 处理包裹错误
  }
  return false
}
```

同样的逻辑在 `tool-execution.ts:30` 也有独立副本（避免跨模块依赖）。

---

## 4. 核心模块：LoopState（会话状态）

**文件：** `packages/core/src/agent/loop-state.ts`

### 4.1 LoopState 结构 — `loop-state.ts:21`

```typescript
// packages/core/src/agent/loop-state.ts:21
interface LoopState {
  messages: ModelMessage[]          // 完整会话消息历史（user/assistant/tool 轮替）
  tokenUsage: TokenUsage            // 累计 token 用量（类型定义：types/index.ts:12）
  lastInputTokens: number           // 最后一次 API 请求的 inputTokens（用于压缩触发）
  sessionId: string                 // 格式：YYYYMMDD-HHMMSS-mmm
  startedAt: string                 // ISO 8601 启动时间
  filesModified: Set<string>        // 被修改的文件路径集合
  systemPromptCache: string | null  // 系统提示缓存（保证 prefix byte 稳定）
  permissionMode: PermissionMode    // 'default' | 'acceptEdits' | 'plan'（types/index.ts:8）
  recentToolCalls: ToolCallRecord[] // Loop Guard 滑动窗口（ToolCallRecord：loop-state.ts:13）
}
```

### 4.2 多轮对话的状态延续

```
第1次用户输入 → agentLoop(msg, model, opts, cbs)          ← loop.ts:260
                  → createLoopState()                      ← loop-state.ts:68
                  → 返回 { state, turnCount }

第2次用户输入 → agentLoop(msg, model, opts, cbs, existingState)
                  → 复用 state（消息历史持续累积）
                  → 返回 { state, turnCount }
```

`existingState` 参数（`loop.ts:265`）使多轮对话成为可能，不需要每次重建历史。

### 4.3 sessionId 格式 — `loop-state.ts:53`

```typescript
// packages/core/src/agent/loop-state.ts:53
// 例：20260602-143022-456
// 设计考虑：比 Date.now().toString(36) 更易读，毫秒后缀保证同秒唯一性
function generateSessionId(now: Date = new Date()): string { ... }
```

---

## 5. 核心模块：Loop Guard（死循环断路器）

**文件：** `packages/core/src/agent/loop-guard.ts`

### 5.1 问题背景

模型有时会陷入死循环：同一工具以相同参数反复调用（通常是上次失败后不做修改直接重试）。

### 5.2 两阶段检测机制

```
阈值 3（soft-block，SOFT_LOOP_THRESHOLD，loop-guard.ts:28）：
  → 不执行工具体，合成一条错误 tool-result 告诉模型"已经失败 3 次，换思路"
  → syntheticLoopBlockResult()  ← loop-guard.ts:140
  → 模型通常看到后会调整策略

阈值 5（hard-block，HARD_LOOP_THRESHOLD，loop-guard.ts:31）：
  → 弹出用户确认框（通过 callbacks.onAskUser，tool-execution.ts:255）
  → 用户选 Pause → 清空 recentToolCalls，推入 user 消息暂停循环
  → 用户选 Continue → 保持激活状态继续
```

### 5.3 检测算法：哈希 + 滑动窗口

```typescript
// packages/core/src/agent/loop-guard.ts:53
// 对 {toolName, stableInputJson} 计算 SHA256（截断为16位十六进制）
export function hashToolCall(toolName: string, input: unknown): string {
  const payload = toolName + '\x00' + stableStringify(input)
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

// packages/core/src/agent/loop-guard.ts:41
// 稳定序列化：对键排序，使 {a:1,b:2} 和 {b:2,a:1} 产生相同哈希
function stableStringify(value: unknown): string { ... }
```

滑动窗口大小：`LOOP_WINDOW_SIZE = 8`（`loop-guard.ts:34`）

**为什么不用"连续 3 次"而用"滑动窗口内 3 次"？**
> 模型先调 `foo`，读一个文件，再调 `foo`——连续检测会漏掉这种情形。

### 5.4 状态读写分离

```typescript
// packages/core/src/agent/loop-guard.ts:85
// 检查（不修改 state）
checkForLoop(state, toolName, input, toolCallId): LoopCheck

// packages/core/src/agent/loop-guard.ts:125
// 记录（修改 state.recentToolCalls）
recordToolCall(state, toolName, input, hash?)
```

调用方先 `checkForLoop` 决定是否执行，再用返回的 `hash` 调用 `recordToolCall`，避免二次计算 SHA256。调用处：`tool-execution.ts:241~248`（`applyLoopGuard` 函数）。

---

## 6. 核心模块：Tool Execution（工具执行）

**文件：** `packages/core/src/agent/tool-execution.ts`

### 6.1 工具分类与处理路径

```
收到 finishReason = 'tool-calls'
        │
        ▼
processToolCalls()                                     ← tool-execution.ts:454
        │
        ├── 预扫描：collectActiveAssistantToolCallIds() ← tool-execution.ts:385
        │     └── 剔除"幽灵调用"（SDK 校验拒绝但仍在 toolCalls Promise 里的）
        │
        ├── 预扫描：collectFulfilledToolCallIds()       ← tool-execution.ts:409
        │     └── 剔除已完成的（auto-execute 工具结果已在 state.messages 里）
        │
        └── 对 liveCalls 按批次处理（partitionToolCalls，tool-execution.ts:432）
              │
              ├── BYPASS_LOOP_GUARD_HANDLERS            ← tool-execution.ts:225
              │     └── askUser → handleAskUser()       ← tool-execution.ts:210
              │           直接执行，跳过循环守卫
              │
              └── 普通工具（writeFile/edit/shell）
                    ├── applyLoopGuard()                ← tool-execution.ts:239
                    ├── checkWriteOrShellPermission()   ← tool-execution.ts:277
                    └── executeWriteOrShell()           ← tool-execution.ts:303
```

### 6.2 幽灵调用问题

**问题：** AI SDK 在 Zod 校验失败时，会发出 `tool-error` chunk 并从 `response.messages` 中排除该调用，但 `result.toolCalls` Promise 里可能仍然包含它。

**危害：**
1. 执行了模型未正式提交的工具，产生真实副作用
2. 推入的 `tool_result` 是孤立的，下次 API 请求会 400 报错

**解决：** `collectActiveAssistantToolCallIds()`（`tool-execution.ts:385`）从 `state.messages` 末尾反向扫描，收集当前 assistant 消息中实际提交的 `toolCallId` 集合，过滤掉幽灵调用（`tool-execution.ts:469~471`）。

### 6.3 executeShell 的进度节流 — `tool-execution.ts:108`

```typescript
// packages/core/src/agent/tool-execution.ts:108
// 50ms 节流：防止 PowerShell Format-Table 等命令每 1ms 发一行
// 导致 React setState 频繁触发重绘
const PROGRESS_THROTTLE_MS = 50
let lastProgressTime = 0

const onChunk = (chunk: Buffer) => {
  callbacks.onShellOutput(s)  // shell 输出实时推送给 UI（无节流）

  const now = Date.now()
  if (now - lastProgressTime < PROGRESS_THROTTLE_MS) return
  // 取最后一行非空内容作为进度消息
  const last = lines[lines.length - 1]
  if (last) {
    lastProgressTime = now
    reportProgress(toolCallId, trimmed)  // progress 消息有节流（progress.ts:62）
  }
}
```

> 关键区分：`onShellOutput`（无节流，模型看到完整输出）vs `reportProgress`（有节流，UI 显示用）

### 6.4 deferred 消息队列 — `tool-execution.ts:463`

```typescript
// packages/core/src/agent/tool-execution.ts:463
const deferred: ModelMessage[] = []
// ...
// 所有工具结果推入后，才 flush 延迟消息（tool-execution.ts:513）
if (deferred.length > 0) state.messages.push(...deferred)
```

**原因：** 在工具执行中间插入 `user` 消息会产生 `assistant → tool A → user → tool B` 这种排序，DeepSeek 等对消息顺序有严格要求的 provider 会返回 400 错误。deferred 消息的推入点：`applyLoopGuard()`（`tool-execution.ts:264`）中的 hard-block 路径。

### 6.5 中断时的安全保证 — `tool-execution.ts:492`

用户按下 Esc/Ctrl+C 后，对剩余未执行的工具调用合成 `tool_result`，防止孤立的 `tool_call` 导致下次请求 400：

```typescript
// packages/core/src/agent/tool-execution.ts:492~505
if (options.abortSignal?.aborted) {
  for (let j = dispatched; j < liveCalls.length; j++) {
    pushToolResult(..., '[Tool execution interrupted by user]', true)  // tool-execution.ts:175
  }
  break
}
```

### 6.6 工具执行结果的统一出口 — `tool-execution.ts:175`

`pushToolResult()` 是手动分发工具的唯一出口：
- 调用 `toolResultMessage()`（`messages.ts:39`）构造 tool 消息格式
- 调用 `clearProgressReporter()`（`progress.ts:48`）清理 progress reporter
- 调用 `callbacks.onToolResult()` 通知 UI

---

## 7. 核心模块：工具集（Tools）

**目录：** `packages/core/src/tools/`

### 7.1 两类工具的本质区别

| 类型 | 工具 | 是否有 `execute` | 谁来执行 | 为什么 |
|------|------|----------------|---------|--------|
| auto-execute | readFile, listDir, glob, grep | ✅ 有 | AI SDK 自动执行 | 只读无副作用，无需确认 |
| 手动分发 | writeFile, edit, shell | ❌ 无 | agent loop 手动处理 | 需要权限检查、流式输出等 |

工具注册表：`packages/core/src/tools/index.ts:37`（`toolRegistry` 对象）

各工具定义文件：
- `read-file.ts` — readFile（auto-execute，有 execute）
- `list-dir.ts` — listDir（auto-execute，有 execute）
- `glob.ts` — glob（auto-execute，有 execute）
- `grep.ts` — grep（auto-execute，有 execute）
- `write-file.ts` — writeFile（手动，无 execute）
- `edit.ts` — edit（手动，无 execute）
- `shell.ts` — shell（手动，无 execute）

### 7.2 shell 工具设计细节 — `shell.ts:16`

**tool description 中的"别用 grep/cat"提示（`shell.ts:17~30`）：**
```
IMPORTANT: Avoid using this tool to run grep, rg, cat... Instead, use the dedicated tool
```
这是给模型的指令，引导其优先使用专用工具获得更好体验。

### 7.3 跨平台 Shell Provider — `packages/core/src/tools/shell-provider.ts`

```
操作系统检测（shell-provider.ts:102）
    │
    ├── Windows（os.platform() === 'win32'）
    │     ├── $SHELL 指向 bash/zsh（Git Bash）→ createPosixProvider()  ← shell-provider.ts:38
    │     └── 否则 → createPowerShellProvider()                        ← shell-provider.ts:61
    │
    └── macOS/Linux → 读取 $SHELL → createPosixProvider()
```

**PowerShell 特殊处理：base64 编码命令（`shell-provider.ts:57`）**
```typescript
// packages/core/src/tools/shell-provider.ts:57
// -EncodedCommand 接受 base64 UTF-16LE 编码的命令
// 字符集只有 [A-Za-z0-9+/=]，彻底避免引号转义问题
function encodePowerShellCommand(psCommand: string): string {
  return Buffer.from(psCommand, 'utf16le').toString('base64')
}

// 还注入了 5 行包裹代码（shell-provider.ts:75~81）：
// 1. UTF-8 输出编码（解决 GBK 乱码）
// 2. 静默进度条
// 3. 正确传播退出码
```

缓冲区上限：`MAX_SHELL_BUFFER = 20MB`（`shell-provider.ts:22`）

### 7.4 shell-utils：命令安全分类 — `packages/core/src/tools/shell-utils.ts`

```
splitShellCommands(cmd)    ← shell-utils.ts:29  引号感知分词 + 大括号深度跟踪
      │
      ▼
  子命令数组
      │
      ├── isDestructive(sub)  ← shell-utils.ts:311  有任何破坏性模式 → 整体拒绝
      ├── isReadOnly(sub)     ← shell-utils.ts:304  全部只读 → 自动允许
      └── 否则 → 询问用户（permissions/index.ts:39）
```

只读命令白名单：`shell-utils.ts:85`（`READ_ONLY_COMMANDS`，含 POSIX + PowerShell cmdlet）
破坏性命令模式：`shell-utils.ts:186`（`DESTRUCTIVE_PATTERNS`，正则数组）

**破坏性模式涵盖：**
- `rm -rf`、`sudo`、`mkfs`、`dd if=`
- `git push --force`、`git reset --hard`
- `curl | bash`（远程代码执行）
- `DROP TABLE`、`DELETE FROM`
- `docker system prune`、`kubectl delete`
- `npm publish`（防止意外发布）

---

## 8. 核心模块：权限系统（Permissions）

**目录：** `packages/core/src/permissions/`
- `index.ts` — 权限决策主逻辑（`checkPermission`、`getPermissionLevel`）
- `session-store.ts` — 会话规则内存存储 + 磁盘持久化

### 8.1 三级权限决策模型 — `permissions/index.ts:6`

```
always-allow → 静默允许（readFile/glob/grep/listDir）   ← index.ts:62~65
ask          → 弹出确认框（edit/writeFile，以及需确认的 shell）
deny         → 静默拒绝（破坏性命令）                    ← index.ts:35（evaluateShellPermission）
```

工具权限规则表：`permissions/index.ts:61`（`rules` 对象）

### 8.2 checkPermission 完整决策流 — `permissions/index.ts:128`

```typescript
// packages/core/src/permissions/index.ts:128
async function checkPermission(toolCall, trustMode, onAskPermission, permissionMode, cwd) {
  const level = getPermissionLevel(toolCall.toolName, toolCall.input)  // index.ts:72

  if (level === 'deny') return false              // 1. deny 优先级最高

  if (level === 'always-allow' || trustMode) return true  // 2. trustMode 全局覆盖

  // 3. acceptEdits 模式：项目内安全写操作自动允许（index.ts:148）
  if (permissionMode === 'acceptEdits' && isWriteTool) {
    if (isPathWithinProject(filePath, cwd) && !isSensitivePath(filePath)) {  // index.ts:100/107
      return true
    }
  }

  if (sessionRulesMatch(...)) return true         // 4. 会话规则（session-store.ts:112）

  const decision = await onAskPermission(toolCall) // 5. 弹出确认框

  if (decision === 'always') {
    // 保存规则到内存（addSessionAllowRule，session-store.ts:108）
    // 和磁盘（persistRule，session-store.ts:153）
    addSessionAllowRule(rule)
    if (result.persist && cwd) persistRule(cwd, rule)
  }
  return decision === 'yes' || decision === 'always'
}
```

### 8.3 permissionMode 三种模式 — `types/index.ts:8`

| 模式 | 含义 | 来源 |
|------|------|------|
| `'default'` | ask 级别工具弹确认框 | 默认 |
| `'acceptEdits'` | 自动允许项目内安全写操作 | 用户手动切换 |
| `'plan'` | 纯探索模式（提示词告知不要写文件） | CLI `--plan` 标志（`cli/src/index.ts:198`） |

### 8.4 敏感路径保护 — `permissions/index.ts:82`

即使在 `acceptEdits` 模式下，以下路径也必须弹确认框（`SENSITIVE_PATH_PATTERNS`，`index.ts:82`）：
`.bashrc`、`.zshrc`、`.gitconfig`、`.ssh/`、`.env`、`.git/`、`.vscode/`、`.idea/` 等

### 8.5 权限记忆：会话内 + 磁盘持久化 — `permissions/session-store.ts`

```
用户选 'always' → buildAllowRule()            ← session-store.ts:192
                    │
                    ├── shell：精确匹配规则（持久化到磁盘）
                    └── writeFile/edit：工具级别规则（仅会话，不持久化）

持久化位置：.mini-code/local/permissions.json  ← session-store.ts:53（getPermissionsPath）
安全保护：自动创建 .mini-code/local/.gitignore ← session-store.ts:174
           防止权限偏好泄漏到 git
```

`SessionPermissionStore` 类：`session-store.ts:65`（内存存储，含 `addRule`、`matches`、`clear`）

**AllowRule 格式（`session-store.ts:20`）：**
```
shell:=git status     ← 精确命令（exact）    → ruleToString: session-store.ts:37
shell:git :*          ← 前缀匹配（prefix）
edit:*                ← 工具级别（tool）
```

---

## 9. 核心模块：Provider Registry（模型注册表）

**文件：** `packages/core/src/providers/registry.ts`
**配置读取：** `packages/core/src/config/index.ts`

### 9.1 懒注册策略 — `registry.ts:29`

```typescript
// packages/core/src/providers/registry.ts:29
export function createModelRegistry() {
  const opts = getProviderOptions()  // config/index.ts:59（读取环境变量中的 API Key）
  const providers = {}

  if (opts.anthropic) providers.anthropic = createAnthropic({ fetch: permanentErrorFetch })
  if (opts.openai)    providers.openai = createOpenAI({ fetch: permanentErrorFetch })
  if (opts.deepseek)  providers.deepseek = createDeepSeek({ fetch: permanentErrorFetch })

  return createProviderRegistry(providers)  // AI SDK 统一注册表
}
```

只有设置了对应 API Key 的 provider 才会被注册。

### 9.2 permanentErrorFetch：永久性错误拦截器 — `registry.ts:177`

**问题：** AI SDK 的指数退避会对 429/5xx 重试，但某些 provider 会误用这些状态码表达永久错误（如余额不足返回 429）。

**解决：** 注入自定义 `fetch`（`registry.ts:177`），在 SDK 解析响应前拦截并重写状态码：

错误分类规则表：`registry.ts:80`（`PERMANENT_ERROR_CATEGORIES`）

```
HTTP 429 + body 含 "insufficient balance" → 重写为 402（Payment Required）
HTTP 任意 + body 含 "context_length_exceeded" → 重写为 413（Payload Too Large）
HTTP 任意 + body 含 "content_filter" → 重写为 422（Unprocessable Entity）
HTTP 任意 + body 含 "invalid api key" → 重写为 401（Unauthorized）
HTTP 任意 + body 含 "model not found" → 重写为 404（Not Found）
```

**关键实现细节：**
```typescript
// packages/core/src/providers/registry.ts:185~194
// 必须用 response.clone() 读 body
// 因为 Response.body 是 ReadableStream，只能消费一次
// SSE 流式响应（status < 400）绝不能读 body（会把整个流消耗掉！）
if (response.status < 400) return response  // 快速路径：不碰 body
const text = await response.clone().text()
```

### 9.3 模型 ID 解析优先级 — `config/index.ts:45`

```
1. --model CLI 标志（显式指定）                    ← cli/src/index.ts:153
2. MINI_CODE_MODEL 环境变量                       ← config/index.ts:47
3. 智能默认：按 PROVIDER_DETECTION_ORDER 找第一个有 Key 的 provider
                                                  ← types/index.ts:64 + config/index.ts:51
```

**别名系统（`types/index.ts:55`）：**
```typescript
// packages/core/src/types/index.ts:55
const MODEL_ALIASES = {
  sonnet: 'anthropic:claude-sonnet-4-5',
  haiku: 'anthropic:claude-haiku-4-5',
  gpt4: 'openai:gpt-4.1',
  deepseek: 'deepseek:deepseek-chat',
}
```

---

## 10. 核心模块：工具结果截断（Truncation）

**文件：** `packages/core/src/tools/truncate.ts`
**调用处：**
- auto-execute 工具：`tool-result-sanitize.ts:183`（`truncateToolResultsInMessages`）
- 手动工具：`tool-execution.ts:368`（`truncateToolResult(result.output)`）
- 工具结果 chunk：`loop.ts:113`（`truncateToolResult(raw)`）

### 10.1 双预算截断设计

```
默认限制：2000 行（MAX_TOOL_RESULT_LINES，truncate.ts:23）
         OR 50KB（MAX_TOOL_RESULT_BYTES，truncate.ts:30）
超过任意一个 → 触发截断
```

### 10.2 三种截断方向 — `truncate.ts:36`（`TruncateOptions.direction`）

| 方向 | 适用场景 | 保留策略 |
|------|---------|---------|
| `head-tail`（默认） | 文件读取、grep 结果 | 头部20% + 尾部80% |
| `head` | shell 输出、glob/listDir 结果 | 只保留开头 |
| `tail` | 日志文件 | 只保留末尾 |

**为什么 head-tail 是 20:80 而非 50:50？**
> 文件开头是声明/import，尾部是最新修改的代码，尾部对模型决策更重要。头部比例常量：`DEFAULT_HEAD_RATIO = 0.2`（`truncate.ts:33`）

### 10.3 各工具的截断策略 — `tool-result-sanitize.ts:31`

```typescript
// packages/core/src/agent/tool-result-sanitize.ts:31
const PER_TOOL_POLICY: Record<string, TruncateOptions> = {
  readFile: { direction: 'head-tail' },
  grep:     { direction: 'head', maxLines: 500 },
  glob:     { direction: 'head', maxLines: 500 },
  listDir:  { direction: 'head', maxLines: 500 },
}
```

### 10.4 UTF-8 安全截断 — `truncate.ts:72`

```typescript
// packages/core/src/tools/truncate.ts:72
// 在字符边界截取，避免多字节字符（CJK）被截断产生乱码
function sliceBytes(buf: Buffer, bytes: number, direction: 'head' | 'tail'): Buffer {
  // UTF-8 续字节特征：高位为 10xxxxxx（即 0x80-0xBF）
  // 截断时向前/向后扫描，跳过续字节，找到合法起始位置
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
}
```

### 10.5 截断标记 — `truncate.ts:212`

截断后会插入人类可读的标记，告知模型不是数据损坏：
```
[truncated: 1500 lines / 45,000 chars dropped — narrow the tool args or read specific ranges]
```

主截断函数入口：`truncateToolResult()`（`truncate.ts:193`）

---

## 11. UI 层：CLI 入口与终端渲染

**文件：** `packages/cli/src/index.ts`
**Ink 入口：** `packages/cli/src/app.tsx`

### 11.1 启动流程

```
main()                                                   ← cli/src/index.ts:103
  ├── checkNodeVersion()                                  ← index.ts:25（强制 >= 20.19.0）
  ├── loadEnvFile()                                       ← index.ts:43（从 cwd 向上查找 .env）
  ├── 解析 CLI 参数（yargs）                               ← index.ts:108
  ├── 检查 API Key（getAvailableProviders）               ← core/config/index.ts:32
  ├── resolveModelId()                                    ← core/config/index.ts:45
  ├── createModelRegistry()                               ← core/providers/registry.ts:29
  ├── startApp(model, options, prompt)                    ← cli/src/app.tsx:9
  └── waitUntilExit() → gracefulShutdown(0)               ← index.ts:80
```

### 11.2 CLI 参数 — `cli/src/index.ts:108~139`

| 参数 | 说明 |
|------|------|
| `[prompt]` | 可选的初始提示语 |
| `--model, -m` | 模型 ID 或别名 |
| `--trust, -t` | 信任模式：跳过写操作确认（`AgentOptions.trustMode`） |
| `--print, -p` | 非交互模式：输出结果后退出（`AgentOptions.printMode`） |
| `--plan` | 计划模式：只读探索（`permissionMode: 'plan'`） |
| `--max-turns` | 限制 agent 循环轮数（`AgentOptions.maxTurns`） |

`AgentOptions` 类型定义：`packages/core/src/types/index.ts:41`

### 11.3 终端安全恢复 — `cli/src/index.ts:63`

进程退出前必须恢复终端状态（同步写入，即使 Ink 异常退出也能执行）：
```typescript
// packages/cli/src/index.ts:63
function resetTerminal(): void {
  fs.writeSync(1, '\x1b[0m')     // 重置 SGR 样式
  fs.writeSync(1, '\x1b[?2004l') // 关闭 bracketed paste
  fs.writeSync(1, '\x1b[?25h')   // 显示光标
  fs.writeSync(1, '\x1b[?1049l') // 退出备用屏幕
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
}
```

### 11.4 双 Ctrl+C 退出 — `cli/src/index.ts:227`

```typescript
// packages/cli/src/index.ts:227
let sigintCount = 0
process.on('SIGINT', () => {
  sigintCount++
  if (sigintCount >= 2) {
    resetTerminal()
    process.exit(0)  // 第二次立即退出
  }
  // 第一次：让 Ink 优雅卸载（waitUntilExit resolve 后正常退出）
})
```

---

## 12. UI 层：ChatInput 渲染引擎

**文件：** `packages/cli/src/ui/components/ChatInput.tsx`
**辅助文件：**
- `ui/chat-input/cells.ts` — Cell 类型定义与转换（`textToCells`、`cellsEqual`）
- `ui/chat-input/palette.ts` — ANSI 样式常量（`S_CURSOR`、`S_DIM`、`S_SPINNER` 等）
- `ui/chat-input/text-helpers.ts` — 折行计算（`wrapCellsToRows`、`countContentRows`）
- `ui/text-width.ts` — CJK 字符宽度（`charWidth`、`visualWidth`）
- `ui/stdout-writer.ts` — 消息写入 scrollback（`writeMessageToStdout`）

### 12.1 为什么不用 Ink 的默认渲染？

> Ink 的 Yoga 布局引擎和 log-update 对 CJK/IME 字符宽度计算有误。

解决方案：**自己持有底部渲染区域**，用 ANSI 转义码直接写 `process.stdout`。向 Ink 返回 `null`（`ChatInput.tsx:403`），使 Ink 的动态区域始终为空。

### 12.2 Cell 级差分渲染 — `ChatInput.tsx:148`

```typescript
// packages/cli/src/ui/components/ChatInput.tsx
// 每帧 = Cell 二维网格（cells.ts:Cell 类型）
type Cell = {
  char: string
  style: string  // ANSI 样式前缀（palette.ts 中定义）
  width: number  // 1（ASCII）或 2（CJK 宽字符，text-width.ts:charWidth）
}

// 渲染流程：
// 1. buildFrame()     ← ChatInput.tsx:108  构建当前帧的 Cell 网格
// 2. buildDiffWrite() ← ChatInput.tsx:148  只发射有变化的格
// 3. process.stdout.write(singleAtomicWrite)  原子写入（无撕裂）
```

**DEC 2026 同步更新协议（BSU/ESU）：** `palette.ts` 中定义，将多次绘制包裹成原子操作，避免终端撕裂。

**核心优势：**
- 未变更的 CJK 格永不重新发射 → 无重绘抖动
- 单次原子写入 → 无帧间撕裂

### 12.3 帧结构 — `ChatInput.tsx:108`（`buildFrame`）

```
[可选] Spinner 行:  ◐ Thinking…        ← spinnerLabel 非 null 时显示，SPINNER_FRAMES（ChatInput.tsx:37）
       分隔线:      ──────────────────  ← S_DIM 样式（palette.ts）
       输入框行:    ❯ 用户输入的内容    ← buildInputCells()（ChatInput.tsx:67）
                      (多行时自动折行，最多 MAX_INPUT_ROWS=10 行)
[可选] notice 行:   提示信息
```

### 12.4 Scrollback 提交路径 — `ChatInput.tsx:267`

历史消息通过 `writeMessageToStdout()`（`stdout-writer.ts`）直接写入终端 scrollback（append-only，不可撤回），与动态区域完全分离：

```typescript
// packages/cli/src/ui/components/ChatInput.tsx:267
// 渲染 effect 中：
// 1. 提交新消息到 scrollback（stdout-writer.ts:writeMessageToStdout）
while (writtenMessageCountRef.current < messages.length) {
  writeMessageToStdout(captureWrite, msg)
  writtenMessageCountRef.current++
}
// 2. 为 scrollback 内容腾出空间（向上滚动，ChatInput.tsx:297~306）
// 3. 然后用差分算法更新动态区域（buildDiffWrite，ChatInput.tsx:148）
```

`DisplayMessage` 类型：`packages/cli/src/ui/display-types.ts`

### 12.5 InputState Reducer — `packages/cli/src/ui/chat-input/reducer.ts`

所有输入操作通过 `useReducer(inputReducer)`（`ChatInput.tsx:212`）进行，保证原子更新（文字+光标同一帧提交）：

```typescript
// packages/cli/src/ui/chat-input/reducer.ts:13
type InputAction =
  | { type: 'INSERT'; pos: number; chunk: string }
  | { type: 'BACKSPACE_REF'; pos: number; deleteCount: number }
  | { type: 'DELETE'; pos: number }
  | { type: 'SET_CURSOR'; cursor: number }
  | { type: 'SET_TEXT'; text: string; cursor: number }
  | { type: 'RESET' }
```

---

## 13. UI 层：输入处理 Hook

**文件：** `packages/cli/src/ui/hooks/use-prompt-input.ts`

### 13.1 括号粘贴（Bracketed Paste） — `use-prompt-input.ts:24`

```
挂载时：发送 \x1b[?2004h  → 终端启用括号粘贴（ENABLE_BRACKETED_PASTE，use-prompt-input.ts:24）
粘贴时：接收 \x1b[200~ 内容 \x1b[201~（PASTE_START/PASTE_END，use-prompt-input.ts:26~27）
卸载时：发送 \x1b[?2004l  → 终端禁用括号粘贴（DISABLE_BRACKETED_PASTE，use-prompt-input.ts:25）
```

### 13.2 两层粘贴检测策略

| 层 | 适用场景 | 机制 | 代码位置 |
|----|---------|------|---------|
| 括号粘贴（主路径） | 支持的终端 | 状态机识别 `\x1b[200~` 包裹 | `use-prompt-input.ts:212~261` |
| 防抖回退 | Windows Terminal/tmux等 | 30ms 防抖（`PASTE_DEBOUNCE_MS`）+ 50ms 上限（`MAX_BATCH_MS`） | `use-prompt-input.ts:116~150` |

**人工输入 vs 粘贴的区分（`use-prompt-input.ts:39`，`PASTE_SIZE_THRESHOLD = 32`）：**
- 人工输入：键击间隔 > 100ms，每个字符单独触发
- 粘贴：字节间隔 < 1ms，一个 tick 内填满 buffer

### 13.3 cursorRef 的设计 — `ChatInput.tsx:213`

```typescript
// packages/cli/src/ui/components/ChatInput.tsx:213
// cursor 在 useReducer 状态中（用于渲染）
// cursorRef 在 ref 中（用于事件处理）
// 两者始终同步（useLayoutEffect，ChatInput.tsx:214~216）：
const cursorRef = useRef(0)
useLayoutEffect(() => {
  cursorRef.current = cursor
})
```

**原因：** 键盘事件 handler 如果直接闭包 `cursor`，会捕获 stale 值；通过 ref 读取始终是最新值。Handler 注册处：`usePromptInput`（`use-prompt-input.ts:70`），handlers 存入 ref（`use-prompt-input.ts:75~78`）避免 effect 每次渲染重新订阅。

---

## 14. 辅助模块：Progress Reporter（进度侧信道）

**文件：** `packages/core/src/tools/progress.ts`

### 14.1 问题

AI SDK 的 `tool.execute(input, { toolCallId, ... })` 签名固定，无法在 `streamText({ tools })` 的静态定义阶段注入动态 UI 回调。

### 14.2 解决方案：模块级 registry — `progress.ts:29`

```typescript
// packages/core/src/tools/progress.ts:29
const reporters = new Map<string, ProgressReporter>()

// agent loop 在 tool-call 事件时注册（loop.ts:102）
setProgressReporter(toolCallId, (msg) => callbacks.onToolProgress(toolCallId, msg))

// 工具 execute 函数内调用（无需感知 UI 层）
reportProgress(toolCallId, 'Reading file...')  // progress.ts:62

// agent loop 在 tool-result 事件后清理（loop.ts:112）
clearProgressReporter(toolCallId)              // progress.ts:48
```

### 14.3 注册时机的重要性

必须在 `tool-call` 事件时注册（`loop.ts:101~103`，而非 `tool-result` 之后），否则工具执行开始的首批 progress 消息会丢失。

---

## 15. 完整数据流时序图

```
用户按 Enter
    │
    ▼
onSubmit(text)                                           [cli/src/ui/components/App.tsx:25]
    │
    ▼
agentLoop(userMessage, model, options, callbacks, existingState)
    │                                                    [core/src/agent/loop.ts:260]
    ├── state.messages.push({ role: 'user', content: userMessage })
    │
    └── while 循环
          │
          ▼
        runTurn()                                        [loop.ts:190]
          ├── repairOrphanToolCalls(state.messages)      [tool-result-sanitize.ts:76]
          │
          ├── streamText({
          │     model, system, messages: state.messages,
          │     tools: toolRegistry,                     [tools/index.ts:37]
          │     maxRetries: 3
          │   })
          │
          └── streamChunksToUI()                         [loop.ts:85]
                │
                ├── chunk.type = 'text-delta'
                │     └── callbacks.onTextDelta(text)    [loop.ts:97]
                │           └── UI 流式显示文字
                │
                ├── chunk.type = 'tool-call'  [auto-execute 工具]
                │     ├── setProgressReporter(...)       [progress.ts:38]
                │     └── callbacks.onToolCall(...)      [loop.ts:104]
                │
                ├── chunk.type = 'tool-result'  [auto-execute 结果]
                │     ├── clearProgressReporter(...)     [progress.ts:48]
                │     └── callbacks.onToolResult(...)    [loop.ts:113]
                │
                └── collectTurnResponse()                [loop.ts:128]
                      ├── truncateToolResultsInMessages  [tool-result-sanitize.ts:183]
                      ├── state.messages.push(...)
                      └── callbacks.onUsageUpdate(...)   [loop.ts:148]

          ↓ finishReason = 'tool-calls'
          │
          ▼
        processToolCalls(toolCalls, state, options, callbacks)
          │                                              [tool-execution.ts:454]
          ├── 过滤幽灵调用（collectActiveAssistantToolCallIds，tool-execution.ts:385）
          ├── 过滤已完成调用（collectFulfilledToolCallIds，tool-execution.ts:409）
          │
          └── 对每个工具（handleToolCall，tool-execution.ts:336）：
                ├── [askUser] handleAskUser()            [tool-execution.ts:210]
                │
                ├── applyLoopGuard()                     [tool-execution.ts:239]
                │     ├── ok → recordToolCall()          [loop-guard.ts:125]
                │     ├── soft-block → pushToolResult(...guardMessage)
                │     └── hard-block → callbacks.onAskUser() → 等待用户
                │
                ├── checkWriteOrShellPermission()        [tool-execution.ts:277]
                │     └── checkPermission()              [permissions/index.ts:128]
                │           └── onAskPermission() → 等待用户确认
                │
                └── executeWriteOrShell()                [tool-execution.ts:303]
                      ├── writeFile → executeWriteTool() [tool-execution.ts:59]
                      ├── edit → executeWriteTool()      [tool-execution.ts:76]
                      └── shell → executeShell()         [tool-execution.ts:108]
                                  → getShellProvider().spawn() [shell-provider.ts:102]

          ↓ finishReason = 'stop'
          │
          ▼
        return { state, turnCount }                      [loop.ts:351]
```

---

## 16. 关键设计决策与模式总结

### 16.1 AgentCallbacks 接口：核心-UI 解耦

**文件：** `packages/core/src/types/index.ts:23`

```typescript
// packages/core/src/types/index.ts:23
interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onToolCall: (toolCallId, toolName, input) => void
  onToolProgress: (toolCallId, message) => void
  onToolResult: (toolCallId, result, isError?) => void
  onAskPermission: (...) => Promise<'yes' | 'always' | 'no'>
  onAskUser: (question, options) => Promise<string>
  onShellOutput: (chunk: string) => void
  onUsageUpdate: (usage: TokenUsage) => void
  onError: (error: Error) => void
}
```

`core` 只面向 `AgentCallbacks` 编程，不知道 UI 层的存在。这使得 core 可以被不同的 UI（Ink、Web、测试）驱动。

### 16.2 in-band 错误 vs throw

**文件：** `packages/core/src/agent/messages.ts`

工具执行失败有两条路径：
1. **throw**（意外错误）→ catch → `toolErrorFromUnknown()`（`messages.ts:67`）→ 作为 tool_result 推入
2. **返回 "Error: ..." 字符串**（预期失败）→ `isToolErrorString()`（`messages.ts:75`）检测 → 翻转 UI 颜色

这样 `writeFile`/`edit` 的"文件不存在"等逻辑错误（`tool-execution.ts:86~89`）不会产生异常堆栈，模型也能正确理解并调整策略。

### 16.3 drainStreamResult：防 unhandledRejection

**文件：** `packages/core/src/agent/stream-utils.ts:87`

```typescript
// packages/core/src/agent/stream-utils.ts:87
// streamText 返回的对象有 4 个兄弟 Promise
// 任何一个出错时，未 await 的那些会变成 unhandledRejection
// 提前挂 noop .catch() 可以防止 Node.js 打印错误或终止进程
export function drainStreamResult(result: StreamResult): void {
  const noop = () => {}
  Promise.resolve(result.response).catch(noop)
  Promise.resolve(result.finishReason).catch(noop)
  Promise.resolve(result.usage).catch(noop)
  Promise.resolve(result.toolCalls).catch(noop)
}
```

调用处：`loop.ts:222`（streamText 调用后立即），`loop.ts:227`（streamChunksToUI 出错后）。

### 16.4 消息历史的正确性保证

| 问题 | 解决方案 | 代码位置 |
|------|---------|---------|
| tool_call 无对应 tool_result（正向孤立） | `repairOrphanToolCalls()` 合成错误 result | `tool-result-sanitize.ts:139~172` |
| tool_result 无前驱 tool_call（反向孤立） | `repairOrphanToolCalls()` 删除孤立 result | `tool-result-sanitize.ts:91~125` |
| auto-execute 结果超长 | `truncateToolResultsInMessages()` | `tool-result-sanitize.ts:183` |
| 手动工具结果超长 | `processToolCalls` 中 `truncateToolResult()` | `tool-execution.ts:368` |
| 消息排序违规（user 插在 tool 中间） | deferred 队列，等所有 tool_result 后才 flush | `tool-execution.ts:463~513` |

### 16.5 Shell 权限缓存

**文件：** `packages/core/src/permissions/index.ts:29`

```typescript
// packages/core/src/permissions/index.ts:29
// 破坏性/只读分类是静态的，可以安全缓存（无需 TTL）
// 上限 256 条防止长时间运行的 agent 无限积累
const SHELL_PERMISSION_CACHE_MAX = 256
const shellPermissionCache = new Map<string, PermissionLevel>()
```

缓存逻辑：`resolveShellPermission()`（`permissions/index.ts:42`），LRU 驱逐最旧条目（`index.ts:50`）。

### 16.6 流式响应的 body 保护

**文件：** `packages/core/src/providers/registry.ts:185`

```typescript
// packages/core/src/providers/registry.ts:185
// SSE 流式响应的 body 是 ReadableStream，读完后指针在末尾无法复位
// 必须在 status < 400 时快速返回，绝不能调用 .text() 或 .json()
if (response.status < 400) return response  // 这一行保护了整个流式输出
```

---

## 附录：关键常量速查

| 常量 | 值 | 文件位置 | 含义 |
|------|-----|---------|------|
| `MAX_CONTINUATIONS` | 3 | `agent/loop.ts:285` | 最大续写次数 |
| `SOFT_LOOP_THRESHOLD` | 3 | `agent/loop-guard.ts:28` | 软警告阈值 |
| `HARD_LOOP_THRESHOLD` | 5 | `agent/loop-guard.ts:31` | 硬中断阈值 |
| `LOOP_WINDOW_SIZE` | 8 | `agent/loop-guard.ts:34` | 滑动窗口大小 |
| `MAX_TOOL_RESULT_LINES` | 2000 | `tools/truncate.ts:23` | 工具结果行数上限 |
| `MAX_TOOL_RESULT_BYTES` | 50KB | `tools/truncate.ts:30` | 工具结果字节上限 |
| `DEFAULT_HEAD_RATIO` | 0.2 | `tools/truncate.ts:33` | head-tail 头部占比 |
| `MAX_SHELL_BUFFER` | 20MB | `tools/shell-provider.ts:22` | shell 输出缓冲区上限 |
| `SHELL_PERMISSION_CACHE_MAX` | 256 | `permissions/index.ts:29` | shell 权限缓存上限 |
| `PROGRESS_THROTTLE_MS` | 50ms | `agent/tool-execution.ts:120` | shell 进度节流间隔 |
| `PASTE_DEBOUNCE_MS` | 30ms | `ui/hooks/use-prompt-input.ts:31` | 粘贴防抖时间窗口 |
| `MAX_BATCH_MS` | 50ms | `ui/hooks/use-prompt-input.ts:35` | 粘贴批次最大时长 |
| `PASTE_SIZE_THRESHOLD` | 32 | `ui/hooks/use-prompt-input.ts:39` | 粘贴大小检测阈值 |
| `MAX_INPUT_ROWS` | 10 | `ui/components/ChatInput.tsx:38` | 输入框最大行数 |
| `MINI_CODE_DIR` | `.mini-code` | `core/src/utils.ts:7` | 项目配置目录名 |
