# Task 15 — Sub-Agent（task 工具）

## 核心学习点

> 独立 LoopState、toolFilter 白名单、禁止递归、token 汇聚

---

## 1. 为什么需要 Sub-Agent？

在复杂的编程任务中，AI 往往需要同时处理多个相对独立的子任务——例如：
- 先用一个 agent 探索代码库结构，再用另一个 agent 执行修改
- 并行让多个 agent 分别审查不同的文件
- 隔离子任务的"思考过程"，避免污染父 agent 的上下文窗口

Sub-agent 系统（task 工具）就是为此设计的：**让父 AI 能把子任务委托给一个完全独立运行的 agentLoop**。

---

## 2. 整体架构

```
父 agentLoop（主 session）
  ├── state.messages = [...]           ← 父 agent 的完整对话历史
  └── 调用 task 工具
        ↓
    handleTaskTool（BYPASS_LOOP_GUARD）
        ↓
    runSubAgent(def, prompt, ...)
        ├── 创建独立 LoopState          ← 与父 agent 隔离
        ├── 过滤工具集（白名单）         ← 不含 task 工具（防递归）
        └── 调用 agentLoop(...)
              ↓（子 agent 独立运行）
    ← 返回 { output, tokenUsage }
        ↓
    汇聚 tokenUsage → parentState
    pushToolResult(output) → 父 state.messages
```

**关键设计决策**：
- **context 隔离**：子 agent 的 `LoopState.messages` 独立，父 agent 只看到子 agent 的最终输出（作为 tool_result），不看过程
- **token 汇聚**：子 agent 的 token 消耗累加到父 state，用户看到准确的总消耗
- **回调透传**：子 agent 的 `onTextDelta`、`onToolCall` 等事件同时转发给父 UI，界面仍然能显示子 agent 的执行进度

---

## 3. 关键代码解析

### 3.1 工具白名单过滤（runner.ts）

```typescript
function filterTools(parentTools, allowedTools) {
  const names = allowedTools.length > 0
    ? allowedTools          // 指定白名单
    : Object.keys(parentTools)  // 空数组 = 继承所有

  for (const name of names) {
    if (name === 'task') continue  // 强制排除：防止无限递归
    if (parentTools[name]) filtered[name] = parentTools[name]
  }
}
```

**为什么强制排除 `task` 工具？**
防止子 agent 再次创建子 agent，形成无限嵌套。这是安全边界，不由配置决定。

### 3.2 工具集注入机制（loop.ts）

task15 修改了 `buildTools` 为异步函数，并增加了 `toolsOverride` 参数：

```typescript
async function buildTools(options, cwd, toolsOverride?) {
  // sub-agent 场景：已过滤的工具集直接使用
  if (toolsOverride != null) return toolsOverride

  // 主 agent 场景：静态工具 + 动态 task 工具
  const registry = await createSubAgentRegistry(cwd)
  const taskTool = createTaskTool(registry)
  return { ...toolRegistry, task: taskTool }
}
```

`agentLoop` 新增 `toolsOverride` 参数：
- **主 agent** 调用时不传，buildTools 构建含 task 工具的完整工具集
- **sub-agent** 通过 runner.ts 传入过滤后的工具集，直接使用

### 3.3 绕过循环守卫（BYPASS_LOOP_GUARD_HANDLERS）

`task` 工具被放入 `BYPASS_LOOP_GUARD_HANDLERS`，原因如下：

1. task 工具的每次调用对应不同的子任务，hash 可能相同（如都是"探索目录"），但都是合法调用，不应被守卫拦截
2. task 工具本身不执行副作用，真正的危险操作（写文件、执行命令）在子 agentLoop 内部单独经过权限检查
3. 递归问题通过工具白名单（强制排除 `task`）来防止，不需要循环守卫

### 3.4 动态 import 避免循环依赖

`tool-execution.ts` 中的 `handleTaskTool` 使用动态 import：

```typescript
// 动态 import 避免循环依赖
const { runSubAgent } = await import('./sub-agents/runner.js')
const { createSubAgentRegistry } = await import('./sub-agents/registry.js')
```

**循环依赖链**：
```
runner.ts → agentLoop（loop.ts）→ processToolCalls（tool-execution.ts）→ runner.ts
```

用动态 import 打断这条链，避免模块加载失败。

### 3.5 task 工具的 Schema（task.ts）

```typescript
export function createTaskTool(registry: SubAgentRegistry) {
  const agents = registry.list()

  // 动态枚举：将注册表中所有 agent 名称作为 subagent 参数的枚举值
  const subagentSchema = z.enum(agents.map(a => a.name))

  return tool({
    inputSchema: z.object({
      subagent: subagentSchema,  // 枚举：只能选已注册的 agent
      prompt: z.string(),         // 子任务描述
    }),
    // 无 execute：在 BYPASS_LOOP_GUARD_HANDLERS 中处理
  })
}
```

动态枚举的好处：AI 能看到当前所有可用的 agent 名称及描述，做出准确的委托决策。

---

## 4. Sub-Agent 定义格式

### 内置 Agent（built-in.ts）

```typescript
export const EXPLORE_AGENT: SubAgentDef = {
  name: 'explore',
  description: 'A read-only agent for exploring codebases...',
  systemPrompt: `You are a code exploration specialist...`,
  allowedTools: ['readFile', 'glob', 'grep', 'listDir'],  // 只读工具
}
```

| agent 名称 | 工具权限 | 典型用途 |
|-----------|---------|---------|
| `explore` | 只读（readFile/glob/grep/listDir） | 理解代码库结构 |
| `general-purpose` | 所有工具（task 除外） | 完整开发任务 |
| `plan` | 只读 | 制定执行计划 |
| `code-reviewer` | 只读 | 代码审查报告 |

### 自定义 Agent（Markdown 文件格式）

用户可以在 `~/.x-code/agents/` 或 `.x-code/agents/` 放置 Markdown 文件来定义自定义 agent：

```markdown
---
name: my-agent
description: 这个 agent 的能力描述
allowedTools: readFile, glob, grep
---

这里是系统提示正文。
```

**加载优先级**（后覆盖前）：
1. 内置 agent
2. `~/.x-code/agents/*.md`（全局）
3. `.x-code/agents/*.md`（项目级）

---

## 5. 与原项目的差异对比

| 方面 | 本实现 | 原项目参考 |
|------|--------|------------|
| 工具注入机制 | `toolsOverride` 参数 + `buildTools` | 类似的工具过滤逻辑 |
| 循环依赖处理 | 动态 import | 类似方式 |
| model 获取 | 通过 `options.modelRegistry.languageModel()` | 直接传入 model 实例 |
| token 汇聚 | `addTokenUsage` 函数 | 类似实现 |
| 递归防护 | 工具白名单强制排除 `task` | 相同原则 |

---

## 6. 踩过的坑

### 6.1 循环依赖

最容易踩的坑：`runner.ts` 调用 `agentLoop`（来自 `loop.ts`），`loop.ts` 调用 `processToolCalls`（来自 `tool-execution.ts`），而 `handleTaskTool` 需要调用 `runSubAgent`（来自 `runner.ts`）。

这形成了一条循环依赖链。**解决方案**：在 `handleTaskTool` 中用动态 `import()` 代替顶层静态 import。

### 6.2 buildTools 变成异步

task15 之前 `buildTools` 是同步函数，返回 `Record<string, any>`。加入 sub-agent registry 后，加载自定义 agent 需要读文件（异步），所以改成了 `async` 函数。

相应地，`effectiveTools` 的初始化也从同步赋值改为 `await buildTools(...)`。

### 6.3 model 传递

`HandlerCtx` 里没有 `model` 字段，但 `handleTaskTool` 需要用 `model` 调用 `runSubAgent`。

解决方案：通过 `options.modelRegistry!.languageModel(options.modelId)` 重建 model 实例。这比在 `HandlerCtx` 里加 `model` 字段更干净（避免污染所有工具处理器的接口）。

### 6.4 并行 task 工具调用

`partitionToolCalls` 已经在 task6 时预留了对 task 工具并行分批的支持：

```typescript
// 连续的 task 工具调用合为一批，可以 Promise.all 并行执行
if (calls[i]!.toolName === 'task') {
  while (end < calls.length && calls[end]!.toolName === 'task') { end++ }
}
```

task15 只需要让 task 工具通过 BYPASS_LOOP_GUARD_HANDLERS 进入分发流程，并行批处理逻辑已经就绪。

---

## 7. 文件结构总览

```
packages/core/src/agent/sub-agents/
  types.ts     — SubAgentDef、SubAgentRegistry 接口定义
  built-in.ts  — 4 个内置 agent（explore/general-purpose/plan/code-reviewer）
  loader.ts    — 从 ~/.x-code/agents/ 和 .x-code/agents/ 加载自定义 agent
  registry.ts  — createSubAgentRegistry()：合并内置 + 自定义
  runner.ts    — runSubAgent()：独立 LoopState 运行子 agentLoop

packages/core/src/tools/
  task.ts      — createTaskTool(registry)：task 工具 schema

（修改的文件）
packages/core/src/agent/loop.ts          — buildTools 异步化 + toolsOverride 参数 + task 工具注入
packages/core/src/agent/tool-execution.ts — handleTaskTool + effectiveTools 参数透传
```
