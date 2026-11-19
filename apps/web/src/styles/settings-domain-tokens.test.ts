import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(here, rel), 'utf8')

/** 剥注释，避免迁移说明里的历史字符串让断言假红。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')

describe('settings domain wiring + tokens (2026-11-19 入口收敛 + design-tokens)', () => {
  it('R1: PC 画布竖轨不再暴露设置入口', () => {
    const dock = strip(read('../components/canvas/NodePanelDock.vue'))
    expect(dock).not.toContain('open-settings')
    expect(dock).not.toContain('模型服务配置')

    const page = strip(read('../pages/CanvasPage.vue'))
    expect(page).not.toContain('@open-settings')
  })

  it('R1: 移动端模型配置入口仍接线到同一弹层', () => {
    const page = strip(read('../pages/CanvasPage.vue'))
    expect(page).toContain('open-model-settings')
    expect(page).toContain('<ProviderConfigDialog v-model="showModelSettings" />')

    const pane = strip(read('../components/mobile/ProfilePane.vue'))
    expect(pane).toContain("emit('open-model-settings')")
  })

  it('R2: 个人中心「设置」Tab 可达且含模型配置入口', () => {
    const page = strip(read('../pages/ProfilePage.vue'))
    expect(page).toContain("'settings'")
    expect(page).toContain("['settings', '设置']")
    expect(page).toContain('data-testid="profile-settings-panel"')
    expect(page).toContain('data-testid="open-model-settings"')
    expect(page).toContain('模型配置')
  })

  it('R3: 配置弹层无遗留 --neo-* 旧令牌', () => {
    const sfc = read('../components/canvas/ProviderConfigDialog.vue')
    expect(sfc.match(/--neo-/g) ?? []).toHaveLength(0)
  })

  it('R4: 弹层有真实标题作为可访问名，且未禁用 Esc 关闭', () => {
    const sfc = read('../components/canvas/ProviderConfigDialog.vue')
    // Element Plus 把 attrs 透传到内层 .el-dialog：自定义标题 id + aria-labelledby 必须成对存在，
    // 且不能假定能覆盖 role=dialog 外层由库自行生成的 el-id-*（上游行为，不由本项目修）。
    expect(sfc).toContain('id="provider-config-title"')
    expect(sfc).toContain('aria-labelledby="provider-config-title"')
    expect(sfc).toContain('aria-label="配置与用户偏好"')
    expect(sfc).not.toContain(':close-on-press-escape="false"')
  })
})
