// @mini-code-cli/core — 跨平台 shell 提供者抽象。
//
// 每种 shell（bash/zsh、PowerShell）都有独特的参数传递和字符集编码方式。
// 将这些差异封装在 ShellProvider 接口背后，意味着工具执行层不需要
// 包含平台分支逻辑，也不用手写 PowerShell 的引号转义。
//
// 设计决策：
// - POSIX shell（bash/zsh）：直接用 `-c "command"` 透传命令字符串
// - PowerShell：将命令 base64 编码后通过 `-EncodedCommand` 传入，
//   彻底避免外层引号逃逸问题（base64 字符集只有 [A-Za-z0-9+/=]）
// - 缓冲区上限 20MB：匹配 Claude Code 的 ripgrep 缓冲区大小，
//   既能处理真实工作负载，又能防止意外的 `yes` / `find /` 耗尽内存
import { type ResultPromise, execa } from 'execa'

import os from 'node:os'

export type ShellType = 'bash' | 'zsh' | 'powershell'

// 20 MB — 匹配 Claude Code 的 ripgrep 缓冲区大小；
// 足够真实工作负载，又小到可以防止意外命令吃掉所有内存。
// 超出时 execa 会用 SIGTERM 终止子进程，并报 "maxBuffer exceeded" 错误。
export const MAX_SHELL_BUFFER = 20 * 1024 * 1024

export interface ShellSpawnOptions {
  timeout: number
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** 当此信号中止时，execa 会杀掉子进程树。
   *  用于响应用户的 Esc / Ctrl+C 取消操作，无需等待超时。 */
  signal?: AbortSignal
}

export interface ShellProvider {
  type: ShellType
  spawn(command: string, opts: ShellSpawnOptions): ResultPromise
}

function createPosixProvider(executable: string, type: 'bash' | 'zsh'): ShellProvider {
  return {
    type,
    spawn(command, opts) {
      return execa(executable, ['-c', command], {
        timeout: opts.timeout,
        maxBuffer: MAX_SHELL_BUFFER,
        cwd: opts.cwd,
        reject: false,         // 非零退出码不抛异常，由调用方检查 exitCode
        cancelSignal: opts.signal,
        env: { ...(opts.env ?? process.env), PYTHONIOENCODING: 'utf-8' },
      })
    },
  }
}

// PowerShell 的 -EncodedCommand 接受 base64 UTF-16LE 编码的命令。
// 字符集为 [A-Za-z0-9+/=]，可以安全穿越任何外层引号层（cmd.exe、
// Node 的 Windows argv 序列化器等），因此用户命令中永远不需要转义引号。
function encodePowerShellCommand(psCommand: string): string {
  return Buffer.from(psCommand, 'utf16le').toString('base64')
}

function createPowerShellProvider(executable: string): ShellProvider {
  return {
    type: 'powershell',
    spawn(command, opts) {
      // 在同一个 -EncodedCommand payload 中注入前缀/后缀：
      //   • OutputEncoding = UTF-8 — PS 5.1 在中文 Windows 上默认用 GBK 写输出，
      //     用 UTF-8 解码会出现乱码。避免使用 `chcp 65001 >nul && ...` 包装。
      //   • ProgressPreference = SilentlyContinue — 首次运行时模块加载
      //     会在 stderr 输出 CLIXML 进度记录，造成无关噪音。
      //   • 末尾的 `exit` — PowerShell 不会将 $LASTEXITCODE 传播到
      //     自身的退出码。如果不加这个，`git push` 失败（退出码1）
      //     或 `tsc` 失败（退出码2）都会变成 exit 0，丢失错误信号。
      //     优先使用 $LASTEXITCODE（有原生可执行程序运行时）；
      //     对于仅有 cmdlet 的管道，回退到 $?。
      const wrapped = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        "$ProgressPreference = 'SilentlyContinue'",
        command,
        '$__ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
        'exit $__ec',
      ].join('\n')
      return execa(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(wrapped)], {
        timeout: opts.timeout,
        maxBuffer: MAX_SHELL_BUFFER,
        cwd: opts.cwd,
        reject: false,
        cancelSignal: opts.signal,
        env: { ...(opts.env ?? process.env), PYTHONIOENCODING: 'utf-8' },
      })
    },
  }
}

/**
 * 根据当前操作系统返回合适的 ShellProvider。
 *
 * 逻辑：
 * - Windows：若 $SHELL 指向 bash/zsh（Git Bash / MSYS2 等），优先使用 POSIX 兼容模式；
 *   否则使用 PowerShell。
 * - 其他平台（macOS/Linux）：读取 $SHELL 环境变量，区分 zsh/bash。
 */
export function getShellProvider(): ShellProvider {
  if (os.platform() === 'win32') {
    // Git Bash / MSYS2 / Cygwin 将 $SHELL 设为 Unix 风格路径。
    // 若存在则优先使用，这样 Unix 工具链可以正常工作。
    const shell = process.env.SHELL
    if (shell && /\b(bash|zsh)$/i.test(shell)) {
      return createPosixProvider(shell, shell.endsWith('zsh') ? 'zsh' : 'bash')
    }
    return createPowerShellProvider('powershell.exe')
  }
  const userShell = process.env.SHELL ?? '/bin/bash'
  return createPosixProvider(userShell, userShell.endsWith('zsh') ? 'zsh' : 'bash')
}
