// @mini-code-cli/cli — ChatInput cell-diff 渲染器的样式调色板
//
// Cell 存储的是原始样式字符串，cell-diff 发射器无法运行 chalk，
// 因此这里使用硬编码的 RGB ANSI 转义序列。
// 颜色值与 Claude Code 深色主题保持一致。
//
// Task 8 — 直接采用 x-code-cli 原实现。

export const S_GRAY = '\x1b[38;2;136;136;136m' // promptBorder #888888
export const S_ACCENT = '\x1b[38;2;215;119;87m' // claude #d77757
export const S_ACCENT_DIM = '\x1b[38;2;153;153;153m' // inactive #999999
export const S_SPINNER = '\x1b[38;2;147;165;255m' // claudeBlue #93a5ff
export const S_SUCCESS = '\x1b[38;2;78;186;101;1m' // success bold #4eba65

// 非粗体版本 —— 与 stdout-writer.formatToolCall 中 c.hex(SUCCESS)('●') 视觉一致
export const S_SUCCESS_DOT = '\x1b[0m\x1b[38;2;78;186;101m'

// 暗色版本 —— 搭配 S_SUCCESS_DOT 实现运行中工具的"心跳"脉冲效果
export const S_SUCCESS_DOT_DIM = '\x1b[0m\x1b[38;2;78;186;101;2m'

// 粗体，无前景色 —— 必须以 \x1b[0m 开头以重置之前的前景色
export const S_BOLD = '\x1b[0m\x1b[1m'

// 蓝紫色 — 与 committed scrollback 中 c.hex(BLUE_PURPLE)('(...)') 匹配
export const S_BLUE_PURPLE = '\x1b[0m\x1b[38;2;153;204;255m'
export const S_BLUE_PURPLE_BOLD = '\x1b[0m\x1b[38;2;153;204;255;1m'

export const S_WARNING = '\x1b[38;2;255;193;7m' // warning #ffc107
export const S_WARNING_BOLD = '\x1b[38;2;255;193;7;1m'
export const S_ERROR_BOLD = '\x1b[38;2;255;107;128;1m'

// S_DIM：必须以 \x1b[0m 开头，防止 dim 叠加在有色前景上造成颜色闪烁
export const S_DIM = '\x1b[0m\x1b[2m'

// ANSI 90（亮黑色），与 chalk 的 c.gray() 输出等价
export const S_GRAY_90 = '\x1b[0m\x1b[90m'

// S_NONE：默认样式（无前景色、无属性）
// 必须是非空转义，否则 cell-diff 循环在样式过渡时不发射重置字节，
// 导致终端 SGR 状态从前一个 cell 继承，引发颜色"渗漏"。
export const S_NONE = '\x1b[0m'
export const S_RESET = '\x1b[0m'

// 反色块 —— 用来"绘制"输入光标位置。
// 真实终端光标在整个 App 范围内保持隐藏（见组件挂载 effect），
// 这里的反色块是用户唯一可见的光标。
export const S_CURSOR = '\x1b[7m'

// DEC 2026 "Synchronized Update Mode"
// BSU / ESU_HIDE 之间的输出由支持的终端缓冲为单帧原子渲染，
// 消除 eraseRegion 擦除与重绘之间的闪烁。
export const BSU = '\x1b[?2026h'
export const ESU_HIDE = '\x1b[?2026l\x1b[?25l'
