# P0 Agent 工具补齐（web_search / web_fetch / delete_nodes + 拍板项）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 pi-runtime agent 补上感知层（web_search/web_fetch）与破坏性操作（delete_nodes），并清理拍板悬置项（死 tier 枚举、introduce_nodes_to_agent 锁注释）。

**Architecture:** 三个新工具全部落在 `services/pi-runtime/src/tools/`，按现有批次模式（`build*Tools` 工厂 + `config.ts` 装配）。web 双工具直连外网（不走 NestClient），search 调 Tavily REST、fetch 用 `@mozilla/readability` + `turndown`（MCP fetch server 同款栈）；delete_nodes 复用既有 Nest `/agent/internal/remove-nodes` 端点。装配按 `TAVILY_API_KEY` 条件注册（fail-closed 降级哲学）。

**Tech Stack:** TypeScript (ESM)、typebox 1.3.7（import 自 `"typebox"`，不是 `@sinclair/typebox`）、node:test + tsx、jsdom、@mozilla/readability、turndown。

**Spec:** `docs/superpowers/specs/2026-09-28-agent-tool-p0-web-and-delete-design.md`（实现时 spec 与本计划同读）

## Global Constraints

- 工具 execute 签名为四参：`async (_id, params, _u, tc: LnkpiToolContext) => ...`（对照 `canvas-write.ts:47`）
- 工具返回形态：`{ content: [{ type: "text", text: JSON.stringify(...) }], details: undefined }`（本计划内统一用局部 `textResult` helper，对照 `canvas-write.ts:14`）
- 错误处理：fail-closed 直接 `throw new Error("<工具名> ...")`——harness 不做 schema 校验，**所有参数约束必须在 execute 内手动兜底**（对照 `canvas-write.ts:51`）
- typebox import：`import { Type } from "typebox"`；Type.Array 只写 `description`，min/max 约束在 execute 内手动判（仓库现状如此）
- `ToolTier` 删除 `"workflow_io" | "export"` 后，全仓不得再引用这两个字符串作为 tier（grep 复核）
- `TAVILY_API_KEY` 判空须同时排除 `"REPLACE_ME"` 占位（helm values.yaml 有占位默认值）
- web 工具不走 NestClient（`/agent/internal` 超时表不适用），用注入的 `fetchImpl` + `AbortSignal.timeout` 自管超时
- 测试框架：node:test + assert/strict，文件名 `*.test.ts`，跑法 `pnpm -C services/pi-runtime test`
- **每个 commit 步骤前必须 `git status --short` 复核目标文件出现在列表里**（本环境有 Edit 报成功但未落盘前科；可靠判据只有 git status 显示 ` M`/`??`）
- 分支：从最新 master 拉 feature 分支 `feat/agent-tool-p0-web-delete`（**建分支前先 `git fetch origin`**——本地 origin/master 缓存会静默丢刚合入的 PR）
- 本机沙箱可能拒 pnpm install；被拒时改用 `--registry=https://registry.npmmirror.com` 重试，仍被拒则停下来报告，不要绕过沙箱

## Review Focus

spec 隐含但任务测试未完全覆盖、最可能咬到真实用户的五类输入（每条已 pinned 到对应任务）：

1. **模型传畸形 URL**（相对路径、`ftp://`、空串）→ `web_fetch` 必须报 "invalid url" 而非抛裸 TypeError —— Task 2
2. **非 HTML content-type**（PDF/JSON API/图片）→ 明确报 "unsupported content-type"，不喂乱码进上下文 —— Task 2
3. **Tavily 侧故障**（超时/5xx/空 results）→ 报 "web_search failed: <原因>"，空结果给明确 note 而非静默空串 —— Task 2
4. **模型越权删画布**（node_ids > 50、空数组、伪造 sessionId）→ execute 内兜底拒绝，schema 不暴露 sessionId 参数 —— Task 3
5. **SSRF 内网探测**（私网 IP/loopback/IPv6 ULA）→ `isPrivateHost` 拒绝；DNS rebinding 为已知限制不深防（netpol egress 白名单兜底）—— Task 1

---

### Task 1: web 纯函数（isPrivateHost / truncateMarkdown）

**Files:**
- Create: `services/pi-runtime/src/tools/web.ts`（本任务只写纯函数部分，工具实现 Task 2 补）
- Test: `services/pi-runtime/src/tools/web.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `isPrivateHost(hostname: string): boolean`；`truncateMarkdown(md: string, startIndex: number): { text: string; total: number; next: number | null }`——Task 2 的工具 execute 直接消费这两个函数

- [ ] **Step 1: 写失败测试**

创建 `services/pi-runtime/src/tools/web.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateHost, truncateMarkdown } from "./web.js";

test("isPrivateHost：私网/loopback 全拒绝", () => {
	for (const h of [
		"localhost",
		"127.0.0.1",
		"127.255.255.255",
		"10.0.0.1",
		"10.255.0.7",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"169.254.169.254", // cloud metadata endpoint
		"0.0.0.0",
		"::1",
		"fd00::1", // IPv6 unique local
		"fe80::1", // IPv6 link-local
	]) {
		assert.equal(isPrivateHost(h), true, `expected private: ${h}`);
	}
});

test("isPrivateHost：公网全放行（含 172 边界外）", () => {
	for (const h of ["example.com", "8.8.8.8", "1.2.3.4", "172.32.0.1", "api.tavily.com"]) {
		assert.equal(isPrivateHost(h), false, `expected public: ${h}`);
	}
});

test("truncateMarkdown：短文一次返回，next=null", () => {
	const r = truncateMarkdown("hello", 0);
	assert.equal(r.text, "hello");
	assert.equal(r.total, 5);
	assert.equal(r.next, null);
});

test("truncateMarkdown：恰好 20000 字符一次返回，next=null", () => {
	const md = "x".repeat(20_000);
	const r = truncateMarkdown(md, 0);
	assert.equal(r.text.length, 20_000);
	assert.equal(r.next, null);
});

test("truncateMarkdown：20001 字符切两窗，next 指向续读偏移", () => {
	const md = "x".repeat(20_001);
	const r1 = truncateMarkdown(md, 0);
	assert.equal(r1.text.length, 20_000);
	assert.equal(r1.next, 20_000);
	const r2 = truncateMarkdown(md, r1.next!);
	assert.equal(r2.text.length, 1);
	assert.equal(r2.next, null);
});

test("truncateMarkdown：startIndex 越界收敛到合法区间", () => {
	const r = truncateMarkdown("hello", 999);
	assert.equal(r.text, "");
	assert.equal(r.next, null);
	const r2 = truncateMarkdown("hello", -5);
	assert.equal(r2.text, "hello");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C services/pi-runtime test src/tools/web.test.ts`
（pnpm 的 test 脚本 glob 是全量；跑单文件用 `node --import tsx --test src/tools/web.test.ts`，在 `services/pi-runtime` 目录下执行）
Expected: FAIL，"Cannot find module './web.js'" 或导出不存在

- [ ] **Step 3: 最小实现**

创建 `services/pi-runtime/src/tools/web.ts`（本任务只含头部注释 + 两个纯函数；常量与工具在 Task 2 追加）：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test src/tools/web.test.ts`（在 `services/pi-runtime` 下）
Expected: PASS，6 个测试全绿

- [ ] **Step 5: 提交**

```bash
git status --short   # 复核 web.ts/web.test.ts 出现为 ??（落盘判据）
git add services/pi-runtime/src/tools/web.ts services/pi-runtime/src/tools/web.test.ts
git commit -m "feat(pi-runtime): web 工具纯函数 isPrivateHost/truncateMarkdown（SSRF+截断，spec D2/Review#5）"
```

---

### Task 2: 依赖安装 + web_search / web_fetch 工具

**Files:**
- Modify: `services/pi-runtime/package.json`（新增依赖）
- Modify: `pnpm-lock.yaml`（pnpm install 自动）
- Modify: `services/pi-runtime/src/tools/web.ts`（追加工具实现）
- Test: `services/pi-runtime/src/tools/web.test.ts`（追加工具测试）

**Interfaces:**
- Consumes: Task 1 的 `isPrivateHost` / `truncateMarkdown` / `FETCH_MAX_CHARS`
- Produces: `buildWebTools(deps?: { fetchImpl?: typeof fetch }): LnkpiTool[]`（Task 4 的 config.ts 装配消费；`fetchImpl` 可注入供测试 mock）

- [ ] **Step 1: 安装依赖**

```bash
pnpm -C /Users/4seven/workspace/pi-lnk/services/pi-runtime add @mozilla/readability turndown jsdom
pnpm -C /Users/4seven/workspace/pi-lnk/services/pi-runtime add -D @types/turndown
```

Expected: package.json dependencies 出现三项、devDependencies 出现 `@types/turndown`，`pnpm-lock.yaml` 更新。若沙箱拒绝 install，按 Global Constraints 最后一条处理（换 npmmirror 重试 / 停下报告）。

- [ ] **Step 2: 写失败测试（追加到 web.test.ts 末尾）**

```ts
import { buildWebTools } from "./web.js";

function mockFetch(responses: { status?: number; headers?: Record<string, string>; body?: string }[]) {
	const calls: RequestInfo[] = [];
	const impl = (async (input: RequestInfo, _init?: RequestInit) => {
		calls.push(input);
		const r = responses.shift() ?? { status: 200, headers: {}, body: "" };
		return {
			ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
			status: r.status ?? 200,
			statusText: "x",
			headers: new Headers(r.headers ?? {}),
			arrayBuffer: async () => new TextEncoder().encode(r.body ?? "").buffer,
			json: async () => JSON.parse(r.body ?? "null"),
			text: async () => r.body ?? "",
		} as unknown as Response;
	}) as typeof fetch;
	return { impl, calls };
}

function findTool(tools: ReturnType<typeof buildWebTools>, name: string) {
	const t = tools.find((x) => x.name === name);
	assert.ok(t, `missing tool ${name}`);
	return t;
}

const HTML_PAGE = `<!doctype html><html><head><title>Ref Page</title></head>
<body><article><h1>Bauhaus</h1><p>${"design ".repeat(200)}</p></article></body></html>`;

test("web_search：映射 Tavily 响应为 title/url/content 文本块", async () => {
	process.env.TAVILY_API_KEY = "test-key";
	try {
		const { impl } = mockFetch([
			{ headers: { "content-type": "application/json" }, body: JSON.stringify({ results: [
				{ title: "Bauhaus posters", url: "https://example.com/a", content: "great examples of bauhaus style posters" },
				{ title: "More", url: "https://example.com/b", content: "second" },
			] }) },
		]);
		const [tool] = buildWebTools({ fetchImpl: impl });
		const out = await tool.execute!("1", { query: "bauhaus poster design" }, undefined as never, {
			sessionId: "s1",
		} as never);
		const parsed = JSON.parse(out.content[0].text);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.data.result_count, 2);
		assert.ok(parsed.data.results[0].includes("Bauhaus posters"));
		assert.ok(parsed.data.results[0].includes("https://example.com/a"));
	} finally {
		delete process.env.TAVILY_API_KEY;
	}
});

test("web_search：TAVILY_API_KEY 缺失 → 报错（防御层，主防线是不注册）", async () => {
	delete process.env.TAVILY_API_KEY;
	const [tool] = buildWebTools({ fetchImpl: mockFetch([]).impl });
	await assert.rejects(() => tool.execute!("1", { query: "x" }, undefined as never, {} as never), /TAVILY_API_KEY missing/);
});

test("web_search：Tavily 5xx → web_search failed 明确文案（Review#3）", async () => {
	process.env.TAVILY_API_KEY = "test-key";
	try {
		const { impl } = mockFetch([{ status: 500, headers: { "content-type": "text/plain" }, body: "boom" }]);
		const [tool] = buildWebTools({ fetchImpl: impl });
		await assert.rejects(() => tool.execute!("1", { query: "x" }, undefined as never, {} as never), /web_search failed/);
	} finally {
		delete process.env.TAVILY_API_KEY;
	}
});

test("web_fetch：html → markdown 正文抽取（含标题）", async () => {
	const { impl } = mockFetch([{ headers: { "content-type": "text/html; charset=utf-8" }, body: HTML_PAGE }]);
	const tools = buildWebTools({ fetchImpl: impl });
	const tool = findTool(tools, "web_fetch");
	const out = await tool.execute!("1", { url: "https://example.com/page" }, undefined as never, {} as never);
	const parsed = JSON.parse(out.content[0].text);
	assert.equal(parsed.data.next_index, null);
	assert.ok(parsed.data.content.includes("Bauhaus"));
});

test("web_fetch：畸形 URL → invalid url 明确报错（Review#1）", async () => {
	const tool = findTool(buildWebTools({ fetchImpl: mockFetch([]).impl }), "web_fetch");
	await assert.rejects(() => tool.execute!("1", { url: "not a url" }, undefined as never, {} as never), /invalid url/);
	await assert.rejects(() => tool.execute!("1", { url: "ftp://example.com/x" }, undefined as never, {} as never), /invalid url|refused/);
});

test("web_fetch：非 HTML content-type → unsupported 明确报错（Review#2）", async () => {
	const { impl } = mockFetch([{ headers: { "content-type": "application/pdf" }, body: "%PDF-1.4" }]);
	const tool = findTool(buildWebTools({ fetchImpl: impl }), "web_fetch");
	await assert.rejects(() => tool.execute!("1", { url: "https://example.com/doc.pdf" }, undefined as never, {} as never), /unsupported content-type/);
});

test("web_fetch：私网地址 → refused（Review#5 复用 isPrivateHost）", async () => {
	const tool = findTool(buildWebTools({ fetchImpl: mockFetch([]).impl }), "web_fetch");
	await assert.rejects(() => tool.execute!("1", { url: "http://127.0.0.1:5100/x" }, undefined as never, {} as never), /refused/);
	await assert.rejects(() => tool.execute!("1", { url: "http://169.254.169.254/latest/meta-data" }, undefined as never, {} as never), /refused/);
});

test("web_fetch：超长页面截断 + start_index 续读 + 15min 缓存命中不二次外呼", async () => {
	const longBody = `<!doctype html><html><body><article><p>${"word ".repeat(8000)}</p></article></body></html>`;
	const { impl, calls } = mockFetch([{ headers: { "content-type": "text/html" }, body: longBody }]);
	const tool = findTool(buildWebTools({ fetchImpl: impl }), "web_fetch");
	const r1 = JSON.parse((await tool.execute!("1", { url: "https://example.com/long" }, undefined as never, {} as never)).content[0].text);
	assert.equal(r1.data.total_chars > 20_000, true);
	assert.ok(r1.data.content.includes("start_index="));
	const r2 = JSON.parse((await tool.execute!("1", { url: "https://example.com/long", start_index: r1.data.next_index }, undefined as never, {} as never)).content[0].text);
	assert.equal(r2.data.start_index, r1.data.next_index);
	assert.equal(calls.length, 1, "cache hit should not refetch");
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --import tsx --test src/tools/web.test.ts`（在 `services/pi-runtime` 下）
Expected: 新增 8 个测试 FAIL（buildWebTools 未导出），Task 1 的 6 个仍 PASS

- [ ] **Step 4: 实现工具（追加到 web.ts）**

在 web.ts 顶部补 import 与常量，底部追加 `buildWebTools`：

```ts
import { Type } from "typebox";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { LnkpiTool } from "./types.js";

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

export function buildWebTools(deps: { fetchImpl?: typeof fetch } = {}): LnkpiTool[] {
	const fetchImpl = deps.fetchImpl ?? fetch;
	// 模块级实例：15min TTL 内存缓存（无 LRU 上限，低频场景可接受，spec §12 P2 再议）
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
			throw new Error(`web_fetch unsupported content-type "${ctype}" (only html/plain; PDF/images not supported)`);
		}
		const buf = await res.arrayBuffer();
		if (buf.byteLength > FETCH_MAX_BYTES) {
			throw new Error(`web_fetch page too large (${buf.byteLength} bytes > ${FETCH_MAX_BYTES})`);
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
					if (!res.ok) throw new Error(`tavily http ${res.status}`);
					payload = (await res.json()) as { results?: TavilyResult[] };
				} catch (err) {
					throw new Error(`web_search failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				const blocks: string[] = [];
				let used = 0;
				for (const r of payload.results ?? []) {
					const block = `${r.title ?? "(untitled)"}\n${r.url ?? "(no url)"}\n${(r.content ?? "").slice(0, EXCERPT_MAX_CHARS)}`;
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
					throw new Error(`web_fetch invalid url: ${p.url}`);
				}
				if (url.protocol !== "https:" && url.protocol !== "http:") {
					throw new Error(`web_fetch refused non-http(s) url: ${p.url}`);
				}
				if (isPrivateHost(url.hostname)) {
					throw new Error(`web_fetch refused private address: ${url.hostname}`);
				}
				const key = url.toString();
				const cached = cache.get(key);
				const md = cached && Date.now() - cached.ts < CACHE_TTL_MS ? cached.md : await fetchMarkdown(url);
				if (!cached || Date.now() - cached.ts >= CACHE_TTL_MS) cache.set(key, { ts: Date.now(), md });
				const { text, total, next } = truncateMarkdown(md, p.start_index ?? 0);
				const tail = next !== null ? `\n\n…[truncated, ${total} chars total, call again with start_index=${next}]` : "";
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
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --import tsx --test src/tools/web.test.ts`（在 `services/pi-runtime` 下）
Expected: PASS，14 个测试全绿（Task 1 的 6 个 + 本任务 8 个）

- [ ] **Step 6: 提交**

```bash
git status --short   # 复核 package.json / pnpm-lock.yaml / web.ts / web.test.ts 均出现
git add services/pi-runtime/package.json pnpm-lock.yaml services/pi-runtime/src/tools/web.ts services/pi-runtime/src/tools/web.test.ts
git commit -m "feat(pi-runtime): web_search(Tavily) + web_fetch(readability+turndown) 工具（spec D1/D2）"
```

---

### Task 3: delete_nodes 工具

**Files:**
- Create: `services/pi-runtime/src/tools/delete-nodes.ts`
- Test: `services/pi-runtime/src/tools/delete-nodes.test.ts`

**Interfaces:**
- Consumes: `NestClient.post(path, body): Promise<unknown>`（返回解包后的 data）；`LnkpiToolContext.sessionId`（Nest 注入，fail-closed 唯一来源）
- Produces: `buildDeleteNodesTools(client: NestClient): LnkpiTool[]`、常量 `DELETE_NODES_MAX = 50`（Task 4 的 config.ts 装配消费）

- [ ] **Step 1: 写失败测试**

创建 `services/pi-runtime/src/tools/delete-nodes.test.ts`：

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeleteNodesTools, DELETE_NODES_MAX } from "./delete-nodes.js";
import type { NestClient } from "./nest-client.js";
import type { LnkpiToolContext } from "./types.js";

function fakeClient(capture: { path?: string; body?: unknown } = {}): NestClient {
	return {
		post: async (path: string, body: unknown) => {
			capture.path = path;
			capture.body = body;
			return { removedNodes: 2, removedEdges: 3 };
		},
	} as unknown as NestClient;
}

const tc = { sessionId: "sess-1", userId: "u1" } as LnkpiToolContext;

test("delete_nodes：schema 不暴露 sessionId（toolContext 安全模型锁）", () => {
	const [tool] = buildDeleteNodesTools(fakeClient());
	const schema = JSON.stringify(tool.parameters);
	assert.ok(!schema.includes("sessionId"), "sessionId must not be a model-visible parameter");
	assert.equal(tool.tier, "destructive");
});

test("delete_nodes：sessionId 只取 toolContext，nodeIds 驼峰透传", async () => {
	const capture: { path?: string; body?: unknown } = {};
	const [tool] = buildDeleteNodesTools(fakeClient(capture));
	const out = await tool.execute!("1", { node_ids: ["n1", "n2"] }, undefined as never, tc);
	assert.equal(capture.path, "/agent/internal/remove-nodes");
	assert.deepEqual(capture.body, { sessionId: "sess-1", nodeIds: ["n1", "n2"] });
	assert.ok(out.content[0].text.includes("removedNodes"));
});

test(`delete_nodes：超过 ${DELETE_NODES_MAX} 个 → execute 内兜底拒绝（Review#4）`, async () => {
	const [tool] = buildDeleteNodesTools(fakeClient());
	const tooMany = Array.from({ length: DELETE_NODES_MAX + 1 }, (_, i) => `n${i}`);
	await assert.rejects(() => tool.execute!("1", { node_ids: tooMany }, undefined as never, tc), /at most 50/);
});

test("delete_nodes：空数组 → 拒绝", async () => {
	const [tool] = buildDeleteNodesTools(fakeClient());
	await assert.rejects(() => tool.execute!("1", { node_ids: [] }, undefined as never, tc), /requires node_ids/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test src/tools/delete-nodes.test.ts`（在 `services/pi-runtime` 下）
Expected: FAIL，"Cannot find module './delete-nodes.js'"

- [ ] **Step 3: 实现**

创建 `services/pi-runtime/src/tools/delete-nodes.ts`：

```ts
/**
 * P0 破坏性操作：delete_nodes（tier=destructive）。
 * spec: docs/superpowers/specs/2026-09-28-agent-tool-p0-web-and-delete-design.md
 * 复用既有 Nest 端点 /agent/internal/remove-nodes（W31）：服务端自动删除关联边，零 Nest 改动。
 * v1 免交互审批（spec D3）：画布 undo/redo 兜底 + 单次上限 50；误删率高再上 before_tool 审批。
 * stage 参数 v1 不透传（恒直接删）；sessionId 只取 toolContext（模型入参不可覆盖会话归属）。
 */
import { Type } from "typebox";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";

export const DELETE_NODES_MAX = 50;

function textResult(data: unknown): { content: [{ type: "text"; text: string }]; details: undefined } {
	return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }], details: undefined };
}

export function buildDeleteNodesTools(client: NestClient): LnkpiTool[] {
	return [
		{
			tier: "destructive" as const,
			name: "delete_nodes",
			label: "删除节点",
			description:
				"Delete canvas nodes by id. Edges connected to deleted nodes are removed automatically. Max 50 nodes per call. The canvas supports undo, but for large deletions prefer confirming the scope with the user first.",
			parameters: Type.Object({
				node_ids: Type.Array(Type.String({ description: "Canvas node id" }), {
					description: `node ids to delete (1-${DELETE_NODES_MAX} per call)`,
				}),
			}),
			execute: async (_id, p: { node_ids: string[] }, _u, tc: LnkpiToolContext) => {
				// harness 不做 schema 校验，约束在此兜底（对齐 canvas-write 模式）
				if (!Array.isArray(p.node_ids) || p.node_ids.length === 0) {
					throw new Error("delete_nodes requires node_ids (1-50 per call)");
				}
				if (p.node_ids.length > DELETE_NODES_MAX) {
					throw new Error(`delete_nodes accepts at most ${DELETE_NODES_MAX} nodes per call`);
				}
				const data = await client.post("/agent/internal/remove-nodes", {
					sessionId: tc.sessionId,
					nodeIds: p.node_ids,
				});
				return textResult(data);
			},
		},
	];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --import tsx --test src/tools/delete-nodes.test.ts`（在 `services/pi-runtime` 下）
Expected: PASS，4 个测试全绿

- [ ] **Step 5: 提交**

```bash
git status --short   # 复核 delete-nodes.ts / delete-nodes.test.ts 出现为 ??
git add services/pi-runtime/src/tools/delete-nodes.ts services/pi-runtime/src/tools/delete-nodes.test.ts
git commit -m "feat(pi-runtime): delete_nodes 工具（tier=destructive，复用 Nest remove-nodes，spec D3/D4）"
```

---

### Task 4: 装配 + 断言 + 死 tier 清理

**Files:**
- Modify: `services/pi-runtime/src/tools/registry.ts`（追加两个批次工厂导出）
- Modify: `services/pi-runtime/src/tools/config.ts`（条件装配）
- Modify: `services/pi-runtime/src/tools/types.ts`（ToolTier 删 `workflow_io`/`export`）
- Test: `services/pi-runtime/src/tools/config.test.ts`（32→33/35 断言 + introduce 锁注释）

**Interfaces:**
- Consumes: Task 2 `buildWebTools(deps?: { fetchImpl?: typeof fetch })`；Task 3 `buildDeleteNodesTools(client: NestClient)`
- Produces: `resolveToolsWithClient` 返回的工具全集——无 TAVILY 时 33 个（+delete_nodes），有 TAVILY 时 35 个（+web_search/web_fetch）

- [ ] **Step 1: 更新失败断言（先改测试）**

修改 `services/pi-runtime/src/tools/config.test.ts`：

① 现有 "env 齐全" 测试（第 18 行起）改为：开头补 `delete process.env.TAVILY_API_KEY;`，总数断言 `32` 改 `33`，标题改 `7 read + 12 write + 7 ui_command + 6 gen/lifecycle + 1 destructive = 33（TAVILY 缺省）`，并在第 30 行 introduce 断言处补注释与 delete_nodes 断言：

```ts
		// 有意不支持（2026-09-28 拍板，spec D4）：老链路 DEFERRED 工具不暴露，此断言为回归锁
		assert.ok(!tools.some((t) => t.name === "introduce_nodes_to_agent"));
		assert.ok(tools.some((t) => t.name === "delete_nodes" && t.tier === "destructive"));
```

② 文件末尾追加：

```ts
test("P0：TAVILY_API_KEY 齐全 → 35 个工具（web_search/web_fetch 注册）", () => {
	process.env.NEST_BASE_URL = "http://127.0.0.1:1";
	process.env.NEST_SERVICE_TOKEN = "tok";
	process.env.TAVILY_API_KEY = "test-key";
	try {
		const tools = resolveTools(new Metrics());
		assert.equal(tools.length, 35);
		assert.ok(tools.some((t) => t.name === "web_search" && t.tier === "read"));
		assert.ok(tools.some((t) => t.name === "web_fetch" && t.tier === "read"));
	} finally {
		delete process.env.NEST_BASE_URL;
		delete process.env.NEST_SERVICE_TOKEN;
		delete process.env.TAVILY_API_KEY;
	}
});

test("P0：TAVILY_API_KEY=REPLACE_ME 占位 → 视同未配置（33 个）", () => {
	process.env.NEST_BASE_URL = "http://127.0.0.1:1";
	process.env.NEST_SERVICE_TOKEN = "tok";
	process.env.TAVILY_API_KEY = "REPLACE_ME";
	try {
		const tools = resolveTools(new Metrics());
		assert.equal(tools.length, 33);
		assert.ok(!tools.some((t) => t.name === "web_search"));
	} finally {
		delete process.env.NEST_BASE_URL;
		delete process.env.NEST_SERVICE_TOKEN;
		delete process.env.TAVILY_API_KEY;
	}
});

test("P0：ToolTier 枚举无 workflow_io/export（死 tier 已清理，spec D5）", async () => {
	const { ToolTier } = await import("./types.js");
	// tier 是 type union（运行时无值），校验编译期字符串集合的替代锚点：
	// 全仓 tier 赋值只允许白名单内的字面量
	const src = await import("node:fs").then((fs) =>
		fs.readFileSync(new URL("./types.ts", import.meta.url), "utf8"),
	);
	assert.ok(!src.includes('"workflow_io"'), "workflow_io tier must be removed");
	assert.ok(!src.includes('"export"'), "export tier must be removed");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --import tsx --test src/tools/config.test.ts`（在 `services/pi-runtime` 下）
Expected: FAIL——33/35 断言失败（当前 32 个、无 delete/web 工具）

- [ ] **Step 3: 实现**

① `services/pi-runtime/src/tools/types.ts`：`ToolTier` union 删除 `"workflow_io"` 与 `"export"` 两行。

② `services/pi-runtime/src/tools/registry.ts`：头部 import 后追加：

```ts
import { buildWebTools } from "./web.js";
import { buildDeleteNodesTools } from "./delete-nodes.js";

/** P0 批次：web_search/web_fetch（感知层）。TAVILY_API_KEY 未配置时由 config.ts 条件装配。 */
export { buildWebTools };

/** P0 批次：delete_nodes（tier=destructive，复用 Nest remove-nodes）。 */
export { buildDeleteNodesTools };
```

③ `services/pi-runtime/src/tools/config.ts`：import 区补 `import { buildWebTools, buildDeleteNodesTools } from "./registry.js";`，`resolveToolsWithClient` 的 tools 数组字面量整体替换为：

```ts
	const hasTavily = !!process.env.TAVILY_API_KEY && process.env.TAVILY_API_KEY !== "REPLACE_ME";
	const tools: LnkpiTool[] = [
		...buildCanvasReadTools(client),
		...buildCanvasWriteTools(client),
		...buildUiCommandTools(metrics),
		...buildAskUserTools(metrics),
		...buildArrangeNodesTools(metrics),
		...buildGenerationTools(client),
		...(hasTavily ? buildWebTools() : []),
		...buildDeleteNodesTools(client),
	];
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run（在 `services/pi-runtime` 下）:
```
node --import tsx --test src/tools/config.test.ts
pnpm -C /Users/4seven/workspace/pi-lnk/services/pi-runtime test
```
Expected: config.test 全绿；pi-runtime 全量测试绿（web/delete 的新测试含在内）

- [ ] **Step 5: 死 tier 全仓 grep 复核 + typecheck + 提交**

用 Grep 工具在 `services/pi-runtime/src` 下搜 `workflow_io` 与 `"export"`：src 下应零命中（spec/plan 文档命中不算）。

```bash
pnpm -C /Users/4seven/workspace/pi-lnk/services/pi-runtime run typecheck
git status --short   # 复核 types.ts / registry.ts / config.ts / config.test.ts 均出现
git add services/pi-runtime/src/tools/types.ts services/pi-runtime/src/tools/registry.ts services/pi-runtime/src/tools/config.ts services/pi-runtime/src/tools/config.test.ts
git commit -m "feat(pi-runtime): 装配 web+delete 批次，ToolTier 清理死枚举 workflow_io/export（spec D5）"
```

---

### Task 5: helm 配置占位 + 收尾验证 + PR

**Files:**
- Modify: `charts/pi-lnk-runtime/values.yaml`（secrets 段注释 + 占位）
- Modify: `docs/superpowers/specs/2026-09-28-agent-tool-p0-web-and-delete-design.md`（如实现中发现 spec 偏差，回写勘误）

**Interfaces:**
- Consumes: Task 2–4 的全部产物
- Produces: 可部署的 pi-runtime（版本号沿项目惯例升 patch，当前生产 tag 0.0.11 → 本次 0.0.12 由部署环节处理，不在本计划内）

- [ ] **Step 1: values.yaml secrets 段补占位**

在 `charts/pi-lnk-runtime/values.yaml` 的 `secrets:` 段（`AGNES_API_KEY` 附近）追加：

```yaml
  # TAVILY_API_KEY: web_search/web_fetch 检索源 key（https://tavily.com 免费申请，1000 次/月）
  # 未配置或为 REPLACE_ME 时 web 工具不注册（降级哲学，spec §4 fail-closed）
  # 部署时：--set secrets.TAVILY_API_KEY=<值>
  TAVILY_API_KEY: "REPLACE_ME"
```

- [ ] **Step 2: 全量验证**

Run（仓库根目录）:
```
pnpm -C /Users/4seven/workspace/pi-lnk/services/pi-runtime test
pnpm -C /Users/4seven/workspace/pi-lnk/services/pi-runtime run typecheck
```
Expected: 全部 PASS。再按仓库规范跑 monorepo 相关构建（`pnpm -C /Users/4seven/workspace/pi-lnk -r --filter @pi-lnk/pi-runtime run build`）确认 dist 产物正常。

- [ ] **Step 3: 提交 + 推分支 + 开 PR**

```bash
git status --short   # 复核 values.yaml 出现
git add charts/pi-lnk-runtime/values.yaml
git commit -m "chore(helm): pi-runtime secrets 补 TAVILY_API_KEY 占位（部署时 --set 注入）"
git push -u origin feat/agent-tool-p0-web-delete
```

开 PR（base master），PR 描述引用 spec 与本计划路径，勾 CI 三项（Verify spec figures / Build monorepo / Build API Docker image）。

- [ ] **Step 4: 目视验收（部署后，本计划外但登记判据）**

部署 pi-runtime 新 tag 后（**必须 docker build --no-cache**，构建后 exec grep dist 验证特征串 `web_search`）：
1. 对话让 agent 搜一个真实主题 → tool result 有真实 title/url/content
2. 让 agent 抓一个 https 长文 → 出现 20k 截断提示，`start_index` 续读语义连续
3. 让 agent 删除画布 2 个节点 → 前端同步消失、关联边一并清理、Ctrl+Z 可撤销
4. 不配 key 的环境 → 模型工具列表无 web_search/web_fetch（`curl localhost:30100` 会话工具列表验证）

## Self-Review 记录

- **Spec 覆盖**：§5.1→Task 1+2；§5.2→Task 3；§5.3→Task 4；§7 helm→Task 5；§6 场景 A–D→Task 2/3 测试 + Task 5 目视验收；D1–D5 决策全部落进对应任务测试或实现注释。无缺口。
- **占位扫描**：无 TBD/TODO；Task 4 Step 3 只含最终正确写法（自审时删除了易误抄的对照块）。
- **类型一致性**：`buildWebTools(deps?: { fetchImpl?: typeof fetch })`（Task 2 定义 = Task 4 消费，无参调用）；`buildDeleteNodesTools(client: NestClient)`（Task 3 定义 = Task 4 消费）；`isPrivateHost`/`truncateMarkdown` 签名 Task 1=Task 2 一致；`DELETE_NODES_MAX=50` Task 3 定义 = 测试引用一致。
- **Review Focus**：五类输入全部有 owning task 的测试 pin（Task 1: SSRF；Task 2: 畸形 URL/非 HTML/Tavily 故障；Task 3: 越权删除）。
