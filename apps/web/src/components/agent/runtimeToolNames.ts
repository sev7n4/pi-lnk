import { readFileSync, readdirSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * Fix 4：工具清单从运行时源码**派生**，替代手写 `ALL_LOCAL_TOOLS`。
 *
 * 手写清单的危险：漏登工具时清单与注册表「双双漏登」→ 测试仍绿，生产却落 ⚙ 兜底
 * （这正是 2026-10-14 实证 4 个工具漏登却无人察觉的根因）。改由扫描
 * `services/pi-runtime/src/tools` 得到权威清单，单元测与 CI 门禁共用同一口径。
 *
 * 本模块零别名依赖（只 import fs/path/url），可被 `verify-tool-tiering.ts`（tsx 运行）
 * 与 `toolPresentation.test.ts`（vitest 运行）同时复用。
 */

function statDirSafe(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, exts, out)
    else if (exts.some((e) => name.endsWith(e))) out.push(p)
  }
  return out
}

/** 从 cwd / 当前模块位置向上找 monorepo 根（含 services/pi-runtime/src/tools）。 */
export function resolveRepoRoot(): string {
  const candidates: string[] = [process.cwd()]
  try {
    candidates.push(dirname(fileURLToPath(import.meta.url)))
  } catch {
    /* CJS / import.meta 不可用时忽略，仅依赖 cwd */
  }
  for (const start of candidates) {
    let dir = start
    for (let i = 0; i < 8; i += 1) {
      if (statDirSafe(join(dir, 'services/pi-runtime/src/tools'))) return dir
      const parent = join(dir, '..')
      if (parent === dir) break
      dir = parent
    }
  }
  throw new Error(
    '[runtimeToolNames] 找不到 monorepo 根（services/pi-runtime/src/tools 不存在）：请在仓库根或 apps/web 下运行。',
  )
}

/** 运行时真实存在的工具名（去重、排序；含 tool_search 元工具）。 */
export function collectRuntimeToolNames(root: string = resolveRepoRoot()): string[] {
  const toolsDir = join(root, 'services/pi-runtime/src/tools')
  const names = new Set<string>()
  for (const file of walk(toolsDir, ['.ts']).filter((f) => !f.endsWith('.test.ts'))) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/^\s*name:\s*"([a-z_0-9]+)"/gm)) names.add(m[1])
    for (const m of src.matchAll(/runTool\(\s*"([a-z_0-9]+)"/g)) names.add(m[1])
  }
  names.add('tool_search') // 元工具，由 createLoadToolsTool 构造
  return [...names].sort()
}

/** TOOL_PRESENTATION 注册表中的工具名（2 空格缩进的顶层键）。 */
export function collectPresentedToolNames(root: string = resolveRepoRoot()): string[] {
  const file = join(root, 'apps/web/src/components/agent/toolPresentation.ts')
  const src = readFileSync(file, 'utf8')
  const names = new Set<string>()
  for (const m of src.matchAll(/^  ([a-z_][a-z_0-9]*):\s*\{/gm)) names.add(m[1])
  return [...names].sort()
}
