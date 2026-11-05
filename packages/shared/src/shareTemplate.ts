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
	og?: { title: string; description: string; image?: string }
}

const STYLE = `
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f5f6f8;color:#1f2430;}
  .wrap{max-width:680px;margin:0 auto;padding:16px;}
  .msg{display:flex;margin:12px 0;}
  .msg.user{justify-content:flex-end;}
  .bubble{max-width:82%;padding:10px 14px;border-radius:14px;line-height:1.6;font-size:15px;word-break:break-word;overflow-wrap:anywhere;box-sizing:border-box;}
  .msg.user .bubble{background:#6d5dfc;color:#fff;border-bottom-right-radius:4px;}
  .msg.assistant .bubble{background:#fff;color:#1f2430;border:1px solid #e6e8ee;border-bottom-left-radius:4px;}
  .meta{font-size:12px;color:#9aa3b2;margin-top:4px;}
  details{margin:8px 0;background:#fff;border:1px solid #e6e8ee;border-radius:10px;padding:8px 12px;}
  summary{cursor:pointer;font-weight:600;color:#4a5364;font-size:13px;}
  .img{max-width:100%;border-radius:10px;margin:6px 0;display:block;}
  .card{background:#fff;border:1px solid #e6e8ee;border-radius:10px;padding:12px;margin:6px 0;}
  .card a{color:#6d5dfc;word-break:break-all;}
  iframe{border:1px solid #e6e8ee;border-radius:10px;width:100%;min-height:340px;background:#fff;}
  .empty{padding:40px;text-align:center;color:#9aa3b2;}
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
			// 原生 <details>，不带 open ⇒ 默认收起（离线零 JS 可展开）
			return `<details><summary>思考过程</summary><div>${escapeHtml(p.text)}</div></details>`
		case 'tool':
			// 工具调用默认展开
			return `<details open><summary>工具调用：${escapeHtml(p.name)}</summary><div>${escapeHtml(
				typeof p.args === 'string' ? p.args : JSON.stringify(p.args ?? '', null, 2),
			)}</div>${
				p.result !== undefined
					? `<div>结果：${escapeHtml(typeof p.result === 'string' ? p.result : JSON.stringify(p.result))}</div>`
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

function renderTurn(turn: ShareTurn): string {
	const roleClass = turn.role === 'user' ? 'user' : 'assistant'
	const parts = turn.parts && turn.parts.length ? turn.parts : deriveParts(turn)
	const inner = parts.map(renderPart).join('')
	return `<div class="msg ${roleClass}"><div class="bubble">${inner}<div class="meta">${escapeHtml(
		fmtTime(turn.createdAt),
	)}</div></div></div>`
}

function renderOg(og?: ShareHtmlOptions['og']): string {
	if (!og) return ''
	const rows = [
		'<meta property="og:type" content="website">',
		`<meta property="og:title" content="${escapeHtml(og.title)}">`,
		`<meta property="og:description" content="${escapeHtml(og.description)}">`,
	]
	if (og.image) rows.push(`<meta property="og:image" content="${escapeHtml(og.image)}">`)
	rows.push('<meta name="twitter:card" content="summary_large_image">')
	return rows.join('\n  ')
}

/**
 * 生成自包含分享 HTML 字符串（纯函数，DOM-free）。
 * @param turns 勾选的消息有序集合
 * @param opts inlineMedia: 离线用 data: URI 图片 / includeOg: 注入 OG meta
 */
export function buildShareHtml(turns: ShareTurn[], opts?: ShareHtmlOptions): string {
	const title = opts?.og?.title ?? '分享对话'
	const body = turns.length
		? turns.map(renderTurn).join('\n')
		: '<div class="empty">暂无分享内容</div>'
	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
  ${opts?.includeOg ? renderOg(opts.og) : ''}
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>`
}
