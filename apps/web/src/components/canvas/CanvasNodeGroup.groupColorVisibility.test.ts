/**
 * 根因回归：分组背景色「设了但看不见」（2026-10-21 用户实测）。
 *
 * 现象：选中分组 → 工具条点色卡（如 moss/rose）→ `colorKey` 正确写进了
 * `node.data` 并落库，但**虚线框的背景/边框颜色毫无变化**，永远是中性灰。
 * 而同一时刻标题前的 2×2 图标**确实变色了** —— 这个「图标变、框不变」的
 * 矛盾正是本 bug 的指纹。
 *
 * ## 根因：CSS 自定义属性的「自身声明覆盖继承」
 *
 * 注入点在 **wrapper**（CanvasNodeGroup.vue 的 groupStyle 挂在根元素上）：
 *     <div class="group-node-wrapper" style="--group-accent: var(--lnk-group-moss)">
 * 而消费点在它的**子**元素 `.group-node-container`（neo-node.css）里。该规则块
 * 自己在开头又声明了一次同名变量：
 *     .group-node-container { --group-accent: var(--lnk-group-accent, var(--lnk-group-neutral)); }
 * CSS 规定：元素**自身**上的声明优先于从父级**继承**来的同名变量（继承只在
 * 自身没有声明时才生效）。于是 container 上的 `--group-accent` 恒等于
 * `--lnk-group-accent` 的值 —— 而**这个令牌在整个仓库从未被定义**
 * （design-tokens.css 只定义了 `--lnk-group-neutral/moss/dusk/clay/
 * celadon/graphite/rose/plum` 八个），于是整条 var() 引用无效，回落到
 * 第二层兜底 `--lnk-group-neutral` ⇒ **恒为中性灰**。
 *
 * 图标之所以正常：`.group-title-icon` 是 wrapper 的子元素、container 的
 * **兄弟**，它读到的 `--group-accent` 来自继承（wrapper 的注入值），没被
 * container 的自身声明影响。
 *
 * ## 为什么既有测试没抓到
 *
 * `CanvasNodeGroup.test.ts` 的「容器边框/底色从 --group-accent 派生」是
 * **假判据**：它只断言 `.group-node-container` 这个类名在 DOM 里存在 + 组件
 * 内无字面 hex，从不验证 CSS 变量最终解析成什么。色卡链路本身也只断言
 * 「wrapper 上有 `--group-accent: var(--lnk-group-moss)`」——注入端是绿的，
 * 断点在注入与消费之间。本文件补上**消费端**的判据。
 *
 * ## 为什么不能靠 jsdom 断
 *
 * jsdom 无 CSS 级联引擎，`getComputedStyle` 不解析 `var()`、更不解析
 * `color-mix()` ⇒ 拿不到真实渲染色。因此判据分两层：
 * ① **DOM 层**：断言 wrapper→container 的父子关系成立（这是「继承」的前提，
 *    必须被验证而不是假设）；
 * ② **源码层**：断言「消费端规则块不得再声明同名变量」+「不存在幽灵令牌」。
 *    这两条在上面的根因下都必然为真，且**能被变异抓住**（见文件末尾注释）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import CanvasNodeGroup from './CanvasNodeGroup.vue'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(here, 'CanvasNodeGroup.vue'), 'utf8')
const CSS = readFileSync(join(here, '..', '..', 'styles', 'neo-node.css'), 'utf8')
const TOKENS = readFileSync(join(here, '..', '..', 'styles', 'design-tokens.css'), 'utf8')
const ALIAS = readFileSync(join(here, '..', '..', 'styles', 'neowow-tokens.css'), 'utf8')

/** 只扫代码不扫注释（同 CanvasNodeGroup.test.ts 口径）。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
}
const CSS_CODE = stripComments(CSS)
const TOKENS_CODE = stripComments(TOKENS)
const ALIAS_CODE = stripComments(ALIAS)

vi.mock('@vue-flow/core', () => ({
  useNode: () => ({ id: 'group-1' }),
  useVueFlow: () => ({ viewport: { value: { x: 0, y: 0, zoom: 1 } } }),
}))

function mountGroup(data: Record<string, unknown>) {
  return mount(CanvasNodeGroup, {
    props: { data, selected: true },
    global: { provide: {} },
  })
}

/** 取某选择器的规则块正文（与 CanvasNodeGroup.test.ts 同口径）。 */
function ruleBody(selector: string, from = CSS_CODE): string {
  const i = from.indexOf(`${selector} {`)
  expect(i, `找不到规则 ${selector}`).toBeGreaterThan(-1)
  const open = from.indexOf('{', i)
  const close = from.indexOf('}', open)
  return from.slice(open + 1, close)
}

describe('根因回归：colorKey 必须真的影响到框的背景/边框', () => {
  it('⛔ .group-node-container 不得再声明 --group-accent（自身声明会覆盖继承）', () => {
    // 本 bug 的直接根因。这一条在修复前为红：规则块首行就是那句自我覆盖的声明。
    const body = ruleBody('.group-node-container')
    expect(
      body,
      '.group-node-container 自身声明了 --group-accent ⇒ 覆盖掉 wrapper 按 colorKey 注入的值，框恒为中性灰',
    ).not.toMatch(/--group-accent\s*:/)
  })

  it('⛔ --lnk-group-accent 是幽灵令牌，必须从仓库里彻底消失', () => {
    // 上面那句声明引用了一个从未定义的令牌。守的不只是这一个字符串：
    // 任何「消费了 var(--lnk-group-X) 但 --lnk-group-X 无定义」的组合都会
    // 让整条 var() 失效、静默回落默认值 —— 这类 bug 在 CSS 里没有任何报错。
    for (const [name, src] of [
      ['neo-node.css', CSS_CODE],
      ['design-tokens.css', TOKENS_CODE],
      ['neowow-tokens.css', ALIAS_CODE],
      ['CanvasNodeGroup.vue', stripComments(SRC)],
    ] as const) {
      const hits = src.match(/--lnk-group-accent/g) ?? []
      expect(hits, `${name} 仍引用未定义令牌 --lnk-group-accent`).toEqual([])
    }
  })

  it('每个 --group-accent 消费点都必须带兜底（否则注入缺失时边框整体失效）', () => {
    // 容器上不再声明 --group-accent 后，值靠继承而来。若某处注入缺失，
    // `color-mix(in srgb, var(--group-accent) …)` 会因变量未定义而**整条失效**
    // （不是回落灰色，而是 border/background 变 transparent）⇒ 必须逐点兜底。
    //
    // ⚠️ 提取口径不能用 `var\(--group-accent[^)]*\)`：兜底里带嵌套括号
    // （`var(--lnk-group-neutral)`），`[^)]*` 会在**第一个** `)` 处截断，把
    // 合法的 `var(--group-accent, var(--lnk-group-neutral))` 截成
    // `var(--group-accent, var(--lnk-group-neutral)`（少一个右括号）而误判红。
    // 这里手写括号配平：遇到 '(' 深度 +1、遇到 ')' 深度 -1，深度归零才收口。
    function extractConsumers(src: string): string[] {
      const out: string[] = []
      const re = /var\(--group-accent/g
      for (let m = re.exec(src); m; m = re.exec(src)) {
        let depth = 0
        for (let i = m.index; i < src.length; i++) {
          if (src[i] === '(') depth++
          else if (src[i] === ')') {
            depth--
            if (depth === 0) {
              out.push(src.slice(m.index, i + 1))
              break
            }
          }
        }
      }
      return out
    }

    const consumers = extractConsumers(CSS_CODE)
    expect(consumers.length, '没找到任何 --group-accent 消费点，判据可能失效').toBeGreaterThan(0)
    for (const c of consumers) {
      expect(c, `消费点 ${c} 缺兜底`).toMatch(
        /^var\(--group-accent,\s*var\(--lnk-group-neutral\)\)$/,
      )
    }
  })
})

describe('根因回归：注入端与消费端的继承链必须成立', () => {
  it('.group-node-container 必须是 wrapper 的后代（注入在 wrapper、消费在 container）', () => {
    // 「继承」这件事的前提是父子关系。若哪天重构把 container 挪到 wrapper
    // 外面，上面那条「container 不声明」就会从「冗余」变成「框拿不到色」。
    // 断言真实 DOM 结构，不靠源码字面量。
    const wrapper = mountGroup({ title: '第一组', childIds: ['a', 'b'], colorKey: 'moss' })
    const root = wrapper.find('.group-node-wrapper')
    expect(root.exists()).toBe(true)
    expect(root.find('.group-node-container').exists()).toBe(true)
    // 注入值挂在根元素上
    expect(root.attributes('style') ?? '').toContain('var(--lnk-group-moss)')
  })

  it('八个色键在令牌层都有真值定义（colorKey → 渲染色 的映射不断链）', () => {
    // 上游断链同样表现为「设了没反应」：若某个键没有 --lnk-group-<key> 定义，
    // 整条 var() 失效 ⇒ 静默回落。这里把 8 键逐一钉住。
    for (const key of ['neutral', 'moss', 'dusk', 'clay', 'celadon', 'graphite', 'rose', 'plum']) {
      expect(TOKENS_CODE, `design-tokens.css 缺 --lnk-group-${key}`).toMatch(
        new RegExp(`--lnk-group-${key}\\s*:`),
      )
    }
  })

  it('注入端必须拼 --lnk-group-{key}（真源），不得拼已降级的 --neo-group-{key}', () => {
    // --neo-group-* 已在 neowow-tokens.css 降级为别名。消费别名能跑，但新代码
    // 走真源；否则将来别名被棘轮删掉时，这里会静默变灰（同一 bug 的另一条路径）。
    const code = stripComments(SRC)
    expect(code).toMatch(/`var\(--lnk-group-\$\{normalizeGroupColorKey/)
    expect(code).not.toMatch(/--neo-group-\$\{/)
  })
})

/**
 * 变异自检记录（2026-10-21 实跑）：
 * ① 把 `.group-node-container` 首行的
 *      `--group-accent: var(--lnk-group-accent, var(--lnk-group-neutral));`
 *    加回去 ⇒ 「不得再声明 --group-accent」「幽灵令牌」两条同时转红。
 * ② 把 wrapper 注入的 `var(--lnk-group-${…})` 改回 `var(--neo-group-${…})`
 *    ⇒ 「注入端必须拼真源」转红。
 * ③ 删掉某个消费点（`.group-node-container` 的 background）的兜底第二参数
 *    ⇒ 「每个消费点都必须带兜底」转红。
 * 三条判据都能真失败，不是恒真断言。
 */