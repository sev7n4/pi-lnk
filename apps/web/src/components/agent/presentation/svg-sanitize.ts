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

/**
 * 允许出现的元素。取自 Task 1/2 `build*` 的实际产物 + 纯图形原语；
 * 刻意排除 `a`/`use`/`image`/`script`/`foreignObject`/`animate`/`set` 等可执行或可外链构造。
 *
 * 表里的 `path`/`circle`/`ellipse`/`polygon`/`marker`/`symbol`/`mask`/`pattern`/`*Gradient`/
 * `stop`/`textpath`/`clippath` 目前 `build*` 都不产出，是**有意的向前余量**（Task 1 后续视图扩展
 * 无需先改净化器）；它们本身不携带脚本或外链构造，故留在白名单内是安全的。
 */
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

/**
 * CSS **语法白名单**（不是黑名单）。
 *
 * 黑名单（`@import` / `url(` 字面量）挡不住这些取数与覆盖构造，它们都不含那两个字面量：
 *   - `@font-face{…src:"https://…"}` / `src:https://…`  —— 合法字体外链取数
 *   - `image-set("https://…")`                        —— 合法图片外链取数
 *   - `@\69 mport "https://…"`                        —— CSS 转义后浏览器读作 `@import`，正则看不见
 *   - `*{position:fixed;inset:0;z-index:99999}`       —— `<style>` 经 v-html 注入是**文档全局**的
 *
 * 故此处只放行「Task 1/2 `build*` 实际产出的那几行样式」，其余整块丢弃：
 * 命中 `@` 即拒（杀尽一切 at-rule，含转义形态），选择器/属性/值逐项走白名单，
 * 且**匹配块必须覆盖输入全文**（末尾游标须正好走完），否则有游离文本可藏。
 */
const CSS_SELECTOR = /^[.#]?[A-Za-z][\w-]*$/
const CSS_PROPERTY = new Set([
  'fill',
  'stroke',
  'stroke-width',
  'font',
  'font-size',
  'text-anchor',
  'opacity',
  'stop-color',
  'stop-opacity',
])
/** 值只认：hex 色、纯数字/长度、`12px sans-serif`、`sans-serif`、`none`、以及
 *  `text-anchor` 的合法关键字（该属性在本白名单里却漏了关键字值，等于埋雷）。 */
const CSS_VALUE =
  /^(?:#[0-9a-fA-F]{3,8}|[0-9]+(?:\.[0-9]+)?(?:px|em|%)?|[0-9]+px\s+sans-serif|sans-serif|none|start|middle|end|center)$/

/** 一条规则：`选择器{声明;声明}`。选择器捕获组供 `CSS_SELECTOR` 收紧；`{}`/`{` 不匹配 ⇒ 判危。 */
const CSS_RULE = /([.#]?[A-Za-z][\w-]*)\{[^{}]*\}/g
const CSS_DECL = /([\w-]+)\s*:\s*([^;]+)/g

/**
 * 声明块白名单：`fill:red;stroke:#000` 逐条走属性集 + 值集；
 * 匹配后把声明从原文剔掉，**残留不得有非空白**（否则有游离垃圾/函数值/嵌套可藏）。
 */
function isSafeCssDeclarations(decls: string): boolean {
  const text = decls.trim()
  if (text === '') return true
  let rest = text
  let matched = 0
  CSS_DECL.lastIndex = 0
  for (let d = CSS_DECL.exec(text); d !== null; d = CSS_DECL.exec(text)) {
    if (!CSS_PROPERTY.has(d[1].toLowerCase())) return false
    if (!CSS_VALUE.test(d[2].trim())) return false
    rest = rest.replace(d[0], '')
    matched++
  }
  if (matched === 0) return false
  return rest.replace(/[;\s]/g, '') === ''
}

/**
 * `<style>` 元素的**规则表**白名单（style 属性走 `isSafeCssDeclarations`，无选择器层）。
 * 规则之间的空白以外若有游离文本 ⇒ 判危（匹配块必须正好覆盖全文，游标须走到底）。
 */
function isSafeCssRuleset(css: string, allowEmpty = false): boolean {
  const text = css.trim()
  if (text === '') return allowEmpty
  // at-rule 一律拒：`@` 字面量在转义形态（`@\69 mport`）里依然出现；
  // 纯转义（`\40 import`）也过不了 CSS_RULE 的选择器字符集（`\` 不在首字符集里）。
  if (text.includes('@')) return false
  let cursor = 0
  let matched = 0
  CSS_RULE.lastIndex = 0
  for (let rule = CSS_RULE.exec(text); rule !== null; rule = CSS_RULE.exec(text)) {
    if (!CSS_SELECTOR.test(rule[1])) return false
    // 规则之间只允许空白
    if (text.slice(cursor, rule.index).trim() !== '') return false
    const body = rule[0].slice(rule[0].indexOf('{') + 1, -1)
    if (!isSafeCssDeclarations(body)) return false
    cursor = rule.index + rule[0].length
    matched++
  }
  if (matched === 0) return false
  return text.slice(cursor).trim() === ''
}

/** 属性值里的 `url(...)`：只允许同图片段引用（渐变/遮罩/图标复用），其余是外部请求。 */
const URL_REF = /url\s*\(\s*(['"]?)([^)]*?)\1\s*\)/gi

function hasUnsafeUrlRef(value: string): boolean {
  if (!/url\s*\(/i.test(value)) return false
  URL_REF.lastIndex = 0
  for (let m = URL_REF.exec(value); m !== null; m = URL_REF.exec(value)) {
    if (!m[2].trim().startsWith('#')) return true
  }
  return false
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
    // `style` 属性是一串声明（无选择器），走声明白名单；其余属性只额外查 url() 外链
    // （`fill="url(https://evil)"` 这类外链口子，且 url(#id) 片段引用要放行）。
    if (name === 'style') {
      if (!isSafeCssDeclarations(attr.value)) el.removeAttribute(attr.name)
    } else if (hasUnsafeUrlRef(attr.value)) {
      el.removeAttribute(attr.name)
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
    if (local === 'style' && !isSafeCssRuleset(child.textContent ?? '', true)) {
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

/** 会产生可见图形的元素。`<defs>`/`<style>`/`<title>` 等容器不计数。 */
const DRAWABLE_ELEMENTS = new Set([
  'rect',
  'line',
  'polyline',
  'polygon',
  'circle',
  'ellipse',
  'path',
  'text',
  'tspan',
])

/** 净化后残留的可绘制图元数（根元素自身也算）。 */
function countDrawable(root: Element): number {
  let n = DRAWABLE_ELEMENTS.has(root.localName.toLowerCase()) ? 1 : 0
  for (const el of Array.from(root.getElementsByTagName('*'))) {
    if (DRAWABLE_ELEMENTS.has(el.localName.toLowerCase())) n++
  }
  return n
}

export function sanitizeSvg(dirty: string): SanitizeSvgResult {
  if (typeof dirty !== 'string' || dirty.trim() === '') return { ok: false, svg: '' }
  let doc: Document
  let out: string
  let drawable = 0
  try {
    doc = new DOMParser().parseFromString(dirty, 'image/svg+xml')
    const root = doc.documentElement
    // image/svg+xml 解析失败时浏览器产出 <parsererror> 根；非 svg 根（html/text）一并拒。
    if (!root || root.localName.toLowerCase() !== 'svg') return { ok: false, svg: '' }
    scrub(root)
    drawable = countDrawable(root)
    out = new XMLSerializer().serializeToString(root)
  } catch {
    // DOMParser/XMLSerializer 抛错（如 jsdom 缺实现）同样降级，不让净化失败炸掉聊天渲染。
    return { ok: false, svg: '' }
  }
  if (out.trim() === '') return { ok: false, svg: '' }
  // 净化到只剩容器（无可绘制图元）时返回 ok:false：否则调用方会渲染出一张空卡片，
  // 用户看到「什么都没有」，无法与「真的画了个空图」区分。
  if (drawable === 0) return { ok: false, svg: '' }
  return { ok: true, svg: out }
}
