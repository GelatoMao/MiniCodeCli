# X-Code CLI：从零到一复现 — 需求文档

## 一、产品功能需求

### 系统概述

X-Code CLI（命令 `xc`）是一个 **终端 AI 编程助手**，工作模式与 Claude Code / Gemini CLI 相似：用户在终端输入自然语言，AI 调用工具（读写文件、执行命令、搜索代码）来完成编程任务。

**核心架构**：两个 pnpm workspace 包，单向依赖 `cli → core`。

---

### 需求 1：多 Provider AI 对话

**User Story**：作为开发者，我想用自己已有的 API Key 与 AI 对话，不被绑定在某一家厂商。

#### 验收标准

1. THE CLI SHALL 支持至少以下 8 个 Provider：Anthropic、OpenAI、DeepSeek、Google、Alibaba（通义）、xAI（Grok）、Zhipu（智谱）、MoonshotAI（月之暗面）
2. THE CLI SHALL 通过环境变量（如 `ANTHROPIC_API_KEY`）读取 API Key，不持久化到磁盘
3. WHEN 用户未配置任何 API Key，THE CLI SHALL 打印友好提示和各厂商的 Key 获取链接，并以退出码 0 退出
4. WHEN 用户通过 `--model` 指定了 provider 但对应 Key 缺失，THE CLI SHALL 报错并退出码 1
5. THE CLI SHALL 支持 OpenAI 兼容的自定义 endpoint（通过 `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL`）
6. WHEN 持久化配置中的 model 所属 provider 的 Key 已被删除，THE CLI SHALL 打印警告并自动回退到第一个可用 provider，不崩溃

---

### 需求 2：流式对话与工具调用（Agent Loop）

**User Story**：作为开发者，我想让 AI 能主动读写文件、执行命令来完成任务，而不只是聊天。

#### 验收标准

1. WHEN 用户提交消息，THE Agent SHALL 以流式方式输出 AI 回复（逐字符打印）
2. WHEN AI 决定调用工具，THE Agent SHALL 在界面显示工具名称和执行状态
3. THE Agent SHALL 循环执行工具直到 AI 返回 `finishReason === 'stop'`
4. WHEN AI 响应因 `length` 被截断，THE Agent SHALL 自动续写，最多重试 3 次
5. WHEN AI 使用工具遭遇循环（同一工具重复调用），THE Agent SHALL 通过 Loop Guard 检测并终止
6. WHEN 上下文接近模型窗口上限，THE Agent SHALL 自动触发 LLM 摘要压缩
7. WHEN 用户按 Esc，THE Agent SHALL 中止当前请求并输出中断提示，不退出程序
8. IF 工具调用产生孤立的 `tool_call`（无对应 `tool_result`），THEN THE Agent SHALL 在下次 API 调用前自动补全合成结果，防止 400 错误

---

### 需求 3：内置工具集

**User Story**：作为开发者，我希望 AI 能操作本地文件系统和执行 shell 命令，帮我完成实际编码任务。

#### 验收标准

1. THE FileTools SHALL 支持：readFile、writeFile、edit（patch diff）、glob（文件搜索）、grep（内容搜索，调 ripgrep）、listDir
2. THE ShellTool SHALL 通过 execa 执行命令，支持流式输出、超时控制、AbortSignal 取消
3. THE WebTools SHALL 支持：webFetch（抓取网页转 Markdown）、webSearch（Tavily / Brave API）
4. THE FileIngestTool SHALL 支持在用户消息中通过 `@path` 引用文件，自动处理图片（vision/OCR）、PDF、Office 文档
5. THE TaskTool SHALL 把子任务委托给独立 sub-agent（隔离上下文、工具白名单、禁止递归）

---

### 需求 4：权限控制系统

**User Story**：作为开发者，我希望对危险操作（写文件、执行命令）有确认机制，防止 AI 意外破坏文件。

#### 验收标准

1. THE PermissionSystem SHALL 对每个写操作工具实现三级控制：always-allow（自动通过）/ ask（弹确认框）/ deny（拒绝）
2. WHEN 工具处于 `ask` 级别，THE CLI SHALL 暂停执行并在 TUI 中显示权限确认对话框
3. WHEN 用户选择 "Always Allow"，THE PermissionSystem SHALL 持久化该工具的 always-allow 状态到当前会话
4. WHEN 用户使用 `--trust` 标志启动，THE CLI SHALL 跳过所有写操作确认
5. WHEN 用户进入 Plan Mode（`--plan`），THE Agent SHALL 只允许只读工具，写操作需用户批准计划后才能执行

---

### 需求 5：终端 UI（TUI）

**User Story**：作为用户，我希望有清晰、流畅的终端界面，支持中文输入，不会出现字符错位。

#### 验收标准

1. THE TUI SHALL 通过直写 `process.stdout` 的 cell-diff 算法渲染，不依赖 Ink 的 Yoga 布局（消除 CJK/IME 抖动）
2. THE InputBox SHALL 正确处理 CJK 双宽字符的光标定位
3. THE TUI SHALL 渲染 AI 回复中的 Markdown（标题、列表、代码块语法高亮）
4. THE TUI SHALL 在工具执行时显示实时进度（工具名 + 状态 + 耗时）
5. THE TUI SHALL 显示 Token 用量统计（input / output / cache）
6. WHEN AI 有待办事项（todoWrite），THE TUI SHALL 在 spinner 上方展示 Todo 面板

---

### 需求 6：会话管理

**User Story**：作为开发者，我希望对话历史能保存，下次可以继续上次的任务。

#### 验收标准

1. THE SessionStore SHALL 以 JSONL 格式增量写入对话记录（每轮追加，不全量重写）
2. WHEN 用户使用 `--continue`（`-c`），THE CLI SHALL 自动加载本项目最近一次会话
3. WHEN 用户使用 `--resume <id>`，THE CLI SHALL 通过 sessionId / slug / 文件名前缀精确查找会话
4. WHEN 用户使用 `--resume`（无参数），THE CLI SHALL 在 TUI 内弹出会话选择器
5. WHEN 程序退出，THE CLI SHALL 打印 `xc --resume <id>` 提示，方便用户下次恢复
6. THE MemoryExtractor SHALL 在每轮正常结束后异步提取关键事实，写入 auto-memory.md

---

### 需求 7：知识系统（AGENTS.md）

**User Story**：作为开发者，我希望能通过项目根目录的 AGENTS.md 文件向 AI 注入项目级上下文和规则。

#### 验收标准

1. THE KnowledgeSystem SHALL 合并 5 层上下文：用户 AGENTS.md → 用户 auto-memory → 项目 AGENTS.md 链（root→leaf，leaf 覆盖 root）→ 项目 auto-memory → AGENTS.local.md
2. THE KnowledgeSystem SHALL 保证系统提示跨 turn 字节稳定（不插入时间戳等动态内容）
3. WHERE AGENTS.local.md 存在，THE KnowledgeSystem SHALL 将其合并到系统提示（个人偏好，gitignore）

---

### 需求 8：MCP 协议支持

**User Story**：作为高级用户，我希望能接入外部 MCP 服务器（如 filesystem、sentry 等），动态扩展 AI 的工具集。

#### 验收标准

1. THE McpLoader SHALL 从用户配置和项目配置加载 MCP 服务器（stdio / HTTP transport）
2. WHEN 项目级 MCP 配置是首次加载，THE CLI SHALL 在挂载 TUI 前展示 trust 确认对话框
3. THE McpRegistry SHALL 支持工具名 mangling（`server__tool` 格式），防止跨服务器名称冲突
4. THE McpAuth SHALL 支持 OAuth 2.0 认证流程（browser redirect → callback server → token storage）

---

---

## 二、学习任务需求（分阶段实现目标）

### 阶段 1：工程框架（第 1-3 步）

| 步骤 | 实现目标 | 核心学习点 |
|------|---------|-----------|
| 1 | pnpm monorepo + TypeScript 双包 | pnpm workspace、tsconfig 项目引用、NodeNext ESM、`.js` 后缀 |
| 2 | Provider 注册表（最小 Anthropic） | AI SDK `createAnthropic`、`createProviderRegistry`、env 读取 |
| 3 | 最简 agentLoop（单轮 streamText） | `streamText`、`finishReason`、`for await fullStream` |

### 阶段 2：工具系统（第 4-6 步）

| 步骤 | 实现目标 | 核心学习点 |
|------|---------|-----------|
| 4 | 基础文件工具（readFile/writeFile/listDir） | `tool()` 定义、Zod 入参、auto-execute 注册 |
| 5 | Shell 工具 + 权限系统 | execa、AbortController 取消链路、3 级权限模型 |
| 6 | 工具循环（ReAct 多轮） | processToolCalls、tool-result 消息格式、state.messages |

### 阶段 3：Ink TUI（第 7-9 步）

| 步骤 | 实现目标 | 核心学习点 |
|------|---------|-----------|
| 7 | 最简 Ink 应用（yargs + render） | yargs 解析、`render()`、`waitUntilExit` |
| 8 | ChatInput cell buffer 渲染 | ANSI 序列、cell diff、stdin raw mode、CJK 宽字符 |
| 9 | use-agent Hook（React ↔ agentLoop 桥接） | useRef 管理 LoopState、React 18 批处理、AbortController |

### 阶段 4：流式渲染与 Markdown（第 10-11 步）

| 步骤 | 实现目标 | 核心学习点 |
|------|---------|-----------|
| 10 | 流式文字渲染 + useStreamBuffer | delta 累积 → flush、滚动管理 |
| 11 | Markdown 渲染 + 代码高亮 | marked、chalk、prism、终端宽度折行 |

### 阶段 5：进阶 AI 特性（第 12-15 步）

| 步骤 | 实现目标 | 核心学习点 |
|------|---------|-----------|
| 12 | 多 Provider + /model 命令 | permanentErrorFetch、resolveModelId、运行时切换 |
| 13 | Prompt Caching | Anthropic cache_control、systemPromptCache 字节稳定 |
| 14 | Context 压缩 + 会话持久化 | context window 计算、JSONL 增量写入、hydrateLoopState |
| 15 | Sub-Agent（task 工具） | 独立 LoopState、toolFilter 白名单、禁止递归、token 汇聚 |

### 阶段 6：生态扩展（第 16 步）

| 步骤 | 实现目标 | 核心学习点 |
|------|---------|-----------|
| 16 | MCP 协议集成 | MCP SDK、stdio/HTTP transport、工具 mangling、OAuth |

---

## 三、关键正确性约束

1. **字节稳定系统提示**：`systemPromptCache` 在整个 session 内容不变，每次修改会导致 OpenAI 兼容厂商的 prefix cache 失效
2. **tool_call ↔ tool_result 配对**：每个工具调用必须有对应结果，否则下次 API 请求报 400
3. **AbortSignal 贯穿**：所有异步操作（streamText / execa / 文件 IO）必须接入同一个 AbortSignal
4. **不可重试错误识别**：余额不足、内容违规等错误必须在 HTTP 拦截层提前标记为不可重试，避免浪费 30 秒重试

---

## 四、词汇表

- **Agent Loop**：模型 → 工具 → 模型的循环，直到 `finishReason === 'stop'`
- **LoopState**：单个 session 的全部状态（messages、tokenUsage、systemPromptCache 等），跨轮复用
- **Provider**：AI 模型厂商（Anthropic / OpenAI / DeepSeek 等）
- **MCP**：Model Context Protocol，外部工具服务器协议
- **Cell Buffer**：终端渲染的 2D 字符网格，用于 diff 渲染
- **Prompt Caching**：Anthropic / OpenAI 的服务端缓存，减少重复 token 计费
- **Sub-Agent**：通过 `task` 工具启动的独立 agentLoop，有独立上下文和工具集

