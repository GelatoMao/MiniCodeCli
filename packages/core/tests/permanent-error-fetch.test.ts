// Task 2.1 — permanentErrorFetch 单元测试
//
// 测试策略：
//   用 vitest 的 vi.stubGlobal('fetch', ...) 模拟全局 fetch，
//   避免发起真实网络请求。
//
// 覆盖的属性（Property 5）：
//   对各类错误关键词生成随机 HTTP 响应体，验证状态码重写正确。

import { describe, expect, it, vi, afterEach } from 'vitest'

import { permanentErrorFetch } from '../src/providers/registry.js'

// ── 辅助函数 ──────────────────────────────────────────────────────────────

/** 构造一个模拟 Response，供 stub fetch 返回 */
function makeResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    statusText: String(status),
    headers: { 'content-type': 'application/json' },
  })
}

/** stub 全局 fetch，使其返回给定的 Response */
function stubFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── 成功响应不修改 ─────────────────────────────────────────────────────────

describe('成功响应（status < 400）直接透传', () => {
  it('200 OK 不读 body，直接返回原 Response', async () => {
    const original = makeResponse(200, 'data: {"token":"hello"}\n')
    stubFetch(original)

    const result = await permanentErrorFetch('https://api.example.com/v1/chat', {})
    expect(result.status).toBe(200)
    // 返回的是同一个对象（未经克隆或重写）
    expect(result).toBe(original)
  })

  it('201 Created 直接透传', async () => {
    const original = makeResponse(201, '{"id":"msg_123"}')
    stubFetch(original)

    const result = await permanentErrorFetch('https://api.example.com/', {})
    expect(result.status).toBe(201)
    expect(result).toBe(original)
  })

  it('301 重定向直接透传', async () => {
    const original = makeResponse(301, '')
    stubFetch(original)

    const result = await permanentErrorFetch('https://api.example.com/', {})
    expect(result.status).toBe(301)
    expect(result).toBe(original)
  })
})

// ── 无关键词的错误响应直接透传 ───────────────────────────────────────────────

describe('不含关键词的错误响应直接透传', () => {
  it('429 但 body 里没有余额不足等关键词 → 保留 429（可重试）', async () => {
    const original = makeResponse(429, '{"error":{"message":"Too Many Requests","type":"rate_limit"}}')
    stubFetch(original)

    const result = await permanentErrorFetch('https://api.example.com/', {})
    expect(result.status).toBe(429)
    expect(result).toBe(original)
  })

  it('500 Internal Server Error 无关键词 → 保留 500', async () => {
    const original = makeResponse(500, '{"error":{"message":"Internal Server Error"}}')
    stubFetch(original)

    const result = await permanentErrorFetch('https://api.example.com/', {})
    expect(result.status).toBe(500)
    expect(result).toBe(original)
  })

  it('空 body 的错误响应直接透传', async () => {
    const original = makeResponse(503, '')
    stubFetch(original)

    const result = await permanentErrorFetch('https://api.example.com/', {})
    expect(result.status).toBe(503)
    expect(result).toBe(original)
  })
})

// ── 402：余额不足 ──────────────────────────────────────────────────────────

describe('余额不足 → 重写为 402', () => {
  const billingKeywords = [
    'insufficient balance',
    'insufficient_balance',
    'insufficient_quota',
    'insufficient quota',
    'exceeded_current_quota',
    'exceeded your current quota',
    'suspended due to insufficient',
    'please recharge',
  ]

  for (const keyword of billingKeywords) {
    it(`关键词 "${keyword}" 配合 429 → 402`, async () => {
      stubFetch(makeResponse(429, `{"error":{"message":"${keyword}"}}`))
      const result = await permanentErrorFetch('https://api.example.com/', {})
      expect(result.status).toBe(402)
    })
  }

  it('关键词大小写不敏感：INSUFFICIENT BALANCE → 402', async () => {
    stubFetch(makeResponse(429, '{"error":{"message":"INSUFFICIENT BALANCE"}}'))
    const result = await permanentErrorFetch('https://api.example.com/', {})
    expect(result.status).toBe(402)
  })

  it('真实 Moonshot 余额不足错误（HTTP 429）→ 402', async () => {
    const body =
      '{"error":{"message":"Your account org-xxx <ak-yyy> is suspended due to insufficient balance, please recharge your account","type":"exceeded_current_quota_error"}}'
    stubFetch(makeResponse(429, body))
    const result = await permanentErrorFetch('https://api.moonshot.cn/v1/chat/completions', {})
    expect(result.status).toBe(402)
  })

  it('原状态码已是 402 时直接返回原 Response（不重建）', async () => {
    const original = makeResponse(402, '{"error":{"message":"insufficient balance"}}')
    stubFetch(original)

    const result = await permanentErrorFetch('https://api.example.com/', {})
    expect(result.status).toBe(402)
    expect(result).toBe(original)
  })
})

// ── 413：上下文超长 ────────────────────────────────────────────────────────

describe('上下文超长 → 重写为 413', () => {
  const contextKeywords = [
    'context_length_exceeded',
    'context length exceeded',
    'maximum context length',
    'prompt is too long',
    'prompt_too_long',
    'context window',
  ]

  for (const keyword of contextKeywords) {
    it(`关键词 "${keyword}" 配合 400 → 413`, async () => {
      stubFetch(makeResponse(400, `{"error":{"message":"${keyword}"}}`))
      const result = await permanentErrorFetch('https://api.example.com/', {})
      expect(result.status).toBe(413)
    })
  }

  it('真实 OpenAI 超长错误（HTTP 400）→ 413', async () => {
    const body =
      '{"error":{"message":"This model\'s maximum context length is 128000 tokens. However, your messages resulted in 140000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}'
    stubFetch(makeResponse(400, body))
    const result = await permanentErrorFetch('https://api.openai.com/v1/chat/completions', {})
    expect(result.status).toBe(413)
  })
})

// ── 422：内容安全过滤 ──────────────────────────────────────────────────────

describe('内容安全过滤 → 重写为 422', () => {
  const safetyKeywords = [
    'content_policy_violation',
    'content_filter_triggered',
    'content_filter',
    'content_policy',
    'input_blocked',
    'harmful_content',
    'unsafe content',
    'safety_violation',
  ]

  for (const keyword of safetyKeywords) {
    it(`关键词 "${keyword}" 配合 500 → 422`, async () => {
      stubFetch(makeResponse(500, `{"error":{"message":"${keyword}"}}`))
      const result = await permanentErrorFetch('https://api.example.com/', {})
      expect(result.status).toBe(422)
    })
  }
})

// ── 401：鉴权失败 ─────────────────────────────────────────────────────────

describe('鉴权失败 → 重写为 401', () => {
  const authKeywords = [
    'invalid api key',
    'invalid_api_key',
    'incorrect api key',
    'api key not found',
    'api_key_invalid',
    'expired api key',
  ]

  for (const keyword of authKeywords) {
    it(`关键词 "${keyword}" 配合 429 → 401`, async () => {
      stubFetch(makeResponse(429, `{"error":{"message":"${keyword}"}}`))
      const result = await permanentErrorFetch('https://api.example.com/', {})
      expect(result.status).toBe(401)
    })
  }
})

// ── 404：模型未找到 ────────────────────────────────────────────────────────

describe('模型未找到 → 重写为 404', () => {
  it('关键词 "model_not_found" 配合 500 → 404', async () => {
    stubFetch(makeResponse(500, '{"error":{"message":"model_not_found"}}'))
    const result = await permanentErrorFetch('https://api.example.com/', {})
    expect(result.status).toBe(404)
  })

  it('关键词 "model not found" 配合 500 → 404', async () => {
    stubFetch(makeResponse(500, '{"error":{"message":"model not found"}}'))
    const result = await permanentErrorFetch('https://api.example.com/', {})
    expect(result.status).toBe(404)
  })

  it('关键词 "unknown model" 配合 500 → 404', async () => {
    stubFetch(makeResponse(500, '{"error":{"message":"unknown model"}}'))
    const result = await permanentErrorFetch('https://api.example.com/', {})
    expect(result.status).toBe(404)
  })

  it('正则匹配 "model ... does not exist" 配合 500 → 404', async () => {
    const body = '{"error":{"message":"The model `gpt-x-turbo-9000` does not exist or you do not have access to it."}}'
    stubFetch(makeResponse(500, body))
    const result = await permanentErrorFetch('https://api.openai.com/', {})
    expect(result.status).toBe(404)
  })
})

// ── body 保留 ─────────────────────────────────────────────────────────────

describe('重写状态码时 body 内容保留原样', () => {
  it('重写为 402 时 body 文本与原始一致', async () => {
    const originalBody = '{"error":{"message":"insufficient balance","type":"billing_error"}}'
    stubFetch(makeResponse(429, originalBody))

    const result = await permanentErrorFetch('https://api.example.com/', {})
    expect(result.status).toBe(402)
    const text = await result.text()
    expect(text).toBe(originalBody)
  })

  it('重写为 404 时 body 文本与原始一致', async () => {
    const originalBody = '{"error":{"message":"model not found","code":"model_not_found"}}'
    stubFetch(makeResponse(500, originalBody))

    const result = await permanentErrorFetch('https://api.example.com/', {})
    expect(result.status).toBe(404)
    const text = await result.text()
    expect(text).toBe(originalBody)
  })
})

// ── 优先级：先匹配的分类获胜 ─────────────────────────────────────────────────

describe('分类优先级：余额不足 > 其他', () => {
  it('同时含余额不足和内容安全关键词 → 402（余额不足优先）', async () => {
    // 余额不足排在 PERMANENT_ERROR_CATEGORIES 的第一位
    const body = '{"error":{"message":"insufficient balance and content_policy_violation"}}'
    stubFetch(makeResponse(429, body))

    const result = await permanentErrorFetch('https://api.example.com/', {})
    expect(result.status).toBe(402)
  })
})
