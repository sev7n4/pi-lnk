import { describe, it, expect } from 'vitest'
// 2026-11-05 真机走查第 3 问：对话框体 ☐ 列被模态遮罩冻住，用户够不着。
// 裁决：☐ 列整体退役，对话页保持常态可操作；回合级分享入口保留。
import raw from './AgentSideRail.vue?raw'

const src = raw
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\/.*$/gm, '')

describe('AgentSideRail 对话页零选择态', () => {
	it('不再渲染任何会话级 ☐ 勾选钮', () => {
		expect(src).not.toContain('data-testid="agent-turn-check"')
		expect(src).not.toContain('agent-turn--share-select')
		expect(src).not.toContain('.agent-turn-check')
	})

	it('不再持有选择态 props / 切换事件', () => {
		expect(src).not.toContain('shareSelectMode')
		expect(src).not.toContain('shareSelectedIds')
		expect(src).not.toContain('toggleShareSelect')
		expect(src).not.toContain('isShareSelected')
	})

	it('回合级分享入口不受影响（仍单选本轮直开面板）', () => {
		expect(src).toContain('@click="openShare(msg)"')
		// 组件挂载位于模板尾段，裁剪注释的正则会跨段吞掉该区 ⇒ 用原始源码断言
		expect(raw).toContain('<ConversationShareSheet')
		expect(raw).toContain('v-model="shareOpen"')
		// 单轮分享没有可切换的范围 ⇒ 隐藏范围行，避免无效控件
		expect(raw).toContain(':show-scope="false"')
	})
})
