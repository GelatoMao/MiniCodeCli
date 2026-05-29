# 任务 3：最简 agentLoop（单轮 streamText）

**参照源码（x-code-cli）：**
- `packages/core/src/agent/loop-state.ts`
- `packages/core/src/agent/stream-utils.ts`
- `packages/core/src/agent/loop.ts`

---

## 一、核心概念

### agentLoop 是什么

`agentLoop` 是整个 AI 编程助手的"心脏"。它的职责是：

1. 把用户的消息发给 LLM
2. 把 LLM 的回答流式推给 UI
3. 如果 LLM 要调用工具，执行工具并把结果发回给 LLM
4. 重复 1-3，直到 LLM 说"我说完了"（`finishReason === 'stop'`）

```
用户输入
  │
  ▼
agentLoop（本 task 实现骨架）
  │
  ├─ runTurn ─── streamText ──► LLM API（流式）
  │      │              │
  │      │        fullStream chunk 事件
  │      │              │
  │      └─ streamChunksToUI ──► UI callbacks（实时推送）
  │
  └─ collectTurnResponse ──► state.messages / state.tokenUsage
```

task3 只实现了最基础的单轮路径（`finishReason === 'stop'`），工具调用分支（`finishReason === 'tool-calls'`）留给 task6 实现。

### streamText 与 generateText 的区别

AI SDK 提供两个主要的文字生成函数：

| 函数 | 行为 | 适用场景 |
|------|------|---------|
| `generateText` | 等待全部生成完才返回 | 批处理、测试 |
| `streamText` | 立即返回，token 边生成边推送 | 交互式 CLI、Web 流式输出 |

CLI 必须用 `streamText`，否则用户盯着空屏等 5-10 秒才看到第一个字——体验很差。

`streamText` 返回的结果对象是"立即可用的"——调用时内部已经发起了 HTTP 请求。它暴露了多个并发的 Promise 和一个异步迭代器 `fullStream`：

```typescript
const result = streamText({ model, messages, ... })
// 此时请求已经发出！

// 迭代 fullStream，边生成边消费
for await (const chunk of result.fullStream) { ... }

// 流结束后，这些 Promise 才会 resolve
await result.response     // 完整的消息对象
await result.usage        // token 用量统计
await result.finishReason // 'stop' | 'tool-calls' | 'length' | ...
```

### LoopState — 会话的"血液"

`LoopState` 是整个会话生命周期中共享的可变状态对象。关键字段：

```typescript
interface LoopState {
  messages: ModelMessage[]    // 完整的消息历史（user/assistant/tool 轮替）
  tokenUsage: TokenUsage      // 累计 token 用量
  lastInputTokens: number     // 最近一次请求的 input tokens（用于触发压缩）
  sessionId: string           // 会话 ID，用于文件命名和缓存 key
  systemPromptCache: string | null  // 系统提示缓存（保证前缀字节稳定）
  permissionMode: PermissionMode    // 当前权限模式
}
```

为什么要把 state 单独抽出来？

**因为每次用户提交消息都会调用一次 `agentLoop`，但消息历史必须跨调用保留。** 做法是把 state 传出来，下次调用时作为 `existingState` 传回去：

```
用户提交 "你好" → agentLoop(msg, ...) → 返回 { state }
用户提交 "继续" → agentLoop(msg, ..., existingState=state) → 返回 { state }
```

state 的生命周期和 CLI 进程一样长（整个会话），而不是每次提交都新建。

### StreamResult — 最小化类型包装

AI SDK 的 `streamText` 返回类型有复杂的泛型参数，直接在业务代码里用会让类型签名非常冗长。`StreamResult` 接口只声明我们实际使用的字段：

```typescript
export interface StreamResult {
  fullStream: AsyncIterable<{ type: string; text?: string; ... }>
  response: Promise<{ messages: ModelMessage[] }>
  usage: Promise<{ inputTokens?: number; outputTokens?: number; ... } | undefined>
  finishReason: Promise<string>
  toolCalls: Promise<Array<{ toolName: string; toolCallId: string; input: ... }>>
}
```

在 `runTurn` 里用 `as unknown as StreamResult` 做类型断言：

```typescript
result = streamText({ ... }) as unknown as StreamResult
```

这样所有后续代码都基于 `StreamResult` 这个简单接口，不需要到处写 `Awaited<ReturnType<typeof streamText>>` 这种类型体操。

---

## 二、关键代码解析

### streamChunksToUI — chunk 分发器

`fullStream` 的每个 chunk 有一个 `type` 字段区分种类：

```typescript
async function streamChunksToUI(result: StreamResult, callbacks: AgentCallbacks): Promise<void> {
  for await (const chunk of result.fullStream) {
    if (chunk.type === 'error') {
      // ① 错误 chunk：re-throw，让外层 try/catch 分类处理
      throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error))
    }
    if (chunk.type === 'text-delta') {
      callbacks.onTextDelta(chunk.text ?? '')   // ② 文字 delta：直接推给 UI
    } else if (chunk.type === 'tool-call') {
      callbacks.onToolCall(...)                 // ③ 工具调用：通知 UI 显示工具行
    } else if (chunk.type === 'tool-result') {
      callbacks.onToolResult(...)               // ④ 工具结果：auto-execute 工具的输出
    }
    // ⑤ 其余 chunk（reasoning-delta 等）：静默丢弃
  }
}
```

**为什么 error chunk 要 re-throw？**

AI SDK 不会从 `for await` 迭代中抛出错误——它把错误封装成一个 `{ type: 'error', error: ... }` chunk 推入流，然后关闭流。如果不在这里 re-throw，外层的 `for await` 循环会**正常完成**（没有抛出），然后 `await result.response` 才会以 `NoOutputGeneratedError` 拒绝——用户看到的是一个语义不明的错误，而不是真实原因（如"insufficient balance"）。

**reasoning-delta 为什么丢弃？**

`reasoning-delta` 是 DeepSeek-R1、o1 等"思考模型"的链式推理过程，是模型的内部思考，不是给用户看的。丢弃它对功能无影响，避免把 `<think>...</think>` 的内容意外渲染到 UI。

### collectTurnResponse — 收集响应写入 state

```typescript
async function collectTurnResponse(result, state, callbacks): Promise<string> {
  const response = await result.response
  state.messages.push(...response.messages)  // ① 追加本轮消息到历史

  const usage = await result.usage
  if (usage) {
    state.tokenUsage.inputTokens += usage.inputTokens ?? 0
    state.tokenUsage.outputTokens += usage.outputTokens ?? 0
    // cacheReadTokens 是 inputTokens 的子集，不能重复计入 total
    state.tokenUsage.cacheReadTokens += usage.inputTokenDetails?.cacheReadTokens ?? 0
    state.tokenUsage.cacheCreationTokens += usage.inputTokenDetails?.cacheWriteTokens ?? 0
    state.tokenUsage.totalTokens = state.tokenUsage.inputTokens + state.tokenUsage.outputTokens

    // currentContextTokens：本轮的，不累计（用于 UI 的"N / M · X%"占用率）
    state.tokenUsage.currentContextTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    if (usage.inputTokens != null) state.lastInputTokens = usage.inputTokens

    callbacks.onUsageUpdate(state.tokenUsage)  // ② 通知 UI 刷新 token 计数器
  }
  return result.finishReason  // ③ 返回结束原因，调用方决定是否继续循环
}
```

**tokenUsage 的累计 vs 快照：**

- `inputTokens` / `outputTokens` / `totalTokens`：跨所有 turn **累加**，用于 `/usage` 命令显示整个会话的费用
- `currentContextTokens`：每轮**覆盖**，反映当前上下文窗口实际占用，用于 UI 底部"N / M · X%"指标

两者语义不同，不能混用。

### drainStreamResult — 防 unhandledRejection

这是一个防御性工具函数，每当流出错时调用：

```typescript
export function drainStreamResult(result: StreamResult): void {
  const noop = () => {}
  Promise.resolve(result.response).catch(noop)
  Promise.resolve(result.finishReason).catch(noop)
  Promise.resolve(result.usage).catch(noop)
  Promise.resolve(result.toolCalls).catch(noop)
}
```

**为什么需要它？**

当 `streamText` 内部发生请求错误时，AI SDK 会同时 reject `response`、`finishReason`、`usage`、`toolCalls` 这四个 Promise。如果我们的代码只从 `fullStream` 的 error chunk 里捕获了错误，而没有给这四个 Promise 挂 `.catch()` handler，Node.js 的 `unhandledRejection` 扫描会先于我们的 catch 块运行，打印 `NoOutputGeneratedError` 到 stderr，甚至在某些配置下终止进程。

调用 `drainStreamResult` 相当于"先给它们都挂上消音器"。**这不会影响功能**——稍后执行 `await result.response` 依然会正常 reject 并被我们的 `try/catch` 捕获。

### TurnOutcome — 单轮结果的 discriminated union

```typescript
type TurnOutcome =
  | { kind: 'done'; finishReason: string; result: StreamResult }
  | { kind: 'error' }
  | { kind: 'aborted' }
```

为什么用 union 而不是直接 throw？

**因为 agentLoop 循环需要在不同情况下采取不同行动，throw 会破坏控制流。** 用 union 可以让 `agentLoop` 的主循环用 `if/break` 结构清晰地表达：

```typescript
if (outcome.kind === 'error') break        // 错误已上报，退出
if (outcome.kind === 'aborted') break      // 用户中断，退出
if (outcome.finishReason === 'stop') break // 正常结束，退出
if (outcome.finishReason === 'tool-calls') { ... continue } // 去执行工具，继续循环
```

### isAbortError — 可靠的中断检测

```typescript
function isAbortError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true              // ① 最可靠的方式
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true  // ② 标准错误名
    if (/aborted|AbortError/i.test(err.message)) return true  // ③ 兜底
  }
  return false
}
```

**为什么不只检查 `err.name === 'AbortError'`？**

部分 provider SDK（尤其是通过自定义 fetch 接入的第三方）会把底层的 `AbortError` 包裹进自己的错误类，导致 `err.name` 不是 `'AbortError'`。但它们都会在 abort 前先翻转 `signal.aborted` 标志——所以**检查 signal 是最可靠的方式**，错误名检查只是后备。

---

## 三、与原项目的差异

| 项目 | x-code-cli | mini-code-cli（task3） | 原因 |
|------|-----------|------------------------|------|
| 系统提示 | `buildSystemPrompt()`（含知识库、git 状态、工具描述等） | 静态字符串 | task-A 实现 `buildSystemPrompt` |
| 工具注册 | `buildTools(options)`（toolRegistry + task 工具 + MCP 工具） | 不传工具 | task4-6 逐步实现 |
| `tool-calls` 分支 | 完整的 `processToolCalls` | 报错占位 | task6 实现 |
| `length` 续写 | 自动推送"继续"消息，最多 3 次 | 报错退出 | task6 可扩展 |
| Context 压缩 | `checkAndCompressContext`（每 turn 前检查） | 无 | task14 实现 |
| 会话持久化 | `flushPendingMessages`、`appendUsage` | 无 | task14 实现 |
| 内存提取器 | `runMemoryExtractor`（stop 后异步运行） | 无 | task-A 实现 |
| Plugin hooks | `UserPromptSubmit`、`TurnComplete` | 无 | 可选扩展功能 |
| `LoopState` 字段数 | ~15 个（含 todos、planPath、taskSlug 等） | 7 个 | 随 task 递增 |

核心三函数（`streamChunksToUI`、`collectTurnResponse`、`agentLoop`）的逻辑与原项目**完全一致**，差异只在于把尚未实现的依赖（工具、压缩、持久化等）先移除，留下骨架。

---

## 四、踩坑 & 疑问

**Q：`streamText` 不需要 `await` 吗？**

不需要。`streamText(...)` 是同步调用，它立即返回一个结果对象（内部已发起 HTTP 请求）。真正的异步操作发生在消费 `fullStream` 时（`for await`）和 `await result.response` 时。

对比 `fetch`——`fetch(url)` 也是立即发出请求，返回一个 Promise；`await fetch(url)` 才是等待响应头回来。`streamText` 类似，但返回的不是 Promise 而是一个多接口的结果对象。

---

**Q：`collectTurnResponse` 里的 `state.messages.push(...response.messages)` 为什么是 `response.messages` 而不是直接把流里的文字拼起来？**

`response.messages` 包含的是**结构化消息**，不仅仅是文字。以工具调用为例，一个 assistant 消息可能包含：

```typescript
{
  role: 'assistant',
  content: [
    { type: 'text', text: '我来读一下这个文件' },
    { type: 'tool-call', toolCallId: 'tc_1', toolName: 'readFile', input: { path: 'src/index.ts' } }
  ]
}
```

如果只拼文字，工具调用部分就丢了。下次请求时 LLM 不知道自己刚才调用了什么工具，会出现"孤立的 tool_result 没有对应的 tool_call"这类错误。`response.messages` 保留了完整的结构，才能维持正确的会话历史。

---

**Q：`generateSessionId` 为什么用本地时间而不是 UTC？**

用本地时间是为了人类可读性——在 `ls .x-code/sessions/` 里看到 `20260529-143022-123` 这样的目录名，人们会自然地把它理解成本地时间的 14:30，而不需要做时区换算。唯一性由毫秒尾保证，不依赖时区正确性。

---

**Q：为什么 `TurnOutcome` 里的 `done` 变体还带着 `result: StreamResult`？**

因为 `finishReason === 'tool-calls'` 分支需要读取 `result.toolCalls`（一个 Promise），才能知道 LLM 要调用哪些工具。`result` 需要从 `runTurn` 传出来给 `agentLoop` 的主循环使用。task3 阶段用不到，但 task6 实现工具循环时就需要了。

---

## 五、自测验证

```bash
pnpm typecheck
# 期望：无报错静默退出
```

| 验证项 | 结果 |
|--------|------|
| `pnpm typecheck` | ✅ 无报错 |

task3 没有配套单元测试（agentLoop 骨架依赖真实 LLM 调用，更适合集成测试；独立可测的工具函数从 task4 开始才引入）。

---

[← 任务 2](./task-02-provider-registry.md) | [返回索引](./README.md) | [任务 4 →](./task-04-file-tools.md)
