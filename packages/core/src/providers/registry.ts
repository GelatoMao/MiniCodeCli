// @mini-code-cli/core — AI SDK Provider Registry
//
// 职责：
//   1. 按环境变量中已配置的 API Key，懒注册对应的 AI SDK provider 实例
//   2. 通过 permanentErrorFetch 拦截"永久失败"错误，将其状态码重写为
//      非重试值，避免 SDK 对无法恢复的错误执行指数退避重试
//   3. 通过 deepseekReasoningFetch 透传 DeepSeek 的思考过程数据
//
// 支持的 8 家厂商：
//   anthropic（Claude）、openai（GPT/o 系列）、deepseek（DeepSeek V3/R1）、
//   google（Gemini）、alibaba（通义千问）、xai（Grok）、zhipu（智谱 GLM）、
//   moonshot（月之暗面 Kimi）
//   + openai-compatible（自定义兼容端点）
import { createAnthropic } from '@ai-sdk/anthropic'
import { createAlibaba } from '@ai-sdk/alibaba'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createXai } from '@ai-sdk/xai'
import { createProviderRegistry } from 'ai'

import { getProviderOptions } from '../config/index.js'

// ─── Zhipu 和 Moonshot 使用 OpenAI 兼容协议 ──────────────────────────────
//
// 智谱 GLM 和月之暗面 Kimi 均提供 OpenAI 兼容 API，因此通过
// createOpenAICompatible 接入，只需指定 baseURL 和 API Key 即可。
//
// 这也体现了"策略模式"：所有厂商面向统一接口，差异由工厂函数在初始化时注入。

const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1'

/**
 * 创建 AI SDK Provider 注册表。
 *
 * 只有检测到对应环境变量时才注册该 provider，未配置的 provider 不出现在
 * 注册表中。
 *
 * 返回的注册表通过 `registry.languageModel('provider:model-id')` 的
 * `<provider>:<model>` 格式统一寻址任意已注册的模型，例如：
 *   registry.languageModel('anthropic:claude-sonnet-4-5')
 *   registry.languageModel('deepseek:deepseek-reasoner')
 *   registry.languageModel('xai:grok-beta')
 *
 * 每个 provider 都注入了 `permanentErrorFetch`，使永久性错误能被
 * 立即识别并短路，而不是被 SDK 反复重试。
 * DeepSeek 额外叠加 `deepseekReasoningFetch`，确保思考内容字段正确传递。
 */
export function createModelRegistry() {
  const opts = getProviderOptions()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers: Record<string, any> = {}

  // ── 有独立 SDK 的厂商 ──────────────────────────────────────────────────
  if (opts.anthropic) {
    providers.anthropic = createAnthropic({
      apiKey: opts.anthropic,
      fetch: permanentErrorFetch,
    })
  }

  if (opts.openai) {
    providers.openai = createOpenAI({
      apiKey: opts.openai,
      fetch: permanentErrorFetch,
    })
  }

  if (opts.deepseek) {
    // DeepSeek 叠加两层 fetch：
    //   permanentErrorFetch  — 永久错误短路
    //   deepseekReasoningFetch — reasoning_content 字段透传（最外层）
    // 调用顺序：deepseekReasoningFetch → permanentErrorFetch → fetch
    providers.deepseek = createDeepSeek({
      apiKey: opts.deepseek,
      fetch: deepseekReasoningFetch(permanentErrorFetch),
    })
  }

  if (opts.google) {
    providers.google = createGoogleGenerativeAI({
      apiKey: opts.google,
      fetch: permanentErrorFetch,
    })
  }

  if (opts.alibaba) {
    providers.alibaba = createAlibaba({
      apiKey: opts.alibaba,
      fetch: permanentErrorFetch,
    })
  }

  if (opts.xai) {
    providers.xai = createXai({
      apiKey: opts.xai,
      fetch: permanentErrorFetch,
    })
  }

  // ── 使用 OpenAI 兼容协议的厂商 ────────────────────────────────────────
  if (opts.zhipu) {
    providers.zhipu = createOpenAICompatible({
      name: 'zhipu',
      apiKey: opts.zhipu,
      baseURL: ZHIPU_BASE_URL,
      fetch: permanentErrorFetch,
    })
  }

  if (opts.moonshot) {
    providers.moonshot = createOpenAICompatible({
      name: 'moonshot',
      apiKey: opts.moonshot,
      baseURL: MOONSHOT_BASE_URL,
      fetch: permanentErrorFetch,
    })
  }

  // ── 自定义 OpenAI 兼容端点 ───────────────────────────────────────────
  // 通过 OPENAI_COMPATIBLE_API_KEY + OPENAI_COMPATIBLE_BASE_URL 配置。
  if (opts.openaiCompatible?.apiKey && opts.openaiCompatible.baseURL) {
    providers['openai-compatible'] = createOpenAICompatible({
      name: 'openai-compatible',
      apiKey: opts.openaiCompatible.apiKey,
      baseURL: opts.openaiCompatible.baseURL,
      fetch: permanentErrorFetch,
    })
  }

  return createProviderRegistry(providers)
}

// ── deepseekReasoningFetch ─────────────────────────────────────────────────
//
// 背景：DeepSeek R1（deepseek-reasoner）的 API 响应中包含 `reasoning_content`
// 字段，里面存放模型的思维链（Chain of Thought）。AI SDK 标准接口不认识
// 这个字段，如果不做处理，思考内容会被直接丢弃，无法在 UI 中展示。
//
// 解决方案：在 SSE 流到达 AI SDK 解析器之前，对每一行 SSE 数据进行改写：
//   1. 找到含有 "reasoning_content" 的 SSE data 行
//   2. 将 reasoning_content 字段的内容转换为普通文本增量（text delta）
//      的格式（追加到 content.delta 中），让 AI SDK 能正常处理
//
// 这是一种"透明代理"模式：外层函数接收另一个 fetch，返回经过改写的响应，
// 调用者无需关心内部差异。

/**
 * DeepSeek Reasoning 内容透传 fetch 包装器工厂。
 *
 * 接受一个底层 fetch（通常是 permanentErrorFetch），返回一个新的 fetch 函数。
 * 该函数在 SSE 流中检测到 `reasoning_content` 字段时，将其内容以统一的
 * `<think>...</think>` 标记格式注入到普通文本流中，使思考过程在 UI 可见。
 *
 * @param innerFetch 底层 fetch 实现（通常为 permanentErrorFetch）
 */
export function deepseekReasoningFetch(innerFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await innerFetch(input, init)

    // 只处理 SSE 流式响应（text/event-stream）
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream') || !response.body) {
      return response
    }

    // 将原始 ReadableStream 转换，对每行 SSE data 进行 reasoning_content 处理
    const transformedBody = transformDeepSeekStream(response.body)

    return new Response(transformedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

/**
 * 对 DeepSeek SSE 流进行逐行转换。
 *
 * 针对每一行包含 JSON data 的 SSE 行：
 * - 如果 delta 中有 reasoning_content，将其以 <think> 标记格式追加到 content
 * - 原始 content delta 保持不变，reasoning_content 追加在其后
 *
 * 格式约定（与 Claude 的 thinking 对齐）：
 *   首次 reasoning_content → 追加 "<think>\n" + content
 *   后续 reasoning_content → 直接追加
 *   reasoning_content 结束（普通 content 出现）→ 追加 "\n</think>\n"
 */
function transformDeepSeekStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let inReasoning = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? '' // 最后一行可能不完整，保留到下次

          for (const line of lines) {
            if (!line.startsWith('data: ')) {
              // 非 data 行（空行、event: 行等）原样透传
              controller.enqueue(encoder.encode(line + '\n'))
              continue
            }

            const dataStr = line.slice(6) // 去掉 "data: " 前缀
            if (dataStr === '[DONE]') {
              controller.enqueue(encoder.encode(line + '\n'))
              continue
            }

            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const parsed: any = JSON.parse(dataStr)
              const delta = parsed?.choices?.[0]?.delta

              if (delta && typeof delta === 'object') {
                const reasoningContent: string | undefined = delta.reasoning_content
                const textContent: string | undefined = delta.content

                if (reasoningContent) {
                  // 有思考内容：加上 <think> 包裹标记
                  if (!inReasoning) {
                    // 进入思考阶段：注入开始标记
                    inReasoning = true
                    delta.content = '<think>\n' + reasoningContent
                  } else {
                    delta.content = reasoningContent
                  }
                  delete delta.reasoning_content
                } else if (textContent !== undefined && textContent !== null && inReasoning) {
                  // 思考阶段结束，有普通文本：注入结束标记
                  inReasoning = false
                  delta.content = '\n</think>\n' + textContent
                }
              }

              controller.enqueue(encoder.encode('data: ' + JSON.stringify(parsed) + '\n'))
            } catch {
              // JSON 解析失败（非预期数据）：原样透传
              controller.enqueue(encoder.encode(line + '\n'))
            }
          }
        }

        // 处理 buffer 中剩余的内容（不完整行）
        if (buffer) {
          controller.enqueue(encoder.encode(buffer))
        }
      } finally {
        controller.close()
        reader.releaseLock()
      }
    },
  })
}

// ── permanentErrorFetch ────────────────────────────────────────────────────
//
// 背景：AI SDK 内部的 `_retryWithExponentialBackoff` 会对以下状态码自动重试：
//   408 / 409 / 429 / 5xx
//
// 问题：各厂商有时会"误用"这些可重试的状态码来表达永久性失败，例如：
//   - Moonshot 余额不足 → HTTP 429（和真实限速一模一样）
//   - 某些 provider 模型 ID 错误 → HTTP 500
//   - OpenAI 上下文超长 → HTTP 400（非重试，但语义不清晰）
//
// 如果不拦截，SDK 会对"余额不足"错误反复等待 + 重试约 30 秒，
// 最终抛出一个语义不清的 RetryError，而不是直接告诉用户"请充值"。
//
// 解决方案：把 permanentErrorFetch 作为自定义 fetch 注入给每个 provider。
// 它在 SDK 解析响应之前拦截，按 body 关键词把状态码重写为语义更准确的值：
//   429（余额不足关键词）→ 402  ←  SDK 判断 402 不可重试，立即抛出
//   400（超长关键词）   → 413
//   ...
//
// 这样下游的错误分类器（classifyApiError）只需检查状态码就能给出正确提示。

/**
 * 错误关键词匹配器类型：支持字符串子串匹配和正则两种形式。
 * 字符串用 `lower.includes(p)` 匹配（大小写不敏感，性能更好）；
 * 正则用于需要匹配变长内容的模板，如 "model `xxx` does not exist"。
 */
type PermanentErrorMatcher = string | RegExp

/**
 * 永久性错误的分类规则表。
 *
 * 每个条目定义：
 *   status     — 目标状态码（非重试值，SDK 遇到后不会重试）
 *   statusText — 对应的 HTTP 状态文本
 *   patterns   — 触发该分类的关键词列表（按 body 文本匹配）
 *
 * 顺序规则：数组顺序即匹配优先级，先匹配的分类获胜。
 * 余额不足排第一，因为它是最常见的"误用 429"场景，且后果最严重。
 */
const PERMANENT_ERROR_CATEGORIES: ReadonlyArray<{
  status: number
  statusText: string
  patterns: readonly PermanentErrorMatcher[]
}> = [
  {
    // 402 Payment Required — 账户余额耗尽 / 配额超限。
    // 典型案例：Moonshot 账户欠费时返回 HTTP 429，body 含 "insufficient balance"。
    status: 402,
    statusText: 'Payment Required',
    patterns: [
      'insufficient balance',
      'insufficient_balance',
      'insufficient_quota',
      'insufficient quota',
      'exceeded_current_quota',
      'exceeded your current quota',
      'suspended due to insufficient',
      'please recharge',
    ],
  },
  {
    // 413 Payload Too Large — Prompt 超过模型上下文窗口上限。
    // 同样的 prompt 会一直超，只有 /compact、/clear 或换更大上下文的模型才能解决，
    // 重试毫无意义。
    status: 413,
    statusText: 'Payload Too Large',
    patterns: [
      'context_length_exceeded',
      'context length exceeded',
      'maximum context length',
      'prompt is too long',
      'prompt_too_long',
      'context window',
    ],
  },
  {
    // 422 Unprocessable Entity — 内容安全过滤触发。
    // 相同内容重试会得到相同结果，用户必须修改输入或更换模型。
    status: 422,
    statusText: 'Unprocessable Entity',
    patterns: [
      'content_policy_violation',
      'content_filter_triggered',
      'content_filter',
      'content_policy',
      'input_blocked',
      'harmful_content',
      'unsafe content',
      'safety_violation',
    ],
  },
  {
    // 401 Unauthorized — API Key 无效 / 过期。
    // 某些 provider 在 Key 错误时返回 429 或 5xx（代理层配置错误所致），
    // 重写为 401 让下游能正确提示用户检查 Key。
    status: 401,
    statusText: 'Unauthorized',
    patterns: [
      'invalid api key',
      'invalid_api_key',
      'incorrect api key',
      'api key not found',
      'api_key_invalid',
      'expired api key',
    ],
  },
  {
    // 404 Not Found — 模型 ID 错误或已废弃。
    // 正则 /\bmodel\b[^]*?\bdoes not exist\b/ 用于匹配 OpenAI 风格的
    // "The model `gpt-x` does not exist or you do not have access to it."
    // 其中模型名是变长内容，必须用正则而不能用字符串匹配。
    status: 404,
    statusText: 'Not Found',
    patterns: ['model_not_found', 'model not found', 'unknown model', /\bmodel\b[^]*?\bdoes not exist\b/],
  },
] as const

/**
 * 自定义 fetch，在 AI SDK 解析响应之前拦截"永久失败"错误并重写状态码。
 *
 * 工作流程：
 *   1. 转发请求到真实的 fetch
 *   2. status < 400 → 直接返回（不读 body，保护 SSE 流不被消费）
 *   3. status >= 400 → clone response 后读取 body 文本
 *   4. 按 PERMANENT_ERROR_CATEGORIES 顺序匹配关键词
 *      - 命中 → 用目标状态码重建 Response（body 原样保留）
 *      - 未命中 → 原样返回（SDK 正常重试 429/5xx）
 *
 * 关键细节：
 *   - 用 response.clone() 读 body，而不是直接读原 response。
 *     Response.body 是 ReadableStream，只能消费一次；clone() 创建独立的
 *     读取状态，避免把原 response 的流读光。
 *   - 关键词匹配前统一 toLowerCase()，实现大小写不敏感。
 *   - 当 provider 已返回正确状态码时（如原本就是 402），直接返回原 response，
 *     不重建对象，节省分配开销。
 */
export const permanentErrorFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)

  // ── 成功响应 / 流式响应：绝对不读 body ───────────────────────────────
  // SSE（Server-Sent Events）流式响应的 body 是一个 ReadableStream，
  // 调用 .text() 会等整个流结束才返回，且读完后流指针在末尾无法复位。
  // SDK 后续需要消费这个流来逐 token 推送给用户，所以 status < 400
  // 的响应必须原样透传，绝不能碰 body。
  if (response.status < 400) return response

  // ── 错误响应：读取 body 文本进行关键词匹配 ──────────────────────────
  // 错误响应（4xx/5xx）通常是普通 JSON，不是 SSE 流，可以安全读取。
  // 用 .clone() 保留原 response 对象的完整性（万一后续路径需要原样返回）。
  const text = await response
    .clone()
    .text()
    .catch(() => '') // 读取失败（断连等网络异常）时静默处理，视作空 body
  if (!text) return response // 空 body 无法匹配关键词，直接透传

  const lower = text.toLowerCase() // 统一转小写，关键词匹配大小写不敏感

  for (const category of PERMANENT_ERROR_CATEGORIES) {
    // 字符串用 includes（快），正则用 test（支持变长模板）
    const hit = category.patterns.some((p) => (typeof p === 'string' ? lower.includes(p) : p.test(lower)))
    if (!hit) continue

    // provider 已经用了正确的目标状态码，直接返回原 response，无需重建
    if (response.status === category.status) return response

    // 重写状态码，body 原样保留。
    // SDK 的错误解析器（APICallError）仍然能从 body 里提取
    // provider 的原始 message 字段，供下游 classifyApiError 使用。
    return new Response(text, {
      status: category.status,
      statusText: category.statusText,
      headers: response.headers, // 保留原始 headers（content-type 等）
    })
  }

  // 无关键词命中：原样返回。真实的限速（429）/ 服务器抖动（5xx）
  // 会走到这里，让 SDK 按正常指数退避逻辑重试。
  return response
}
