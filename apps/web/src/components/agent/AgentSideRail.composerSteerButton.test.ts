// 移动端 composer「流式中插话」按钮态（2026-10-20 真机故障回归守卫）。
//
// 故障：turn 进行中，用户在 composer 输入了补充文字，底部按钮仍恒为「停止」态，
// 且点击会停掉整个 turn —— 插话（steer / followUp）这条既有链路与按钮完全脱钩。
//
// 本守卫锁**契约**（按钮态 = 流式 × 草稿；send() 按草稿分流），不锁某一行字面量：
// 换写法仍应通过；回退到「只看 isStreaming」/「先取消后挂起」必须红。
//
// ⚠️ **不要用「先全局剥注释再全文扫」**：本组件 230KB，JSDoc 里大量 `/* ... *\/`
// 与 `//` 片段会让朴素正则把真源码一起吃掉（实测 `:generating` 直接消失 ⇒ 假红）。
// 改为**按目标结构定点提取**（组件标签块 / 花括号配平函数体），天然不受注释影响。
// 否定断言一律配有效性断言（防空集假绿，见 AGENTS.md 沙箱假阴性纪律）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'AgentSideRail.vue'), 'utf8')

/** 花括号配平提取函数/方法全文（含签名）。找不到返回 null。 */
function fnBody(signature: string): string | null {
  const start = sfc.indexOf(signature)
  if (start === -1) return null
  let depth = 0
  let opened = false
  for (let i = start + signature.length; i < sfc.length; i++) {
    const ch = sfc[i]
    if (ch === '{') {
      depth++
      opened = true
    } else if (ch === '}') {
      depth--
      if (opened && depth === 0) return sfc.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 提取唯一的 <DockGenerateButton ... /> 自闭合标签块。
 * 找不到 / 找到多处一律 throw（而不是返回 null）——让调用点保持非空类型，
 * 免得每处都要 `!` 断言把「提取失败」变成静默通过。
 */
function generateButtonBlock(): string {
  const blocks = [...sfc.matchAll(/<DockGenerateButton[\s\S]*?\/>/g)].map((m) => m[0])
  if (blocks.length !== 1) {
    throw new Error(`DockGenerateButton 标签块应恰好 1 处，实际 ${blocks.length} 处`)
  }
  return blocks[0]!
}

/** 同理：提取函数体，缺失即 throw。 */
function requireFnBody(signature: string): string {
  const body = fnBody(signature)
  if (body === null) throw new Error(`未找到函数：${signature}`)
  return stripLineComments(body)
}

/**
 * 去掉行注释（`//` 到行尾），但**跳过字符串字面量里的 `//`**（如 `'https://'`）。
 *
 * ⚠️ 为什么必须剥：断言是对**代码**的断言，不是对注释的断言。
 * 本组件 230KB，注释里常出现与代码同形的字面量（把旧写法抄进注释做说明）——
 * 不剥就会被注释命中 ⇒ **正向断言空转**（明明代码已改，断言却因注释而绿）、
 * **否定断言假红**（2026-10-21 hotfix 实测踩过：注释里抄了
 * `if (await queueDraftAsPending()) return`，把否定断言打成红）。
 *
 * 只在**已定位的单个函数体**上剥（不是全文），并逐字符跟踪引号状态，
 * 避免把真源码当注释吃掉；引号未闭合时保守地**不剥**（宁可少剥，不可误吃代码）。
 */
function stripLineComments(src: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += src[++i] ?? ''
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
      continue
    }
    out += ch
  }
  return out
}

describe('composer 按钮态随草稿切换（流式中可插话）', () => {
  it('按钮的 generating 绑定同时受草稿约束，不只看 isStreaming', () => {
    const btn = generateButtonBlock()

    // 有效性配对：按钮确实绑定在 composer 上（防空集假绿）
    expect(btn).toContain('@generate="send"')
    expect(btn).toMatch(/:generating="([^"]*)"/)

    const bound = btn.match(/:generating="([^"]*)"/)![1]!

    // 契约：isStreaming 单独决定字形 = 回退到故障态 ⇒ 必须红。
    // 允许：isStreaming && !<草稿> / !<草稿> && isStreaming / 三元嵌套（**两种顺序都放行**，
    // 否则守卫会退化成「锁字面量」，合法改写也假红）。
    expect(
      bound,
      `按钮态只由 isStreaming 决定（:generating="${bound}"）——流式中输入草稿后无法切回发送态，即回归本次修复前的故障`,
    ).toMatch(
      /isStreaming\s*&&\s*!\w+|!\w+\s*&&\s*(?:agent\.)?isStreaming|isStreaming\s*\?[^"]*:|!\w+[^"]*&&[^"]*isStreaming/,
    )

    // 草稿判定必须是「有文本」：只有附件时不该切按钮（附件走不了 steer 文本通道）
    expect(sfc).toMatch(
      /const composerDraftText = computed\(\(\) => Boolean\(input\.value\.trim\(\)\)\)/,
    )
  })

  it('send() 在流式中分流：先挂待发气泡并短路，无草稿才停 turn', () => {
    const body = requireFnBody('async function send()')

    // 有效性配对：两条分支都在
    expect(body).toContain('queueDraftAsPending')
    expect(body).toContain('cancelActiveStream')

    // 顺序契约：先尝试挂气泡。反序（先 cancel）= 有草稿也会停整轮 = 故障态。
    const queueAt = body.indexOf('queueDraftAsPending')
    const cancelAt = body.indexOf('cancelActiveStream')
    expect(
      queueAt,
      'send() 先取消再挂气泡 ⇒ 流式中点按钮仍会停掉整轮 turn（回归本次修复前的故障）',
    ).toBeLessThan(cancelAt)

    // ⭐ 2026-10-21 hotfix：boolean 返回值已废止，改为三态。
    // 契约：**只有 'empty'（根本没有草稿）才允许中止 turn**；'full'（槽位已满）必须分流。
    // 继续用 boolean 判别 = 把「槽位已满」当成「无草稿」⇒ 排满时点按钮停掉整轮 turn。
    // （下面用剥过注释的函数体断言 ⇒ 注释里抄旧写法不会干扰）
    expect(
      body,
      'send() 仍用 boolean 返回值决定是否中止 —— 槽位已满（\'full\'）会被当成无草稿，' +
        '点按钮会停掉正在跑的那一轮 turn',
    ).not.toMatch(/if\s*\(\s*await queueDraftAsPending\(\)\s*\)\s*return/)

    expect(
      body,
      "send() 必须把挂起结果与 'empty' 判别（只有无草稿才中止 turn）",
    ).toMatch(/!==\s*'empty'|!=\s*'empty'/)

    // 有效性配对：判别发生在中止调用**之前**，否则等于没判别
    const discAt = body.search(/!==\s*'empty'|!=\s*'empty'/)
    expect(discAt, "send() 里找不到 'empty' 判别").toBeGreaterThan(-1)
    expect(
      discAt,
      "send() 的 'empty' 判别必须排在 cancelActiveStream() 之前（否则中止先于判别发生）",
    ).toBeLessThan(cancelAt)
  })

  it('回车与按钮共用同一挂起函数（两处逻辑不得分叉）', () => {
    const submit = requireFnBody('async function onComposerSubmit()')
    expect(
      submit,
      'onComposerSubmit() 未复用 queueDraftAsPending() —— 回车与按钮会分叉出两套挂起逻辑',
    ).toContain('queueDraftAsPending')

    const queue = requireFnBody('async function queueDraftAsPending()')

    // 只挂起、不投递：steer/followUp 的送达时机必须由用户在气泡上二选一
    expect(queue).toContain("state: 'pending'")
    expect(
      queue,
      'queueDraftAsPending() 不应直接投递 —— steer/followUp 是两种送达时机，不能替他默认选',
    ).not.toMatch(/deliverQueued\(|runs\/(steer|followup)/)

    // 空草稿不得吞意图：返回 'empty'，让调用方回退到停止语义。
    // ⭐ 2026-10-21 hotfix：此前是 `return false`，而 boolean 把「无草稿」与「槽位已满」
    // 混成同一个 false ⇒ 调用方在满槽位时会中止用户正在跑的那一轮 turn。
    expect(queue).toMatch(/if\s*\(\s*!text\.trim\(\)\s*\)\s*return\s*'empty'/)

    // 槽位已满必须返回**另一个**值（'full'），不能与 'empty' 同形
    expect(
      queue,
      "queueDraftAsPending() 的满槽位出口必须返回 'full'（与 'empty' 分流），" +
        '否则调用方无法区分「没草稿」与「挂不下」',
    ).toMatch(/MAX_QUEUED_SLOTS[\s\S]{0,300}?return\s*'full'/)
  })

  it('流式中按钮 title 如实说明「发送插话」而非「停止」', () => {
    const btn = generateButtonBlock()
    const title = btn.match(/:title="([^"]*)"/)
    expect(title, '发送按钮未绑定 title').toBeTruthy()
    // 有草稿时不得再宣称「停止生成」——那正是用户点下去才发现点错的原因
    expect(title![1]).toMatch(/发送插话/)
  })
})