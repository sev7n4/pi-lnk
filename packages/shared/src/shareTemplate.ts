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
 * ⚠️ **保真契约（2026-11-06）**：产品对话页的时间线有 8 类 part，本模板逐类有对应
 * 渲染器；文本一律 `white-space:pre-wrap`（产品同款 `collapseBlankRuns`），
 * 时间统一按 UTC+8 纯字符串格式化（不依赖宿主时区，托管页/离线页/图片三端一致）。
 *
 * 安全：所有用户文本均经 `escapeHtml`；SVG 内联走 `sanitizeSvg` 白名单剥离；
 * HTML 产物走 `<iframe sandbox="allow-scripts">` 沙箱（禁止 same-origin / top-navigation）。
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

/** 仅转义属性值所需的字符（`&` 与 `"`），保留 `<`/`>` 使其在 srcdoc 内仍为标签。 */
function escapeAttr(s: string): string {
	return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/**
 * SVG 内联净化（DOM-free 纯字符串白名单剥离）。
 * 托管分享页是公开可访问的静态 HTML，而 `svg` part 由客户端上送 ⇒ 直插等于存储型 XSS。
 * 这里剥掉脚本/事件/外部实体等可执行面，其余标签原样保留（合法 mermaid SVG 不受影响）。
 */
export function sanitizeSvg(svg: string): string {
	const cleaned = String(svg ?? '')
		// 可执行/外部嵌入容器整段剥离；<style> 不剥（mermaid 导出的 SVG 靠它上色），
		// 只清掉 @import / url() / expression() 这类可外连的 CSS 能力。
		.replace(/<\s*(script|foreignObject|iframe|object|embed|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
		.replace(/<\s*(script|foreignObject|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, '')
		.replace(/<\s*style\b[^>]*>([\s\S]*?)<\/\s*style\s*>/gi, (_m, css: string) =>
			`<style>${String(css).replace(/@import|expression\s*\(|url\s*\(/gi, '')}</style>`,
		)
		.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
		.replace(/(?:href|src|xlink:href)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi, '')
		.replace(/<!\s*(?:ENTITY|DOCTYPE)\b[^>]*>/gi, '')
	if (!/^\s*<svg\b/i.test(cleaned)) return ''
	return cleaned
}

/**
 * 沙箱契约常量（规格 §4.3 定稿；与
 * `apps/web/src/components/canvas/htmlNodePreviewContract.ts` 的值保持同步）。
 */
export const HTML_NODE_CSP =
	"default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'"

/** 分享消息内的结构化内容块（1:1 对齐产品 turnTimeline 的 part 类别）。 */
export type ShareTurnPart =
	| { type: 'text'; text: string }
	/** 思考过程：原生 `<details>`，done 收起 / running 展开（产品同款默认态）。 */
	| { type: 'thinking'; text: string; done: boolean }
	/** 工具调用：`status` / `ms` 用于 ✓✗⏹ 与耗时标记；`result` 为产品同款摘要。
	 *  `interrupted`（D1 2026-11-11）= 上游流耗尽且无权威收束，与产品
	 *  `TimelinePart.tool.status` 同字面量：既不是成功也不是失败，且无「完成耗时」。 */
	| {
			type: 'tool'
			name: string
			args?: unknown
			result?: unknown
			isError?: boolean
			status?: 'running' | 'done' | 'failed' | 'interrupted'
			ms?: number
	  }
	/** 图片：`url` 为 `data:` URI（离线）或外链（托管）；`fallbackUrl` 用于占位卡的在线查看链接。 */
	| { type: 'image'; url: string; caption?: string; fallbackUrl?: string }
	/** 视频：不嵌 `<video>`（离线必坏），渲染带在线链接的卡片。 */
	| { type: 'video'; url: string; posterUrl?: string; title?: string; durationMs?: number }
	/** 音频 / 通用文件：产品里有独立 tile，分享页保留标题与在线入口，不伪装成破图。 */
	| { type: 'audio'; url: string; title?: string; durationMs?: number }
	| { type: 'file'; url: string; title?: string; kind?: string }
	/** 系统提示：tone 决定配色，error/warn 不再被压成普通正文。 */
	| { type: 'notice'; text: string; tone?: 'info' | 'warn' | 'error'; detail?: string }
	/** 画布操作行。 */
	| { type: 'canvas'; label: string; nodeId?: string }
	/** 非图/视频产物（text / html / mermaid 节点等）：保住标题、状态、失败原因。 */
	| {
			type: 'artifact'
			nodeType: string
			title: string
			status?: 'pending' | 'running' | 'done' | 'failed'
			url?: string
			errorText?: string
	  }
	/** 生成确认卡（propose_generation）：静态快照，不含可点按钮。 */
	| {
			type: 'proposal'
			title: string
			status: 'pending_confirm' | 'confirmed' | 'declined' | 'expired'
			detail?: string
	  }
	/** askuser 多题卡：题目 + 选项 + 状态，静态只读。 */
	| {
			type: 'question'
			title: string
			status: 'pending_answer' | 'answered' | 'declined'
			questions: Array<{
				question: string
				options: string[]
				multiSelect?: boolean
				allowOther?: boolean
			}>
	  }
	/** Mermaid / 画布 SVG：`svg` 须为**已净化**字符串（本模块再兜一层），包进 `<details>`。 */
	| { type: 'mermaid'; svg: string; code?: string }
	| { type: 'node_graph'; svg: string; title?: string }
	/** agent HTML 产物：内联 `<iframe srcdoc sandbox>`。 */
	| { type: 'html'; content: string; title?: string }

export interface ShareDeliveryItem {
	title: string
	nodeType: string
	url?: string
}

export interface ShareTurn {
	id: string
	role: 'user' | 'assistant'
	/** 无 `parts` 时的降级文本。 */
	contentText?: string
	/** 结构化内容（优先于 contentText）。 */
	parts?: ShareTurnPart[]
	createdAt: number
	/** 用户上传的附件：与 parts **合并**渲染（不是二选一，修「附件全丢」）。 */
	attachments?: Array<{ kind: 'image' | 'video' | 'file'; url: string; thumbUrl?: string }>
	/** 回合末交付摘要（E2-a 同源派生），助手回合渲染产物 tile 条。 */
	delivery?: ShareDeliveryItem[]
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
  .wrap{max-width:680px;margin:0 auto;padding:16px 16px 40px;}
  .msg{display:flex;margin:12px 0;}
  .msg.user{justify-content:flex-end;}
  .bubble{padding:10px 14px;border-radius:14px;line-height:1.65;font-size:15px;word-break:break-word;overflow-wrap:anywhere;box-sizing:border-box;}
  .msg.user .bubble{max-width:82%;background:rgba(23,25,35,0.05);color:#1f2430;border:1px solid rgba(23,25,35,0.08);border-bottom-right-radius:4px;}
  .msg.assistant .bubble{width:100%;background:transparent;border:none;padding:2px 0 0;color:#1f2430;}
  /* 产品正文用 whitespace-pre-wrap：没有它，所有换行/段落会被 HTML 折叠成一坨 */
  .text{white-space:pre-wrap;margin:6px 0;line-height:1.7;}
  .meta{font-size:11px;color:#9aa3b2;margin-top:6px;}
  .msg.user .meta{text-align:right;}
  .msg.assistant .meta{text-align:left;}
  details{margin:8px 0;background:#fff;border:1px solid #e6e8ee;border-radius:10px;padding:8px 12px;}
  summary{cursor:pointer;font-weight:600;color:#4a5364;font-size:13px;}
  .img{max-width:100%;border-radius:10px;margin:8px 0;display:block;background:#eceef3;}
  .card{background:#fff;border:1px solid #e6e8ee;border-radius:10px;padding:12px;margin:8px 0;}
  .card a{color:#5b4bd6;word-break:break-all;}
  iframe{border:1px solid #e6e8ee;border-radius:10px;width:100%;min-height:340px;background:#fff;}
  .empty{padding:40px;text-align:center;color:#9aa3b2;}
  .share-header{text-align:center;padding:8px 0 16px;margin-bottom:12px;border-bottom:1px solid #e6e8ee;}
  .share-brand{display:inline-flex;align-items:center;gap:8px;justify-content:center;}
  .share-brand__name{font-size:18px;font-weight:700;letter-spacing:-.01em;color:#1f2430;}
  .share-title{margin:10px 0 0;font-size:16px;font-weight:600;color:#4a5364;}
  .turn-head{display:flex;align-items:center;gap:6px;margin:16px 0 6px;}
  .turn-head__badge{width:18px;height:18px;flex:0 0 auto;display:inline-flex;}
  .turn-head__name{font-size:13px;font-weight:600;color:#4a5364;}
  .step{margin:8px 0;padding:0;border-radius:10px;background:#fff;border:1px solid #e6e8ee;overflow:hidden;}
  .step > summary{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;list-style:none;}
  .step > summary::-webkit-details-marker{display:none;}
  .step__icon{flex:0 0 auto;display:inline-flex;width:16px;height:16px;color:#6b7488;}
  .step__icon svg{width:16px;height:16px;}
  .step__label{flex:1;font-size:13px;font-weight:500;color:#4a5364;}
  .step__state{flex:0 0 auto;font-size:11px;color:#9aa3b2;}
  .step__chev{flex:0 0 auto;color:#9aa3b2;font-size:11px;}
  .step__body{padding:0 12px 10px;color:#5a6478;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;}
  .notice{display:flex;gap:8px;align-items:flex-start;padding:9px 12px;margin:8px 0;border-radius:10px;font-size:13px;line-height:1.6;white-space:pre-wrap;background:#eef2fb;color:#40506e;border:1px solid #dae3f5;}
  .notice--warn{background:#fff7e8;color:#775318;border-color:#f4e2bd;}
  .notice--error{background:#fdeeee;color:#8b3434;border-color:#f5cfcf;}
  .notice__label{flex:0 0 auto;font-weight:600;}
  .media{display:flex;align-items:center;gap:10px;margin:8px 0;padding:10px 12px;background:#fff;border:1px solid #e6e8ee;border-radius:10px;}
  .media__icon{flex:0 0 auto;display:inline-flex;width:20px;height:20px;color:#6b7488;}
  .media__icon svg{width:20px;height:20px;}
  .media__body{flex:1;min-width:0;}
  .media__title{font-size:13px;font-weight:600;color:#4a5364;word-break:break-word;}
  .media__sub{font-size:11px;color:#9aa3b2;margin-top:2px;}
  .media a{color:#5b4bd6;font-size:12px;word-break:break-all;}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:#eef2fb;color:#40506e;}
  .badge--ok{background:#e8f6ee;color:#2b7049;}
  .badge--warn{background:#fff7e8;color:#775318;}
  .badge--error{background:#fdeeee;color:#8b3434;}
  .qa{margin:8px 0;padding:12px;background:#fff;border:1px solid #e6e8ee;border-radius:10px;}
  .qa__title{font-size:14px;font-weight:600;color:#4a5364;margin-bottom:8px;}
  .qa__q{margin:10px 0 4px;font-size:13px;color:#1f2430;white-space:pre-wrap;}
  .qa__opts{margin:0;padding-left:18px;font-size:13px;color:#5a6478;line-height:1.8;}
  .delivery{margin:14px 0 4px;padding-top:10px;border-top:1px dashed #dfe3ec;}
  .delivery__label{font-size:12px;color:#9aa3b2;margin-bottom:8px;}
  .delivery__strip{display:flex;flex-wrap:wrap;gap:6px;}
  .delivery__tile{padding:5px 10px;border-radius:8px;background:#fff;border:1px solid #e6e8ee;font-size:12px;color:#4a5364;}
  .share-footer{margin-top:28px;padding-top:12px;border-top:1px solid #e6e8ee;text-align:center;font-size:11px;color:#9aa3b2;line-height:1.8;}
  @media (prefers-color-scheme: dark){
    body{background:#15171d;color:#e7e9ef;}
    .msg.user .bubble{background:#242832;color:#e7e9ef;border-color:#33394a;}
    .msg.assistant .bubble{color:#e7e9ef;}
    .share-brand__name{color:#e7e9ef;}
    .share-title,.turn-head__name,.step__label,.media__title,.qa__title,.delivery__tile{color:#c8cddb;}
    .share-header,.share-footer,.delivery{border-color:#303644;}
    .card,.step,.media,.qa,details,.delivery__tile{background:#1e222b;border-color:#303644;}
    .text,.qa__q{color:#e7e9ef;}
    .step__body,.qa__opts{color:#a9b1c3;}
    .card a,.media a{color:#a99bff;}
    .notice{background:#212a3b;color:#c3d2ef;border-color:#33415c;}
    .notice--warn{background:#332b1c;color:#e5cd94;border-color:#4b3d22;}
    .notice--error{background:#372224;color:#e9b1b1;border-color:#523033;}
    .img,iframe{background:#1e222b;}
    /* 墨盘徽标在深色底上会融进背景 ⇒ 提亮盘面，保留白色锚的对比 */
    .brand-badge > circle:first-child,.turn-head svg > circle:first-child{fill:#3b4457;}
  }
`

/** 产品同款：3+ 连续换行折叠为单个空行，保留段落语义。 */
function collapseBlankRuns(text: string): string {
	return String(text ?? '').replace(/\n{3,}/g, '\n\n')
}

/**
 * 时间统一按北京时间 (UTC+8) 格式化，纯字符串运算、不读宿主时区。
 * 托管页由 Node 落盘（容器是 UTC），离线页/图片在用户浏览器渲染 —— 用
 * `toLocaleString` 会让同一个分享链接在两个端显示相差 8 小时的两个时间。
 */
export function fmtShareTime(ts: number): string {
	const d = new Date(Number(ts) + 8 * 60 * 60 * 1000)
	if (Number.isNaN(d.getTime())) return ''
	const p = (n: number) => String(n).padStart(2, '0')
	// 与产品 `toLocaleString('zh-CN')` 形态一致：月/日不补零，时分秒补零
	return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

const ICON = {
	think: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5.9 1.1 1 1.7h5.2c.1-.6.4-1.2 1-1.7A6 6 0 0 0 12 3z"/></svg>',
	tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.6 2.6-2.4-2.4 2-2.2z"/></svg>',
	image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M4 17l5-5 4 4 3-3 4 4"/></svg>',
	video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="M17 10l4-3v10l-4-3"/></svg>',
	audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
	file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
	canvas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
	question: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.5v.3"/><path d="M12 17h.01"/></svg>',
}

const STATUS_LABEL: Record<string, string> = {
	pending_confirm: '等待确认',
	confirmed: '已确认',
	declined: '已拒绝',
	expired: '已过期',
	pending_answer: '等待回答',
	answered: '已回答',
	pending: '排队中',
	running: '进行中',
	done: '已完成',
	failed: '失败',
	/** D1：分享页状态徽标不把「没收到结果」误标成完成/失败。 */
	interrupted: '未收到结果',
}

function statusBadge(status: string): string {
	const cls = status === 'failed' || status === 'declined' ? 'error' : status === 'confirmed' || status === 'done' || status === 'answered' ? 'ok' : 'warn'
	return `<span class="badge badge--${cls}">${escapeHtml(STATUS_LABEL[status] ?? status)}</span>`
}

function externalLink(url: string, label = '在线查看'): string {
	if (!/^https?:\/\//i.test(url)) return ''
	return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
}

function mediaCard(icon: string, title: string, sub: string, url?: string, linkLabel = '在线查看'): string {
	return `<div class="media"><span class="media__icon">${icon}</span><div class="media__body"><div class="media__title">${escapeHtml(title)}</div>${sub ? `<div class="media__sub">${escapeHtml(sub)}</div>` : ''}${url ? externalLink(url, linkLabel) : ''}</div></div>`
}

function renderPart(p: ShareTurnPart, offline: boolean): string {
	switch (p.type) {
		case 'text':
			return `<p class="text">${escapeHtml(collapseBlankRuns(p.text))}</p>`
		case 'thinking':
			return `<details class="step"${p.done ? '' : ' open'}><summary><span class="step__icon">${ICON.think}</span><span class="step__label">${p.done ? '思考' : '思考中'}</span><span class="step__chev">▾</span></summary><div class="step__body">${escapeHtml(collapseBlankRuns(p.text))}</div></details>`
		case 'tool': {
			// D1：interrupted 不能落进空 state（等于什么都没说），更不能复用 ✓/✗；
			// 也不显示 ms —— 中断没有「完成耗时」，否则复刻「✓ 用时 0ms」二次说谎。
			const interrupted = p.status === 'interrupted'
			const state = interrupted
				? '⏹ 未收到结果'
				: p.isError || p.status === 'failed' ? '✗ 失败' : p.status === 'running' ? '进行中' : p.status === 'done' ? '✓ 完成' : ''
			const ms = !interrupted && typeof p.ms === 'number' ? `${Math.round(p.ms)}ms` : ''
			const body = p.result !== undefined
				? `<div class="step__body">${escapeHtml(typeof p.result === 'string' ? p.result : JSON.stringify(p.result))}</div>`
				: ''
			return `<details class="step" open><summary><span class="step__icon">${ICON.tool}</span><span class="step__label">${escapeHtml(p.name)}</span><span class="step__state">${escapeHtml([state, ms].filter(Boolean).join(' · '))}</span><span class="step__chev">▾</span></summary>${body}</details>`
		}
		case 'image': {
			// 离线/截图模式下外链图无法内联（CDN 无 CORS）⇒ 渲染占位卡，避免破图与 canvas 污染
			if (offline && !p.url.startsWith('data:')) {
				return mediaCard(ICON.image, p.caption ?? '图片', '图片需在在线分享页查看', p.fallbackUrl ?? p.url)
			}
			return `<img class="img" loading="lazy" src="${escapeHtml(p.url)}" alt="${escapeHtml(p.caption ?? '图片')}">`
		}
		case 'video':
			return mediaCard(ICON.video, p.title ?? '视频', p.durationMs ? `时长 ${Math.round(p.durationMs / 1000)}s` : '视频产物', p.url, '在线观看')
		case 'audio':
			return mediaCard(ICON.audio, p.title ?? '音频', p.durationMs ? `时长 ${Math.round(p.durationMs / 1000)}s` : '音频产物', p.url)
		case 'file':
			return mediaCard(ICON.file, p.title ?? '文件', p.kind ?? '附件', p.url)
		case 'notice': {
			const cls = p.tone === 'error' ? 'notice--error' : p.tone === 'warn' ? 'notice--warn' : ''
			const label = p.tone === 'error' ? '错误' : p.tone === 'warn' ? '提示' : '说明'
			return `<div class="notice ${cls}"><span class="notice__label">${label}</span><span>${escapeHtml(collapseBlankRuns(p.text))}</span></div>`
		}
		case 'canvas':
			return mediaCard(ICON.canvas, p.label, '画布操作', undefined)
		case 'artifact': {
			const sub = [p.nodeType, p.status ? (STATUS_LABEL[p.status] ?? p.status) : '', p.errorText].filter(Boolean).join(' · ')
			return `<div class="card">${statusBadge(p.status ?? 'done')} <strong>${escapeHtml(p.title)}</strong><div class="meta">${escapeHtml(sub)}</div>${p.url ? externalLink(p.url) : ''}</div>`
		}
		case 'proposal':
			return `<div class="card">${statusBadge(p.status)} <strong>${escapeHtml(p.title)}</strong>${p.detail ? `<div class="meta">${escapeHtml(p.detail)}</div>` : ''}</div>`
		case 'question': {
			const qs = p.questions
				.map((q) => {
					const opts = q.options.length
						? `<ul class="qa__opts">${q.options.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}${q.allowOther ? '<li>其他</li>' : ''}</ul>`
						: ''
					return `<div class="qa__q">${escapeHtml(collapseBlankRuns(q.question))}${q.multiSelect ? '（多选）' : ''}</div>${opts}`
				})
				.join('')
			return `<div class="qa"><div class="qa__title">${escapeHtml(p.title)} ${statusBadge(p.status)}</div>${qs}</div>`
		}
		case 'mermaid':
		case 'node_graph': {
			const title = p.type === 'node_graph' ? p.title ?? '画布结构' : '图表'
			return `<details><summary>${escapeHtml(title)}</summary>${sanitizeSvg(p.svg)}</details>`
		}
		case 'html': {
			const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${HTML_NODE_CSP}">`
			const srcdoc = escapeAttr(cspMeta + p.content)
			return `<iframe sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe>`
		}
		default:
			return ''
	}
}

/** 无 `parts` 时，由 contentText 推导文本 part（附件另行合并，不再在这里吞掉）。 */
function deriveTextParts(turn: ShareTurn): ShareTurnPart[] {
	return turn.contentText ? [{ type: 'text', text: turn.contentText }] : []
}

/** 附件 → part（与 parts 合并，修「用户上传的图永远不渲染」）。 */
function attachmentParts(turn: ShareTurn): ShareTurnPart[] {
	return (turn.attachments ?? []).map((a) => {
		if (a.kind === 'video') return { type: 'video', url: a.url } as ShareTurnPart
		if (a.kind === 'file') return { type: 'file', url: a.url, title: '附件' } as ShareTurnPart
		return {
			type: 'image',
			url: a.url,
			caption: a.url ? a.thumbUrl : '图片',
			// 预内联失败时 url 被清空、thumbUrl 仍留原地址 ⇒ 占位卡给出在线查看入口
			fallbackUrl: a.thumbUrl,
		} as ShareTurnPart
	})
}

/** 每轮助手回复前的品牌药丸徽章（对齐产品 agent-turn-head）。 */
function renderTurnHead(): string {
	return `<div class="turn-head">${TURN_BADGE_SVG}<span class="turn-head__name">lnk π</span></div>`
}

function renderDelivery(items: ShareDeliveryItem[]): string {
	if (!items.length) return ''
	const tiles = items
		.map((it) => `<span class="delivery__tile">${escapeHtml(it.title || it.nodeType || '产物')}</span>`)
		.join('')
	return `<div class="delivery"><div class="delivery__label">本轮产物 · ${items.length}</div><div class="delivery__strip">${tiles}</div></div>`
}

function renderTurn(turn: ShareTurn, offline: boolean): string {
	const roleClass = turn.role === 'user' ? 'user' : 'assistant'
	const parts = [
		...(turn.parts?.length ? turn.parts : deriveTextParts(turn)),
		...attachmentParts(turn),
	]
	const inner = parts.map((p) => renderPart(p, offline)).join('')
	const time = fmtShareTime(turn.createdAt)
	const meta = time ? `<div class="meta">${escapeHtml(time)}</div>` : ''
	const bubble = `<div class="msg ${roleClass}"><div class="bubble">${inner}${meta}</div></div>`
	const delivery = turn.role === 'assistant' ? renderDelivery(turn.delivery ?? []) : ''
	return turn.role === 'assistant' ? `${renderTurnHead()}${bubble}${delivery}` : bubble
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

/** 品牌徽标：盘 + 锚（自包含内联 SVG，离线/托管均无外链依赖）。 */
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
	const offline = opts?.inlineMedia === 'offline'
	const header = renderHeader(opts?.title ?? '分享对话')
	const body = turns.length
		? turns.map((t) => renderTurn(t, offline)).join('\n')
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
<footer class="share-footer">由 lnk π 生成的对话快照 · 时间按北京时间 (UTC+8)<br>交互操作与画布编辑不在快照内</footer>
</div>
</body>
</html>`
}
