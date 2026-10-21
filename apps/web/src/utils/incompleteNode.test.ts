/**
 * 「未完成」态前端判据的测试。
 *
 * ⭐ 覆盖三类：① 判据纯函数 ② 占位文案 ③ **组件渲染行为**（挂载 `NeoBaseNode`
 * 后断言 DOM 上的角标）——按仓库纪律，调用点缺陷必须用行为级测试兜底，
 * 断言要落在**可观测出口**（DOM testid），不落在内部状态。
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import {
  NODE_INCOMPLETE_STATUS,
  incompleteBadgeLabel,
  incompleteReasonOf,
  isIncompleteNode,
  nodePlaceholderText,
} from '@/utils/incompleteNode'

vi.mock('@vue-flow/core', () => ({
  useNode: () => ({ id: 'n1' }),
  Handle: { template: '<div class="handle-stub" />' },
  Position: { Left: 'left', Right: 'right' },
}))

import NeoBaseNode from '@/components/canvas/NeoBaseNode.vue'

describe('isIncompleteNode', () => {
  it('status=incomplete ⇒ true', () => {
    expect(isIncompleteNode({ status: NODE_INCOMPLETE_STATUS })).toBe(true)
  })

  it('⛔ 其它状态 ⇒ false（含 generating / completed / failed / 空）', () => {
    for (const s of ['generating', 'completed', 'failed', 'error', 'pending_confirm', '', undefined]) {
      expect(isIncompleteNode({ status: s })).toBe(false)
    }
  })

  it('⛔ 非对象 ⇒ false（不抛）', () => {
    expect(isIncompleteNode(null)).toBe(false)
    expect(isIncompleteNode(undefined)).toBe(false)
    expect(isIncompleteNode('incomplete')).toBe(false)
    expect(isIncompleteNode(42)).toBe(false)
  })
})

describe('incompleteReasonOf', () => {
  it('取后端写入的人话', () => {
    expect(incompleteReasonOf({ status: 'incomplete', incompleteReason: '上游模型调用报错' })).toBe(
      '上游模型调用报错',
    )
  })

  it('⛔ 缺失 / 非字符串 / 空白 ⇒ 空串', () => {
    expect(incompleteReasonOf({ status: 'incomplete' })).toBe('')
    expect(incompleteReasonOf({ status: 'incomplete', incompleteReason: 123 })).toBe('')
    expect(incompleteReasonOf({ status: 'incomplete', incompleteReason: '   ' })).toBe('')
  })
})

describe('incompleteBadgeLabel', () => {
  it('有原因 ⇒ 「未完成 · 原因」', () => {
    expect(incompleteBadgeLabel({ status: 'incomplete', incompleteReason: '工具执行期间中断' })).toBe(
      '未完成 · 工具执行期间中断',
    )
  })

  it('无原因 ⇒ 只「未完成」', () => {
    expect(incompleteBadgeLabel({ status: 'incomplete' })).toBe('未完成')
  })
})

describe('nodePlaceholderText', () => {
  it('⭐ incomplete 优先于 generating（后台任务还在跑但那一轮已中断）', () => {
    expect(nodePlaceholderText('incomplete')).toBe('未完成')
  })

  it('generating 文案可按节点定制（视频节点是「视频生成中...」）', () => {
    expect(nodePlaceholderText('generating', '视频生成中...')).toBe('视频生成中...')
    // ⛔ 定制参数不得影响 incomplete 档
    expect(nodePlaceholderText('incomplete', '视频生成中...')).toBe('未完成')
  })

  it('其余档位保持原样', () => {
    expect(nodePlaceholderText('uploading')).toBe('上传中')
    expect(nodePlaceholderText('generating')).toBe('生成中...')
    expect(nodePlaceholderText('completed')).toBe('上传或等待生成')
    expect(nodePlaceholderText(undefined)).toBe('上传或等待生成')
  })
})

describe('NeoBaseNode 渲染「未完成」角标（行为级）', () => {
  function mountNode(data: Record<string, unknown>) {
    return mount(NeoBaseNode, {
      props: { nodeType: 'image', data, status: String(data.status ?? '') },
      global: { stubs: { Handle: true } },
    })
  }

  it('⭐ status=incomplete ⇒ 渲染角标 + 带原因（DOM 出口）', async () => {
    const wrapper = mountNode({
      status: 'incomplete',
      incompleteReason: '上游模型调用报错',
      url: 'https://example.com/a.png',
    })
    await nextTick()
    const badge = wrapper.find('[data-testid="node-incomplete-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('未完成')
    expect(badge.text()).toContain('上游模型调用报错')
    // 悬浮提示也带原因（用户不一定看得到 textContent）
    expect(badge.attributes('title') ?? '').toContain('上游模型调用报错')
  })

  it('⛔ 其它状态 ⇒ 不渲染角标（防空集假绿）', async () => {
    for (const s of ['generating', 'completed', 'failed', 'pending_confirm', '']) {
      const wrapper = mountNode({ status: s })
      await nextTick()
      expect(wrapper.find('[data-testid="node-incomplete-badge"]').exists()).toBe(false)
    }
  })

  it('⭐ status 走 props.status（各节点组件都显式传）⇒ incomplete 也能识别', async () => {
    // 模拟 CanvasNodeImage 的用法：`:data="data" :status="data.status"`
    const wrapper = mount(NeoBaseNode, {
      props: {
        nodeType: 'image',
        data: { status: 'incomplete', incompleteReason: '工具执行期间中断' },
        status: 'incomplete',
      },
      global: { stubs: { Handle: true } },
    })
    await nextTick()
    expect(wrapper.find('[data-testid="node-incomplete-badge"]').exists()).toBe(true)
  })
})
