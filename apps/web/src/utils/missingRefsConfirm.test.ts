/**
 * RB-D6① dock 直生二次确认判定（纯函数锁定；wiring 在 CanvasPage.handleNodeGenerate，评审读码验证）。
 */
import { describe, expect, it } from 'vitest'
import type { SidebarAttachment } from '@lnkpi/shared'
import {
  MISSING_REFS_CONFIRM_MESSAGE,
  latestUserSidebarImageCount,
  shouldConfirmDirectGenerateWithoutRefs,
} from './missingRefsConfirm'

const img = (mediaType: SidebarAttachment['mediaType'] = 'image'): SidebarAttachment =>
  ({ id: 'a1', mediaType, sourceKind: 'upload', label: 'a.png', url: 'https://x/a.png' }) as SidebarAttachment

describe('shouldConfirmDirectGenerateWithoutRefs', () => {
  it('image/video 节点 + 无 refs + 本轮有侧栏图 → 确认', () => {
    expect(shouldConfirmDirectGenerateWithoutRefs({ nodeType: 'image', refCount: 0, sidebarImageCount: 1 })).toBe(true)
    expect(shouldConfirmDirectGenerateWithoutRefs({ nodeType: 'video', refCount: 0, sidebarImageCount: 2 })).toBe(true)
  })
  it('非 image/video 节点不确认（Ruling 2 前端镜像）', () => {
    for (const t of ['text', 'prompt', 'audio', 'shot', 'sceneComposer']) {
      expect(shouldConfirmDirectGenerateWithoutRefs({ nodeType: t, refCount: 0, sidebarImageCount: 1 })).toBe(false)
    }
  })
  it('已有 refs 或本轮无侧栏图不确认', () => {
    expect(shouldConfirmDirectGenerateWithoutRefs({ nodeType: 'image', refCount: 1, sidebarImageCount: 1 })).toBe(false)
    expect(shouldConfirmDirectGenerateWithoutRefs({ nodeType: 'image', refCount: 0, sidebarImageCount: 0 })).toBe(false)
  })
})

describe('latestUserSidebarImageCount', () => {
  it('取最近一条 user 消息的 image 附件计数；assistant 中间层不干扰', () => {
    const messages = [
      { role: 'user', attachments: [img()] },
      { role: 'assistant', attachments: undefined },
      { role: 'user', attachments: [img(), img('text') as SidebarAttachment] },
    ]
    expect(latestUserSidebarImageCount(messages)).toBe(1)
  })
  it('无 user 消息 / 无 attachments → 0', () => {
    expect(latestUserSidebarImageCount([{ role: 'assistant' }])).toBe(0)
    expect(latestUserSidebarImageCount([{ role: 'user', attachments: [] }])).toBe(0)
  })
})

it('文案含可行动出口（先绑定参考图 / 直接生成语义）', () => {
  expect(MISSING_REFS_CONFIRM_MESSAGE).toContain('参考图')
})
