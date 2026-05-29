# 任务 1：搭建 pnpm monorepo 双包结构

**参照源码（x-code-cli）：**
- `pnpm-workspace.yaml`
- `package.json` / `packages/core/package.json` / `packages/cli/package.json`
- `tsconfig.base.json` / `tsconfig.json` / `packages/*/tsconfig.json`
- `packages/cli/esbuild.config.js`

---

## 一、核心概念

### pnpm workspace 与 monorepo

monorepo 是把多个相关包放在同一个 Git 仓库的做法。x-code-cli 分成两个包：
- `core`：纯 TypeScript 的 agent 引擎，**零 UI 依赖**，可独立测试和发布
- `cli`：依赖 `core`，负责 Ink/React 终端界面

**为什么要分包而不是一个包？**
`core` 里的 agentLoop 逻辑和 `cli` 的渲染逻辑是两个关注点。分包之后，可以单独测试 `core`（不需要启动终端），未来也可以让别人把 `core` 作为库用在自己的项目里。

`pnpm-workspace.yaml` 只需一行就能声明所有子包：
```yaml
packages:
  - 'packages/*'
```

子包之间通过 `workspace:*` 协议互相引用，pnpm 会把它解析为本地符号链接，不走网络：
```json
// packages/cli/package.json
"dependencies": {
  "@mini-code-cli/core": "workspace:*"
}
```

### TypeScript Project References

`tsc -b`（build mode）的核心能力：**按依赖顺序编译多个包，并利用增量缓存跳过未修改的包**。

要启用它，每个子包的 `tsconfig.json` 必须设置 `"composite": true`，同时声明依赖关系：
```json
// packages/cli/tsconfig.json — 告诉 tsc：先编译 core，再编译 cli
{
  "references": [{ "path": "../core" }]
}
```

根 `tsconfig.json` 的 `"files": []` 是固定写法，意思是"根项目本身不编译任何文件，只充当构建入口"。

### NodeNext 模块解析与 `.js` 后缀

这是最容易踩坑的地方（见踩坑区块）。

`moduleResolution: "NodeNext"` 让 TypeScript 完全遵循 Node.js 原生 ESM 的解析规则——Node.js 要求 `import` 路径有**精确的扩展名**，TypeScript 不会自动补全。

结论：**写 `.ts` 源文件时，import 路径要写 `.js`**，因为编译产物是 `.js`：
```typescript
import { foo } from './utils.js'  // ✅ 正确
import { foo } from './utils'     // ❌ Node.js 运行时找不到
```

### esbuild 单文件打包

`core` 用 `tsc -b` 输出 `dist/`（保留类型声明，供 TypeScript 消费）。

`cli` 用 esbuild 打包成**一个文件** `dist/cli.js`，把所有依赖都 bundle 进去。好处是体积可控、启动快、不需要用户手动 `npm install`。

两个关键的 `external` 规则：
- `builtinModules`（`fs`、`path` 等）：Node.js 内置，运行时天然可用，不需要打包
- `@vscode/ripgrep`：包含平台相关的原生二进制 `.node` 文件，esbuild **无法打包**，必须排除

---

## 二、关键代码解析

### tsconfig.base.json — 严格模式基础配置

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",           // 生成 Node.js ESM 格式
    "moduleResolution": "NodeNext", // 遵循 Node.js 解析规则
    "strict": true,                 // 开启所有严格检查
    "declaration": true,            // 生成 .d.ts 类型声明
    "declarationMap": true,         // 生成 .d.ts.map，IDE 可跳转到源码
    "sourceMap": true               // 生成 .js.map，调试可还原到 .ts
  }
}
```

### esbuild.config.js — 详细解析

**为什么要有这个文件？**

`cli` 包的目标是生成一个可以在用户机器上直接运行的命令行程序。用 `tsc` 输出的话，用户还需要自己 `npm install` 几百个依赖包。用 esbuild 把所有依赖打进一个文件，用户拿到 `dist/cli.js` 就能直接用。

之所以写成脚本而不是命令行参数，是因为需要注册三个自定义插件，命令行无法表达插件逻辑。执行 `pnpm build` 实际上是运行 `node esbuild.config.js`。

**核心打包配置：**

```javascript
await esbuild.build({
  entryPoints: ['src/index.ts'], // 入口文件
  bundle: true,                  // 把所有 import 递归打包进一个文件
  platform: 'node',              // 目标平台 Node.js（影响内置模块处理方式）
  format: 'esm',                 // 输出 ES module 格式
  target: 'node20',              // 目标版本（影响语法是否降级）
  outfile: 'dist/cli.js',        // 输出单文件
  jsx: 'automatic',              // React 17+ JSX transform，不需要手动 import React
  sourcemap: true,               // 生成 .map，报错时可还原到 .ts 源码行号
  define: {
    'process.env.NODE_ENV': '"production"', // 静态替换，让 React 走生产路径
  },
})
```

**external — 哪些包不打包：**

```javascript
external: [
  ...builtinModules,                         // fs、path、os 等内置模块
  ...builtinModules.map((m) => `node:${m}`), // 同上，带 node: 前缀的写法
  '@vscode/ripgrep',                         // 原生二进制，无法打包
]
```

内置模块要写两遍：代码里有的写 `import fs from 'fs'`，有的写 `import fs from 'node:fs'`，esbuild 把这两种写法视为不同的 specifier，需要各加一条 external 规则。`@vscode/ripgrep` 包含 `.node` 原生二进制文件，esbuild 无法处理，必须排除，运行时从 `node_modules` 动态加载。

**banner — 注入文件头部：**

```javascript
banner: { js: '#!/usr/bin/env node\n' + ESM_POLYFILLS }
```

`#!/usr/bin/env node`（shebang）：Unix/macOS 看到这行知道用 `node` 执行，可以直接 `./dist/cli.js` 运行。

`ESM_POLYFILLS` 在文件头部定义 `__dirname`、`__filename`、`require` 三个变量的 ESM 实现。原因：ESM 里原生没有这三个 CJS 全局变量，但依赖树里的老包（Ink 依赖的部分包）代码里直接使用了它们。打包后这些调用都在同一个文件里，变量不存在就运行时报错。

**三个兼容性插件：**

| 插件 | 问题 | 解法 |
|------|------|------|
| `stubPlugin` | Ink 有对 `react-devtools-core` 的弱依赖，生产环境找不到这个包 esbuild 就报错 | 拦截所有对它的 import，替换为 `export default undefined` |
| `entitiesFixPlugin` | `entities` v4.x 把文件放在 `./lib/decode`，消费方用 `entities/decode`，路径不匹配 | 把 `entities/decode` 重定向到 pnpm store 里的实际路径 |
| `signalExitFixPlugin` | 依赖树里同时有 `signal-exit` v3（Ink 用，CJS 默认导出）和 v4（execa 用，ESM 具名导出），esbuild 只能打包一个版本，选哪个都有一方出错 | 注入 shim，同时提供默认导出和具名导出，两种 import 写法都兼容 |

### bin 字段 — 注册命令行入口

```json
// packages/cli/package.json
"bin": {
  "mini-code": "dist/cli.js",
  "mc": "dist/cli.js"
}
```

`pnpm install -g` 或 `npm link` 后，系统在 PATH 里创建 `mc` → `dist/cli.js` 的软链接。

---

## 三、踩坑 & 疑问

**Q：为什么 import 写 `.js` 但源文件是 `.ts`，TypeScript 不报错？**

初次看到这个写法会觉得很奇怪。原因是：TypeScript 在 NodeNext 模式下会把 `import './utils.js'` 理解为「我要引用的模块，编译后的路径是 `./utils.js`」，然后去找对应的 `./utils.ts` 源文件来做类型检查。也就是说，`.js` 扩展名在这里描述的是**编译产物**的路径，不是源文件。

**Q：`pnpm-workspace.yaml` 里的 `"pnpm"` 字段警告是什么意思？**

运行 `pnpm install` 时会看到：
```
[WARN] The "pnpm" field in package.json is no longer read by pnpm.
The following keys were ignored: "pnpm.onlyBuiltDependencies"
```
这是因为较新版本的 pnpm 把 `onlyBuiltDependencies` 等配置移到了 `.npmrc` 或 `pnpm-workspace.yaml` 里。x-code-cli 还在用旧格式，不影响功能，但后续可以迁移。

**Q：`"files": []` 在根 tsconfig.json 里是什么意思？**

`files: []` 明确告诉 TypeScript「根项目不直接编译任何文件」。如果不写，tsc 会尝试把根目录的所有 `.ts` 文件都纳入编译，可能导致 `packages/` 下的文件被重复编译。

**Q：`moduleResolution: "NodeNext"` 是主流配置吗？为什么不用 `bundler`？**

不算主流，但在 Node.js CLI 工具这个场景下是最合适的选择。

当前 TypeScript 主要的模块解析选项：

| 选项 | 适用场景 | 特点 |
|------|---------|------|
| `bundler` | 前端项目（Vite / webpack / Next.js） | 目前前端最流行，不需要写 `.js` 后缀，依赖打包工具处理路径 |
| `NodeNext` | Node.js 原生 ESM 项目（CLI 工具、后端服务） | 严格遵循 Node.js 解析规则，需要 `.js` 后缀 |
| `node16` | 同上（旧叫法） | 和 `NodeNext` 几乎一样，`NodeNext` 是它的持续更新版 |
| `node` | 旧式 CommonJS 项目 | 最宽松，不需要后缀，但只能生成 CJS |

**前端工程师更常见 `bundler`** 是因为 Vite、webpack、esbuild 会自己处理模块路径，不需要遵循 Node.js 的严格规则，写法更自然（不用写 `.js`）。Next.js 等前端框架默认也是这个。

**x-code-cli 用 `NodeNext` 的原因：** `core` 包用 `tsc -b` 输出，会被 Node.js 原生 `import` 加载（不经过打包工具）。用 `NodeNext` 保证 tsc 的类型检查和 Node.js 运行时的路径解析**行为一致**，不会出现「编译通过但运行时找不到模块」的问题。

结论：写前端项目用 `bundler`；写需要直接在 Node.js 运行的 ESM 库或 CLI 工具用 `NodeNext`。这里选 `NodeNext` 是针对场景的正确选择，不是过时。

---

## 四、依赖划分规则

monorepo 中有三个 `package.json`，划分原则是**谁用谁声明，按用途区分**。

| 放在哪里 | 放什么 | 判断依据 |
|---------|-------|---------|
| 根目录 `devDependencies` | 编译工具、测试框架、类型声明 | 不进入任何产物，只在开发阶段使用 |
| `core` 的 `dependencies` | 运行时必须的库 | `core` 作为库包发布，用户安装时需要这些依赖 |
| `cli` 的 `dependencies` | 运行时使用的库 | 会被 esbuild 打进单文件，发布后用户不需要单独安装 |

### 根目录 — 只放 devDependencies

根目录 `"private": true`，不生产任何代码，不发布。它只放**所有子包共享的开发工具**：

```json
"devDependencies": {
  "typescript": "^5.7.0",    // tsc 命令，编译所有包都要用
  "vitest": "^4.0.0",        // 测试框架，所有包的测试都跑这里
  "esbuild": "^0.27.0",      // cli 包打包用，放根目录避免重复安装
  "tsx": "^4.21.0",          // 开发时直接跑 .ts 文件
  "@types/node": "^22.0.0",  // Node.js 类型，core 和 cli 都要用
  "@types/react": "^19.0.0",
  "@types/yargs": "^17.0.0"
}
```

pnpm workspace 中，子包可以直接访问根目录安装的 devDependencies，**不需要重复声明**。所以 `typescript`、`vitest` 这类每个包都要用的工具，装一次就够。

### core 包 — 只放运行时 dependencies

`core` 是要发布的库包，它的 `dependencies` 会跟着包一起被用户安装：

```json
"dependencies": {
  "ai": "^6.0.0",               // AI SDK 核心，运行时必须有
  "@ai-sdk/anthropic": "^3.0.0",
  "@vscode/ripgrep": "^1.17.0", // grep 工具，运行时调用二进制
  "chalk": "^5.4.0",            // 终端颜色，运行时输出
  "execa": "^9.0.0",            // 执行 shell 命令，运行时必须有
  "zod": "^3.25.76"             // 参数校验，运行时必须有
}
```

`core` 里没有 `devDependencies`，因为 `tsc` 已在根目录，无需重复声明。

### cli 包 — dependencies 最终会被打包进单文件

`cli` 虽然也有 `dependencies`，但 esbuild 会把它们**全部打进 `dist/cli.js`**。用户全局安装 `mc` 命令后，这些包已经在产物里了，不需要单独存在于 `node_modules`：

```json
"dependencies": {
  "@mini-code-cli/core": "workspace:*", // 引用本地 core 包
  "ink": "...",     // 终端 React 渲染
  "react": "...",   // React 运行时
  "yargs": "...",   // 参数解析
  "chalk": "...",   // 终端颜色
  "marked": "..."   // Markdown 渲染
}
```

### 依赖版本冲突

**会存在**，pnpm 有专门机制处理。

**情况 1：不同子包声明了同一个包的不同版本**

比如 `core` 依赖 `chalk@^5.0.0`，`cli` 依赖 `chalk@^4.0.0`。pnpm 的做法是各装各的，互不干扰：
- pnpm 用内容寻址存储（`~/.pnpm-store`），每个版本只存一份实体文件
- 子包各自的 `node_modules` 通过硬链接指向 store，磁盘不重复占用
- `core/node_modules/chalk` → chalk 5.x，`cli/node_modules/chalk` → chalk 4.x，两者隔离

**情况 2：根目录和子包声明了同一个包的不同版本**

pnpm 以**子包自己声明的版本为准**，根目录版本只对没有自己声明的包生效。

**pnpm 的严格隔离（对比 npm/yarn）**

npm/yarn 会把所有包提升（hoist）到根目录的 `node_modules`，导致子包可以 `import` 到自己没声明的包——这个包某天被移除时代码就报错了，这叫**幽灵依赖**问题。pnpm 通过符号链接结构从根上杜绝了这个问题：子包只能访问自己 `package.json` 里声明的依赖。

**实际开发建议：**

| 场景 | 建议 |
|------|------|
| 同一个包多个子包都用 | 版本号保持一致，pnpm 自动复用 |
| 构建工具（typescript、vitest） | 只放根目录，子包不重复声明 |
| 需要排查冲突 | `pnpm why <包名>` 查看完整依赖链 |
| 强制锁定某个包的版本 | 在根目录 `pnpm.overrides` 里统一覆盖 |

---

## 五、与原项目的差异

| 项目 | x-code-cli | mini-code-cli | 原因 |
|------|-----------|---------------|------|
| 包名前缀 | `@x-code-cli/` | `@mini-code-cli/` | 区分两个项目 |
| 命令名 | `xc` / `x-code` | `mc` / `mini-code` | 同上 |
| devDependencies | 包含 eslint、husky、prettier 等 | 暂时省略 | 专注学习核心功能，工程规范工具后续按需添加 |
| core 依赖 | 8 个 AI provider + MCP + OCR 等 | 仅 Anthropic + OpenAI + DeepSeek | 按任务逐步添加，避免一开始依赖太多 |

---

## 六、项目常用命令

所有命令在 **monorepo 根目录**执行。

| 命令 | 说明 |
|------|------|
| `pnpm install` | 安装所有依赖，自动处理 workspace 符号链接 |
| `pnpm build` | 递归构建所有子包（`pnpm -r run build`） |
| `pnpm typecheck` | 全量类型检查（`tsc -b`，按依赖顺序） |
| `pnpm test` | 运行所有单元测试（`vitest run`） |
| `pnpm dev` | 先构建所有包，再以 tsx 启动 cli |

```bash
# 只构建某个子包
pnpm --filter @mini-code-cli/core run build
pnpm --filter @mini-code-cli/cli run build
```

**程序入口链路：**
```
mc / mini-code
  └→ dist/cli.js                     (esbuild 产物，开发时用 tsx src/index.ts)
       └→ packages/cli/src/index.ts   (yargs 参数解析、.env 加载、Ink 启动)
            └→ packages/cli/src/app.tsx              (render(<App />))
                 └→ packages/core/src/agent/loop.ts  (agentLoop 核心循环)
```

---

## 七、Commit 规范

**工具链：** husky + commitlint + @commitlint/config-conventional

### 为什么要有 commit 规范

- commit message 是代码历史的唯一说明，规范格式方便 `git log` 快速定位变更
- 后续可以基于规范自动生成 CHANGELOG
- 团队协作时统一格式，减少沟通成本

### 工具链工作原理

```
git commit -m "feat(core): xxx"
  │
  ▼
husky 触发 .husky/commit-msg hook
  │
  ▼
npx commitlint --edit $1
  │  读取 commitlint.config.js 的规则
  ▼
通过 → 提交成功
失败 → 终止提交，打印错误信息
```

- **husky**：Git hooks 管理工具，`pnpm install` 时自动通过 `prepare: "husky"` 脚本初始化
- **commitlint**：读取 commit message，对照规则校验格式
- **`.husky/commit-msg`**：Git 在写入 commit 前调用这个脚本，失败则阻断

### Commit message 格式

```
<type>(<scope>): <描述>

# scope 可选
```

**type 可选值：**

| type | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修复 bug |
| `docs` | 文档 |
| `build` | 构建相关（依赖、脚本） |
| `chore` | 杂项（不影响代码逻辑） |
| `refactor` | 重构 |
| `test` | 测试 |
| `wip` | 进行中（未完成的功能） |
| `perf` | 性能优化 |
| `style` | 格式调整（不影响逻辑） |
| `revert` | 回滚 |
| `ci` | CI/CD 配置 |
| `release` | 发版 |

**scope 预定义列表（`commitlint.config.js`）：**

| scope | 含义 |
|-------|------|
| `core` | packages/core — agent 引擎 |
| `cli` | packages/cli — 终端 UI |
| `providers` | AI Provider 注册表 |
| `agent` | agentLoop 及相关逻辑 |
| `tools` | 工具集（readFile / shell / grep 等） |
| `permissions` | 权限系统 |
| `tui` | 终端 UI 渲染（ChatInput / Ink） |
| `mcp` | MCP 协议集成 |
| `session` | 会话持久化 |
| `knowledge` | 知识系统（AGENTS.md） |
| `deps` | 依赖升级 |
| `config` | 配置文件（tsconfig / esbuild 等） |
| `docs` | 文档 |
| `ci` | CI/CD |

scope 填写时会校验是否在列表内（⚠ warning 级别，不阻断提交）；不填写完全合法。新增模块时在 `commitlint.config.js` 的 `scope-enum` 数组里追加即可。

**示例：**

```bash
git commit -m "feat(core): 搭建 pnpm monorepo 双包结构"
git commit -m "build(config): 配置 esbuild 打包脚本"
git commit -m "docs(docs): 添加任务1学习笔记"
git commit -m "feat: 不写 scope 也合法"
```

---

## 八、自测验证

任务 1 是纯工程框架，没有业务代码，验证以下三点即可。

### 验证 1：类型检查

```bash
pnpm typecheck
# 实际执行：tsc -b
# tsc -b = build mode，读取根目录 tsconfig.json 的 references，
# 按 core → cli 的依赖顺序依次类型检查，
# 利用 .tsbuildinfo 增量缓存跳过未修改的文件。
```

期望：无任何报错，静默退出。

### 验证 2：构建产物

```bash
pnpm build
# 实际执行：pnpm -r run build
# -r = recursive，遍历所有子包，依次执行各自的 build 脚本：
#   packages/core: tsc -b   → 输出 dist/index.js + dist/index.d.ts
#   packages/cli:  node esbuild.config.js → 输出 dist/cli.js（单文件打包）
```

期望：
- `packages/core/dist/` 生成 `index.js`、`index.d.ts`、sourcemap
- `packages/cli/dist/` 生成 `cli.js`（esbuild 单文件产物）

```bash
node packages/cli/dist/cli.js
# 直接用 Node.js 运行打包产物，验证：
# 1. esbuild 打包没有遗漏依赖（运行时不会报 Cannot find module）
# 2. shebang 和 ESM polyfills 注入正确（__dirname 等变量可用）
# 期望输出：mini-code-cli
```

### 验证 3：workspace 符号链接

```bash
ls packages/cli/node_modules/@mini-code-cli/
# 检查 pnpm 是否正确处理了 "workspace:*" 协议：
# pnpm install 时会在 cli/node_modules/ 下创建指向本地 core 包的符号链接，
# 而不是从 npm 下载。有 core 目录说明链接建立成功，
# cli 代码里 import from '@mini-code-cli/core' 可以正确解析。
# 期望输出：core
```

### 实际结果（✅ 全部通过）

| 验证项 | 结果 |
|--------|------|
| `pnpm typecheck` | ✅ 无报错 |
| `pnpm build` | ✅ core 和 cli 都编译成功 |
| `core/dist/` 产物 | ✅ `index.js` + `index.d.ts` + sourcemap |
| `cli/dist/cli.js` | ✅ esbuild 单文件产物生成 |
| `node dist/cli.js` | ✅ 输出 `mini-code-cli`，产物可执行 |
| workspace 符号链接 | ✅ `cli/node_modules/@mini-code-cli/core` 存在 |

---

[← 返回索引](./README.md) | [任务 2 →](./task-02-provider-registry.md)
