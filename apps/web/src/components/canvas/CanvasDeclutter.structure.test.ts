import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = join(HERE, '..', '..', '..')
const read = (...segs: string[]) => readFileSync(join(WEB, 'src', ...segs), 'utf8')

/**
 * 画布减法结构锁（2026-10-12 用户口径，PR C）。
 *
 * 涉及组件挂载链重（CanvasAssetPanel 拉 api / CanvasPage 巨页），
 * 结构层断言落在源码形状上——与既有 CSS 规则块锁同一手法：
 * ① 资产库 hover 层去掉规格条与 prompt tooltip（干扰「加入 Agent/加载到画布」）；
 * ② 文本节点 dock 底栏去掉「优化提示词」按钮（分镜板对话框等创建流场景保留）；
 * ③ 右上角导入/导出常驻按钮退场，入口迁进画布名称「...」菜单。
 */
describe('画布减法：结构锁', () => {
  it('资产库卡片：规格条与 prompt tooltip 退场，hover 回归纯操作层', () => {
    const src = read('components', 'canvas', 'CanvasAssetPanel.vue')
    expect(src).not.toContain('MediaInfoSummary')
    expect(src).not.toContain('mediaSummary')
    expect(src, 'hover 层应回归纯操作条').toContain('hover 纯操作层')
    expect(src, '原生 title 不得再拼 prompt 片段').not.toContain('asset.label.slice')
  })

  it('文本节点 dock：DockOptimizePrompt 退场（组件本体保留给分镜板等创建流）', () => {
    const src = read('components', 'canvas', 'dock-studio', 'panels', 'TextDockPanel.vue')
    expect(src).not.toContain('DockOptimizePrompt')
    expect(src).not.toContain('onOptimized')
  })

  it('CanvasPage：右上角导入/导出常驻按钮退场，入口接线进「...」菜单', () => {
    const src = read('pages', 'CanvasPage.vue')
    expect(src).not.toContain('title="导入工作流"')
    expect(src).not.toContain('title="导出工作流"')
    expect(src).toContain('@import-workflow="openWorkflowImportPicker"')
    expect(src).toContain("@export-workflow=\"handleExportPack([], 'full_package')\"")
  })
})
