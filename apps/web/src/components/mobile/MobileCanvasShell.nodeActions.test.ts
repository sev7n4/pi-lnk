// MobileCanvasShell 长按动作集成（R1-T5）：验证 CanvasPage 经 provide 触发后，
// 壳层正确渲染动作 sheet / 编辑 sheet，并把用户意图经回调路由回页面级真源逻辑
// （不另起一套、不伪造）。覆盖 Review Focus #2「删 Dock 后编辑不丢链」。
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
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
    // 2026-10-27 三页顶栏统一重构（规格 §6.3）：‹ 返回创作空间 + ⤢ 适应画布
    goGallery: noop(),
    fitView: noop(),
  }
  const batchActions = {
    done: noop(),
    // D4 / H1（§4.9 选择模式）：「全选」（接口新增 ⇒ mock 同步）
    selectAll: noop(),
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
    // SP-B（#554，master 合并进来）：判别联合载荷必须原样透传，mock 同步补上
    align: noop(),
    download: noop(),
    delete: noop(),
  }
  return {
    mobileAppTab: 'canvas' as const,
    // 规格 §6.4：顶栏项目名（chat + canvas 同构常驻渲染）
    projectName: '测试项目',
    saving: false,
    saveFailed: false,
    hasNodes: true,
    multiSelectActive: false,
    multiSelectCount: 0,
    selectionBatch: null,
    multiSelectCanUngroup: false,
    multiSelectGroupColorKey: null,
    canvasChromeHidden: false,
    dockExpanded: false,
    composerVisible: false,
    // §16-②（2026-10-27）：画布视图可见（跨形态真相源）——状态栏/保存行的新门控
    canvasViewVisible: true,
    onTabChange: noop(),
    onSave: noop(),
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
    onNodeRename: vi.fn(),
    // D8/J1/K1（2026-10-25）：编辑器改为「发给 agent 修改」，本地提交与删引用 emit 已移除
    onNodeEditorSendToAgent: vi.fn(),
    // D8/L1/M1 + §17 v2（2026-10-27）：查看器批注锚带回（合成图 blob 或降级 + 胶囊意见）
    onViewerAnnotate: vi.fn(),
    onViewerMore: vi.fn(),
    onViewerBottomAction: vi.fn(),
    // §17-④（拍板②）：查看器编辑态保存 ⇒ 页面层覆盖磁贴提示词
    onViewerEditSave: vi.fn(),
    onNodeEditorClose: vi.fn(),
    onNodeEditorPatch: vi.fn(),
    viewerNode: null,
    onViewerClose: vi.fn(),
    // R3-T4：壳层聚合状态栏（默认无任务态）
    nodeGeneratingCount: 0,
    nodePendingNodes: [],
    nodeGeneratingElapsed: '',
    onNodePendingConfirm: vi.fn(),
    onNodePendingCancel: vi.fn(),
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


/** 派发 PointerEvent（jsdom 实例属性只读 ⇒ test-utils trigger 赋值会炸，须走构造器） */
async function firePointer(
  el: Element,
  type: string,
  o: { pointerId: number; clientX?: number; clientY?: number },
): Promise<void> {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...o }))
  await nextTick()
}

describe('MobileCanvasShell 长按动作集成', () => {
  it('mobileActionNode 设置 → 渲染动作 sheet', () => {
    const w = mount(MobileCanvasShell, {
      props: baseProps({ mobileActionNode: actionNode }),
      attachTo: document.body,
      // ⚠️ 2026-10-25（§4.11 Menu 化）：动作 sheet 走 `MobileSheet` 基座（含 Teleport）
      //    ⇒ Teleport 内容被移出 wrapper 子树 ⇒ `w.find` 找不到 ⇒ 必须 stub teleport
      global: { stubs: { teleport: true } },
    })
    expect(w.findComponent({ name: 'MobileNodeActionSheet' }).exists()).toBe(true)
    w.unmount()
  })

  it('动作 sheet 选中「删除」→ 经 onNodeAction(key, id) 回传页面', async () => {
    const onNodeAction = vi.fn()
    const w = mount(MobileCanvasShell, {
      props: baseProps({ mobileActionNode: actionNode, onNodeAction }),
      attachTo: document.body,
      global: { stubs: { teleport: true } },
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
      global: { stubs: { teleport: true } },
    })
    await w.find('[data-action="cancel"]').trigger('click')
    expect(onNodeActionClose).toHaveBeenCalled()
    w.unmount()
  })

  it('mobileEditor 设置 → 渲染编辑 sheet（轻量编辑器，不挂 PC dock）', () => {
    const w = mount(MobileCanvasShell, { global: { stubs: { teleport: true } }, props: baseProps({ mobileEditor: editorContext }), attachTo: document.body })
    expect(w.findComponent({ name: 'MobileNodeEditorSheet' }).exists()).toBe(true)
    expect(w.findComponent({ name: 'MobileNodeEditorSheet' }).exists()).toBe(true)
    // ⛔ D8/J1/K1（2026-10-25）：移动端编辑器**不再挂 PC studio dock**（参数所有权归 agent）
    expect(w.findComponent({ name: 'DockStudioRouter' }).exists()).toBe(false)
    w.unmount()
  })

  it('编辑 sheet 关闭把手 → onNodeEditorClose', async () => {
    const onNodeEditorClose = vi.fn()
    const w = mount(MobileCanvasShell, {
      global: { stubs: { teleport: true } }, // §13.2：viewer Teleport 后 jsdom 断言需内联渲染
      props: baseProps({ mobileEditor: editorContext, onNodeEditorClose }),
      attachTo: document.body,
    })
    await w.find('[data-action="close"]').trigger('click')
    expect(onNodeEditorClose).toHaveBeenCalled()
    w.unmount()
  })
})

describe('MobileCanvasShell 全屏查看器集成（R1-T4/T6）', () => {
  it('viewerNode 设置 → 渲染全屏查看器（图灯箱）', () => {
    const w = mount(MobileCanvasShell, {
      global: { stubs: { teleport: true } }, // §13.2：viewer Teleport 后 jsdom 断言需内联渲染
      props: baseProps({ viewerNode: { id: 'n1', type: 'image', data: { url: 'x.png' } } }),
      attachTo: document.body,
    })
    expect(w.findComponent({ name: 'MobileNodeViewer' }).exists()).toBe(true)
    w.unmount()
  })

  it('查看器返回 → onViewerClose', async () => {
    const onViewerClose = vi.fn()
    const w = mount(MobileCanvasShell, {
      global: { stubs: { teleport: true } }, // §13.2：viewer Teleport 后 jsdom 断言需内联渲染
      props: baseProps({
        viewerNode: { id: 'n1', type: 'text', data: { content: '短文' } },
        onViewerClose,
      }),
      attachTo: document.body,
    })
    // ⚠️ 2026-10-25（D2）：左上 `‹`（`.viewer-back`）已删 ⇒ 改为**右上角 X**
    //    （`data-testid="mobile-viewer-close"`，内联 SVG，§4.11.5 禁文本字符当图标）
    await w.find('[data-testid="mobile-viewer-close"]').trigger('click')
    expect(onViewerClose).toHaveBeenCalled()
    w.unmount()
  })
})

describe('提示词摘要条 + 全文审核层退役（v1.5 P / G-21）', () => {
  it('摘要条与全文审核层均不再渲染（chips 直达编辑器，路由归 CanvasPage provide）', () => {
    const w = mount(MobileCanvasShell, {
      global: { stubs: { teleport: true } }, // §13.2：viewer Teleport 后 jsdom 断言需内联渲染
      props: baseProps({
        viewerNode: { id: 'n1', type: 'image', data: { url: 'x.png', prompt: '赛博朋克城市夜景', status: 'confirmed' } },
      }),
      attachTo: document.body,
    })
    expect(w.find('[data-testid="mobile-viewer-prompt-strip"]').exists()).toBe(false)
    expect(w.find('[data-testid="mobile-prompt-review"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('MobileCanvasShell 审核层底栏两键（§17 v2 · 拍板①）', () => {
  it('pending + 有产物 → 批注 / 编辑 两键（⛔ 拒绝/改词/确认 三键退役）', () => {
    const w = mount(MobileCanvasShell, {
      global: { stubs: { teleport: true } }, // §13.2：viewer Teleport 后 jsdom 断言需内联渲染
      props: baseProps({
        viewerNode: { id: 'n1', type: 'image', data: { url: 'x.png', status: 'pending_confirm' } },
      }),
      attachTo: document.body,
    })
    const labels = w.findAll('.mv-chrome-item').map((b) => b.text())
    expect(labels).toEqual(['批注', '编辑'])
    w.unmount()
  })

  it('pending + 无产物 + 有提示词 → 批注 / 编辑（审核内容层为载体，两键不受产物门控）', () => {
    const w = mount(MobileCanvasShell, {
      global: { stubs: { teleport: true } }, // §13.2：viewer Teleport 后 jsdom 断言需内联渲染
      props: baseProps({
        viewerNode: {
          id: 'n1',
          type: 'image',
          data: { prompt: '赛博朋克城市夜景', status: 'pending_confirm' },
        },
      }),
      attachTo: document.body,
    })
    const labels = w.findAll('.mv-chrome-item').map((b) => b.text())
    expect(labels).toEqual(['批注', '编辑'])
    w.unmount()
  })

  it('pending + 无产物且无提示词 → 仍给批注 / 编辑（批注意见可在 composer 自补）', () => {
    const w = mount(MobileCanvasShell, {
      global: { stubs: { teleport: true } }, // §13.2：viewer Teleport 后 jsdom 断言需内联渲染
      props: baseProps({
        viewerNode: { id: 'n1', type: 'image', data: { status: 'pending_confirm' } },
      }),
      attachTo: document.body,
    })
    const labels = w.findAll('.mv-chrome-item').map((b) => b.text())
    expect(labels).toEqual(['批注', '编辑'])
    w.unmount()
  })

  it('confirmed + 有产物 → 仅改词，审核层两键不泄漏到非 pending 节点', () => {
    const w = mount(MobileCanvasShell, {
      global: { stubs: { teleport: true } }, // §13.2：viewer Teleport 后 jsdom 断言需内联渲染
      props: baseProps({
        viewerNode: { id: 'n1', type: 'text', data: { content: '正文', status: 'confirmed' } },
      }),
      attachTo: document.body,
    })
    const labels = w.findAll('.mv-chrome-item').map((b) => b.text())
    // text 节点合法追加「朗读」（viewer 内消化），审核层两键不得泄漏
    expect(labels).toContain('改词')
    expect(labels).not.toContain('批注')
    expect(labels).not.toContain('编辑')
    w.unmount()
  })

  it('编辑保存事件透传：viewer edit-save → onViewerEditSave(nodeId, prompt)', async () => {
    const onViewerEditSave = vi.fn()
    const w = mount(MobileCanvasShell, {
      global: { stubs: { teleport: true } }, // §13.2：viewer Teleport 后 jsdom 断言需内联渲染
      props: baseProps({
        viewerNode: { id: 'n1', type: 'image', data: { prompt: '原词', status: 'pending_confirm' } },
        onViewerEditSave,
      }),
      attachTo: document.body,
    })
    await w.find('[data-testid="mobile-viewer-bottom-edit"]').trigger('click')
    await w.find('[data-testid="mobile-viewer-review-edit"]').setValue('新词')
    await w.find('[data-testid="mobile-viewer-bottom-edit-save"]').trigger('click')
    expect(onViewerEditSave).toHaveBeenCalledWith('n1', '新词')
    w.unmount()
  })

  it('批注锚事件透传：胶囊 ⚓ → onViewerAnnotate（payload 带文字；jsdom 诚实降级路径）', async () => {
    const onViewerAnnotate = vi.fn()
    const w = mount(MobileCanvasShell, {
      global: { stubs: { teleport: true } }, // §13.2：viewer Teleport 后 jsdom 断言需内联渲染
      props: baseProps({
        viewerNode: { id: 'n1', type: 'image', data: { prompt: '原词', status: 'pending_confirm' } },
        onViewerAnnotate,
      }),
      attachTo: document.body,
    })
    await w.find('[data-testid="mobile-viewer-bottom-annotate"]').trigger('click')
    const ink = w.find('[data-testid="mobile-viewer-ink"]')
    // 画笔已迁 useInkOverlay：Pointer Events 采集（touchstart → pointerdown）
    await firePointer(ink.element as Element, 'pointerdown', { pointerId: 1, clientX: 10, clientY: 10 })
    await firePointer(ink.element as Element, 'pointerup', { pointerId: 1 })
    await w.find('[data-testid="mobile-annotation-capsule-input"]').setValue('构图太挤')
    await w.find('[data-testid="mobile-annotation-capsule-anchor"]').trigger('click')
    await vi.waitFor(() => expect(onViewerAnnotate).toHaveBeenCalled())
    expect(onViewerAnnotate.mock.calls[0]![0]).toMatchObject({ text: '构图太挤' })
    w.unmount()
  })
})

describe('MobileCanvasShell §16 真机走查二轮（2026-10-27）', () => {
  const taskProps = {
    nodeGeneratingCount: 2,
    nodePendingNodes: [{ id: 'n9', title: '图' }],
  }

  it('§16-② 窗态（tab=chat + canvasViewVisible）→ 状态栏常驻（定位落地即见确认/取消）', () => {
    const w = mount(MobileCanvasShell, {
      props: baseProps({ mobileAppTab: 'chat', ...taskProps }),
      attachTo: document.body,
      global: { stubs: { teleport: true } },
    })
    expect(w.find('[data-testid="mobile-node-status-bar"]').exists()).toBe(true)
    w.unmount()
  })

  it('§16-② 纯对话（canvasViewVisible=false）→ 状态栏不渲染（画布不在眼前不占底带）', () => {
    const w = mount(MobileCanvasShell, {
      props: baseProps({ mobileAppTab: 'chat', canvasViewVisible: false, ...taskProps }),
      attachTo: document.body,
      global: { stubs: { teleport: true } },
    })
    expect(w.find('[data-testid="mobile-node-status-bar"]').exists()).toBe(false)
    w.unmount()
  })

  it('§16-② 状态栏「N 个生成中」可点 → emit open-tasks（顶栏退役后的任务入口承接）', async () => {
    const w = mount(MobileCanvasShell, {
      props: baseProps({ nodeGeneratingCount: 2, nodePendingNodes: [] }),
      attachTo: document.body,
      global: { stubs: { teleport: true } },
    })
    await w.find('[data-testid="mobile-node-status-open-tasks"]').trigger('click')
    expect(w.text()).toContain('生成任务的定位与重试')
    w.unmount()
  })

  it('§6.3 画布页签常驻渲染顶栏（‹ 返回创作空间 + 项目名 + ⤢；取代生命周期 §16-①）', () => {
    const w = mount(MobileCanvasShell, {
      props: baseProps({ mobileAppTab: 'canvas' }),
      attachTo: document.body,
      global: { stubs: { teleport: true } },
    })
    const bar = w.findComponent({ name: 'MobileTopBar' })
    expect(bar.exists()).toBe(true)
    expect(bar.props('projectName')).toBe('测试项目')
    w.unmount()
  })

  it('§6.2 对话页签仍渲染顶栏（‹ 返回创作空间 + 项目名）', () => {
    const w = mount(MobileCanvasShell, {
      props: baseProps({ mobileAppTab: 'chat', canvasViewVisible: false }),
      attachTo: document.body,
      global: { stubs: { teleport: true } },
    })
    expect(w.findComponent({ name: 'MobileTopBar' }).exists()).toBe(true)
    w.unmount()
  })
})
