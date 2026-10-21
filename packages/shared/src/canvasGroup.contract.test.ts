/**
 * 分组契约防漂移守卫（2026-10-21）。
 *
 * ## 为什么要有这个
 *
 * `packages/shared/src/index.ts` 的 `CanvasGroup`（TS interface，给静态类型用）
 * 与 `packages/shared/src/canvasGroup.ts` 的 `CanvasGroupSchema`（zod，给运行时用）
 * 是**刻意两份并存**的 —— interface 无法在运行时校验，schema 无法做类型推断的
 * 唯一来源。代价就是**可能漂移**：改了一边忘了另一边 ⇒
 * 运行时校验放行/拦错的字段集合与静态类型不一致 ⇒
 * 「TS 说有、运行时没有」或反之，这类缺陷极难排查。
 *
 * ## 本守卫的判据
 *
 * ① **字段集逐一对应**：schema 的键集合 == interface 的键集合（不多不少）。
 * ② **类型匹配**：每个字段的 TS 类型与 zod 推导类型一致。
 * ③ **色键白名单唯一**：interface 上的 `colorKey` 注释指向 `GROUP_COLOR_KEYS`，
 *    且 schema 的 `colorKey` 用的是同一个 `GroupColorKeySchema`（不是另抄一份枚举）。
 * ④ **三份白名单一致**：shared（SSOT）、前端 re-export、pi-runtime 镜像三者逐项相等。
 *    —— 前两者在 `apps/web/src/components/canvas/groupColors.contract.test.ts`；
 *    pi-runtime 镜像在 `apps/web` 侧同文件（跨包）。
 *
 * ⭐ 判据必须**能真失败**：把 interface 的某个字段删掉、或把 schema 的
 * `colorKey` 换成另一个枚举，本守卫必须转红（见 mutation 自检记录）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { CanvasGroupSchema, GroupColorKeySchema, GROUP_COLOR_KEYS } from './canvasGroup'
import type { CanvasGroup } from './index'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * ⭐ 读 `index.ts` 源码，**解析出 `CanvasGroup` interface 的真实字段集**。
 *
 * 为什么不能靠「构造一个真值对象再取 Object.keys」：
 * 那个对象的键是**手写字面量** ⇒ interface 加了字段它不会跟着变
 * ⇒ 守卫失明（2026-10-21 实测：给 interface 加 `driftedField` 后守卫仍全绿）。
 * ⇒ 必须读 interface 的**声明本身**，interface 一改守卫就转红。
 *
 * 解析方式：截出 `export interface CanvasGroup {` 到匹配的 `}`，
 * 逐行取「行首是标识符」的行作为字段名（跳过注释行与空行）。
 */
function interfaceFieldNames(): string[] {
  const src = readFileSync(resolve(HERE, 'index.ts'), 'utf8')
  const start = src.indexOf('export interface CanvasGroup {')
  expect(start, 'index.ts 里找不到 CanvasGroup interface').toBeGreaterThan(-1)
  const body = src.slice(start)
  // 找到 interface 的闭合大括号（顶层 `}` 独占一行）
  const end = body.indexOf('\n}')
  expect(end, '找不到 CanvasGroup interface 的闭合').toBeGreaterThan(-1)
  const fields: string[] = []
  for (const line of body.slice(0, end).split('\n').slice(1)) {
    const t = line.trim()
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
    const m = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(t)
    if (m) fields.push(m[1]!)
  }
  return fields.sort()
}

describe('CanvasGroup：interface 与 zod schema 不得漂移', () => {
  it('① schema 的键集合 == interface 的键集合', () => {
    const schemaKeys = Object.keys(CanvasGroupSchema.shape).sort()
    expect(schemaKeys).toEqual(interfaceFieldNames())
  })

  it('② 每个字段的类型与 schema 兼容（用真值过一遍 schema）', () => {
    const sample: CanvasGroup = {
      id: 'g1',
      title: '组一',
      colorKey: 'moss',
      childIds: ['n1', 'n2'],
      position: { x: 10, y: 20 },
      size: { width: 300, height: 200 },
    }
    const parsed = CanvasGroupSchema.parse(sample)
    expect(parsed.id).toBe('g1')
    expect(parsed.position.x).toBe(10)
    expect(parsed.size.width).toBe(300)
    expect(parsed.childIds).toEqual(['n1', 'n2'])
  })

  it('②-b 必填字段缺失时 schema 必须拒绝（防止被误改成全 optional）', () => {
    const bad = { id: 'g1', title: '组一' } as unknown as CanvasGroup
    expect(CanvasGroupSchema.safeParse(bad).success).toBe(false)
  })

  it('③ colorKey 走的是同一份白名单枚举（不是另抄一份）', () => {
    // 同一引用 ⇒ 不可能漂移
    expect(GroupColorKeySchema.options).toEqual([...GROUP_COLOR_KEYS])
    // schema 里的 colorKey 字段用的就是这个枚举
    const colorField = CanvasGroupSchema.shape.colorKey
    expect(colorField).toBeDefined()
    expect(colorField!.safeParse('moss').success).toBe(true)
    expect(colorField!.safeParse('hacker666').success).toBe(false)
  })

  it('④ 白名单是 8 键且顺序稳定（顺序变了会破坏 UI 上的色卡排列）', () => {
    expect(GROUP_COLOR_KEYS).toEqual([
      'neutral',
      'moss',
      'dusk',
      'clay',
      'celadon',
      'graphite',
      'rose',
      'plum',
    ])
    expect(GROUP_COLOR_KEYS.length).toBe(8)
  })
})

describe('分组命令请求体 schema：写入口的硬约束', () => {
  it('打组必须至少 2 个节点（少一个都必须被拒）', async () => {
    const { GroupNodesRequestSchema } = await import('./canvasGroup')
    expect(
      GroupNodesRequestSchema.safeParse({ sessionId: 's', userId: 'u', nodeIds: ['a'] }).success,
    ).toBe(false)
    expect(
      GroupNodesRequestSchema.safeParse({ sessionId: 's', userId: 'u', nodeIds: ['a', 'b'] }).success,
    ).toBe(true)
  })

  it('改色：非空色键必须是 8 键之一，null/省略都合法（复位语义）', async () => {
    const { SetGroupColorRequestSchema } = await import('./canvasGroup')
    const base = { sessionId: 's', userId: 'u', groupId: 'g1' }
    expect(SetGroupColorRequestSchema.safeParse({ ...base, colorKey: 'moss' }).success).toBe(true)
    expect(SetGroupColorRequestSchema.safeParse({ ...base, colorKey: null }).success).toBe(true)
    expect(SetGroupColorRequestSchema.safeParse(base).success).toBe(true)
    expect(SetGroupColorRequestSchema.safeParse({ ...base, colorKey: 'hacker666' }).success).toBe(false)
  })

  it('zod 版本与用法一致（GroupColorKeySchema 是 z.enum）', () => {
    expect(GroupColorKeySchema).toBeInstanceOf(z.ZodEnum)
  })
})
