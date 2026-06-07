# Task 10：流式文字渲染 — delta 缓冲、工具行格式化与 spinner 状态切换

## 核心设计决策

### 1. 为什么需要 useStreamBuffer？

**问题：** `agentLoop` 通过 `onTextDelta` 推送增量文字，每次可能只有几个字符。如果每个 delta 都直接调用 `setState`，React 会以极高频率（每秒几十次）触发重渲染，导致：
- CPU 占用飙高（React reconciler 频繁运行）
- 终端输出抖动（过于频繁的 `process.stdout.write`）
- 动态帧区域闪烁（cell-diff 渲染器被反复调用）

**解决方案：** `useStreamBuffer` 实现「缓冲 + 定时 flush」：

```
onTextDelta(delta)
    ↓
bufferRef.current += delta      ← 纯 string 拼接，无 React 开销
    ↓ (每 50ms)
setStreamingText(prev + buf)    ← 合并为一次 setState，触发单次渲染
```

50ms 间隔 ≈ 20fps，人眼感知流畅（< 100ms），同时把 setState 调用降低到可控范围。

### 2. streamingText 的双重作用

`useStreamBuffer` 的 `streamingText` 状态在两处发挥作用：

1. **实时预览（App.tsx）：** `streamingText` 作为最后一条 `streamingChunk: true` 消息合并进 `displayMessages`，让用户看到 AI 正在打字的效果

2. **防止丢失（useAgent.ts）：** agentLoop 完成时调用 `commitStreamingText()`，将缓冲中所有未 flush 的文字提交为正式消息，防止最后几个字被丢弃

### 3. commitStreamingText 的 queueMicrotask 设计

`commitStreamingText` 内部使用 `queueMicrotask` 延迟调用 `onCommit`：

```typescript
setStreamingText((prev) => {
  const finalText = prev + buf
  queueMicrotask(() => {
    if (finalText) onCommitRef.current(finalText)
  })
  return '' // 先清空 streamingText
})
```

**原因：** `setStreamingText('')`（清空预览）和 `onCommit`（追加到 messages）必须在同一 React flush 批次内，否则会出现：
- 清空预览 → 渲染 → 消息尚未追加 → UI 空白闪烁

用 `queueMicrotask` 确保 `setStreamingText('')` 先入 React 更新队列，`onCommit` 在其 microtask 后紧跟执行。

### 4. 工具 duration 记录策略

工具耗时通过 `toolStartTimeRef` 记录，在 `onToolCall` 时打点、`onToolResult` 时读取：

```typescript
// onToolCall：记录开始时间
toolStartTimeRef.current.set(toolCallId, Date.now())

// onToolResult：计算耗时
const startTime = toolStartTimeRef.current.get(toolCallId)
const durationMs = startTime !== undefined ? Date.now() - startTime : undefined
toolStartTimeRef.current.delete(toolCallId)
```

为什么用 `ref` 而不是 `state`：duration 是瞬态数据，不需要触发重渲染；`ref` 在跨 render 闭包中也能读到最新值。

### 5. stdout-writer.ts 的工具行格式设计

工具行格式（Task 10 完整版）：
```
 ● readFile src/index.ts  [12ms]
    ⎿  export function App...
```

设计要点：
- **状态图标**：○（等待/拒绝）vs ●（运行/完成/错误），颜色区分状态
- **工具名粗体**：视觉层级，让工具名一眼可见
- **输入摘要**：专用格式化（readFile 显示文件名，shell 显示命令前两词），避免路径过长
- **duration 只在完成/错误时显示**：运行中不显示计时，避免频繁更新
- **输出摘要行（`⎿`）**：单行、最长 120 字符，让用户知道工具返回了什么

### 6. spinnerLabel 状态机

App.tsx 实现了 5 级优先级的 spinner 标签：

```
pendingPermission（有权限请求）
    ↓ trustMode = "Executing <toolName>…" / 非 trustMode = "Allow <toolName>? (y/n)"
pendingQuestion（有问题请求）
    ↓ "Waiting for input…"
isLoading + activeToolName（工具运行中）
    ↓ buildToolSpinnerLabel(toolName, input)
isLoading（AI 思考中，无工具）
    ↓ "Thinking…"
空闲
    ↓ null（不显示 spinner）
```

`buildToolSpinnerLabel` 对常见工具定制了人性化描述：

| 工具 | 输入 | spinner 标签 |
|------|------|------------|
| readFile | `{ path: "src/foo.ts" }` | `Reading foo.ts…` |
| writeFile | `{ path: "src/bar.ts" }` | `Writing bar.ts…` |
| shell | `{ command: "npm install" }` | `Running npm install…` |
| grep | `{ pattern: "useState" }` | `Grepping useState…` |

## 关键代码解析

### useStreamBuffer（`hooks/use-stream-buffer.ts`）

```typescript
export function useStreamBuffer(onCommit: (text: string) => void) {
  const bufferRef = useRef<string>('')       // 累积 delta（无 React 开销）
  const [streamingText, setStreamingText]   // 50ms flush 后的可见文字
    = useState<string>('')
  const streamingTextRef = useRef<string>('') // 同步镜像（供 hasStreamingText 读取）

  // 定时 flush
  useEffect(() => {
    const timer = setInterval(() => {
      const buf = bufferRef.current
      if (!buf) return
      bufferRef.current = ''
      setStreamingText((prev) => {
        const next = prev + buf
        streamingTextRef.current = next
        return next
      })
    }, 50)
    return () => clearInterval(timer)
  }, [])
  
  // ...
}
```

### activeToolName 驱动 spinner（`hooks/use-agent.ts`）

```typescript
// onToolCall：设置 activeToolName
setState((prev) => ({
  ...prev,
  activeToolCalls: next,
  activeToolName: toolName,    // ← 新增
  activeToolInput: input,       // ← 新增
}))

// onToolResult：更新 activeToolName 为下一个 running 工具
let nextActiveTool: string | null = null
for (const tc of next.values()) {
  if (tc.status === 'running') {
    nextActiveTool = tc.toolName
    break
  }
}
setState((prev) => ({
  ...prev,
  activeToolName: nextActiveTool,
  activeToolInput: nextActiveTool ? /* ... */ : null,
}))
```

### 工具调用前 flush（`hooks/use-agent.ts`）

```typescript
const onToolCall = (toolCallId, toolName, input) => {
  // ⚠️ 关键：工具调用开始前，立即 flush 缓冲中的 streaming text
  flushBuffer()  // 确保文字内容先于工具行写入 scrollback
  setState(...)
}
```

**原因：** 如果不立即 flush，可能出现：
- AI 输出 "I'll read the file..." → delta 在 buffer 中等待 flush
- 工具行已写入 scrollback（"● readFile src/foo.ts"）
- 50ms 后 flush 触发 → 文字出现在工具行**之后** → 顺序颠倒

## 与原项目的差异对比

| 特性 | 原 x-code-cli | mini-code-cli Task 10 |
|------|--------------|----------------------|
| delta 缓冲 | 200ms setInterval（内部实现）| 50ms setInterval（`useStreamBuffer`） |
| streamingText 管理 | 直接 `setState` | 独立 Hook，与 AgentState 解耦 |
| 工具 duration | `durationMs` 字段，`Date.now()` 打点 | 相同策略（`toolStartTimeRef`） |
| spinner 标签 | 固定 "Working…" + 工具名 | 动词化标签（"Reading/Writing/Running…"） |
| 工具行格式 | `● toolName: arg  [Xms]` | 相同，加输出摘要行 |

## 踩过的坑

### 坑 1：streamingText 从 AgentState 剥离

**问题：** 最初把 `streamingText` 直接放进 `AgentState` 的 `useState`，导致两个 useState 并行更新：
1. `useStreamBuffer` 内部的 `setStreamingText`（每 50ms）
2. `AgentState` 的 `setState`（每次工具调用等）

React 18 的自动批处理虽然能减少渲染次数，但两个 state 分属不同的 `useState` 调用，仍然会引发额外的协调开销。

**解决：** `streamingText` 完全由 `useStreamBuffer` 管理，`AgentState` 不存储它。在 `useAgent` 返回时合并：
```typescript
const stateWithStreaming: AgentState = {
  ...state,
  streamingText, // 来自 useStreamBuffer 的独立 state
}
```

### 坑 2：commitStreamingText 的时序问题

**问题：** agentLoop 完成时，`commitStreamingText()` 和后续的 `setState`（清空 `isLoading`）是独立的 state 更新。如果 `onCommit` 同步执行，会导致消息追加和状态重置在同一 tick，React 可能批处理为单次渲染，丢失中间状态。

**解决：** 用 `queueMicrotask` 延迟 `onCommit`，确保 `setStreamingText('')` 先渲染，再追加消息。

### 坑 3：abort 时的双重清理

**问题：** `abort()` 需要同时清理：
1. `useStreamBuffer` 的缓冲区（bufferRef + streamingText state）
2. `AgentState` 中的 `streamingText`（旧版遗留字段）

**解决：** abort 中先调用 `commitStreamingText()` 提交缓冲内容，再在 `setState` 回调中检查 `prev.streamingText` 作为兜底（应对 commitStreamingText 的 microtask 延迟）。
