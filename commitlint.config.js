export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'release', 'style', 'test', 'wip'],
    ],
    // scope 可选，但填写时必须在以下范围内
    'scope-enum': [
      1, // 1 = warning（不强制，填了就检查）
      'always',
      [
        // 包维度
        'core',       // packages/core — agent 引擎
        'cli',        // packages/cli — 终端 UI
        // 功能模块（随任务推进逐步扩充）
        'providers',  // AI Provider 注册表
        'agent',      // agentLoop 及相关逻辑
        'tools',      // 工具集（readFile / shell / grep 等）
        'permissions',// 权限系统
        'tui',        // 终端 UI 渲染（ChatInput / Ink）
        'mcp',        // MCP 协议集成
        'session',    // 会话持久化
        'knowledge',  // 知识系统（AGENTS.md）
        // 工程
        'deps',       // 依赖升级
        'config',     // 配置文件（tsconfig / esbuild 等）
        'docs',       // 文档
        'ci',         // CI/CD
      ],
    ],
    'scope-case': [2, 'always', 'lower-case'],
  },
}
