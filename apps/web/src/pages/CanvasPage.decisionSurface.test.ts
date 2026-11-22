import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(here, 'CanvasPage.vue'), 'utf8')

/**
 * 决策面收归对话页（2026-11-22 用户拍板）：
 * 画布只承担预览查看，ProposeConfirmOverlay 三钮（确认生成/编辑/取消）整体退场，
 * 决策入口唯一在对话时间线 proposal 卡。
 *
 * 断言落在「可观测出口」（页面源码引用 + 组件文件存在性），不碰实现细节。
 */
describe('决策面收归对话页 — 画布不再渲染确认胶囊（PC）', () => {
  it('CanvasPage 不再 import / 渲染 ProposeConfirmOverlay', () => {
    expect(PAGE).not.toContain('ProposeConfirmOverlay')
  })

  it('仅服务两处胶囊的 handler 已清理（核心生成入口保留）', () => {
    expect(PAGE).not.toContain('handleProposeConfirmEdit')
    expect(PAGE).not.toContain('handleProposeConfirmCancel')
    // handleAgentGenerateNode 是生成核心入口（批量/@generate-node 仍用），必须在
    expect(PAGE).toContain('handleAgentGenerateNode')
  })

  it('待确认节点的状态展示仍保留（proposeConfirmNode / NodePendingPrompt 门控）', () => {
    // 状态面（查看）与操作面（决策）正交：退场的只是后者
    expect(PAGE).toContain('proposeConfirmNode')
    expect(PAGE).toContain('NodePendingPrompt')
  })

  it('overlay 组件与其独占测试文件已删除', () => {
    let overlayExists = true
    let overlayTestExists = true
    try {
      readFileSync(join(here, '..', 'components', 'canvas', 'ProposeConfirmOverlay.vue'))
    } catch {
      overlayExists = false
    }
    try {
      readFileSync(join(here, '..', 'components', 'canvas', 'ProposeConfirmOverlay.test.ts'))
    } catch {
      overlayTestExists = false
    }
    expect(overlayExists, 'ProposeConfirmOverlay.vue 应已删除').toBe(false)
    expect(overlayTestExists, 'ProposeConfirmOverlay.test.ts 应已删除').toBe(false)
  })
})
