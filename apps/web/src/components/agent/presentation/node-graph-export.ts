/**
 * `node_graph` → 独立 HTML 快照（2026-07-24）。
 *
 * ## 为什么是「快照/ 分享」而不是别的
 *
 * 产物是一个**静态 HTML 文件**：位置与连线已内嵌、不依赖服务端。
 * ⚠️ **缩略图拿不到**—— `node_graph` 载荷里只有 `id`/`title`/`position`，
 * **没有图片 URL**（后端 `types-node-graph.ts` 有意如此：载荷服务于画布投影，不是素材分发）。
 * 所以本快照**默认不显示缩略图**，改用「类型色块 + 图标 + 标题」。
 * ⚠️ 若将来要缩略图，需要在 HTML 里按 node id 调鉴权取图接口 ——
 *那会把快照从「零依赖」变成「依赖登录态」，是另一个权衡，不在本次范围。
 *
 * ## 安全：为什么所有文本都要转义
 *
 * 节点标题来自画布（用户可编辑），会原样进 HTML。**不转义就是 XSS**：
 * 标题 `<img src=x onerror=alert(1)>` 会在打开文件时执行。
 * ⇒ `escapeHtml` 覆盖 `& < > " '` 五个字符，**不可省**。
 */

/** 转义 HTML 文本节点（`&` 必须第一个处理，否则会把已转义的 `&lt;` 再转一次）。 */
export function escapeHtml(s: unknown): string {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

interface GraphNode {
	id: string;
	type?: string;
	title?: string;
	position?: { x: number; y: number };
	groupId?: string;
	status?: string;
}
interface GraphEdge {
	source: string;
	target: string;
}

/** 类型 → 视觉语义。未知类型走中性色（**不编造**语义）。 */
const TYPE_STYLE: Record<string, { label: string; icon: string; color: string }> = {
	image: { label: "图片", icon: "▣", color: "#7F77DD" },
	video: { label: "视频", icon: "▶", color: "#D85A30" },
	audio: { label: "音频", icon: "♪", color: "#BA7517" },
	text: { label: "文本", icon: "¶", color: "#1D9E75" },
	table: { label: "表格", icon: "▦", color: "#378ADD" },
	group: { label: "分组", icon: "▢", color: "#888780" },
};
const NEUTRAL = { label: "节点", icon: "⬦", color: "#888780" };

function styleOf(t?: string) {
	return (t && TYPE_STYLE[t]) || NEUTRAL;
}

/**
 * 生成独立 HTML 字符串。
 *
 * ⚠️ **布局用画布原坐标**（不重排）—— 与前端 Vue Flow 的取值一致，
 * 这样「导出的快照」和「屏幕上看到的」是同一张图。
 */
export function buildNodeGraphHtml(
	nodes: GraphNode[],
	edges: GraphEdge[],
	title?: string,
): string {
	const safeTitle = escapeHtml(title || "画布概览");

	// 视图框按节点包围盒算（留20px 边距），空图给一个最小视口
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const n of nodes) {
		const x = n.position?.x ?? 0;
		const y = n.position?.y ?? 0;
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x + 168);
		maxY = Math.max(maxY, y + 96);
	}
	if (!nodes.length) {
		minX = 0;
		minY = 0;
		maxX = 400;
		maxY = 240;
	}
	//⚠️ 包围盒要**贴紧**节点，不能只算 min/max：
	//   画布节点间距常是 200–400px，而节点本身仅 168px 宽 ⇒ 空白远大于内容
	//   ⇒ SVG 视图里大量留白 ⇒ 内容被压得很小（用户实测"看不清"）。
	//   这里保持紧贴（pad 20），让导出页至少是"节点排布"的密度。
	const pad = 20;
	const vbW = Math.max(1, maxX - minX + pad * 2);
	const vbH = Math.max(1, maxY - minY + pad * 2);

	const byId = new Map(nodes.map((n) => [n.id, n]));

	const edgesSvg = edges
		.map((e) => {
			const s = byId.get(e.source);
			const t = byId.get(e.target);
			// ⚠️ 两端缺节点就跳过（不编造位置）
			if (!s?.position || !t?.position) return "";
			const sx = (s.position.x ?? 0) + 168;
			const sy = (s.position.y ?? 0) + 48;
			const tx = t.position.x ?? 0;
			const ty = (t.position.y ?? 0) + 48;
			const dashed = s.type === "group" || t.type === "group" ? ` stroke-dasharray="5 4"` : "";
			return `<line x1="${sx}" y1="${sy}" x2="${tx}" y2="${ty}" stroke="#b4b2a9" stroke-width="1.6"${dashed} />`;
		})
		.join("\n");

	const nodesSvg = nodes
		.map((n) => {
			const st = styleOf(n.type);
			const x = n.position?.x ?? 0;
			const y = n.position?.y ?? 0;
			const running = n.status === "running" || n.status === "failed";
			return `<g>
    <rect x="${x}" y="${y}" width="168" height="96" rx="9" fill="#ffffff" stroke="${st.color}" stroke-width="1.4"/>
    <rect x="${x + 1}" y="${y + 1}" width="166" height="62" rx="8" fill="${st.color}" opacity="0.13"/>
    <text x="${x + 84}" y="${y + 40}" font-size="20" fill="${st.color}" text-anchor="middle" opacity="0.85">${st.icon}</text>
    <text x="${x + 10}" y="${y + 80}" font-size="12" fill="#1c1c1a">${escapeHtml(n.title || n.id)}</text>
    <text x="${x + 158}" y="${y + 80}" font-size="10" fill="#8a8a82" text-anchor="end">${escapeHtml(st.label)}</text>
    ${running ? `<circle cx="${x + 158}" cy="${y + 14}" r="4" fill="${n.status === "failed" ? "#E24B4A" : "#EF9F27"}"/>` : ""}
  </g>`;
		})
		.join("\n");

	const stats = `${nodes.length} 节点 · ${edges.length} 连线`;

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 28px 20px 56px; background: #f7f7f5; color: #1c1c1a;
         font: 400 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 19px; font-weight: 500; margin: 0 0 4px; }
  .meta { font-size: 12px; color: #8a8a82; margin: 0 0 18px; }
  .card { background: #fff; border: 1px solid rgba(0,0,0,.12); border-radius: 12px; padding: 14px; }
  .hint { font-size: 11px; color: #8a8a82; margin: 14px 0 0; line-height: 1.6; }
  svg { display: block; width: 100%; height: auto; background: #efeeea; border-radius: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${safeTitle}</h1>
  <p class="meta">画布节点图快照 · ${escapeHtml(stats)}</p>
  <div class="card">
    <svg viewBox="${minX - pad} ${minY - pad} ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg">
${edgesSvg}
${nodesSvg}
    </svg>
  </div>
  <p class="hint">静态快照：位置与连线已内嵌，不依赖服务端。<br/>缩略图未包含（node_graph 载荷不含图片 URL）—— 需要看图请回画布。</p>
</div>
</body>
</html>`;
}

/** 建议文件名（`<title>`-cmuwrdar.html` 风格，源自会话 id）。 */
export function nodeGraphFileName(sessionId: string, title?: string): string {
	const slug = String(title || "node-graph")
		.trim()
		.replace(/[^\w一-龥-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return `${slug || "node-graph"}-${String(sessionId || "session").slice(0, 8)}.html`;
}