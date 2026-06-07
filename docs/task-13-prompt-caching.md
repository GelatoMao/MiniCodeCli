# Task 13：Prompt Caching（Anthropic + OpenAI）

## 一、本步目标

在 Agent Loop 的每次 API 调用前注入 **Prompt Caching** 控制信息，让 Anthropic 和 OpenAI 服务端可以缓存重复前缀，显著降低重复 token 计算成本。

新增文件：
- `packages/core/src/providers/cache-control.ts` — `applyCacheControl()` 核心逻辑
- `packages/core/src/providers/capabilities.ts` — `capabilitiesOf(modelId)` 模型能力标志

修改文件：
- `packages/core/src/agent/loop.ts` — 在 `runTurn` 中接入 `applyCacheControl`

---

## 二、核心设计决策

### 2.1 为什么要做 Prompt Caching？

在一个长对话会话中，每轮 API 请求都会携带完整的历史消息（messages 数组）。随着对话轮数增加，这个数组可能包含几千甚至几万个 token。**每次都从头计算**会导致：

1. 费用随对话轮数线性增加
2. 响应延迟（token 越多，计算时间越长）
3. 服务端资源浪费

Prompt Caching 的核心思路：**把不变的前缀缓存在服务器端，后续请求命中缓存时只需支付极低的 cache read 费用（约为正常价格的 1/10）**。

### 2.2 各 Provider 的缓存机制差异

| Provider | 机制 | 配置方式 |
|----------|------|---------|
| Anthropic | cache_control 断点注入 | 在 Part/消息上设 `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }` |
| OpenAI | promptCacheKey 前缀缓存 | 在系统消息上设 `providerOptions.openai.promptCacheKey = sessionId` |
| OpenAI-compatible（DeepSeek/Moonshot 等）| 隐式 prefix cache | 保持系统提示字节稳定即可自动命中，无需显式配置 |
| Google | Context Caching API | 独立的 cache 管理 API，本项目暂不接入 |

### 2.3 Anthropic 断点策略：为什么是"系统提示 + 末尾 3 条消息"？

Anthropic 当前 API 最多允许 **4 个 cache_control 断点**。选择哪里打断点要权衡"缓存命中率"和"断点位置的稳定性"：

```
对话历史（按时间序）：
  [系统提示]  ← 整个 session 不变，命中率最高 ★★★★★
  [用户 1]
  [助手 1]
  [工具结果]
  [用户 2]
  [助手 2]
  [工具结果]  ← 末尾 slot 3
  [用户 3]
  [助手 3]    ← 末尾 slot 2
  [工具结果]  ← 末尾 slot 1（最新的一轮）
  [用户 N]    ← 当前输入，不打断点（还没有缓存价值）
```

**为什么从末尾往前？**  
每轮对话后，末尾 3 条消息固定不变了（已完成的轮次）。下次请求时，这段内容会命中缓存。随着对话进行，缓存区域逐渐向后滑动，形成"滑动缓存窗口"。

**为什么 slot 0 给系统提示？**  
系统提示在整个会话内字节完全相同（`systemPromptCache` 设计保证了这一点），是命中率最高的区域，理应优先缓存。

### 2.4 关键设计：不修改 state.messages

`applyCacheControl` 返回的是**新创建的对象**，而非原地修改 `state.messages`：

```typescript
const { systemMessage, messages: cachedMessages } = applyCacheControl(...)
// cachedMessages 是新数组，state.messages 不变
result = streamText({
  system: systemMessage,  // 带 providerOptions 的新对象
  messages: cachedMessages, // 带 cache 标记的浅拷贝数组
  ...
})
```

**为什么不改 state.messages？**  
如果直接修改 `state.messages`，下次 `runTurn` 时又会再次注入断点，导致断点不断叠加（已有断点会被幂等检查跳过，但还是会产生不必要的对象重建开销）。更重要的是，`state.messages` 是会话的"真实历史记录"，不应该被渲染相关的标记污染。

---

## 三、关键代码解析

### 3.1 capabilities.ts — 模型能力检测

```typescript
export function capabilitiesOf(modelId: string): ModelCapabilities {
  const provider = modelId.split(':')[0]
  const model = modelId.split(':')[1] ?? modelId

  if (provider === 'anthropic') {
    const supportsVision = [...ANTHROPIC_VISION_MODELS].some(p => model.startsWith(p))
    return {
      supportsVision,
      supportsThinking: [...ANTHROPIC_THINKING_MODELS].some(p => model.startsWith(p)),
      supportsPromptCache: supportsVision, // claude-3+ 均支持
    }
  }
  // ...
}
```

用**前缀子串匹配**而非精确 ID 匹配，未来新版本模型（如 `claude-sonnet-4-7`）无需修改代码即可自动覆盖。

### 3.2 applyCacheControl — 策略分派

```typescript
export function applyCacheControl(modelId, systemPrompt, messages, sessionId) {
  const caps = capabilitiesOf(modelId)
  const provider = modelId.split(':')[0]

  if (!caps.supportsPromptCache) {
    return { systemMessage: baseSystemMessage, messages }  // 直接透传
  }

  if (provider === 'anthropic') return applyAnthropicCacheControl(...)
  if (provider === 'openai')    return applyOpenAICacheControl(...)

  return { systemMessage: baseSystemMessage, messages }  // 兜底
}
```

### 3.3 Anthropic 断点注入（幂等）

```typescript
// 检查是否已有断点（幂等保护）
const existing = (msg.providerOptions?.anthropic as any)?.cacheControl
if (existing) continue  // 跳过已注入的消息

// 注入断点
annotated[i] = {
  ...msg,
  providerOptions: {
    ...msg.providerOptions,
    anthropic: {
      ...msg.providerOptions?.anthropic,
      cacheControl: { type: 'ephemeral' }
    }
  }
} as ModelMessage
```

用 spread 展开 `providerOptions` 的目的是**保留该消息已有的其他 provider 选项**（如 thinking 配置），不会意外覆盖。

### 3.4 loop.ts 中的接入点

```typescript
// runTurn() 内，repairOrphanToolCalls 之后、streamText 之前
const { systemMessage, messages: cachedMessages } = applyCacheControl(
  options.modelId,
  systemPrompt,
  state.messages,
  state.sessionId,
)

result = streamText({
  model,
  system: systemMessage as any,  // SystemModelMessage 对象（含 providerOptions）
  messages: cachedMessages,
  tools: effectiveTools,
  ...
})
```

将 `system` 从纯字符串改为 `SystemModelMessage` 对象，是为了**携带 providerOptions**。AI SDK 的 `streamText` 的 `system` 参数虽然类型定义是 `string`，但实际实现接受对象形式（带 `role: 'system'` 和 `providerOptions` 字段），Anthropic 提供商会从 `providerOptions.anthropic` 中提取 `cacheControl` 配置。

---

## 四、与原项目的差异对比

| 方面 | 本项目（mini-code-cli）| 参考原项目逻辑 |
|------|---------------------|-------------|
| 系统提示缓存 | 通过 `state.systemPromptCache` 字节稳定 + `applyCacheControl` 注入标记 | 相同思路 |
| Anthropic 断点数 | 4 个（系统提示 1 + 末尾消息 3）| 相同 |
| OpenAI 缓存 | promptCacheKey = sessionId | 相同 |
| 能力检测 | `capabilitiesOf()` 独立模块 | 原项目可能内联在 applyCacheControl 中 |
| 不改 state.messages | ✅ 每次返回新对象 | 通常相同 |

---

## 五、踩过的坑

### 5.1 system 参数类型问题

AI SDK 的 `streamText` TypeScript 类型定义中，`system` 参数只接受 `string`，但实际运行时接受 `SystemModelMessage` 对象。这是因为 SDK 内部会做 duck typing（检查 `role === 'system'`）。

解决方法：用 `system: systemMessage as any` 绕过类型检查，并在注释中说明原因。

### 5.2 断点幂等性

如果同一轮 `runTurn` 被重试（如因为续写触发多次），必须确保断点不会被重复注入。通过检查 `providerOptions?.anthropic?.cacheControl` 是否已存在来实现幂等。

### 5.3 不改 state.messages 的重要性

早期版本直接修改了 `state.messages`，导致 `tool-result-sanitize.ts` 的 `repairOrphanToolCalls` 在下一轮看到的消息已经被"污染"了 providerOptions，虽然功能上没有问题，但增加了代码的耦合度。改为返回新对象后更清晰。

---

## 六、测试验证

按 task 说明，属性测试（task13.1）：
- **Property 2：系统提示幂等性** — 验证相同参数两次调用 `buildSystemPrompt` 结果字节相同（预留，task-A 实现系统提示后补充）
- **验证 `applyCacheControl` 注入的 Anthropic 断点数不超过 4 个**

目前通过现有 545 个测试验证无回归：

```
Test Files  19 passed | 1 skipped (20)
Tests       545 passed | 4 skipped (549)
```
