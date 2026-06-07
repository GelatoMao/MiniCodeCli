// @mini-code-cli/cli — CLI 入口（Task 7）
import { Chalk } from 'chalk'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import fs from 'node:fs'
import path from 'node:path'

import {
  PROVIDER_DETECTION_ORDER,
  createModelRegistry,
  getAvailableProviders,
  getEnvVarName,
  resolveModelId,
} from '@mini-code-cli/core'
import type { AgentOptions } from '@mini-code-cli/core'

import { startApp } from './app.js'

const chalk = new Chalk({ level: process.stderr.isTTY ? 3 : 0 })

// ── Node 版本检查 ──────────────────────────────────────────────────────────
const MIN_NODE_VERSION = [20, 19, 0]

function checkNodeVersion(): void {
  const [major, minor, patch] = process.versions.node.split('.').map((v) => parseInt(v, 10))
  const [reqMajor, reqMinor, reqPatch] = MIN_NODE_VERSION
  if (
    major < reqMajor ||
    (major === reqMajor && minor < reqMinor) ||
    (major === reqMajor && minor === reqMinor && patch < reqPatch)
  ) {
    console.error(
      `Error: Mini Code CLI requires Node.js >= ${MIN_NODE_VERSION.join('.')}, but you are running ${process.versions.node}.\n` +
        'Please upgrade Node.js: https://nodejs.org/',
    )
    process.exit(1)
  }
}

// ── 环境变量加载 ────────────────────────────────────────────────────────────
// 从 cwd 向上遍历查找 .env 文件，类似 dotenv 约定
function loadEnvFile(): void {
  let dir = process.cwd()
  while (true) {
    const envPath = path.join(dir, '.env')
    if (fs.existsSync(envPath)) {
      try {
        process.loadEnvFile(envPath)
      } catch {
        // 忽略解析错误
      }
      return
    }
    const parent = path.dirname(dir)
    if (parent === dir) break // 到达根目录
    dir = parent
  }
}

// ── 终端恢复 ──────────────────────────────────────────────────────────────
// 同步写入，确保即使 Ink 异常退出也能恢复终端状态
function resetTerminal(): void {
  if (!process.stdout.isTTY) return
  try {
    fs.writeSync(1, '\x1b[0m')    // 重置 SGR（颜色、粗体等）
    fs.writeSync(1, '\x1b[?2004l') // 关闭 bracketed paste
    fs.writeSync(1, '\x1b[?25h')  // 显示光标
    fs.writeSync(1, '\x1b[?1049l') // 退出备用屏幕（如有）
    fs.writeSync(1, '\r\n')        // 确保 shell 提示符换行
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
  } catch {
    // 终端可能已关闭（SIGHUP、SSH 断开）——忽略
  }
}

// ── 优雅退出 ──────────────────────────────────────────────────────────────
let shutdownInProgress = false

async function gracefulShutdown(exitCode: number): Promise<never> {
  if (shutdownInProgress) return undefined as never
  shutdownInProgress = true

  resetTerminal()
  process.exit(exitCode)
}

// ── 无 API Key 提示 ────────────────────────────────────────────────────────
function printNoApiKeyMessage(): void {
  const code = (s: string) => chalk.cyan(s)
  const envName = (s: string) => chalk.yellow(s)

  console.error(chalk.red.bold('Error: No API key found.') + '\n')
  console.error('Set at least one provider API key via environment variable:\n')
  for (const { envKey } of PROVIDER_DETECTION_ORDER) {
    console.error(`  ${envName(envKey)}`)
  }
  console.error(`\nExample:\n  ${code('export ANTHROPIC_API_KEY=sk-ant-...')}`)
  console.error(`\nAlternatively, put keys in a project-local ${chalk.bold('.env')} file (loaded from cwd upward).`)
}

// ── 主函数 ────────────────────────────────────────────────────────────────
async function main() {
  checkNodeVersion()
  loadEnvFile()

  // 解析 CLI 参数
  const argv = await yargs(hideBin(process.argv))
    .scriptName('mini-code')
    .usage('$0 [options] [prompt]')
    .option('model', {
      alias: 'm',
      type: 'string',
      describe: 'Model to use (e.g. sonnet, deepseek, openai:gpt-4.1)',
    })
    .option('trust', {
      alias: 't',
      type: 'boolean',
      default: false,
      describe: 'Trust mode: skip write operation confirmations',
    })
    .option('print', {
      alias: 'p',
      type: 'boolean',
      default: false,
      describe: 'Non-interactive mode: output result and exit',
    })
    .option('plan', {
      type: 'boolean',
      default: false,
      describe: 'Start the session in plan mode (read-only exploration)',
    })
    .option('max-turns', {
      type: 'number',
      describe: 'Cap on agent loop iterations per submission (default: unlimited)',
    })
    .help()
    .alias('h', 'help')
    .parse()

  const prompt = (argv._ as string[]).join(' ') || undefined

  const availableProviders = getAvailableProviders()

  // 如果没有配置任何 provider，显示帮助信息并退出
  if (availableProviders.length === 0) {
    printNoApiKeyMessage()
    // exit 0：这是用户配置提示，而非崩溃
    process.exit(0)
  }

  // 解析模型 ID
  let modelId = resolveModelId(argv.model)
  if (!modelId) {
    const requested = argv.model
    if (requested) {
      const provider = requested.split(':')[0]
      const envVar = getEnvVarName(provider) ?? `${provider.toUpperCase()}_API_KEY`
      console.error(`Error: ${envVar} is not set. Please set this environment variable to use ${requested}.`)
      process.exit(1)
    } else {
      printNoApiKeyMessage()
      process.exit(0)
    }
  }

  // 检查请求的 provider 是否已配置
  const requestedProvider = modelId.split(':')[0]
  if (!availableProviders.includes(requestedProvider)) {
    const envVar = getEnvVarName(requestedProvider) ?? `${requestedProvider.toUpperCase()}_API_KEY`
    if (argv.model) {
      console.error(`Error: ${envVar} is not set. Please set this environment variable to use ${argv.model}.`)
      process.exit(1)
    }
    const fallback = PROVIDER_DETECTION_ORDER.find(({ envKey }) => process.env[envKey])
    if (!fallback) {
      printNoApiKeyMessage()
      process.exit(0)
    }
    console.error(
      chalk.yellow(
        `Note: saved model '${modelId}' needs ${envVar}, which is not set. ` +
          `Falling back to '${fallback.defaultModel}'.`,
      ),
    )
    modelId = fallback.defaultModel
  }

  // 创建 provider 注册表和模型实例
  const providerRegistry = createModelRegistry()
  const model = providerRegistry.languageModel(modelId as `${string}:${string}`)

  const options: AgentOptions = {
    modelId,
    trustMode: argv.trust,
    printMode: argv.print,
    maxTurns: argv['max-turns'],
    permissionMode: argv.plan ? 'plan' : 'default',
    // task 工具（sub-agent）需要通过 modelRegistry 重建 LanguageModel 实例
    modelRegistry: providerRegistry,
  }

  // 启动 Ink 应用 — waitUntilExit 在 Ink 卸载时 resolve（包括 Ctrl+C）
  const waitUntilExit = startApp(model, options, prompt)
  await waitUntilExit()

  // 正常退出路径（包括 Ctrl+C 先卸载 Ink 的情况）
  await gracefulShutdown(0)
}

// ── 未处理 Promise 拒绝安全网 ──────────────────────────────────────────────
// Node 15+ 默认在未处理拒绝时终止进程。
// AI SDK 会创建多个独立 promise，在请求失败时可能各自拒绝。
// 我们尽量在 loop.ts 中处理，但时序竞争或新 SDK 路径可能漏掉一个。
process.on('unhandledRejection', (reason) => {
  if (process.env.DEBUG_STDOUT) {
    console.error('[unhandledRejection]', reason)
  }
})
process.on('uncaughtException', (err) => {
  if (process.env.DEBUG_STDOUT) {
    console.error('[uncaughtException]', err)
  }
})

// ── SIGINT 处理 ────────────────────────────────────────────────────────────
// 双 Ctrl+C 强制退出：第一次设置 exitCode=0；第二次立即退出并恢复终端。
let sigintCount = 0
process.on('SIGINT', () => {
  sigintCount++
  process.exitCode = 0
  if (sigintCount >= 2) {
    // 双 Ctrl+C → 用户要立即退出。跳过异步 cleanup，但必须恢复终端
    // 防止 raw mode / 隐藏光标 / bracketed paste 泄漏到 shell。
    resetTerminal()
    process.exit(0)
  }
})

main().catch((err) => {
  // 如果正在关闭（Ctrl+C 已卸载 Ink，waitUntilExit rejected），
  // 不作为致命错误处理 — gracefulShutdown 负责处理。
  if (sigintCount > 0 || shutdownInProgress) {
    return
  }
  console.error('Fatal error:', err)
  process.exit(1)
})
