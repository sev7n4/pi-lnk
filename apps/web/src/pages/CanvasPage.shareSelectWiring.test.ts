import { describe, it, expect } from 'vitest'
// 会话级分享勾选接线契约（用户裁决 2026-11-05 · 极简化）：
// ① 点顶栏「分享」**直接弹分享面板**（不再需要顶栏 ✓ 二次确认）；
// ② 面板顶部自带「☑ 全选 / ✕ 取消」，一步完成选择；
// ③ 面板消费页面层的勾选集映射（shareTurns 为 computed），勾选变化即变；
// ④ 顶栏选择态只保留「✕ 退出选择」。
import raw from './CanvasPage.vue?raw'

const src = raw
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\/.*$/gm, '')

describe('CanvasPage 会话级分享勾选接线（极简版）', () => {
	it('顶栏「分享」进入勾选态并**直接打开面板**（无二次确认）', () => {
		expect(src).toMatch(/function openShare\(\)[\s\S]{0,400}shareSelectedIds\.value = agent\.messages\.map\(\(m\) => m\.id\)/)
		expect(src).toMatch(/function openShare\(\)[\s\S]{0,400}shareSelectMode\.value = true/)
		expect(src).toMatch(/function openShare\(\)[\s\S]{0,400}shareOpen\.value = true/)
	})

	it('不再存在「顶栏 ✓ 二次确认」链路（confirmShare 已下线）', () => {
		expect(src).not.toContain('confirmShare')
		expect(src).not.toContain('on-share-confirm')
	})

	it('面板消费勾选集映射（computed，随勾选变化）', () => {
		expect(src).toMatch(/const shareTurns = computed<ShareTurn\[\]>\(\)/)
		expect(src).toMatch(/const shareTurns = computed<ShareTurn\[\]>\(\)[\s\S]{0,400}picked\.has\(m\.id\)/)
	})

	it('面板顶部一键全选 / 一键取消（页面层改勾选集）', () => {
		expect(src).toContain('function selectAllShare()')
		expect(src).toContain('function clearShareSelection()')
		expect(src).toContain('@select-all="selectAllShare"')
		expect(src).toContain('@clear-all="clearShareSelection"')
	})

	it('面板拿到计数（已选 N / M）', () => {
		expect(src).toContain(':selected-count="shareSelectedIds.length"')
		expect(src).toContain(':total-count="shareTotalCount"')
	})

	it('退出选择态同时关闭面板', () => {
		expect(src).toMatch(/function cancelShareSelect\(\)[\s\S]{0,200}shareOpen\.value = false/)
		expect(src).toContain(':on-share-cancel="cancelShareSelect"')
	})

	it('对话流 ☐ 接线保留（逐条挑选）', () => {
		expect(src).toContain(':share-select-mode="shareSelectMode"')
		expect(src).toContain(':share-selected-ids="shareSelectedIds"')
		expect(src).toContain('@toggle-share-select="toggleShareSelect"')
	})
})
