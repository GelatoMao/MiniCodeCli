// @mini-code-cli/cli — 流式文字 delta 缓冲 Hook
//
// 问题背景：
//   agentLoop 通过 onTextDelta 每次推送少量文字（几个字符），
//   如果每个 delta 都直接 setState，React 会触发极高频率的重渲染（每秒可达数十次），
//   导致 CPU 飙高和终端输出抖动。
//
// 解决方案：delta 缓冲 + 定时 flush
//   1. onTextDelta 将 delta 追加到 ref（不触发 setState）
//   2. setInterval（每 FLUSH_INTERVAL_MS）批量将缓冲区内容 flush 到 React state
//   3. agentLoop 结束时立即 flush 剩余内容（防止遗漏最后的文字片段）
//
// 典型使用场景：
//   const { bufferDelta, flushBuffer, streamingText } = useStreamBuffer(appendMessage)
//   // onTextDelta callback：
//   bufferDelta(delta)
//   // agentLoop 完成时：
//   flushBuffer()
//
// Task 10 — 实现流式渲染缓冲层。

import { useCallback, useEffect, useRef, useState } from 'react'

// ── 常量 ──────────────────────────────────────────────────────────────────────

/**
 * flush 间隔（毫秒）。
 * 50ms ≈ 20fps，人眼感知流畅（< 100ms），同时限制 setState 频率。
 * 比 requestAnimationFrame（16ms）更保守，避免 TTY 渲染开销。
 */
const FLUSH_INTERVAL_MS = 50

// ── 接口 ──────────────────────────────────────────────────────────────────────

export interface UseStreamBufferReturn {
  /**
   * 当前缓冲中尚未 flush 的流式文字（实时更新，用于 spinner 旁的预览）。
   * 这里直接暴露 `streamingText` state，调用方可用它做"正在输出…"的状态展示。
   */
  streamingText: string

  /**
   * 将文字 delta 追加到内部缓冲区（不触发 React setState）。
   * 高频调用安全：只是 string 拼接，无 React 开销。
   */
  bufferDelta: (delta: string) => void

  /**
   * 立即将缓冲区内容 flush 到 streamingText state。
   * 适用于：agentLoop 完成、用户 abort 等需要立刻显示的时机。
   */
  flushBuffer: () => void

  /**
   * 将当前 streamingText 提交为一条正式消息，并清空缓冲区。
   * 调用方负责在 agentLoop 轮次结束后调用，将流式片段转化为 scrollback 消息。
   *
   * @param options.force 若为 true，即使 streamingText 为空也执行（用于清场）
   */
  commitStreamingText: (options?: { force?: boolean }) => void

  /**
   * 当前 streamingText 是否非空（快速判断，避免读取 state）。
   */
  hasStreamingText: () => boolean
}

// ── useStreamBuffer ───────────────────────────────────────────────────────────

/**
 * 流式文字 delta 缓冲 Hook。
 *
 * @param onCommit 当一段流式文字提交为正式消息时的回调（参数：最终文字内容）
 */
export function useStreamBuffer(
  onCommit: (text: string) => void,
): UseStreamBufferReturn {
  // 内部缓冲区（ref，不触发重渲染）
  const bufferRef = useRef<string>('')

  // 暴露给外部的流式文字 state（每 FLUSH_INTERVAL_MS flush 一次）
  const [streamingText, setStreamingText] = useState<string>('')

  // streamingText 的镜像 ref（供 hasStreamingText 同步读取，避免 stale closure）
  const streamingTextRef = useRef<string>('')

  // onCommit 稳定 ref（避免 effect 依赖变化）
  const onCommitRef = useRef(onCommit)
  useEffect(() => {
    onCommitRef.current = onCommit
  })

  // ── 定时 flush ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const timer = setInterval(() => {
      const buf = bufferRef.current
      if (!buf) return
      bufferRef.current = ''
      setStreamingText((prev) => {
        const next = prev + buf
        streamingTextRef.current = next
        return next
      })
    }, FLUSH_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [])

  // ── API ─────────────────────────────────────────────────────────────────────

  const bufferDelta = useCallback((delta: string) => {
    bufferRef.current += delta
  }, [])

  const flushBuffer = useCallback(() => {
    const buf = bufferRef.current
    if (!buf) return
    bufferRef.current = ''
    setStreamingText((prev) => {
      const next = prev + buf
      streamingTextRef.current = next
      return next
    })
  }, [])

  const commitStreamingText = useCallback((options?: { force?: boolean }) => {
    // 先 flush 缓冲区中的残余 delta
    const buf = bufferRef.current
    bufferRef.current = ''

    // 同步读取当前 streamingText，再清空
    const prev = streamingTextRef.current
    const finalText = prev + buf
    streamingTextRef.current = ''
    setStreamingText('')

    // 同步调用 onCommit（不用 queueMicrotask，避免与外部 setState 竞争）
    if (finalText || options?.force) {
      if (finalText) {
        onCommitRef.current(finalText)
      }
    }
  }, [])

  const hasStreamingText = useCallback(() => {
    return streamingTextRef.current.length > 0 || bufferRef.current.length > 0
  }, [])

  return {
    streamingText,
    bufferDelta,
    flushBuffer,
    commitStreamingText,
    hasStreamingText,
  }
}
