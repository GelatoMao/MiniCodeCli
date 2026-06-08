// @mini-code-cli/core — Knowledge Context Loader（5 层 AGENTS.md 合并）
//
// 需求 7.1：KnowledgeSystem SHALL 合并 5 层上下文（优先级从低到高）：
//   层 1（最低）：用户 AGENTS.md（~/.mini-code/AGENTS.md）
//   层 2：用户 auto-memory.md（~/.mini-code/auto-memory.md）
//   层 3：项目 AGENTS.md 链（从 cwd 向上查找，直到 home 或 git root；root 覆盖 leaf）
//           注意：叶节点（更深的目录）覆盖根节点 —— 越具体越优先
//   层 4：项目 auto-memory.md（<cwd>/.mini-code/auto-memory.md）
//   层 5（最高）：AGENTS.local.md（个人偏好，应加入 .gitignore）
//
// 设计原则：
//   - 字节稳定：同一 cwd + 文件内容 → 同一输出（跨 turn 复用 systemPromptCache）
//   - 静默降级：任何文件读取失败时不报错，只是该层贡献空字符串
//   - 不注入时间戳或动态内容（会破坏 prefix cache）
//
// 调用时机：
//   agentLoop 首轮 buildSystemPrompt 时调用一次，结果存入 state.knowledgeContext。
//   后续 turn 直接使用缓存，不重新读取文件（同一 session 内知识不变）。

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  readAutoMemory,
  getProjectAutoMemoryPath,
  getUserAutoMemoryPath,
} from './auto-memory.js'

// ── 常量 ──────────────────────────────────────────────────────────────────────

const AGENTS_MD = 'AGENTS.md'
const AGENTS_LOCAL_MD = 'AGENTS.local.md'
const USER_AGENTS_PATH = path.join(os.homedir(), '.mini-code', AGENTS_MD)

// ── 路径查找 ──────────────────────────────────────────────────────────────────

/** 从 cwd 开始向上遍历目录，收集所有 AGENTS.md 文件路径。
 *  停止条件：
 *   a) 到达用户主目录（不再向上）
 *   b) 到达文件系统根目录
 *
 *  返回顺序：从根（最高层）到叶（最低层，即 cwd 最近的一层）。
 *  这样后续合并时从根到叶拼接，叶覆盖根（越具体优先级越高）。*/
function collectProjectAgentsMdPaths(cwd: string): string[] {
  const homedir = os.homedir()
  const paths: string[] = []

  let dir = path.resolve(cwd)

  while (true) {
    const candidate = path.join(dir, AGENTS_MD)
    if (fs.existsSync(candidate)) {
      paths.unshift(candidate)  // 插到前面，根在前叶在后
    }

    // 停止条件：到达 home 目录或根目录
    const parent = path.dirname(dir)
    if (dir === homedir || parent === dir) {
      break
    }
    dir = parent
  }

  return paths
}

// ── 文件读取 ──────────────────────────────────────────────────────────────────

/** 读取文件内容，失败时静默返回空字符串。*/
function safeReadFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

// ── 层合并 ────────────────────────────────────────────────────────────────────

/** 将多段非空文本合并，以双换行分隔，去除首尾空白。*/
function joinSections(sections: string[]): string {
  return sections
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n\n')
}

// ── buildKnowledgeContext ─────────────────────────────────────────────────────

/** 构建 5 层知识上下文字符串。
 *
 *  层合并策略（从低优先级到高优先级，最终字符串从上到下排列）：
 *  1. 用户 AGENTS.md（基础通用规则）
 *  2. 用户 auto-memory.md（用户级自动记忆）
 *  3. 项目 AGENTS.md 链（项目规则；从根到叶，叶覆盖根）
 *  4. 项目 auto-memory.md（项目级自动记忆）
 *  5. AGENTS.local.md（本地私人偏好，最高优先级）
 *
 *  @param cwd 当前工作目录（默认 process.cwd()）
 *  @returns   合并后的 Markdown 字符串；如果所有层均为空，返回空字符串*/
export function buildKnowledgeContext(cwd: string = process.cwd()): string {
  // 层 1：用户 AGENTS.md
  const userAgentsMd = safeReadFile(USER_AGENTS_PATH)

  // 层 2：用户 auto-memory.md
  const userAutoMemory = readAutoMemory(getUserAutoMemoryPath())

  // 层 3：项目 AGENTS.md 链（从根到叶，叶（cwd 最近）在后，优先级最高）
  const projectAgentsPaths = collectProjectAgentsMdPaths(cwd)
  const projectAgentsSections = projectAgentsPaths.map(safeReadFile)

  // 层 4：项目 auto-memory.md
  const projectAutoMemory = readAutoMemory(getProjectAutoMemoryPath(cwd))

  // 层 5：AGENTS.local.md（项目本地，gitignore）
  const agentsLocalMd = safeReadFile(path.join(cwd, AGENTS_LOCAL_MD))

  return joinSections([
    userAgentsMd,
    userAutoMemory,
    ...projectAgentsSections,
    projectAutoMemory,
    agentsLocalMd,
  ])
}
