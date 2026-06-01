// @mini-code-cli/core — 工具层共享辅助函数
//
// 本文件专门存放被多个工具文件共用、但不值得单独建模块的小型辅助函数。
// 当前唯一的导出是 getRipgrepPath()，被 glob.ts 和 grep.ts 共用。
//
// 【ESM + CJS 兼容性问题】
// `@mini-code-cli/core` 是 ESM 包（package.json 中 "type": "module"），
// 这意味着全局 `require` 函数在运行时不存在。
// 但 `@vscode/ripgrep` 是纯 CJS 包，通过 `module.exports.rgPath` 暴露二进制路径，
// 没有 ESM 构建版本。
//
// 解决方案：使用 Node.js 内置的 `createRequire(import.meta.url)` 创建一个
// 局部 require 函数，专门用于加载这个 CJS 模块。
// `import.meta.url` 是当前 ESM 模块的文件 URL，createRequire 以此为基准
// 解析相对路径和模块查找。
import { createRequire } from 'node:module'

const _require = createRequire(import.meta.url)

/**
 * ripgrep 二进制路径缓存。
 * 进程生命周期内只解析一次（懒加载），后续复用缓存值。
 * null 表示尚未初始化。
 */
let _rgPath: string | null = null

/**
 * 解析 ripgrep 二进制文件的路径。
 *
 * 优先使用 @vscode/ripgrep 包内置的预编译二进制（按平台和架构打包），
 * 如果包不可用（postinstall 未运行、CI 环境等），回退到 PATH 中的系统 `rg`。
 *
 * 结果会被缓存到模块级变量，后续调用直接返回缓存值，
 * 避免每次工具调用都重复 require 解析的开销。
 *
 * @returns ripgrep 可执行文件的绝对路径，或回退时的命令名 "rg"
 */
export function getRipgrepPath(): string {
  // 已缓存则直接返回，跳过 require 开销
  if (_rgPath) return _rgPath
  try {
    // @vscode/ripgrep 通过 rgPath 字段暴露平台对应的预编译二进制路径
    const rg = _require('@vscode/ripgrep') as { rgPath: string }
    _rgPath = rg.rgPath
  } catch {
    // 包不可用时回退到系统 PATH 中的 rg 命令
    // 开发机通常已通过 homebrew/apt 安装了系统级 ripgrep
    _rgPath = 'rg'
  }
  return _rgPath
}
