# Task A：知识系统与系统提示

## 核心设计决策

### 1. 5 层知识合并架构

知识系统的核心是将来自不同来源的上下文按优先级合并，形成注入系统提示的知识背景。

**合并顺序（优先级从低到高）：**

```
层 1：~/.mini-code/AGENTS.md          (用户通用规则)
层 2：~/.mini-code/auto-memory.md     (用户级自动记忆)
层 3：项目 AGENTS.md 链               (从 cwd 向上，root→leaf，叶覆盖根)
层 4：<cwd>/.mini-code/auto-memory.md (项目级自动记忆)
层 5：<cwd>/AGENTS.local.md           (个人偏好，gitignore)
```

**关键设计原则：**
- **叶节点覆盖根节点**：越具体的目录，优先级越高（`collectProjectAgentsMdPaths` 返回从根到叶的路径，拼接时后者覆盖前者）
- **静默降级**：任何文件不存在都不报错，只是该层贡献空字符串
- **不注入时间戳**：`buildKnowledgeContext()` 内不使用 `Date.now()` 等动态内容，保证字节稳定

### 2. 字节稳定的系统提示（Prefix Cache 关键）

系统提示的字节稳定性对 OpenAI-compatible 厂商的 prefix cache 命中至关重要。

```
state.systemPromptCache
  ↑ 首轮构建 (buildSystemPrompt)
  ↑ permissionMode 变化时由 tool-execution.ts 置 null
  ↑ 下轮重建（knowledgeContext 在 session 内不变，所以结果相同）
```

**`buildSystemPrompt(knowledgeContext, isPlanMode)` 的组合规则：**
1. `BASE_SYSTEM_PROMPT`（硬编码，永不变）
2. `"## Project Knowledge\n\n{knowledgeContext}"`（session 内固定）
3. `PLAN_MODE_OVERLAY`（仅 plan 模式追加）

### 3. Fire-and-Forget 记忆提取

```typescript
// loop.ts 中 finishReason === 'stop' 后
void runMemoryExtractor(state.messages, messageCountBeforeLoop, model, cwd)
```

**为什么不 await？**
- 记忆提取需要一次 LLM 调用，耗时 1-3 秒
- 用户已经看到了 AI 的回答，不应等待后台任务
- 失败完全静默，不影响主流程
- 这是"后台维护"，与当前对话任务解耦

### 4. knowledgeContext 的 Session 内缓存

```
agentLoop 首次调用（existingState 为 null）
  → buildKnowledgeContext(cwd) → state.knowledgeContext
  → detectIsGitRepo(cwd) → state.isGitRepo

agentLoop 后续调用（existingState 传入）
  → 跳过构建，直接复用 existingState.knowledgeContext
```

**为什么不每轮重读文件？**
- AGENTS.md 在 session 内不会变（用户不会在对话过程中修改知识文件）
- 避免不必要的文件 IO
- 保证跨轮的字节稳定，维持 prefix cache 命中

## 关键代码解析

### `buildKnowledgeContext()` —— `knowledge/loader.ts`

```typescript
function collectProjectAgentsMdPaths(cwd: string): string[] {
  const homedir = os.homedir()
  const paths: string[] = []
  let dir = path.resolve(cwd)

  while (true) {
    const candidate = path.join(dir, AGENTS_MD)
    if (fs.existsSync(candidate)) {
      paths.unshift(candidate)  // ← 插到前面！根在前，叶在后
    }
    const parent = path.dirname(dir)
    if (dir === homedir || parent === dir) break
    dir = parent
  }
  return paths
}
```

**关键点**：`paths.unshift(candidate)` 将更浅（根）的路径插到前面，`paths.map(safeReadFile)` 后展开，叶节点内容自然在后面（优先级更高）。

### `buildSystemPrompt()` —— `agent/system-prompt.ts`

```typescript
export function buildSystemPrompt(knowledgeContext: string, isPlanMode: boolean): string {
  const parts: string[] = [BASE_SYSTEM_PROMPT]

  if (knowledgeContext.trim().length > 0) {
    parts.push(`## Project Knowledge\n\n${knowledgeContext.trim()}`)
  }

  if (isPlanMode) {
    parts.push(PLAN_MODE_OVERLAY)
  }

  return parts.join('\n\n')
}
```

**字节稳定保证**：
- `BASE_SYSTEM_PROMPT` 是硬编码常量
- `knowledgeContext` 在 session 内固定（首轮缓存到 state）
- `isPlanMode` 由 `state.permissionMode === 'plan'` 决定（变化时清缓存重建）

### `runMemoryExtractor()` —— `agent/memory-extractor.ts`

**提取策略：**
1. 只取 `messages.slice(existingMessageCount)` 的新消息（避免重复提取旧内容）
2. 将消息序列化为纯文本（只提取 `TextPart`，忽略工具调用）
3. 调用 LLM，要求以 Markdown 列表格式输出事实
4. 解析输出，追加到 `auto-memory.md`

**过滤机制：**
- 对话内容 < 100 字符时跳过（太短没有提取价值）
- LLM 返回 `NONE` 时不写文件
- 任何错误均 `catch` 静默忽略

### `detectIsGitRepo()` —— `agent/loop.ts`

```typescript
function detectIsGitRepo(cwd: string): boolean {
  try {
    const result = childProcess.spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
    })
    return result.status === 0 && result.stdout.trim() === 'true'
  } catch {
    return false
  }
}
```

**为什么用 `spawnSync` 而不是 `execSync`？**
- `spawnSync` 不走 shell，更快，避免 shell injection
- `timeout: 2000` 防止在挂载的网络文件系统上 git 命令挂起
- 任何失败都返回 `false`（静默降级，不影响主功能）

## 与原项目的差异对比

| 方面 | 原项目 (Claude Code) | 本实现 |
|------|---------------------|--------|
| 知识文件名 | `CLAUDE.md` | `AGENTS.md` |
| 用户配置目录 | `~/.claude/` | `~/.mini-code/` |
| 记忆文件 | `auto-memory.md`（同名） | `auto-memory.md` |
| 系统提示构建 | 复杂的多段组合（含 Todo 工具说明、git 状态等） | 简化版，含 BASE + knowledge + plan overlay |
| memory extractor | 独立进程/worker | 同进程异步（fire-and-forget） |

## 踩过的坑

### 1. `maxTokens` vs `maxOutputTokens`

AI SDK 的 `generateText` API 使用 `maxOutputTokens` 而不是 `maxTokens`。直接用 `maxTokens` 会导致 TypeScript 类型错误：

```
// ❌ 错误
generateText({ ..., maxTokens: 500 })

// ✅ 正确
generateText({ ..., maxOutputTokens: 500 })
```

### 2. `hydrateLoopState` 漏加字段

新增 `LoopState` 字段后，`session-store.ts` 中的 `hydrateLoopState` 函数也需要同步更新，否则 TypeScript 报 "missing properties" 错误。

记忆：**每次新增 LoopState 字段，都要同时更新：**
1. `loop-state.ts` 的接口定义
2. `loop-state.ts` 的 `createLoopState` 初始值
3. `session-store.ts` 的 `hydrateLoopState` 返回值

### 3. messageCountBeforeLoop 的计算

```typescript
// 用户消息刚推入 state.messages 后
state.messages.push({ role: 'user', content: userMessage })
// 此时 state.messages.length = existingCount + 1

// 记录"循环开始前"的位置（不含刚推入的用户消息）
const messageCountBeforeLoop = state.messages.length - 1
```

如果记录 `state.messages.length`（不减 1），memory extractor 会连用户当前消息也一起重复提取。减 1 后只提取 AI 的回复和工具调用，更精准。

### 4. 系统提示缓存的清空时机

`state.systemPromptCache` 由 `tool-execution.ts` 在 `permissionMode` 变化时置 `null`。
Task A 的 `agentLoop` 每轮检查缓存：
- 缓存存在 → 复用（保证字节稳定）
- 缓存为 null → 重建（permissionMode 变化 → PLAN_MODE_OVERLAY 需要更新）

这种"lazy rebuild"模式避免了每轮重建系统提示，同时确保模式切换时能及时更新。
