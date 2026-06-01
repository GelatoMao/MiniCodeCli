# Task 04：基础文件工具系统

## 概述

本任务实现了 `packages/core/src/tools/` 下的 6 个基础文件工具，以及配套的 `truncate.ts` 和工具注册表 `index.ts`。同时在 `utils/` 目录下补充了 `tool-errors.ts` 工具。

---

## 文件清单

```
packages/core/src/
  utils/
    tool-errors.ts          ← 统一错误格式化
  tools/
    progress.ts             ← 工具进度报告 registry
    utils.ts                ← getRipgrepPath 等共享辅助函数
    truncate.ts             ← 工具结果双预算截断
    read-file.ts            ← 带行号文件读取（auto-execute）
    write-file.ts           ← 文件写入工具 schema（无 execute）
    list-dir.ts             ← 目录列表（auto-execute）
    glob.ts                 ← 文件模式搜索 via ripgrep（auto-execute）
    grep.ts                 ← 内容正则搜索 via ripgrep（auto-execute）
    edit.ts                 ← 字符串替换工具 schema（无 execute）
    index.ts                ← 工具注册表 + 统一导出
```

---

## 核心设计决策

### 1. auto-execute 与手动分发的区分

工具分两类：

| 类型 | 工具 | 原因 |
|------|------|------|
| `auto-execute`（有 `execute`）| `readFile`, `listDir`, `glob`, `grep` | 只读操作，无安全风险，AI SDK 可自动执行 |
| 手动分发（无 `execute`）| `writeFile`, `edit` | 写操作，需要进入权限检查流程再执行 |

关键代码模式：
```typescript
// auto-execute：AI SDK 直接调用 execute
export const readFile = tool({
  inputSchema: z.object({ ... }),
  execute: async ({ filePath }, { toolCallId }) => { ... }
})

// 手动分发：只有 schema，没有 execute
export const writeFile = tool({
  inputSchema: z.object({ ... }),
  // No execute — handled manually in agent loop
})
```

### 2. Progress 侧信道 registry

AI SDK 的 `execute` 函数签名固定，无法传入自定义回调。Progress reporter 使用模块级 Map 实现侧信道：

```typescript
// agent loop 在 tool-call 事件时注册
setProgressReporter(toolCallId, (msg) => callbacks.onToolProgress(toolCallId, msg))

// 工具内部调用（无需感知外部）
reportProgress(toolCallId, `Reading ${filePath}`)

// agent loop 在 tool-result 后清理
clearProgressReporter(toolCallId)
```

这样工具定义保持干净，不需要任何依赖注入。

### 3. readFile 的双截断机制

`readFile` 有两层保护：

1. **行数截断**（`LARGE_FILE_LINE_THRESHOLD = 2000`）：超过 2000 行自动只返回前 2000 行，附带提示如何读取后续内容
2. **字节截断**（`MAX_READ_BYTES = 256KB`）：即使用户指定了 `limit`，也不会返回超过 256KB 的内容，防止上下文超限

截断附带的提示信息告诉模型如何自恢复，避免重复相同的无效调用：
```
[readFile: showing first 2000/5432 lines.
Call readFile again with offset/limit to view other ranges, or use grep to find specific symbols.]
```

### 4. truncateToolResult 的 head-tail 分割

工具结果的截断不只保留开头，而是保留前 20% + 后 80%，中间插入截断标记。设计理由：
- 开头通常包含上下文（如文件路径、标题）
- 结尾通常包含最新结果（grep 最后的匹配、log 最新的记录）
- 中间内容对模型决策贡献最小

特殊情况：Shell 输出用 `direction: 'head'`，因为末尾是重复的提示符/退出码。

### 5. glob 工具用 ripgrep 代替 Node glob 库

三个理由：
1. `@vscode/ripgrep` 已经是 grep 工具的依赖，无额外成本
2. ripgrep 速度极快，自动尊重 `.gitignore`
3. `--sortr=modified` 提供按修改时间排序，截断时最相关的文件优先保留

```typescript
const isCatchAll = /^(\*\*\/?\*?|\*)$/.test(pattern.trim())
const args = ['--files', '--sortr=modified', '--hidden', '--glob', '!.git']
if (!isCatchAll) {
  args.push('--glob', pattern)
}
```

注意：catch-all 模式（`**/*`, `**`, `*`）不传 `--glob` 参数，因为 ripgrep 的 `--glob` 是白名单模式，会覆盖 `.gitignore`，导致 `node_modules` 等噪声文件全部出现。

### 6. getRipgrepPath 使用 createRequire 加载 CJS 模块

`@mini-code-cli/core` 是 ESM 包（`"type": "module"`），全局 `require` 不存在。`@vscode/ripgrep` 是 CJS-only 包，需要用 `createRequire(import.meta.url)` 来加载它：

```typescript
const _require = createRequire(import.meta.url)
const rg = _require('@vscode/ripgrep') as { rgPath: string }
```

---

## 关键代码解析

### truncateToolResult 的两步截断

```typescript
// 先行截断（保留结构化分块）
const lineSlice = applyLineSlice(result, maxLines, direction, headRatio)
// 再字节截断（处理长单行或 CJK 密集内容）
const byteSlice = applyByteSlice(lineSlice.result, maxBytes, direction, headRatio)
```

字节截断时需要 UTF-8 边界对齐，不然会产生乱码：
```typescript
function sliceBytes(buf: Buffer, bytes: number, direction: 'head' | 'tail'): Buffer {
  if (direction === 'head') {
    let end = bytes
    // continuation bytes in UTF-8 have high bits `10xxxxxx`
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
    return buf.subarray(0, end)
  }
  // ...
}
```

### readFile 的 offset/limit 语义

- `offset`：从第几行开始（**1-based**），对应 `start = offset - 1`
- `limit`：读取多少行
- 两者都不传：自动判断是否超过 2000 行阈值

---

## 与原项目的差异

| 特性 | 原项目 | mini 版 |
|------|--------|---------|
| readFile 图片支持 | ✅ 返回 `content` 类型的 image-data/file-data | ❌ 未实现（focus 在核心功能） |
| readFile PDF 支持 | ✅ 返回 file-data | ❌ 未实现 |
| toolRegistry | 包含 webFetch, webSearch, askUser, enterPlanMode, exitPlanMode, todoWrite | 只包含文件工具 |
| classifyFile | 用于区分 text/image/pdf | 未引入，直接按文本处理 |

mini 版有意保持简洁，只实现学习所需的核心部分。

---

## 踩过的坑

### 1. index.ts 中 writeFile 和 edit 放入 toolRegistry 的问题

任务要求将 `writeFile` 和 `edit` 放入 `toolRegistry`，但它们没有 `execute`。如果放入 `toolRegistry` 传给 `streamText`，AI SDK 会认为这些工具需要"human in the loop"，会进入 `for await (const chunk of result.fullStream)` 中的 `tool-call` 分支而不会自动执行。

这实际上是预期行为——agent loop 需要在 `tool-calls` finishReason 时手动分发这些工具。

### 2. ripgrep exit code 1 = 无匹配（不是错误）

```typescript
if (err && typeof err === 'object' && 'code' in err && err.code === 1) {
  return 'No matches found.'  // 正常结果，不是错误
}
```

ripgrep 用 exit code 0 表示有匹配，**1 表示无匹配**，2 表示错误。不处理这个区别会让模型认为工具调用失败。

### 3. progress reporter 的 toolCallId 可能为 undefined

AI SDK 的 `execute` 函数第二个参数 `{ toolCallId }` 中，`toolCallId` 可能为 `undefined`（如直接调用工具函数时）。`reportProgress` 做了空值保护：

```typescript
export function reportProgress(toolCallId: string | undefined, message: string): void {
  if (!toolCallId) return  // 安全地 no-op
  reporters.get(toolCallId)?.(message)
}
```
