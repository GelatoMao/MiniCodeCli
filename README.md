# mini-code-cli

一个运行在终端里的 AI 编程助手。支持 Anthropic、OpenAI、DeepSeek、Google 等 8 家主流模型厂商，具备文件读写、Shell 执行、代码搜索、MCP 协议扩展等能力。

---

## 安装

### 前置要求

- **Node.js >= 20.19.0**

### npm 全局安装（推荐）

```bash
npm install -g @mini-code-cli/cli
```

安装完成后即可在任意目录使用 `mini-code` 或 `mc` 命令。

> **注意**：包内置了绝大多数依赖（单文件 bundle），安装时会额外下载 `@vscode/ripgrep` 原生二进制（用于文件搜索），首次安装耗时稍长属正常现象。

### 从源码构建

适合想修改源码或参与开发的场景：

```bash
git clone <repo-url>
cd mini-code-cli

pnpm install   # 需要 pnpm
pnpm build

# 全局链接
cd packages/cli
npm link
```

之后可以在任意目录使用 `mini-code` 或 `mc` 命令。

---

## 配置 API Key

mini-code-cli 通过环境变量读取 API Key，**不会将密钥写入磁盘**。

| 厂商 | 环境变量 | 申请地址 |
|------|----------|----------|
| Anthropic | `ANTHROPIC_API_KEY` | https://console.anthropic.com/ |
| OpenAI | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| DeepSeek | `DEEPSEEK_API_KEY` | https://platform.deepseek.com/ |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` | https://aistudio.google.com/apikey |
| 阿里云（通义） | `ALIBABA_API_KEY` | https://bailian.console.aliyun.com/ |
| xAI (Grok) | `XAI_API_KEY` | https://console.x.ai/ |
| 智谱 (GLM) | `ZHIPU_API_KEY` | https://open.bigmodel.cn/ |
| Moonshot (Kimi) | `MOONSHOT_API_KEY` | https://platform.moonshot.cn/ |
| OpenAI 兼容接口 | `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` | — |

**推荐方式**：在项目根目录创建 `.env` 文件，cli 启动时会自动从 cwd 向上查找并加载：

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

也可以直接 `export` 到 shell 环境：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
mini-code
```

---

## 快速上手

### 交互模式（默认）

```bash
mini-code
# 或短命令
mc
```

启动后进入 TUI 界面，直接输入问题即可：

```
> 帮我找出 src/ 目录下所有超过 200 行的 TypeScript 文件
> 在 utils.ts 第 42 行加一个日志
> 运行测试并告诉我哪里失败了
```

### 非交互模式（单次输出）

适合在脚本或 CI 中使用：

```bash
mini-code --print "解释一下这个项目的目录结构"
# 或
mc -p "这个函数有什么问题？"
```

### 带初始提示启动

```bash
mini-code "重构 packages/core/src/agent/loop.ts，减少函数长度"
```

---

## 命令行选项

```
mini-code [options] [prompt]

选项：
  -m, --model     指定模型（见下方模型列表）
  -t, --trust     信任模式：跳过写操作确认弹窗
  -p, --print     非交互模式：输出结果后退出
      --plan      计划模式：只读探索，不执行写操作
      --max-turns 限制 agent 循环最大轮次
  -h, --help      显示帮助
```

---

## 选择模型

使用 `--model`（或 `-m`）指定模型，支持以下格式：

### 短别名

| 别名 | 实际模型 |
|------|---------|
| `sonnet` | `anthropic:claude-sonnet-4-5` |
| `haiku` | `anthropic:claude-haiku-4-5` |
| `opus` | `anthropic:claude-opus-4-5` |
| `gpt4` | `openai:gpt-4.1` |
| `gpt4o` | `openai:gpt-4o` |
| `o1` | `openai:o1` |
| `o3` | `openai:o3` |
| `deepseek` | `deepseek:deepseek-chat` |
| `deepseek-r1` | `deepseek:deepseek-reasoner` |
| `gemini` | `google:gemini-2.0-flash` |
| `qwen` | `alibaba:qwen-plus` |
| `grok` | `xai:grok-beta` |
| `glm` | `zhipu:glm-4-plus` |
| `kimi` / `moonshot` | `moonshot:moonshot-v1-8k` |

### 完整模型 ID

```bash
mini-code --model anthropic:claude-opus-4-5
mini-code --model openai:gpt-4o
mini-code --model deepseek:deepseek-reasoner
```

### 默认模型

如果不指定 `--model`，cli 会按以下优先级选择：

1. 环境变量 `MINI_CODE_MODEL`（如 `export MINI_CODE_MODEL=deepseek`）
2. 第一个配置了 API Key 的厂商（按 Anthropic → OpenAI → DeepSeek → ... 顺序检测）

---

## 工作模式

### 默认模式

Agent 可以读写文件、执行 Shell 命令。执行**写操作**（writeFile、edit、shell）前会弹出权限确认：

```
Allow mini-code to run: git commit -m "fix: ..."?
[y] Yes  [a] Always allow  [n] No
```

- 选 `y`：本次允许
- 选 `a`：本 session 内始终允许该命令（不再询问）
- 选 `n`：拒绝

### 信任模式（`--trust`）

跳过所有权限确认，适合在受控环境中使用：

```bash
mini-code --trust "自动修复所有 lint 错误并提交"
```

### 计划模式（`--plan`）

只读模式，Agent 只能读取文件和分析代码，不能执行任何写操作。适合先探索再执行：

```bash
mini-code --plan "分析登录模块，制定重构方案"
# 确认方案后，退出 plan 模式，在普通模式执行
```

---

## 内置工具

Agent 在对话中会自动选择使用以下工具：

| 工具 | 功能 |
|------|------|
| `readFile` | 读取文件内容（带行号） |
| `writeFile` | 创建新文件 |
| `edit` | 修改已有文件（精确字符串替换） |
| `listDir` | 列出目录内容 |
| `glob` | 按模式搜索文件 |
| `grep` | 在代码中正则搜索 |
| `shell` | 执行 Shell 命令（支持流式输出） |
| `task` | 调用 Sub-Agent 完成子任务（并行） |

---

## 知识系统（AGENTS.md）

mini-code-cli 支持通过 Markdown 文件向 Agent 注入项目或个人知识，按 **5 层优先级**合并（低到高）：

| 层级 | 文件路径 | 说明 |
|------|----------|------|
| 1（最低）| `~/.mini-code/AGENTS.md` | 用户全局规则 |
| 2 | `~/.mini-code/auto-memory.md` | 用户级自动记忆（Agent 自动维护） |
| 3 | `<项目路径>/AGENTS.md`（多层） | 项目规则，从 git 根到当前目录，越具体优先级越高 |
| 4 | `<cwd>/.mini-code/auto-memory.md` | 项目级自动记忆（Agent 自动维护） |
| 5（最高）| `<cwd>/AGENTS.local.md` | 本地私人偏好（建议加入 `.gitignore`） |

**示例**：在项目根目录创建 `AGENTS.md`：

```markdown
# Project Rules

- 所有代码使用 TypeScript strict 模式
- 提交信息遵循 Conventional Commits 规范
- 测试框架使用 vitest，不使用 jest
```

Agent 每次会话启动时自动读取并注入系统提示。**auto-memory** 文件由 Agent 在每轮对话结束后自动提取并记录有用的事实（如用户偏好、项目约定），无需手动维护。

---

## MCP 协议扩展

mini-code-cli 支持 [MCP（Model Context Protocol）](https://modelcontextprotocol.io/) 协议，可接入任意 MCP 服务器扩展工具能力。

### 配置文件位置

- **用户级**：`~/.mini-code/mcp.json`（对所有项目生效）
- **项目级**：`<cwd>/.mini-code/mcp.json`（首次加载会弹出 trust 确认）

### 配置格式

**stdio 模式**（本地子进程，最常用）：

```json
{
  "servers": [
    {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    {
      "name": "my-tool",
      "transport": "stdio",
      "command": "python",
      "args": ["my_mcp_server.py"],
      "env": {
        "MY_API_KEY": "..."
      }
    }
  ]
}
```

**HTTP 模式**（远程服务）：

```json
{
  "servers": [
    {
      "name": "remote-service",
      "transport": "http",
      "url": "https://my-mcp-server.example.com/mcp",
      "headers": {
        "Authorization": "Bearer my-token"
      }
    }
  ]
}
```

MCP 工具在 Agent 中以 `<服务器名>__<工具名>` 形式出现，自动注入系统提示。

---

## 会话持久化

每次对话会自动保存到 `<cwd>/.mini-code/sessions/` 目录（JSONL 格式）。下次启动时可以恢复上次会话：

```bash
mini-code
# 启动后会提示是否恢复上次会话
```

会话文件记录完整的消息历史和 token 用量统计，支持断点续传。

当上下文接近模型 token 上限时，会自动触发**压缩摘要**：使用 LLM 将历史消息压缩为摘要，保留对话连续性的同时控制 token 消耗。

---

## 开发

```bash
# 安装依赖
pnpm install

# 构建所有包
pnpm build

# 运行测试
pnpm test

# 类型检查
pnpm typecheck

# 开发模式（tsx 直接运行，无需构建）
cd packages/cli
pnpm dev
```

### 项目结构

```
mini-code-cli/
├── packages/
│   ├── core/          # 业务逻辑（Agent、工具、权限、Provider）
│   │   └── src/
│   │       ├── agent/      # agentLoop、LoopState、工具执行、会话持久化
│   │       ├── tools/      # 文件工具、Shell 工具、截断处理
│   │       ├── permissions/# 权限系统（3 级决策）
│   │       ├── providers/  # 多厂商注册表、Prompt Caching
│   │       ├── knowledge/  # AGENTS.md 5 层合并、auto-memory
│   │       ├── mcp/        # MCP 协议集成
│   │       └── config/     # 环境变量读取、模型解析
│   └── cli/           # UI 层（Ink TUI）
│       └── src/
│           ├── index.ts    # CLI 入口 + yargs 参数解析
│           ├── app.tsx     # Ink render 入口
│           └── ui/
│               ├── components/  # App.tsx、ChatInput.tsx
│               └── hooks/       # use-agent、use-prompt-input、use-stream-buffer
└── docs/              # 各模块学习文档
```

---

## 许可证

MIT
