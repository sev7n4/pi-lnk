import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import type { GenerationDiagnostic } from '@lnkpi/shared'
import { CANVAS_AGENT_DIAGNOSE_KEY } from '@/composables/canvasNodeActions'
import {
  __resetStudioCatalogForTests,
  setStudioCatalogEntries,
} from '@/constants/studioModels'
import { sharedDiagnosticCache } from '@/utils/generationDiagnostic'
import type { GenerationRecord } from '@/services/studio-api'

const diagnoseFn = vi.fn()

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
      rows: [],
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
] as unknown as Parameters<typeof setStudioCatalogEntries>[0]

function failedRecord(): GenerationRecord {
  return {
    id: 'g1',
    type: 'image',
    prompt: 'a cat',
    status: 'failed',
    createdAt: '2026-10-10T00:00:00.000Z',
    metadata: JSON.stringify({ modelKey: 'agnes-image-2.1-flash', chargedPoints: 10 }),
  } as GenerationRecord
}

async function openDiagnosticDrawer(opts: { provideDiagnose?: boolean } = {}) {
  const mod = (await import('@/composables/useMediaInspector')) as unknown as {
    __getInspectorRefs: () => InspectorRefs
  }
  inspectorRefs = mod.__getInspectorRefs()
  inspectorRefs.record.value = failedRecord()
  inspectorRefs.target.value = { nodeId: 'node-1', nodeLabel: '节点 1' }
  inspectorRefs.open.value = true
  const provide: Record<symbol, unknown> = {}
  if (opts.provideDiagnose !== false) provide[CANVAS_AGENT_DIAGNOSE_KEY as symbol] = diagnoseFn
  const wrapper = mount(MediaInspectorDrawer, {
    attachTo: document.body,
    global: {
      stubs: {
        ElDrawer: { template: '<div><slot /></div>' },
        ElAlert: { template: '<div><slot /></div>' },
      },
      provide,
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

beforeEach(() => {
  setStudioCatalogEntries(CATALOG)
  diagnosticPayload = {
    userMessage: '上游超时',
    code: 'upstream_timeout',
    taskKind: 'generation',
    taskId: 'g1',
    occurredAt: '2026-10-10T00:00:00.000Z',
    providerSnippet: null,
  }
})

afterEach(() => {
  document.body.innerHTML = ''
  diagnoseFn.mockClear()
  sharedDiagnosticCache.clear()
  __resetStudioCatalogForTests()
})

describe('让 Agent 诊断入口（PR1 Task3）', () => {
  it('error 态 + provide 存在 → 渲染按钮；点击 → 带 nodeId/userMessage/errorCode 调用', async () => {
    const wrapper = await openDiagnosticDrawer()
    await switchToDiagnosticTab(wrapper)
    const btn = bodyButtons().find((b) => (b.textContent ?? '').includes('让 Agent 诊断'))
    expect(btn).toBeTruthy()
    btn!.click()
    await flushPromises()
    expect(diagnoseFn).toHaveBeenCalledTimes(1)
    const call = diagnoseFn.mock.calls[0][0] as {
      nodeId: string
      title: string
      userMessage: string
      errorCode?: string
    }
    expect(call.nodeId).toBe('node-1')
    expect(call.title).toBe('节点 1')
    expect(call.userMessage).toBe('上游超时')
    expect(call.errorCode).toBe('upstream_timeout')
    wrapper.unmount()
  })

  it('provide 缺失（inject 回落 null）→ 按钮不渲染', async () => {
    const wrapper = await openDiagnosticDrawer({ provideDiagnose: false })
    await switchToDiagnosticTab(wrapper)
    const btn = bodyButtons().find((b) => (b.textContent ?? '').includes('让 Agent 诊断'))
    expect(btn).toBeFalsy()
    wrapper.unmount()
  })
})
