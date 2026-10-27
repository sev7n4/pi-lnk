import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ref, nextTick, defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { CANVAS_NODE_PATCH_KEY } from '@/composables/canvasNodeActions'

vi.mock('@/services/studio-api', () => ({
  studioApi: {
    probeMedia: vi.fn(),
  },
}))

import { studioApi } from '@/services/studio-api'
import { useNodeMediaInfoFooter } from './useNodeMediaInfoFooter'

describe('useNodeMediaInfoFooter', () => {
  beforeEach(() => {
    vi.mocked(studioApi.probeMedia).mockReset()
  })

  it('probes and patches when url present without mediaInfo', async () => {
    vi.mocked(studioApi.probeMedia).mockResolvedValue({
      url: 'https://cdn/a.png',
      width: 10,
      height: 10,
      bytes: 100,
      probeStatus: 'ok',
    })
    const patches: Array<Record<string, unknown>> = []
    const url = ref('https://cdn/a.png')
    const mediaInfo = ref(undefined as undefined | { kind: 'image'; width: number; height: number; bytes: number })
    const Comp = defineComponent({
      setup() {
        useNodeMediaInfoFooter({
          nodeId: 'n1',
          url,
          kind: 'image',
          mediaInfo,
        })
        return () => h('div')
      },
    })
    mount(Comp, {
      global: {
        provide: {
          [CANVAS_NODE_PATCH_KEY as symbol]: (id: string, patch: Record<string, unknown>) => {
            expect(id).toBe('n1')
            patches.push(patch)
            mediaInfo.value = patch.mediaInfo as typeof mediaInfo.value
          },
        },
      },
    })
    await nextTick()
    for (let i = 0; i < 20 && !vi.mocked(studioApi.probeMedia).mock.calls.length; i++) {
      await nextTick()
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(studioApi.probeMedia).toHaveBeenCalledWith('https://cdn/a.png')
    expect(patches[0]?.mediaInfo).toMatchObject({ kind: 'image', width: 10, height: 10, bytes: 100 })
  })

  // ⭐ 三轮走查修订（2026-10-27）：bytes-only 残缺 summary **必须**补 probe
  // （旧判据「有任意 payload 即跳过」是磁贴底部只见媒体大小的根因）。
  it('bytes-only 残缺 summary ⇒ 仍补 probe（三轮走查修订：要素集判据）', async () => {
    const url = ref('https://cdn/b.png')
    const mediaInfo = ref({ kind: 'image' as const, bytes: 1 })
    const Comp = defineComponent({
      setup() {
        useNodeMediaInfoFooter({ nodeId: 'n2', url, kind: 'image', mediaInfo })
        return () => h('div')
      },
    })
    mount(Comp, {
      global: { provide: { [CANVAS_NODE_PATCH_KEY as symbol]: vi.fn() } },
    })
    await nextTick()
    for (let i = 0; i < 20 && !vi.mocked(studioApi.probeMedia).mock.calls.length; i++) {
      await nextTick()
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(studioApi.probeMedia).toHaveBeenCalledWith('https://cdn/b.png')
  })

  it('要素集完整（width+height+bytes）⇒ 跳过 probe', async () => {
    const url = ref('https://cdn/c.png')
    const mediaInfo = ref({ kind: 'image' as const, width: 10, height: 10, bytes: 1 })
    const Comp = defineComponent({
      setup() {
        useNodeMediaInfoFooter({ nodeId: 'n3', url, kind: 'image', mediaInfo })
        return () => h('div')
      },
    })
    mount(Comp, {
      global: { provide: { [CANVAS_NODE_PATCH_KEY as symbol]: vi.fn() } },
    })
    await nextTick()
    await new Promise((r) => setTimeout(r, 20))
    expect(studioApi.probeMedia).not.toHaveBeenCalled()
  })
})
