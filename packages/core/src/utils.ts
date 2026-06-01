// @mini-code-cli/core — 共享常量与工具函数
import os from 'node:os'
import path from 'node:path'

/** 项目本地配置目录名 */
export const MINI_CODE_DIR = '.mini-code'

/** 用户级配置目录（~/.mini-code）。模块加载时冻结。 */
export const USER_MINI_CODE_DIR = path.join(os.homedir(), '.mini-code')
