/**
 * 从 SFC 源码里定点提取代码片段的测试辅助（**仅测试用**，生产代码不引用）。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────────
 * `AgentSideRail.vue` 有 230KB，且 JSDoc/行注释里大量出现与代码**同形**的字面量
 * （例如把旧写法抄进注释做说明）。断言是对**代码**的断言：
 *  - 不剥注释 ⇒ 正向断言可能被**注释**命中而空转（代码已改，断言却因注释而绿）
 *  - 不剥注释 ⇒ 否定断言被**注释**打成红（2026-10-21 实测假红）
 *
 * ⚠️ 剥注释**只作用在已定位的单个函数体**上（不是全文）：全局剥会把真源码当注释吃掉
 * （本仓 2026-10-21 前踩过：朴素正则让 `:generating` 直接消失 ⇒ 假红）。
 */

/**
 * 去掉行注释（`//` 到行尾），但**跳过字符串字面量里的 `//`**（如 `'https://'`）。
 *
 * 逐字符跟踪引号状态；引号未闭合时保守地**不剥**（宁可少剥，不可误吃代码）。
 */
export function stripLineComments(src: string): string {
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

/**
 * 花括号配平提取函数/方法全文（含签名）。找不到返回 null。
 *
 * 签名是**前缀匹配**：`'async function send()'` 能命中
 * `async function send(): Promise<void> {`（泛型/返回类型在括号之后，不影响配平起点）。
 */
export function fnBody(sfc: string, signature: string): string | null {
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
 * 同 {@link fnBody}，但**先剥行注释**再返回；找不到即 throw（让调用点保持非空类型，
 * 免得每处都要 `!` 断言把「提取失败」变成静默通过）。
 */
export function requireFnBody(sfc: string, signature: string): string {
  const body = fnBody(sfc, signature)
  if (body === null) throw new Error(`未找到函数：${signature}`)
  return stripLineComments(body)
}
