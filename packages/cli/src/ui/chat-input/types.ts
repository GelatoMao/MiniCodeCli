// @mini-code-cli/cli — ChatInput 内部类型定义
//
// Task 8：cell buffer 渲染所需的公共 + 内部类型。
// 原项目 x-code-cli/packages/cli/src/ui/components/chat-input/types.ts

/** 斜杠命令菜单项（顶级命令行和子命令行共用此结构）。 */
export interface MenuItem {
  name: string
  description: string
  applyText: string
  /** 可选参数提示，如 `[on|off]`，仅用于顶级命令行 */
  argumentHint?: string
}

/** 注册到 ChatInput 的斜杠命令定义 */
export interface SlashCommand {
  name: string
  description: string
  /** 参数提示，例如 `[on|off]` */
  argumentHint?: string
  /** 固定子命令列表，用于二级菜单 */
  subcommands?: ReadonlyArray<{ name: string; description: string }>
}

/** Spinner 状态 */
export interface SpinnerState {
  label: string
  mode: 'requesting' | 'responding' | 'thinking' | 'tool-use'
}

/** 权限请求对话框数据 */
export interface PermissionRequest {
  toolName: string
  input: Record<string, unknown>
  onResolve: (decision: 'yes' | 'always' | 'no') => void
}

/** 选项选择对话框数据 */
export interface SelectRequest {
  question: string
  options: { label: string; description: string; freeform?: boolean }[]
  onResolve: (answer: string) => void
  dismissible?: boolean
  layout?: 'compact' | 'compact-vertical'
}
