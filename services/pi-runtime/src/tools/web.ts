/**
 * P0 感知层工具：web_search（Tavily）+ web_fetch（readability+turndown）。
 * spec: docs/superpowers/specs/2026-09-28-agent-tool-p0-web-and-delete-design.md
 * 不重复造轮子：search 走 Tavily REST；fetch 用 MCP fetch server 同款 npm 栈。
 * 已知限制（有意不支持，见 spec §7）：DNS rebinding 不深防（netpol egress 白名单兜底）；
 * http:// 80 端口被 netpol 拦截，生产环境实际仅 https 可达。
 */

/** 单字符上限：web_fetch 单次返回窗口（MCP fetch 模式，超出用 start_index 续读）。 */
export const FETCH_MAX_CHARS = 20_000;

/** SSRF 防护纯函数：私网/loopback/link-local 主机名拒绝。无 DNS 解析（记录为限制）。 */
export function isPrivateHost(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/\.$/, "");
	if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
	const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m) {
		const a = Number(m[1]);
		const b = Number(m[2]);
		if (a === 127 || a === 10 || a === 0) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 169 && b === 254) return true;
		return false;
	}
	if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
	return false;
}

/** 截断纯函数：[startIndex, startIndex+20k) 窗口 + next 指针；越界收敛不抛错。 */
export function truncateMarkdown(
	md: string,
	startIndex: number,
): { text: string; total: number; next: number | null } {
	const total = md.length;
	const start = Math.max(0, Math.min(Math.floor(startIndex) || 0, total));
	const end = Math.min(start + FETCH_MAX_CHARS, total);
	return { text: md.slice(start, end), total, next: end < total ? end : null };
}
