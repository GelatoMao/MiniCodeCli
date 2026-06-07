// @mini-code-cli/cli — useAgent Hook：React ↔ agentLoop 桥接
//
// Task 9：将 agentLoop 的异步逻辑与 React state 连接。
// Task 10：集成 useStreamBuffer，降低 onTextDelta 触发的重渲染频率；
//          添加 activeToolName / toolStartTimeRef 以实现精确的 spinner 标签和 duration 记录。
//
// 核心设计思路：
//   agentLoop 是一个长时异步函数，通过 callbacks 向外推送增量事件。
//   React 状态管理需要一个稳定的同步接口（submit / abort / resolvePermission）。
//   useAgent 扮演"适配层"：
//     1. 把 agentLoop callbacks 翻译为 setState 调用（onToolCall/onToolResult 保持即时）
//     2. 把 onTextDelta 通过 useStreamBuffer 缓冲（50ms flush 一次），降低渲染频率
//     3. 把 abort 翻译为 abortController.abort() + 解除挂起的 Promise
//     4. 把 resolvePermission / resolveQuestion 翻译为 Promise.resolve()
//
// AgentState 设计：
//   - messages：已提交到 scrollback 的展示消息列表（append-only）
//   - streamingText：当前正在流式输出的文字片段（经 buffer flush 后的值，50ms 精度）
//   - activeToolCalls：正在执行的工具调用（Map: toolCallId → DisplayToolCall）
//   - activeToolName：当前正在运行的工具名（null = 无工具 → spinner 显示 "Thinking…"）
//   - isLoading：是否有 agentLoop 正在运行
//   - pendingPermission：等待用户确认的权限请求
//   - pendingQuestion：等待用户回答的问题
//   - tokenUsage：累计 token 使用量
//
// abort 流程：
//   1. commitStreamingText → 将缓冲中的文字写入 messages（保留已输出内容）
//   2. 推入"[Request interrupted by user]"消息
//   3. abortController.abort()
//   4. 解除所有挂起的 permission / question Promise（用 'no' / '' 默认值）
//
// spinner 状态切换（Task 10 新增）：
//   - 无工具运行时：App.tsx 显示 "Thinking…"
//   - readFile 运行时：显示 "Reading <path>…"
//   - writeFile/edit 运行时：显示 "Writing <path>…"
//   - shell 运行时：显示 "Running <command>…"
//   - 其他工具：显示 "Using <toolName>…"

import { useCallback, useRef, useState } from 'react'

import {
  agentLoop,
  type AgentCallbacks,
  type AgentOptions,
  type LanguageModel,
  type LoopState,
  type TokenUsage,
} from '@mini-code-cli/core'

import type { DisplayMessage, DisplayToolCall } from '../display-types.js'
import { useStreamBuffer } from './use-stream-buffer.js'

// ── AgentState ────────────────────────────────────────────────────────────────

export interface AgentState {
  /** 已提交到 scrollback 的展示消息（append-only） */
  messages: DisplayMessage[]
  /**
   * 当前流式文字片段（经 useStreamBuffer 50ms flush 后的值，未提交到 messages）。
   * App.tsx 用此字段在 scrollback 末尾追加实时预览行。
   */
  streamingText: string
  /** 正在执行的工具调用（toolCallId → DisplayToolCall） */
  activeToolCalls: Map<string, DisplayToolCall>
  /**
   * 当前正在运行的工具名（null = 无工具 / AI 正在思考）。
   * App.tsx 用此字段生成精确的 spinner 标签（"Thinking…" vs "Reading file…"）。
   */
  activeToolName: string | null
  /**
   * 当前正在运行的工具的输入参数（用于 spinner 标签中的路径/命令摘要）。
   */
  activeToolInput: Record<string, unknown> | null
  /** 是否有 agentLoop 正在运行 */
  isLoading: boolean
  /** 等待用户权限确认的请求（null = 无） */
  pendingPermission: PendingPermission | null
  /** 等待用户回答的问题（null = 无） */
  pendingQuestion: PendingQuestion | null
  /** 累计 token 使用量 */
  tokenUsage: TokenUsage
  /** 最后一条错误消息（用于在 spinner 区显示） */
  lastError: string | null
}

export interface PendingPermission {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

export interface PendingQuestion {
  question: string
  options: { label: string; description: string }[]
}

// ── useAgent return type ──────────────────────────────────────────────────────

export interface UseAgentReturn {
  state: AgentState
  /** 提交用户消息，启动 agentLoop */
  submit: (text: string) => void
  /** 中断当前 agentLoop */
  abort: () => void
  /** 解决挂起的权限请求 */
  resolvePermission: (decision: 'yes' | 'always' | 'no') => void
  /** 解决挂起的问题 */
  resolveQuestion: (answer: string) => void
  /** 切换当前使用的模型 */
  switchModel: (newModel: LanguageModel, newModelId: string) => void
}

// ── 初始状态工厂 ──────────────────────────────────────────────────────────────

const INITIAL_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  currentContextTokens: 0,
}

function createInitialState(): AgentState {
  return {
    messages: [],
    streamingText: '',
    activeToolCalls: new Map(),
    activeToolName: null,
    activeToolInput: null,
    isLoading: false,
    pendingPermission: null,
    pendingQuestion: null,
    tokenUsage: { ...INITIAL_TOKEN_USAGE },
    lastError: null,
  }
}

// ── useAgent ──────────────────────────────────────────────────────────────────

export function useAgent(
  initialModel: LanguageModel,
  initialOptions: AgentOptions,
): UseAgentReturn {
  const [state, setState] = useState<AgentState>(createInitialState)

  // 跨渲染稳定 ref
  const modelRef = useRef<LanguageModel>(initialModel)
  const optionsRef = useRef<AgentOptions>(initialOptions)
  const loopStateRef = useRef<LoopState | undefined>(undefined)
  const abortControllerRef = useRef<AbortController | null>(null)

  // 工具开始时间记录（toolCallId → Date.now()），用于计算 durationMs
  const toolStartTimeRef = useRef<Map<string, number>>(new Map())

  // 挂起的 Promise resolve 函数
  const permissionResolveRef = useRef<((v: 'yes' | 'always' | 'no') => void) | null>(null)
  const questionResolveRef = useRef<((v: string) => void) | null>(null)

  // ── useStreamBuffer：将 onTextDelta 缓冲，50ms flush 一次 ─────────────────────

  /**
   * 当流式片段提交为正式消息时，追加到 state.messages。
   * 这是 commitStreamingText 的 onCommit 回调。
   */
  const handleStreamCommit = useCallback((text: string) => {
    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, { role: 'assistant', content: text }],
    }))
  }, [])

  const { streamingText, bufferDelta, flushBuffer, commitStreamingText, hasStreamingText } =
    useStreamBuffer(handleStreamCommit)

  // ── submit ──────────────────────────────────────────────────────────────────

  const submit = useCallback((text: string) => {
    if (!text.trim()) return

    // 创建新的 AbortController
    const abortController = new AbortController()
    abortControllerRef.current = abortController

    // 清空工具计时记录
    toolStartTimeRef.current.clear()

    // 将用户消息加入展示列表
    const userMessage: DisplayMessage = { role: 'user', content: text }

    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, userMessage],
      isLoading: true,
      activeToolCalls: new Map(),
      activeToolName: null,
      activeToolInput: null,
      lastError: null,
    }))

    // 构建 AgentOptions（注入 abortSignal）
    const options: AgentOptions = {
      ...optionsRef.current,
      abortSignal: abortController.signal,
    }

    // ── callbacks ────────────────────────────────────────────────────────────

    // 流式文字 delta — 交给 useStreamBuffer 缓冲（不直接 setState）
    const onTextDelta = (delta: string) => {
      bufferDelta(delta)
    }

    // 工具调用开始
    const onToolCall = (toolCallId: string, toolName: string, input: Record<string, unknown>) => {
      // 记录开始时间（用于计算 duration）
      toolStartTimeRef.current.set(toolCallId, Date.now())

      // 工具调用开始前，flush 当前缓冲中的 streaming text，
      // 确保工具行显示在文字内容之后（而非之前）。
      flushBuffer()

      setState((prev) => {
        const next = new Map(prev.activeToolCalls)
        next.set(toolCallId, {
          toolCallId,
          toolName,
          input,
          status: 'running',
        })
        return {
          ...prev,
          activeToolCalls: next,
          activeToolName: toolName,
          activeToolInput: input,
        }
      })
    }

    // 工具执行进度（用于实时更新 shell 输出等）
    const onToolProgress = (_toolCallId: string, _message: string) => {
      // Task 10：暂不处理（shell 输出通过 onShellOutput 处理）
      // Task 15+ 可在此更新 spinner 标签为具体进度信息
    }

    // 工具调用完成
    const onToolResult = (toolCallId: string, result: string, isError?: boolean) => {
      const startTime = toolStartTimeRef.current.get(toolCallId)
      const durationMs = startTime !== undefined ? Date.now() - startTime : undefined
      toolStartTimeRef.current.delete(toolCallId)

      setState((prev) => {
        const next = new Map(prev.activeToolCalls)
        const existing = next.get(toolCallId)
        if (existing) {
          // 工具完成 → 将其移入 messages 列表（作为独立的 assistant toolCalls 消息）
          const updatedTc: DisplayToolCall = {
            ...existing,
            status: isError ? 'error' : 'completed',
            output: result,
            durationMs,
          }
          next.delete(toolCallId)

          // 计算新的 activeToolName（取下一个 running 工具，若无则 null）
          let nextActiveTool: string | null = null
          let nextActiveInput: Record<string, unknown> | null = null
          for (const tc of next.values()) {
            if (tc.status === 'running') {
              nextActiveTool = tc.toolName
              nextActiveInput = tc.input
              break
            }
          }

          // 将工具结果消息追加到 messages
          const toolMsg: DisplayMessage = {
            role: 'assistant',
            toolCalls: [updatedTc],
          }
          return {
            ...prev,
            activeToolCalls: next,
            activeToolName: nextActiveTool,
            activeToolInput: nextActiveInput,
            messages: [...prev.messages, toolMsg],
          }
        }
        return { ...prev, activeToolCalls: next }
      })
    }

    // 权限请求 — 返回 Promise，等待用户确认
    const onAskPermission = (toolCall: {
      toolCallId: string
      toolName: string
      input: Record<string, unknown>
    }): Promise<'yes' | 'always' | 'no'> => {
      return new Promise<'yes' | 'always' | 'no'>((resolve) => {
        permissionResolveRef.current = resolve
        setState((prev) => ({
          ...prev,
          pendingPermission: {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: toolCall.input,
          },
        }))
      })
    }

    // 问题请求 — 返回 Promise，等待用户回答
    const onAskUser = (
      question: string,
      options: { label: string; description: string }[],
    ): Promise<string> => {
      return new Promise<string>((resolve) => {
        questionResolveRef.current = resolve
        setState((prev) => ({
          ...prev,
          pendingQuestion: { question, options },
        }))
      })
    }

    // shell 输出（追加到最后一条 running shell 工具的 output）
    const onShellOutput = (chunk: string) => {
      setState((prev) => {
        const activeToolCalls = new Map(prev.activeToolCalls)
        // 找到最新的 running shell tool
        for (const [id, tc] of activeToolCalls) {
          if (tc.toolName === 'shell' && tc.status === 'running') {
            activeToolCalls.set(id, {
              ...tc,
              output: (tc.output ?? '') + chunk,
            })
            break
          }
        }
        return { ...prev, activeToolCalls }
      })
    }

    // token 使用量更新
    const onUsageUpdate = (usage: TokenUsage) => {
      setState((prev) => ({ ...prev, tokenUsage: { ...usage } }))
    }

    // 错误处理
    const onError = (error: Error) => {
      setState((prev) => ({
        ...prev,
        lastError: error.message,
        messages: [
          ...prev.messages,
          { role: 'assistant', content: `Error: ${error.message}` },
        ],
      }))
    }

    const callbacks: AgentCallbacks = {
      onTextDelta,
      onToolCall,
      onToolProgress,
      onToolResult,
      onAskPermission,
      onAskUser,
      onShellOutput,
      onUsageUpdate,
      onError,
    }

    // ── 启动 agentLoop ────────────────────────────────────────────────────────

    agentLoop(text, modelRef.current, options, callbacks, loopStateRef.current)
      .then(({ state: newLoopState }) => {
        loopStateRef.current = newLoopState

        // agentLoop 完成 — 提交 streamingText 缓冲中剩余的文字
        // commitStreamingText 会 flush buffer → onCommit → 追加到 messages
        commitStreamingText()

        // 提交所有尚未完成的 activeToolCalls（标记为 completed）
        setState((prev) => {
          const remainingCalls = [...prev.activeToolCalls.values()]
          if (remainingCalls.length === 0) {
            return {
              ...prev,
              activeToolCalls: new Map(),
              activeToolName: null,
              activeToolInput: null,
              isLoading: false,
              pendingPermission: null,
              pendingQuestion: null,
            }
          }

          const toolMsgs: DisplayMessage[] = remainingCalls.map((tc) => ({
            role: 'assistant' as const,
            toolCalls: [{ ...tc, status: 'completed' as const }],
          }))

          return {
            ...prev,
            messages: [...prev.messages, ...toolMsgs],
            activeToolCalls: new Map(),
            activeToolName: null,
            activeToolInput: null,
            isLoading: false,
            pendingPermission: null,
            pendingQuestion: null,
          }
        })
      })
      .catch((err: unknown) => {
        // agentLoop 本身不应 throw（所有错误通过 onError 上报），
        // 但用 catch 做兜底，避免 unhandledRejection。
        const msg = err instanceof Error ? err.message : String(err)
        commitStreamingText({ force: false })
        setState((prev) => ({
          ...prev,
          isLoading: false,
          activeToolName: null,
          activeToolInput: null,
          lastError: msg,
        }))
      })
  }, [bufferDelta, flushBuffer, commitStreamingText]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── abort ───────────────────────────────────────────────────────────────────

  const abort = useCallback(() => {
    // 1. 解除挂起的 permission / question Promise（用默认拒绝值）
    if (permissionResolveRef.current) {
      permissionResolveRef.current('no')
      permissionResolveRef.current = null
    }
    if (questionResolveRef.current) {
      questionResolveRef.current('')
      questionResolveRef.current = null
    }

    // 2. flush streamingText buffer → commit 到 messages，推入中断消息
    if (hasStreamingText()) {
      commitStreamingText()
    }

    setState((prev) => {
      const newMessages = [...prev.messages]
      // commitStreamingText() 已同步追加消息到 messages，
      // 此处无需重复检查 prev.streamingText（streamingText 由 useStreamBuffer 管理）
      newMessages.push({
        role: 'assistant',
        content: '[Request interrupted by user]',
      })
      return {
        ...prev,
        messages: newMessages,
        activeToolCalls: new Map(),
        activeToolName: null,
        activeToolInput: null,
        isLoading: false,
        pendingPermission: null,
        pendingQuestion: null,
      }
    })

    // 3. 中断 agentLoop
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
  }, [hasStreamingText, commitStreamingText])

  // ── resolvePermission ────────────────────────────────────────────────────────

  const resolvePermission = useCallback((decision: 'yes' | 'always' | 'no') => {
    // 用 queueMicrotask 确保 React state 更新先 flush，再解除 Promise
    // 防止 Promise 解除后 agentLoop 继续执行，但 React 还未重渲染导致 UI 抖动
    const resolve = permissionResolveRef.current
    permissionResolveRef.current = null
    setState((prev) => ({ ...prev, pendingPermission: null }))
    if (resolve) {
      queueMicrotask(() => resolve(decision))
    }
  }, [])

  // ── resolveQuestion ──────────────────────────────────────────────────────────

  const resolveQuestion = useCallback((answer: string) => {
    const resolve = questionResolveRef.current
    questionResolveRef.current = null
    setState((prev) => ({ ...prev, pendingQuestion: null }))
    if (resolve) {
      queueMicrotask(() => resolve(answer))
    }
  }, [])

  // ── switchModel ──────────────────────────────────────────────────────────────

  const switchModel = useCallback((newModel: LanguageModel, newModelId: string) => {
    modelRef.current = newModel
    optionsRef.current = { ...optionsRef.current, modelId: newModelId }
  }, [])

  // ── 将 useStreamBuffer 的 streamingText 同步到 AgentState ─────────────────────
  // 注意：streamingText 来自 useStreamBuffer（独立 useState），
  // 我们将其直接暴露在返回的 state 对象中，而不放入 AgentState 的 useState。
  // 这样避免两个 setState 的双重渲染。

  const stateWithStreaming: AgentState = {
    ...state,
    streamingText,
  }

  return {
    state: stateWithStreaming,
    submit,
    abort,
    resolvePermission,
    resolveQuestion,
    switchModel,
  }
}
