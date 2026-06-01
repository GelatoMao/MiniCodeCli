# Task 07 — 最简 Ink 应用

## 核心设计决策

### 1. CLI 入口职责划分

`index.ts` 承担 "启动协调者" 角色，在 Ink 挂载之前完成所有同步初始化工作：

| 步骤 | 职责 | 关键原因 |
|------|------|---------|
| `checkNodeVersion()` | 检查 Node ≥ 20.19.0 | `Array.fromAsync`、`process.loadEnvFile` 等 API 的最低版本要求 |
| `loadEnvFile()` | 向上查找 `.env` 并加载 | 让用户把 API Key 放在项目根，无需每次 `export` |
| yargs 解析 | `--model`、`--trust`、`--print`、`--plan`、`--max-turns` | 将 CLI 参数结构化为 `AgentOptions` |
| Provider 检查 | `getAvailableProviders()` → 无 key 时打印帮助并 `exit(0)` | exit 0（非 1）避免 pnpm 报 ELIFECYCLE 错误 |
| `startApp()` | 挂载 Ink，返回 `waitUntilExit` | 将 Ink 渲染逻辑与 CLI 逻辑解耦 |
| `gracefulShutdown()` | `resetTerminal()` → `process.exit()` | 确保终端在任何情况下都能恢复 |

### 2. 终端恢复设计（`resetTerminal`）

使用同步 `fs.writeSync(1, ...)` 而非 `process.stdout.write()`，原因：
- `process.stdout.write` 是异步的，在 SIGINT 等信号处理中可能不会及时刷新
- `fs.writeSync` 绕过 Node.js 流缓冲，直接写 fd 1，保证原子性
- 即使 Ink 已经卸载或抛出异常，同步写入仍能恢复终端

需要恢复的 4 个状态：
- `\x1b[0m` — SGR 重置：防止颜色/粗体等 ANSI 属性泄漏到 shell 提示符
- `\x1b[?2004l` — 关闭 bracketed paste：Ink 开启 raw mode 时会打开它
- `\x1b[?25h` — 显示光标：ChatInput 帧渲染期间光标通常被隐藏
- `\x1b[?1049l` — 退出备用屏幕：防止 alt-screen 泄漏

### 3. 双 Ctrl+C 强制退出

```
第 1 次 Ctrl+C:
  SIGINT → sigintCount=1 → process.exitCode=0 → Ink 接管（内部拦截 Ctrl+C 触发卸载）
  Ink 卸载 → waitUntilExit resolve → gracefulShutdown(0)

第 2 次 Ctrl+C（用户不耐烦，在 gracefulShutdown 运行期间按了第二次）:
  SIGINT → sigintCount=2 → resetTerminal() → process.exit(0)（立即退出）
```

与 `exitOnCtrlC: false` 配合：把 Ctrl+C 的控制权交给我们自己，而不是 Ink 默认行为（直接 `process.exit(1)`）。

### 4. `app.tsx` 的必要性

`app.tsx` 是一个专门的 Ink 渲染入口，不放在 `index.ts` 里：
- 隔离 Ink 依赖（`import { render } from 'ink'` 只出现在这里）
- 导出 `startApp()` 供测试或 `--print` 模式（Task 10 将绕过 Ink）直接调用
- 未来注册 `onCleanupReady` / `onSessionInfoReady` 回调时不会污染 `index.ts`

### 5. App.tsx 最简骨架

Task 7 的 `App.tsx` 只返回一个空 `<Box />`，原因：
- Task 8 才引入 `ChatInput`（依赖 cell-buffer 和 stdout 直接写入）
- 过早注入 UI 组件会让 Task 7 变成两个任务的混合，难以独立验证
- Ink 挂载一个空 `<Box />` 即可验证"Ink 能正常工作"这一基础

---

## 关键代码解析

### `loadEnvFile()` 向上查找

```typescript
function loadEnvFile(): void {
  let dir = process.cwd()
  while (true) {
    const envPath = path.join(dir, '.env')
    if (fs.existsSync(envPath)) {
      try { process.loadEnvFile(envPath) } catch { /* 忽略解析错误 */ }
      return
    }
    const parent = path.dirname(dir)
    if (parent === dir) break // 到达文件系统根
    dir = parent
  }
}
```

`process.loadEnvFile` 是 Node 20.19+ 内置 API，无需 `dotenv` 包，且会自动合并到 `process.env`。

### yargs 解析 `--max-turns` 命名

yargs 的 `--max-turns` 在 `argv` 中以 camelCase 访问需要用 `argv['max-turns']`（连字符不会自动转换为下划线）。

### `unhandledRejection` 安全网

AI SDK 的 `streamText` 内部会创建多个独立 Promise（`response`、`usage`、`finishReason`、`toolCalls`、流内部 flush）。当请求失败时，它们可能各自独立 reject。如果漏掉任何一个，Node 默认会 fatal exit。安全网把这些"噪音"记录到 `DEBUG_STDOUT` 日志，而不是崩溃进程。

---

## 与原项目的差异对比

| 对比点 | 原项目（x-code-cli） | mini-code-cli（Task 7）|
|--------|---------------------|----------------------|
| 参数数量 | 10+ 个（含 `--continue`、`--resume`、`--plugins`、`--hooks` 等） | 5 个核心参数 |
| Provider 回退 | 带 chalk 彩色提示 + `PROVIDER_DETECTION_ORDER` 遍历 | 简化版，相同逻辑 |
| `gracefulShutdown` | 还负责关闭 MCP、触发插件 SessionEnd hook | 仅 `resetTerminal` + `exit` |
| Resume 功能 | `--continue`、`--resume` 完整会话持久化 | 未实现（Task 14）|
| Plugin 系统 | 完整插件加载、SubAgentRegistry、SkillRegistry | 未实现（后续任务）|
| `App.tsx` | 2500+ 行，含全部斜杠命令处理 | 最简骨架，8 行 |
| 打印模式 | `--print` 走 `print.ts` 绕过 Ink | Task 7 阶段 `--print` flag 已解析但未连接 |

---

## 踩过的坑

### 1. `exit(0)` vs `exit(1)` 在"无 API Key"场景

原项目注释：`// Exit 0: this is a user-configuration hint, not a crash. Non-zero would make pnpm pile on ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL / ELIFECYCLE noise.`

使用 `exit(1)` 时，pnpm 会在 monorepo 根目录再打印一条 `ELIFECYCLE` 错误，让用户误以为有 bug。`exit(0)` 告诉 pnpm "一切正常，只是用户需要配置"。

### 2. `fs.writeSync` vs `process.stdout.write` 在 `resetTerminal`

最初考虑用 `process.stdout.write`，但 SIGINT 信号处理函数是同步的，异步 write 可能不会立即刷新。改用 `fs.writeSync(1, ...)` 确保同步写入 fd 1。

### 3. JSX 需要 `tsconfig.json` 里配置 `jsx`

`app.tsx` 使用 JSX，需要 tsconfig 里有 `"jsx": "react-jsx"` 或 esbuild 的 `jsx: 'automatic'`。已通过 esbuild.config.js 的 `jsx: 'automatic'` 处理，无需修改 tsconfig。
