# X-Code CLI 设计文档

## 概述

X-Code CLI 是一个两包 monorepo 终端 AI 编程助手。`core` 包实现无 UI 的 agent 引擎；`cli` 包实现 Ink/React 终端界面。单向依赖：`cli → core`，`core` 零 UI 依赖，可独立测试。

**数据流总览：**
```
stdin 按键
  → use-prompt-input（raw mode 键序列解析）
  → ChatInput（cell-buffer 渲染）
  → use-agent.submit()
  → agentLoop（core）
    → streamText（AI SDK）
    → processToolCalls
  → callbacks（onTextDelta / onToolCall / onToolResult）
  → React state → ChatInput 重绘
```

---

## 架构

### 包结构

```
packages/
  core/               @x-code-cli/core — Agent 引擎（纯 TS，无 UI）
    src/
      agent/          agentLoop、工具执行、压缩、会话持久化
      providers/      多厂商注册、缓存控制、Thinking 开关
      tools/          所有工具定义（file / shell / web / task）
      permissions/    3 级权限模型
      knowledge/      5 层 AGENTS.md 合并
      mcp/            MCP 协议加载、OAuth
      hooks/          插件生命周期事件总线
  cli/                @x-code-cli/cli — 终端 UI
    src/
      ui/
        components/   App.tsx、ChatInput.tsx
        hooks/        use-agent、use-prompt-input、use-stream-buffer
      index.ts        CLI 入口（yargs + 启动流程）
      app.tsx         Ink render 入口
```

### 构建策略

- `core`：纯 `tsc -b`，输出 `dist/`（类型 + JS），`cli` 通过 `workspace:*` 引用
- `cli`：esbuild 打包成单文件 `dist/cli.js`，tree-shake 所有依赖

---

## 核心组件与接口

### 1. AgentLoop（`core/src/agent/loop.ts`）

```typescript
// 主入口：处理一条用户消息，循环直到 stop/abort/error
async function agentLoop(
  userMessage: UserContent,      // 用户消息（字符串或多模态数组）
  model: LanguageModel,          // AI SDK 模型实例
  options: AgentOptions,         // 模型 ID、权限模式、AbortSignal 等
  callbacks: AgentCallbacks,     // UI 事件回调
  existingState?: LoopState,     // 可选：会话续传状态
): Promise<AgentLoopResult>

interface AgentLoopResult {
  state: LoopState     // 更新后的会话状态（跨轮复用）
  turnCount: number    // 本次调用的轮次数（不累积）
}
```

**内部循环：**
```
while (maxTurns 未达到):
  1. flushPendingMessages（增量写 JSONL）
  2. checkAndCompressContext（上下文压缩）
  3. buildSystemPrompt（首轮构建并缓存）
  4. runTurn → streamText → 流式输出
  5. 按 finishReason 分支：
     - 'tool-calls' → processToolCalls → continue
     - 'length'     → 推入续写提示 → continue（最多3次）
     - 'stop'       → completedNormally = true → break
     - 'error'/'aborted' → break
```

### 2. LoopState（`core/src/agent/loop-state.ts`）

```typescript
interface LoopState {
  sessionId: string               // 唯一会话 ID（时间戳格式）
  taskSlug: string                // 任务简短标题（用于文件名）
  messages: ModelMessage[]        // 完整对话历史（AI SDK 格式）
  tokenUsage: TokenUsage          // 累积 token 用量
  lastInputTokens: number         // 上一轮 inputTokens（进度显示用）
  systemPromptCache: string|null  // 跨轮字节稳定的系统提示缓存
  permissionMode: PermissionMode  // 'default' | 'plan' | 'acceptEdits'
  recentToolCalls: ToolCallRecord[]  // Loop Guard 滑动窗口
  filesModified: Set<string>      // 本会话修改的文件集合
  persistedMessageCount: number   // 已写入 JSONL 的消息数
  knowledgeContext: string        // buildKnowledgeContext 缓存
  isGitRepo: boolean
  currentPlanPath: string|null    // Plan 模式的计划文件路径
}
```

### 3. AgentCallbacks（`core/src/types/index.ts`）

```typescript
interface AgentCallbacks {
  onTextDelta(delta: string): void
  onToolCall(id: string, name: string, input: Record<string,unknown>): void
  onToolProgress(id: string, message: string): void
  onToolResult(id: string, result: string, isError?: boolean): void
  onFileEdit(id: string, payload: EditDiffPayload): void
  onAskPermission(tc: PendingToolCall): Promise<'yes'|'always'|'no'>
  onAskUser(q: string, opts: Option[]): Promise<string>
  onPlanApprovalRequest(planText: string): Promise<boolean>
  onPlanModeChange(mode: PermissionMode): void
  onTodosUpdate(todos: TodoItem[]): void
  onSubAgentEvent(event: SubAgentEvent): void
  onShellOutput(chunk: string): void
  onUsageUpdate(usage: TokenUsage): void
  onContextCompressed(): void
  onError(err: Error): void
  onMemoryWrite(entry: MemoryEntry): void
}
```

### 4. ProviderRegistry（`core/src/providers/registry.ts`）

```typescript
// 8 家厂商 + 自定义 endpoint 注册
function createModelRegistry(): ProviderRegistry

// 关键设计：permanentErrorFetch
// 在 HTTP 响应体层面识别"永久失败"错误（余额不足、内容违规等）
// 将这些错误的 HTTP status 重写为非重试码（402/413/422/401/404）
// 防止 AI SDK 把它们当可重试的 5xx/429 浪费 30 秒重试
const permanentErrorFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  if (response.status < 400) return response   // 不碰成功响应
  const text = await response.clone().text()
  // 关键词匹配 → 重写 status
  for (const category of PERMANENT_ERROR_CATEGORIES) {
    if (matches(text, category)) return new Response(text, { status: category.status, ... })
  }
  return response
}
```

### 5. 工具注册表（`core/src/tools/index.ts`）

```typescript
// auto-execute 工具（AI SDK 自动执行，无需手动分发）
export const toolRegistry = {
  readFile:    tool({ execute: async (input) => ... }),
  glob:        tool({ execute: async (input) => ... }),
  grep:        tool({ execute: async (input) => ... }),
  listDir:     tool({ execute: async (input) => ... }),
  webFetch:    tool({ execute: async (input) => ... }),
  webSearch:   tool({ execute: async (input) => ... }),
  // ...
}

// 手动分发工具（只有 schema，无 execute，需要权限检查）
export const shell = tool({ inputSchema: z.object({ command: z.string() }) })
export const writeFile = tool({ inputSchema: ... })
export const edit = tool({ inputSchema: ... })
```

### 6. 权限系统（`core/src/permissions/index.ts`）

```typescript
// 3 级权限决策
async function checkPermission(
  toolCall: { toolCallId, toolName, input },
  trustMode: boolean,              // --trust 标志
  onAskPermission: PermissionCallback,
  permissionMode: PermissionMode,  // plan 模式自动拒绝写操作
  cwd: string,
): Promise<boolean>

// 决策优先级：
// 1. trustMode === true → 直接通过
// 2. permissionMode === 'acceptEdits' → 直接通过
// 3. permissionMode === 'plan' → 直接拒绝
// 4. always-allow 持久化列表命中 → 直接通过
// 5. onAskPermission 弹对话框 → 等用户决策
```

### 7. ChatInput（`cli/src/ui/components/ChatInput.tsx`）

**核心设计：绕过 Ink 的 Yoga 布局，直接写 `process.stdout`**

```typescript
// 渲染流程（每帧）：
// 1. buildCellGrid(state) → CellGrid（2D 字符数组）
// 2. diffCellGrid(prev, next) → 差异列表
// 3. write(BSU + ANSI diff patches + ESU) → 一次 stdout.write

// CellGrid 包含：
// - 滚动消息区（已提交的历史消息，append-only）
// - 动态区（正在流式输出的助手回复 + 工具行 + 权限 dialog + input box）

// 关键约束：Ink 的动态区永远为空，App.tsx 只渲染 <ChatInput />
// 原因：Ink 用 log-update 写同一 DECSC 寄存器，多写方会互相覆盖光标
```

### 8. use-agent Hook（`cli/src/ui/hooks/use-agent.ts`）

**React ↔ agentLoop 桥接层**

```typescript
function useAgent(model, options, initialSession?): {
  state: AgentState,      // 完整 UI 状态（消息、loading、工具调用、权限队列等）
  submit(text, opts?),    // 用户提交消息 → 调用 agentLoop
  abort(),               // 中止当前 turn（AbortController.abort()）
  resolvePermission(decision),  // 解决挂起的权限请求
  resolveQuestion(answer),      // 解决挂起的 askUser 请求
  // ...更多操作
}

// 关键模式：Promise-based 异步对话
// onAskPermission 返回 new Promise(resolve => permissionResolversRef.push(resolve))
// 用户点击 Yes/No → resolvePermission(decision) → resolve(decision) → agentLoop 继续
```

---

## 数据模型

### 消息格式（AI SDK `ModelMessage`）

```typescript
// 用户消息
{ role: 'user', content: UserContent }
// UserContent = string | Array<TextPart | ImagePart | FilePart>

// 助手消息（含工具调用）
{ role: 'assistant', content: Array<TextPart | ToolCallPart | ReasoningPart> }

// 工具结果
{ role: 'tool', content: Array<ToolResultPart> }
```

### 会话文件格式（JSONL）

```jsonl
{"type":"header","sessionId":"20260529-120000-000","taskSlug":"fix-login","modelId":"anthropic:claude-3-7-sonnet","firstPrompt":"...","createdAt":1748520000000}
{"type":"message","role":"user","content":"帮我修复登录 bug"}
{"type":"message","role":"assistant","content":[{"type":"tool-call","toolCallId":"tc1","toolName":"readFile","input":{...}}]}
{"type":"usage","inputTokens":1234,"outputTokens":567,"totalTokens":1801}
{"type":"compact-boundary","summary":"会话摘要"}
```

### 权限持久化（JSON）

```json
{
  "alwaysAllow": {
    "shell": true,
    "writeFile": true
  }
}
```

---

## 正确性属性

*属性是在所有有效输入上都应成立的系统行为规则——将可读规格转化为可机器验证的正确性保证。*

### 属性 1：工具调用配对不变量（Round-Trip）

*对任意包含孤立 `tool_call`（无对应 `tool_result`）的 messages 数组，运行 `repairOrphanToolCalls` 后，每个 `tool_call` 都应有对应的 `tool_result`。*

**Validates: 需求 2.8**

```typescript
// 伪代码
property('tool_call/result 配对', fc.array(messageArbitrary), (messages) => {
  const repaired = repairOrphanToolCalls(messages)
  const callIds = collectToolCallIds(repaired)
  const resultIds = collectToolResultIds(repaired)
  expect(callIds).toEqual(resultIds)  // 完全配对
})
```

### 属性 2：系统提示幂等性（Idempotence）

*对任意相同参数，`buildSystemPrompt` 的两次连续调用结果必须字节完全相同。*

**Validates: 需求 7.2**

```typescript
property('系统提示幂等性', fc.record({ modelId: fc.string(), isGitRepo: fc.boolean(), planMode: fc.boolean() }), (opts) => {
  const p1 = buildSystemPrompt(opts)
  const p2 = buildSystemPrompt(opts)
  expect(p1).toBe(p2)  // 字节相等
})
```

### 属性 3：权限 3 级决策完备性（Error Conditions）

*对任意工具调用，3 级权限检查必须返回 true 或 false，不能挂起（无 Promise 永不 resolve）。在 trustMode = true 时永远返回 true；在 permissionMode = 'plan' 且为写工具时永远返回 false。*

**Validates: 需求 4.1, 4.4, 4.5**

```typescript
property('trust 模式直通', fc.record({ toolName: writeToolNameArb, input: fc.object() }), async (tc) => {
  const result = await checkPermission(tc, /* trustMode */ true, neverAskCallback, 'default', cwd)
  expect(result).toBe(true)
})

property('plan 模式拒绝写操作', fc.record({ toolName: writeToolNameArb, input: fc.object() }), async (tc) => {
  const result = await checkPermission(tc, false, neverAskCallback, 'plan', cwd)
  expect(result).toBe(false)
})
```

### 属性 4：JSONL 会话写入可恢复性（Round-Trip）

*对任意一批消息，写入会话文件后读取出来，得到的消息列表与写入前完全相同（顺序、内容均等）。*

**Validates: 需求 6.1**

```typescript
property('会话 JSONL 写读 round-trip', fc.array(messageArbitrary, { minLength: 1 }), async (messages) => {
  const state = createLoopState('default')
  state.messages = messages
  await flushPendingMessages(state)
  const loaded = await loadSession(state.sessionFilePath)
  expect(loaded?.messages).toEqual(messages)
})
```

### 属性 5：Tool 结果截断不改变含义（Metamorphic）

*对任意工具结果字符串，截断后的结果长度不超过预算（MAX_TOOL_RESULT_SIZE），且截断前后的前 N 个字符完全相同。*

**Validates: 需求 2（上下文不超限）**

```typescript
property('工具结果截断保留前缀', fc.string({ minLength: 0 }), (raw) => {
  const truncated = truncateToolResult(raw)
  expect(truncated.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_SIZE)
  if (raw.length <= MAX_TOOL_RESULT_SIZE) {
    expect(truncated).toBe(raw)  // 不截断时原样返回
  } else {
    expect(raw.startsWith(truncated.slice(0, 100))).toBe(true)  // 截断保留前缀
  }
})
```

---

## 错误处理

### API 错误分类（`classifyApiError`）

| 错误类型 | HTTP 状态 | 用户提示 |
|---------|----------|---------|
| 余额不足 | 402 | "账户余额不足，请充值" |
| 上下文超限 | 413 | "上下文过长，请使用 /compact 压缩" |
| 内容违规 | 422 | "内容被安全过滤器拦截" |
| 认证失败 | 401 | "API Key 无效，请检查" |
| 模型不存在 | 404 | "模型 ID 不存在或无权访问" |
| 速率限制 | 429 | "请求太频繁，正在重试..." |
| 网络错误 | - | "网络连接失败" |

### 孤立 ToolCall 修复

每次 `runTurn` 前调用 `repairOrphanToolCalls(state.messages)`：
- 扫描最近的 assistant 消息中的 `tool-call` parts
- 对每个没有对应 `tool-result` 的 toolCallId 注入合成结果
- 防止下次 API 请求因消息格式错误被拒绝（`tool_use without tool_result`）

### AbortSignal 传播链

```
用户 Esc
  → use-agent.abort()
    → abortController.abort()
      → agentLoop options.abortSignal
        → streamText({ abortSignal })    // 取消 HTTP 请求
        → executeShell(signal)           // execa cancelSignal → SIGKILL
        → readFile(signal)               // fs.readFile({ signal })
        → MCP callTool(signal)           // MCP SDK abort
```

---

## 测试策略

### 双轨测试方法

- **单元测试**（vitest）：验证具体行为、边界条件、错误路径
- **属性测试**（fast-check）：验证普遍性质，随机生成 100+ 输入

### 单元测试重点

```
packages/core/tests/
  agent-loop.test.ts       — 循环分支（stop/tool-calls/length/abort）
  tool-execution.test.ts   — 权限门、孤立修复、loop guard
  permissions.test.ts      — 3级决策矩阵
  session-store.test.ts    — JSONL 写读 round-trip
  cache-control.test.ts    — Anthropic cache_control 注入
  shell-utils.test.ts      — 命令分类、引号感知分词
```

### 属性测试配置

```typescript
// vitest + fast-check
import fc from 'fast-check'

test.prop([fc.array(messageArbitrary)], { numRuns: 100 })(
  'tool_call 配对不变量',
  (messages) => { ... }
)
```

**Property 标注格式**（每个属性测试必须注释）：
```typescript
// Feature: x-code-cli, Property 1: tool_call/result 配对不变量
```

### 关键测试边界

1. **0 条消息**的 agentLoop 调用（不能崩溃）
2. **maxTurns = 1** 时达到上限的处理
3. **同时多个工具调用**（并行 task 工具）
4. **DeepSeek V4** `reasoning_content` 回传
5. **Anthropic 4 个** cache_control 断点上限

---

## 词汇表

- **AgentLoop**：`core` 的核心循环，处理单条用户消息，返回更新后的 LoopState
- **LoopState**：一个 session 内跨轮次共享的状态对象
- **UserContent**：AI SDK 的用户消息类型（string 或多模态 Part 数组）
- **ModelMessage**：AI SDK 的统一消息格式（user / assistant / tool 三种角色）
- **permanentErrorFetch**：在 HTTP 层拦截并重写"永久失败"错误码的 fetch 包装器
- **Cell Buffer**：`ChatInput` 用于渲染的 2D 字符网格，通过 diff 算法最小化 stdout 写入
- **systemPromptCache**：`LoopState` 上缓存的字节稳定系统提示，跨轮复用以命中 prefix cache
- **Loop Guard**：防止模型重复调用相同工具陷入死循环的滑动窗口检测机制
- **processToolCalls**：`tool-execution.ts` 中的工具分发函数，处理权限、loop guard、并行 task
- **repairOrphanToolCalls**：每次 turn 前扫描并修复无对应 result 的 tool_call 的修复函数

