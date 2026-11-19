import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(join(here, rel), 'utf8')

/** 剥注释，避免迁移说明里的历史字符串让断言假红。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')

describe('settings domain wiring + tokens (2026-11-19 入口收敛 + design-tokens + 返工迁至 /settings)', () => {
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

  it('R2: 设置入口在头像一级菜单，个人中心不再有设置 Tab（2026-11-19 返工）', () => {
    // 头像菜单：一级「设置」项 → 独立 /settings 路由
    const menu = strip(read('../components/account/AccountUserMenu.vue'))
    expect(menu).toContain('data-testid="account-settings"')
    expect(menu).toContain("router.push('/settings')")

    const router = strip(read('../router/index.ts'))
    expect(router).toContain("path: '/settings'")
    expect(router).toContain('SettingsPage.vue')

    const settingsPage = strip(read('../pages/SettingsPage.vue'))
    expect(settingsPage).toContain('data-testid="theme-option-light"')
    expect(settingsPage).toContain('data-testid="theme-option-dark"')
    expect(settingsPage).toContain('data-testid="open-model-settings"')
    expect(settingsPage).toContain('setTheme')

    // 反转判据：个人中心不得回退到「设置」Tab / 面板
    const profile = strip(read('../pages/ProfilePage.vue'))
    expect(profile).not.toContain('panel-settings')
    expect(profile).not.toContain('data-testid="open-model-settings"')
    expect(profile).not.toContain("['settings', '设置']")
  })

  it('R5: 外观双选项用不变式预览令牌 + 稳定 accent 选中态', () => {
    const sfc = strip(read('../pages/SettingsPage.vue'))
    // 缩略预览：恒白/恒深的不变式 L2（不随主题翻转），符合「禁引用 L1」硬规则
    expect(sfc).toContain('--lnk-stamp-face-on-signature')
    expect(sfc).toContain('--lnk-stamp-ink-on-signature')
    expect(sfc).toContain('--lnk-surface-signature')
    // 选中态：主题稳定的 accent 三件套
    expect(sfc).toContain('--lnk-accent-border')
    expect(sfc).toContain('--lnk-accent-subtle')
    expect(sfc).toContain('accent-text')
    // 禁用会随主题翻转的 hi-bg/hi-text 于外观选中态
    expect(sfc).not.toContain('hi-bg')
    expect(sfc).not.toContain('hi-text')
  })

  it('R2b: useCanvasTheme 暴露 setTheme 且复用现有 ref/watch 链路', () => {
    const sfc = strip(read('../composables/useCanvasTheme.ts'))
    expect(sfc).toContain('function setTheme')
    expect(sfc).toContain('theme.value = value')
    expect(sfc).toContain('setTheme')
    // 不得引入第二个真相源：仍只有一条 watch(theme) 落地链路
    expect(sfc.match(/watch\(theme/g) ?? []).toHaveLength(1)
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
