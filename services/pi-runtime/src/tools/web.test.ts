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
