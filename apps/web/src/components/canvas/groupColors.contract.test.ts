/**
 * 分组契约的**三方一致性**守卫（2026-10-21）。
 *
 * ⭐ 为什么必须有这条：分组色键白名单现在同时出现在三个地方 ——
 *   ① `packages/shared/src/canvasGroup.ts`（SSOT，zod enum）；
 *   ② `apps/web/src/components/canvas/groupColors.ts`（**re-export**，不是副本）；
 *   ③ `services/pi-runtime/src/tools/canvas-group.ts`（**镜像**，刻意不 import shared）。
 * ③ 是镜像而非 import 是设计决定（pi-runtime 的依赖面刻意不含 `@lnkpi/shared`，
 * 加进来会拖入整个 zod 依赖树）⇒ **漂移风险由本守卫兜住**。
 *
 * 漂移的后果不是「某个颜色显示不出来」，而是**静默失效**：
 * 服务端按 ① 拒掉一个 ③ 放行的键（或反之），Agent 拿到的是
 * "分组不存在"/"非法色键"这种与真实原因无关的结论 ⇒ 自我纠错被误导。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUP_COLOR_KEYS as SHARED_KEYS, parseGroupColorKey } from '@lnkpi/shared'
import { GROUP_COLOR_KEYS as WEB_KEYS } from '@/components/canvas/groupColors'

const HERE = dirname(fileURLToPath(import.meta.url))
// apps/web/src/components/canvas/ → 仓库根需上 5 层（canvas→components→src→web→apps→根）
const REPO = join(HERE, '../../../../..')

describe('分组色键白名单：三方一致（SSOT + 前端 re-export + 工具镜像）', () => {
  it('shared 的 8 键就是约定的 8 个（顺序也一致 ⇒ 前端色卡显示顺序不变）', () => {
    expect([...SHARED_KEYS]).toEqual([
      'neutral',
      'moss',
      'dusk',
      'clay',
      'celadon',
      'graphite',
      'rose',
      'plum',
    ])
  })

  it('⭐ 前端 re-export 的就是 shared 那份（不是自有副本）', () => {
    expect([...WEB_KEYS]).toEqual([...SHARED_KEYS])
  })

  it('⭐ pi-runtime 工具里的镜像与 shared 逐项一致（漂移会误导 Agent 自我纠错）', () => {
    const src = readFileSync(
      join(REPO, 'services/pi-runtime/src/tools/canvas-group.ts'),
      'utf8',
    )
    // 提取工具文件里的 GROUP_COLOR_KEYS 数组字面量
    const m = src.match(/export const GROUP_COLOR_KEYS = \[([\s\S]*?)\] as const/)
    expect(m, '工具文件里找不到 GROUP_COLOR_KEYS 数组').not.toBeNull()
    const toolKeys = [...m![1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]!)
    expect(toolKeys).toEqual([...SHARED_KEYS])
  })

  it('parseGroupColorKey：合法键原样返回、非法键落 null（写入口据此报错）', () => {
    expect(parseGroupColorKey('moss')).toBe('moss')
    expect(parseGroupColorKey('neutral')).toBe('neutral')
    expect(parseGroupColorKey('hacker666')).toBeNull()
    expect(parseGroupColorKey(null)).toBeNull()
    expect(parseGroupColorKey(undefined)).toBeNull()
    expect(parseGroupColorKey(123)).toBeNull()
  })

  it('⛔ 8 个键之外的值一律非法（防止白名单被悄悄放宽）', () => {
    for (const bad of ['red', 'RED', 'Moss', 'moss ', ' purple', '']) {
      expect(parseGroupColorKey(bad), `「${bad}」不该被接受`).toBeNull()
    }
  })
})
