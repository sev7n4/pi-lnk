import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CP = readFileSync(join(HERE, 'CanvasPage.vue'), 'utf8')

/**
 * J-2 发送必有落点（2026-11-01 改词浮层 v2 规格 · 图 2 G 分支）——源级守卫。
 *
 * 背景（毛边）：意见为空时点【发送】，旧实现落在**空 composer**——用户按了
 * 按钮却无事可发，像死胡同。修法：兜底轻引用仍走 `setComposerInput` 既有
 * 通道（不新开通路），扣扳机者永远是用户。
 *
 * ⭐ 为什么是源级断言而非挂载：CanvasPage 挂载类用例在本机有 OOM(137) 前科
 * （纪律：`--maxWorkers=1` + 逐文件跑仍偶发）⇒ 沿 `CanvasPage.mobileCreateLoop`
 * 的守卫风格，断言「走既有通道」而非重挂载。
 */
describe('移动端改词发送 fallback（J-2 发送必有落点）', () => {
  const body = /function handleMobileNodeSendToAgent\([\s\S]*?\n\}/.exec(CP)?.[0] ?? ''

  it('处理函数存在且兜底走 composeFallbackOpinion', () => {
    expect(body).not.toBe('')
    expect(body).toContain('composeFallbackOpinion')
  })

  it('兜底仍在 setComposerInput 既有通道内（不新开通路）', () => {
    // else 分支：setComposerInput(composeFallbackOpinion(…))
    const elseBranch = /else \{[\s\S]*?composeFallbackOpinion[\s\S]*?\n  \}/.exec(body)?.[0] ?? ''
    expect(elseBranch, '必须能在 else 分支定位 composeFallbackOpinion').not.toBe('')
    expect(elseBranch).toContain('setComposerInput')
  })

  it('兜底取标题降级链（data.title → 类型名），不新增 isMobileLayout 分支', () => {
    expect(body).toMatch(/composeFallbackOpinion\(\s*typeof d\.title === 'string'/)
    // 移动端编排所有权在壳层（PR4 立规）：页面级处理函数不得新增形态分支
    expect(body).not.toContain('isMobileLayout')
  })

  it('切回对话页签的既有行为不变（§4.5 看得见落地）', () => {
    expect(body).toContain("mobileAppTab.value = 'chat'")
  })
})
