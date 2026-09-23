import { test } from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "../metrics.js";
import { resolveTools } from "./config.js";

test("env 缺失 → 返回空数组（纯文本模式不受影响）", () => {
	const prev = { b: process.env.NEST_BASE_URL, t: process.env.NEST_SERVICE_TOKEN };
	delete process.env.NEST_BASE_URL;
	delete process.env.NEST_SERVICE_TOKEN;
	try {
		assert.deepEqual(resolveTools(new Metrics()), []);
	} finally {
		if (prev.b !== undefined) process.env.NEST_BASE_URL = prev.b;
		if (prev.t !== undefined) process.env.NEST_SERVICE_TOKEN = prev.t;
	}
});

test("env 齐全 → 返回 7 个 read 工具", () => {
	process.env.NEST_BASE_URL = "http://127.0.0.1:1";
	process.env.NEST_SERVICE_TOKEN = "tok";
	try {
		const tools = resolveTools(new Metrics());
		assert.equal(tools.length, 7);
	} finally {
		delete process.env.NEST_BASE_URL;
		delete process.env.NEST_SERVICE_TOKEN;
	}
});
