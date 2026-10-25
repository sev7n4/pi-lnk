import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Task 6：品牌纹样头像全站收敛守卫。
 *
 * 契约：**用户头像位**（渲染"这个人是谁"的位）一律走 BrandPatternAvatar
 * —— 真实头像优先，缺省回落确定性纹样 + 首字母。
 * **品牌位**（渲染"我们是谁"的位）保留 BRAND_LOGO_URL。
 *
 * 反例动机：此前 ProfilePage / AccountPanel / ProfilePane 三处把公司
 * 吉祥物当成了"用户没头像时的兜底"，于是所有未设头像的用户长得一模一样，
 * 且看不出这是品牌 logo —— 头像位的语义被品牌资产劫持。
 */
const here = dirname(fileURLToPath(import.meta.url))
// src/components/account →上溯两级到 src，再拼业务相对路径
const srcRoot = join(here, '../..')
const read = (rel: string) => readFileSync(join(srcRoot, rel), 'utf8')

/**
 * 允许保留**品牌资产**的品牌位（渲染品牌资产，不是"某个人"）。
 *
 * 2026-10-26 用户裁定：品牌**标志**位（导航头 BrandLogo / 隐私·协议页头）改用
 * 双色徽标（`useBrandMark()` → `brandMarkUrl`，按主题反相），slogan 下吉祥物与
 * AI 助手头像仍走 `BRAND_LOGO_URL`。⇒ 断言从「必须含 BRAND_LOGO_URL」放宽为
 * 「必须引用任一品牌资产」——守的语义不变：**品牌位不许退化成没有品牌资产**，
 * 放宽的只是「用哪一份品牌资产」。
 */
const BRAND_ASSET = /BRAND_LOGO_URL|BRAND_MARK_ON_|brandMarkUrl/

const BRAND_SLOTS = [
  'constants/brand.ts',
  'components/brand/BrandLogo.vue',
  'components/agent/NeoAgentLogo.vue',
  'pages/TermsPage.vue',
  'pages/PrivacyPage.vue',
]

/** 用户头像位：必须走 BrandPatternAvatar，且不得直接引BRAND_LOGO_URL */
const USER_AVATAR_SLOTS = [
  'pages/ProfilePage.vue',
  'components/account/AccountPanel.vue',
  'components/mobile/ProfilePane.vue',
  'components/account/AccountUserMenu.vue',
]

describe('BrandPatternAvatar 全站收敛（Task 6）', () => {
  it.each(USER_AVATAR_SLOTS)('用户头像位 %s 走 BrandPatternAvatar，不碰品牌 logo', (file) => {
    const src = read(file)
    expect(src).toContain('BrandPatternAvatar')
    expect(src).not.toMatch(BRAND_ASSET)
  })

  it('用户头像位的 seed 用用户 id（纹样按人稳定，不随昵称变）', () => {
    for (const file of USER_AVATAR_SLOTS) {
      const src = read(file)
      const seeds = [...src.matchAll(/:seed="([^"]*)"/g)].map((m) => m[1])
      expect(seeds.length, file).toBeGreaterThan(0)
      for (const seed of seeds) {
        expect(seed, file).toContain('id')
        expect(seed, file).not.toContain('nickname')
      }
    }
  })

  it('品牌位保留品牌资产白名单不被误改', () => {
    for (const file of BRAND_SLOTS) {
      expect(read(file), file).toMatch(BRAND_ASSET)
    }
  })

  it('品牌资产的消费者只有品牌位（用户头像位零命中）', () => {
    const offenders: string[] = []
    for (const file of USER_AVATAR_SLOTS) {
      if (BRAND_ASSET.test(read(file))) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('BrandPatternAvatar 暴露 data-testid 供挂载级测试定位', () => {
    const src = read('components/account/BrandPatternAvatar.vue')
    expect(src).toContain('data-testid="brand-pattern"')
  })
})

// 路径仅用于失败信息可读性
void relative
