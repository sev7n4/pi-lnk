/**
 * Canvas Digest（画布总览产物）服务 —— spec 2026-11-05-canvas-digest-design。
 *
 * Task 1：`renderDigestHtml` 纯渲染函数（零 LLM，同画布态 ⇒ 同 HTML）。
 *   - D3 封顶 100；D4 内容边界（只取画布态字段，不读正文）；
 *   - D7 全量转义（title 是自由文本，文本位/属性位均经 escapeHtml）；
 *   - D8 媒体 URL 绝对化（srcdoc opaque origin 下相对路径必裂）；
 *   - D9 有正据才收（媒体 = url 存在；文本 = title 存在）。
 * Task 2：maybeRender 编排（触发判定 / 快照采集 / upsert / SSE 复用）。
 */

export interface DigestNodeSnapshot {
  id: string
  nodeType: 'image' | 'video' | 'audio' | 'text'
  title?: string
  url?: string
  durationSec?: number
  /** 透传字段：text 节点正文仅用于 D4 边界测试断言不被渲染。 */
  content?: string
  /** P2：生命周期状态（只用于 Footer 未收录分类，不进收录分区/不读正文）。 */
  status?: string
}

export interface DigestSnapshot {
  nodes: DigestNodeSnapshot[]
  digestVersion: number
  updatedAt: Date
}

/** D3：单份总览收录节点上限，防 HTML 体积失控。 */
const DIGEST_NODE_CAP = 100

/** D7：HTML 全上下文转义（文本位与属性位共用）。 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** D8：相对 url 拼 publicBaseUrl 绝对化；已是绝对地址（http(s)/data:/blob:）透传。 */
export function absoluteUrl(url: string, publicBaseUrl?: string): string {
  if (/^(https?:\/\/|data:|blob:)/i.test(url)) return url
  if (!publicBaseUrl) return url
  const base = publicBaseUrl.replace(/\/+$/, '')
  return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`
}

/** durationSec ⇒ m:ss（不足 1h）/ h:mm:ss。 */
export function formatDuration(durationSec: number): string {
  const s = Math.max(0, Math.floor(durationSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Header 更新时间：服务端统一 Asia/Shanghai（用户时区），格式 HH:mm。 */
export function formatUpdatedAt(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

const FALLBACK_TITLE: Record<DigestNodeSnapshot['nodeType'], string> = {
  image: '未命名图片',
  video: '未命名视频',
  audio: '未命名音频',
  text: '未命名文档',
}

const SECTION_LABEL: Record<DigestNodeSnapshot['nodeType'], string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
}

const SECTION_ORDER: DigestNodeSnapshot['nodeType'][] = ['image', 'video', 'audio', 'text']

/**
 * D9 有正据判据：媒体 = url 存在；文本 = title 或 content 任一存在。
 * （Ruling：D9 原文「文本 = title 存在」与 D4「未命名文档」兜底互斥成死判据，
 *  收窄为 title/content 任一即可让兜底可达、防空节点本意不变。）
 */
function hasEvidence(node: DigestNodeSnapshot): boolean {
  if (node.nodeType === 'text') {
    return Boolean(String(node.title ?? '').trim() || String(node.content ?? '').trim())
  }
  return Boolean(String(node.url ?? '').trim())
}

export function renderDigestHtml(
  snapshot: DigestSnapshot,
  opts: { publicBaseUrl?: string },
): string | null {
  const collected = snapshot.nodes.filter(hasEvidence)
  if (collected.length === 0) return null

  const capped = collected.slice(0, DIGEST_NODE_CAP)
  const overflowCount = collected.length - capped.length

  // D9 未收录计数：有正据节点数之外的画布节点。
  // P2（2026-11-07 生产实证）：旧实现把全部未收录项一律写「生成中」，但该会话
  // 4 项其实是 4 张 failed 图片，另有 1 个 draft 空文本节点 ⇒ 用户误以为还在跑。
  // 现按生命周期状态分桶；未知/缺省状态保守沿用旧文案「生成中」（历史快照零变化）。
  const excluded = snapshot.nodes.filter((n) => !hasEvidence(n))
  const pendingBuckets: Record<'generating' | 'failed' | 'draft', number> = {
    generating: 0,
    failed: 0,
    draft: 0,
  }
  for (const node of excluded) {
    const status = String(node.status ?? '').trim()
    if (status === 'failed' || status === 'error') pendingBuckets.failed += 1
    else if (status === 'draft' || status === 'pending_confirm') pendingBuckets.draft += 1
    else pendingBuckets.generating += 1
  }
  const pendingLabels = [
    pendingBuckets.generating > 0 ? `${pendingBuckets.generating} 项生成中未收录` : null,
    pendingBuckets.failed > 0 ? `${pendingBuckets.failed} 项生成失败未收录` : null,
    pendingBuckets.draft > 0 ? `${pendingBuckets.draft} 项待完成未收录` : null,
  ].filter((b): b is string => b !== null)

  const base = opts.publicBaseUrl

  // Stats：只列收录数 > 0 的类型，保持索引心智。
  const stats = SECTION_ORDER.map((t) => {
    const n = capped.filter((n) => n.nodeType === t).length
    return n > 0 ? `${n} ${SECTION_LABEL[t]}` : null
  })
    .filter(Boolean)
    .join(' · ')

  const tiles = (type: DigestNodeSnapshot['nodeType']) =>
    capped
      .filter((n) => n.nodeType === type)
      .map((n) => renderTile(n, base))
      .join('\n')

  const mediaSections = (['image', 'video', 'audio'] as const)
    .map((t) => {
      const inner = tiles(t)
      return inner
        ? `<section class="sec" data-section="${t}"><h2 class="sec-title">${SECTION_LABEL[t]}</h2><div class="grid">${inner}</div></section>`
        : ''
    })
    .join('\n')

  const textRows = capped
    .filter((n) => n.nodeType === 'text')
    .map(
      (n) =>
        `<div class="row" data-node-id="${escapeHtml(n.id)}"><span class="row-icon" aria-hidden="true">${DOC_ICON}</span><span class="row-title">${escapeHtml(n.title?.trim() || FALLBACK_TITLE.text)}</span></div>`,
    )
    .join('\n')

  const textSection = textRows
    ? `<section class="sec" data-section="text"><h2 class="sec-title">文本</h2><div class="rows">${textRows}</div></section>`
    : ''

  const footerBits = [
    ...pendingLabels,
    overflowCount > 0 ? `其余 ${overflowCount} 项未收录` : null,
    // P2 命名区分（2026-11-07 截图研判）：用户自建「画布内容总结」与系统总览名称近似，
    // 容易被混为一谈；Footer 明确「系统自动生成 + 当前画布快照（非用户产物）」。
    '系统自动生成 · 当前画布快照',
  ].filter((b): b is string => b !== null)

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>画布总览</title>
<style>
  :root {
    --bg: #101418; --panel: #181d24; --panel-2: #1f262f;
    --text: #e8ecf1; --text-2: #9aa4af; --line: #2a323d;
    --accent: #4da3ff; --thumb-bg: #14181e;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f5f6f8; --panel: #ffffff; --panel-2: #eef1f4;
      --text: #1a2028; --text-2: #5c6670; --line: #e1e5ea;
      --accent: #1f6fd0; --thumb-bg: #e8ebef;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    font-size: 14px; line-height: 1.5; padding: 16px 16px 24px;
  }
  .header { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .header h1 { font-size: 17px; font-weight: 600; }
  .header .ver { font-size: 11px; color: var(--text-2); }
  .header .time { font-size: 11px; color: var(--text-2); margin-left: auto; }
  .stats { font-size: 12px; color: var(--text-2); margin-top: 4px; }
  .sec { margin-top: 16px; }
  .sec-title { font-size: 12px; font-weight: 600; color: var(--text-2); margin-bottom: 8px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .tile {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    overflow: hidden;
  }
  .thumb { position: relative; aspect-ratio: 16 / 10; background: var(--thumb-bg); }
  .thumb img, .thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb .icon-fallback {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: var(--text-2);
  }
  .dur {
    position: absolute; right: 4px; bottom: 4px;
    background: rgba(0, 0, 0, 0.65); color: #fff;
    font-size: 11px; line-height: 1; padding: 3px 5px; border-radius: 4px;
  }
  .tile-title {
    font-size: 12px; padding: 6px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .rows { display: flex; flex-direction: column; }
  .row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; margin-bottom: 8px;
  }
  .row-icon { color: var(--text-2); display: flex; }
  .row-title { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .footer {
    margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line);
    font-size: 11px; color: var(--text-2); display: flex; gap: 8px; flex-wrap: wrap;
  }
</style>
</head>
<body>
<header class="header">
  <h1>画布总览</h1>
  <span class="ver">第 ${escapeHtml(String(snapshot.digestVersion))} 版</span>
  <span class="time">更新 ${formatUpdatedAt(snapshot.updatedAt)}</span>
</header>
<div class="stats">${stats}</div>
${mediaSections}
${textSection}
<footer class="footer">${footerBits.map(escapeHtml).join('<span aria-hidden="true">·</span>')}</footer>
${DG_FAIL_SCRIPT}
</body>
</html>`
}

const DOC_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>'

const IMAGE_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>'

const VIDEO_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>'

/**
 * Task 6：媒体加载失败内联降级（spec §10 风险——裂图/黑框）。
 * CSP script-src 'unsafe-inline' 已放行内联 handler（基线与 trusted 级均保留该段）；
 * dgFail 查表取图标、替换整个 thumb 元素——图标常量在 JS 字符串里，无 HTML 属性引号嵌套。
 */
const DG_FAIL_SCRIPT = `<script>
var DG_ICONS = { image: ${JSON.stringify(IMAGE_ICON)}, video: ${JSON.stringify(VIDEO_ICON)} };
function dgFail(el, kind) {
  if (!el || el.dataset.dgFailed) return;
  el.dataset.dgFailed = '1';
  el.outerHTML = '<span class="icon-fallback" aria-hidden="true">' + (DG_ICONS[kind] || '') + '</span>';
}
</script>`

/** 媒体 tile：image 用 img；video 用 video 首帧（preload=metadata + #t=0.1）；audio 用图标占位。 */
function renderTile(node: DigestNodeSnapshot, base?: string): string {
  const id = escapeHtml(node.id)
  const title = escapeHtml(node.title?.trim() || FALLBACK_TITLE[node.nodeType])
  const titleBar = `<div class="tile-title">${title}</div>`
  const durBadge =
    typeof node.durationSec === 'number'
      ? `<span class="dur">${formatDuration(node.durationSec)}</span>`
      : ''

  let thumb: string
  if (node.nodeType === 'image') {
    thumb = `<img src="${escapeHtml(absoluteUrl(String(node.url ?? ''), base))}" loading="lazy" alt="" onerror="dgFail(this,'image')">`
  } else if (node.nodeType === 'video') {
    thumb = `<video src="${escapeHtml(`${absoluteUrl(String(node.url ?? ''), base)}#t=0.1`)}" preload="metadata" muted playsinline tabindex="-1" onerror="dgFail(this,'video')"></video>`
  } else {
    thumb = `<span class="icon-fallback" aria-hidden="true">${DOC_ICON}</span>`
  }

  return `<div class="tile" data-node-id="${id}"><div class="thumb">${thumb}${durBadge}</div>${titleBar}</div>`
}

// ── Task 2：触发判定 / 快照采集 / upsert 编排（spec D1/D2/D6/S6/S7）──────────

import { Logger } from '@nestjs/common'
import type { CanvasAction } from '@lnkpi/shared'

/** 画布节点最小切片（canvasData JSON 内的真实形态）。 */
export interface DigestRawNode {
  id: string
  type?: string
  position?: { x: number; y: number }
  data?: Record<string, unknown>
}

export interface DigestRawCanvas {
  nodes: DigestRawNode[]
  edges?: unknown[]
}

const DIGEST_NODE_TYPES = new Set(['image', 'video', 'audio', 'text'])

/**
 * 画布态 → 渲染快照：空间序（y→x 扫描序，§6.0「总览 = 画布的空间投影」）。
 * 排除：digest 节点自身（防自吞——总览不该收录总览）与已下线类型（NodeType 收敛纪律）。
 */
export function collectDigestSnapshot(canvas: DigestRawCanvas): DigestSnapshot {
  const nodes = [...canvas.nodes]
    .filter((n) => n.data?.digest !== true && DIGEST_NODE_TYPES.has(String(n.type ?? '')))
    .sort((a, b) => {
      const ay = a.position?.y ?? 0
      const by = b.position?.y ?? 0
      return ay !== by ? ay - by : (a.position?.x ?? 0) - (b.position?.x ?? 0)
    })
    .map((n) => {
      const data = n.data ?? {}
      const nodeType = String(n.type ?? '') as DigestNodeSnapshot['nodeType']
      const mediaInfo = data.mediaInfo as { output?: { durationSec?: number } } | undefined
      return {
        id: n.id,
        nodeType,
        title: typeof data.title === 'string' ? data.title : undefined,
        url: typeof data.url === 'string' ? data.url : undefined,
        durationSec:
          nodeType === 'video' || nodeType === 'audio'
            ? typeof mediaInfo?.output?.durationSec === 'number'
              ? mediaInfo.output.durationSec
              : undefined
            : undefined,
        content: nodeType === 'text' && typeof data.content === 'string' ? data.content : undefined,
        status: typeof data.status === 'string' ? data.status : undefined,
      }
    })
  return { nodes, digestVersion: 0, updatedAt: new Date() }
}

/**
 * §9.1 P3 可观测（2026-11-07）：识别「回合外画布态变更导致的总览陈旧」。
 *
 * 纯函数、零写入、零用户可见变更。三条同时成立才算 stale：
 *   ① 节点当前有正据（D9：媒体 url / 文本 title|content），且在 D3 前 100 收录上限内；
 *   ② 该节点不在上一版 digest HTML 的 `data-node-id` 集合中（renderTile 已转义，故对比时同样转义）；
 *   ③ 本轮 canvasActions 没有触碰该节点 —— 本轮新建/更新属正常翻新，不是陈旧。
 * 首次渲染无上一版 HTML ⇒ 无可对比基线，返回空。
 *
 * 用途：把「是否该实施事件驱动去抖」从主观判断变成可量化证据——生产出现
 * `digest_stale` warn 且确认由 url 回填引起，即满足 §9.1 准入判据。
 * 本函数**不改变触发架构**：maybeRender 仍只在 finalizeTurn 被调用。
 */
export function findDigestStaleIds(input: {
  canvas: DigestRawCanvas
  canvasActions: readonly CanvasAction[]
}): string[] {
  const digestNode = input.canvas.nodes.find((n) => n.data?.digest === true)
  const previousHtml = typeof digestNode?.data?.content === 'string' ? digestNode.data.content : ''
  if (!previousHtml) return []

  // 上一版收录集合：直接反查渲染器写进 tile 的 data-node-id，零新增持久化字段。
  const previouslyIncluded = new Set<string>()
  for (const match of previousHtml.matchAll(/data-node-id="([^"]+)"/g)) {
    if (match[1]) previouslyIncluded.add(match[1])
  }

  const touched = new Set<string>()
  for (const action of input.canvasActions) {
    const payload = action.payload as unknown as { id?: unknown } | undefined
    if (typeof payload?.id === 'string' && payload.id) touched.add(payload.id)
  }

  const collected = collectDigestSnapshot(input.canvas)
    .nodes.filter(hasEvidence)
    .slice(0, DIGEST_NODE_CAP)

  return collected
    .filter((n) => !previouslyIncluded.has(escapeHtml(n.id)) && !touched.has(n.id))
    .map((n) => n.id)
    .sort()
}

/**
 * P1b：下一版版本号（双源自愈）。
 *
 * 2026-11-07 生产事故：客户端回拉/PATCH 循环把陈旧的 `digestVersion` 回灌，
 * 元数据卡在 4、HTML Header 已是「第 5 版」⇒ 旧判据「meta+1」使 Header 永远
 * 停在第 5 版。根因已由「系统专属字段禁写」收口，这里对**存量脏状态**做收敛：
 * 同时读节点元数据与上一版 HTML Header，取较大者 +1，保证版本号继续单调前进，
 * 并在下一轮把元数据写回与 Header 一致。HTML Header 是本渲染器生成的确定形态，
 * 仅认 `<span class="ver">第 N 版</span>`，不按正文里的「第 N 版」字样猜测。
 */
export function resolveNextDigestVersion(canvas: DigestRawCanvas): number {
  const node = canvas.nodes.find((n) => n.data?.digest === true)
  if (!node) return 1
  const data = node.data ?? {}
  const meta = typeof data.digestVersion === 'number' && Number.isFinite(data.digestVersion)
    ? Math.max(0, Math.floor(data.digestVersion))
    : 0
  const content = typeof data.content === 'string' ? data.content : ''
  const m = content.match(/<span class="ver">第\s*(\d+)\s*版<\/span>/)
  const fromHtml = m ? Number(m[1]) : 0
  return Math.max(meta, Number.isFinite(fromHtml) ? fromHtml : 0) + 1
}

/**
 * D2 upsert 动作构造（纯函数）：无 digest 节点 ⇒ add_node；有 ⇒ update_node 同 nodeId。
 * 写入统一打 data.source='system-digest'（G4：不进 agent 工具统计/审批/计费——
 * 调用侧不经 pi 工具层，action 由系统管道产生）。
 */
export function buildDigestUpsertActions(input: {
  canvas: DigestRawCanvas
  html: string
  digestVersion: number
}): { nodeId: string; actions: CanvasAction[] } {
  const existing = input.canvas.nodes.find((n) => n.data?.digest === true)
  if (existing) {
    return {
      nodeId: existing.id,
      actions: [
        {
          type: 'update_node',
          payload: {
            id: existing.id,
            data: {
              content: input.html,
              digestVersion: input.digestVersion,
              status: 'completed',
            },
          },
        } as CanvasAction,
      ],
    }
  }
  // F2（final review）：确定性 id——add_node 在 applier 内对同 id 幂等（2026-10-01 修：
  // 重放/并发 add 同 id ⇒ data 合并非重复 push）。并发 detached finalizeTurn 双 add
  // 各自随机 id 会落两个 digest 节点（persist 串行只保 action 各落一次）；同 id 则
  // 第二次事务内 re-apply 走合并分支 ⇒ 结构性收敛单节点，最后写赢（D6 拍板可接受）。
  const nodeId = 'digest-canvas'
  // 放置：既有内容下方（空间序 y→x 的末尾，「总览在底部」心智）；空画布落 {80,80}。
  const maxY = input.canvas.nodes.reduce((m, n) => Math.max(m, n.position?.y ?? 0), 0)
  const position = input.canvas.nodes.length
    ? { x: 80, y: maxY + 320 }
    : { x: 80, y: 80 }
  return {
    nodeId,
    actions: [
      {
        type: 'add_node',
        payload: {
          id: nodeId,
          nodeType: 'text',
          position,
          data: {
            title: '画布总览',
            content: input.html,
            format: 'html',
            status: 'completed',
            source: 'system-digest',
            digest: true,
            digestVersion: input.digestVersion,
          },
        },
      } as CanvasAction,
    ],
  }
}

/**
 * 回合末管道编排（图 1）：flag 判定 → 快照采集 → 纯函数渲染 → upsert。
 * S7 fail-soft：任何异常内部吞掉 warn 后返回 null，不影响回合落库。
 */
export class CanvasDigestService {
  private readonly logger = new Logger(CanvasDigestService.name)

  constructor(
    private readonly prisma: { session: { findUnique(args: unknown): Promise<{ canvasData: string | null } | null> } },
    private readonly canvasTools: {
      upsertDigestNode(input: {
        sessionId: string
        userId: string
        html: string
        digestVersion: number
      }): Promise<{ nodeId: string; actions: CanvasAction[] }>
    },
  ) {}

  static isEnabled(): boolean {
    return process.env.CANVAS_DIGEST === 'on'
  }

  /** 实例侧 flag 门（挂载点经端口调用，便于替身替换；语义同 static）。 */
  isEnabled(): boolean {
    return CanvasDigestService.isEnabled()
  }

  async maybeRender(input: {
    sessionId: string
    userId?: string
    canvasActions: CanvasAction[]
  }): Promise<{ nodeId: string; actions: CanvasAction[] } | null> {
    try {
      if (!CanvasDigestService.isEnabled()) return null // S6：flag off 全链路零行为
      if (!input.canvasActions.length) return null // D1：纯聊天回合跳过
      if (!input.userId) return null

      const session = await this.prisma.session.findUnique({
        where: { id: input.sessionId },
        select: { canvasData: true },
      })
      if (!session) return null
      const canvas: DigestRawCanvas = session.canvasData
        ? (JSON.parse(session.canvasData) as DigestRawCanvas)
        : { nodes: [], edges: [] }

      const snapshot = collectDigestSnapshot(canvas)
      // F1（final review）：版本计算须在渲染**之前**并回填 snapshot——Header「第 N 版」
      // 是本轮要写入的版本（= 既有 +1），不是既有值；曾恒渲染 collectDigestSnapshot
      // 占位的 0 ⇒ Header 永远「第 0 版」（S2 违约）。
      // P1b：版本取自「元数据 + 上一版 HTML Header」双源 max+1，存量脏状态可自愈。
      const digestVersion = resolveNextDigestVersion(canvas)
      snapshot.digestVersion = digestVersion

      // §9.1 P3 可观测：仅 warn，不改触发架构 / 不改 HTML / 不写画布 / 不影响返回值。
      // fail-soft 与 S7 同源：探针自身异常不得阻断总览渲染。
      try {
        const staleIds = findDigestStaleIds({ canvas, canvasActions: input.canvasActions })
        if (staleIds.length > 0) {
          this.logger.warn(
            `digest_stale session=${input.sessionId} ver=${digestVersion} missing=${staleIds.length} ids=${staleIds.slice(0, 10).join(',')} — 画布已有正据节点未进入上一版总览（回合外画布态变更，§9.1 P3 准入证据）`,
          )
        }
      } catch (err) {
        this.logger.warn(
          `digest_stale_probe_failed session=${input.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      const html = renderDigestHtml(snapshot, { publicBaseUrl: resolvePublicBaseUrl() })
      if (!html) return null // 无可收录节点（D9 全过滤）

      return await this.canvasTools.upsertDigestNode({
        sessionId: input.sessionId,
        userId: input.userId,
        html,
        digestVersion,
      })
    } catch (err) {
      this.logger.warn(
        `canvas_digest skipped (session=${input.sessionId}): ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  }
}

/** D8：publicBaseUrl 解析（与 share.service 同链路；抽取复用见 Task 2 计划）。 */
export function resolvePublicBaseUrl(): string {
  return process.env.SHARE_PUBLIC_BASE_URL ?? process.env.API_PUBLIC_URL ?? 'http://119.29.173.89:8888'
}
