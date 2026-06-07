// @mini-code-cli/cli — edit 工具的彩色 Diff 渲染
//
// Task 11：将 edit 工具的 old_string/new_string patch 转换为
// 类 git diff 的彩色终端输出（+ 绿色、- 红色）。
//
// 设计：
//   - 不依赖 diff 库，使用简单的行级对比
//   - 对每行做前缀标记：- 删除行（红色）、+ 新增行（绿色）、  上下文行（灰色）
//   - 显示文件路径头部（类似 git diff --stat）
//   - 上下文行数：前后各 3 行（与 git diff 默认行为一致）
//
// 用法：
//   const diffText = renderEditDiff(filePath, oldString, newString)
//   writeToStdout(diffText)

// ── ANSI 颜色 ─────────────────────────────────────────────────────────────────

const C_RESET = '\x1b[0m'
const C_DIM = '\x1b[2m'
const C_BOLD = '\x1b[1m'
const C_RED = '\x1b[38;2;255;107;128m'         // 删除行前景
const C_RED_BG = '\x1b[48;2;60;20;20m'         // 删除行背景
const C_GREEN = '\x1b[38;2;78;186;101m'         // 新增行前景
const C_GREEN_BG = '\x1b[48;2;20;50;20m'        // 新增行背景
const C_GRAY = '\x1b[38;2;136;136;136m'
const C_CYAN = '\x1b[38;2;80;210;210m'          // 文件名颜色
const C_HUNK_HEADER = '\x1b[38;2;147;165;255m'  // @@ 行颜色

// ── 行级 diff 计算 ────────────────────────────────────────────────────────────

/**
 * 使用最长公共子序列（LCS）计算两组行之间的最小编辑序列。
 * 返回 DiffOp 数组，描述从 oldLines 变换到 newLines 需要的操作。
 */
type DiffOp =
  | { type: 'equal'; line: string }
  | { type: 'delete'; line: string }
  | { type: 'insert'; line: string }

/**
 * 简单的 Myers 算法简化版本：
 * 使用 DP 表计算最短编辑路径。
 * 对于代码 diff 场景（行数通常 < 500），O(N*M) 是可接受的。
 */
function computeDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length
  const m = newLines.length

  // LCS DP 表（使用滚动数组节省内存）
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
      }
    }
  }

  // 回溯构建 diff 操作
  const ops: DiffOp[] = []
  let i = n
  let j = m

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'equal', line: oldLines[i - 1]! })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.push({ type: 'insert', line: newLines[j - 1]! })
      j--
    } else {
      ops.push({ type: 'delete', line: oldLines[i - 1]! })
      i--
    }
  }

  ops.reverse()
  return ops
}

// ── Hunk 分组 ────────────────────────────────────────────────────────────────

/** 上下文行数（前后各 3 行） */
const CONTEXT_LINES = 3

interface Hunk {
  oldStart: number  // 1-indexed
  oldCount: number
  newStart: number
  newCount: number
  ops: DiffOp[]
}

/**
 * 将 diff 操作列表按连续修改区域分组为 Hunks。
 * 每个 Hunk 包含前后各 CONTEXT_LINES 行的上下文。
 */
function groupIntoHunks(ops: DiffOp[]): Hunk[] {
  if (ops.length === 0) return []

  // 标记每个 op 是否在修改区域附近
  const hasChange = ops.map((op) => op.type !== 'equal')

  // 标记需要输出的 op 索引（修改区域 ± CONTEXT_LINES 范围内）
  const included = new Array(ops.length).fill(false)
  for (let i = 0; i < ops.length; i++) {
    if (hasChange[i]) {
      for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(ops.length - 1, i + CONTEXT_LINES); j++) {
        included[j] = true
      }
    }
  }

  // 按连续 included 区段分组
  const hunks: Hunk[] = []
  let oldLine = 1
  let newLine = 1

  let i = 0
  while (i < ops.length) {
    if (!included[i]) {
      // 跳过不包含的 equal op，同时更新行号计数
      const op = ops[i]!
      if (op.type === 'equal' || op.type === 'delete') oldLine++
      if (op.type === 'equal' || op.type === 'insert') newLine++
      i++
      continue
    }

    // 找到当前 hunk 的结束边界（最后一个连续 included 的 op）
    let j = i
    while (j < ops.length && included[j]) {
      j++
    }

    // 收集这段 ops 并计算行号
    const hunkOps = ops.slice(i, j)
    const hunk: Hunk = {
      oldStart: oldLine,
      newStart: newLine,
      oldCount: 0,
      newCount: 0,
      ops: hunkOps,
    }

    for (const op of hunkOps) {
      if (op.type === 'equal' || op.type === 'delete') {
        hunk.oldCount++
        oldLine++
      }
      if (op.type === 'equal' || op.type === 'insert') {
        hunk.newCount++
        newLine++
      }
    }

    hunks.push(hunk)
    i = j
  }

  return hunks
}

// ── 渲染 ─────────────────────────────────────────────────────────────────────

/**
 * 将 edit 工具的 patch 参数渲染为类 git diff 格式的终端字符串。
 *
 * @param filePath 被修改的文件路径（用于标题行）
 * @param oldString 被替换的原始字符串
 * @param newString 替换后的新字符串
 * @returns ANSI 着色的 diff 字符串（末尾不含 \n）
 */
export function renderEditDiff(filePath: string, oldString: string, newString: string): string {
  const oldLines = oldString.split('\n')
  const newLines = newString.split('\n')

  const ops = computeDiff(oldLines, newLines)
  const hunks = groupIntoHunks(ops)

  if (hunks.length === 0) {
    // 无变化
    return `${C_GRAY}（无变化）${C_RESET}`
  }

  const lines: string[] = []

  // 文件路径标题
  lines.push(`${C_CYAN}${C_BOLD}${filePath}${C_RESET}`)

  // 统计变化行数
  let addCount = 0
  let delCount = 0
  for (const op of ops) {
    if (op.type === 'insert') addCount++
    if (op.type === 'delete') delCount++
  }

  const statParts: string[] = []
  if (addCount > 0) statParts.push(`${C_GREEN}+${addCount}${C_RESET}`)
  if (delCount > 0) statParts.push(`${C_RED}-${delCount}${C_RESET}`)
  if (statParts.length > 0) {
    lines.push(`${C_GRAY}${statParts.join(' ')} 行变化${C_RESET}`)
  }

  // 每个 Hunk
  for (const hunk of hunks) {
    // @@ 行
    const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
    lines.push(`${C_HUNK_HEADER}${hunkHeader}${C_RESET}`)

    // Hunk 内容行
    for (const op of hunk.ops) {
      switch (op.type) {
        case 'equal': {
          lines.push(`${C_DIM}  ${op.line}${C_RESET}`)
          break
        }
        case 'delete': {
          lines.push(`${C_RED_BG}${C_RED}- ${op.line}${C_RESET}`)
          break
        }
        case 'insert': {
          lines.push(`${C_GREEN_BG}${C_GREEN}+ ${op.line}${C_RESET}`)
          break
        }
      }
    }
  }

  return lines.join('\n')
}

/**
 * 渲染文件新建操作（writeFile 时使用）。
 * 将整个文件内容作为纯新增 diff 展示。
 *
 * @param filePath 新文件路径
 * @param content 文件内容
 */
export function renderNewFileDiff(filePath: string, content: string): string {
  const lines = content.split('\n')

  const parts: string[] = [
    `${C_CYAN}${C_BOLD}${filePath}${C_RESET} ${C_GRAY}(new file)${C_RESET}`,
    `${C_GREEN}+${lines.length}${C_RESET}${C_GRAY} 行${C_RESET}`,
    `${C_HUNK_HEADER}@@ -0,0 +1,${lines.length} @@${C_RESET}`,
    ...lines.map((line) => `${C_GREEN_BG}${C_GREEN}+ ${line}${C_RESET}`),
  ]

  return parts.join('\n')
}
