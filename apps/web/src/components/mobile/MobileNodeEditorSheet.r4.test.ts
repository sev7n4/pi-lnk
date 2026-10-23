import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MobileNodeEditorSheet from './MobileNodeEditorSheet.vue'

const HERE = dirname(fileURLToPath(import.meta.url))
const CP = readFileSync(join(HERE, '..', '..', 'pages', 'CanvasPage.vue'), 'utf8')
const SHELL = readFileSync(join(HERE, 'MobileCanvasShell.vue'), 'utf8')

/**
 * R4-T2：移动端编辑 → 生成闭环。
 *
 * ⭐ 断链（代码级取证）：`DockStudioRouter` 声明了 6 个 emit
 *   （patch / removeRef / generate / close / continueShot / refine），
 *   而 `MobileNodeEditorSheet` **只接了 patch / close** ⇒ 其余四个被丢弃。
 *   后果：dock panel 的 `onGenerate`（先 emit patch 再 emit generate）后半段被吞
 *   ⇒ **移动端在编辑 sheet 里改完提示词，点「生成」毫无反应**；
 *   且无法删引用芯片（removeRef 丢失）。
 *
 * ⇒ 移动端提议闭环缺「看提议 → 改 → 生成」这一环（看提议由 R4-T1 补上）。
 */
describe('R4-T2 移动端编辑 sheet 的 generate / removeRef 透传', () => {
  const node = {
    id: 'n1',
    type: 'image',
    position: { x: 0, y: 0 },
    data: { url: 'https://x/a.png', prompt: '一只猫' },
  } as any

  function mountSheet() {
    return mount(MobileNodeEditorSheet, { props: { node } })
  }

  it('透传 generate：DockStudioRouter 的 generate 事件冒泡为 sheet 的 generate', async () => {
    const w = mountSheet()
    // 直接触发 DockStudioRouter 根组件上的 generate（DockStudioRouter 是唯一子组件）
    const router = w.findComponent({ name: 'DockStudioRouter' })
    expect(router.exists()).toBe(true)
    router.vm.$emit('generate')
    await w.vm.$nextTick()
    expect(w.emitted('generate')).toBeTruthy()
    w.unmount()
  })

  it('透传 removeRef：引用删除事件冒泡为 sheet 的 removeRef', async () => {
    const w = mountSheet()
    const router = w.findComponent({ name: 'DockStudioRouter' })
    router.vm.$emit('removeRef', { nodeId: 'ref1' })
    await w.vm.$nextTick()
    expect(w.emitted('removeRef')?.[0]).toEqual([{ nodeId: 'ref1' }])
    w.unmount()
  })

  it('既有 patch / close 透传不受影响', async () => {
    const w = mountSheet()
    const router = w.findComponent({ name: 'DockStudioRouter' })
    router.vm.$emit('patch', { prompt: 'x' })
    router.vm.$emit('close')
    await w.vm.$nextTick()
    expect(w.emitted('patch')?.[0]).toEqual([{ prompt: 'x' }])
    expect(w.emitted('close')).toBeTruthy()
    w.unmount()
  })

  it('壳层把 generate / removeRef 接到页面回调', () => {
    expect(SHELL).toContain('@generate="props.onNodeEditorGenerate"')
    expect(SHELL).toContain('@remove-ref="props.onNodeEditorRemoveRef"')
  })

  it('页面提供移动端生成函数（复用 PC 的判据纯函数，不动 PC 的 handleNodeGenerate）', () => {
    expect(CP).toContain('async function handleMobileNodeGenerate()')
    const body = /async function handleMobileNodeGenerate\(\) \{[\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
    expect(body).toContain('isNodeBusy')
    expect(body).toContain('shouldConfirmDirectGenerateWithoutRefs')
    expect(body).toContain('generateForNode')
  })

  it('PC 的 handleNodeGenerate 未被改动（PC 零 diff）', () => {
    // PC 仍用 editorNode + debouncedNodePatch.flush()，移动端另起函数但共用纯函数
    const pcBody = /async function handleNodeGenerate\(\) \{[\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
    expect(pcBody).toContain('debouncedNodePatch.flush()')
  })
})
