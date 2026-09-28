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

// ---- Task 2：web_search / web_fetch 工具 ----

import { buildWebTools } from "./web.js";

function mockFetch(responses: { status?: number; headers?: Record<string, string>; body?: string }[]) {
	const calls: string[] = [];
	const impl = (async (input: RequestInfo | URL, _init?: RequestInit) => {
		calls.push(String(input));
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
	assert.ok(t, "missing tool " + name);
	return t;
}

const HTML_PAGE =
	'<!doctype html><html><head><title>Ref Page</title></head><body><article><h1>Bauhaus</h1><p>' +
	"design ".repeat(200) +
	"</p></article></body></html>";

test("web_search：映射 Tavily 响应为 title/url/content 文本块", async () => {
	process.env.TAVILY_API_KEY = "test-key";
	try {
		const { impl } = mockFetch([
			{
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					results: [
						{ title: "Bauhaus posters", url: "https://example.com/a", content: "great examples of bauhaus style posters" },
						{ title: "More", url: "https://example.com/b", content: "second" },
					],
				}),
			},
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
	await assert.rejects(
		() => tool.execute!("1", { query: "x" }, undefined as never, {} as never),
		/TAVILY_API_KEY missing/,
	);
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
	await assert.rejects(() => tool.execute!("1", { url: "ftp://example.com/x" }, undefined as never, {} as never), /refused/);
});

test("web_fetch：非 HTML content-type → unsupported 明确报错（Review#2）", async () => {
	const { impl } = mockFetch([{ headers: { "content-type": "application/pdf" }, body: "%PDF-1.4" }]);
	const tool = findTool(buildWebTools({ fetchImpl: impl }), "web_fetch");
	await assert.rejects(
		() => tool.execute!("1", { url: "https://example.com/doc.pdf" }, undefined as never, {} as never),
		/unsupported content-type/,
	);
});

test("web_fetch：私网地址 → refused（Review#5 复用 isPrivateHost）", async () => {
	const tool = findTool(buildWebTools({ fetchImpl: mockFetch([]).impl }), "web_fetch");
	await assert.rejects(() => tool.execute!("1", { url: "http://127.0.0.1:5100/x" }, undefined as never, {} as never), /refused/);
	await assert.rejects(
		() => tool.execute!("1", { url: "http://169.254.169.254/latest/meta-data" }, undefined as never, {} as never),
		/refused/,
	);
});

test("web_fetch：超长页面截断 + start_index 续读 + 缓存命中不二次外呼", async () => {
	const longBody =
		"<!doctype html><html><body><article><p>" + "word ".repeat(8000) + "</p></article></body></html>";
	const { impl, calls } = mockFetch([{ headers: { "content-type": "text/html" }, body: longBody }]);
	const tool = findTool(buildWebTools({ fetchImpl: impl }), "web_fetch");
	const r1 = JSON.parse(
		(await tool.execute!("1", { url: "https://example.com/long" }, undefined as never, {} as never)).content[0].text,
	);
	assert.equal(r1.data.total_chars > 20_000, true);
	assert.ok(r1.data.content.includes("start_index="));
	const r2 = JSON.parse(
		(
			await tool.execute!("1", { url: "https://example.com/long", start_index: r1.data.next_index }, undefined as never, {} as never)
		).content[0].text,
	);
	assert.equal(r2.data.start_index, r1.data.next_index);
	assert.equal(calls.length, 1, "cache hit should not refetch");
});
