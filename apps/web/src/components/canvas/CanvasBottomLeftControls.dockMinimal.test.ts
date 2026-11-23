// PC 画布底部胶囊条 IA 减法（9→4）+ 浮层 design-tokens 契约：
// ① 底栏只留 4 入口（小地图 / 缩放档位 / 适应 / 设置）；
// ② 缩放滑块、± 步进、独立闪电连线入口、Dock 缩放元设置不得回潮；
// ③ 三个浮层（小地图 / 列表 / 设置）统一 --lnk-* 令牌，零 --neo-*；
// ④ 焦点环 / aria-expanded / Esc 关闭等 A13 契约在位。
// jsdom 不计算样式 ⇒ 令牌与结构走源码静态契约（同 MobileTopBar / hitTarget 模式）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'CanvasBottomLeftControls.vue'), 'utf8')

/** 剥注释后再断言「某物已移除」——迁移记录写在注释里是规范，全文扫描会假红。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}
const code = stripComments(sfc)

/** 只取 <template> 段，避免 script 注释/类名干扰「底栏入口数」判定。 */
const template = code.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? ''
/** 取底栏容器本体（不含末尾闭合的 wrapper），用于数入口。 */
const dockBody = template.slice(template.indexOf('<div class="toolbar-row'), template.lastIndexOf('</template>'))

describe('PC 底部胶囊条 IA 减法（9→4）', () => {
  it('有效性：源码读到了底栏本体（否则下面否定断言全是空转）', () => {
    expect(dockBody).toContain('toolbar-row')
    expect(dockBody.length).toBeGreaterThan(200)
  })

  it('底栏恰好 4 个入口，且缩放是「读数 + 档位」二合一', () => {
    // 顶层交互按钮：小地图 / 缩放读数 / 适应 / 设置 = 4
    const topLevelBtns =
      dockBody.match(/<button\b[^>]*class="(?:bar-btn|zoom-trigger)/g) ?? []
    expect(topLevelBtns, `底栏应有 4 个入口，实得 ${topLevelBtns.length}`).toHaveLength(4)
    // 缩放读数是唯一缩放入口，点击展开档位
    expect(dockBody).toContain('zoom-trigger')
    expect(dockBody).toContain('@click="toggleZoomMenu"')
    expect(dockBody).toContain('aria-label="缩放比例，点击选择档位"')
  })

  it('缩放滑块 / ± 步进 / zoomBy 一律不得回潮', () => {
    expect(code).not.toContain('type="range" class="zoom-slider"')
    expect(code).not.toContain('zoom-slider')
    expect(code).not.toContain('zoomBy')
    expect(code).not.toContain('title="缩小"')
    expect(code).not.toContain('title="放大"')
    // 有效性：缩放能力本身仍在（档位 + zoomTo 接线）
    expect(code).toContain('ZOOM_STEPS')
    expect(code).toContain('zoomTo(')
  })

  it('独立闪电连线入口退役，连线设置并入设置浮层的「连线」栏', () => {
    // 底栏不再有闪电（连线）按钮；设置浮层仍含全部连线项
    expect(dockBody).not.toContain('连线设置')
    expect(code).toContain('<h3 class="dock-section-title">连线</h3>')
    for (const key of ['edgeAnimated', 'edgeWidth', 'edgeColor', 'edgeDash', 'edgeGlow']) {
      expect(code, `连线项 ${key} 必须在设置浮层可达`).toContain(key)
    }
  })

  it('Dock 缩放元设置下架，但 settings 字段保留兼容 localStorage', () => {
    expect(code).not.toContain('Dock 缩放')
    expect(code).not.toContain('bottomToolbarScale')
  })

  it('cycleMinimap 接线保留（移动端 hygiene 契约依赖此消费方）', () => {
    expect(sfc).toContain('cycleMinimap')
    expect(dockBody).toContain('@click="onMapToggle"')
  })
})

describe('三个浮层的 design-tokens 遵从', () => {
  it('零 --neo-*，浮层表面全部走 --lnk-* 令牌', () => {
    expect(code).not.toContain('--neo-')
    for (const token of [
      '--lnk-surface-overlay',
      '--lnk-border-subtle',
      '--lnk-shadow-lg',
      '--lnk-radius-lg',
      '--lnk-pad-card',
      '--lnk-z-popover',
    ]) {
      expect(code, `缺少浮层令牌 ${token}`).toContain(token)
    }
  })

  it('三个浮层用同一 dock-popover 表面规范，不各写一套', () => {
    for (const label of ['画布小地图', '节点列表', '画布设置']) {
      expect(template, `浮层 ${label} 缺失或没用统一表面`).toMatch(
        new RegExp(`aria-label="${label}"[\\s\\S]{0,120}dock-popover|dock-popover[\\s\\S]{0,120}aria-label="${label}"`),
      )
    }
    // 有效性：统一 surface 类确实定义
    expect(code).toMatch(/\.dock-popover\s*\{[^}]*--lnk-surface-overlay/)
  })

  it('选中态用 accent 语义色，不用随主题翻转的 --lnk-hi-*', () => {
    expect(code).not.toContain('--lnk-hi-')
    expect(code).toMatch(/\.dock-seg\.is-on\s*\{[^}]*--lnk-accent-subtle/)
  })

  it('A11y：焦点环 / aria-expanded / Esc 关闭在位', () => {
    expect(code).toMatch(/:focus-visible\s*\{[^}]*--lnk-border-focus/s)
    expect(code).toContain('outline-offset: 2px')
    expect(dockBody).toContain(':aria-expanded=')
    expect(code).toContain("event.key !== 'Escape'")
  })
})
