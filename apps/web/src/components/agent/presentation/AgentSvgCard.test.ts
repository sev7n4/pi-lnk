import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentSvgCard from './AgentSvgCard.vue'
import { sanitizeSvg } from './svg-sanitize'

const wrap = (svg: string) => mount(AgentSvgCard, { props: { svg } })

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
      const canvas = w.find('[data-testid="svg-card"]').element
      // HTML 解析器会把 svg 内的小写 foreignobject 归一化成真 foreignObject
      expect(canvas.querySelector('foreignObject')).toBeNull()
      expect(canvas.querySelector('div')).toBeNull()
    }
  })

  it('剥离 javascript: href', () => {
    const w = wrap('<svg><a href="javascript:alert(1)"><rect/></a></svg>')
    expect(w.html()).not.toContain('javascript:')
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
      expect(w.html()).not.toContain('alert(1)')
      expect(w.html()).not.toContain('msgbox')
    }
  })

  it('剥离 xlink:href 外部引用', () => {
    const w = wrap(
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.example/x.svg#a"/></svg>',
    )
    expect(w.html()).not.toContain('evil.example')
  })

  it('剥离 use / image 元素（外部资源与跨文档引用的入口）', () => {
    const w = wrap('<svg><image href="https://evil.example/p.png"/><rect/></svg>')
    expect(w.element.querySelector('image')).toBeNull()
    expect(w.html()).not.toContain('evil.example')
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
    expect(w.html()).not.toContain('alert(1)')
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

  it('style 元素含 @import 外链时整块丢弃', () => {
    const w = wrap('<svg><style>@import url(https://evil.example/x.css);.a{fill:red}</style></svg>')
    expect(w.element.innerHTML).not.toContain('evil.example')
  })

  it('style 元素含 url(https:) 外链时整块丢弃', () => {
    const w = wrap('<svg><style>.a{fill:url(https://evil.example/x)}</style></svg>')
    expect(w.element.innerHTML).not.toContain('evil.example')
  })

  it('style 元素含 CSS 表达式 / 绑定时整块丢弃', () => {
    for (const css of ['.a{width:expression(alert(1))}', '.a{-moz-binding:url(https://evil.example/b.xml#x)}']) {
      const w = wrap(`<svg><style>${css}</style></svg>`)
      expect(w.element.innerHTML).not.toContain('evil.example')
      expect(w.html()).not.toContain('expression(')
    }
  })

  it('实体编码藏起来的 @import / url() 外链仍被判危', () => {
    // `&#64;`=@、`&#117;`=u：只匹配字面量会被绕过
    for (const css of ['&#64;import url(https://evil.example/a.css);', '.a{fill:&#117;rl(https://evil.example/b)}']) {
      const w = wrap(`<svg><style>${css}</style></svg>`)
      expect(w.element.innerHTML).not.toContain('evil.example')
    }
  })

  it('根 svg 的 style 属性外链被剥离', () => {
    const w = wrap('<svg xmlns="http://www.w3.org/2000/svg" style="background:url(https://evil.example/x)"><rect/></svg>')
    expect(w.element.querySelector('svg')!.getAttribute('style')).toBeNull()
  })

  it('保留指向本图内部片段的 url(#id)', () => {
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

  it('空串降级为有可见文案的 pre 占位（超界丢弃，不是空 DOM）', () => {
    const w = wrap('')
    const fb = w.find('[data-testid="svg-card-fallback"]')
    expect(fb.exists()).toBe(true)
    expect(fb.text().trim()).not.toBe('')
    expect(fb.text()).toContain('丢弃')
    expect(w.find('[data-testid="svg-card"]').exists()).toBe(false)
  })

  it('纯空白串同样走占位降级', () => {
    const w = wrap('   \n  ')
    expect(w.find('[data-testid="svg-card-fallback"]').exists()).toBe(true)
    expect(w.find('[data-testid="svg-card-fallback"]').text().trim()).not.toBe('')
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
})
