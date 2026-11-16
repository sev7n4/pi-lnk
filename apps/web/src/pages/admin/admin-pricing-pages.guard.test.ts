import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P3-B 接线守卫（spec 2026-11-15-p3-admin-page-consolidation §4.2）：
 * 「删页不删接口」——三张「原始数据·高级」页下线后，后端 controller 与前端 admin-api
 * 接口方法必须全在，随时可恢复路由/菜单（逃生口）。
 *
 * 判据取向：读**文件文本**而不是 import 后端（前端单测不引后端模块），
 * 断言的是「能力入口仍在」，而非「调用成功」。
 */

const REPO_ROOT = resolve(__dirname, '../../../../..')
const ADMIN_API_SRC = resolve(REPO_ROOT, 'apps/web/src/services/admin-api.ts')
const WEB_SRC = resolve(REPO_ROOT, 'apps/web/src')
const SERVER_ADMIN_SRC = resolve(REPO_ROOT, 'apps/server/src/admin')

/** 后端定价 controller：删页后必须仍在（= 逃生口本体）。 */
const REQUIRED_CONTROLLERS = [
  'pricing-cost.controller.ts',
  'pricing-margin.controller.ts',
  'pricing-cost-record.controller.ts',
  'pricing-cost-collect.controller.ts',
  'pricing-subject.controller.ts',
  'pricing-gray.controller.ts',
  'pricing-publishing.controller.ts',
  'pricing-materialize.controller.ts',
]

/** admin-api 里三个能力组的关键方法（方法全在 ⇒ 接口未删）。 */
const REQUIRED_API_METHODS: Array<[group: string, method: string]> = [
  ['pricingVersions', 'list'],
  ['pricingVersions', 'createDraft'],
  ['pricingVersions', 'get'],
  ['pricingVersions', 'putEntries'],
  ['pricingVersions', 'diff'],
  ['pricingVersions', 'publish'],
  ['pricingVersions', 'rollback'],
  ['pricingGray', 'preview'],
  ['pricingGray', 'create'],
  ['pricingGray', 'list'],
  ['pricingGray', 'report'],
  ['pricingGray', 'promote'],
  ['pricingGray', 'rollback'],
  ['pricingS1', 'listSubjects'],
  ['pricingS1', 'rebuildSubjects'],
  ['pricingS1', 'putCostRate'],
  ['pricingS1', 'listCostRates'],
  ['pricingS1', 'importCostRates'],
  ['pricingS1', 'putMarginPolicy'],
  ['pricingS1', 'listMarginPolicies'],
  ['pricingS1', 'materializeDraft'],
  ['pricingS1', 'getReadiness'],
]

/** 已下线的三张高级页（文件 + 路由均应不存在）。 */
const REMOVED_PAGES = [
  'AdminPricingSubjectsPage.vue',
  'AdminCostRatesPage.vue',
  'AdminMarginPoliciesPage.vue',
]

const REMOVED_ROUTE_PATHS = ['pricing-subjects', 'pricing-cost', 'pricing-margin']

describe('P3-B 接线守卫：删页不删接口', () => {
  it('后端定价 controller 全在（逃生口本体）', () => {
    const missing = REQUIRED_CONTROLLERS.filter((f) => !existsSync(resolve(SERVER_ADMIN_SRC, f)))
    expect(missing).toEqual([])
  })

  it('admin-api 三个能力组的关键方法全在', () => {
    const src = readFileSync(ADMIN_API_SRC, 'utf8')
    const missing: string[] = []
    for (const [group, method] of REQUIRED_API_METHODS) {
      // 方法声明形如 `    list: (): Promise<...> =>`（组内缩进两格后顶格）
      const groupIdx = src.indexOf(`${group}: {`)
      if (groupIdx < 0) {
        missing.push(`${group}（能力组缺失）`)
        continue
      }
      // 取该组到下一个顶层组之间的切片，避免跨组误命中同名方法
      const nextGroup = src.indexOf('\n  }', groupIdx)
      const slice = src.slice(groupIdx, nextGroup > 0 ? nextGroup : undefined)
      if (!new RegExp(`\\b${method}\\s*:`).test(slice)) missing.push(`${group}.${method}`)
    }
    expect(missing).toEqual([])
  })

  it('三张高级页文件确已删除', () => {
    const still = REMOVED_PAGES.filter((f) => existsSync(resolve(WEB_SRC, 'pages/admin', f)))
    expect(still).toEqual([])
  })

  it('router 中不再有三条已下线路由', () => {
    const router = readFileSync(resolve(WEB_SRC, 'router/index.ts'), 'utf8')
    const still = REMOVED_ROUTE_PATHS.filter((p) => router.includes(`path: '${p}'`))
    expect(still).toEqual([])
  })

  it('发布流页与灰度页仍保留（回滚逃生口 + 灰度设施）', () => {
    expect(existsSync(resolve(WEB_SRC, 'pages/admin/AdminPricingVersionsPage.vue'))).toBe(true)
    expect(existsSync(resolve(WEB_SRC, 'pages/admin/AdminGrayReleasePage.vue'))).toBe(true)
    const router = readFileSync(resolve(WEB_SRC, 'router/index.ts'), 'utf8')
    expect(router).toContain("path: 'pricing-versions'")
    expect(router).toContain("path: 'gray-release'")
  })
})
