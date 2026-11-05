/**
 * 分享对话的自包含 HTML 模板（跨端单源真相源）。
 *
 * ⚠️ **DOM-free 硬约束**：本模块被 web（浏览器）与 server（Node）同时 import。
 * server 端 Node 环境**没有** `window`/`document`/`DOMParser`/`XMLSerializer`，
 * 故本文件**严禁引用任何浏览器 API**。mermaid / 画布 SVG / agent HTML 产物的
 * 「净化」必须在**客户端提取阶段**完成（调用方传入已净化的 `svg` 字符串 / `content`
 * 全文），本模块只做字符串拼接与 `escapeHtml` 转义。
 *
 * ⚠️ **自包含**：输出 HTML 内联 `<style>`（具体色值，零 CSS 变量）、零外链
 * `<script src>` / `<link href>`，离线打开无站点样式也能正确渲染。
 *
 * 安全：所有用户文本均经 `escapeHtml`；HTML 产物走 `<iframe sandbox="allow-scripts">`
 * 沙箱（禁止 same-origin / top-navigation），不依赖运行时 CSP 改造。
 */

/** 转义 HTML 文本节点（`&` 必须第一个处理，否则会把已转义的 `&lt;` 再转一次）。 */
export function escapeHtml(s: string): string {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/** 仅转义属性值所需的字符（`&` 与 `"`），保留 `<`/`>` 使其在 srcdoc 内仍为标签。
 *  用于把整段（含 `<meta>` + 产物 HTML）塞进 `<iframe srcdoc="...">` 的双引号属性。 */
function escapeAttr(s: string): string {
	return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/**
 * 沙箱契约常量（规格 §4.3 定稿；与
 * `apps/web/src/components/canvas/htmlNodePreviewContract.ts` 的值保持同步）。
 * iframe srcdoc 内嵌此 CSP meta ⇒ 产物脚本可跑，但禁止同源/外链 connect。
 */
export const HTML_NODE_CSP =
	"default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'"

/** 分享消息内的结构化内容块（对话外壳的"内容节点"）。 */
export type ShareTurnPart =
	| { type: 'text'; text: string }
	/** 思考过程：原生 `<details>` 默认收起（离线零 JS 可展开）。 */
	| { type: 'thinking'; text: string; done: boolean }
	/** 工具调用：原生 `<details open>`。 */
	| { type: 'tool'; name: string; args?: unknown; result?: unknown; isError?: boolean }
	/** 图片：离线模式下 `url` 已是 `data:` URI（调用方预内联）。 */
	| { type: 'image'; url: string; caption?: string }
	/** 视频：本期无 poster，渲染占位卡（标题+时长+在线链接），不嵌 `<video>`（离线必坏）。 */
	| { type: 'video'; url: string; posterUrl?: string; title?: string; durationMs?: number }
	/** Mermaid / 画布 SVG：`svg` 须为**已净化**字符串，包进 `<details>`。 */
	| { type: 'mermaid'; svg: string; code?: string }
	| { type: 'node_graph'; svg: string; title?: string }
	/** agent HTML 产物：内联 `<iframe srcdoc sandbox>`。 */
	| { type: 'html'; content: string; title?: string }

export interface ShareTurn {
	id: string
	role: 'user' | 'assistant'
	/** 无 `parts` 时的降级文本。 */
	contentText?: string
	/** 结构化内容（优先于 contentText+attachments）。 */
	parts?: ShareTurnPart[]
	createdAt: number
	/** 旧式附件（无 parts 时降级渲染）。 */
	attachments?: Array<{ kind: 'image' | 'video' | 'file'; url: string; thumbUrl?: string }>
}

export interface ShareHtmlOptions {
	/** 'offline'：图片 url 应为已内联的 `data:` URI（调用方预抓取）；'online'（默认）：图片用外链。 */
	inlineMedia?: 'online' | 'offline'
	/** 是否注入 OG meta（托管页用）。 */
	includeOg?: boolean
	og?: { title: string; description?: string; image?: string }
	/** 分享页可见标题（如「对话·项目名称」）。缺省回退到 OG 标题 / '分享对话'。 */
	title?: string
}

const STYLE = `
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f5f6f8;color:#1f2430;}
  .wrap{max-width:680px;margin:0 auto;padding:16px;}
  .msg{display:flex;margin:12px 0;}
  .msg.user{justify-content:flex-end;}
  .bubble{max-width:82%;padding:10px 14px;border-radius:14px;line-height:1.6;font-size:15px;word-break:break-word;overflow-wrap:anywhere;box-sizing:border-box;}
  .msg.user .bubble{background:rgba(23,25,35,0.05);color:#1f2430;border:1px solid rgba(23,25,35,0.08);border-bottom-right-radius:4px;}
  .msg.assistant .bubble{background:#fff;color:#1f2430;border:1px solid #e6e8ee;border-bottom-left-radius:4px;}
  .meta{font-size:12px;color:#9aa3b2;margin-top:4px;}
  details{margin:8px 0;background:#fff;border:1px solid #e6e8ee;border-radius:10px;padding:8px 12px;}
  summary{cursor:pointer;font-weight:600;color:#4a5364;font-size:13px;}
  .img{max-width:100%;border-radius:10px;margin:6px 0;display:block;}
  .card{background:#fff;border:1px solid #e6e8ee;border-radius:10px;padding:12px;margin:6px 0;}
  .card a{color:#6d5dfc;word-break:break-all;}
  iframe{border:1px solid #e6e8ee;border-radius:10px;width:100%;min-height:340px;background:#fff;}
  .empty{padding:40px;text-align:center;color:#9aa3b2;}
  .share-header{text-align:center;padding:8px 0 16px;margin-bottom:12px;border-bottom:1px solid #e6e8ee;}
  .share-brand{display:inline-flex;align-items:center;gap:8px;justify-content:center;}
  .share-brand__name{font-size:18px;font-weight:700;letter-spacing:-.01em;color:#1f2430;}
  .share-title{margin:10px 0 0;font-size:16px;font-weight:600;color:#4a5364;}
  /* 每轮助手回复前的品牌药丸徽章（对齐产品 agent-turn-head） */
  .turn-head{display:flex;align-items:center;gap:6px;margin:14px 0 6px;}
  .turn-head__badge{width:18px;height:18px;flex:0 0 auto;display:inline-flex;}
  .turn-head__name{font-size:13px;font-weight:600;color:#4a5364;}
  /* 思考 / 调用工具：对齐产品的带图标步骤卡片（原生 details 可离线展开） */
  .step{margin:8px 0;padding:0;border-radius:10px;background:#fff;border:1px solid #e6e8ee;overflow:hidden;}
  .step > summary{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;list-style:none;}
  .step > summary::-webkit-details-marker{display:none;}
  .step__icon{flex:0 0 auto;font-size:14px;line-height:1;}
  .step__label{flex:1;font-size:13px;font-weight:500;color:#4a5364;}
  .step__chev{flex:0 0 auto;color:#9aa3b2;font-size:11px;}
  .step__body{padding:0 12px 10px;color:#5a6478;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;}
`

function fmtTime(ts: number): string {
	try {
		return new Date(ts).toLocaleString('zh-CN')
	} catch {
		return String(ts)
	}
}

function renderPart(p: ShareTurnPart): string {
	switch (p.type) {
		case 'text':
			return `<p>${escapeHtml(p.text)}</p>`
		case 'thinking':
			// 对齐产品「🧠 思考」步骤卡片：原生 <details> 默认收起（离线零 JS 可展开）
			return `<details class="step"><summary><span class="step__icon">🧠</span><span class="step__label">思考</span><span class="step__chev">▾</span></summary><div class="step__body">${escapeHtml(
				p.text,
			)}</div></details>`
		case 'tool':
			// 对齐产品「🔧 调用工具：name」步骤卡片，默认展开
			return `<details class="step" open><summary><span class="step__icon">🔧</span><span class="step__label">调用工具：${escapeHtml(
				p.name,
			)}</span><span class="step__chev">▾</span></summary><div class="step__body">${escapeHtml(
				typeof p.args === 'string' ? p.args : JSON.stringify(p.args ?? '', null, 2),
			)}</div>${
				p.result !== undefined
					? `<div class="step__body">结果：${escapeHtml(typeof p.result === 'string' ? p.result : JSON.stringify(p.result))}</div>`
					: ''
			}</details>`
		case 'image':
			return `<img class="img" src="${escapeHtml(p.url)}" alt="${escapeHtml(p.caption ?? '图片')}">`
		case 'video': {
			const dur = p.durationMs ? `<div class="meta">时长：${Math.round(p.durationMs / 1000)}s</div>` : ''
			return `<div class="card"><div>视频：${escapeHtml(p.title ?? '视频')}</div>${dur}<a href="${escapeHtml(
				p.url,
			)}">在线观看</a></div>`
		}
		case 'mermaid':
		case 'node_graph': {
			const title = p.type === 'node_graph' ? p.title ?? '画布结构' : '图表'
			// svg 为调用方已净化的信任字符串
			return `<details><summary>${escapeHtml(title)}</summary>${p.svg}</details>`
		}
		case 'html': {
			const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${HTML_NODE_CSP}">`
			const srcdoc = escapeAttr(cspMeta + p.content)
			return `<iframe sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe>`
		}
	}
}

/** 无 `parts` 时，由 contentText + attachments 推导（降级路径，旧式数据兼容）。 */
function deriveParts(turn: ShareTurn): ShareTurnPart[] {
	const parts: ShareTurnPart[] = []
	if (turn.contentText) parts.push({ type: 'text', text: turn.contentText })
	for (const a of turn.attachments ?? []) {
		if (a.kind === 'image') parts.push({ type: 'image', url: a.url, caption: a.thumbUrl })
		else if (a.kind === 'video') parts.push({ type: 'video', url: a.url })
		else parts.push({ type: 'image', url: a.url }) // file 尽力当图片链接呈现
	}
	return parts
}

/** 每轮助手回复前的品牌药丸徽章（对齐产品 agent-turn-head）。 */
function renderTurnHead(): string {
	return `<div class="turn-head">${TURN_BADGE_SVG}<span class="turn-head__name">lnk π</span></div>`
}

function renderTurn(turn: ShareTurn): string {
	const roleClass = turn.role === 'user' ? 'user' : 'assistant'
	const parts = turn.parts && turn.parts.length ? turn.parts : deriveParts(turn)
	const inner = parts.map(renderPart).join('')
	const bubble = `<div class="msg ${roleClass}"><div class="bubble">${inner}<div class="meta">${escapeHtml(
		fmtTime(turn.createdAt),
	)}</div></div></div>`
	// 产品：每条助手回复前都有品牌徽章；用户气泡不带徽章
	return turn.role === 'assistant' ? `${renderTurnHead()}${bubble}` : bubble
}

function renderOg(og?: ShareHtmlOptions['og']): string {
	if (!og) return ''
	const rows = [
		'<meta property="og:type" content="website">',
		`<meta property="og:title" content="${escapeHtml(og.title)}">`,
		`<meta property="og:description" content="${escapeHtml(og.description ?? '')}">`,
	]
	if (og.image) rows.push(`<meta property="og:image" content="${escapeHtml(og.image)}">`)
	rows.push('<meta name="twitter:card" content="summary_large_image">')
	return rows.join('\n  ')
}

/**
 * 品牌徽标：盘 + 锚（自包含内联 SVG，离线/托管均无外链依赖）。
 * 与产品本体 anchor-badge（盘+锚双色徽标）视觉一致——深墨盘 + 白色锚。
 */
const BRAND_BADGE_SVG = `<svg class="brand-badge" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
  <circle cx="12" cy="12" r="11" fill="#1f2430"/>
  <g fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="4.6" x2="12" y2="19"/>
    <line x1="5.5" y1="9" x2="18.5" y2="9"/>
    <path d="M12 19a6 6 0 0 0 6-6"/>
    <path d="M12 19a6 6 0 0 1-6-6"/>
  </g>
  <circle cx="12" cy="4.6" r="1.6" fill="#fff" stroke="none"/>
</svg>`

/** 每轮徽章用的小号品牌徽标（深墨盘 + 白色锚）。 */
const TURN_BADGE_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
  <circle cx="12" cy="12" r="11" fill="#1f2430"/>
  <g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"/>
    <line x1="6" y1="9" x2="18" y2="9"/>
    <path d="M12 19a6 6 0 0 0 6-6"/>
    <path d="M12 19a6 6 0 0 1-6-6"/>
  </g>
  <circle cx="12" cy="5" r="1.8" fill="#fff" stroke="none"/>
</svg>`

/** 分享页顶部品牌头：徽标 + 品牌名 + 可见标题（对话·项目名称）。 */
function renderHeader(title: string): string {
	return `<header class="share-header">
  <div class="share-brand">${BRAND_BADGE_SVG}<span class="share-brand__name">lnk π</span></div>
  <h1 class="share-title">${escapeHtml(title)}</h1>
</header>`
}

/**
 * 生成自包含分享 HTML 字符串（纯函数，DOM-free）。
 * @param turns 勾选的消息有序集合
 * @param opts inlineMedia: 离线用 data: URI 图片 / includeOg: 注入 OG meta / title: 可见标题
 */
export function buildShareHtml(turns: ShareTurn[], opts?: ShareHtmlOptions): string {
	const pageTitle = opts?.title ?? opts?.og?.title ?? '分享对话'
	const header = renderHeader(opts?.title ?? '分享对话')
	const body = turns.length
		? turns.map(renderTurn).join('\n')
		: '<div class="empty">暂无分享内容</div>'
	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
  ${opts?.includeOg ? renderOg(opts.og) : ''}
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${header}
${body}
</div>
</body>
</html>`
}
