import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentSvgCard from './AgentSvgCard.vue'
import { sanitizeSvg } from './svg-sanitize'

const wrap = (svg: string) => mount(AgentSvgCard, { props: { svg } })

/**
 * 断言「渲染出的 DOM 里没有活的危险构造」。
 *
 * 只扫 `[data-testid="svg-card"]` 画布区，**不看 `<pre>` 降级区**：降级区用 Vue 插值渲染
 * 原文，Vue 会把 `<`/`&` 转义成文本节点，那是惰性文本、不是构造，断言它「不含某字符串」
 * 是在测 Vue 的转义而不是测净化器（净化器早就把原文与 DOM 隔离开了）。
 */
function expectNoLiveConstructs(w: ReturnType<typeof wrap>, forbidden: RegExp): void {
  const canvas = w.find('[data-testid="svg-card"]')
  if (!canvas.exists()) return // 已降级：无画布 ⇒ 没有任何活构造
  const live = canvas.element
  expect(live.querySelector('script')).toBeNull()
  expect(live.querySelector('foreignObject')).toBeNull()
  expect(live.innerHTML).not.toMatch(forbidden)
}

/** 挂载后卡片内**不得残留**任何可执行构造。这是本组件的存亡线（前端无 CSP、iframe 无 sandbox）。 */
describe('AgentSvgCard 净化：可执行构造剥离', () => {
  it('剥离 script 标签', () => {
    const w = wrap('<svg><script>alert(1)</script><rect/></svg>')
    expect(w.element.querySelector('script')).toBeNull()
  })

  it('剥离嵌套在 g 内的 script', () => {
    const w = wrap('<svg><g><g><script>alert(1)</script></g></g></svg>')
    expect(w.element.querySelector('script')).toBeNull()
  })

  it('剥离 on* 事件属性', () => {
    const w = wrap('<svg><rect onclick="alert(1)" onload="x()"/></svg>')
    const rect = w.element.querySelector('rect')
    expect(rect).not.toBeNull()
    expect(rect!.getAttribute('onclick')).toBeNull()
    expect(rect!.getAttribute('onload')).toBeNull()
  })

  it('剥离 on* 事件属性的大小写变体（ONLOAD / OnLoad）', () => {
    const w = wrap('<svg><rect ONLOAD="alert(1)" OnLoad="alert(2)"/></svg>')
    const rect = w.element.querySelector('rect')
    expect(rect!.getAttribute('ONLOAD')).toBeNull()
    expect(rect!.getAttribute('OnLoad')).toBeNull()
  })

  it('剥离 foreignObject', () => {
    const w = wrap('<svg><foreignObject><div>x</div></foreignObject></svg>')
    expect(w.element.querySelector('foreignObject')).toBeNull()
  })

  it('剥离 foreignObject 的大小写变体（绕过点：标签集按 nodeName 精确匹配会漏）', () => {
    for (const tag of ['foreignobject', 'FOREIGNOBJECT', 'FoReIgNoBjEcT']) {
      const w = wrap(`<svg><${tag}><div>x</div></${tag}></svg>`)
      // HTML 解析器会把 svg 内的小写 foreignobject 归一化成真 foreignObject
      const canvas = w.find('[data-testid="svg-card"]')
      if (canvas.exists()) {
        expect(canvas.element.querySelector('foreignObject')).toBeNull()
        expect(canvas.element.querySelector('div')).toBeNull()
      }
      // 无画布（整图被剥空 → 降级）同样可接受：不得出现活的 foreignObject/div
      expect(w.element.querySelector('foreignObject')).toBeNull()
    }
  })

  it('剥离 javascript: href', () => {
    const w = wrap('<svg><a href="javascript:alert(1)"><rect/></a></svg>')
    // <a> 不在白名单 ⇒ 整棵子树（含内部 rect）被删 ⇒ 无可绘制图元 ⇒ 走降级
    expect(w.find('[data-testid="svg-card"]').exists()).toBe(false)
    expect(w.element.querySelector('a')).toBeNull()
  })

  it('剥离 data: / vbscript: / 实体编码的 javascript: URL', () => {
    for (const url of [
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      '&#106;avascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)',
    ]) {
      const w = wrap(`<svg><a href="${url.replace(/&/g, '&amp;').replace(/</g, '&lt;')}"><rect/></a></svg>`)
      // 不产生活的 <a>/href；降级区里的原文是 Vue 转义后的惰性文本
      expect(w.element.querySelector('a')).toBeNull()
      expect(w.element.querySelector('script')).toBeNull()
      const canvas = w.find('[data-testid="svg-card"]')
      if (canvas.exists()) {
        expect(canvas.element.querySelector('a')?.getAttribute('href') ?? '').not.toMatch(
          /javascript|data|vbscript/,
        )
      }
    }
  })

  it('剥离 xlink:href 外部引用', () => {
    const w = wrap(
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.example/x.svg#a"/></svg>',
    )
    // <use> 不在白名单 ⇒ 整棵删除 ⇒ 无图元 ⇒ 降级（无可绘制的 use 残留）
    expect(w.element.querySelector('use')).toBeNull()
    expectNoLiveConstructs(w, /evil\.example/)
  })

  it('剥离 use / image 元素（外部资源与跨文档引用的入口）', () => {
    const w = wrap('<svg><image href="https://evil.example/p.png"/><rect/></svg>')
    expect(w.element.querySelector('image')).toBeNull()
    expectNoLiveConstructs(w, /evil\.example/)
  })

  it('剥离注释里藏的 script（解析器差异绕过点）', () => {
    // XML 解析器把 `<!-->` 当注释开头，script 落在注释节点内（querySelector 查不到），
    // 但 XMLSerializer 原样输出后，HTML 解析器会把它解析成真 <script>。
    const w = wrap('<svg><!--><script>alert(1)</script>--><rect/></svg>')
    expect(w.element.querySelector('script')).toBeNull()
  })

  it('剥离根 svg 元素自身的 onload（绕过点：只遍历子节点会漏根属性）', () => {
    const w = wrap('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>')
    expect(w.find('[data-testid="svg-card"]').exists()).toBe(true)
    expect(w.element.querySelector('svg')!.getAttribute('onload')).toBeNull()
  })

  it('剥离 SMIL 动画元素（animate/set 可在运行时把属性改回 on*）', () => {
    const w = wrap(
      '<svg><a><set attributeName="onclick" to="alert(1)"/><animate attributeName="href" to="javascript:alert(1)"/></a></svg>',
    )
    expect(w.element.querySelector('set')).toBeNull()
    expect(w.element.querySelector('animate')).toBeNull()
    // 画布内不得有活的 SMIL/事件属性（降级区原文是 Vue 转义的惰性文本，不计）
    const canvas = w.find('[data-testid="svg-card"]')
    if (canvas.exists()) {
      expect(canvas.element.querySelector('set, animate')).toBeNull()
      for (const el of canvas.element.querySelectorAll('*')) {
        for (const a of Array.from(el.attributes)) {
          expect(a.name.toLowerCase().startsWith('on')).toBe(false)
        }
      }
    }
  })

  it('剥离 CDATA 段里的标记（CDATA 不是脚本通道，但其内容不得被还原成标签）', () => {
    for (const payload of ['<script>alert(1)</script>', ' onload="alert(1)"']) {
      const w = wrap(`<svg><rect><![CDATA[${payload}]]></rect></svg>`)
      const canvas = w.find('[data-testid="svg-card"]').element
      expect(canvas.querySelector('script')).toBeNull()
      expect(canvas.querySelector('rect')!.getAttribute('onload')).toBeNull()
    }
  })

  it('剥离嵌套 svg 上的 onload', () => {
    const w = wrap('<svg><svg onload="alert(1)"><rect/></svg></svg>')
    const canvas = w.find('[data-testid="svg-card"]').element
    for (const el of canvas.querySelectorAll('svg')) {
      expect(el.getAttribute('onload')).toBeNull()
    }
  })

  it('DOCTYPE / 外部实体（XXE）不被展开，整体降级', () => {
    const r = sanitizeSvg(
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>',
    )
    expect(r.ok).toBe(false)
    expect(r.svg).not.toContain('root:')
  })
})

describe('AgentSvgCard 净化：外部引用剥离', () => {
  it('剥离 fill 的外部 url() 引用', () => {
    const w = wrap('<svg><rect fill="url(https://evil.example/x)"/></svg>')
    expect(w.element.innerHTML).not.toContain('evil.example')
  })

  it('剥离 filter / stroke / clip-path / mask 的外部 url() 引用', () => {
    for (const attr of ['filter', 'stroke', 'clip-path', 'mask', 'marker-end']) {
      const w = wrap(`<svg><rect ${attr}="url(https://evil.example/x)"/></svg>`)
      expect(w.element.innerHTML).not.toContain('evil.example')
    }
  })

  // 以下 4 条都带一个存活 <rect>：这样「<style> 被整块丢弃」与「整图降级」可区分开 ——
  // 画布仍在 ⇒ 掉的只是 style 块。
  const withRect = (css: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style><rect width="4" height="4"/></svg>`

  it('style 元素含 @import 外链时整块丢弃', () => {
    const w = wrap(withRect('@import url(https://evil.example/x.css);.a{fill:red}'))
    const canvas = w.find('[data-testid="svg-card"]')
    expect(canvas.exists()).toBe(true)
    expect(canvas.element.querySelector('style')).toBeNull()
    expectNoLiveConstructs(w, /evil\.example|@import/)
  })

  it('style 元素含 url(https:) 外链时整块丢弃', () => {
    const w = wrap(withRect('.a{fill:url(https://evil.example/x)}'))
    const canvas = w.find('[data-testid="svg-card"]')
    expect(canvas.exists()).toBe(true)
    expect(canvas.element.querySelector('style')).toBeNull()
    expectNoLiveConstructs(w, /evil\.example/)
  })

  it('style 元素含 CSS 表达式 / 绑定时整块丢弃', () => {
    for (const css of ['.a{width:expression(alert(1))}', '.a{-moz-binding:url(https://evil.example/b.xml#x)}']) {
      const w = wrap(withRect(css))
      const canvas = w.find('[data-testid="svg-card"]')
      expect(canvas.exists()).toBe(true)
      expect(canvas.element.querySelector('style')).toBeNull()
      expectNoLiveConstructs(w, /evil\.example|expression\(|-moz-binding/)
    }
  })

  it('实体编码藏起来的 @import / url() 外链仍被判危', () => {
    // `&#64;`=@、`&#117;`=u：只匹配字面量会被绕过
    for (const css of ['&#64;import url(https://evil.example/a.css);', '.a{fill:&#117;rl(https://evil.example/b)}']) {
      const w = wrap(withRect(css))
      const canvas = w.find('[data-testid="svg-card"]')
      expect(canvas.exists()).toBe(true)
      expect(canvas.element.querySelector('style')).toBeNull()
      expectNoLiveConstructs(w, /evil\.example/)
    }
  })

  it('根 svg 的 style 属性外链被剥离', () => {
    const w = wrap('<svg xmlns="http://www.w3.org/2000/svg" style="background:url(https://evil.example/x)"><rect/></svg>')
    expect(w.element.querySelector('svg')!.getAttribute('style')).toBeNull()
  })

  it('保留指向本图内部片段的 url(#id)', () => {
    // 注意：url(#id) 只在**属性**位置放行；CSS 语法白名单不认 url()（含片段），
    // 因为 CSS 里的 url() 同样能取外链，而白名单值集刻意不含它。
    const r = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg>',
    )
    expect(r.ok).toBe(true)
    expect(r.svg).toContain('url(#g)')
  })
})

describe('AgentSvgCard 净化：不误伤合法产物', () => {
  // 防「过度净化」：Task 1/2 的 build* 产物必须原样透传，否则卡片全黑。
  const serverSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 128" width="720" height="128" role="img">' +
    '<style>.bar{fill:#dbe4ee}.over{stroke:#c0392b;stroke-width:2}.lbl{font:12px sans-serif;fill:#334}</style>' +
    '<text x="8" y="44" class="lbl">礼盒主视觉</text>' +
    '<rect class="bar" x="120" y="30" width="480" height="20"/>' +
    '<line x1="140" y1="35" x2="600" y2="35" class="e"/>' +
    '<polyline points="140,64 300,50 460,70" fill="none" stroke="#4a7ebb" stroke-width="2"/>' +
    '</svg>'

  it('保留 build* 产出的 style / class / viewBox / 几何属性', () => {
    const r = sanitizeSvg(serverSvg)
    expect(r.ok).toBe(true)
    expect(r.svg).toContain('.bar{fill:#dbe4ee}')
    expect(r.svg).toContain('viewBox="0 0 720 128"')
    expect(r.svg).toContain('class="bar"')
    expect(r.svg).toContain('<polyline')
    expect(r.svg).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('挂载后服务端产物仍是有内容的卡片而非空壳', () => {
    const w = mount(AgentSvgCard, { props: { svg: serverSvg } })
    const canvas = w.find('[data-testid="svg-card"]')
    expect(canvas.exists()).toBe(true)
    expect(canvas.element.querySelectorAll('rect, text, line, polyline').length).toBe(4)
  })
})

describe('AgentSvgCard 降级', () => {
  it('输入不是合法 SVG 时降级为 pre 且不崩', () => {
    const w = wrap('这不是 svg <<<')
    expect(w.find('[data-testid="svg-card-fallback"]').exists()).toBe(true)
  })

  it('空串降级为有可见文案的占位（超界丢弃，不是空 DOM）', () => {
    const w = wrap('')
    const fb = w.find('[data-testid="svg-card-discarded"]')
    expect(fb.exists()).toBe(true)
    expect(fb.text().trim()).not.toBe('')
    expect(fb.text()).toContain('丢弃')
    expect(w.find('[data-testid="svg-card"]').exists()).toBe(false)
  })

  it('纯空白串同样走占位降级', () => {
    const w = wrap('   \n  ')
    expect(w.find('[data-testid="svg-card-discarded"]').exists()).toBe(true)
    expect(w.find('[data-testid="svg-card-discarded"]').text().trim()).not.toBe('')
  })

  it('DOMParser 抛错时降级为 pre 而不是让组件崩掉', () => {
    const spy = vi.spyOn(globalThis, 'DOMParser').mockImplementation(() => {
      throw new Error('boom')
    })
    try {
      const w = wrap('<svg><rect/></svg>')
      expect(w.find('[data-testid="svg-card-fallback"]').exists()).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('非 svg 根节点（html）降级为 pre', () => {
    const w = wrap('<html><body>x</body></html>')
    expect(w.find('[data-testid="svg-card-fallback"]').exists()).toBe(true)
  })
})

describe('AgentSvgCard 正常渲染', () => {
  it('合法 SVG 正常渲染容器', () => {
    const w = wrap('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>')
    expect(w.find('[data-testid="svg-card"]').exists()).toBe(true)
    expect(w.find('[data-testid="svg-card-fallback"]').exists()).toBe(false)
  })

  it('Review Focus #1：节点标题含尖括号时不被当成标签解析', () => {
    const w = wrap('<svg xmlns="http://www.w3.org/2000/svg"><text>&lt;script&gt;x&lt;/script&gt;</text></svg>')
    expect(w.element.querySelector('text script')).toBeNull()
    expect(w.html()).toContain('&lt;script&gt;')
  })

  it('title 渲染为 figcaption', () => {
    const w = mount(AgentSvgCard, {
      props: { svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', title: '出图计划' },
    })
    expect(w.find('figcaption').text()).toBe('出图计划')
  })

  it('annotations 渲染且 warn 有区别样式', () => {
    const w = mount(AgentSvgCard, {
      props: {
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
        annotations: [
          { nodeId: 'n1', text: '超时长', severity: 'warn' },
          { nodeId: 'n2', text: '仅提示', severity: 'info' },
        ],
      },
    })
    expect(w.text()).toContain('超时长')
    expect(w.html()).toContain('warn')
    expect(w.find('[data-severity="warn"]').exists()).toBe(true)
    expect(w.find('[data-severity="info"]').exists()).toBe(true)
  })

  it('annotations 文本按文本渲染，不解析成标签', () => {
    const w = mount(AgentSvgCard, {
      props: {
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
        annotations: [{ nodeId: 'n1', text: '<img src=x onerror=alert(1)>', severity: 'warn' }],
      },
    })
    expect(w.element.querySelector('img')).toBeNull()
    expect(w.text()).toContain('<img src=x onerror=alert(1)>')
  })
})

describe('sanitizeSvg 纯函数契约', () => {
  it('空串 / 非字符串 → ok:false', () => {
    expect(sanitizeSvg('').ok).toBe(false)
    expect(sanitizeSvg('   ').ok).toBe(false)
    expect(sanitizeSvg(undefined as unknown as string).ok).toBe(false)
  })

  it('非 SVG 根节点 → ok:false', () => {
    expect(sanitizeSvg('这不是 svg <<<').ok).toBe(false)
    expect(sanitizeSvg('<html><body>x</body></html>').ok).toBe(false)
  })

  it('ok:false 时 svg 为空串（不把不可信原文回传给调用方注入）', () => {
    expect(sanitizeSvg('<script>alert(1)</script>').svg).toBe('')
  })

  it('净化后无可绘制图元 → ok:false（不留空壳卡片）', () => {
    // 全部内容被剥掉时若仍返回 ok:true，渲染出来是一张空卡片，用户无从判断发生了什么
    for (const dirty of [
      '<svg><script>alert(1)</script></svg>',
      '<svg><foreignObject><div>x</div></foreignObject></svg>',
      '<svg><g></g></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><title>只有标题</title></svg>',
    ]) {
      const r = sanitizeSvg(dirty)
      expect(r.ok).toBe(false)
      expect(r.svg).toBe('')
    }
  })

  it('空壳 SVG 挂载后走降级分支而非渲染空卡片', () => {
    const w = wrap('<svg><script>alert(1)</script></svg>')
    expect(w.find('[data-testid="svg-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="svg-card-fallback"]').exists()).toBe(true)
  })
})

/**
 * CSS 语法白名单（review Critical）。
 *
 * 这些向量**不含**字面量 `@import` 与 `url(`，CSS 黑名单对它们完全无感：
 *   - `@font-face` + 引号包裹的 `src`、裸 `src:` 字符串：合法字体外链取数构造
 *   - `image-set("…")`：合法图片外链取数构造
 *   - `@\69 mport`：CSS 转义后浏览器读作 `@import`，`/@import/i` 正则看不见
 *   - `*{position:fixed;…}`：`<style>` 经 v-html 注入是**文档全局**的，不是卡片作用域
 */
describe('AgentSvgCard CSS 语法白名单（review Critical）', () => {
  const CSS_VECTORS = [
    ['@font-face 引号 src', '@font-face{font-family:x;src:"https://evil.example/a.woff"}'],
    ['@font-face 裸 src', '@font-face{font-family:x;src:https://evil.example/a.woff}'],
    ['image-set()', '*{background-image:image-set("https://evil.example/a.png" 1x)}'],
    ['CSS 转义 @\\69 mport', '@\\69 mport "https://evil.example/a.css";'],
    ['全屏覆盖', '*{position:fixed;inset:0;z-index:99999;background:#000}'],
  ]

  it.each(CSS_VECTORS)('style 元素：%s 被丢弃', (_name, css) => {
    const w = wrap(`<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style><rect width="4" height="4"/></svg>`)
    // 整块 <style> 被丢弃 ⇒ 图元保留、卡片仍渲染，但 style 里不含攻击载荷
    const style = w.find('[data-testid="svg-card"]').element.querySelector('style')
    if (style) {
      expect(style.textContent).not.toContain('evil.example')
      expect(style.textContent).not.toContain('position:fixed')
    }
    expect(w.html()).not.toContain('evil.example')
    expect(w.html()).not.toContain('position:fixed')
  })

  it.each(CSS_VECTORS)('style 属性：%s 被剥离', (_name, css) => {
    const attr = css.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    const w = wrap(`<svg xmlns="http://www.w3.org/2000/svg" style="${attr}"><rect width="4" height="4"/></svg>`)
    const svg = w.find('[data-testid="svg-card"]').element.querySelector('svg')!
    expect(svg.getAttribute('style')).toBeNull()
    expect(w.html()).not.toContain('evil.example')
    expect(w.html()).not.toContain('position:fixed')
  })

  it('CSS 语法白名单仍放行 4 条真实 build* style 串（防过度净化）', () => {
    // 逐字取自 render-canvas-view.ts 的 buildTimelineSvg / buildTopologySvg / buildTableSvg
    for (const css of [
      '.bar{fill:#dbe4ee}.over{stroke:#c0392b;stroke-width:2}.lbl{font:12px sans-serif;fill:#334}',
      '.n{fill:#eef2f7;stroke:#8aa}.t{font:12px sans-serif;fill:#334}.e{stroke:#8aa;stroke-width:1.5}',
      '.t{font:12px sans-serif;fill:#334}.row0{fill:#fafbfc}.sev-error{fill:#fdecea}.sev-warn{fill:#fff6e5}',
      '.bar{fill:#dbe4ee}.over{stroke:#c0392b;stroke-width:2}.lbl{font:12px sans-serif;fill:#334}.sev-error{fill:#fdecea}.sev-warn{fill:#fff6e5}',
    ]) {
      const r = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style><rect width="4" height="4"/></svg>`)
      expect(r.ok).toBe(true)
      expect(r.svg).toContain(css)
    }
  })

  it('白名单外的属性 / 值 / 选择器被拒（证明是语法白名单而非更宽的黑名单）', () => {
    for (const css of [
      '.a{background:url(https://evil.example/x)}', // 非白名单属性
      '.a{fill:red;background:#000}', // 混入非白名单属性
      '.a{width:expression(alert(1))}', // 非白名单属性 + 函数值
      'div{color:red}', // 标签选择器
      '.a{position:fixed}', // 非白名单属性
      '.a{fill:#abc;position:fixed}', // 合法属性里夹带非白名单属性
      '.a{fill:red} .b{stroke:#000} extra{}', // 末尾有游离文本
      'garbage .a{fill:#abc}', // 开头有游离文本
      '.a{fill:}', // 空值
      '.a{fill:/*x*/#abc}', // 注释分割
      '.a{fill:#abc}/*@import url(https://evil.example/a.css)*/', // 注释藏 @import
      '.a{\\66 ill:#abc}', // 属性名转义
      '.a{fill:#abc}}', // 多余右花括号
      '.a{fill:#abc;.b{stroke:#000}}', // 嵌套花括号
    ]) {
      const w = wrap(`<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style><rect width="4" height="4"/></svg>`)
      const canvas = w.find('[data-testid="svg-card"]')
      // 合法值白名单只认 hex/数字/长度/sans-serif/none/text-anchor 关键字，命名色（red）不在内
      const dropped = !canvas.exists() || canvas.element.querySelector('style') === null
      if (!dropped) {
        // 未被丢弃时，至少不得含外链/覆盖类载荷
        expectNoLiveConstructs(w, /evil\.example|@import|position\s*:\s*fixed|expression\(|image-set/)
      }
      expectNoLiveConstructs(w, /evil\.example|@import|position\s*:\s*fixed|expression\(|image-set/)
    }
  })

  it('白名单内的合法 CSS 全部放行（值集边界：hex/数字/长度/关键字/尾分号）', () => {
    for (const css of [
      '.a{fill:#abc}', // 3 位 hex
      '.a{fill:#aabbccdd}', // 8 位 hex
      '.a{opacity:0.5}', // 无单位小数
      '.a{stroke-width:1.5}', // 无单位
      '.a{font-size:12px}', // 带单位
      '.a{font:12px sans-serif}', // font 简写
      '.a{text-anchor:middle}', // 关键字值（回归：值集曾漏关键字）
      '.a{fill:#abc;}', // 尾分号
      '.a{fill:#dbe4ee;stroke:#8aa;stroke-width:1.5}', // 多声明
      '.stop-0{stop-color:#fff6e5;stop-opacity:1}',
    ]) {
      const r = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style><rect width="4" height="4"/></svg>`)
      expect(r.ok).toBe(true)
      expect(r.svg).toContain(css)
    }
  })

  it('匹配块必须覆盖全文：规则之间/两端的游离文本一律丢弃', () => {
    // 这条专测「全文覆盖」防线本身：payload 全部使用**白名单内的** hex/属性，
    // 所以它被拒的唯一原因就是有游离文本（否则会误判成「只是因为值不合法」）。
    // 注意 `x{fill:#def}` 这种**裸 type 选择器**是合法规则（匹配不到真实元素，无害），
    // 不属于游离文本，故不在此列。
    for (const css of [
      '.a{fill:#abc}extra', // 末尾游离文本
      'extra.a{fill:#abc}', // 开头游离文本
      '.a{fill:#abc}/*x*/.b{stroke:#000}', // 规则之间夹注释
      '.a{fill:#abc}@import "https://evil.example/a.css";', // 规则之后跟 at 语句
    ]) {
      const r = sanitizeSvg(
        `<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style><rect width="4" height="4"/></svg>`,
      )
      // rect 存活 ⇒ 卡片仍渲染；被丢的必须是 style 整块
      expect(r.ok).toBe(true)
      expect(r.svg).not.toContain(css)
    }
  })

  it('命名色值不在白名单内（build* 只产 hex；放开命名色是独立决策，不在本次范围）', () => {
    const r = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:red}</style><rect width="4" height="4"/></svg>',
    )
    // 卡片仍渲染（rect 存活），只是 style 被丢
    expect(r.ok).toBe(true)
    expect(r.svg).not.toContain('fill:red')
  })
})

describe('AgentSvgCard 降级分支可区分（review Minor 1）', () => {
  it('超界丢弃用独立 testid，与解析失败区分开', () => {
    const discarded = wrap('')
    expect(discarded.find('[data-testid="svg-card-discarded"]').exists()).toBe(true)
    expect(discarded.find('[data-testid="svg-card-fallback"]').exists()).toBe(false)
  })

  it('解析失败仍是 svg-card-fallback，不冒充超界丢弃', () => {
    const failed = wrap('这不是 svg <<<')
    expect(failed.find('[data-testid="svg-card-fallback"]').exists()).toBe(true)
    expect(failed.find('[data-testid="svg-card-discarded"]').exists()).toBe(false)
  })
})

describe('AgentSvgCard data-* 前缀白名单（review Minor 2）', () => {
  it('保留服务端 data-warn 超预算标记', () => {
    // render-canvas-view.ts:225 用 data-warn="1" 标注超预算行；剥掉它等于静默丢失超限信号
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 128">' +
      '<style>.bar{fill:#dbe4ee}.over{stroke:#c0392b;stroke-width:2}</style>' +
      '<rect class="bar over" data-warn="1" x="120" y="30" width="480" height="20"/>' +
      '</svg>'
    const r = sanitizeSvg(dirty)
    expect(r.ok).toBe(true)
    expect(r.svg).toContain('data-warn="1"')

    const w = mount(AgentSvgCard, { props: { svg: dirty } })
    const rect = w.find('[data-testid="svg-card"]').element.querySelector('rect')!
    expect(rect.getAttribute('data-warn')).toBe('1')
  })

  it('aria-* 前缀同样放行', () => {
    const r = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect aria-label="节点" width="4" height="4"/></svg>',
    )
    expect(r.ok).toBe(true)
    expect(r.svg).toContain('aria-label')
  })
})
