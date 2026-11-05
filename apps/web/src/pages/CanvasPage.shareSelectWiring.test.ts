import { describe, it, expect } from 'vitest'
// 2026-11-05 真机走查六问 · 会话级分享接线契约：
// ① 对话页零选择态——只有顶栏一个「分享」入口，不插 ☐、不换顶栏 ✕、不进选择模式；
// ② 点分享直接弹卡片，卡片 ✕ 一次关闭且完整复原范围；
// ③ 面板消费页面层的范围映射，范围切换经 toggleAll 上抛。
import raw from './CanvasPage.vue?raw'

const src = raw
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\/.*$/gm, '')

describe('CanvasPage 会话级分享接线（对话页零选择态）', () => {
	it('点分享只打开面板：不设置任何页面级选择态', () => {
		expect(src).toMatch(/function openShare\(\)[\s\S]{0,200}shareOpen\.value = true/)
		expect(src).not.toContain('shareSelectMode')
		expect(src).not.toContain('shareSelectedIds')
		expect(src).not.toContain('toggleShareSelect')
		expect(src).not.toContain('confirmShare')
	})

	it('关闭一次即完整复原：面板态与范围一起复位', () => {
		expect(src).toMatch(/function closeShare\(\)[\s\S]{0,200}shareOpen\.value = false/)
		expect(src).toMatch(/function closeShare\(\)[\s\S]{0,200}shareIncludeAll\.value = true/)
		expect(src).toContain('@update:model-value="onShareOpenChange"')
		expect(src).toContain(':model-value="shareOpen"')
	})

	it('范围只有「全部 / 空」两态，由卡片 toggleAll 切换', () => {
		expect(src).toContain('const shareIncludeAll = ref(true)')
		expect(src).toContain('function setShareIncludeAll(value: boolean)')
		expect(src).toContain('@toggle-all="setShareIncludeAll"')
		expect(src).toMatch(/const shareSelectedCount = computed\(\(\) => \(shareIncludeAll\.value/)
		expect(src).toContain(':selected-count="shareSelectedCount"')
		expect(src).toContain(':total-count="shareTotalCount"')
	})

	it('对话流与顶栏都不再接选择态 props（背景不被要求可点）', () => {
		expect(src).not.toContain(':share-select-mode=')
		expect(src).not.toContain(':share-selected-ids=')
		expect(src).not.toContain('@toggle-share-select=')
		expect(src).not.toContain(':on-share-cancel=')
		expect(src).not.toContain('agent-turn-check')
	})

	it('面板与上传共用同一范围映射（computed，范围一变即变）', () => {
		expect(src).toMatch(/const shareTurns = computed<ShareTurn\[\]>\(\(\) =>/)
		expect(src).toContain(':turns="shareTurns"')
	})
})
