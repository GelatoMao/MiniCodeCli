// @mini-code-cli/cli — useAgent Hook：React ↔ agentLoop 桥接
//
// Task 9：将 agentLoop 的异步逻辑与 React state 连接。
//
// 核心设计思路：
//   agentLoop 是一个长时异步函数，通过 callbacks 向外推送增量事件。
//   React 状态管理需要一个稳定的同步接口（submit / abort / resolvePermission）。
//   useAgent 扮演"适配层"：
//     1. 把 agentLoop callbacks 翻译为 setState 调用
//     2. 把 abort 翻译为 abortController.abort() + 解除挂起的 Promise
//     3. 把 resolvePermission / resolveQuestion 翻译为 Promise.resolve()
//
// AgentState 设计：
//   - messages：已提交到 scrollback 的展示消息列表（append-only）
//   - streamingText：当前正在流式输出的文字片段（未提交到 messages）
//   - activeToolCalls：正在执行的工具调用（Map: toolCallId → DisplayToolCall）
//   - isLoading：是否有 agentLoop 正在运行
//   - pendingPermission：等待用户确认的权限请求
//   - pendingQuestion：等待用户回答的问题
//   - tokenUsage：累计 token 使用量
//
// abort 流程：
//   1. flush streamingText → 写入 messages（保留已输出内容）
//   2. 推入"[Request interrupted by user]"消息
//   3. abortController.abort()
//   4. 解除所有挂起的 permission / question Promise（用 'no' / '' 默认值）
//
// permission 请求流程：
//   1. agentLoop callback onAskPermission 调用时，创建 Promise 并存储 resolve 函数
//   2. 设置 pendingPermission state → ChatInput 显示确认 UI
//   3. 用户点击后调用 resolvePermission(decision)，解除 Promise

import { useCallback, useRef, useState } from 'react'

import {
  agentLoop,
  createLoopState,
  type AgentCallbacks,
  type AgentOptions,
  type LanguageModel,
  type LoopState,
  type TokenUsage,
} from '@mini-code-cli/core'

import type { DisplayMessage, DisplayToolCall } from '../display-types.js'

// ── AgentState ────────────────────────────────────────────────────────────────

export interface AgentState {
  /** 已提交到 scrollback 的展示消息（append-only） */
  messages: DisplayMessage[]
  /** 当前流式文字片段（未最终提交，显示在 scrollback 最后） */
  streamingText: string
  /** 正在执行的工具调用（toolCallId → DisplayToolCall） */
  activeToolCalls: Map<string, DisplayToolCall>
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

  // 挂起的 Promise resolve 函数
  const permissionResolveRef = useRef<((v: 'yes' | 'always' | 'no') => void) | null>(null)
  const questionResolveRef = useRef<((v: string) => void) | null>(null)

  // ── submit ──────────────────────────────────────────────────────────────────

  const submit = useCallback((text: string) => {
    if (!text.trim()) return

    // 创建新的 AbortController
    const abortController = new AbortController()
    abortControllerRef.current = abortController

    // 将用户消息加入展示列表
    const userMessage: DisplayMessage = { role: 'user', content: text }

    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, userMessage],
      isLoading: true,
      streamingText: '',
      activeToolCalls: new Map(),
      lastError: null,
    }))

    // 构建 AgentOptions（注入 abortSignal）
    const options: AgentOptions = {
      ...optionsRef.current,
      abortSignal: abortController.signal,
    }

    // ── callbacks ────────────────────────────────────────────────────────────

    // 流式文字 delta
    const onTextDelta = (delta: string) => {
      setState((prev) => ({ ...prev, streamingText: prev.streamingText + delta }))
    }

    // 工具调用开始
    const onToolCall = (toolCallId: string, toolName: string, input: Record<string, unknown>) => {
      setState((prev) => {
        const next = new Map(prev.activeToolCalls)
        next.set(toolCallId, {
          toolCallId,
          toolName,
          input,
          status: 'running',
        })
        return { ...prev, activeToolCalls: next }
      })
    }

    // 工具执行进度（暂时忽略，Task 10+ 处理）
    const onToolProgress = (_toolCallId: string, _message: string) => {
      // Task 10 中可用来更新 progress 消息
    }

    // 工具调用完成
    const onToolResult = (toolCallId: string, result: string, isError?: boolean) => {
      setState((prev) => {
        const next = new Map(prev.activeToolCalls)
        const existing = next.get(toolCallId)
        if (existing) {
          // 工具完成 → 将其移入 messages 列表（作为独立的 assistant toolCalls 消息）
          const updatedTc: DisplayToolCall = {
            ...existing,
            status: isError ? 'error' : 'completed',
            output: result,
          }
          next.delete(toolCallId)

          // 将工具结果消息追加到 messages
          const toolMsg: DisplayMessage = {
            role: 'assistant',
            toolCalls: [updatedTc],
          }
          return {
            ...prev,
            activeToolCalls: next,
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

    // shell 输出（追加到最后一条工具调用的 output）
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

        // agentLoop 完成 — 提交剩余的 streamingText
        setState((prev) => {
          const finalMessages = [...prev.messages]

          // 提交剩余流式文字
          if (prev.streamingText) {
            finalMessages.push({
              role: 'assistant',
              content: prev.streamingText,
            })
          }

          // 提交所有尚未完成的 activeToolCalls（标记为 completed）
          const remainingCalls = [...prev.activeToolCalls.values()]
          for (const tc of remainingCalls) {
            finalMessages.push({
              role: 'assistant',
              toolCalls: [{ ...tc, status: 'completed' }],
            })
          }

          return {
            ...prev,
            messages: finalMessages,
            streamingText: '',
            activeToolCalls: new Map(),
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
        setState((prev) => ({
          ...prev,
          isLoading: false,
          streamingText: '',
          lastError: msg,
        }))
      })
  }, []) // 故意空依赖：callbacks 内部通过 ref 访问最新状态，不需要 re-create

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

    // 2. flush streamingText → messages，推入中断消息
    setState((prev) => {
      const newMessages = [...prev.messages]
      if (prev.streamingText) {
        newMessages.push({ role: 'assistant', content: prev.streamingText })
      }
      newMessages.push({
        role: 'assistant',
        content: '[Request interrupted by user]',
      })
      return {
        ...prev,
        messages: newMessages,
        streamingText: '',
        activeToolCalls: new Map(),
        isLoading: false,
        pendingPermission: null,
        pendingQuestion: null,
      }
    })

    // 3. 中断 agentLoop
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
  }, [])

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

  return {
    state,
    submit,
    abort,
    resolvePermission,
    resolveQuestion,
    switchModel,
  }
}
