# Task 08 — ChatInput Cell Buffer 渲染

## 核心设计决策

### 为什么绕过 Ink 直接写 stdout？

Ink 使用 [Yoga 布局引擎](https://github.com/facebook/yoga) 计算组件尺寸，内部使用 `string.length` 统计字符宽度。但对于 CJK（中日韩）字符，一个字符的 `string.length = 1`，而在终端中实际占用 **2 列**。

这带来的问题：
- Ink 重绘时，光标回退行数计算错误
- 含 CJK 字符的行被截断或错位
- 每次状态更新都全量重绘，效率低

**解决方案**：ChatInput 完全接管底部 N 行的渲染，绕过 Ink 的布局引擎，直接向 `process.stdout` 写原始 ANSI 序列。

### Cell-Diff 渲染模型

```
每帧 = Cell[][] (二维网格)
  ↓
与上一帧逐 cell 比较 (char + style)
  ↓
只为有变化的 cell 发射 ANSI 序列
  ↓
BSU + 差分字节 + ESU_HIDE → 单次 process.stdout.write()
```

`Cell` 类型：
```typescript
interface Cell {
  char: string   // 单个字符
  style: string  // 原始 ANSI SGR 转义串（如 "\x1b[38;2;78;186;101m"）
  width: number  // 终端视觉宽度：1（普通）或 2（CJK）
}
```

### DEC 2026 同步更新模式（BSU/ESU）

```typescript
const BSU = '\x1b[?2026h'   // Begin Synchronized Update
const ESU_HIDE = '\x1b[?2026l\x1b[?25l'  // End + hide cursor
```

支持 BSU/ESU 的终端（VSCode、iTerm2、Windows Terminal、Ghostty）会将 BSU～ESU 之间的所有输出缓冲为单帧原子渲染，消除差分写入期间的中间闪烁状态。不支持的终端静默忽略这两条序列。

### 为什么不用 DECSC/DECRC（\x1b7/\x1b8）？

终端只有**一个**光标保存寄存器。Ink 自身的 `log-update` 也在用同一寄存器（每次 render 循环都调用 `\x1b7`）。如果 ChatInput 也用它，两者会互相覆盖光标位置，产生"幽灵恢复位置"的 bug。

替代方案：用绝对定位序列 `\x1b[row;colH`（CUP）重建光标位置，无需保存/恢复。

## 文件结构与职责

```
packages/cli/src/ui/
├── text-width.ts               CJK 双宽字符判断（isWide/charWidth/visualWidth/sliceByWidth）
├── display-types.ts            DisplayMessage、DisplayToolCall UI 层类型
├── stdout-writer.ts            向 scrollback 写消息（用户消息/工具调用/助手文字）
├── chat-input/
│   ├── types.ts                公共类型（MenuItem、SlashCommand、PermissionRequest 等）
│   ├── cells.ts                Cell 类型 + textToCells/ansiTextToCells/renderRowToAnsi
│   ├── palette.ts              ANSI 颜色/样式常量（S_GRAY、S_SUCCESS、S_CURSOR 等）
│   ├── reducer.ts              输入缓冲区原子 reducer（INSERT/BACKSPACE/DELETE/SET_CURSOR）
│   └── text-helpers.ts        truncateCellRow、wrapCellsToRows、countContentRows 等
├── hooks/
│   └── use-prompt-input.ts    stdin raw mode 键序列解析 + 括号粘贴支持
└── components/
    └── ChatInput.tsx           核心组件（cell-diff 渲染引擎 + 键盘处理）
```

## 关键代码解析

### 1. CJK 宽度计算（text-width.ts）

```typescript
export function isWide(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||  // CJK Unified Ideographs
    (cp >= 0xac00 && cp <= 0xd7af) ||  // Hangul Syllables
    // ... 更多 Unicode 范围
  )
}

export function charWidth(ch: string): number {
  return isWide(ch.codePointAt(0)!) ? 2 : 1
}
```

覆盖了终端普遍渲染为双宽的 Unicode 区间（CJK、全角日文假名、全角符号等）。

### 2. Cell Diff 算法（ChatInput.tsx）

```typescript
function buildDiffWrite(prev: Cell[][], next: Cell[][], termRows: number): string {
  const frameTop = Math.max(1, termRows - h + 1)
  let buf = BSU

  for (let r = 0; r < h; r++) {
    const row = r + frameTop
    for (let c = 0; c < nextRow.length; c++) {
      if (oldCell && cellsEqual(newCell, oldCell)) {
        if (newCell.width === 2) c++  // 跳过 CJK 宽字符的第二半格
        continue
      }
      // 计算视觉列位置并发射更新
      let visualCol = 1
      for (let ci = 0; ci < c; ci++) visualCol += nextRow[ci]?.width ?? 1
      buf += `\x1b[${row};${visualCol}H${newCell.style}${newCell.char}`
    }
  }
  return buf + S_RESET + ESU_HIDE
}
```

关键：CJK 字符宽度为 2，在内部 cell 数组中占一格，但视觉上跨两列。差分循环用 `visualCol` 追踪实际终端列（而非 cell 索引），保证定位精确。

### 3. 括号粘贴检测（use-prompt-input.ts）

双重策略：
1. **括号粘贴模式**：发送 `\x1b[?2004h`，终端用 `\x1b[200~...~\x1b[201~` 包裹粘贴内容
2. **防抖回退**：块大小 ≥ 32 字节或含 `\n` 的输入，进入 30ms 防抖 buffer 合并为单个 `onPaste` 调用

```typescript
const PASTE_DEBOUNCE_MS = 30
const MAX_BATCH_MS = 50       // 防止持续按键不断重置计时器
const PASTE_SIZE_THRESHOLD = 32
```

`MAX_BATCH_MS` 上限防止了按住键时防抖计时器被无限重置、直到松键才一次性发送的"冻结"问题。

### 4. Scrollback Append-Only 提交

```typescript
// 主渲染 effect 中
let scrollbackContent = ''
while (writtenMessageCountRef.current < messages.length) {
  const msg = messages[writtenMessageCountRef.current]!
  writeMessageToStdout((s) => { scrollbackContent += s }, msg)
  writtenMessageCountRef.current++
}
```

`writtenMessageCountRef` 单调递增，保证每条消息只写一次。写入的内容通过预先发射 LF 向上推送终端内容，为新消息腾出空间，然后再重绘底部帧。

## 与原项目（x-code-cli）的差异对比

| 特性 | x-code-cli | mini-code-cli (Task 8) |
|------|-----------|------------------------|
| 斜杠命令补全 | ✅ 模糊匹配 + 二级菜单 | ❌ Task 9+ |
| @-mention 文件补全 | ✅ | ❌ Task 9+ |
| 权限对话框（in-frame） | ✅ | ❌ Task 9+ |
| 选项选择对话框 | ✅ | ❌ Task 9+ |
| 输入历史（Up/Down） | ✅ 持久化到 JSONL | ❌ Task 9+ |
| 粘贴引用折叠（[#N +M lines]） | ✅ | ❌ Task 9+ |
| Todo 面板 | ✅ | ❌ Task 9+ |
| 工具调用进度行 | ✅ | 简化版（Task 10 完善）|
| Markdown 渲染 | ✅ | ❌ Task 11 |
| 代码高亮 | ✅ | ❌ Task 11 |
| BSU/ESU 原子渲染 | ✅ | ✅ |
| CJK 宽字符感知 | ✅ | ✅ |
| 括号粘贴检测 | ✅ | ✅ |
| Cell-diff 渲染 | ✅ | ✅ 核心算法一致 |
| DECSC/DECRC 规避 | ✅ | ✅ |

## 踩过的坑

### 1. `stdout.off()` 返回值类型

```typescript
// ❌ 错误：stdout.off() 返回 NodeJS.WriteStream，不是 void
return () => stdout.off('resize', onResize)

// ✅ 正确：包裹在 void 函数中
return () => {
  stdout.off('resize', onResize)
}
```

TypeScript 的 `useEffect` cleanup 函数必须返回 `void | Destructor`，而 EventEmitter 的 `.off()` 返回 `this`（即 `WriteStream`）。

### 2. S_NONE 必须是非空转义

```typescript
// ❌ 危险：空字符串作为默认样式
export const S_NONE = ''

// ✅ 正确：显式重置
export const S_NONE = '\x1b[0m'
```

Cell-diff 发射器：若 `cell.style !== lastStyle`，发射 `cell.style`。若 S_NONE 是空串，则样式"继承"上一个 cell 的颜色，导致颜色溢出/闪烁。

### 3. CJK 宽字符的第二半格处理

```typescript
if (oldCell && cellsEqual(newCell, oldCell)) {
  if (newCell.width === 2) c++  // 跳过宽字符的第二半格
  continue
}
```

内部 cell 数组只为宽字符存**一个**格（width=2），但终端渲染时该字符占两列。如果不跳过，后续 cell 的 `visualCol` 计算会偏移一列，导致所有后续字符显示位置错误。
