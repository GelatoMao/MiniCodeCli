// @mini-code-cli/core — Shell 命令语义辅助（与 shell 类型无关）。
//
// 将复合命令拆分为子命令并分类（只读/破坏性），仅用于权限检查。
// 实际执行（spawn 子进程）在 shell-provider.ts 中。
//
// 设计亮点：
// 1. 引号感知分词：单引号/双引号内的分隔符不触发切分
// 2. 大括号深度跟踪：处理 PowerShell hash 字面量和脚本块中的分号
// 3. 预编译正则：性能关键路径（权限检查 hot path）避免重复编译
// 4. PowerShell 控制流特判：if/foreach 等不是命令本身，需扫描内部 cmdlet
export type { ShellType } from './shell-provider.js'

/**
 * 按管道/链式操作符拆分复合 shell 命令，用于权限检查。
 *
 * 拆分规则（引号和大括号内的字符不触发）：
 *   |   — 管道
 *   &&  — 逻辑与（短路）
 *   ;   — 顺序执行
 *   ||  — 逻辑或（短路）
 *
 * 大括号跟踪的意义：
 *   `Select-Object @{N='Dir';E={$_.Name}},Count` 中的 `;` 是字段分隔符
 *   而非语句边界。不跟踪深度的话，分词器会把字面量切成两半，
 *   导致尾部被误判为独立命令，触发不必要的权限提示。
 *   POSIX `{ … ; }` 大括号组也被同样处理——副作用可接受，
 *   内容仍会被 isDestructive 端到端扫描。
 */
export function splitShellCommands(cmd: string): string[] {
  const parts: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let braceDepth = 0

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    const next = cmd[i + 1]

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += ch
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += ch
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '{') {
        braceDepth++
        current += ch
      } else if (ch === '}' && braceDepth > 0) {
        braceDepth--
        current += ch
      } else if (braceDepth > 0) {
        // 大括号内，原样追加
        current += ch
      } else if (ch === '|' && next === '|') {
        parts.push(current)
        current = ''
        i++ // 跳过下一个 |
      } else if (ch === '&' && next === '&') {
        parts.push(current)
        current = ''
        i++ // 跳过下一个 &
      } else if (ch === '|') {
        parts.push(current)
        current = ''
      } else if (ch === ';') {
        parts.push(current)
        current = ''
      } else {
        current += ch
      }
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)

  return parts.map((p) => p.trim()).filter(Boolean)
}

// ─── 只读命令白名单 ───

/** 可以自动允许执行的 Unix/PowerShell 命令 */
const READ_ONLY_COMMANDS = [
  // POSIX shell 只读工具
  'cd',
  'ls',
  'dir',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'echo',
  'which',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'env',
  'printenv',
  'find',
  'tree',
  'sort',
  'uniq',
  'grep',
  'cut',
  'nl',
  'basename',
  'dirname',
  'realpath',
  // PowerShell 只读 cmdlet（在下方的匹配中大小写不敏感）
  // 精选自 codex/opencode 安全列表：只读或只做对象管道变换的 cmdlet。
  // 能写文件、启动进程或 eval 用户代码的均被排除（Invoke-Expression、
  // Set-*、New-*、Remove-*、Start-Process、Set-Content、Out-File 等）
  'Get-ChildItem',
  'Get-Location',
  'Set-Location',
  'Push-Location',
  'Pop-Location',
  'Get-Content',
  'Get-Item',
  'Get-ItemProperty',
  'Get-Date',
  'Get-Process',
  'Get-Service',
  'Get-Command',
  'Get-Help',
  'Get-Member',
  'Get-Variable',
  'Get-Alias',
  'Get-PSDrive',
  'Get-Module',
  'Get-History',
  'Get-CimInstance',
  'Select-String',
  'Select-Object',
  'Sort-Object',
  'Group-Object',
  'Where-Object',
  'ForEach-Object',
  'Measure-Object',
  'Compare-Object',
  'Tee-Object',
  'Format-Table',
  'Format-List',
  'Format-Wide',
  'Format-Custom',
  'Out-String',
  'Out-Default',
  'Out-Host',
  'Write-Output',
  'Write-Host',
  'Write-Verbose',
  'Write-Debug',
  'Write-Information',
  'ConvertTo-Json',
  'ConvertFrom-Json',
  'ConvertTo-Csv',
  'ConvertFrom-Csv',
  'ConvertTo-Xml',
  'ConvertFrom-Xml',
  'ConvertTo-Html',
  'Resolve-Path',
  'Split-Path',
  'Join-Path',
  'Convert-Path',
  'Test-Path',
]

/** 只读 git 子命令 */
const READ_ONLY_GIT_SUBCOMMANDS = ['status', 'log', 'diff', 'branch', 'show', 'remote', 'tag', 'stash list', 'reflog']

// 预编译正则（性能关键路径）。`/i` 标志使匹配大小写不敏感，
// 这样 `Get-ChildItem` / `get-childitem` / `GET-CHILDITEM` 都能命中——
// PowerShell 本身就是大小写不敏感的，而 `dir` / `DIR` 在 Windows cmd 中也都应允许。
const READ_ONLY_REGEX = new RegExp(
  `^\\s*(${READ_ONLY_COMMANDS.join('|')}|git\\s+(${READ_ONLY_GIT_SUBCOMMANDS.join('|')}))\\b`,
  'i',
)

// ─── 破坏性命令模式 ───

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // ── 文件系统破坏 ──
  /\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive)/,
  /\brm\s+-rf\b/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\b(chmod|chown)\s+.*\//,
  />\s*\/dev\/sd/,
  /\bformat\b/,
  /\bRemove-Item\s+.*-Recurse/i,
  /\bRemove-Item\s+.*-Force/i,
  /\bdel\s+\/[sS]/,
  /\brmdir\s+\/[sS]/,

  // ── Git 破坏性操作 ──
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+checkout\s+--\s*\./,
  /\bgit\s+rebase\b/,
  /\bgit\s+filter-branch\b/,
  /\bgit\s+reflog\s+expire\b/,
  /\bgit\s+gc\s+--prune\b/,

  // ── 远程代码执行 / 下载并执行 ──
  /\bcurl\s.*\|\s*(ba)?sh\b/,
  /\bwget\s.*\|\s*(ba)?sh\b/,
  /\bcurl\s.*\|\s*python/,
  /\bwget\s.*\|\s*python/,

  // ── 系统控制 ──
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+[06]\b/,
  /\bsystemctl\s+(stop|disable|mask|halt|poweroff)\b/,
  /\bkillall\b/,
  /\bpkill\s+-9\b/,
  /\bStop-Computer\b/i,
  /\bRestart-Computer\b/i,

  // ── 数据库破坏 ──
  /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bDELETE\s+FROM\s+\S+\s*;?\s*$/im,

  // ── 容器/基础设施破坏 ──
  /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/,
  /\bkubectl\s+delete\b/,

  // ── 环境污染（发布到公共源） ──
  /\bnpm\s+publish\b/,
  /\bpnpm\s+publish\b/,
  /\byarn\s+publish\b/,

  // ── 磁盘/分区 ──
  /\bfdisk\b/,
  /\bparted\b/,
]

// ─── PowerShell 控制流特判 ───

// READ_ONLY_COMMANDS 中含 `-` 的小写子集，O(1) 查找。
// 没有 `-` 的都是 POSIX 命令，与 PowerShell 控制流启发式无关。
const READ_ONLY_CMDLET_SET = new Set(READ_ONLY_COMMANDS.filter((c) => c.includes('-')).map((c) => c.toLowerCase()))

// PowerShell 控制流关键字，它们包裹着 `{ … }` 主体。
// 当片段以其中之一开头时，READ_ONLY_REGEX（只检查首词）的结果是错的——
// `if`、`foreach`、`try` 等本身不是命令；实际工作在大括号内。
// codex / gemini-cli 等工具用真实的 PowerShell AST 解析器来处理；
// 我们没有 AST 解析器，所以用 Verb-Noun cmdlet 扫描加执行调用模式保护。
const PS_CONTROL_FLOW_RE = /^\s*(?:if|elseif|else|for|foreach|while|switch|try|catch|finally|do)\b/i

// 出现在控制流片段中就关掉只读启发式的模式：
//   `& "C:\bin\foo.exe" arg`  — 调用操作符 + 路径/字符串/变量
//   `& $cmd`                  — 同上，通过变量调用
//   `. .\script.ps1`          — dot sourcing
//   `. $script`               — dot sourcing via 变量
//
// dot sourcing 模式要求 `.` 之后有空白，避免 `.Property` 访问和
// `Get-Content .\file` 误报。
const PS_CALL_OP_RE = /&\s*["'$./\\]/
const PS_DOT_SOURCING_RE = /(?:^|[\s;{(])\.\s+\S/

// Verb-Noun 词形查找（宽松）+ 严格验证。
// FIND 匹配任何带 `-` 的词（包括路径如 `x-code-cli`）；
// STRICT 强制首字母大写的 Verb 和 Noun，路径会失败。
const VERB_NOUN_FIND_RE = /\b[A-Za-z]+(?:-[A-Za-z0-9]+)+\b/g
const VERB_NOUN_STRICT_RE = /^[A-Z][a-z]+(?:-[A-Z][A-Za-z0-9]*)+$/

/**
 * 对于 PowerShell 控制流片段，当且仅当其中所有 cmdlet 都在只读集合内，
 * 且没有任意代码调用（`&` 操作符、dot sourcing）时，返回 true。
 *
 * `if (Test-Path X) { Get-Content X }`     → true
 * `if (Test-Path X) { Set-Content X foo }` → false（Set-Content 不是只读）
 * `if (Test-Path X) { & "evil.exe" }`      → false（调用操作符）
 * `if (Test-Path X) { . .\\evil.ps1 }`     → false（dot sourcing）
 *
 * 对于非控制流片段，直接返回 false，将判断权交给调用方的"ask"路径。
 */
function isReadOnlyControlFlow(cmd: string): boolean {
  if (!PS_CONTROL_FLOW_RE.test(cmd)) return false
  if (PS_CALL_OP_RE.test(cmd)) return false
  if (PS_DOT_SOURCING_RE.test(cmd)) return false

  let found = 0
  for (const match of cmd.matchAll(VERB_NOUN_FIND_RE)) {
    const name = match[0]
    if (!VERB_NOUN_STRICT_RE.test(name)) continue
    found++
    if (!READ_ONLY_CMDLET_SET.has(name.toLowerCase())) return false
  }
  return found > 0
}

/** 检查子命令是否为只读（可以自动允许） */
export function isReadOnly(cmd: string): boolean {
  const c = cmd.trim()
  if (READ_ONLY_REGEX.test(c)) return true
  return isReadOnlyControlFlow(c)
}

/** 检查子命令是否破坏性（应该拒绝） */
export function isDestructive(cmd: string): boolean {
  const c = cmd.trim()
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(c))
}
