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

export function buildWebTools(deps: { fetchImpl?: typeof fetch } = {}): LnkpiTool[] {
	const fetchImpl = deps.fetchImpl ?? fetch;
	// 15min TTL 内存缓存（无 LRU 上限，低频场景可接受，spec §12 P2 再议）
	const cache = new Map<string, { ts: number; md: string }>();
	const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

	async function fetchMarkdown(url: URL): Promise<string> {
		const res = await fetchImpl(url.toString(), {
			headers: { "user-agent": "pi-lnk-agent/0.1", accept: "text/html,text/plain" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			redirect: "follow",
		});
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
				const fresh = cached !== undefined && Date.now() - cached.ts < CACHE_TTL_MS;
				const md = fresh && cached ? cached.md : await fetchMarkdown(url);
				if (!fresh) cache.set(key, { ts: Date.now(), md });
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
