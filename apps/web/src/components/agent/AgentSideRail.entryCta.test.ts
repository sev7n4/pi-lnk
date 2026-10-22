// A1 传图引导位（2026-10-22）：空态 chips 区固定一位「传图」CTA。
//
// 为什么必须单独有这一位：10 条真实语料里 5 条依赖素材，但 attachment 相的
// 触发前提是「用户已经传了图」——空态若只有不依赖素材的短句，用户根本不会想到
// 传图 ⇒ attachment 池一条都曝不了光。
//
// 判据卡「行为」不卡文案：CTA 的关键性质是 ① 只在 empty 相出现 ② 点击走传图、
// 不走 fillFromUtterance（否则会计入金句点击率，污染 golden_quote_picked）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')
const tpl = sfc
  .slice(sfc.indexOf('<template>'), sfc.lastIndexOf('</template>'))
  .replace(/<!--[\s\S]*?-->/g, '')

describe('A1 传图引导位', () => {
  it('空态存在独立的传图 CTA（存在性配对）', () => {
    expect(tpl).toContain('data-testid="agent-attachment-cta"')
    expect(sfc).toContain('showAttachmentCta')
  })

  it('只在 empty 相出现：不占用 attachment / selection / artifact 相的展示位', () => {
    // 有素材时 attachment 池自己就是素材话术，再挂一个「传图」是噪音
    expect(sfc).toMatch(/showAttachmentCta[\s\S]{0,200}currentUtterancePhase\.value === 'empty'/)
  })

  it('点击走传图而非金句填充（否则污染 golden_quote_picked）', () => {
    // 精确切到 CTA 按钮自身：金句 chip 紧邻其后，取固定窗口会把
    // fillFromUtterance 一起框进来 —— 那会让「不得走金句填充」这条判据永远假绿。
    const ctaIdx = tpl.indexOf('data-testid="agent-attachment-cta"')
    const ctaBlock = tpl.slice(
      tpl.lastIndexOf('<button', ctaIdx),
      tpl.indexOf('</button>', ctaIdx),
    )
    expect(ctaBlock).toContain('pickImage')
    expect(ctaBlock).not.toContain('fillFromUtterance')
  })
})
