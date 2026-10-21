// P0-4 移动端命中区 ≥44px 的静态契约测试：
// 工具类挂载点 + AgentSideRail 媒体查询作用域的扩边定义 + 视觉尺寸基线（B8: 24/28/32）不变。
// 注：brief 里的 `__dirname` 在 vitest ESM 下不存在，这里用 fileURLToPath(import.meta.url)；
// brief 的 `../../agent/...` 相对路径也少算了一层（本文件在 components/canvas/dock-studio/shared/ 下）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, p), 'utf8')

describe('mobile hit target expansion (P0-4)', () => {
  it('generate button carries the expansion class', () => {
    // 2026-10-21 语音识别下线：麦克风钮（DockMicButton）已删除，其命中区断言随之移除
    expect(read('./DockGenerateButton.vue')).toMatch(/class="[^"]*agent-hit-expand/)
  })
  it('canvas-ref corner button carries the expansion class + l-size hit (P1-2.3)', () => {
    const sfc = read('../../../agent/AgentSideRail.vue')
    const btn = sfc.match(/<button[^>]*composer-canvas-ref-btn[\s\S]*?>/)?.[0] ?? ''
    expect(btn).toContain('agent-hit-expand')
    expect(btn).toContain('data-hit="l"')
  })
  it('AgentSideRail defines the media-scoped expansion', () => {
    const sfc = read('../../../agent/AgentSideRail.vue')
    expect(sfc).toContain('.agent-hit-expand')
    // 2026-10-18 裸条两行化：m 档保持四向 -10px；l 档/模型 chip 改只横向外扩
    // （inset: -2px -8px）——垂直方向不越过行间距，防点输入误触模型 chip。
    expect(sfc).toMatch(/@media\s*\(max-width:\s*767px\)[\s\S]{0,400}inset:\s*-10px/)
    expect(sfc).toMatch(/@media\s*\(max-width:\s*767px\)[\s\S]{0,500}inset:\s*-2px -8px/)
  })
  it('visual sizes unchanged (B8: 28/32)', () => {
    expect(read('./DockGenerateButton.vue')).toMatch(/width:\s*28px/)
  })
})
