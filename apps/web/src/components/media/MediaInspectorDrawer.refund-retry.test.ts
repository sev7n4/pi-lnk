import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import type { GenerationDiagnostic } from '@lnkpi/shared'
import { CANVAS_NODE_RETRY_KEY } from '@/composables/canvasNodeActions'
import {
  __resetStudioCatalogForTests,
  setStudioCatalogEntries,
} from '@/constants/studioModels'
import { sharedDiagnosticCache } from '@/utils/generationDiagnostic'
import type { GenerationRecord } from '@/services/studio-api'

const retryFn = vi.fn()

interface InspectorRefs {
  open: Ref<boolean>
  loading: Ref<boolean>
  error: Ref<string | null>
  target: Ref<Record<string, unknown> | null>
  record: Ref<GenerationRecord | null>
}

let inspectorRefs: InspectorRefs
let diagnosticPayload: Partial<GenerationDiagnostic>

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
    getGenerationDiagnostic: vi.fn(async () => diagnosticPayload),
    confirmPlatformFallback: vi.fn(),
    cancelPlatformFallback: vi.fn(),
    probeMedia: vi.fn(),
  },
}))

vi.mock('@/composables/useProviderBootstrap', () => ({
  useProviderBootstrap: () => ({
    allChannels: {
      value: [
        {
          id: 'platform',
          models: [
            { name: 'agnes-image-2.1-flash', capability: 'image', availability: 'available' },
            { name: 'seedream-5.0-pro', capability: 'image', availability: 'unavailable' },
          ],
        },
      ],
    },
  }),
}))

vi.mock('@/composables/useModelHealth', () => ({
  useModelHealth: () => ({
    value: {
      generatedAt: '2026-10-10T00:00:00.000Z',
      windowHours: 24,
      rows: [
        {
          model: 'agnes-image-2.1-flash',
          channelId: 'platform',
          windowHours: 24,
          total: 10,
          completed: 9,
          failed: 1,
          fallbackPending: 0,
          refunded: 0,
          successRate: 0.7,
        },
      ],
    },
  }),
}))

import MediaInspectorDrawer from './MediaInspectorDrawer.vue'

const CATALOG = [
  {
    modelKey: 'agnes-image-2.1-flash',
    displayName: 'Agnes 图像 2.1 Flash',
    gatewayModelId: 'agnes-image-2.1-flash',
    modality: 'image',
    providerBinding: 'gateway-openai-compat',
    params: { model: 'native' },
  },
  {
    modelKey: 'seedream-5.0-pro',
    displayName: 'Seedream 5.0 Pro',
    gatewayModelId: 'doubao-seedream-5-0-pro',
    modality: 'image',
    providerBinding: 'gateway-openai-compat',
    params: { model: 'native' },
  },
] as unknown as Parameters<typeof setStudioCatalogEntries>[0]

function failedRecord(): GenerationRecord {
  return {
    id: 'g1',
    type: 'image',
    prompt: 'a cat',
    status: 'failed',
    createdAt: '2026-10-10T00:00:00.000Z',
    metadata: JSON.stringify({
      modelKey: 'seedream-5.0-pro',
      chargedPoints: 10,
      refundedPoints: 10,
      refundReason: 'platform_failed',
    }),
  } as GenerationRecord
}

async function openDiagnosticDrawer() {
  const mod = (await import('@/composables/useMediaInspector')) as unknown as {
    __getInspectorRefs: () => InspectorRefs
  }
  inspectorRefs = mod.__getInspectorRefs()
  inspectorRefs.record.value = failedRecord()
  inspectorRefs.target.value = { nodeId: 'node-1', nodeLabel: '节点 1' }
  inspectorRefs.open.value = true
  const wrapper = mount(MediaInspectorDrawer, {
    attachTo: document.body,
    global: {
      stubs: {
        ElDrawer: { template: '<div><slot /></div>' },
        ElAlert: { template: '<div><slot /></div>' },
      },
      provide: { [CANVAS_NODE_RETRY_KEY as symbol]: retryFn },
    },
  })
  await flushPromises()
  return wrapper
}

async function switchToDiagnosticTab(wrapper: ReturnType<typeof mount>) {
  await wrapper.find('.media-inspector-tab:nth-child(2)').trigger('click')
  await flushPromises()
}

function bodyButtons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll('button'))
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

beforeEach(() => {
  setStudioCatalogEntries(CATALOG)
  diagnosticPayload = {
    userMessage: '生成失败',
    code: 'upstream_error',
    taskKind: 'generation',
    taskId: 'g1',
    occurredAt: '2026-10-10T00:00:00.000Z',
    providerSnippet: null,
    model: 'doubao-seedream-5-0-pro',
    chargedPoints: 10,
    refundedPoints: 10,
    refundReason: 'platform_failed',
  }
})

afterEach(() => {
  document.body.innerHTML = ''
  retryFn.mockClear()
  sharedDiagnosticCache.clear()
  __resetStudioCatalogForTests()
})

describe('退款透明化（A1）', () => {
  it('diagnostic.refundedPoints>0 → 渲染「已自动退还 N 积分」', async () => {
    const wrapper = await openDiagnosticDrawer()
    await switchToDiagnosticTab(wrapper)
    expect(bodyText()).toContain('已自动退还 10 积分')
    wrapper.unmount()
  })

  it('缺退款字段 → 不渲染退款行（缺字段不渲染）', async () => {
    diagnosticPayload = {
      ...diagnosticPayload,
      chargedPoints: undefined,
      refundedPoints: undefined,
      refundReason: undefined,
    }
    const wrapper = await openDiagnosticDrawer()
    await switchToDiagnosticTab(wrapper)
    expect(bodyText()).not.toContain('已自动退还')
    wrapper.unmount()
  })

  it('复制诊断文本含 refund 行（shared formatDiagnosticCopy 同源）', async () => {
    const { formatDiagnosticCopy } = await import('@/utils/generationDiagnostic')
    const text = formatDiagnosticCopy({
      userMessage: '生成失败',
      code: 'upstream_error',
      taskKind: 'generation',
      taskId: 'g1',
      occurredAt: '2026-10-10T00:00:00.000Z',
      providerSnippet: null,
      chargedPoints: 10,
      refundedPoints: 10,
      refundReason: 'platform_failed',
    })
    expect(text).toContain('refund: charged 10 → refunded 10 (platform_failed)')
  })
})

describe('一键换模型重试', () => {
  it('失败态 + 推荐非 null → 「换 {displayName} 重试」按钮，点击走 retry 注入（页面级 patch 通路）', async () => {
    const wrapper = await openDiagnosticDrawer()
    await switchToDiagnosticTab(wrapper)
    const retryBtn = bodyButtons().find((b) =>
      (b.textContent ?? '').includes('换 Agnes 图像 2.1 Flash 重试'),
    )
    expect(retryBtn).toBeTruthy()
    retryBtn!.click()
    await flushPromises()
    expect(retryFn).toHaveBeenCalledWith('node-1', { modelKey: 'platform::agnes-image-2.1-flash' })
    wrapper.unmount()
  })

  it('errorCode ∈ {cancelled, invalid_input, upload_required} → 不渲染重试按钮', async () => {
    for (const code of ['cancelled', 'invalid_input', 'upload_required'] as const) {
      diagnosticPayload = { ...diagnosticPayload, code }
      sharedDiagnosticCache.clear()
      const wrapper = await openDiagnosticDrawer()
      await switchToDiagnosticTab(wrapper)
      const hasRetry = bodyButtons().some(
        (b) => (b.textContent ?? '').includes('换 ') && (b.textContent ?? '').includes('重试'),
      )
      expect(hasRetry, `code=${code} 不应渲染重试按钮`).toBe(false)
      wrapper.unmount()
    }
  })

  it('推荐排除探活 unavailable（seedream unavailable 且为失败模型自身 → 只有 agnes）', async () => {
    const wrapper = await openDiagnosticDrawer()
    await switchToDiagnosticTab(wrapper)
    expect(bodyText()).not.toContain('换 Seedream 5.0 Pro 重试')
    expect(bodyText()).toContain('换 Agnes 图像 2.1 Flash 重试')
    wrapper.unmount()
  })
})
