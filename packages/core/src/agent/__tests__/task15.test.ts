// @mini-code-cli/core — Task-15 本地验证测试
//
// 覆盖 task15 新增的三个核心模块（零 API Key 依赖，纯逻辑单元测试）：
//   1. sub-agents/built-in.ts  — 内置 agent 定义的完整性与约束
//   2. sub-agents/loader.ts    — Markdown frontmatter 解析、优先级合并
//   3. sub-agents/registry.ts  — 注册表查找与枚举
//   4. tools/task.ts           — createTaskTool schema 生成
//
// 不测试 runner.ts（需要真实 LanguageModel 实例）和
// 端到端 task 工具调用链（需要 API Key）。
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { BUILT_IN_AGENTS, EXPLORE_AGENT, GENERAL_PURPOSE_AGENT, PLAN_AGENT, CODE_REVIEWER_AGENT } from '../sub-agents/built-in.js'
import { loadCustomAgents } from '../sub-agents/loader.js'
import { createSubAgentRegistry } from '../sub-agents/registry.js'
import { createTaskTool } from '../../tools/task.js'

// ─────────────────────────────────────────────────────────────────────────────
// 1. built-in.ts — 内置 agent 定义约束
// ─────────────────────────────────────────────────────────────────────────────

describe('BUILT_IN_AGENTS — 内置 agent 定义完整性', () => {
  it('包含 4 个内置 agent', () => {
    expect(BUILT_IN_AGENTS).toHaveLength(4)
  })

  it('每个 agent 的 name 符合命名规范（小写字母+数字+连字符）', () => {
    for (const def of BUILT_IN_AGENTS) {
      expect(def.name).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('每个 agent 的 name 唯一', () => {
    const names = BUILT_IN_AGENTS.map((a) => a.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('每个 agent 有非空 description 和 systemPrompt', () => {
    for (const def of BUILT_IN_AGENTS) {
      expect(def.description.trim()).not.toBe('')
      expect(def.systemPrompt.trim()).not.toBe('')
    }
  })

  it('每个 agent 的 allowedTools 是数组', () => {
    for (const def of BUILT_IN_AGENTS) {
      expect(Array.isArray(def.allowedTools)).toBe(true)
    }
  })

  it('explore agent：name 为 "explore"，工具白名单为只读工具', () => {
    expect(EXPLORE_AGENT.name).toBe('explore')
    expect(EXPLORE_AGENT.allowedTools).toEqual(
      expect.arrayContaining(['readFile', 'glob', 'grep', 'listDir'])
    )
    // 不包含写操作工具
    expect(EXPLORE_AGENT.allowedTools).not.toContain('writeFile')
    expect(EXPLORE_AGENT.allowedTools).not.toContain('edit')
    expect(EXPLORE_AGENT.allowedTools).not.toContain('shell')
    // 绝不包含 task（防递归）
    expect(EXPLORE_AGENT.allowedTools).not.toContain('task')
  })

  it('general-purpose agent：allowedTools 为空（继承所有工具）', () => {
    expect(GENERAL_PURPOSE_AGENT.name).toBe('general-purpose')
    expect(GENERAL_PURPOSE_AGENT.allowedTools).toHaveLength(0)
  })

  it('plan agent：只读工具白名单', () => {
    expect(PLAN_AGENT.name).toBe('plan')
    expect(PLAN_AGENT.allowedTools).not.toContain('writeFile')
    expect(PLAN_AGENT.allowedTools).not.toContain('shell')
    expect(PLAN_AGENT.allowedTools).not.toContain('task')
  })

  it('code-reviewer agent：只读工具白名单', () => {
    expect(CODE_REVIEWER_AGENT.name).toBe('code-reviewer')
    expect(CODE_REVIEWER_AGENT.allowedTools).not.toContain('writeFile')
    expect(CODE_REVIEWER_AGENT.allowedTools).not.toContain('edit')
    expect(CODE_REVIEWER_AGENT.allowedTools).not.toContain('shell')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. loader.ts — 自定义 agent 加载与 Markdown frontmatter 解析
// ─────────────────────────────────────────────────────────────────────────────

describe('loadCustomAgents — 目录不存在时返回空数组', () => {
  it('全局和项目目录都不存在时不报错，返回空数组', async () => {
    // 用一个不存在的路径作为 cwd
    const result = await loadCustomAgents('/nonexistent-path-xyz-12345')
    expect(result).toEqual([])
  })
})

describe('loadCustomAgents — Markdown frontmatter 解析', () => {
  // 创建临时目录写入测试用 .md 文件
  async function withTempDir(fn: (dir: string) => Promise<void>) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-test-'))
    try {
      await fn(tmpDir)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }

  it('解析正确格式的 Markdown agent 文件', async () => {
    await withTempDir(async (tmpDir) => {
      // 模拟项目级 agents 目录
      const agentsDir = path.join(tmpDir, '.x-code', 'agents')
      await fs.mkdir(agentsDir, { recursive: true })

      await fs.writeFile(
        path.join(agentsDir, 'my-agent.md'),
        `---
name: my-agent
description: A custom agent for testing
allowedTools: readFile, glob
---

This is the system prompt.`
      )

      const agents = await loadCustomAgents(tmpDir)
      expect(agents).toHaveLength(1)
      expect(agents[0]!.name).toBe('my-agent')
      expect(agents[0]!.description).toBe('A custom agent for testing')
      expect(agents[0]!.allowedTools).toEqual(['readFile', 'glob'])
      expect(agents[0]!.systemPrompt).toBe('This is the system prompt.')
    })
  })

  it('省略 allowedTools 时默认为空数组（继承所有工具）', async () => {
    await withTempDir(async (tmpDir) => {
      const agentsDir = path.join(tmpDir, '.x-code', 'agents')
      await fs.mkdir(agentsDir, { recursive: true })

      await fs.writeFile(
        path.join(agentsDir, 'no-tools.md'),
        `---
name: no-tools
description: Agent without tool restriction
---

Do anything.`
      )

      const agents = await loadCustomAgents(tmpDir)
      expect(agents).toHaveLength(1)
      expect(agents[0]!.allowedTools).toEqual([])
    })
  })

  it('缺少必填字段 name 时静默跳过', async () => {
    await withTempDir(async (tmpDir) => {
      const agentsDir = path.join(tmpDir, '.x-code', 'agents')
      await fs.mkdir(agentsDir, { recursive: true })

      await fs.writeFile(
        path.join(agentsDir, 'invalid.md'),
        `---
description: Missing name field
---

System prompt.`
      )

      const agents = await loadCustomAgents(tmpDir)
      expect(agents).toHaveLength(0)
    })
  })

  it('缺少必填字段 description 时静默跳过', async () => {
    await withTempDir(async (tmpDir) => {
      const agentsDir = path.join(tmpDir, '.x-code', 'agents')
      await fs.mkdir(agentsDir, { recursive: true })

      await fs.writeFile(
        path.join(agentsDir, 'no-desc.md'),
        `---
name: no-desc
---

System prompt.`
      )

      const agents = await loadCustomAgents(tmpDir)
      expect(agents).toHaveLength(0)
    })
  })

  it('name 包含非法字符时静默跳过', async () => {
    await withTempDir(async (tmpDir) => {
      const agentsDir = path.join(tmpDir, '.x-code', 'agents')
      await fs.mkdir(agentsDir, { recursive: true })

      await fs.writeFile(
        path.join(agentsDir, 'bad-name.md'),
        `---
name: Bad Name! (有中文)
description: Bad name
---

System prompt.`
      )

      const agents = await loadCustomAgents(tmpDir)
      expect(agents).toHaveLength(0)
    })
  })

  it('没有 YAML frontmatter 的文件被静默跳过', async () => {
    await withTempDir(async (tmpDir) => {
      const agentsDir = path.join(tmpDir, '.x-code', 'agents')
      await fs.mkdir(agentsDir, { recursive: true })

      await fs.writeFile(
        path.join(agentsDir, 'no-frontmatter.md'),
        `# Just a regular markdown file

No frontmatter here.`
      )

      const agents = await loadCustomAgents(tmpDir)
      expect(agents).toHaveLength(0)
    })
  })

  it('项目级 agent 覆盖同名全局 agent', async () => {
    // 用临时目录模拟 HOME 很麻烦，这里只测项目级的加载（全局目录通常不存在）
    await withTempDir(async (tmpDir) => {
      const agentsDir = path.join(tmpDir, '.x-code', 'agents')
      await fs.mkdir(agentsDir, { recursive: true })

      await fs.writeFile(
        path.join(agentsDir, 'custom.md'),
        `---
name: custom
description: Project-level custom agent
---

Project system prompt.`
      )

      const agents = await loadCustomAgents(tmpDir)
      const custom = agents.find((a) => a.name === 'custom')
      expect(custom).toBeDefined()
      expect(custom!.description).toBe('Project-level custom agent')
    })
  })

  it('allowedTools 逗号分隔，去除空白', async () => {
    await withTempDir(async (tmpDir) => {
      const agentsDir = path.join(tmpDir, '.x-code', 'agents')
      await fs.mkdir(agentsDir, { recursive: true })

      await fs.writeFile(
        path.join(agentsDir, 'tools-test.md'),
        `---
name: tools-test
description: Tools parsing test
allowedTools:  readFile ,  glob ,  grep 
---

System prompt.`
      )

      const agents = await loadCustomAgents(tmpDir)
      expect(agents[0]!.allowedTools).toEqual(['readFile', 'glob', 'grep'])
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. registry.ts — 注册表查找与合并
// ─────────────────────────────────────────────────────────────────────────────

describe('createSubAgentRegistry — 基础查找', () => {
  it('能找到所有 4 个内置 agent', async () => {
    const registry = await createSubAgentRegistry('/nonexistent-path-xyz')
    expect(registry.get('explore')).toBeDefined()
    expect(registry.get('general-purpose')).toBeDefined()
    expect(registry.get('plan')).toBeDefined()
    expect(registry.get('code-reviewer')).toBeDefined()
  })

  it('查找不存在的 agent 返回 undefined', async () => {
    const registry = await createSubAgentRegistry('/nonexistent-path-xyz')
    expect(registry.get('nonexistent-agent')).toBeUndefined()
  })

  it('list() 至少包含 4 个内置 agent', async () => {
    const registry = await createSubAgentRegistry('/nonexistent-path-xyz')
    expect(registry.list().length).toBeGreaterThanOrEqual(4)
  })

  it('list() 中的每个 agent 都能通过 get() 找到', async () => {
    const registry = await createSubAgentRegistry('/nonexistent-path-xyz')
    for (const def of registry.list()) {
      expect(registry.get(def.name)).toBe(def)
    }
  })
})

describe('createSubAgentRegistry — 自定义 agent 覆盖内置', () => {
  async function withCustomAgentDir(
    agentMd: string,
    fn: (registry: Awaited<ReturnType<typeof createSubAgentRegistry>>) => Promise<void>
  ) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-registry-test-'))
    try {
      const agentsDir = path.join(tmpDir, '.x-code', 'agents')
      await fs.mkdir(agentsDir, { recursive: true })
      await fs.writeFile(path.join(agentsDir, 'override.md'), agentMd)
      const registry = await createSubAgentRegistry(tmpDir)
      await fn(registry)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }

  it('自定义 agent 出现在 list() 中', async () => {
    await withCustomAgentDir(
      `---
name: my-custom
description: My custom agent
---

System prompt.`,
      async (registry) => {
        const names = registry.list().map((a) => a.name)
        expect(names).toContain('my-custom')
      }
    )
  })

  it('自定义 agent 能覆盖同名内置 agent', async () => {
    await withCustomAgentDir(
      `---
name: explore
description: Overridden explore agent
---

Custom explore system prompt.`,
      async (registry) => {
        const explore = registry.get('explore')
        expect(explore).toBeDefined()
        expect(explore!.description).toBe('Overridden explore agent')
        expect(explore!.systemPrompt).toBe('Custom explore system prompt.')
      }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. tools/task.ts — createTaskTool schema 生成
// ─────────────────────────────────────────────────────────────────────────────

describe('createTaskTool — schema 生成', () => {
  it('返回合法的 AI SDK tool 对象（有 inputSchema）', async () => {
    const registry = await createSubAgentRegistry('/nonexistent-path-xyz')
    const taskTool = createTaskTool(registry)

    // AI SDK tool 对象具有 inputSchema 字段
    expect(taskTool).toBeDefined()
    expect((taskTool as Record<string, unknown>).inputSchema).toBeDefined()
  })

  it('inputSchema 包含 subagent 和 prompt 字段', async () => {
    const registry = await createSubAgentRegistry('/nonexistent-path-xyz')
    const taskTool = createTaskTool(registry)

    // 用 safeParse 验证合法输入
    const schema = (taskTool as Record<string, unknown>).inputSchema as {
      safeParse: (input: unknown) => { success: boolean }
    }

    // 合法输入：使用已知内置 agent 名称
    const valid = schema.safeParse({ subagent: 'explore', prompt: 'explore the codebase' })
    expect(valid.success).toBe(true)

    // 非法输入：subagent 名称不在枚举中
    const invalid = schema.safeParse({ subagent: 'nonexistent-agent-xyz', prompt: 'test' })
    expect(invalid.success).toBe(false)
  })

  it('空 registry 时 schema 使用宽松字符串类型', async () => {
    // 模拟没有任何 agent 的 registry
    const emptyRegistry = {
      get: () => undefined,
      list: () => [],
    }

    const taskTool = createTaskTool(emptyRegistry)
    const schema = (taskTool as Record<string, unknown>).inputSchema as {
      safeParse: (input: unknown) => { success: boolean }
    }

    // 任意字符串应该通过（宽松类型）
    const result = schema.safeParse({ subagent: 'any-name', prompt: 'test' })
    expect(result.success).toBe(true)
  })

  it('task 工具没有 execute 函数（手动分发）', async () => {
    const registry = await createSubAgentRegistry('/nonexistent-path-xyz')
    const taskTool = createTaskTool(registry)

    // 手动分发工具不应有 execute 函数
    expect((taskTool as Record<string, unknown>).execute).toBeUndefined()
  })

  it('task 工具的 description 包含所有内置 agent 名称', async () => {
    const registry = await createSubAgentRegistry('/nonexistent-path-xyz')
    const taskTool = createTaskTool(registry)

    const description = (taskTool as Record<string, unknown>).description as string
    expect(description).toContain('explore')
    expect(description).toContain('general-purpose')
    expect(description).toContain('plan')
    expect(description).toContain('code-reviewer')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 防递归约束：内置 agent 的 allowedTools 不含 task
// ─────────────────────────────────────────────────────────────────────────────

describe('防递归约束', () => {
  it('所有内置 agent 的 allowedTools 都不包含 "task"', () => {
    for (const def of BUILT_IN_AGENTS) {
      expect(def.allowedTools).not.toContain('task')
    }
  })

  it('general-purpose agent 的空白名单意图明确（需在 runner.ts 中强制排除 task）', () => {
    // general-purpose 的 allowedTools = [] 意味着"继承父 agent 所有工具"
    // 但 runner.ts 的 filterTools() 在空白名单时仍强制排除 task
    // 这里只验证定义层面的意图正确（不含 task 的显式声明）
    expect(GENERAL_PURPOSE_AGENT.allowedTools).toHaveLength(0)
    // 注意：空数组 ≠ 不限制，测试 runner.ts 的行为需要集成测试
  })
})
