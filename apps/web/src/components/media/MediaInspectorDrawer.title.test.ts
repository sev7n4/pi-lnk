import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sharedDiagnosticCache } from '@/utils/generationDiagnostic'
import type { GenerationRecord } from '@/services/studio-api'

const HERE = dirname(fileURLToPath(import.meta.url))

interface InspectorRefs {
  open: Ref<boolean>
  loading: Ref<boolean>
  error: Ref<string | null>
  target: Ref<Record<string, unknown> | null>
  record: Ref<GenerationRecord | null>
}

let inspectorRefs: InspectorRefs
let diagnosticPayload: Record<string, unknown>

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
  useProviderBootstrap: () => ({ allChannels: { value: [] } }),
}))

vi.mock('@/composables/useModelHealth', () => ({
  useModelHealth: () => ({ value: { rows: [] } }),
}))

import MediaInspectorDrawer from './MediaInspectorDrawer.vue'

const LONG_PROMPT =
  'a japanese girl sitting on a white sofa, hands folded on knees, looking up at camera with a sweet smile, ' +
  'warm cozy living room, cream cable-knit sweater, golden hour lighting, Kodak Portra 400 style, 85mm lens, ' +
  'shallow depth of field, photorealistic, 4k, cinematic composition, dreamy atmosphere'

function failedRecord(type: 'video' | 'image'): GenerationRecord {
  return {
    id: 'g1',
    type,
    prompt: LONG_PROMPT,
    status: 'failed',
    createdAt: '2026-10-10T00:00:00.000Z',
    metadata: JSON.stringify({ modelKey: 'agnes-video-2.5-flash' }),
  } as GenerationRecord
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

function titleText(): string {
  return document.body.querySelector('.media-inspector-title')?.textContent?.trim() ?? ''
}

beforeEach(() => {
  diagnosticPayload = {
    userMessage: '生成失败',
    code: 'upstream_error',
    taskKind: 'generation',
    taskId: 'g1',
    occurredAt: '2026-10-10T00:00:00.000Z',
    providerSnippet: null,
    model: 'agnes-video-2.5-flash',
  }
})

afterEach(() => {
  document.body.innerHTML = ''
  sharedDiagnosticCache.clear()
})

/**
 * 失败抽屉标题回归锁（2026-10-12，P1）。
 *
 * 历史缺陷：节点无名称时把**整条 prompt 当抽屉标题**且头部无截断，长提示词把
 * 诊断三段式整体压出抽屉视口。修复后：标题只取节点名，无名称用「{类型}任务 · 时间」
 * 短标签；prompt 全文只进「技术详情」折叠区（默认收起、展开后限高滚动）。
 * CSS 层用「选择器规则块提取」断言 line-clamp（jsdom 无布局引擎，不能算样式）。
 */
describe('失败抽屉：标题不再落入 prompt 全文', () => {
  it('有效性前置：seed 的 record.prompt 确实是长文本（防下面否定式断言空转）', () => {
    expect(LONG_PROMPT.length).toBeGreaterThan(100)
    expect(LONG_PROMPT).toContain('Kodak Portra 400')
  })

  it('无 nodeLabel 的失败视频记录 → 标题为「视频任务 · …」短标签，不含 prompt 片段', async () => {
    const wrapper = await openDrawer(failedRecord('video'), { nodeId: 'node-1' })
    const t = titleText()
    expect(t.startsWith('视频任务'), `实际标题: ${t}`).toBe(true)
    expect(t.length).toBeLessThan(40)
    expect(t).not.toContain('Kodak Portra 400')
    expect(t).not.toContain('white sofa')
    wrapper.unmount()
  })

  it('有 nodeLabel → 标题即节点名（不受 prompt 影响）', async () => {
    const wrapper = await openDrawer(failedRecord('video'), {
      nodeId: 'node-1',
      nodeLabel: '开场镜头',
    })
    expect(titleText()).toBe('开场镜头')
    wrapper.unmount()
  })

  it('CSS 兜底：.media-inspector-title 规则块含 -webkit-line-clamp: 2', () => {
    const src = readFileSync(join(HERE, 'MediaInspectorDrawer.vue'), 'utf8')
    const block = src.match(/\.media-inspector-title\s*\{[^}]*\}/)?.[0]
    expect(block, '找不到 .media-inspector-title 规则块').toBeTruthy()
    expect(block).toContain('-webkit-line-clamp: 2')
    expect(block).toContain('overflow: hidden')
  })
})

describe('失败抽屉：Prompt 上下文只进技术详情折叠区', () => {
  it('技术详情默认收起；展开后 Prompt 行存在、带 is-multiline 且附复制按钮', async () => {
    const wrapper = await openDrawer(failedRecord('video'), { nodeId: 'node-1' })
    await wrapper.find('.media-inspector-tab:nth-child(2)').trigger('click')
    await flushPromises()

    const details = document.body.querySelector('details.media-inspector-diag-tech')
    expect(details, '技术详情折叠区必须存在').toBeTruthy()
    expect(details!.hasAttribute('open'), '技术详情默认应收起').toBe(false)

    await (details!.querySelector('summary') as HTMLElement).click()
    await flushPromises()

    const dds = Array.from(document.body.querySelectorAll('.media-inspector-diag-tech-rows dd'))
    const promptDd = dds.find((dd) => (dd.textContent ?? '').includes('Kodak Portra 400'))
    expect(promptDd, '展开后应有 Prompt 行且内容同源').toBeTruthy()
    expect(promptDd!.classList.contains('is-multiline'), 'Prompt 行应限高滚动').toBe(true)
    expect(
      Array.from(promptDd!.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('复制')),
      'Prompt 行应带复制按钮',
    ).toBe(true)
    wrapper.unmount()
  })
})
