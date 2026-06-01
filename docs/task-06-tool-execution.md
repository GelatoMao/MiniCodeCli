# Task-06: 工具调用循环（完整 ReAct）

## 概述

本任务实现了 agent loop 的完整 ReAct（Reasoning + Acting）循环，让 AI 模型能够调用工具、
获取结果、再根据结果继续推理——形成真正的"思考 → 行动 → 观察"迭代。

**新增文件：**
- `packages/core/src/agent/messages.ts` — 消息构造工具函数
- `packages/core/src/agent/loop-guard.ts` — 死循环断路器
- `packages/core/src/agent/tool-execution.ts` — 工具调度核心
- `packages/core/src/agent/tool-result-sanitize.ts` — 结果修复与截断

**修改文件：**
- `packages/core/src/agent/loop-state.ts` — 新增 `recentToolCalls` 字段
- `packages/core/src/agent/loop.ts` — 接入完整 ReAct 循环

---

## 核心设计决策

### 1. 工具执行的两条路径

AI SDK 的工具有两种执行模式，理解这个区别是整个系统的关键：

```
auto-execute 工具（有 execute 函数）       手动分发工具（无 execute 函数）
  readFile, glob, grep, listDir              writeFile, edit, shell

    模型发出 tool-call
         ↓
    AI SDK 自动执行                         AI SDK 输出 tool-call chunk
    结果写入 response.messages               agentLoop 收到 finishReason='tool-calls'
    UI 通过 tool-result chunk 得知               ↓
                                            processToolCalls 手动执行
                                            结果写入 state.messages
                                            UI 通过 callbacks.onToolResult 得知
```

**为什么要分开？**

- auto-execute 工具（只读，无副作用）：安全自动执行，速度快
- 手动工具（写文件、执行命令）：需要经过权限检查，可能弹出确认框，不能由 SDK 独立决策

### 2. toolRegistry 传给 streamText

task3 阶段 `streamText` 不传 `tools`，模型无法调用工具。task6 中增加了 `buildTools()` 函数，
将工具注册表传入：

```typescript
result = streamText({
  model,
  system: systemPrompt,
  messages: state.messages,
  tools: effectiveTools,  // ← task6 新增
  ...
})
```

传入工具后，模型输出时 `finishReason` 可能为 `'tool-calls'`，进入工具执行分支。

### 3. Loop Guard — 死循环断路器

**问题背景：** 模型在工具调用失败后，有时会用完全相同的参数重试同一工具 5~10 次，
每次失败都把堆栈追加到 context，最终耗尽 context window。

**解决方案：** 滑动窗口 + SHA256 哈希检测

```
checkForLoop(state, toolName, input, toolCallId)
  ├── 计算 hash = SHA256(toolName + stableJSON(input))[:16]
  ├── 扫描 state.recentToolCalls 最近 8 次，统计相同 hash 的次数
  ├── 达到阈值 3 → soft-block：注入合成 result，告知模型"停止重试"
  └── 达到阈值 5 → hard-block：弹出用户确认框
```

**stable stringify** 的意义：确保 `{a:1,b:2}` 和 `{b:2,a:1}` 产生相同哈希，
防止对象键序不同导致哈希不同、漏掉循环检测。

### 4. repairOrphanToolCalls — 孤立调用修复

**问题背景：** Provider 严格要求 tool_call ↔ tool_result 一一配对。
但有两种情况会打破这个配对：

1. **正向孤立**（tool_call 无 result）：模型输出了 malformed 工具输入，
   SDK 校验失败，发 tool-error event，但不一定产生 response.messages 里的对应 result。
2. **反向孤立**（tool_result 无 call）：SDK 发 tool-error 并把 tool_call 排除出
   response.messages，但 processToolCalls 还从 result.toolCalls 里读到了这个"幽灵调用"
   并推了 tool_result 进去。

**修复策略：**
```
正向孤立 → 合成一条错误 result（模型会看到并调整策略）
反向孤立 → 删除这条孤立 result（若两侧都是 assistant 则替换为 user 占位消息）
```

每次 `runTurn` 开始前调用 `repairOrphanToolCalls`，是防御性编程的典型用法。

### 5. truncateToolResultsInMessages — auto-execute 结果截断

**问题背景：** `grep` 匹配 2000 行、`readFile` 读 800 行文件的完整内容，
每轮都带着全量内容调用 API，迅速耗尽 context window（最坏案例：9M tokens 的对话历史）。

**解决方案：** 在 `collectTurnResponse` 把 `response.messages` push 进 `state.messages` 之前，
先调用 `truncateToolResultsInMessages` 裁剪每个 tool-result part 的输出。

各工具采用不同策略：
- `readFile`：head-tail（保留文件开头和结尾，中间裁掉）
- `grep / glob / listDir`：head only，最多 500 行（词典序列表，头部最有信息量）

### 6. 延迟消息队列（deferred）

**问题：** Loop Guard 的 hard-block 需要在工具结果之后追加一条 `role: 'user'` 消息，
但如果在遍历工具调用的中途插入这条消息，会产生：
```
assistant (tool_calls) → tool A result → user (loop-guard) → tool B result
```
DeepSeek 等严格 provider 会因为 tool B result 前没有对应 assistant tool_call 而 400。

**解决方案：** `deferred` 队列收集需要推迟的消息，在 `processToolCalls` 的最后统一 flush：
```typescript
if (deferred.length > 0) state.messages.push(...deferred)
```

---

## 关键代码解析

### processToolCalls 的执行流程

```
processToolCalls(toolCalls, state, options, callbacks)
  │
  ├── collectActiveAssistantToolCallIds(state)  — 收集本轮 assistant 消息中的 id
  ├── collectFulfilledToolCallIds(state)        — 收集已有 result 的 id（auto-execute）
  │
  ├── 预扫描：
  │     ├── 幽灵调用（不在 assistant 消息里）→ 跳过，不推 result
  │     └── 已完成调用（有 result）→ 记录 loop-guard，跳过执行
  │
  ├── partitionToolCalls(liveCalls)             — task 工具批量并行，其他串行
  │
  └── 遍历批次：
        └── handleToolCall(tc, ...)
              ├── BYPASS_LOOP_GUARD_HANDLERS[toolName]?  → 直接处理（askUser 等）
              ├── applyLoopGuard()                        → 循环守卫
              ├── checkWriteOrShellPermission()           → 权限检查
              └── executeWriteOrShell()                   → 实际执行
```

### collectActiveAssistantToolCallIds 的必要性

```typescript
// result.toolCalls 里可能包含"幽灵调用"（SDK 校验失败后排除出 response.messages 的）
// 如果不过滤，对幽灵调用执行 writeFile 会：
//   1. 触发真实文件写入（副作用）
//   2. 推入孤立 tool_result（下次 API 请求 400）
const activeIds = collectActiveAssistantToolCallIds(state)
if (activeIds.size > 0 && !activeIds.has(tc.toolCallId)) {
  continue  // 跳过幽灵调用
}
```

---

## 与原项目（x-code-cli）的差异对比

| 特性 | mini-code-cli（task6）| x-code-cli |
|------|----------------------|------------|
| 工具集 | 静态 toolRegistry | buildTools() 含 task/MCP 工具 |
| Loop Guard | ✅ 完整实现 | ✅ 完整实现 |
| 权限检查 | ✅ checkPermission | ✅ checkPermission |
| 孤立修复 | ✅ repairOrphanToolCalls | ✅ repairOrphanToolCalls |
| 结果截断 | ✅ 基础截断策略 | ✅ 更多工具策略（webFetch 等）|
| Shell 错误折叠 | ❌ 未实现 | ✅ foldShellErrorNoise |
| Plugin Hooks | ❌ 未实现 | ✅ PreToolUse/PostToolUse |
| MCP 工具分发 | ❌ 未实现 | ✅ handleMcpToolCall |
| 文件 diff 渲染 | ❌ 未实现 | ✅ computeEditDiff + onFileEdit |
| Length 续写 | ✅ MAX_CONTINUATIONS=3 | ✅ MAX_CONTINUATIONS=3 |

主要简化：
1. **无 Plugin Hooks**：原项目有 PreToolUse/PostToolUse 钩子，允许第三方插件拦截和修改工具调用。
2. **无 MCP 工具**：原项目支持通过 Model Context Protocol 注册外部工具服务器。
3. **无 diff 渲染**：原项目 writeFile/edit 执行前会读旧内容计算 diff，通过 `onFileEdit` 回调传给 UI。

---

## 踩过的坑

### 1. tool-call 时必须注册 progress reporter

```typescript
// ❌ 错误：在 tool-result 时才注册，但 execute() 已经开始了
} else if (chunk.type === 'tool-result') {
  setProgressReporter(chunk.toolCallId, ...)  // 太晚了！

// ✅ 正确：在 tool-call 时立即注册
} else if (chunk.type === 'tool-call') {
  if (toolCallId) setProgressReporter(toolCallId, ...)  // 在执行前注册
```

AI SDK 在 `tool-call` 事件之后同步调用 `execute()`，所以 progress reporter 必须在
`tool-call` 事件处理时注册，否则 execute 函数里的第一批 reportProgress 调用会找不到 reporter。

### 2. deferred 消息必须在所有 tool_result 之后

Loop Guard 的 hard-block 需要追加一条 `role: 'user'` 消息告知模型暂停，
但如果立即 push 进 state.messages，会在两个 tool_result 之间插入 user 消息：

```
❌ 违规顺序：assistant tool_calls → tool A → user (loop-guard) → tool B
✅ 正确顺序：assistant tool_calls → tool A → tool B → user (loop-guard)
```

DeepSeek 等 provider 对消息顺序有严格要求，错误顺序会返回 400。
解决方案是 deferred 队列，确保所有工具结果推完后再 flush。

### 3. 正向孤立合成 result 的位置

`orphanParts` 要合并到已有 tool 消息的末尾，而不是新建一条单独的 tool 消息：

```typescript
// ❌ 问题：可能产生两条相邻的 tool 消息（某些 provider 不接受）
messages.push({ role: 'tool', content: orphanParts })

// ✅ 正确：合并到已有的末尾 tool 消息
const tail = messages[messages.length - 1]
if (tail?.role === 'tool') {
  tail.content.push(...orphanParts)  // 合并
} else {
  messages.push({ role: 'tool', content: orphanParts })  // 才新建
}
```
