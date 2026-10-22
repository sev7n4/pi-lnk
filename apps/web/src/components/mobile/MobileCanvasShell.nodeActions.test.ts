// MobileCanvasShell 长按动作集成（R1-T5）：验证 CanvasPage 经 provide 触发后，
// 壳层正确渲染动作 sheet / 编辑 sheet，并把用户意图经回调路由回页面级真源逻辑
// （不另起一套、不伪造）。覆盖 Review Focus #2「删 Dock 后编辑不丢链」。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import MobileCanvasShell, { type MobileEditorContext } from './MobileCanvasShell.vue'
import type { MobileNodeActionNode } from './MobileNodeActionSheet.vue'
import type { EditableFlowNode } from '@/composables/useSelectedNodeEditor'

function noop() {
  return vi.fn()
}

function baseProps(overrides: Record<string, unknown> = {}) {
  const agentActions = {
    openDrawer: noop(),
    newChat: noop(),
    openHistory: noop(),
    openPanel: noop(),
    openAssetLibrary: noop(),
  }
  const batchActions = {
    done: noop(),
    generate: noop(),
    regenerate: noop(),
    stop: noop(),
    blockedHint: noop(),
    group: noop(),
    ungroup: noop(),
    groupColor: noop(),
    duplicate: noop(),
    duplicateUpstream: noop(),
    addAgentRef: noop(),
    layout: noop(),
    download: noop(),
    delete: noop(),
  }
  return {
    mobileAppTab: 'canvas' as const,
    saving: false,
    saveFailed: false,
    hasNodes: true,
    multiSelectActive: false,
    multiSelectCount: 0,
    selectionBatch: null,
    multiSelectCanUngroup: false,
    multiSelectGroupColorKey: null,
    sessionId: '',
    canvasChromeHidden: false,
    dockExpanded: false,
    composerVisible: false,
    onTabChange: noop(),
    onSave: noop(),
    onPublish: noop(),
    onImportWorkflow: noop(),
    onExportPack: noop(),
    agentActions,
    dockAdd: noop(),
    assetApply: noop(),
    assetAddToAgent: noop(),
    openMembership: noop(),
    openModelSettings: noop(),
    historyLocate: noop(),
    historyRetry: noop(),
    batchActions,
    mobileActionNode: null as MobileNodeActionNode | null,
    mobileEditor: null as MobileEditorContext | null,
    onNodeAction: vi.fn(),
    onNodeActionClose: vi.fn(),
    onNodeEditorClose: vi.fn(),
    onNodeEditorPatch: vi.fn(),
    ...overrides,
  }
}

const actionNode: MobileNodeActionNode = { id: 'n1', type: 'image', data: { url: 'x.png' } }

const editorContext = {
  node: { id: 'n1', type: 'image', data: { url: 'x.png', title: '图' } } as unknown as EditableFlowNode,
  upstream: {
    textPrompt: '',
    referenceImageUrl: '',
    referenceImageNodeId: null,
    textNodeIds: [],
    lastFrameUrl: '',
    lastFrameVideoNodeId: null,
  },
  refs: [],
  mentions: [],
  generating: false,
} as unknown as MobileEditorContext

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

describe('MobileCanvasShell 长按动作集成', () => {
  it('mobileActionNode 设置 → 渲染动作 sheet', () => {
    const w = mount(MobileCanvasShell, { props: baseProps({ mobileActionNode: actionNode }), attachTo: document.body })
    expect(w.findComponent({ name: 'MobileNodeActionSheet' }).exists()).toBe(true)
    w.unmount()
  })

  it('动作 sheet 选中「删除」→ 经 onNodeAction(key, id) 回传页面', async () => {
    const onNodeAction = vi.fn()
    const w = mount(MobileCanvasShell, {
      props: baseProps({ mobileActionNode: actionNode, onNodeAction }),
      attachTo: document.body,
    })
    await w.find('[data-action="delete"]').trigger('click')
    expect(onNodeAction).toHaveBeenCalledWith('delete', 'n1')
    w.unmount()
  })

  it('动作 sheet 取消 → onNodeActionClose', async () => {
    const onNodeActionClose = vi.fn()
    const w = mount(MobileCanvasShell, {
      props: baseProps({ mobileActionNode: actionNode, onNodeActionClose }),
      attachTo: document.body,
    })
    await w.find('[data-action="cancel"]').trigger('click')
    expect(onNodeActionClose).toHaveBeenCalled()
    w.unmount()
  })

  it('mobileEditor 设置 → 渲染编辑 sheet 且挂载 DockStudioRouter（删 Dock 后编辑不丢链）', () => {
    const w = mount(MobileCanvasShell, { props: baseProps({ mobileEditor: editorContext }), attachTo: document.body })
    expect(w.findComponent({ name: 'MobileNodeEditorSheet' }).exists()).toBe(true)
    expect(w.findComponent({ name: 'DockStudioRouter' }).exists()).toBe(true)
    w.unmount()
  })

  it('编辑 sheet 关闭把手 → onNodeEditorClose', async () => {
    const onNodeEditorClose = vi.fn()
    const w = mount(MobileCanvasShell, {
      props: baseProps({ mobileEditor: editorContext, onNodeEditorClose }),
      attachTo: document.body,
    })
    await w.find('[data-action="close"]').trigger('click')
    expect(onNodeEditorClose).toHaveBeenCalled()
    w.unmount()
  })
})
