import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import MobileNodeActionSheet from './MobileNodeActionSheet.vue'
import MobileNodeTile from './MobileNodeTile.vue'
import { CANVAS_MULTI_SELECT_ACTIVE_KEY } from '@/composables/canvasNodeActions'

const HERE = dirname(fileURLToPath(import.meta.url))
const TILE = readFileSync(join(HERE, 'MobileNodeTile.vue'), 'utf8')
const CP = readFileSync(join(HERE, '..', '..', 'pages', 'CanvasPage.vue'), 'utf8')

/**
 * R4-T3 / R4-T4：移动端节点操作类补齐。
 *
 * 取证（代码级）：
 * - **重命名完全失效**：动作 sheet 声明 `rename`（`MobileNodeActionSheet.vue:21`）→
 *   接线写 `renameRequestNodeId`（`CanvasPage.vue:4684`）→ provide → **唯一消费端
 *   `NeoBaseNode.vue:133` 在移动端被旁路**（`NodeRenderer.vue:35` 移动端渲染
 *   `MobileNodeTile`，不渲染 `NeoBaseNode`）⇒ 无人消费 ⇒ **点了零反馈**。
 * - **动作 sheet 选完不关**：`handleMobileNodeAction` 从不调 `closeMobileNodeAction()`。
 * - **多选无勾选徽标**：PC 的 `.neo-node-multi-badge`（`neo-node.css:428`）绑定
 *   `.neo-node` ⇒ 移动端磁贴（`.mobile-node-tile`）永远命中不到。
 */
describe('R4-T3/R4-T4 移动端节点操作类', () => {
  describe('T3 重命名：动作 sheet 内联输入', () => {
    // ⚠️ 2026-10-25（§4.11 Menu 化）：Menu 走 `MobileSheet` 基座 ⇒ **必须 stub
    //    teleport**（VTU 默认把 Teleport 内容送到 document.body，wrapper.find 找不到）。
    //    且「重命名」是**二级**项（§4.11.3 低频下沉）⇒ 需先点「更多」。
    function mountSheet(node = { id: 'n1', type: 'image', data: { title: '旧标题' } }) {
      return mount(MobileNodeActionSheet, {
        props: { node },
        global: { stubs: { teleport: true } },
      })
    }

    /**
     * 展开二级「更多」菜单（**容错**）。
     *
     * ⚠️ 本组用例的节点**无 url**（empty 态）⇒ 一级不足 5 项 ⇒ 「重命名」被
     *   **回填到一级**（§4.11.3 的上下文裁剪）⇒ 此处根本没有「更多」按钮。
     *   故：存在才展开，不存在就直接点一级项。
     */
    async function openMore(w: ReturnType<typeof mountSheet>) {
      const more = w.find('[data-action="more"]')
      if (more.exists()) await more.trigger('click')
    }

    it('点「重命名」→ 出现输入框（不再静默）', async () => {
      const w = mountSheet()
      await openMore(w)
      await w.find('[data-action="rename"]').trigger('click')
      expect(w.find('[data-testid="mobile-action-rename-input"]').exists()).toBe(true)
      w.unmount()
    })

    it('输入框初值 = 当前标题', async () => {
      const w = mountSheet()
      await openMore(w)
      await w.find('[data-action="rename"]').trigger('click')
      const input = w.find('[data-testid="mobile-action-rename-input"]')
      expect((input.element as HTMLInputElement).value).toBe('旧标题')
      w.unmount()
    })

    it('确定 → emit rename(新标题)', async () => {
      const w = mountSheet()
      await openMore(w)
      await w.find('[data-action="rename"]').trigger('click')
      await w.find('[data-testid="mobile-action-rename-input"]').setValue('新标题')
      await w.find('[data-action="rename-confirm"]').trigger('click')
      expect(w.emitted('rename')?.[0]).toEqual(['新标题'])
      w.unmount()
    })

    it('取消 → 不 emit rename', async () => {
      const w = mountSheet()
      await openMore(w)
      await w.find('[data-action="rename"]').trigger('click')
      await w.find('[data-action="rename-cancel"]').trigger('click')
      expect(w.emitted('rename')).toBeUndefined()
      w.unmount()
    })

    it('重命名态下不再列出动作列表（避免同时可点的歧义）', async () => {
      const w = mountSheet()
      await openMore(w)
      await w.find('[data-action="rename"]').trigger('click')
      expect(w.find('[data-action="duplicate"]').exists()).toBe(false)
      w.unmount()
    })

    it('不再走 PC 的 renameRequestNodeId 通道（移动端那条路无人消费）', () => {
      const body = /function handleMobileNodeAction\(action: string, nodeId: string\) \{[\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
      expect(body).not.toContain('renameRequestNodeId.value = nodeId')
      // 但仍要有移动端自己的重命名提交入口
      expect(CP).toContain('function handleMobileNodeRename(nodeId: string, title: string)')
    })

    it('移动端重命名落库复用既有 renameNodeById（合并语义，不丢 prompt/参数）', () => {
      const body = /function handleMobileNodeRename\(nodeId: string, title: string\) \{[\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
      expect(body).toContain('renameNodeById')
    })
  })

  describe('T4 动作 sheet 选完即关', () => {
    it('handleMobileNodeAction 末尾统一 closeMobileNodeAction()', () => {
      const body = /function handleMobileNodeAction\(action: string, nodeId: string\) \{[\s\S]*?\n\}/.exec(CP)?.[0] ?? ''
      expect(body).toContain('closeMobileNodeAction()')
    })
  })

  describe('T4 多选勾选徽标', () => {
    function mountTile(multiActive: boolean, selected: boolean) {
      return mount(MobileNodeTile, {
        props: { id: 'n1', type: 'image', data: { url: 'https://x/a.png' }, selected },
        global: {
          provide: { [CANVAS_MULTI_SELECT_ACTIVE_KEY as symbol]: { value: multiActive } },
        },
      })
    }

    it('多选态 + 已选中 → 渲染勾选徽标', () => {
      const w = mountTile(true, true)
      expect(w.find('.mobile-node-multi-badge').exists()).toBe(true)
      w.unmount()
    })

    it('多选态 + 未选中 → 无徽标', () => {
      const w = mountTile(true, false)
      expect(w.find('.mobile-node-multi-badge').exists()).toBe(false)
      w.unmount()
    })

    it('非多选态 + 已选中 → 无徽标（单选不是多选语义）', () => {
      const w = mountTile(false, true)
      expect(w.find('.mobile-node-multi-badge').exists()).toBe(false)
      w.unmount()
    })

    it('磁贴声明 selected prop（否则 vue-flow 的 selected 只是 DOM attribute）', () => {
      expect(TILE).toMatch(/selected\?: boolean/)
    })

    it('磁贴消费 PC 同一多选注入键（判据单一真源）', () => {
      expect(TILE).toContain('CANVAS_MULTI_SELECT_ACTIVE_KEY')
    })

    it('用磁贴自有类名（不改 PC 的 .neo-node-multi-badge）', () => {
      expect(TILE).toContain('.mobile-node-multi-badge')
    })
  })
})
