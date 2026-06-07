# Task 12：多 Provider 支持 + /model 命令

## 核心目标

在现有 Anthropic/OpenAI/DeepSeek 三家基础上，扩展至 8 家主流 AI 厂商，并实现运行时通过 `/model` 命令切换模型。

---

## 核心设计决策

### 1. 统一的 Provider 注册抽象

```
用户配置 API Key（环境变量）
     ↓
getProviderOptions()          // 读取全部 8 家厂商的 Key
     ↓
createModelRegistry()         // 按已配置的 Key 懒注册 provider
     ↓
registry.languageModel('provider:model-id')   // 统一寻址
```

AI SDK 的 `createProviderRegistry` 提供了统一的 `registry.languageModel(id)` 接口，所有厂商只需在初始化时注入对应的创建函数即可。

**关键约束**：只有检测到 API Key 的厂商才会被注册，未配置的不出现在注册表中——这样既节省资源，也方便报错提示。

### 2. 三类 Provider 接入方式

| 类型 | 厂商 | 接入方式 |
|------|------|---------|
| 独立 SDK | Anthropic、OpenAI、DeepSeek、Google、Alibaba、xAI | `@ai-sdk/<name>` 官方包 |
| OpenAI 兼容 | Zhipu（智谱）、Moonshot（月之暗面） | `@ai-sdk/openai-compatible` + baseURL |
| 自定义 endpoint | 用户自定义 | `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` |

`createOpenAICompatible` 的威力在于：任何实现了 OpenAI Chat API 格式的服务都能直接接入，不需要专用 SDK。

### 3. deepseekReasoningFetch —— SSE 流透传

DeepSeek R1（deepseek-reasoner）的 API 响应包含 `reasoning_content` 字段（思维链）。AI SDK 标准接口不认识这个字段，直接丢弃。

**解决方案**：构造一个"透明代理"fetch：

```typescript
// 工厂函数：接受 innerFetch，返回包装后的 fetch
export function deepseekReasoningFetch(innerFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await innerFetch(input, init)
    // 只处理 SSE 流（text/event-stream）
    // 通过 TransformStream 逐行改写 SSE data，
    // 将 reasoning_content 以 <think>...</think> 格式注入到 content 中
  }
}
```

**调用链**：`deepseekReasoningFetch(permanentErrorFetch)` → `fetch`

这是"装饰器模式"的经典应用：每一层 fetch 包装只关注自己的职责。

### 4. permanentErrorFetch —— HTTP 层错误分类

各厂商有时"误用"可重试状态码（429、5xx）表达永久性失败。不拦截的后果：SDK 反复重试 30 秒。

**实现原理**：
1. `status < 400`：绝不读 body（保护 SSE 流）
2. `status >= 400`：克隆响应，读取 body 文本
3. 按关键词表匹配 → 重写状态码（402/413/422/401/404）

```
余额不足 → 402 Payment Required
上下文超长 → 413 Payload Too Large  
内容违规 → 422 Unprocessable Entity
Key 无效 → 401 Unauthorized
模型不存在 → 404 Not Found
```

**核心细节**：`response.clone().text()` 而非 `response.text()`。`Response.body` 是 `ReadableStream`，只能消费一次；`clone()` 创建独立的读取状态，避免把原 response 的流读光。

### 5. provider-compat.ts —— 非视觉模型降级

不同厂商对图片的支持参差不齐：DeepSeek、Moonshot 等不支持图片输入。

**设计原则**：降级优于报错。把 `ImagePart` 替换为 `[图片：该模型不支持视觉输入]` 的文本占位符，模型至少还能基于文件名推断上下文。

```typescript
// 使用 any 绕过复杂的联合类型，在运行时按 part.type 做判断
function downgradeBinaryParts(content: any): any {
  return content.map(part => {
    if (part.type === 'image') return { type: 'text', text: placeholder }
    return part
  })
}
```

**优化**：若无任何改动，返回原数组引用（节省分配，避免触发 React 重渲染）。

### 6. /model 命令 —— 运行时模型切换

实现思路：在 `App.tsx` 中拦截斜杠命令，不走 agentLoop，而是弹出 `notice` 驱动的文本选择器。

```
用户输入 /model（回车）
    ↓
submit() 拦截，调用 buildModelOptions()
    ↓
setIsModelPicking(true)，设置选项列表
    ↓
notice 显示选择器 UI（▶ 高亮当前项）
    ↓
ChatInput 检测到 isModelPicking，将 ↑↓/Enter/Esc 路由到 onPickerNavKey
    ↓
用户按 Enter → createModelRegistry() → switchModel(newModel, newModelId)
    ↓
use-agent 的 modelRef 和 optionsRef 更新（下次提交生效）
```

**关键设计**：`ChatInput` 的 `isModelPicking` prop 将方向键路由改变——这是"模式切换"模式的一个简单实现。

---

## 关键代码解析

### `createModelRegistry` 中的条件注册

```typescript
if (opts.anthropic) providers.anthropic = createAnthropic({ apiKey: opts.anthropic, fetch: permanentErrorFetch })
if (opts.deepseek)  providers.deepseek  = createDeepSeek({ apiKey: opts.deepseek, fetch: deepseekReasoningFetch(permanentErrorFetch) })
if (opts.zhipu)     providers.zhipu     = createOpenAICompatible({ name: 'zhipu', apiKey: opts.zhipu, baseURL: ZHIPU_BASE_URL, fetch: permanentErrorFetch })
```

`opts.xxx` 为 undefined 时条件不满足，provider 不注册。这保证了 `registry.languageModel('zhipu:xxx')` 在 key 未配置时能给出明确报错，而不是静默失败。

### `PROVIDER_DETECTION_ORDER` 的 fallback 逻辑

```typescript
// 在 CLI 入口中：
const fallback = PROVIDER_DETECTION_ORDER.find(({ envKey }) => process.env[envKey])
if (!fallback) { printNoApiKeyMessage(); process.exit(0) }
// 用 fallback.defaultModel 替换失效的 modelId
```

`PROVIDER_DETECTION_ORDER` 数组同时承担两个职责：
1. 规定"首选 provider"的优先级（第一个有 key 的作为默认）
2. 提供每家 provider 的默认模型 ID

---

## 与原项目的差异对比

| 方面 | 本实现 | 原 x-code 项目 |
|------|--------|----------------|
| xAI 接入 | `@ai-sdk/xai` 官方包 | 同 |
| Alibaba 接入 | `@ai-sdk/alibaba` 官方包 | 通过 openai-compatible |
| Zhipu/Moonshot | `@ai-sdk/openai-compatible` | 同 |
| DeepSeek 思考 | SSE 逐行改写，注入 `<think>` 标签 | 类似，但标签格式略有差异 |
| /model UI | notice prop + 方向键路由 | Ink 组件渲染的选择器 |

---

## 踩过的坑

### 1. `Response.clone()` 是关键

最初直接用 `response.text()` 读取 body，导致 SSE 流被消费，AI SDK 收到空流，抛出"流已结束"错误。

**教训**：HTTP Response 的 body 是 ReadableStream，只能消费一次。任何需要"既读 body 又保留 Response 原始状态"的场景，必须用 `.clone()`。

### 2. `type MessageContent = any` 的取舍

`ModelMessage['content']` 是一个庞大的联合类型，包含 `TextPart | ImagePart | FilePart | ReasoningPart | ToolCallPart | ...`。对每个 part 做 map 操作时，TypeScript 会严格检查返回值是否兼容联合类型中的所有成员。

用 `any` 绕过是务实选择：函数的正确性由运行时 `part.type` 判断保证，静态类型在此反而是障碍。

### 3. React setState 嵌套的隐患

最初在 `setModelPickerState` 的回调里调用了 `setIsModelPicking(false)`（React 的 setState 是异步的，嵌套调用语义不明确）。

**修正**：分开调用两个 setState，避免潜在的批处理问题：
```typescript
setModelPickerState(prev => { /* ... */ return prev })  // 处理选项逻辑
setIsModelPicking(false)  // 独立调用
```

### 4. DeepSeek SSE 改写：buffer 管理

SSE 行的读取需要处理"跨 chunk 的不完整行"。实现中用 `buffer` 变量缓存未完整的行，等下次 chunk 到来时拼接处理：

```typescript
buffer += decoder.decode(value, { stream: true })
const lines = buffer.split('\n')
buffer = lines.pop() ?? ''  // 最后一行可能不完整，保留
```

这是处理流式文本的标准模式，值得记忆。
