// 移动端「新建」全宽 sheet（2026-10-19 D-2）：
// ① 一级视图 = 资产库通栏瓦片 + 10 类节点宫格（CANVAS_DOCK_MENU_ITEMS 单一出处）；
// ② 资产库瓦片 → sheet 内二级视图（CanvasAssetPanel 面板本体复用，仅换容器）；
// ③ 选中即创建/插入并关闭；遮罩/关闭钮仅收起不触发动作。
// 注：sheet 走 Teleport to body —— 查询落在 document.body；CanvasAssetPanel 被
// stub 掉，避免其 onMounted 真实打接口。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { h } from 'vue'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MobileCreateSheet from './MobileCreateSheet.vue'

const { assetStubEmit } = vi.hoisted(() => ({
  assetStubEmit: { apply: vi.fn(), addToAgent: vi.fn() },
}))

vi.mock('@/components/canvas/CanvasAssetPanel.vue', () => ({
  default: {
    name: 'CanvasAssetPanelStub',
    emits: ['apply', 'add-to-agent'],
    setup(_props: Record<string, unknown>, { emit }: { emit: (event: string, payload: unknown) => void }) {
      return () =>
        h(
          'button',
          {
            class: 'asset-stub',
            onClick: () => {
              assetStubEmit.apply({ id: 'a1', kind: 'image' })
              emit('apply', { id: 'a1', kind: 'image' })
            },
          },
          'asset-panel',
        )
    },
  },
}))

function mountSheet() {
  return mount(MobileCreateSheet, { attachTo: document.body })
}

function q(selector: string): HTMLElement | null {
  return document.body.querySelector(selector)
}

function qa(selector: string): HTMLElement[] {
  return Array.from(document.body.querySelectorAll(selector))
}

beforeEach(() => {
  document.body.innerHTML = ''
  assetStubEmit.apply.mockClear()
  assetStubEmit.addToAgent.mockClear()
})

describe('MobileCreateSheet（PR2 新建收敛）', () => {
  it('一级视图：资产库瓦片 + 10 类节点宫格（与竖轨同源）', () => {
    mountSheet()
    expect(q('[data-testid="mcs-asset-tile"]')).not.toBeNull()
    const items = qa('[data-testid="mcs-grid"] .mcs-grid-item')
    expect(items).toHaveLength(10)
    // 分镜/分组等低频项也在宫格内（I-1：10 类节点可达）
    expect(items.map((el) => el.getAttribute('data-type'))).toContain('shot')
    expect(items.map((el) => el.getAttribute('data-type'))).toContain('group')
  })

  it('点宫格项 → emit create(type)（走竖轨同一条创建链路）', async () => {
    const wrapper = mountSheet()
    const video = qa('[data-testid="mcs-grid"] .mcs-grid-item').find((el) => el.getAttribute('data-type') === 'video')
    expect(video).toBeDefined()
    video!.click()
    await flushPromises()
    expect(wrapper.emitted('create')).toEqual([['video']])
    wrapper.unmount()
  })

  it('资产库瓦片 → sheet 内二级视图；返回钮回一级', async () => {
    const wrapper = mountSheet()
    q('[data-testid="mcs-asset-tile"]')!.click()
    await flushPromises()
    // 二级视图：stub 面板 + 返回钮（一级宫格消失）
    expect(q('.asset-stub')).not.toBeNull()
    expect(q('[data-testid="mcs-grid"]')).toBeNull()
    q('[data-testid="mcs-back"]')!.click()
    await flushPromises()
    expect(q('[data-testid="mcs-grid"]')).not.toBeNull()
    expect(q('.asset-stub')).toBeNull()
    wrapper.unmount()
  })

  it('资产库 apply → emit asset-apply（插入节点语义）', async () => {
    const wrapper = mountSheet()
    q('[data-testid="mcs-asset-tile"]')!.click()
    await flushPromises()
    q('.asset-stub')!.click()
    await flushPromises()
    expect(wrapper.emitted('asset-apply')).toEqual([[{ id: 'a1', kind: 'image' }]])
    wrapper.unmount()
  })

  it('遮罩点按 / 关闭钮 → emit close，不触发任何创建', async () => {
    const wrapper = mountSheet()
    q('[data-testid="m-sheet-scrim"]')!.click()
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.emitted('create')).toBeUndefined()
    wrapper.unmount()

    document.body.innerHTML = ''
    const w2 = mountSheet()
    q('[data-testid="m-sheet-close"]')!.click()
    await flushPromises()
    expect(w2.emitted('close')).toHaveLength(1)
    expect(w2.emitted('create')).toBeUndefined()
    w2.unmount()
  })

  it('触控高度契约：宫格项/瓦片 56px ≥44px（T-6，静态断言 scoped 样式）', () => {
    // jsdom 不计算 scoped CSS，min-height 契约走源码断言（同 hitTarget.test.ts 模式）
    const here = dirname(fileURLToPath(import.meta.url))
    const sfc = readFileSync(join(here, 'MobileCreateSheet.vue'), 'utf8')
    expect(sfc).toMatch(/\.mcs-grid-item\s*\{[^}]*min-height:\s*56px/)
    expect(sfc).toMatch(/\.mcs-asset-tile\s*\{[^}]*min-height:\s*56px/)
  })
})
