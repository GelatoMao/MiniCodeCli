# 实现计划：X-Code CLI 从零到一

## 概述

按照设计文档，将项目拆分为 16 个编码步骤，分 6 个阶段递进实现。每步产出可独立运行或可测试的代码。所有任务（包含测试）均为必须完成项。

---

## 阶段一：工程框架

- [ ] 1. 搭建 pnpm monorepo 双包结构
  - 创建 `pnpm-workspace.yaml`，声明 `packages/*`
  - 创建 `packages/core/package.json`：`"type": "module"`，`"exports"` 指向 `dist/`
  - 创建 `packages/cli/package.json`：`"bin": {"xc": "dist/cli.js"}`，依赖 `@x-code-cli/core: workspace:*`
  - 创建 `tsconfig.base.json`（严格模式、NodeNext 模块解析）
  - 创建各包 `tsconfig.json`，使用 `"references"` 建立 core → cli 依赖
  - 配置根 `package.json` 的 `build` / `test` / `typecheck` 脚本
  - _需求：工程化基础_

- [ ] 2. 实现 Provider 注册表（最小 Anthropic 接入）
  - 创建 `packages/core/src/config/index.ts`：从环境变量读取各厂商 API Key
  - 创建 `packages/core/src/providers/registry.ts`：`createModelRegistry()` 使用 `createProviderRegistry`
  - 接入 Anthropic：`createAnthropic({ fetch: permanentErrorFetch })`
  - 实现 `permanentErrorFetch`：HTTP 响应体关键词匹配，将永久失败错误重写为非重试状态码
  - 实现 `getAvailableProviders()` 和 `resolveModelId()`
  - _需求：需求 1.1, 1.2, 1.5_

- [ ] 2.1 为 permanentErrorFetch 编写属性测试（使用 TestAgent 工具）
  - **Property 5：工具结果截断保留前缀**
  - 对各类错误关键词生成随机 HTTP 响应体，验证状态码重写正确
  - _需求：需求 1.6_

- [ ] 3. 实现最简 agentLoop（单轮 streamText）
  - 创建 `packages/core/src/agent/loop-state.ts`：`createLoopState()` 和 `LoopState` 接口
  - 创建 `packages/core/src/agent/loop.ts`（骨架）：单轮 `streamText` 调用
  - 实现 `streamChunksToUI`：迭代 `fullStream`，分发 `text-delta` / `tool-call` / `tool-result`
  - 实现 `collectTurnResponse`：从 `result.response` 收集消息和 token 用量，写入 `state`
  - 暂不实现工具调用分支，只处理 `finishReason === 'stop'`
  - 创建 `packages/core/src/types/index.ts`：`AgentOptions`、`AgentCallbacks` 接口
  - _需求：需求 2.1_

---

## 阶段二：工具系统

- [ ] 4. 实现基础文件工具
  - 创建 `packages/core/src/tools/read-file.ts`：带行号的文件读取，auto-execute
  - 创建 `packages/core/src/tools/write-file.ts`：工具 schema（无 execute，需手动分发）
  - 创建 `packages/core/src/tools/list-dir.ts`：目录列表，auto-execute
  - 创建 `packages/core/src/tools/glob.ts`：文件模式搜索（调 `@vscode/ripgrep`），auto-execute
  - 创建 `packages/core/src/tools/grep.ts`：内容正则搜索，auto-execute
  - 创建 `packages/core/src/tools/edit.ts`：字符串替换 patch，工具 schema
  - 创建 `packages/core/src/tools/index.ts`：导出 `toolRegistry` 和 `truncateToolResult`
  - _需求：需求 3.1_

- [ ] 4.1 使用 TestAgent 工具为文件工具编写单元测试
  - 测试 readFile 带行号输出、ENOENT 错误、大文件截断
  - 测试 edit 的唯一匹配检查、replaceAll 模式
  - _需求：需求 3.1_

- [ ] 5. 实现 Shell 工具 + 权限系统
  - 创建 `packages/core/src/tools/shell-provider.ts`：跨平台 shell 检测（bash/zsh/powershell）
  - 创建 `packages/core/src/tools/shell-utils.ts`：命令分类、引号感知分词、LRU 缓存
  - 创建 `packages/core/src/tools/shell.ts`：shell 工具 schema（无 execute）
  - 创建 `packages/core/src/permissions/index.ts`：`checkPermission` 实现 3 级权限决策
  - 创建 `packages/core/src/permissions/session-store.ts`：会话级 always-allow 内存存储
  - _需求：需求 3.2, 4.1-4.5_

- [ ] 5.1 为权限系统编写属性测试（使用 TestAgent 工具）
  - **Property 3：权限 3 级决策完备性**
  - 验证 trustMode=true 永远返回 true；plan 模式对写工具返回 false
  - _需求：需求 4.1, 4.4, 4.5_

- [ ] 6. 实现工具调用循环（完整 ReAct）
  - 创建 `packages/core/src/agent/messages.ts`：`toolResultMessage`、`toolErrorString` 等消息构造工具函数
  - 创建 `packages/core/src/agent/loop-guard.ts`：滑动窗口哈希检测，`checkForLoop` / `recordToolCall`
  - 创建 `packages/core/src/agent/tool-execution.ts`：`processToolCalls`、`handleToolCall`
    - 实现 `executeWriteTool`（writeFile / edit）
    - 实现 `executeShell`（execa，流式 stdout/stderr，50ms 节流）
    - 实现 `pushToolResult`、`BYPASS_LOOP_GUARD_HANDLERS`
    - 实现 `partitionToolCalls`（task 工具并行批处理）
  - 在 `loop.ts` 中接入 `processToolCalls`，补全 `finishReason === 'tool-calls'` 分支
  - 创建 `packages/core/src/agent/tool-result-sanitize.ts`：`repairOrphanToolCalls`、`truncateToolResultsInMessages`
  - _需求：需求 2.2, 2.3, 2.5, 2.8_

- [ ] 6.1 为 repairOrphanToolCalls 编写属性测试（使用 TestAgent 工具）
  - **Property 1：工具调用配对不变量**
  - 生成包含随机孤立 tool_call 的消息数组，验证修复后每个 call 都有 result
  - _需求：需求 2.8_

---

## 阶段三：Ink TUI

- [ ] 7. 实现最简 Ink 应用
  - 创建 `packages/cli/src/index.ts`：yargs 解析 `--model`、`--trust`、`--print`、`--plan` 参数
  - 实现 `checkNodeVersion()`、`loadEnvFile()`、`resetTerminal()`
  - 实现 `gracefulShutdown()`：优雅退出，打印 resume 提示
  - 注册 `SIGINT` 处理（双 Ctrl+C 强制退出）、`unhandledRejection` 安全网
  - 创建 `packages/cli/src/app.tsx`：`startApp()` 调用 `render(<App />)`
  - 创建最简 `packages/cli/src/ui/components/App.tsx`（仅挂载，不渲染内容）
  - 配置 `esbuild.config.js` 打包脚本
  - _需求：需求 5（框架）_

- [ ] 8. 实现 ChatInput cell buffer 渲染
  - 创建 `packages/cli/src/ui/chat-input/types.ts`：`Cell`、`CellGrid`、`CellRow` 类型定义
  - 创建 `packages/cli/src/ui/chat-input/cells.ts`：`buildCellGrid`、`diffCellGrid`、cell diff 算法
  - 创建 `packages/cli/src/ui/text-width.ts`：CJK 双宽字符宽度计算
  - 创建 `packages/cli/src/ui/stdout-writer.ts`：BSU/ESU 同步更新包裹，batch stdout.write
  - 实现 `packages/cli/src/ui/components/ChatInput.tsx`（核心）：
    - 接管底部 N 行，setInterval 驱动帧渲染
    - 输入框渲染（光标、CJK 宽字符）
    - 滚动消息区（append-only commit）
  - 创建 `packages/cli/src/ui/hooks/use-prompt-input.ts`：stdin raw mode 键序列解析（方向键、Backspace、Enter、Esc、Ctrl 组合键、IME 合成）
  - _需求：需求 5.1, 5.2_

- [ ] 9. 实现 use-agent Hook（React ↔ agentLoop 桥接）
  - 创建 `packages/cli/src/ui/hooks/use-agent.ts`：
    - `useAgent()` Hook，管理 `AgentState`（messages、isLoading、activeToolCalls 等）
    - `submit(text)`：构建 callbacks，调用 `agentLoop`，更新 React state
    - `abort()`：flush buffer → 写中断消息 → `abortController.abort()` → 解除挂起 permission/question Promise
    - `resolvePermission(decision)`：用 `queueMicrotask` 解除 `onAskPermission` Promise
    - `resolveQuestion(answer)`：解除 `onAskUser` Promise
  - 在 `App.tsx` 中接入 `useAgent`，连接 `ChatInput`
  - _需求：需求 2.7, 5.3_

---

## 阶段四：流式渲染与 Markdown

- [ ] 10. 实现流式文字渲染
  - 创建 `packages/cli/src/ui/hooks/use-stream-buffer.ts`：delta 累积 → 定时 flush → `appendMessage`
  - 实现 `DisplayMessage` 类型：`role`、`content`、`toolCalls`、`kind`（command-echo/command-result）
  - 在 `ChatInput` 中实现消息滚动区渲染（`writtenMessageCountRef` diff，append-only）
  - 实现工具行渲染（`⎿ toolName: status [duration]`）
  - 实现 spinner（"Thinking…" / "Reading…" 状态切换）
  - _需求：需求 5.3, 5.4_

- [ ] 11. 实现 Markdown 渲染 + 代码高亮
  - 创建 `packages/cli/src/ui/render-markdown.ts`：使用 `marked` 解析，chalk 渲染标题/列表/引用/代码块
  - 创建 `packages/cli/src/ui/syntax-highlight.ts`：代码块语法高亮（可选 prism）
  - 创建 `packages/cli/src/ui/render-diff.ts`：edit 工具的彩色 diff 渲染（`+` 绿、`-` 红）
  - 在 `ChatInput` 中集成 Markdown 渲染到消息区
  - 实现 Token 用量底部状态栏（input / output / cache / context%）
  - _需求：需求 5.3, 5.5_

---

## 阶段五：进阶 AI 特性

- [ ] 12. 多 Provider 支持 + /model 命令
  - 在 `registry.ts` 中补全 8 家厂商：OpenAI、DeepSeek（含 `deepseekReasoningFetch`）、Google、Alibaba、xAI、Zhipu、MoonshotAI
  - 实现 `PROVIDER_DETECTION_ORDER` 和 fallback 逻辑
  - 实现 `getEnvVarName(provider)`、`PROVIDER_KEY_URLS`
  - 创建 `packages/core/src/agent/provider-compat.ts`：`downgradeBinaryPartsForProvider`（非视觉模型图片处理）
  - 在 `App.tsx` 中实现 `/model` 斜杠命令：弹 `askQuestion` picker → `switchModel`
  - _需求：需求 1.1-1.6_

- [ ] 13. Prompt Caching（Anthropic + OpenAI）
  - 创建 `packages/core/src/providers/cache-control.ts`：`applyCacheControl()`
    - Anthropic：在系统提示 + 最后 3 条工具/消息注入 `cache_control: {type:'ephemeral'}`（最多4个断点）
    - OpenAI：设置 `promptCacheKey: sessionId`
    - OpenAI-compatible（DeepSeek/Moonshot 等）：依赖 `systemPromptCache` 字节稳定，无需额外配置
  - 创建 `packages/core/src/providers/capabilities.ts`：`capabilitiesOf(modelId)` 返回视觉/思考能力标志
  - 在 `loop.ts` 的 `runTurn` 中调用 `applyCacheControl`
  - _需求：需求 7.2_

- [ ] 13.1 为 cache-control 编写属性测试（使用 TestAgent 工具）
  - **Property 2：系统提示幂等性**
  - 验证相同参数两次调用 `buildSystemPrompt` 结果字节相同
  - 验证 `applyCacheControl` 注入的 Anthropic 断点数不超过 4 个
  - _需求：需求 7.2_

- [ ] 14. Context 压缩 + 会话持久化
  - 创建 `packages/core/src/agent/session-store.ts`：
    - `appendHeader`：写入 JSONL header 行（idempotent）
    - `flushPendingMessages`：增量追加 `messages.slice(persistedCount)`
    - `appendUsage`：写 usage 快照行
    - `loadSession`：读取 JSONL，重建 `LoadedSession`
    - `listSessions` / `pickLatestSession`
  - 创建 `packages/core/src/agent/compression.ts`：
    - `checkAndCompressContext`：当 tokens 超过阈值时触发摘要压缩
    - `compressMessages`：使用 LLM 将历史消息生成摘要，替换旧消息
  - 创建 `packages/core/src/agent/context-window.ts`：`getCompressionThreshold`、`getMaxOutputTokens`
  - 实现 `hydrateLoopState(session, permissionMode)`：从 LoadedSession 重建 LoopState
  - _需求：需求 6.1-6.4_

- [ ] 14.1 为会话持久化编写属性测试（使用 TestAgent 工具）
  - **Property 4：JSONL 会话写读一致性**
  - 生成随机消息数组，写入后读出，验证内容完全相同
  - _需求：需求 6.1_

- [ ] 15. Sub-Agent（task 工具）
  - 创建 `packages/core/src/agent/sub-agents/types.ts`：`SubAgentDef`、`SubAgentRegistry` 接口
  - 创建 `packages/core/src/agent/sub-agents/built-in.ts`：4 个内置 agent（explore/general-purpose/plan/code-reviewer）的工具白名单和系统提示
  - 创建 `packages/core/src/agent/sub-agents/loader.ts`：从 `~/.x-code/agents/*.md` 和项目 `.x-code/agents/*.md` 加载自定义 agent
  - 创建 `packages/core/src/agent/sub-agents/registry.ts`：`createSubAgentRegistry()`
  - 创建 `packages/core/src/agent/sub-agents/runner.ts`：`runSubAgent()` — 用独立 LoopState 调用 `agentLoop`，token 汇聚到 parentState，禁止 task 工具递归
  - 创建 `packages/core/src/tools/task.ts`：`createTaskTool(registry)` 工具定义
  - 在 `loop.ts` 的 `buildTools` 中注册 task 工具
  - _需求：需求 3.5_

---

## 阶段六：生态扩展

- [ ] 16. MCP 协议集成
  - 创建 `packages/core/src/mcp/types.ts`：`McpServerConfig`、`McpEntry`、`McpRegistry` 接口
  - 创建 `packages/core/src/mcp/client.ts`：`McpClient` 包装 `@modelcontextprotocol/sdk`，支持 stdio/HTTP transport
  - 创建 `packages/core/src/mcp/name-mangling.ts`：`<server>__<tool>` 名称处理，防冲突
  - 创建 `packages/core/src/mcp/loader.ts`：`loadMcpFromDisk()`，读取用户/项目配置，启动 MCP 服务器
  - 创建 `packages/core/src/mcp/trust.ts`：首次加载项目级配置时的 trust 对话框
  - 创建 `packages/core/src/mcp/permissions.ts`：MCP 工具专用权限存储（always-allow 持久化）
  - 创建 `packages/core/src/mcp/tool-bridge.ts`：`bridgeMcpTool()` 将 MCP tool 转换为 AI SDK tool 格式；`toSystemPromptEntries()` 生成系统提示 MCP 工具描述
  - 创建 `packages/core/src/mcp/registry.ts`：`McpRegistry` 实现（list/get/callTool/shutdown）
  - 在 `loop.ts` 的 `buildTools` 和 `system-prompt.ts` 中接入 MCP 工具
  - 在 `tool-execution.ts` 的 `handleToolCall` 中接入 `handleMcpToolCall`
  - _需求：需求 8.1-8.4_

---

## 附加：知识系统与系统提示

- [ ] A. 实现知识系统（AGENTS.md 5层合并）
  - 创建 `packages/core/src/knowledge/loader.ts`：`buildKnowledgeContext()` 合并 5 层
  - 创建 `packages/core/src/knowledge/auto-memory.ts`：读写 auto-memory.md
  - 创建 `packages/core/src/agent/memory-extractor.ts`：`runMemoryExtractor()`，每轮 stop 后异步提取事实
  - 创建 `packages/core/src/agent/system-prompt.ts`：`buildSystemPrompt()` 和 `PLAN_MODE_OVERLAY`
  - _需求：需求 7.1-7.3_

---

## 说明

- 所有任务（含测试）均为必须完成项，不可跳过
- 每个任务引用具体子需求编号，保证需求可追溯
- 测试任务使用 `generate_unit_test` 工具创建 TestAgent 异步任务，不手动编写测试文件
- 检查点：完成每个阶段后运行 `pnpm typecheck && pnpm test`
- 每步实现完后，先读对应源码（参考原项目），再对比差异

