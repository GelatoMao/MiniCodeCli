// @mini-code-cli/core — Tool-output truncation
//
// 【设计目标】
// 工具结果（readFile / grep / shell 等）可能非常大，直接放入 context 会：
//   1. 超出模型 context window 限制，导致 API 请求失败
//   2. 浪费大量 token 预算，推高成本
//
// 本模块实现"双预算截断"：行数 OR 字节数任意一个超限就触发截断，
// 截断后保留首尾内容（head + tail），丢弃中间部分，并插入截断标记。
//
// 【head-tail 分割策略】
// 为什么保留首尾而不只保留开头？
//   - 文件开头：通常包含 import/package 声明、类定义等上下文
//   - 文件结尾：通常包含最新修改的代码、导出声明
//   - 文件中间：通常是重复性内容（函数体、数据行），对模型决策贡献最小
// 默认比例 20:80（头部 20%，尾部 80%）—— 尾部更重要。
//
// 【例外：Shell 输出用 head-only】
// Shell 命令的输出末尾通常是重复的 shell 提示符和退出码，
// 有用的信息集中在开头（命令输出的主体），所以 shell 工具使用 direction: 'head'。

/** 默认行数上限。超过后保留首尾切片而非完整内容。 */
export const MAX_TOOL_RESULT_LINES = 2000

/**
 * 默认字节上限（UTF-8 编码）。
 * 同时约束 ASCII 内容（单行 minified JS）和非 ASCII 内容（CJK 代码/注释），
 * 后者 char count 较小但 byte count 可能很大。
 */
export const MAX_TOOL_RESULT_BYTES = 50 * 1024

/** head-tail 模式中头部占总预算的比例。0.2 = 头部 20%，尾部 80%。 */
export const DEFAULT_HEAD_RATIO = 0.2

export interface TruncateOptions {
  /** 触发截断的行数阈值。默认 {@link MAX_TOOL_RESULT_LINES}。 */
  maxLines?: number
  /** 触发截断的字节数阈值（UTF-8）。默认 {@link MAX_TOOL_RESULT_BYTES}。 */
  maxBytes?: number
  /**
   * 截断时保留哪部分内容：
   *  - `head-tail`（默认）：保留前 20% + 后 80%，丢弃中间。
   *    适用于文件读取、grep 结果等结构化内容。
   *  - `head`：只保留开头 N 字节。
   *    适用于 shell 输出，尾部是重复的提示符/退出码。
   *  - `tail`：只保留末尾 N 字节。
   *    适用于日志文件，最新的条目在末尾。
   */
  direction?: 'head-tail' | 'head' | 'tail'
  /** head-tail 模式中头部比例。默认 {@link DEFAULT_HEAD_RATIO}。 */
  headRatio?: number
}

/**
 * 计算字符串的 UTF-8 字节数。
 * 用于精确判断是否超出字节预算，而非使用可能误判 CJK 的 `.length`。
 */
function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf-8')
}

/**
 * 在 UTF-8 字符边界处截取 Buffer，避免在多字节字符中间切断产生乱码（U+FFFD）。
 *
 * UTF-8 编码规则：多字节字符的后续字节均以 `10xxxxxx`（0x80-0xBF）开头。
 * 截断时向前/向后扫描，跳过这些续字节，找到合法的字符起始位置。
 *
 * @param buf       - 待截取的 UTF-8 Buffer
 * @param bytes     - 目标字节数
 * @param direction - 'head' 保留前 N 字节，'tail' 保留后 N 字节
 */
function sliceBytes(buf: Buffer, bytes: number, direction: 'head' | 'tail'): Buffer {
  if (buf.length <= bytes) return buf
  if (direction === 'head') {
    let end = bytes
    // 向前扫描，跳过 UTF-8 续字节（高位为 10xxxxxx），直到找到字符起始字节
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
    return buf.subarray(0, end)
  }
  // tail 模式：从后端向前找合法起始位置
  let start = buf.length - bytes
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start)
}

/**
 * 行切片结果的中间表示。
 * headEnd 记录 head+tail 拼接字符串中头部结束的字符索引，
 * 用于后续在正确位置插入截断标记（而非插在 tail 的末尾）。
 */
type SliceResult = {
  sliced: string
  /**
   * 仅 head-tail 模式有效：`sliced` 字符串中头部结束处的字符索引。
   * 截断标记应插入在 `sliced[0..headEnd]` 和 `sliced[headEnd..]` 之间。
   * null 表示 head 或 tail 单向模式，不需要分割点。
   */
  headEnd: number | null
}

/**
 * 按行数预算对结果字符串进行切片。
 *
 * 返回切片结果和丢弃的行数。如果行数未超限，原样返回（linesDropped = 0）。
 *
 * @param result    - 原始工具结果字符串
 * @param maxLines  - 行数上限
 * @param direction - 截断方向（同 TruncateOptions.direction）
 * @param headRatio - head-tail 模式中头部占比
 */
function applyLineSlice(
  result: string,
  maxLines: number,
  direction: 'head-tail' | 'head' | 'tail',
  headRatio: number,
): { result: SliceResult; linesDropped: number } {
  const lines = result.split('\n')
  // 未超限：原样返回，headEnd=null 表示无需插入截断标记
  if (lines.length <= maxLines) return { result: { sliced: result, headEnd: null }, linesDropped: 0 }

  if (direction === 'head') {
    return {
      result: { sliced: lines.slice(0, maxLines).join('\n'), headEnd: null },
      linesDropped: lines.length - maxLines,
    }
  }
  if (direction === 'tail') {
    return {
      result: { sliced: lines.slice(-maxLines).join('\n'), headEnd: null },
      linesDropped: lines.length - maxLines,
    }
  }

  // head-tail 模式：按比例分配头部和尾部行数
  // Math.max(1, ...) 保证头部至少保留 1 行，避免 headRatio 极小时头部为空
  const headLines = Math.max(1, Math.floor(maxLines * headRatio))
  const tailLines = maxLines - headLines
  const head = lines.slice(0, headLines).join('\n')
  const tail = lines.slice(-tailLines).join('\n')
  // headEnd 记录头部字符串结束位置，用于后续在此处插入截断标记
  return { result: { sliced: head + '\n' + tail, headEnd: head.length }, linesDropped: lines.length - maxLines }
}

/**
 * 在行切片结果的基础上，进一步按字节数预算截取。
 *
 * 行切片之后可能仍然超出字节预算，例如：
 *   - 单行极长的 minified JS（行数=1，但字节数很大）
 *   - CJK 密集内容（每字符 3 字节，行数少但字节多）
 *
 * @param input     - 行切片的结果（SliceResult）
 * @param maxBytes  - 字节数上限
 * @param direction - 截断方向
 * @param headRatio - head-tail 模式中头部字节占比
 */
function applyByteSlice(
  input: SliceResult,
  maxBytes: number,
  direction: 'head-tail' | 'head' | 'tail',
  headRatio: number,
): SliceResult {
  const buf = Buffer.from(input.sliced, 'utf-8')
  if (buf.length <= maxBytes) return input // 未超限，原样返回

  if (direction === 'head') return { sliced: sliceBytes(buf, maxBytes, 'head').toString('utf-8'), headEnd: null }
  if (direction === 'tail') return { sliced: sliceBytes(buf, maxBytes, 'tail').toString('utf-8'), headEnd: null }

  // head-tail 模式：将字节预算按比例分配给头部和尾部
  // Math.max(256, ...) 保证头部至少 256 字节，避免极端比例下头部几乎为空
  const headBudget = Math.max(256, Math.floor(maxBytes * headRatio))
  const tailBudget = maxBytes - headBudget
  const head = sliceBytes(buf, headBudget, 'head').toString('utf-8')
  const tail = sliceBytes(buf, tailBudget, 'tail').toString('utf-8')
  // 拼接后 headEnd 指向头部字符串的结尾，用于插入截断标记
  return { sliced: head + tail, headEnd: head.length }
}

/**
 * 将工具结果截断到行数和字节数双重预算以内。
 *
 * 若结果同时满足行数和字节数限制，原样返回，不做任何修改。
 * 截断后会在头部和尾部之间（或结尾）插入一行截断标记，
 * 告知模型这是有意省略，而非数据损坏，并提示如何获取完整内容。
 *
 * 截断顺序：先行切片，再字节切片。
 * 原因：行切片保留了内容的结构完整性（grep 匹配行、目录条目等），
 * 字节切片仅在确实超出字节预算时才进一步裁剪。
 *
 * @param result  - 待截断的工具结果字符串
 * @param options - 可选截断参数，未指定则使用默认值
 * @returns 截断后（或原样的）结果字符串
 */
export function truncateToolResult(result: string, options: TruncateOptions = {}): string {
  const maxLines = options.maxLines ?? MAX_TOOL_RESULT_LINES
  const maxBytes = options.maxBytes ?? MAX_TOOL_RESULT_BYTES
  const direction = options.direction ?? 'head-tail'
  const headRatio = options.headRatio ?? DEFAULT_HEAD_RATIO

  // 统计原始内容的行数、字节数、字符数（字符数用于计算 droppedChars）
  const origLines = (result.match(/\n/g)?.length ?? 0) + 1
  const origBytes = byteLength(result)
  const origChars = result.length

  // 快速路径：两项预算均未超限，直接返回原始结果
  if (origLines <= maxLines && origBytes <= maxBytes) return result

  // 两步截断：先行切片，再字节切片
  const lineSlice = applyLineSlice(result, maxLines, direction, headRatio)
  const byteSlice = applyByteSlice(lineSlice.result, maxBytes, direction, headRatio)

  // 构造截断标记：优先报告行数（更直观），否则只报告字节数
  const droppedChars = origChars - byteSlice.sliced.length
  const marker =
    lineSlice.linesDropped > 0
      ? `[truncated: ${lineSlice.linesDropped} lines / ${droppedChars.toLocaleString()} chars dropped — narrow the tool args or read specific ranges]`
      : `[truncated: ${droppedChars.toLocaleString()} chars dropped — output exceeded byte budget]`

  // head 模式：标记附在末尾
  if (direction === 'head') return `${byteSlice.sliced}\n\n${marker}`
  // tail 模式：标记附在开头
  if (direction === 'tail') return `${marker}\n\n${byteSlice.sliced}`

  // head-tail 模式：标记插入在头部和尾部之间
  // headEnd 是字符索引，指向头部结束的位置
  if (byteSlice.headEnd != null && byteSlice.headEnd > 0 && byteSlice.headEnd < byteSlice.sliced.length) {
    return `${byteSlice.sliced.slice(0, byteSlice.headEnd)}\n\n${marker}\n\n${byteSlice.sliced.slice(byteSlice.headEnd)}`
  }
  // headEnd 无效（可能字节切片后头部为空）：标记放在开头
  return `${marker}\n\n${byteSlice.sliced}`
}
