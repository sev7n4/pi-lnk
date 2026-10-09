/** @vitest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const panelSrc = readFileSync(resolve(import.meta.dirname, 'VideoDockPanel.vue'), 'utf8')
const bottom = panelSrc.split('bottom-toolbar-actions')[1] ?? ''

describe('VideoDockPanel bottom dock', () => {
  it('does not render model capability badges', () => {
    expect(panelSrc).not.toContain('VideoCapabilityBadges')
    expect(panelSrc).not.toContain('V·A 参考')
    expect(panelSrc).not.toContain('连续镜')
  })

  it('keeps the bottom bar to model, params and generate', () => {
    expect(bottom).toContain('UniversalModelSelector')
    expect(bottom).toContain('VideoSettingsSelector')
    expect(bottom).toContain('DockGenerateButton')
    expect(bottom).not.toContain('文生视频')
    expect(bottom).not.toContain('图生视频')
    expect(bottom).not.toContain('参考生成')
    expect(bottom).not.toContain('延续上一镜')
    expect(bottom).not.toContain('接下一段')
    expect(bottom).not.toContain('dock-advanced')
  })

  it('places capability-only actions next to the chip strip', () => {
    expect(panelSrc).toContain('dock-video-chip-actions')
    expect(panelSrc).toContain('inferVideoDockMode')
    expect(panelSrc).not.toContain('title="文生视频"')
    expect(panelSrc).not.toContain('title="图生视频"')
    expect(panelSrc).not.toContain('dock-advanced')
  })

  it('does not embed the ref-preflight banner or client-side probe (server owns preflight)', () => {
    expect(panelSrc).not.toContain('dock-ref-preflight-alert')
    expect(panelSrc).not.toContain('ElAlert')
    expect(panelSrc).not.toContain('refreshRefPreflight')
    expect(panelSrc).not.toContain('loadCachedRefPreflight')
    expect(panelSrc).not.toContain('probeMedia')
    expect(panelSrc).not.toContain('evaluateMediaRefPreflight')
    expect(panelSrc).not.toContain('studioApi')
    // 失败 toast 兜底保留：错误回显仍按 refKey 定位（服务端拦截文案含「参考图 N」）
    expect(panelSrc).toContain('pendingPreflightToast')
    expect(panelSrc).toContain('ElMessage.error')
  })
})
