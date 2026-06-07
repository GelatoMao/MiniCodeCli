# Task 11 学习文档：Markdown 渲染 + 代码高亮

## 一、本任务完成的内容

Task 11 为终端 AI 输出实现了完整的视觉渲染能力：

| 文件 | 功能 |
|------|------|
| `packages/cli/src/ui/render-markdown.ts` | Markdown → ANSI 终端字符串（标题/列表/引用/代码块/表格） |
| `packages/cli/src/ui/syntax-highlight.ts` | 代码块语法高亮（TypeScript/Python/Rust/Go/Shell 等） |
| `packages/cli/src/ui/render-diff.ts` | edit 工具的彩色 diff 渲染（+ 绿、- 红） |
| `stdout-writer.ts`（修改） | 在助手消息写入时调用 Markdown 渲染 |
| `ChatInput.tsx`（修改） | 分隔线右侧显示 Token 用量状态栏 |
| `App.tsx`（修改） | 传递 `tokenUsage` prop 给 `ChatInput` |

---

## 二、核心设计决策

### 2.1 marked 的 Lexer 模式

我们使用 `marked.lexer(markdown)` 而**不是** `marked(markdown)` 的原因：

- `marked()` 输出 HTML 字符串 → 无法直接渲染到终端
- `marked.lexer()` 输出结构化 Token 数组 → 可以逐 token 转换为 ANSI 序列
- Token 层次分层（块级 → 行内），符合 Markdown 的语义结构

```typescript
const tokens = marked.lexer(markdown)  // 返回 Token[]（块级）
for (const tok of tokens) {
  if (tok.type === 'heading') {
    // tok.tokens 是该标题的行内 tokens（粗体、链接等）
  }
}
```

### 2.2 三层渲染架构

```
renderMarkdown(text)
  → marked.lexer(text) → Token[]
  → renderTokens(tokens)     ← 块级渲染
    → renderToken(tok)
      → case 'code' → highlightCode(code, lang)   ← 语法高亮
      → case 'heading' / 'paragraph' → renderInline(tokens)  ← 行内渲染
```

### 2.3 为什么流式片段不做 Markdown 渲染

Markdown 渲染需要完整的文本结构（代码块需要闭合的 ` ``` `，表格需要完整行）。在流式输出过程中，文本可能截断在任意位置：

```
# 这是一个标## ← 截断于此（破坏了标题语法）
```

**解决方案**：`streamingChunk === true` 的消息原样输出；等 agentLoop 完成后提交为正式消息时，调用 `renderMarkdown` 渲染。

```typescript
// stdout-writer.ts
if (msg.streamingChunk) {
  // 原样输出，不渲染
  renderedContent = msg.content
} else {
  // 完整消息：检测是否有 Markdown，有则渲染
  const rendered = hasMarkdownSyntax(text) ? renderMarkdown(text) : text
  renderedContent = rendered + '\n\n'
}
```

### 2.4 `hasMarkdownSyntax` 的作用

不是所有 AI 回复都含有 Markdown。对纯文字对话（如"好的，我来帮你"），不应该经过 marked 解析（浪费 CPU，也可能引入不必要的字符转换）。

```typescript
export function hasMarkdownSyntax(text: string): boolean {
  return /^#{1,6}\s|^\*\s|^-\s|^\d+\.\s|```|`[^`]|^\s*>|\*\*|__|\[.+\]\(|^---$|^\|.+\|/m.test(text)
}
```

正则覆盖：标题、列表、代码块、行内代码、引用、粗体、链接、分隔线、表格。

### 2.5 语法高亮：正则而非 prism

**为什么不用 prism/shiki**：
- prism: CommonJS 导入困难，ESM 支持需要额外配置
- shiki: 依赖 TextMate Grammar 文件，打包体积 +5MB 以上（esbuild bundle）
- 终端展示场景：精确高亮 vs. 快速启动权衡，正则足够

**正则高亮策略**（按优先级）：
1. 注释（`//`、`#`、`--`）→ 灰蓝斜体
2. 字符串字面量（单引号、双引号、模板字符串）→ 绿色
3. 语言关键字（预定义集合）→ 紫色
4. 数字字面量 → 橙色
5. 函数调用（`word(`）→ 蓝色
6. PascalCase 类型名 → 黄色
7. 操作符 → 青色
8. 括号 → 金色

### 2.6 Diff 渲染：LCS 算法

`render-diff.ts` 使用标准 DP 最长公共子序列算法计算两组行之间的最小编辑距离：

```typescript
// O(N*M) DP 表，对 < 500 行的代码块可接受
for (let i = 1; i <= n; i++) {
  for (let j = 1; j <= m; j++) {
    if (oldLines[i-1] === newLines[j-1]) {
      dp[i][j] = dp[i-1][j-1] + 1
    } else {
      dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1])
    }
  }
}
```

输出格式类 `git diff`（带 `@@` 行，上下各 3 行上下文）。

### 2.7 Token 状态栏的 Cell 解析

Token 状态栏文字含有多个 ANSI 颜色段（每个数字用不同颜色）。要把它写入 cell-diff 渲染引擎，需要将 ANSI 字符串解析为 `(style, char)` pairs：

```typescript
const ansiRegex = /\x1b\[[0-9;]*m/g
let lastStyle = S_DIM
// 解析 ANSI → Cell 数组
while ((match = ansiRegex.exec(tokenText)) !== null) {
  const visChars = tokenText.slice(lastIndex, match.index)
  for (const ch of visChars) {
    tokenCells.push({ char: ch, style: lastStyle, width: 1 })
  }
  lastStyle = match[0]   // 更新当前样式
  lastIndex = match.index + match[0].length
}
```

---

## 三、关键代码解析

### render-markdown.ts：标题渲染

```typescript
case 'heading': {
  const t = token as Tokens.Heading
  const text = renderInline(t.tokens as Token[])
  
  switch (t.depth) {
    case 1:
      // H1：粗体青色 + 下划线
      const underline = '━'.repeat(Math.min(visualLength(text), width))
      return `${C_CYAN}${C_BOLD}${text}${C_RESET}\n${C_CYAN}${underline}${C_RESET}`
    case 2:
      // H2：粗体蓝色 + 普通分隔线
      const underline = '─'.repeat(Math.min(visualLength(text), width))
      return `${C_BLUE}${C_BOLD}${text}${C_RESET}\n${C_GRAY}${underline}${C_RESET}`
    // ...
  }
}
```

`visualLength()` 计算标题文字的视觉宽度（考虑 CJK 双宽字符），用于生成等宽下划线。

### syntax-highlight.ts：代码块框架

```
╭──────────────────────── typescript ───╮
│ const x = 1                           │
│ console.log(x)                        │
╰────────────────────────────────────────╯
```

- 深蓝灰背景（`\x1b[48;2;30;30;40m`）
- 语言标签显示在顶部边框右侧

### ChatInput.tsx：Token 状态栏显示逻辑

```typescript
// 分隔线左侧：灰色 ─
// 分隔线右侧：彩色 token 统计
// 格式：in:1.2k  out:456  cache:800  ctx:12%
```

仅在 `totalTokens > 0` 时显示（agentLoop 开始后才有数据）。

---

## 四、与原项目的差异对比

| 方面 | 原项目（x-code-cli） | 本项目（mini-code-cli） |
|------|---------------------|------------------------|
| Markdown 解析 | 使用 marked + chalk | 相同（直接参考） |
| 语法高亮 | 使用简单正则（无 prism） | 相同策略，略有简化 |
| Diff 渲染 | 基于 LCS diff | 相同（LCS DP） |
| Token 状态栏 | 集成在分隔线行 | 相同位置 |
| 高亮语言覆盖 | TypeScript/Python/Rust/Go/Shell | 相同 |
| `hasMarkdownSyntax` | 存在 | 相同逻辑 |

主要差异：
- **代码块边框样式**：原项目使用简单的等宽背景行，本项目加入了 `╭─╮` Unicode 边框，视觉更丰富
- **CJK 宽度计算**：本项目在 `visualLength` 中对 CJK 范围的处理更完整，参考了 unicode-aware width 标准

---

## 五、踩过的坑

### 坑 1：`token.start` 的类型是 `false | number`

`Tokens.List` 的 `start` 字段类型是 `false | number`（`false` 表示无序列表）。
直接用 `token.start ?? 1` 再做 `itemIndex++` 会触发 TypeScript 错误：

```
TS2356: An arithmetic operand must be of type 'any', 'number', 'bigint' or an enum type
```

**修复**：
```typescript
let itemIndex: number = typeof token.start === 'number' ? token.start : 1
```

### 坑 2：ANSI 字符串不能直接用 `textToCells`

`buildSeparatorWithTokens` 需要将含多个颜色段的 token 状态文字转成 Cell 数组。
`textToCells(text, style)` 只接受单一 style，无法处理内嵌 ANSI。

**解决方案**：手动解析 ANSI 序列，把每段颜色对应的字符分配到各自的 Cell：
```typescript
while ((match = ansiRegex.exec(tokenText)) !== null) {
  // ...把当前 style 对应的可见字符依次推入 tokenCells
}
```

### 坑 3：流式片段 Markdown 渲染导致截断乱码

早期版本对所有消息（含流式片段）都调用 `renderMarkdown`，导致流式过程中出现 `\x1b[1m[截断` 等残留 ANSI 序列。

**修复**：检查 `msg.streamingChunk` flag，流式片段直接原样输出。

### 坑 4：marked 的 chalk 导入

`chalk` v5 是纯 ESM，在 `marked` 的上下文中没有问题，但在 esbuild 打包时需要确认 `external: ['chalk']` 不被错误配置。本项目将 chalk 作为运行时依赖（不 external），esbuild 直接打包进 bundle，无问题。

---

## 六、关键学习点总结

1. **marked Lexer 模式**：`marked.lexer()` 返回结构化 Token 树，是终端渲染的正确入口
2. **行内 vs 块级分离**：`renderInline` 处理行内元素（强调、代码、链接），`renderToken` 处理块级结构（段落、标题、代码块）
3. **流式 vs 完整消息**：流式片段语法可能不完整，应跳过 Markdown 渲染
4. **ANSI Cell 解析**：将 ANSI 字符串解析为 `(style, char)` 对的通用技巧
5. **LCS diff**：O(N*M) 的 DP 表足以处理代码编辑场景（行数通常 < 500）
6. **Token 状态栏可见性**：通过 `totalTokens > 0` 判断是否显示，避免空状态栏
