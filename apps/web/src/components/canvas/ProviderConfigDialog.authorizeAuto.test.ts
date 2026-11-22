import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * PC 管理入口 · 授权自动生成开关（规格 2026-11-22-generation-auto-approve-gate-design §4）。
 *
 * 该弹层是 element-plus 的 el-dialog + el-tabs，完整挂载成本高——断言落在
 * **源码契约**上（偏好字段三处同步 + 开关出口 + 令牌纪律），与仓库既有静态守卫同风格。
 * 行为级断言在 useAutoApproveGeneration.test.ts（读写薄接线）。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'canvas', 'ProviderConfigDialog.vue'), 'utf8')

describe('ProviderConfigDialog — 授权自动生成开关（2026-11-22 规格 §4）', () => {
  it('偏好字段三处同步：draft / hydrate / payload（漏一处即静默丢字段）', () => {
    // draft 声明
    expect(SRC).toMatch(/autoApproveGenerations:\s*'manual'\s+as\s+'manual'\s*\|\s*'auto'/)
    // hydrate（bootstrap → draft）
    expect(SRC).toMatch(/prefsDraft\.autoApproveGenerations\s*=\s*prefs\.autoApproveGenerations/)
    // payload（draft → PUT）
    expect(SRC).toMatch(/autoApproveGenerations:\s*prefsDraft\.autoApproveGenerations/)
  })

  it('开关出口存在：role=switch + aria-checked + 可读文案', () => {
    expect(SRC).toContain('data-testid="auto-approve-switch"')
    expect(SRC).toMatch(/role="switch"/)
    expect(SRC).toContain('aria-checked')
    expect(SRC).toContain('授权自动生成')
    // 作用域必须写清（否则用户误以为所有写操作都免确认）
    expect(SRC).toContain('视频始终需要确认')
  })

  it('令牌纪律：开关样式只用 --lnk-* 令牌（无裸 hex / rgba）', () => {
    const block = /\.auto-approve-switch[^{]*\{([^}]*)\}/.exec(SRC)?.[1] ?? ''
    expect(block).toContain('var(--lnk-border-subtle)')
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    expect(block).not.toMatch(/rgba?\(/)
    // 禁用随主题翻转的 --lnk-hi-*（选中态用它会出事）——只查开关自己的规则块
    expect(block).not.toContain('--lnk-hi-bg')
    expect(block).not.toContain('--lnk-hi-text')
  })
})
