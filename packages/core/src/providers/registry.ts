// @mini-code-cli/core — AI SDK Provider Registry
//
// 职责：
//   1. 按环境变量中已配置的 API Key，懒注册对应的 AI SDK provider 实例
//   2. 通过 permanentErrorFetch 拦截"永久失败"错误，将其状态码重写为
//      非重试值，避免 SDK 对无法恢复的错误执行指数退避重试
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAI } from '@ai-sdk/openai'
import { createProviderRegistry } from 'ai'

import { getProviderOptions } from '../config/index.js'

/**
 * 创建 AI SDK Provider 注册表。
 *
 * 只有检测到对应环境变量（ANTHROPIC_API_KEY / OPENAI_API_KEY /
 * DEEPSEEK_API_KEY）时才注册该 provider，未配置的 provider 不出现在
 * 注册表中。
 *
 * 返回的注册表通过 `registry.languageModel('provider:model-id')` 的
 * `<provider>:<model>` 格式统一寻址任意已注册的模型，例如：
 *   registry.languageModel('anthropic:claude-sonnet-4-5')
 *   registry.languageModel('openai:gpt-4.1')
 *
 * 每个 provider 都注入了 `permanentErrorFetch`，使永久性错误能被
 * 立即识别并短路，而不是被 SDK 反复重试。
 */
export function createModelRegistry() {
  const opts = getProviderOptions()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers: Record<string, any> = {}

  if (opts.anthropic) providers.anthropic = createAnthropic({ fetch: permanentErrorFetch })
  if (opts.openai) providers.openai = createOpenAI({ fetch: permanentErrorFetch })
  if (opts.deepseek) providers.deepseek = createDeepSeek({ fetch: permanentErrorFetch })

  return createProviderRegistry(providers)
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
