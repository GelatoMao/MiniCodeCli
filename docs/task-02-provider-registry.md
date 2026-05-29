# 任务 2：Provider 注册表（最小 Anthropic 接入）

**参照源码（x-code-cli）：**
- `packages/core/src/config/index.ts`
- `packages/core/src/providers/registry.ts`
- `packages/core/src/types/index.ts`（`MODEL_ALIASES`、`PROVIDER_DETECTION_ORDER` 部分）

---

## 一、核心概念

### AI SDK 的 Provider 体系

Vercel AI SDK（`ai` 包）提供了一个统一的抽象层，让你用同一套代码调用不同的 LLM 厂商：

```
应用代码 → ai SDK → @ai-sdk/anthropic → Anthropic API
                 → @ai-sdk/openai    → OpenAI API
                 → @ai-sdk/deepseek  → DeepSeek API
```

每个 `@ai-sdk/<provider>` 包负责：
- 把 AI SDK 的标准请求格式转成各厂商的私有 API 格式
- 把各厂商的流式响应转成 AI SDK 的标准事件流
- 处理各厂商特有的参数（如 Anthropic 的 `cache_control`、DeepSeek 的 `reasoning_content`）

**为什么要用 AI SDK 而不直接调用 Anthropic SDK？**

直接用 Anthropic SDK 会把厂商锁死。用 AI SDK 的好处是：
- 切换模型只需改一个字符串（如 `'anthropic:claude-sonnet-4-5'` → `'openai:gpt-4.1'`）
- 工具调用、流式输出、token 计数的接口完全统一
- 后续加新厂商不需要修改 agentLoop 的任何逻辑

### createProviderRegistry — 多 Provider 统一入口

`createProviderRegistry` 接收一个 `{ [providerName]: providerInstance }` 对象，返回一个注册表。通过它可以用 `'anthropic:claude-sonnet-4-5'` 这种 `<provider>:<model>` 格式统一寻址任意模型：

```typescript
const registry = createProviderRegistry({
  anthropic: createAnthropic({ ... }),
  openai: createOpenAI({ ... }),
})

// 用法：registry.languageModel('anthropic:claude-sonnet-4-5')
```

注册表内部把冒号左侧的 `anthropic` 映射到对应的 provider 实例，右侧的 `claude-sonnet-4-5` 传给该 provider 解析为具体的模型对象。

### API Key 管理原则：只读环境变量，不存磁盘

API Key 是极敏感的凭证，x-code-cli 设计了一个简单但重要的原则：**只从环境变量读取，绝不写入磁盘**。

好处：
- 用户的 Key 不会因为项目文件被提交到 Git 而泄漏
- 符合 12-Factor App 的配置管理规范
- 与 `.env` 文件生态完全兼容（`.env` 本身不上传 Git）

```typescript
// config/index.ts — 映射表：provider 名 → 环境变量名
const ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
}

function getApiKey(provider: string): string | undefined {
  const envKey = ENV_MAP[provider]
  return envKey ? process.env[envKey] : undefined
}
```

### Model ID 解析：三级优先级

用户可以通过多种方式指定模型，按优先级从高到低：

```
1. --model 参数（CLI 显式传入）
      ↓ 无则
2. MINI_CODE_MODEL 环境变量
      ↓ 无则
3. 智能默认：按 PROVIDER_DETECTION_ORDER 找第一个有 API Key 的 provider
```

这个设计让 CLI 的使用体验很灵活：
- 临时切换：`mc --model openai:gpt-4.1`
- 全局默认：在 `.env` 里写 `MINI_CODE_MODEL=deepseek:deepseek-chat`
- 零配置：只要设了任何一个 API Key 就能直接 `mc` 运行

**Model Aliases（短别名）** 让常用模型可以用简短名称指代：

```typescript
export const MODEL_ALIASES: Record<string, string> = {
  sonnet: 'anthropic:claude-sonnet-4-5',  // mc --model sonnet
  haiku: 'anthropic:claude-haiku-4-5',
  gpt4: 'openai:gpt-4.1',
  deepseek: 'deepseek:deepseek-chat',
}
```

别名解析发生在 `resolveModelId` 里，对所有输入来源统一处理：

```typescript
export function resolveModelId(input?: string): string | null {
  const explicit = input ?? process.env.MINI_CODE_MODEL
  if (explicit) {
    return MODEL_ALIASES[explicit] ?? explicit  // 先查别名，查不到原样返回
  }
  // 智能默认...
}
```

---

## 二、关键代码解析

### permanentErrorFetch — 永久错误拦截器

这是 task 2 最核心、也最有意思的一段代码。先看问题场景：

**问题：AI SDK 会对部分错误自动重试，但有些错误根本不可能通过重试解决。**

AI SDK 内部有一个指数退避重试机制，它认为以下 HTTP 状态码是"可重试"的：
- `408` / `409`（超时/冲突）
- `429`（速率限制）
- `5xx`（服务器错误）

但现实中各厂商会"乱用"这些状态码。例如：
- Moonshot 余额不足时返回 `429`（和速率限制一样的状态码！）
- 某些 provider 模型不存在时返回 `500`
- OpenAI 上下文超长时返回 `400`

如果不处理，SDK 会对"余额不足"错误反复重试 3 次，白白消耗 30 秒，然后抛出一个语义不清的 `RetryError`。

**解决方案：自定义 `fetch` 函数，在 SDK 解析响应之前拦截，按 body 关键词把错误状态码重写为语义正确的值。**

```
原始响应: HTTP 429  {"error": "insufficient balance"}
                     ↓ permanentErrorFetch 拦截
重写响应: HTTP 402  {"error": "insufficient balance"}   ← body 不变
                     ↓ AI SDK 收到
SDK 判断: 402 ∉ {408, 409, 429, 5xx}  → isRetryable = false → 立即抛出
```

**为什么可以拦截 fetch？**

AI SDK 的每个 provider factory（`createAnthropic`、`createOpenAI` 等）都支持传入自定义 `fetch` 参数，内部所有 HTTP 请求都通过它发出：

```typescript
createAnthropic({ fetch: permanentErrorFetch })
```

这样 `permanentErrorFetch` 就成为了 Anthropic provider 发出的所有请求的代理层。

**实现细节逐行解析：**

```typescript
export const permanentErrorFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)   // ① 真正发出请求

  if (response.status < 400) return response  // ② 成功响应直接返回，不读 body
  // 为什么不读 body？流式响应（SSE）的 body 是一个"管道"，只能消费一次。
  // 如果这里把它读走了，SDK 后续就拿不到任何数据了。
  // 200-399 的响应里成功流式响应占大多数，绝对不能碰。

  const text = await response
    .clone()   // ③ 克隆一份再读，保留原 response 的 body 流供后续使用
    .text()
    .catch(() => '')   // ④ 读取失败（网络中断等）静默处理，当作无 body

  if (!text) return response  // ⑤ 空 body，无法匹配关键词，直接返回

  const lower = text.toLowerCase()  // ⑥ 统一转小写，实现大小写不敏感匹配

  for (const category of PERMANENT_ERROR_CATEGORIES) {
    const hit = category.patterns.some((p) =>
      typeof p === 'string' ? lower.includes(p) : p.test(lower)
    )
    // ⑦ 支持字符串子串匹配和正则两种模式
    //    正则用于 "model `xxx` does not exist" 这类变长模板

    if (!hit) continue

    if (response.status === category.status) return response
    // ⑧ provider 已经用了正确的状态码，不需要重建 Response，直接返回

    return new Response(text, {     // ⑨ 重建 Response，换状态码，body 原样保留
      status: category.status,
      statusText: category.statusText,
      headers: response.headers,   // ⑩ 转发原始 headers，保留 content-type 等信息
    })
  }
  return response   // ⑪ 无关键词匹配，原样返回（真实 429/5xx 走 SDK 正常重试）
}
```

**为什么要 `response.clone()`？**

`Response` 的 body 是一个 `ReadableStream`，只能被消费一次。调用 `.text()` 会把整个流读光，如果后续 SDK 再读这个 response 就会得到空流。`.clone()` 创建一个新的 `Response` 对象，两者共享 body 数据但各有独立的读取状态——读克隆体不影响原体。

这里只在 `status >= 400` 时才 clone + 读 body，成功响应完全不触碰 body，是对流式 SSE 响应的保护。

### PERMANENT_ERROR_CATEGORIES — 错误分类表

5 个分类，按顺序匹配（**先匹配先获胜**）：

| 目标状态码 | 语义 | 典型触发场景 |
|-----------|------|------------|
| `402` | 余额不足 | Moonshot/DeepSeek 账户余额耗尽，返回 429 |
| `413` | 上下文超长 | OpenAI prompt 超过 context window，返回 400 |
| `422` | 内容安全过滤 | 内容违规，某些 provider 返回 500 |
| `401` | 鉴权失败 | API Key 无效，某些 provider 返回 429/500 |
| `404` | 模型未找到 | 模型 ID 错误或已废弃，某些 provider 返回 500 |

**为什么余额不足排第一？**

实践中余额不足是最常见的"误用可重试状态码"场景，而且它的后果最严重（重试会继续扣费 + 等 30 秒）。排在前面确保优先识别。

**字符串 vs 正则**

大多数关键词用字符串子串匹配（性能更好、可读性更高）。只有"模型不存在"用了正则：

```typescript
/\bmodel\b[^]*?\bdoes not exist\b/
```

原因：OpenAI 的错误信息是 `"The model 'gpt-x-turbo-9000' does not exist or you do not have access to it."`，中间嵌了变长的模型名，只能用正则匹配。`[^]*?` 是非贪婪匹配任意字符（含换行）。

### 懒注册（按需注册 Provider）

```typescript
export function createModelRegistry() {
  const opts = getProviderOptions()
  const providers: Record<string, any> = {}

  if (opts.anthropic) providers.anthropic = createAnthropic({ fetch: permanentErrorFetch })
  if (opts.openai)    providers.openai    = createOpenAI({ fetch: permanentErrorFetch })
  if (opts.deepseek)  providers.deepseek  = createDeepSeek({ fetch: permanentErrorFetch })

  return createProviderRegistry(providers)
}
```

只有检测到对应 API Key 时才注册该 provider。这样：
- 只有 `ANTHROPIC_API_KEY` 的用户，注册表里只有 `anthropic`，调用其他 provider 会得到清晰的错误
- 不会在启动时因为某个 provider SDK 缺少初始化参数而报错

---

## 三、踩坑 & 疑问

**Q：为什么 `permanentErrorFetch` 对成功响应不读 body？就算是 SSE 流，读一下 body 不会出什么问题吗？**

SSE（Server-Sent Events）流式响应的 body 是一个 `ReadableStream`，Node.js 把它表示成一个"水管"——数据从 provider 服务器源源不断地流过来，一旦被消费就消失了。

`response.text()` 会等待整个流结束后把所有数据拼成字符串返回。对于流式 LLM 响应，这意味着：
1. 要等模型生成完所有 token 才能得到结果（失去了流式的意义）
2. `.text()` 执行完后 body 流的读取指针在末尾，再读只能得到空字符串

所以 `if (response.status < 400) return response` 这一行是关键保障——只拦截错误响应（LLM 服务出错时返回的是普通 JSON，不是 SSE 流），让成功的流式响应原样透传给 SDK。

---

**Q：为什么要 `typeof p === 'string' ? lower.includes(p) : p.test(lower)`，不能统一用正则吗？**

可以，但字符串子串匹配比正则快，也更易读。绝大多数关键词是固定字符串，只有需要匹配变长内容时才用正则。这是性能和可读性的折中。如果全用正则，每条字符串关键词都要转成 `/keyword/i` 的形式，反而增加了噪音。

---

**Q：`PERMANENT_ERROR_CATEGORIES` 里的顺序真的重要吗？**

是的。想象一个 provider 的错误消息是：

```
"Your account is suspended due to insufficient balance, and the content_policy_violation was also detected."
```

这个 body 同时匹配了 `402` 分类（`suspended due to insufficient`）和 `422` 分类（`content_policy_violation`）。由于 `for...of` 顺序遍历，`402` 排在前面，所以最终状态码是 `402`——这是正确的，因为账户余额问题比内容安全问题更需要优先告警。

---

**Q：AI SDK 的重试逻辑是怎么判断"可重试"的？**

AI SDK（`ai` 包）内部有 `_retryWithExponentialBackoff` 函数。它捕获 `APICallError`，检查 `error.isRetryable` 字段。`isRetryable` 的值由 `APICallError` 构造函数根据 HTTP 状态码决定：

```
isRetryable = status in {408, 409, 429} || status >= 500
```

`permanentErrorFetch` 把永久性错误的状态码改写为 `401 / 402 / 404 / 413 / 422`，这些都不在可重试集合里，所以 SDK 拿到这些状态码时会直接抛出（`isRetryable = false`），不会重试。

---

## 四、vitest 测试策略

### 如何测试网络请求而不发真实请求

vitest 提供 `vi.stubGlobal` 可以替换任意全局变量：

```typescript
vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
  new Response('{"error": "..."}', { status: 429 })
))
```

这样 `permanentErrorFetch` 内部调用 `fetch(input, init)` 时，实际上调用的是我们的 mock，不会发出任何真实网络请求。

测试结束后用 `vi.unstubAllGlobals()` 还原，避免污染其他测试：

```typescript
afterEach(() => {
  vi.unstubAllGlobals()
})
```

### 测试用例组织思路

测试文件按"输入分类"组织，每个 `describe` 块对应一个场景：

```
成功响应直接透传          ← 验证"不越界"
不含关键词的错误直接透传   ← 验证"误伤率"
余额不足 → 402           ← 验证每个关键词
上下文超长 → 413          ← 同上
...（其余分类）
body 保留               ← 验证重建 Response 时 body 不变
分类优先级               ← 验证顺序匹配逻辑
```

**循环生成测试用例**：对于"每个关键词都单独测试"的场景，用 `for...of` 在顶层生成多个 `it`：

```typescript
for (const keyword of billingKeywords) {
  it(`关键词 "${keyword}" 配合 429 → 402`, async () => {
    stubFetch(makeResponse(429, `{"error":{"message":"${keyword}"}}`))
    const result = await permanentErrorFetch('https://api.example.com/', {})
    expect(result.status).toBe(402)
  })
}
```

这比手写 8 个重复测试更易维护，也能确保关键词列表和测试用例始终同步。

---

## 五、与原项目的差异

| 项目 | x-code-cli | mini-code-cli | 原因 |
|------|-----------|---------------|------|
| Provider 数量 | 8 家 + custom | 3 家（Anthropic、OpenAI、DeepSeek） | 逐步接入，task 12 补全 |
| `deepseekReasoningFetch` | 有 | 无 | 针对 DeepSeek V4 的特殊处理，后续添加 |
| `loadUserConfig` / `saveUserConfig` | 有（读写 `~/.x-code/config.json`） | 无 | 配置持久化在 task 14 引入 |
| 模型别名数量 | 10+ | 4 个 | 只保留当前接入的 3 个 provider 的主力模型 |

---

## 六、自测验证

### 验证 1：类型检查

```bash
pnpm typecheck
# 期望：无报错静默退出
```

### 验证 2：单元测试

```bash
pnpm test
# 期望：45 tests passed
```

### 实际结果（✅ 全部通过）

| 验证项 | 结果 |
|--------|------|
| `pnpm typecheck` | ✅ 无报错 |
| `pnpm test` | ✅ 45 个测试全部通过，耗时 ~19ms |

---

[← 任务 1](./task-01-monorepo.md) | [返回索引](./README.md) | [任务 3 →](./task-03-agent-loop.md)
