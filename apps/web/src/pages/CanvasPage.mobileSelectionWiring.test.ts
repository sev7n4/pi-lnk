// PR3 接线契约（2026-10-20）：
// ① 移动端 S3 动作条接 PC 同一批处理器与同一份 selectionBatch 口径；
// ② PC MultiSelectToolbar 的批量派生改走 useSelectionBatchActions（不再内联复制）；
// ③ dock 收缩态 tap 化（移动端）+ 旋转项移动端隐藏；
// ④ 批量进度卡移动端清位与 44px 停止钮。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(join(here, p), 'utf8')

describe('mobile multi-select & dock wiring (PR3)', () => {
  const page = read('./CanvasPage.vue')

  it('移动端动作条接 PC 同一批处理器（不另造一套）', () => {
    const bar = page.match(/<MobileMultiSelectBar[\s\S]*?\/>/)?.[0] ?? ''
    expect(bar, 'MobileMultiSelectBar 必须存在').toContain(':selection-batch="selectionBatchProp"')
    expect(bar).toContain(':can-ungroup="multiSelectCanUngroup"')
    expect(bar).toContain(':group-color-key="multiSelectGroupColorKey"')
    for (const handler of [
      'handleSelectionBatchGenerate',
      'handleSelectionBatchRegenerate',
      'handleSelectionBatchStop',
      'handleSelectionBatchBlocked',
      'handleGroupSelection',
      'handleUngroupSelection',
      'handleGroupColorSelection',
      'handleKeyboardDuplicate',
      'handleToolbarDuplicateUpstream',
      'handleLayoutSelection',
      'handlePackageDownload',
      'handleDeleteSelection',
    ]) {
      expect(bar, `缺接线：${handler}`).toContain(handler)
    }
    // 多选态仍必须摘除 PC 贴选区工具条（两者互斥）
    expect(page).toMatch(/v-if="!isMobileLayout \|\| !mobileMultiSelectActive"/)
  })

  it('PC 工具条改走共享派生 composable（口径单一出处）', () => {
    const toolbar = read('../components/canvas/MultiSelectToolbar.vue')
    expect(toolbar).toContain("from '@/composables/useSelectionBatchActions'")
    expect(toolbar).toContain('useSelectionBatchActions(() => props.selectionBatch)')
    // 旧的重复实现（内联 Set/文案表）不得残留
    expect(toolbar).not.toMatch(/const showGenerateButton = computed\(\s*\(\) =>\s*batchRunCount/)
  })

  it('dock 收缩态：tap 化 + 旋转项移动端隐藏', () => {
    const dock = read('../components/canvas/DockStudioToolbar.vue')
    expect(dock).toContain('useDockCollapseState')
    expect(dock).toContain("@click=\"onCollapsedHit\"")
    expect(dock).toContain('data-testid="dock-collapse"')
    expect(dock).toMatch(/tool\.id === 'rotate'/)
    // PC 悬停通道逐字保留
    expect(dock).toContain('@mouseenter="hoverOpen = true"')
  })

  it('批量进度卡：移动端清位 + 44px 停止钮（PC 尺寸不变）', () => {
    const card = read('../components/canvas/SelectionBatchProgressCard.vue')
    expect(card).toMatch(/@media\s*\(max-width:\s*767px\)[\s\S]*?\.batch-progress-card[\s\S]*?--lnk-agent-dock-h/)
    expect(card).toMatch(/\.batch-progress-stop\s*\{[^}]*min-height:\s*var\(--lnk-touch-target\)/)
    // PC 基线仍在（w-56 居中）
    expect(card).toContain('bottom-6 left-1/2')
  })
})