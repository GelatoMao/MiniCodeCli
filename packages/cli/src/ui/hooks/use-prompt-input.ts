// @mini-code-cli/cli — 自定义 stdin 输入 Hook（带括号粘贴支持）
//
// 两层粘贴检测策略：
//
//   1. **括号粘贴模式**（主路径，快速）
//      挂载时发送 `\x1b[?2004h`。支持的终端会用
//      `\x1b[200~ … \x1b[201~` 包裹每次粘贴内容。
//      状态机检测这些标记并将载荷作为单次 `onPaste` 调用发出，
//      无论 Node 如何分块 stdin 字节。
//
//   2. **防抖回退**（用于 Windows Terminal / PowerShell / tmux /
//      VS Code 集成终端等不处理括号粘贴的环境）
//      未检测到粘贴标记时，可打印文字被缓冲到 buffer，
//      每次 stdin 事件后重置短计时器（PASTE_DEBOUNCE_MS）。
//      人工输入键击间隔 >100ms，每个字符自行刷新；
//      粘贴爆发以亚毫秒间隔到达，buffer 在一个 tick 内填满，
//      作为单个原子块刷新后路由到 `onPaste`。
//
// Task 8 — 直接采用 x-code-cli 原实现。
import { useEffect, useRef } from 'react'

import { useStdin } from 'ink'

const ENABLE_BRACKETED_PASTE = '\x1b[?2004h'
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

// 批量快速 stdin 爆发的时间窗口。30ms 远低于人工输入节奏（~100-200ms），
// 但远高于粘贴字符间的亚毫秒间隔，可清晰区分两者。
const PASTE_DEBOUNCE_MS = 30

// 单次按键在防抖 buffer 中最长停留时间上限 —— 防止按住某键时
// OS 重复事件不断重置计时器导致内容永远不刷新的问题。
const MAX_BATCH_MS = 50

// >= 此大小（或含换行符）的 stdin 块被怀疑为粘贴内容，进入防抖 buffer。
// 低于此大小的块视为正常键入，直接发送（无延迟）。
const PASTE_SIZE_THRESHOLD = 32

export type PromptKey =
  | 'return'
  | 'newline'
  | 'backspace'
  | 'delete'
  | 'tab'
  | 'escape'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'

export interface PromptInputHandlers {
  /** 正常键入的文字（若终端合并了爆发可能是多字符） */
  onText: (text: string) => void
  /** 原子粘贴 —— 始终是一次粘贴事件的完整内容 */
  onPaste: (content: string) => void
  /** 特殊键 */
  onKey: (key: PromptKey) => void
  /** Ctrl+C 时调用 —— 应通过 useApp().exit() 触发 Ink 清洁卸载 */
  onInterrupt: () => void
  /** 打开/关闭监听器（不卸载组件） */
  enabled: boolean
}

export function usePromptInput({ onText, onPaste, onKey, onInterrupt, enabled }: PromptInputHandlers): void {
  const { stdin, setRawMode } = useStdin()

  // 将 handler 存入 ref，避免 effect 在每次渲染时重新订阅——
  // 每次渲染都会产生新的闭包，但我们需要一个稳定订阅，始终调用最新 handler。
  const handlersRef = useRef({ onText, onPaste, onKey, onInterrupt })
  useEffect(() => {
    handlersRef.current = { onText, onPaste, onKey, onInterrupt }
  })

  // 括号粘贴状态持久化跨 stdin 块，以便拼接跨多个 data 事件到达的粘贴内容。
  const pasteStateRef = useRef<{ inPaste: boolean; buffer: string; timer: NodeJS.Timeout | null }>({
    inPaste: false,
    buffer: '',
    timer: null,
  })

  // 回退路径的防抖 buffer + 计时器
  const pendingTextRef = useRef<string>('')
  const pendingTimerRef = useRef<NodeJS.Timeout | null>(null)
  /** 当前爆发开始的挂钟时间（ms）。0 表示无爆发进行中。
   *  用于将防抖延迟上限设为 MAX_BATCH_MS，防止持续按键不断重置计时器。 */
  const pendingBurstStartRef = useRef<number>(0)

  // Ctrl+C 即使在输入禁用时也必须有效（如加载中）。
  // 始终监听 stdin 的 \x03 并路由到 onInterrupt。
  // enabled=false 时忽略所有其他输入。
  useEffect(() => {
    if (!enabled) {
      setRawMode(true)
      const handleCtrlC = (data: Buffer | string): void => {
        const chunk = typeof data === 'string' ? data : data.toString('utf8')
        if (chunk.includes('\x03')) {
          handlersRef.current.onInterrupt()
        }
      }
      stdin.on('data', handleCtrlC)
      return () => {
        stdin.off('data', handleCtrlC)
        setRawMode(false)
      }
    }

    setRawMode(true)
    process.stdout.write(ENABLE_BRACKETED_PASTE)

    // ── 刷新防抖 buffer ──
    const flushPending = (): void => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
      pendingBurstStartRef.current = 0
      const raw = pendingTextRef.current
      if (!raw) return
      pendingTextRef.current = ''
      const text = raw.replace(/\r\n?/g, '\n')

      const looksLikePaste = text.length >= PASTE_SIZE_THRESHOLD || text.includes('\n')
      if (looksLikePaste) {
        handlersRef.current.onPaste(text)
      } else {
        handlersRef.current.onText(text)
      }
    }

    // 计算下次计时器延迟（防抖+上限）
    const armFlushTimer = (): void => {
      if (pendingBurstStartRef.current === 0) {
        pendingBurstStartRef.current = Date.now()
      }
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
      const elapsed = Date.now() - pendingBurstStartRef.current
      const remaining = Math.max(0, MAX_BATCH_MS - elapsed)
      const delay = Math.min(PASTE_DEBOUNCE_MS, remaining)
      pendingTimerRef.current = setTimeout(flushPending, delay)
    }

    const queueText = (data: string): void => {
      pendingTextRef.current += data
      armFlushTimer()
    }

    // 分发特殊键，始终先刷新 pending 文字
    const dispatchKey = (key: PromptKey): void => {
      flushPending()
      handlersRef.current.onKey(key)
    }

    // 解析非粘贴输入
    const processNormalInput = (data: string): void => {
      if (data.length === 0) return

      if (data === '\r' || data === '\n') return dispatchKey('return')
      if (data === '\x7f' || data === '\b') {
        if (pendingTextRef.current.length > 0) {
          pendingTextRef.current = pendingTextRef.current.slice(0, -1)
          return
        }
        dispatchKey('backspace')
        return
      }
      if (data === '\t') return dispatchKey('tab')

      // Alt+Enter / Ctrl+Enter → 插入字面换行符
      if (data === '\x1b\r' || data === '\x1b\n') return dispatchKey('newline')
      if (data === '\x1b[27;3;13~' || data === '\x1b[27;5;13~') return dispatchKey('newline')
      if (data === '\x1b[13;3u' || data === '\x1b[13;5u') return dispatchKey('newline')

      if (data === '\x1b' || data === '\x1b\x1b') return dispatchKey('escape')

      // Ctrl+C
      if (data === '\x03') {
        flushPending()
        handlersRef.current.onInterrupt()
        return
      }

      // ANSI 方向键和导航键
      if (data === '\x1b[A') return dispatchKey('up')
      if (data === '\x1b[B') return dispatchKey('down')
      if (data === '\x1b[C') return dispatchKey('right')
      if (data === '\x1b[D') return dispatchKey('left')
      if (data === '\x1b[H' || data === '\x1b[1~') return dispatchKey('home')
      if (data === '\x1b[F' || data === '\x1b[4~') return dispatchKey('end')
      if (data === '\x1b[3~') return dispatchKey('delete')
      if (data === '\x1b[5~') return dispatchKey('pageup')
      if (data === '\x1b[6~') return dispatchKey('pagedown')

      // 未知转义序列 —— 丢弃，防止显示为字面 "\x1b[…" 文字
      if (data.startsWith('\x1b')) return

      // 可打印文字：大块/多行进入防抖 buffer，小块直接发送
      if (data.length >= PASTE_SIZE_THRESHOLD || data.includes('\n')) {
        queueText(data)
      } else {
        flushPending()
        handlersRef.current.onText(data)
      }
    }

    // 顶层 stdin 数据处理器：扫描括号粘贴标记
    const handleData = (data: Buffer | string): void => {
      let chunk = typeof data === 'string' ? data : data.toString('utf8')

      while (chunk.length > 0) {
        const state = pasteStateRef.current

        if (state.inPaste) {
          const endIdx = chunk.indexOf(PASTE_END)
          if (endIdx === -1) {
            state.buffer += chunk
            return
          }
          state.buffer += chunk.slice(0, endIdx)
          if (state.timer) {
            clearTimeout(state.timer)
            state.timer = null
          }
          const content = state.buffer.replace(/\r\n?/g, '\n')
          state.buffer = ''
          state.inPaste = false
          flushPending()
          handlersRef.current.onPaste(content)
          chunk = chunk.slice(endIdx + PASTE_END.length)
          continue
        }

        const startIdx = chunk.indexOf(PASTE_START)
        if (startIdx === -1) {
          processNormalInput(chunk)
          return
        }
        if (startIdx > 0) {
          processNormalInput(chunk.slice(0, startIdx))
        }
        flushPending()
        chunk = chunk.slice(startIdx + PASTE_START.length)
        state.inPaste = true
        // 安全超时：如果 PASTE_END 永远不到达（ConHost 缺陷），1 秒后强制刷新
        state.timer = setTimeout(() => {
          const s = pasteStateRef.current
          if (!s.inPaste) return
          const content = s.buffer.replace(/\r\n?/g, '\n')
          s.buffer = ''
          s.inPaste = false
          s.timer = null
          if (content) {
            handlersRef.current.onPaste(content)
          }
        }, 1000)
      }
    }

    stdin.on('data', handleData)
    return () => {
      flushPending()
      const ps = pasteStateRef.current
      if (ps.timer) {
        clearTimeout(ps.timer)
        ps.timer = null
      }
      ps.inPaste = false
      ps.buffer = ''
      stdin.off('data', handleData)
      process.stdout.write(DISABLE_BRACKETED_PASTE)
      setRawMode(false)
    }
  }, [enabled, stdin, setRawMode])
}
