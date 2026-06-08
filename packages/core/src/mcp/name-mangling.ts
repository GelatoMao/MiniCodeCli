// @mini-code-cli/core — MCP 工具名称处理
//
// MCP 工具名称冲突问题：
//   不同 MCP 服务器可能导出同名工具（如两个服务器都有 "readFile"）。
//   AI SDK 的 tools 对象是扁平 Record<string, tool>，key 直接作为工具名。
//   如果两个服务器有同名工具，后者会覆盖前者，导致路由错误。
//
// 解决方案：命名空间前缀（Name Mangling）
//   每个 MCP 工具在注册到 toolRegistry 时加上服务器名前缀：
//     <serverName>__<toolName>
//   例如：
//     filesystem 服务器的 readFile → filesystem__readFile
//     git 服务器的 readFile        → git__readFile
//
// 分隔符选择 "__"（双下划线）：
//   - 标准 MCP 工具名通常用单下划线或 camelCase，双下划线不常见
//   - 避免与合法工具名（如 "read_file"）冲突
//   - 与原始 Python MCP 实现保持一致

// ── SEPARATOR ─────────────────────────────────────────────────────────────────

export const MCP_NAME_SEPARATOR = '__'

// ── mangleName ────────────────────────────────────────────────────────────────

/** 将服务器名和工具名拼接为命名空间化的工具名。
 *
 *  @param serverName  服务器名称（如 "filesystem"）
 *  @param toolName    server-local 工具名（如 "readFile"）
 *  @returns           命名空间化工具名（如 "filesystem__readFile"）
 *
 *  @example
 *  mangleName('filesystem', 'readFile')  // → 'filesystem__readFile'
 *  mangleName('git', 'status')           // → 'git__status'
 */
export function mangleName(serverName: string, toolName: string): string {
  return `${serverName}${MCP_NAME_SEPARATOR}${toolName}`
}

// ── demangleName ──────────────────────────────────────────────────────────────

/** 将命名空间化工具名拆分为服务器名和 server-local 工具名。
 *
 *  如果输入不含分隔符，返回 null（非 MCP 工具名）。
 *
 *  @param mangledName  命名空间化工具名（如 "filesystem__readFile"）
 *  @returns            { serverName, toolName } 或 null
 *
 *  @example
 *  demangleName('filesystem__readFile')  // → { serverName: 'filesystem', toolName: 'readFile' }
 *  demangleName('readFile')              // → null（非 MCP 工具）
 *  demangleName('a__b__c')              // → { serverName: 'a', toolName: 'b__c' }（服务器名只取第一段）
 */
export function demangleName(mangledName: string): { serverName: string; toolName: string } | null {
  const idx = mangledName.indexOf(MCP_NAME_SEPARATOR)
  if (idx === -1) return null
  return {
    serverName: mangledName.slice(0, idx),
    toolName: mangledName.slice(idx + MCP_NAME_SEPARATOR.length),
  }
}

// ── isMangledName ─────────────────────────────────────────────────────────────

/** 判断一个工具名是否是 MCP 命名空间工具名（含 "__" 前缀）。
 *
 *  @example
 *  isMangledName('filesystem__readFile')  // → true
 *  isMangledName('readFile')              // → false
 *  isMangledName('shell')                 // → false
 */
export function isMangledName(toolName: string): boolean {
  return toolName.includes(MCP_NAME_SEPARATOR)
}
