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

test("env 齐全（TAVILY 缺省）→ 8 read + 12 write + 7 ui_command + 6 gen/lifecycle + 1 destructive + 1 read_document + 2 memory = 37", () => {
	process.env.NEST_BASE_URL = "http://127.0.0.1:1";
	process.env.NEST_SERVICE_TOKEN = "tok";
	delete process.env.TAVILY_API_KEY;
	try {
		const tools = resolveTools(new Metrics());
		assert.equal(tools.length, 37);
		assert.ok(tools.some((t) => t.name === "upsert_media_node"));
		assert.ok(tools.some((t) => t.name === "connect_nodes"));
		assert.ok(tools.some((t) => t.name === "set_node_text"));
		assert.ok(tools.some((t) => t.name === "focus_node" && t.tier === "ui_command"));
		assert.ok(tools.some((t) => t.name === "ask_user" && t.tier === "ui_command"));
		assert.ok(tools.some((t) => t.name === "arrange_nodes" && t.tier === "ui_command"));
		// 有意不支持（2026-09-28 拍板，spec D4）：老链路 DEFERRED 工具不暴露，此断言为回归锁
		assert.ok(!tools.some((t) => t.name === "introduce_nodes_to_agent"));
		assert.ok(tools.some((t) => t.name === "delete_nodes" && t.tier === "destructive"));
		// P1（spec 2026-09-29）：read_document + memory 两工具无条件注册
		assert.ok(tools.some((t) => t.name === "read_document" && t.tier === "read"));
		assert.ok(tools.some((t) => t.name === "save_memory" && t.tier === "write_light"));
		assert.ok(tools.some((t) => t.name === "recall_memory" && t.tier === "read"));
		// spec S3（2026-09-29）：list_model_options 无条件注册（模型 ref 合法来源）
		assert.ok(tools.some((t) => t.name === "list_model_options" && t.tier === "read"));
	} finally {
		delete process.env.NEST_BASE_URL;
		delete process.env.NEST_SERVICE_TOKEN;
	}
});

test("B-5：gen/lifecycle 工具已注册（31 总数）", () => {
	process.env.NEST_BASE_URL = "http://127.0.0.1:1";
	process.env.NEST_SERVICE_TOKEN = "tok";
	try {
		const names = resolveTools(new Metrics()).map((t) => t.name);
		for (const n of [
			"run_image_generation",
			"run_video_generation",
			"run_text_generation",
			"run_prompt_generation",
			"run_audio_generation",
			"cancel_generation",
		]) {
			assert.ok(names.includes(n), `missing ${n}`);
		}
	} finally {
		delete process.env.NEST_BASE_URL;
		delete process.env.NEST_SERVICE_TOKEN;
	}
});

test("M-3：grid-slice-image 超时覆盖 120s（老链路第 4 档）", async () => {
	const { TOOL_TIMEOUT_OVERRIDES } = await import("./config.js");
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/grid-slice-image"], 120_000);
});

test("B-5：gen 工具超时档位对齐老链路（image/text/prompt/audio 210s、video 690s）", async () => {
	const { TOOL_TIMEOUT_OVERRIDES } = await import("./config.js");
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/run-image-generation"], 210_000);
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/wait-image-generation"], 210_000);
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/run-text-generation"], 210_000);
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/run-prompt-generation"], 210_000);
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/run-audio-generation"], 210_000);
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/run-video-generation"], 690_000);
	assert.equal(TOOL_TIMEOUT_OVERRIDES["/agent/internal/wait-video-generation"], 690_000);
});

test("P0：TAVILY_API_KEY 齐全 → 39 个工具（web_search/web_fetch 注册）", () => {
	process.env.NEST_BASE_URL = "http://127.0.0.1:1";
	process.env.NEST_SERVICE_TOKEN = "tok";
	process.env.TAVILY_API_KEY = "test-key";
	try {
		const tools = resolveTools(new Metrics());
		assert.equal(tools.length, 39);
		assert.ok(tools.some((t) => t.name === "web_search" && t.tier === "read"));
		assert.ok(tools.some((t) => t.name === "web_fetch" && t.tier === "read"));
	} finally {
		delete process.env.NEST_BASE_URL;
		delete process.env.NEST_SERVICE_TOKEN;
		delete process.env.TAVILY_API_KEY;
	}
});

test("P0：TAVILY_API_KEY=REPLACE_ME 占位 → 视同未配置（37 个）", () => {
	process.env.NEST_BASE_URL = "http://127.0.0.1:1";
	process.env.NEST_SERVICE_TOKEN = "tok";
	process.env.TAVILY_API_KEY = "REPLACE_ME";
	try {
		const tools = resolveTools(new Metrics());
		assert.equal(tools.length, 37);
		assert.ok(!tools.some((t) => t.name === "web_search"));
	} finally {
		delete process.env.NEST_BASE_URL;
		delete process.env.NEST_SERVICE_TOKEN;
		delete process.env.TAVILY_API_KEY;
	}
});

test("P0：ToolTier 枚举无 workflow_io/export（死 tier 已清理，spec D5）", async () => {
	const fs = await import("node:fs");
	const src = fs.readFileSync(new URL("./types.ts", import.meta.url), "utf8");
	assert.ok(!src.includes('"workflow_io"'), "workflow_io tier must be removed");
	assert.ok(!src.includes('"export"'), "export tier must be removed");
});
