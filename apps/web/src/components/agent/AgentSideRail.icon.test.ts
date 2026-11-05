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
	it('有帮助/无帮助 为清晰线性拇指（Feather 拇指字形，非旧旋涡 path）', () => {
		// 旧 path 把整只手旋转 180°，渲染成旋涡状，读不出「拇指向下」
		expect(src).toContain('M14 9V5a3 3 0 0 0-3-3L7 11v11h11.28')
		expect(src).toContain('M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72')
		expect(src).not.toContain('M17 13V5m0 8v3a2 2 0 0 1-2 2h-1.5')
		expect(src).not.toContain('M7 11v8m0-8V7a2 2 0 0 1 2-2h1.5')
	})
})
