# Task 09：use-agent Hook — React ↔ agentLoop 桥接

## 核心设计决策

### 1. 为什么需要 useAgent？

`agentLoop` 是一个异步函数，通过 callbacks 向外推送增量事件（文字 delta、工具调用状态等）。而 React 组件需要同步状态（`useState`）来驱动 UI 重渲染。

`useAgent` 作为**适配层**，承担三个职责：
1. **回调 → State**：将 `agentLoop` callbacks 翻译为 `setState` 调用
2. **中断管理**：把 `abort()` 翻译为 `abortController.abort()` + 解除挂起 Promise
3. **Permission 桥接**：把 `resolvePermission()` 翻译为 Promise.resolve()，实现异步等待

### 2. AgentState 结构设计

```typescript
interface AgentState {
  messages: DisplayMessage[]          // 已提交到 scrollback（append-only）
  streamingText: string               // 当前流式片段（未最终提交）
  activeToolCalls: Map<string, DisplayToolCall>  // 正在执行的工具
  isLoading: boolean                  // agentLoop 是否运行中
  pendingPermission: PendingPermission | null    // 等待权限确认
  pendingQuestion: PendingQuestion | null        // 等待用户回答
  tokenUsage: TokenUsage              // 累计 token 使用
  lastError: string | null            // 最后一条错误
}
```

**关键设计**：`streamingText` 与 `messages` 分离存储。
- `messages` 是 append-only 历史，每次 `setState` 只追加，不修改
- `streamingText` 是"进行中"的文字片段，每个 `onTextDelta` 都会更新
- 渲染时两者合并为 `displayMessages`，`streamingText` 作为最后一条 `streamingChunk: true` 消息

这个设计**避免了每个文字 delta 都 re-create 完整的 messages 数组**，减少不必要的对象创建。

### 3. abort 流程

中断时需要做三件事，顺序很重要：

```
用户按 Esc / Ctrl+C
    ↓
1. 解除挂起的 permission / question Promise（传默认拒绝值）
    ↓
2. flush streamingText → messages，追加 "[Request interrupted]"
    ↓
3. abortController.abort() → agentLoop 停止
```

为什么要先解除 Promise 再 abort？
- 如果 `agentLoop` 在 `onAskPermission` 的 Promise 里等待，`abort()` 并不会自动让 Promise resolve
- 必须手动 call `permissionResolveRef.current('no')` 才能让 `agentLoop` 从等待中退出
- 否则会出现内存泄漏：`agentLoop` 卡在一个永远不会 resolve 的 Promise 里

### 4. Permission 请求流程

使用 **Resolve Ref 模式** 把 React state 和 Promise 结合：

```
agentLoop 调用 onAskPermission
    ↓
创建 Promise，将 resolve 存入 permissionResolveRef.current
    ↓
setState → pendingPermission 非 null → UI 显示确认对话框
    ↓
用户点击 → resolvePermission('yes')
    ↓
queueMicrotask → permissionResolveRef.current('yes')
    ↓
agentLoop 从 await onAskPermission() 处继续执行
```

为什么用 `queueMicrotask`？
- `resolvePermission` 调用时先 `setState`（清除 `pendingPermission`），然后才 resolve Promise
- 如果直接同步 resolve，agentLoop 会立即继续，可能在 React 渲染之前再次触发 `onAskPermission`
- `queueMicrotask` 把 resolve 推迟到当前微任务队列末尾，让 `setState` 的 batching 先完成

### 5. Ref vs State 的边界

| 数据 | 存储方式 | 原因 |
|------|----------|------|
| `modelRef` | `useRef` | model 对象不需要触发重渲染，但 callbacks 需要访问最新值 |
| `loopStateRef` | `useRef` | LoopState 是 agentLoop 的内部状态，不直接驱动 UI |
| `abortControllerRef` | `useRef` | AbortController 的生命周期与 React 渲染无关 |
| `permissionResolveRef` | `useRef` | Promise resolve 函数不需要触发重渲染 |
| `messages / isLoading` | `useState` | 直接驱动 UI 渲染 |

### 6. submit 的空依赖数组

```typescript
const submit = useCallback((text: string) => {
  // ...
}, []) // 故意空依赖
```

`submit` 的所有"可变状态"（model、options、loopState）都通过 Ref 访问，而不是通过 closure 捕获。这意味着：
- `submit` 不会因 model/options 变化而 re-create（稳定引用，不触发 ChatInput 重渲染）
- 内部仍然能访问最新的 model/options（通过 ref.current）

## 关键代码解析

### App.tsx 中的 displayMessages 合并

```typescript
const displayMessages: readonly DisplayMessage[] = useMemo(() => {
  if (!state.streamingText) return state.messages
  const streamingMsg: DisplayMessage = {
    role: 'assistant',
    content: state.streamingText,
    streamingChunk: true,
  }
  return [...state.messages, streamingMsg]
}, [state.messages, state.streamingText])
```

`useMemo` 依赖 `state.messages` 和 `state.streamingText`。因为这两个字段在 `AgentState` 里是独立更新的：
- `onTextDelta` 只修改 `streamingText`，不修改 `messages`
- 工具完成时只修改 `messages`，不修改 `streamingText`

所以 `useMemo` 能有效避免不必要的重计算。

### agentLoop 完成后的状态更新

```typescript
agentLoop(...).then(({ state: newLoopState }) => {
  loopStateRef.current = newLoopState  // 保存 LoopState 用于下次提交（多轮对话）
  setState((prev) => {
    const finalMessages = [...prev.messages]
    // 提交剩余 streamingText
    if (prev.streamingText) {
      finalMessages.push({ role: 'assistant', content: prev.streamingText })
    }
    // ...
  })
})
```

**多轮对话**通过保存 `loopStateRef.current = newLoopState` 实现：下次调用 `agentLoop` 时传入 `existingState`，保留完整消息历史。

## 与原项目的差异对比

原项目（x-code-cli）的 `use-agent.ts` 采用了更复杂的设计：
- 使用 `useReducer` 而不是 `useState`，状态转换更清晰可预测
- 有独立的 `AgentAction` discriminated union，每种 callback 对应一个 action
- `streamBuffer` 是独立的 hook（`use-stream-buffer.ts`），有 50ms 的 flush 节流避免过于频繁的重渲染
- 权限对话框是完整的 React 组件，而非简化处理

mini-code-cli Task 9 选择 `useState` 是为了降低复杂度，Task 10+ 可以按需迁移到 `useReducer`。

## 踩过的坑

### 坑1：agentLoop 的 callbacks 不能捕获 React state

```typescript
// ❌ 错误：callbacks 捕获了 state 的快照值
const submit = useCallback((text: string) => {
  const onToolResult = (id: string, result: string) => {
    // 这里的 state 是 submit 被创建时的快照，不是最新值！
    setState({ ...state, ... })
  }
}, [state])

// ✅ 正确：使用 setState 的函数式更新，接收最新 prev
const submit = useCallback((text: string) => {
  const onToolResult = (id: string, result: string) => {
    setState((prev) => ({ ...prev, ... }))  // prev 永远是最新值
  }
}, []) // 空依赖
```

所有 callbacks 内部都使用 `setState(prev => ...)` 函数式更新，避免 stale closure 问题。

### 坑2：Map 在 setState 里需要 new Map()

```typescript
// ❌ 错误：直接修改原 Map，React 无法检测变化
setState((prev) => {
  prev.activeToolCalls.set(id, tc)  // 突变！
  return { ...prev }
})

// ✅ 正确：创建新 Map
setState((prev) => {
  const next = new Map(prev.activeToolCalls)
  next.set(id, tc)
  return { ...prev, activeToolCalls: next }
})
```

`Map` 不是值类型，React 的浅比较不会检测到内部修改。每次更新都要 `new Map(prev)` 创建新实例。

### 坑3：多轮对话需要保存 LoopState

首次调用 `agentLoop` 时没有 `existingState`，会创建新的空 `LoopState`。但第二次调用必须传入上次的 `LoopState`，否则 AI 不知道之前的对话历史。

通过 `loopStateRef.current = newLoopState`（在 `.then()` 里保存）+ 下次 `agentLoop(... loopStateRef.current)` 实现跨轮次的状态延续。
