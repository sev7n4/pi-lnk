/**
 * P0 感知层工具：web_search（Tavily）+ web_fetch（readability+turndown）。
 * spec: docs/superpowers/specs/2026-09-28-agent-tool-p0-web-and-delete-design.md
 * 不重复造轮子：search 走 Tavily REST；fetch 用 MCP fetch server 同款 npm 栈。
 * 已知限制（有意不支持，见 spec §7）：DNS rebinding 不深防（netpol egress 白名单兜底）；
 * http:// 80 端口被 netpol 拦截，生产环境实际仅 https 可达。
 */
import { Type } from "typebox";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { LnkpiTool } from "./types.js";

/** 单字符上限：web_fetch 单次返回窗口（MCP fetch 模式，超出用 start_index 续读）。 */
export const FETCH_MAX_CHARS = 20_000;

const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MAX_BYTES = 2_000_000;
const EXCERPT_MAX_CHARS = 1_000;
const SEARCH_TOTAL_MAX_CHARS = 8_000;
const CACHE_TTL_MS = 15 * 60 * 1000;

function textResult(data: unknown): { content: [{ type: "text"; text: string }]; details: undefined } {
	return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }], details: undefined };
}

interface TavilyResult {
	title?: string;
	url?: string;
	content?: string;
}

function isPrivateIPv4(ip: string): boolean {
	const p = ip.split(".").map(Number);
	const a = p[0];
	const b = p[1];
	if (a === 127 || a === 10 || a === 0) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true;
	return false;
}

/** SSRF 防护纯函数：私网/loopback/link-local 主机名拒绝。无 DNS 解析（记录为限制）。
 *  IPv6 规则（fc/fd/fe80 前缀）只对含 ":" 的字面量生效——fcXX.com 这类普通域名不误杀（终审 I-2）。
 *  IPv4-mapped IPv6（::ffff:127.0.0.1 / ::ffff:7f00:1）剥前缀后复用 IPv4 判定（终审 I-1）。 */
export function isPrivateHost(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
	if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
	if (h.includes(":")) {
		// IPv4-embedded IPv6（::ffff:1.2.3.4 / 0:0:0:0:0:ffff:1.2.3.4 / NAT64 64:ff9b::1.2.3.4）：
		// 尾部点分十进制直接复用 IPv4 判定（终审 I-1）
		const dotted = h.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
		if (dotted) return isPrivateIPv4(dotted[1]);
		// 十六进制压缩形态 ::ffff:7f00:1 → 两段 16bit 拆 4 字节
		const hexMapped = h.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
		if (hexMapped) {
			const hi = parseInt(hexMapped[1], 16);
			const lo = parseInt(hexMapped[2], 16);
			if (Number.isNaN(hi) || Number.isNaN(lo)) return false;
			return isPrivateIPv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join("."));
		}
		// unique local fc00::/7、link-local fe80::/10
		return h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
	}
	const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m) return isPrivateIPv4(h);
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

export function buildWebTools(deps: { fetchImpl?: typeof fetch; now?: () => number } = {}): LnkpiTool[] {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const now = deps.now ?? (() => Date.now());
	// 15min TTL 内存缓存（无 LRU 上限，低频场景可接受，spec §12 P2 再议）
	const cache = new Map<string, { ts: number; md: string }>();
	const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

	const MAX_REDIRECTS = 5;

	/** 每跳重校验协议 + SSRF（终审 C-1：redirect:"follow" 会被公网页面 302 引到私网）。 */
	async function fetchWithRedirects(initUrl: URL): Promise<Response> {
		let url = initUrl;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			if (url.protocol !== "https:" && url.protocol !== "http:") {
				throw new Error("web_fetch refused non-http(s) url: " + url.toString());
			}
			if (isPrivateHost(url.hostname)) {
				throw new Error("web_fetch refused private address: " + url.hostname);
			}
			const res = await fetchImpl(url.toString(), {
				headers: { "user-agent": "pi-lnk-agent/0.1", accept: "text/html,text/plain" },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				redirect: "manual",
			});
			if (res.status >= 300 && res.status < 400) {
				const loc = res.headers.get("location");
				if (!loc) return res; // 无 Location 的 3xx 当普通响应处理
				url = new URL(loc, url);
				continue;
			}
			return res;
		}
		throw new Error("web_fetch too many redirects (max " + MAX_REDIRECTS + ")");
	}

	async function fetchMarkdown(url: URL): Promise<string> {
		const res = await fetchWithRedirects(url);
		const ctype = res.headers.get("content-type") ?? "";
		if (!/^(text\/html|text\/plain)/i.test(ctype)) {
			throw new Error(
				'web_fetch unsupported content-type "' + ctype + '" (only html/plain; PDF/images not supported)',
			);
		}
		const buf = await res.arrayBuffer();
		if (buf.byteLength > FETCH_MAX_BYTES) {
			throw new Error("web_fetch page too large (" + buf.byteLength + " bytes > " + FETCH_MAX_BYTES + ")");
		}
		const html = new TextDecoder().decode(buf);
		if (/text\/plain/i.test(ctype)) return html;
		const dom = new JSDOM(html, { url: url.toString() });
		const article = new Readability(dom.window.document).parse();
		if (!article?.content) throw new Error("web_fetch: no readable content extracted from page");
		return turndown.turndown(article.content);
	}

	return [
		{
			tier: "read" as const,
			name: "web_search",
			label: "网络搜索",
			summary: "Search the web, returns LLM-ready title/url/content blocks.",
			description:
				"Search the web via Tavily. Returns up to max_results entries with title, url and a cleaned content excerpt. Use before web_fetch to discover sources.",
			parameters: Type.Object({
				query: Type.String({ description: "search query" }),
				max_results: Type.Optional(Type.Number({ description: "1-10, default 5" })),
			}),
			execute: async (_id, p: { query: string; max_results?: number }) => {
				const apiKey = process.env.TAVILY_API_KEY;
				if (!apiKey || apiKey === "REPLACE_ME") {
					throw new Error("web_search not configured: TAVILY_API_KEY missing");
				}
				if (!p.query || !p.query.trim()) throw new Error("web_search requires a non-empty query");
				const maxResults = Math.min(Math.max(Math.floor(p.max_results ?? 5) || 5, 1), 10);
				let payload: { results?: TavilyResult[] };
				try {
					const res = await fetchImpl("https://api.tavily.com/search", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							api_key: apiKey,
							query: p.query,
							max_results: maxResults,
							search_depth: "basic",
							include_raw_content: false,
						}),
						signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
					});
					if (!res.ok) throw new Error("tavily http " + res.status);
					payload = (await res.json()) as { results?: TavilyResult[] };
				} catch (err) {
					throw new Error("web_search failed: " + (err instanceof Error ? err.message : String(err)));
				}
				const blocks: string[] = [];
				let used = 0;
				for (const r of payload.results ?? []) {
					const block =
						(r.title ?? "(untitled)") +
						"\n" +
						(r.url ?? "(no url)") +
						"\n" +
						(r.content ?? "").slice(0, EXCERPT_MAX_CHARS);
					if (used + block.length > SEARCH_TOTAL_MAX_CHARS) break;
					blocks.push(block);
					used += block.length;
				}
				return textResult({
					query: p.query,
					result_count: blocks.length,
					results: blocks,
					...(blocks.length === 0 ? { note: "no results returned by search provider" } : {}),
				});
			},
		},
		{
			tier: "read" as const,
			name: "web_fetch",
			label: "抓取网页",
			summary: "Fetch a public https URL, return readable markdown (20k window, start_index to continue).",
			description:
				"Fetch a public https URL, extract main content with Readability, convert to markdown. Long pages return a 20k-char window with a start_index hint; pass start_index to continue reading. Private/intranet addresses are refused.",
			parameters: Type.Object({
				url: Type.String({ description: "http(s) URL of a public page" }),
				start_index: Type.Optional(Type.Number({ description: "character offset to continue a truncated fetch" })),
			}),
			execute: async (_id, p: { url: string; start_index?: number }) => {
				let url: URL;
				try {
					url = new URL(p.url);
				} catch {
					throw new Error("web_fetch invalid url: " + p.url);
				}
				if (url.protocol !== "https:" && url.protocol !== "http:") {
					throw new Error("web_fetch refused non-http(s) url: " + p.url);
				}
				if (isPrivateHost(url.hostname)) {
					throw new Error("web_fetch refused private address: " + url.hostname);
				}
				const key = url.toString();
				const cached = cache.get(key);
				const fresh = cached !== undefined && now() - cached.ts < CACHE_TTL_MS;
				let md: string;
				if (fresh && cached) {
					md = cached.md;
				} else {
					try {
						md = await fetchMarkdown(url);
					} catch (err) {
						// 终审 M-3：网络层错误包装成模型可读文案（含 http 局限提示）
						throw new Error(
							"web_fetch failed: " +
								(err instanceof Error ? err.message : String(err)) +
								" (note: 仅支持公网可访问的 http(s) 页面；生产环境 http:80 被网络策略拦截)",
						);
					}
					cache.set(key, { ts: now(), md });
				}
				const { text, total, next } = truncateMarkdown(md, p.start_index ?? 0);
				const tail = next !== null ? "\n\n…[truncated, " + total + " chars total, call again with start_index=" + next + "]" : "";
				return textResult({
					url: key,
					start_index: Math.max(0, Math.floor(p.start_index ?? 0)),
					total_chars: total,
					next_index: next,
					content: text + tail,
				});
			},
		},
	];
}
