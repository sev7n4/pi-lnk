/**
 * agent 产出的 SVG 是**不可信输入**：节点标题、表格文本都来自用户，且最终经 `v-html` 注入 DOM。
 * 前端无 CSP（deploy/nginx.conf 无该头）、iframe 无 sandbox 兜底 ⇒ 本文件是唯一防线。
 *
 * 用浏览器原生 `DOMParser`/`XMLSerializer`，不引 DOMPurify（spec §4.5：不新增运行时依赖）。
 *
 * **按白名单而非黑名单**：黑名单（brief 原案只列 5 类）漏了根元素属性、注释节点、SMIL 动画、
 * data:/vbscript: URL、filter/stroke/clip-path/mask 的外链、命名空间前缀标签等口子，
 * 而 SVG 的可执行构造远多于「标签 + on* + href」这三类。未知构造一律不保留。
 *
 * 失败即降级：`ok:false` + 空串，调用方渲染 `<pre>`，不抛错、不渲染空白。
 */

/** 允许出现的元素。取自 Task 1/2 `build*` 的实际产物 + 纯图形原语；
 *  刻意排除 `a`/`use`/`image`/`script`/`foreignObject`/`animate`/`set` 等可执行或可外链构造。 */
const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'style',
  'title',
  'desc',
  'text',
  'tspan',
  'textpath',
  'rect',
  'line',
  'polyline',
  'polygon',
  'circle',
  'ellipse',
  'path',
  'marker',
  'symbol',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'pattern',
])

/** 允许出现的属性。白名单 ⇒ `on*` 事件属性、`href`/`xlink:href`/`src` 天然不在内。 */
const ALLOWED_ATTRS = new Set([
  'xmlns',
  'xmlns:xlink',
  'viewbox',
  'width',
  'height',
  'preserveaspectratio',
  'version',
  'role',
  'id',
  'class',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'dx',
  'dy',
  'transform',
  'opacity',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'letter-spacing',
  'word-spacing',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'patternunits',
  'patterncontentunits',
  'patterntransform',
  'clip-path',
  'clip-rule',
  'mask',
  'filter',
  'marker-start',
  'marker-mid',
  'marker-end',
  'markerwidth',
  'markerheight',
  'markerunits',
  'orient',
  'refx',
  'refy',
  'style',
])

/** 属性名前缀白名单：这两族不承载脚本/URL，Task 1 产物用 `data-warn` 标注超预算行。 */
const ALLOWED_ATTR_PREFIXES = ['data-', 'aria-']

/** CSS 文本里出现即整体判危的构造。命中就整块丢弃 `<style>`，不做「挖掉一处」——
 *  CSS 解析器的构造（注释分割、转义、嵌套）比正则能覆盖的多，逐条挖必然漏。 */
const CSS_POISON = /@import|expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behavior\s*:|\/\*/i

/** 属性值里的 `url(...)` 目标：只允许同图片段引用（渐变/遮罩/图标复用），其余是外部请求。 */
const URL_REF = /url\s*\(\s*(['"]?)([^)]*?)\1\s*\)/gi

function isDangerousCss(css: string): boolean {
  if (CSS_POISON.test(css)) return true
  URL_REF.lastIndex = 0
  for (let m = URL_REF.exec(css); m !== null; m = URL_REF.exec(css)) {
    if (!m[2].trim().startsWith('#')) return true
  }
  return false
}

/** 属性值含 `url()` 时，只有全部指向 `#片段` 才放行。 */
function hasUnsafeUrlRef(value: string): boolean {
  if (!/url\s*\(/i.test(value)) return false
  return isDangerousCss(value)
}

function sanitizeAttrs(el: Element): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    const keep =
      ALLOWED_ATTRS.has(name) || ALLOWED_ATTR_PREFIXES.some((p) => name.startsWith(p))
    if (!keep) {
      el.removeAttribute(attr.name)
      continue
    }
    // style 属性与 url() 引用都要过 CSS 判危；`style="fill:url(https://evil)"` 是外链口子。
    if (name === 'style' || hasUnsafeUrlRef(attr.value)) {
      if (isDangerousCss(attr.value)) el.removeAttribute(attr.name)
    }
  }
}

function scrub(el: Element): void {
  sanitizeAttrs(el)
  for (const node of Array.from(el.childNodes)) {
    // 注释与处理指令是**解析器差异**口子：XML 解析器把 `<!--><script>…` 里的 script 归入注释
    // （querySelector 查不到），XMLSerializer 原样输出后 HTML 解析器却会把它变成真 <script>。
    // 产物里没有任何东西依赖注释，直接删。
    if (node.nodeType === 8 /* comment */ || node.nodeType === 7 /* PI */) {
      node.parentNode?.removeChild(node)
      continue
    }
    if (node.nodeType !== 1) continue
    const child = node as Element
    const local = child.localName.toLowerCase()
    if (!ALLOWED_ELEMENTS.has(local)) {
      child.remove()
      continue
    }
    if (local === 'style' && isDangerousCss(child.textContent ?? '')) {
      child.remove()
      continue
    }
    scrub(child)
  }
}

export interface SanitizeSvgResult {
  ok: boolean
  /** ok:true 时是净化后的良构 SVG 串；ok:false 时恒为 ''（不把不可信原文回传给注入层）。 */
  svg: string
}

export function sanitizeSvg(dirty: string): SanitizeSvgResult {
  if (typeof dirty !== 'string' || dirty.trim() === '') return { ok: false, svg: '' }
  let doc: Document
  let out: string
  try {
    doc = new DOMParser().parseFromString(dirty, 'image/svg+xml')
    const root = doc.documentElement
    // image/svg+xml 解析失败时浏览器产出 <parsererror> 根；非 svg 根（html/text）一并拒。
    if (!root || root.localName.toLowerCase() !== 'svg') return { ok: false, svg: '' }
    scrub(root)
    out = new XMLSerializer().serializeToString(root)
  } catch {
    // DOMParser/XMLSerializer 抛错（如 jsdom 缺实现）同样降级，不让净化失败炸掉聊天渲染。
    return { ok: false, svg: '' }
  }
  if (out.trim() === '') return { ok: false, svg: '' }
  return { ok: true, svg: out }
}
