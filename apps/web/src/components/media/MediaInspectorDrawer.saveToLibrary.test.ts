import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { sharedDiagnosticCache } from '@/utils/generationDiagnostic'
import type { GenerationRecord } from '@/services/studio-api'
import { saveAssetToLibrary } from '@/composables/useAssetLibrary'

interface InspectorRefs {
  open: Ref<boolean>
  loading: Ref<boolean>
  error: Ref<string | null>
  target: Ref<Record<string, unknown> | null>
  record: Ref<GenerationRecord | null>
}

let inspectorRefs: InspectorRefs

vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }) }))

vi.mock('@/composables/useMediaInspector', async () => {
  const { ref } = await import('vue')
  const refs = {
    open: ref(false),
    loading: ref(false),
    error: ref(null),
    target: ref(null),
    record: ref(null),
    locateNodeHandler: ref(null),
  }
  return {
    useMediaInspector: () => ({
      ...refs,
      closeInspector: vi.fn(),
      probeMedia: vi.fn(),
      locateCanvasNode: vi.fn(),
      invalidateRecordCache: vi.fn(),
    }),
    __getInspectorRefs: () => refs,
  }
})

vi.mock('@/services/studio-api', () => ({
  studioApi: {
    getGeneration: vi.fn(async () => ({ data: { data: null } })),
    getGenerationDiagnostic: vi.fn(async () => ({ userMessage: '', code: '', taskKind: '', taskId: '', occurredAt: '' })),
    confirmPlatformFallback: vi.fn(),
    cancelPlatformFallback: vi.fn(),
    probeMedia: vi.fn(),
  },
}))

vi.mock('@/composables/useProviderBootstrap', () => ({
  useProviderBootstrap: () => ({ allChannels: { value: [] } }),
}))

vi.mock('@/composables/useModelHealth', () => ({
  useModelHealth: () => ({ value: { rows: [] } }),
}))

vi.mock('@/composables/useAssetLibrary', () => ({
  saveAssetToLibrary: vi.fn(async () => true),
}))

import MediaInspectorDrawer from './MediaInspectorDrawer.vue'

function recordWithUrl(type: 'video' | 'image' | 'audio', url: string | null): GenerationRecord {
  return {
    id: 'g1',
    type,
    prompt: '一只穿格子衫的柴犬在写代码',
    status: 'completed',
    url,
    createdAt: '2026-10-12T00:00:00.000Z',
    metadata: '{}',
  } as unknown as GenerationRecord
}

async function openDrawer(
  record: GenerationRecord,
  target: Record<string, unknown> | null,
): Promise<ReturnType<typeof mount>> {
  const mod = (await import('@/composables/useMediaInspector')) as unknown as {
    __getInspectorRefs: () => InspectorRefs
  }
  inspectorRefs = mod.__getInspectorRefs()
  inspectorRefs.record.value = record
  inspectorRefs.target.value = target
  inspectorRefs.open.value = true
  const wrapper = mount(MediaInspectorDrawer, {
    attachTo: document.body,
    global: {
      stubs: {
        ElDrawer: { template: '<div><slot /></div>' },
        ElAlert: { template: '<div><slot /></div>' },
      },
    },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.mocked(saveAssetToLibrary).mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
  sharedDiagnosticCache.clear()
})

/**
 * 抽屉动作区回归锁（2026-10-12 hover 收敛配套）。
 *
 * 用户口径：媒体节点 hover 只留 ⓘ，下载/存资产库统一收进详情抽屉。
 * 锁定：动作区「下载 + 存入资产库」成对出现（有输出 URL 时）；存入动作
 * 携带 kind/generationRecordId/sourceNodeId 落库；无 URL 时不渲染动作。
 */
describe('抽屉动作区：下载 + 存入资产库统一入口', () => {
  it('有效性前置：saveAssetToLibrary mock 就位', () => {
    expect(vi.mocked(saveAssetToLibrary)).toBeTruthy()
  })

  it('有输出 URL → 动作区渲染「下载」与「存入资产库」', async () => {
    const wrapper = await openDrawer(recordWithUrl('image', '/files/a.png'), { nodeId: 'node-1' })
    const texts = Array.from(document.body.querySelectorAll('.media-inspector-action')).map(
      (b) => b.textContent?.trim(),
    )
    expect(texts).toContain('下载')
    expect(texts).toContain('存入资产库')
    wrapper.unmount()
  })

  it('点击「存入资产库」→ 按 record.type 落 kind，携带任务与节点溯源', async () => {
    const wrapper = await openDrawer(recordWithUrl('video', '/files/a.mp4'), {
      nodeId: 'node-9',
      nodeLabel: '开场镜头',
    })
    const saveBtn = Array.from(document.body.querySelectorAll('.media-inspector-action')).find(
      (b) => b.textContent?.trim() === '存入资产库',
    ) as HTMLButtonElement
    expect(saveBtn, '存入按钮必须渲染').toBeTruthy()
    saveBtn.click()
    await flushPromises()
    expect(saveAssetToLibrary).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(saveAssetToLibrary).mock.calls[0]![0] as unknown as Record<string, unknown>
    expect(payload.kind).toBe('video')
    expect(payload.generationRecordId).toBe('g1')
    expect(payload.sourceNodeId).toBe('node-9')
    expect(payload.label).toBe('开场镜头')
    expect(payload.prompt).toBe('一只穿格子衫的柴犬在写代码')
    expect(String(payload.url)).toContain('/files/a.mp4')
    wrapper.unmount()
  })

  it('audio 记录（target.kind=audio）→ kind 落 audio（不误判 image）', async () => {
    const wrapper = await openDrawer(recordWithUrl('audio', '/files/a.mp3'), {
      nodeId: 'node-2',
      kind: 'audio',
    })
    const saveBtn = Array.from(document.body.querySelectorAll('.media-inspector-action')).find(
      (b) => b.textContent?.trim() === '存入资产库',
    ) as HTMLButtonElement
    saveBtn.click()
    await flushPromises()
    const payload = vi.mocked(saveAssetToLibrary).mock.calls[0]![0] as unknown as Record<string, unknown>
    expect(payload.kind).toBe('audio')
    wrapper.unmount()
  })

  it('无输出 URL → 下载/存入按钮不渲染', async () => {
    const wrapper = await openDrawer(recordWithUrl('image', null), { nodeId: 'node-1' })
    const texts = Array.from(document.body.querySelectorAll('.media-inspector-action')).map(
      (b) => b.textContent?.trim(),
    )
    expect(texts).not.toContain('下载')
    expect(texts).not.toContain('存入资产库')
    wrapper.unmount()
  })
})
