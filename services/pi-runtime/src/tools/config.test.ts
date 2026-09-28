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

test("env 齐全 → 返回 7 read + 12 write + 7 ui_command + 6 gen/lifecycle = 32 个工具", () => {
	process.env.NEST_BASE_URL = "http://127.0.0.1:1";
	process.env.NEST_SERVICE_TOKEN = "tok";
	try {
		const tools = resolveTools(new Metrics());
		assert.equal(tools.length, 32);
		assert.ok(tools.some((t) => t.name === "upsert_media_node"));
		assert.ok(tools.some((t) => t.name === "connect_nodes"));
		assert.ok(tools.some((t) => t.name === "set_node_text"));
		assert.ok(tools.some((t) => t.name === "focus_node" && t.tier === "ui_command"));
		assert.ok(tools.some((t) => t.name === "ask_user" && t.tier === "ui_command"));
		assert.ok(tools.some((t) => t.name === "arrange_nodes" && t.tier === "ui_command"));
		assert.ok(!tools.some((t) => t.name === "introduce_nodes_to_agent"));
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
