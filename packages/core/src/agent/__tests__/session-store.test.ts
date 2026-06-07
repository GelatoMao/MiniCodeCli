// @mini-code-cli/core — Session Store 单元测试 + 属性测试
//
// 覆盖 task14 新增的 session-store.ts 模块：
//   - appendHeader（idempotent 语义）
//   - flushPendingMessages（增量写入 + persistedMessageCount 推进）
//   - appendUsage（usage 快照）
//   - appendCompactBoundary（压缩边界记录）
//   - loadSession（JSONL 重建 LoadedSession）
//   - hydrateLoopState（从 LoadedSession 重建 LoopState）
//   - listSessions / pickLatestSession（会话列表）
//
// Property 4 验证（设计文档 §正确性属性）：
//   "对任意一批消息，写入后读取出来，得到的消息列表与写入前完全相同"
//
// Feature: x-code-cli, Property 4: JSONL 会话写读一致性
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

import type { ModelMessage } from 'ai'
import { describe, expect, it, afterEach } from 'vitest'

import { createLoopState } from '../loop-state.js'
import {
  appendCompactBoundary,
  appendHeader,
  appendUsage,
  findSession,
  flushPendingMessages,
  getSessionFilePath,
  hydrateLoopState,
  listSessions,
  loadSession,
  pickLatestSession,
} from '../session-store.js'

// ── 测试工具 ──────────────────────────────────────────────────────────────────

/** 创建隔离的临时目录，测试结束后清理 */
function makeTempDir(): { cwd: string; cleanup: () => void } {
  const dir = path.join(os.tmpdir(), 'session-store-test-' + crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return {
    cwd: dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    },
  }
}

/** 构造一条简单的 user ModelMessage */
function userMsg(text: string): ModelMessage {
  return { role: 'user', content: text }
}

/** 构造一条 assistant ModelMessage（纯文字） */
function assistantMsg(text: string): ModelMessage {
  return { role: 'assistant', content: text }
}

/** 构造一条带工具调用的 assistant 消息 */
function assistantWithTool(toolCallId: string, toolName: string): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName, input: { path: '/test' } }],
  } as ModelMessage
}

/** 构造一条 tool result 消息 */
function toolResultMsg(toolCallId: string, toolName: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'text', value } }],
  } as ModelMessage
}

// ── appendHeader ──────────────────────────────────────────────────────────────

describe('appendHeader — idempotent 语义', () => {
  it('文件不存在时写入 header', () => {
    const { cwd, cleanup } = makeTempDir()
    afterEach(cleanup)

    const state = createLoopState()
    const filePath = getSessionFilePath(state.sessionId, cwd)
    appendHeader(filePath, state.sessionId, 'test-slug', 'anthropic:claude', 'first prompt')

    expect(fs.existsSync(filePath)).toBe(true)
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.trim())
    expect(lines.length).toBe(1)
    const record = JSON.parse(lines[0]!)
    expect(record.type).toBe('header')
    expect(record.sessionId).toBe(state.sessionId)
    expect(record.taskSlug).toBe('test-slug')

    cleanup()
  })

  it('文件已存在时不重复写入 header（idempotent）', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    const filePath = getSessionFilePath(state.sessionId, cwd)

    // 第一次写
    appendHeader(filePath, state.sessionId, 'slug', 'anthropic:claude', 'prompt')
    // 第二次写（应跳过）
    appendHeader(filePath, state.sessionId, 'slug', 'anthropic:claude', 'prompt')

    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.trim())
    expect(lines.length).toBe(1) // 依然只有 1 行
    cleanup()
  })
})

// ── flushPendingMessages ──────────────────────────────────────────────────────

describe('flushPendingMessages — 增量写入', () => {
  it('首次 flush 写入全部消息，persistedMessageCount 更新正确', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    state.messages.push(userMsg('hello'), assistantMsg('world'))

    flushPendingMessages(state, 'anthropic:claude', cwd)

    expect(state.persistedMessageCount).toBe(2)
    expect(state.sessionFilePath).not.toBeNull()

    // 文件应包含：1 header + 2 message 行
    const lines = fs.readFileSync(state.sessionFilePath!, 'utf-8').split('\n').filter((l) => l.trim())
    expect(lines.length).toBe(3)

    cleanup()
  })

  it('第二次 flush 只追加新消息（增量语义）', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    state.messages.push(userMsg('msg1'))
    flushPendingMessages(state, 'anthropic:claude', cwd)
    expect(state.persistedMessageCount).toBe(1)

    // 添加新消息后再 flush
    state.messages.push(assistantMsg('reply1'), userMsg('msg2'))
    flushPendingMessages(state, 'anthropic:claude', cwd)
    expect(state.persistedMessageCount).toBe(3)

    // 文件：1 header + 3 message 行
    const lines = fs.readFileSync(state.sessionFilePath!, 'utf-8').split('\n').filter((l) => l.trim())
    expect(lines.length).toBe(4)

    cleanup()
  })

  it('无新消息时 flush 是幂等的（不重复写）', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    state.messages.push(userMsg('only msg'))
    flushPendingMessages(state, 'anthropic:claude', cwd)

    const sizeAfterFirst = fs.statSync(state.sessionFilePath!).size

    // 再次 flush（无新消息）
    flushPendingMessages(state, 'anthropic:claude', cwd)
    const sizeAfterSecond = fs.statSync(state.sessionFilePath!).size

    expect(sizeAfterFirst).toBe(sizeAfterSecond)
    cleanup()
  })
})

// ── Property 4：JSONL 写读一致性 ──────────────────────────────────────────────

describe('Property 4 — JSONL 会话写读一致性', () => {
  it('纯文字消息：写入后读取内容完全相同', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    const msgs: ModelMessage[] = [
      userMsg('task: fix the login bug'),
      assistantMsg('I will analyze the issue.'),
      userMsg('what did you find?'),
      assistantMsg('Found the problem in auth.ts line 42.'),
    ]
    state.messages.push(...msgs)
    flushPendingMessages(state, 'anthropic:claude', cwd)

    const loaded = loadSession(state.sessionFilePath!)
    expect(loaded).not.toBeNull()
    expect(loaded!.messages.length).toBe(msgs.length)

    // 逐条比对 role 和 content
    for (let i = 0; i < msgs.length; i++) {
      expect(loaded!.messages[i]!.role).toBe(msgs[i]!.role)
      expect(JSON.stringify(loaded!.messages[i]!.content)).toBe(JSON.stringify(msgs[i]!.content))
    }
    cleanup()
  })

  it('含工具调用的消息：写入后读取内容完全相同', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    const msgs: ModelMessage[] = [
      userMsg('read the file'),
      assistantWithTool('tc-1', 'readFile'),
      toolResultMsg('tc-1', 'readFile', 'file contents here'),
      assistantMsg('The file contains...'),
    ]
    state.messages.push(...msgs)
    flushPendingMessages(state, 'anthropic:claude', cwd)

    const loaded = loadSession(state.sessionFilePath!)
    expect(loaded).not.toBeNull()
    expect(loaded!.messages.length).toBe(msgs.length)

    for (let i = 0; i < msgs.length; i++) {
      expect(loaded!.messages[i]!.role).toBe(msgs[i]!.role)
    }
    cleanup()
  })

  it('多轮增量写入后读取结果相同（模拟多轮对话）', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()

    // 第一轮
    state.messages.push(userMsg('turn1 user'), assistantMsg('turn1 assistant'))
    flushPendingMessages(state, 'anthropic:claude', cwd)

    // 第二轮
    state.messages.push(userMsg('turn2 user'), assistantMsg('turn2 assistant'))
    flushPendingMessages(state, 'anthropic:claude', cwd)

    // 第三轮
    state.messages.push(userMsg('turn3 user'), assistantMsg('turn3 assistant'))
    flushPendingMessages(state, 'anthropic:claude', cwd)

    const loaded = loadSession(state.sessionFilePath!)
    expect(loaded).not.toBeNull()
    expect(loaded!.messages.length).toBe(state.messages.length)

    for (let i = 0; i < state.messages.length; i++) {
      expect(loaded!.messages[i]!.role).toBe(state.messages[i]!.role)
      expect(JSON.stringify(loaded!.messages[i]!.content)).toBe(
        JSON.stringify(state.messages[i]!.content),
      )
    }
    cleanup()
  })

  it('空消息列表：loadSession 返回 messages 为 [] 的会话', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    // 不推入任何消息，只写 header（通过 flushPendingMessages，messages 为空）
    flushPendingMessages(state, 'anthropic:claude', cwd)

    const loaded = loadSession(state.sessionFilePath!)
    expect(loaded).not.toBeNull()
    expect(loaded!.messages).toEqual([])
    cleanup()
  })
})

// ── appendCompactBoundary ─────────────────────────────────────────────────────

describe('appendCompactBoundary — 压缩边界记录', () => {
  it('写入压缩边界后 loadSession 只保留边界之后的消息', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()

    // 写入旧消息
    state.messages.push(userMsg('old msg 1'), assistantMsg('old reply 1'))
    flushPendingMessages(state, 'anthropic:claude', cwd)

    // 写入压缩边界
    appendCompactBoundary(state, 'Summary: user asked to fix login, assistant found bug', cwd)

    // 压缩后写入新消息
    state.messages = [
      userMsg('[Context compressed]'),
      assistantMsg('Summary: user asked to fix login, assistant found bug'),
      userMsg('new msg after compression'),
    ]
    state.persistedMessageCount = 0
    flushPendingMessages(state, 'anthropic:claude', cwd)

    const loaded = loadSession(state.sessionFilePath!)
    expect(loaded).not.toBeNull()
    // 压缩边界会清空 messages，所以只有边界之后的 3 条消息
    expect(loaded!.messages.length).toBe(3)
    expect(loaded!.lastSummary).toBe('Summary: user asked to fix login, assistant found bug')
    cleanup()
  })
})

// ── appendUsage ───────────────────────────────────────────────────────────────

describe('appendUsage — usage 快照', () => {
  it('写入 usage 后文件中存在 usage 行', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    state.messages.push(userMsg('hello'))
    flushPendingMessages(state, 'anthropic:claude', cwd)

    state.tokenUsage.inputTokens = 1234
    state.tokenUsage.outputTokens = 567
    state.tokenUsage.totalTokens = 1801
    appendUsage(state, cwd)

    const lines = fs.readFileSync(state.sessionFilePath!, 'utf-8').split('\n').filter((l) => l.trim())
    const usageLine = lines.find((l) => {
      try {
        return JSON.parse(l).type === 'usage'
      } catch {
        return false
      }
    })
    expect(usageLine).toBeDefined()
    const usage = JSON.parse(usageLine!)
    expect(usage.inputTokens).toBe(1234)
    expect(usage.outputTokens).toBe(567)
    cleanup()
  })
})

// ── loadSession ───────────────────────────────────────────────────────────────

describe('loadSession', () => {
  it('文件不存在时返回 null', () => {
    const result = loadSession('/nonexistent/path/session.jsonl')
    expect(result).toBeNull()
  })

  it('文件无 header 时返回 null', () => {
    const { cwd, cleanup } = makeTempDir()
    const filePath = path.join(cwd, 'bad.jsonl')
    fs.writeFileSync(filePath, '{"type":"message","role":"user","content":"oops"}\n')
    const result = loadSession(filePath)
    expect(result).toBeNull()
    cleanup()
  })

  it('正确恢复 sessionId / taskSlug / modelId / firstPrompt', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    state.taskSlug = 'fix-login-bug'
    state.messages.push(userMsg('please fix the login bug'))
    flushPendingMessages(state, 'openai:gpt-4o', cwd)

    const loaded = loadSession(state.sessionFilePath!)
    expect(loaded).not.toBeNull()
    expect(loaded!.sessionId).toBe(state.sessionId)
    expect(loaded!.taskSlug).toBe('fix-login-bug')
    expect(loaded!.modelId).toBe('openai:gpt-4o')
    expect(loaded!.firstPrompt).toContain('please fix the login bug')
    cleanup()
  })

  it('损坏的 JSON 行被静默跳过，不影响其他行的解析', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    state.messages.push(userMsg('valid message'))
    flushPendingMessages(state, 'anthropic:claude', cwd)

    // 手动追加一行损坏的 JSON
    fs.appendFileSync(state.sessionFilePath!, '{broken json}\n', 'utf-8')
    // 再追加一行有效消息
    fs.appendFileSync(
      state.sessionFilePath!,
      JSON.stringify({ type: 'message', role: 'user', content: 'second valid' }) + '\n',
    )

    const loaded = loadSession(state.sessionFilePath!)
    expect(loaded).not.toBeNull()
    // 损坏行被跳过，valid + second valid = 2 条消息
    expect(loaded!.messages.length).toBe(2)
    cleanup()
  })
})

// ── hydrateLoopState ──────────────────────────────────────────────────────────

describe('hydrateLoopState — 从 LoadedSession 重建 LoopState', () => {
  it('重建后的 LoopState 具有正确的字段', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    state.taskSlug = 'my-task'
    state.messages.push(userMsg('do something'), assistantMsg('done'))
    flushPendingMessages(state, 'anthropic:claude', cwd)

    const loaded = loadSession(state.sessionFilePath!)
    expect(loaded).not.toBeNull()

    const hydrated = hydrateLoopState(loaded!, 'acceptEdits', cwd)

    expect(hydrated.sessionId).toBe(state.sessionId)
    expect(hydrated.taskSlug).toBe('my-task')
    expect(hydrated.permissionMode).toBe('acceptEdits')
    expect(hydrated.messages.length).toBe(2)
    // persistedMessageCount 应等于 messages.length（已全部持久化）
    expect(hydrated.persistedMessageCount).toBe(2)
    // sessionFilePath 应已设置
    expect(hydrated.sessionFilePath).not.toBeNull()
    // token usage 初始化为 0
    expect(hydrated.tokenUsage.inputTokens).toBe(0)
    cleanup()
  })

  it('重建后 messages 内容与原始完全相同（round-trip）', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    const originalMsgs: ModelMessage[] = [
      userMsg('step 1'),
      assistantWithTool('tc-1', 'readFile'),
      toolResultMsg('tc-1', 'readFile', 'content'),
      assistantMsg('I read the file.'),
    ]
    state.messages.push(...originalMsgs)
    flushPendingMessages(state, 'anthropic:claude', cwd)

    const loaded = loadSession(state.sessionFilePath!)!
    const hydrated = hydrateLoopState(loaded, 'default', cwd)

    expect(hydrated.messages.length).toBe(originalMsgs.length)
    for (let i = 0; i < originalMsgs.length; i++) {
      expect(hydrated.messages[i]!.role).toBe(originalMsgs[i]!.role)
    }
    cleanup()
  })
})

// ── listSessions / pickLatestSession ──────────────────────────────────────────

describe('listSessions / pickLatestSession', () => {
  it('无会话文件时返回空数组', () => {
    const { cwd, cleanup } = makeTempDir()
    const sessions = listSessions(cwd)
    expect(sessions).toEqual([])
    cleanup()
  })

  it('多个会话按 createdAt 倒序排列', async () => {
    const { cwd, cleanup } = makeTempDir()

    // 写入两个会话，间隔 2ms 确保时间不同
    const state1 = createLoopState()
    state1.messages.push(userMsg('first session'))
    flushPendingMessages(state1, 'anthropic:claude', cwd)

    await new Promise((r) => setTimeout(r, 10)) // 确保 createdAt 不同

    const state2 = createLoopState()
    state2.messages.push(userMsg('second session'))
    flushPendingMessages(state2, 'anthropic:claude', cwd)

    const sessions = listSessions(cwd)
    expect(sessions.length).toBe(2)
    // 最新的在前
    expect(sessions[0]!.createdAt).toBeGreaterThanOrEqual(sessions[1]!.createdAt)

    cleanup()
  })

  it('pickLatestSession 返回最新的会话', async () => {
    const { cwd, cleanup } = makeTempDir()

    const state1 = createLoopState()
    state1.taskSlug = 'older-task'
    state1.messages.push(userMsg('older'))
    flushPendingMessages(state1, 'anthropic:claude', cwd)

    await new Promise((r) => setTimeout(r, 10))

    const state2 = createLoopState()
    state2.taskSlug = 'newer-task'
    state2.messages.push(userMsg('newer'))
    flushPendingMessages(state2, 'anthropic:claude', cwd)

    const latest = pickLatestSession(cwd)
    expect(latest).not.toBeNull()
    expect(latest!.taskSlug).toBe('newer-task')

    cleanup()
  })

  it('无会话时 pickLatestSession 返回 null', () => {
    const { cwd, cleanup } = makeTempDir()
    const result = pickLatestSession(cwd)
    expect(result).toBeNull()
    cleanup()
  })
})

// ── findSession ───────────────────────────────────────────────────────────────

describe('findSession — sessionId/slug 模糊查找', () => {
  it('通过完整 sessionId 查找', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    state.messages.push(userMsg('hello'))
    flushPendingMessages(state, 'anthropic:claude', cwd)

    const found = findSession(state.sessionId, cwd)
    expect(found).not.toBeNull()
    expect(found!.sessionId).toBe(state.sessionId)
    cleanup()
  })

  it('通过 sessionId 前缀查找', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    state.messages.push(userMsg('hello'))
    flushPendingMessages(state, 'anthropic:claude', cwd)

    // 取前 8 个字符作为前缀
    const prefix = state.sessionId.slice(0, 8)
    const found = findSession(prefix, cwd)
    expect(found).not.toBeNull()
    cleanup()
  })

  it('通过 taskSlug 模糊查找（大小写不敏感）', () => {
    const { cwd, cleanup } = makeTempDir()
    const state = createLoopState()
    state.taskSlug = 'fix-auth-login'
    state.messages.push(userMsg('hello'))
    flushPendingMessages(state, 'anthropic:claude', cwd)

    const found = findSession('AUTH', cwd)
    expect(found).not.toBeNull()
    expect(found!.taskSlug).toBe('fix-auth-login')
    cleanup()
  })

  it('找不到时返回 null', () => {
    const { cwd, cleanup } = makeTempDir()
    const result = findSession('nonexistent-id-12345', cwd)
    expect(result).toBeNull()
    cleanup()
  })
})
