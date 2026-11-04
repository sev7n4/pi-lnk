import { describe, it, expect } from 'vitest'
// 静态契约：读源文件做正则断言，不挂载组件（避免引入整组件测试栈）。
// 用 Vite ?raw 导入（走 transform，不碰 node fs，规避 broker shim）。
import raw from './AgentSideRail.vue?raw'

const src = raw
	.replace(/\/\*[\s\S]*?\*\//g, '') // 去块注释
	.replace(/<!--[\s\S]*?-->/g, '') // 去 HTML 注释
	.replace(/\/\/.*$/gm, '') // 去行注释

describe('AgentSideRail 分享图标判据静态契约', () => {
	it('分享按钮存在且用 currentColor 内联 SVG', () => {
		expect(src).toContain('分享')
		expect(src).toContain('@click="openShare(msg)"')
		expect(src).toContain('stroke="currentColor"')
	})
	it('分享图标 stroke-width="1.5"（设计系统 §2.11）', () => {
		// 分享按钮的内联 SVG 图标遵循设计系统 1.5px 描边
		const shareBtn = src.match(/@click="openShare\(msg\)"[\s\S]*?<\/button>/)
		expect(shareBtn).not.toBeNull()
		expect(shareBtn![0]).toContain('stroke-width="1.5"')
	})
	it('图标 svg 内部不含 emoji', () => {
		// 精度：只检查 <svg> 图标块内，避免误伤代码库注释里的 ⚠️ 等惯例符号。
		const svgBlocks = src.match(/<svg[\s\S]*?<\/svg>/g) || []
		expect(svgBlocks.length).toBeGreaterThan(0)
		for (const b of svgBlocks) {
			expect(b).not.toMatch(/[😀-🿿⚀-➿]/u)
		}
	})
})
