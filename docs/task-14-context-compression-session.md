# Task 14：Context 压缩 + 会话持久化

## 核心设计决策

### 1. 为什么用 JSONL 格式？

**对比 JSON 全量写入：**

| 特性 | JSONL 增量追加 | JSON 全量重写 |
|------|-------------|------------|
| 崩溃安全 | ✅ 每条消息写入后即持久化 | ❌ 崩溃会丢失当轮所有消息 |
| 写入放大 | O(新消息数) | O(全部消息数) |
| 并发写入 | append-only，天然安全 | 需要 fsync + rename 原子替换 |
| 人工可读 | 每行独立 JSON，方便 grep | 需整体解析 |

JSONL 的 append-only 特性让"崩溃恢复"变得简单：只需从第一行（header）开始读到文件末尾，跳过解析失败的行即可。

### 2. 增量写入的游标设计

```
state.messages:  [msg0, msg1, msg2, msg3, msg4]
                                         ↑
state.persistedMessageCount = 4  ←──── 游标

下次 flush 只写 messages.slice(4) = [msg4]
```

`persistedMessageCount` 是一个纯游标，不需要额外的状态。每次 flush 只追加 `messages.slice(persistedMessageCount)` 的部分，写完后将游标推进到 `messages.length`。

### 3. compact-boundary 的作用

当 context 被压缩时，旧消息不会从 JSONL 文件删除，而是写入一条 `compact-boundary` 记录：

```jsonl
{"type":"message","role":"user","content":"early conversation..."}
{"type":"message","role":"assistant","content":"early reply..."}
{"type":"compact-boundary","summary":"The user asked to fix login..."}
{"type":"message","role":"user","content":"[Context compressed]"}
{"type":"message","role":"assistant","content":"Summary: ..."}
```

`loadSession` 解析时遇到 `compact-boundary` 会 **清空已收集的 messages**，只保留边界之后的消息。这样：
- 会话文件保留了完整历史（不丢数据）
- 恢复时只加载压缩后的有效部分（不重复 token 消耗）

### 4. Context 压缩的触发与恢复

**触发条件：**
```
state.lastInputTokens >= getCompressionThreshold(modelId)
// 即：上一轮的 inputTokens >= context window * 80%
```

**为什么用 `lastInputTokens` 而不是 `tokenUsage.inputTokens`？**

`tokenUsage.inputTokens` 是累计值（跨所有 turn 求和），会随对话越来越大，不能用于判断"当前请求是否快满了"。`lastInputTokens` 是上一轮单次请求花费的 tokens，反映了当前 context 的实际大小。

**压缩流程：**

```
1. appendCompactBoundary(state, summary, cwd)
   └─ 写入 compact-boundary 行（在修改 state 前！确保可恢复）
2. state.messages = [user: "[Context compressed]", assistant: summary]
3. state.systemPromptCache = null  ← 触发下轮重建系统提示
4. state.persistedMessageCount = 0  ← 新起点，重新计游标
5. state.lastInputTokens = 0  ← 防止下一轮立即再次触发
6. onContextCompressed?.()  ← 通知 UI
```

**为什么在修改 state 之前先写 JSONL？**

如果 `appendCompactBoundary` 在 `state.messages = [...]` 之后抛出（如磁盘满），JSONL 文件里就没有压缩边界，但 state 里消息已经被替换了。下次恢复时就会错误地用压缩后的短历史，而不是完整历史。"先写 JSONL，再改 state"确保两者始终一致。

### 5. hydrateLoopState 的"懒恢复"策略

从 LoadedSession 重建 LoopState 时，大部分字段直接置为初始值：

```typescript
// tokenUsage 初始为 0：不需要从历史重建，它只用于 UI 显示当轮用量
// systemPromptCache 为 null：首次 runTurn 会重新构建，自然包含"已压缩"标注
// recentToolCalls 为空：Loop Guard 对旧历史不感兴趣，只关注当前 session 的行为
// filesModified 为空 Set：恢复时暂不重建（会在后续操作中自动填充）
```

只有 `messages`、`sessionId`、`taskSlug`、`persistedMessageCount`、`sessionFilePath` 需要从 LoadedSession 准确恢复。

## 关键代码解析

### `flushPendingMessages` — 核心思路

```typescript
export function flushPendingMessages(state: LoopState, modelId: string, cwd?: string): void {
  const filePath = state.sessionFilePath ?? getSessionFilePath(state.sessionId, cwd)
  if (!state.sessionFilePath) {
    state.sessionFilePath = filePath  // 缓存路径，避免每次重新计算
  }

  // appendHeader 是幂等的：文件存在时跳过
  appendHeader(filePath, state.sessionId, state.taskSlug ?? '', modelId, firstPrompt)

  // 只追加新增部分
  const pending = state.messages.slice(state.persistedMessageCount)
  for (const msg of pending) {
    appendLine(filePath, { type: 'message', role: msg.role, content: msg.content })
  }
  state.persistedMessageCount = state.messages.length  // 推进游标
}
```

### `loadSession` — 解析规则

```
line 1: {"type":"header",...}  → 填充 header 字段
line 2-N: {"type":"message",...} → push 到 messages
line M: {"type":"compact-boundary","summary":"..."} → messages.length = 0（清空）
line M+1-...: {"type":"message",...} → push（从压缩后重新开始）
```

无论压缩了多少次，这个算法总是正确的：多次 compact-boundary 会多次清空，最终只保留最后一次压缩后的消息。

### loop.ts 中的集成顺序

```typescript
while (turn < maxTurns) {
  turn++
  
  // 1. 先 flush（确保最新消息在崩溃时不丢）
  flushPendingMessages(state, options.modelId, cwd)
  
  // 2. 再检查是否需要压缩（基于上一轮的 inputTokens）
  if (state.lastInputTokens > 0) {
    await checkAndCompressContext(state, model, options.modelId, ...)
  }
  
  // 3. 然后 runTurn
  const outcome = await runTurn(...)
  
  // 4. 正常 stop 时写 usage 快照
  if (outcome.finishReason === 'stop') {
    appendUsage(state, cwd)
  }
}
```

**为什么首轮不触发压缩（`state.lastInputTokens > 0` 的判断）？**

首轮 `lastInputTokens` 为 0（createLoopState 的初始值），不代表真实的 context 大小。如果没有这个检查，第一轮请求也会尝试压缩（0 < threshold 一定不满足，但还是多了一次无意义的函数调用）。加上 `> 0` 的前置检查，语义更清晰。

## 与原项目的差异对比

| 方面 | 原 x-code-cli | 本次复现 |
|------|-------------|--------|
| 会话目录 | `~/.x-code/sessions/` + 项目目录 | `.mini-code/sessions/`（仅项目目录） |
| taskSlug 提取 | 用 LLM 从第一条消息中提取简短标题 | 直接截取前 200 字作为 firstPrompt（简化） |
| 压缩触发 | 同样的 80% 阈值 | 相同 |
| 摘要提示词 | 中英文混合 | 纯英文（模型对英语理解更稳定） |
| 全局会话列表 | 支持 `~/.x-code/sessions/` 全局搜索 | 预留了 `getGlobalSessionDir()`，未实现跨目录列表 |
| `--continue` / `--resume` | CLI 层处理 | session-store 提供了 `findSession` / `pickLatestSession`，待 CLI 层调用 |

## 踩过的坑

### 坑 1：`generateText` 没有 `maxTokens` 参数

AI SDK v5 的 `generateText` 使用 `maxOutputTokens`（不是 `maxTokens`），这与 v4 不同。TypeScript 类型检查会报错：

```
error TS2353: Object literal may only specify known properties,
and 'maxTokens' does not exist in type...
```

**解决**：改为 `maxOutputTokens: summaryMaxTokens`。

### 坑 2：`compact-boundary` 前要先 flush

初版代码是先修改 `state.messages`，再写 `compact-boundary`。如果写入 JSONL 失败（磁盘满），state 里已经是压缩后的短消息，但 JSONL 没有边界记录，下次恢复就会用压缩前的长历史（但 state 已经是压缩后的）——两者不一致。

**解决**：先 `appendCompactBoundary`，再修改 `state.messages`，确保 JSONL 永远比 state 更"旧"（state 的变更总是在 JSONL 有记录后才发生）。

### 坑 3：`afterEach` 不能在测试体外注册

Vitest 中 `afterEach(cleanup)` 必须在 `describe` 块内或测试文件顶层注册，不能在 `it` 体内调用（否则不会被执行）。

**解决**：改为在 `it` 体内直接 `try/finally` 调用 `cleanup()`，或者在 `describe` 块顶层注册。最终改为在函数内 makeTempDir 后，在测试末尾显式调用 `cleanup()`。

### 坑 4：`persistedMessageCount` 初始为 undefined 的坑

task6 版本的 `createLoopState` 没有 `persistedMessageCount` 字段，如果直接调用 `flushPendingMessages`，`state.messages.slice(undefined)` 会返回整个数组，功能上正确，但语义上不明确。

**解决**：在 `loop-state.ts` 中给 `createLoopState` 添加 `persistedMessageCount: 0` 初始值，明确初始状态。

## 学到的核心知识

1. **append-only 的崩溃安全性**：追加写（`fs.appendFileSync`）天然是原子的，即使进程中途崩溃，已追加的行也不会损坏。全量重写则需要 `rename` 原子操作才能安全。

2. **增量持久化的游标模式**：用一个整数游标（`persistedMessageCount`）追踪"已持久化到哪里"，避免重复写旧数据，又不需要遍历文件来检测重复。

3. **先写磁盘，再改内存**：任何涉及"磁盘 + 内存双写"的操作，都应该先写磁盘。这样即使内存操作失败或进程崩溃，磁盘状态是"更完整的"，可以从磁盘恢复到正确状态。反之，先改内存再写磁盘，崩溃后磁盘是旧状态但内存是新状态，恢复后磁盘和内存不一致。

4. **LLM 摘要 vs 截断**：截断（滑动窗口）实现简单但会丢失语义关键信息；LLM 摘要能保留"做了什么"的语义但需要一次额外的 LLM 调用（成本和延迟）。实际产品（Claude Code、Gemini CLI 等）都采用 LLM 摘要方案。
