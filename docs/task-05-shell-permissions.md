# Task 05: Shell 工具 + 权限系统

## 概述

本任务实现了两个相互依赖的核心模块：

1. **Shell 工具** — 跨平台命令执行抽象（`shell-provider.ts` + `shell-utils.ts` + `shell.ts`）
2. **权限系统** — 3 级权限决策模型（`permissions/index.ts` + `permissions/session-store.ts`）

这两个模块共同解决了"AI 执行 shell 命令前如何安全授权"的核心问题。

---

## 核心设计决策

### 1. Shell 工具为何不带 execute？

`shell.ts` 中的 `tool()` 没有提供 `execute` 函数，这是刻意为之的。

```typescript
// shell.ts — 无 execute
export const shell = tool({
  inputSchema: z.object({ command: z.string(), timeout: z.number().optional() }),
  // 没有 execute
})
```

**原因：**
- AI SDK 的 `streamText` 遇到没有 `execute` 的工具时，会产出 `tool-call` chunk
- agent loop 在 `finishReason='tool-calls'` 时收到该 chunk，进行手动处理
- 手动处理允许我们在执行前插入：权限检查 → 用户确认 → 跨平台 shell 选择 → 流式输出

对比 `readFile`（有 execute，AI SDK 自动执行），`shell` 需要更多控制权，所以选择手动分发。

### 2. 权限 3 级模型

```
deny         → 破坏性命令（rm -rf, git push --force, shutdown 等）
always-allow → 只读命令（ls, cat, grep, git status 等）
ask          → 介于两者之间（需要用户确认）
```

关键洞察：**只分析子命令，不分析整个命令字符串**。

```
`ls -la && rm -rf /` 的子命令：["ls -la", "rm -rf /"]
→ rm -rf / 是破坏性的 → 整个命令 deny
```

### 3. trustMode 的优先级

```typescript
if (level === 'deny') return false       // deny 不可被 trust 覆盖
if (level === 'always-allow' || trustMode) return true
```

`deny` 是硬性保护，即使用户开启了 `--trust` 模式，破坏性命令也无法被执行。这个设计防止 AI 误导用户用 `--trust` 绕过安全限制。

### 4. acceptEdits 模式的路径检查

当 `permissionMode === 'acceptEdits'` 时，对写操作自动放行，但有双重保护：

```typescript
if (
  filePath &&
  isPathWithinProject(filePath, projectDir) && // 1. 必须在项目目录内
  !isSensitivePath(filePath)                    // 2. 不能是 .bashrc/.ssh/.git 等敏感文件
) {
  return true
}
```

### 5. 引号感知的命令分词

`splitShellCommands()` 使用状态机而非简单的正则分割，追踪三种状态：
- 单引号内 (`inSingleQuote`)
- 双引号内 (`inDoubleQuote`)  
- 大括号深度 (`braceDepth`)

```typescript
// 正确处理 PowerShell 哈希字面量中的分号
// `Select-Object @{N='Dir';E={$_.Name}},Count`
// `;` 在大括号内 → 不触发分割
```

### 6. PowerShell 控制流特判

PowerShell 中 `if`、`foreach` 等不是命令，而是包裹真正命令的控制流。

```typescript
// `if (Test-Path X) { Get-Content X }` 应该被判断为只读
// 但 READ_ONLY_REGEX 只检查首词，`if` 不在白名单里
// 所以需要 isReadOnlyControlFlow() 单独处理：
// 扫描大括号内的所有 Verb-Noun cmdlet，全部在只读集合内 → 判断为只读
```

---

## 关键代码解析

### shell-provider.ts — PowerShell 编码技巧

```typescript
function encodePowerShellCommand(psCommand: string): string {
  return Buffer.from(psCommand, 'utf16le').toString('base64')
}
```

PowerShell 的 `-EncodedCommand` 接受 UTF-16LE base64，字符集 `[A-Za-z0-9+/=]` 不含任何引号。这意味着用户命令中的引号永远不需要转义，彻底解决了 Windows 命令行参数引号地狱。

### shell-provider.ts — PowerShell exit code 修复

```typescript
const wrapped = [
  // ...
  command,
  '$__ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
  'exit $__ec',
].join('\n')
```

PowerShell 本身不传播 `$LASTEXITCODE` 到进程退出码。不加这段代码，`git push` 失败（退出码1）会变成 exit 0，agent loop 无法判断命令是否成功。

### permissions/session-store.ts — LRU-cap 缓存

```typescript
const SHELL_PERMISSION_CACHE_MAX = 256
const shellPermissionCache = new Map<string, PermissionLevel>()

// Map 保持插入顺序，驱逐最旧的条目
if (shellPermissionCache.size >= SHELL_PERMISSION_CACHE_MAX) {
  const oldest = shellPermissionCache.keys().next().value
  if (oldest !== undefined) shellPermissionCache.delete(oldest)
}
```

Shell 权限评估（正则匹配）在 hot path 上。用简单的 Map + 上限驱逐实现 O(1) 缓存，防止长时间运行的 agent 积累无限唯一命令。

### permissions/session-store.ts — 规则序列化格式

```
shell:*          → 允许所有 shell 命令（tool 级别）
shell:git commit:* → 允许所有以 "git commit" 开头的命令（前缀匹配）
shell:=npm test  → 只允许精确命令 "npm test"（精确匹配）
```

这个文本格式简洁、可读，存储在 `.mini-code/local/permissions.json` 中。

---

## 与原项目 (x-code-cli) 的差异对比

| 方面 | x-code-cli | mini-code-cli |
|------|-----------|--------------|
| `buildAllowRule` | 支持前缀/精确/工具3种规则，有 extractCommandPrefix 复杂逻辑 | 简化为精确匹配和工具级别，前缀逻辑推迟到任务6 |
| `sessionRulesMatch` shell | 复合命令段级别匹配，每段独立检查 | 简化为全命令精确匹配或前缀匹配 |
| `suggestRuleLabel` | 支持 `git commit:*`、`git commit:*, git push:*` 等丰富标签 | 简化为 "this exact command" |
| 配置目录 | `.x-code` | `.mini-code` |
| utils.ts | 包含 debugLog、日志轮转、fileExists 等大量工具函数 | 精简为只有目录常量 |

**简化原则**：保留核心安全逻辑（3级决策、deny 优先、路径保护），暂缓实现复杂的前缀提取逻辑（任务6补全）。

---

## 踩过的坑

### 1. `deny` 不能被 `trustMode` 覆盖

原始代码中检查顺序非常重要：

```typescript
// ❌ 错误顺序：trustMode 覆盖了 deny
if (trustMode) return true
if (level === 'deny') return false

// ✅ 正确顺序：deny 优先
if (level === 'deny') return false
if (trustMode) return true
```

`sudo rm -rf /` 不应该因为用户设置了 `--trust` 就被执行。

### 2. execa 的 `reject: false` 参数

execa 默认在非零退出码时抛出异常（就像 `execSync` 在 throw 模式）。对于 shell 工具，我们希望捕获任何退出码并呈现给模型：

```typescript
return execa(executable, ['-c', command], {
  reject: false,  // 非零退出码不抛异常，由 agent loop 检查 exitCode
})
```

### 3. 测试文件的 `safeParse` 错误（存量问题）

`typecheck` 报告的 `edit.test.ts` 中 `safeParse` 类型错误是任务4遗留的问题：

```
FlexibleSchema<...> 没有 safeParse 属性
```

AI SDK 的 `tool()` 返回的 schema 类型是 `FlexibleSchema`，它不暴露 zod 的 `safeParse` 方法。测试文件需要直接用 zod schema 而不是 tool.inputSchema 来验证。这个问题将在任务5.1（TestAgent 属性测试）中修复。

---

## 架构图

```
用户提交 shell 命令
      │
      ▼
  agentLoop (任务6实现)
      │
      ├─► checkPermission()
      │       │
      │       ├── getPermissionLevel()
      │       │       │
      │       │       └── splitShellCommands()
      │       │               ├── isDestructive() → deny
      │       │               └── isReadOnly()   → always-allow
      │       │
      │       ├── trustMode? → allow
      │       ├── acceptEdits + 项目内路径? → allow
      │       ├── sessionRulesMatch()? → allow
      │       └── onAskPermission() → 等待用户决策
      │
      └─► getShellProvider()
              │
              ├── macOS/Linux → bash/zsh provider
              └── Windows     → PowerShell provider
                                 (UTF-16LE base64 编码)
```
