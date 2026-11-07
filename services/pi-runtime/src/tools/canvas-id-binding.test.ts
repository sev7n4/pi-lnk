/** canvas-id-binding 单测（spec 2026-10-16 P1-C/P1-D）：纯逻辑直调，stub harness 见 Task 3。 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	closeBindingWindow,
	decideBinding,
	recordUpsertedNode,
	registerCanvasIdBindingHooks,
	resetIdBindingForTest,
	resetIdBindingRewritesForTest,
} from "./canvas-id-binding.js";
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import type { LnkpiToolContext } from "./types.js";

function upsertContent(nodeId: string) {
	return [{ type: "text", text: JSON.stringify({ ok: true, data: { nodeId, actions: [] } }) }];
}

describe("canvas-id-binding: 同批窗口捕获与裁决（spec P1b）", () => {
	it("窗口未开（无 pending upsert）→ 放行旧节点引用（合法用户点名，spec P1-D）", () => {
		resetIdBindingForTest();
		assert.deepEqual(decideBinding("propose_generation", { node_id: "image-old" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("窗口内单 upsert + node_id 不一致 → rewrite 为记录 id（spec P1-C，零重试主路径）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-new"));
		const original = { node_id: "image-old", guide_scene_id: "s1" };
		const d = decideBinding("propose_generation", original, "r1");
		assert.deepEqual(d, { kind: "rewrite", nodeId: "image-new" });
		// 不突变调用方 args（重写由 register 层展开新对象）
		assert.equal(original.node_id, "image-old");
	});

	it("node_id 已等于记录 id → passthrough（含 update 路径 upsert 返回 existing.id）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-new"));
		assert.deepEqual(decideBinding("set_node_generation_params", { node_id: "image-new" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("同批多 upsert（无法消歧）→ fail-closed block 且 reason 列出全部候选 id（Review Focus #2）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-a"));
		recordUpsertedNode("r1", upsertContent("image-b"));
		const d = decideBinding("propose_generation", { node_id: "image-a" }, "r1");
		assert.equal(d.kind, "block");
		assert.ok(d.kind === "block" && d.reason.includes("image-a") && d.reason.includes("image-b"));
	});

	it("prompt-only set_node_text（无 content）→ 永不介入（跨轮窗口只管 content 写入）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-new"));
		assert.deepEqual(decideBinding("set_node_text", { node_id: "image-old" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("畸形 content（非 JSON / 缺 data.nodeId / 非 text 块）→ fail-soft 不记录、不抛（Review Focus #3）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", [{ type: "text", text: "not json" }]);
		recordUpsertedNode("r1", [{ type: "text", text: JSON.stringify({ ok: true }) }]);
		recordUpsertedNode("r1", "string-content");
		assert.deepEqual(decideBinding("propose_generation", { node_id: "image-old" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("before_request 关窗：同 run 后续消息合法提名旧节点 → 不误重写（Review Focus #1）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-new"));
		closeBindingWindow("r1");
		assert.deepEqual(decideBinding("propose_generation", { node_id: "image-old" }, "r1"), {
			kind: "passthrough",
		});
	});

	it("窗口按 runId 隔离：r2 的窗口不影响 r1，反之亦然", () => {
		resetIdBindingForTest();
		recordUpsertedNode("r1", upsertContent("image-r1"));
		assert.deepEqual(decideBinding("propose_generation", { node_id: "x" }, "r2"), { kind: "passthrough" });
		assert.deepEqual(decideBinding("propose_generation", { node_id: "x" }, "r1").kind, "rewrite");
	});
});

describe("canvas-id-binding: 钩子注册与 kill switch（spec P1b）", () => {
	/** 捕获式 stub harness（同 plan-gate-wiring.test.ts 范式）。 */
	function stubHarness() {
		const handlers = new Map<string, (event: never) => Promise<unknown>>();
		const harness = {
			hooks: {
				on: (name: string, fn: never) => {
					handlers.set(name, fn as never);
				},
			},
		} as unknown as AgentHarness<LnkpiToolContext>;
		return { harness, handlers };
	}

	it("默认 on：注册 after_tool / before_tool / before_request 三钩子", () => {
		resetIdBindingForTest();
		const { harness, handlers } = stubHarness();
		registerCanvasIdBindingHooks(harness);
		assert.ok(handlers.has("after_tool"));
		assert.ok(handlers.has("before_tool"));
		assert.ok(handlers.has("before_request"));
	});

	it("kill switch off（PI_RUNTIME_CANVAS_ID_BINDING=off）→ 零钩子注册，逐字节旧行为（Review Focus #4）", () => {
		resetIdBindingForTest();
		process.env.PI_RUNTIME_CANVAS_ID_BINDING = "off";
		try {
			const { harness, handlers } = stubHarness();
			registerCanvasIdBindingHooks(harness);
			assert.equal(handlers.size, 0, "off 时不得注册任何钩子");
		} finally {
			delete process.env.PI_RUNTIME_CANVAS_ID_BINDING;
		}
	});

	it("after_tool：成功 upsert 记录 → before_tool 重写返回 {args}；isError upsert 不记录", async () => {
		resetIdBindingForTest();
		const { harness, handlers } = stubHarness();
		registerCanvasIdBindingHooks(harness);
		const afterTool = handlers.get("after_tool")!;
		const beforeTool = handlers.get("before_tool")!;

		// 成功 upsert：捕获
		await afterTool({
			runId: "r9",
			toolName: "upsert_media_node",
			isError: false,
			content: upsertContent("image-9"),
		} as never);
		const rewritten = (await beforeTool({
			runId: "r9",
			toolName: "propose_generation",
			args: { node_id: "image-old" },
		} as never)) as { args?: Record<string, unknown> };
		assert.deepEqual(rewritten, { args: { node_id: "image-9" } });

		// 失败 upsert：不捕获（新 run r10 保持窗口未开）
		await afterTool({
			runId: "r10",
			toolName: "upsert_media_node",
			isError: true,
			content: upsertContent("image-x"),
		} as never);
		assert.deepEqual(await beforeTool({ runId: "r10", toolName: "propose_generation", args: { node_id: "old" } } as never), undefined);
	});

	it("before_request 关窗：同 runId 下一批消息恢复旧路径", async () => {
		resetIdBindingForTest();
		const { harness, handlers } = stubHarness();
		registerCanvasIdBindingHooks(harness);
		const afterTool = handlers.get("after_tool")!;
		const beforeTool = handlers.get("before_tool")!;
		const beforeRequest = handlers.get("before_request")!;

		await afterTool({ runId: "r11", toolName: "upsert_media_node", isError: false, content: upsertContent("image-11") } as never);
		await beforeRequest({ runId: "r11" } as never);
		assert.deepEqual(
			await beforeTool({ runId: "r11", toolName: "propose_generation", args: { node_id: "image-old" } } as never),
			undefined,
			"关窗后必须放行（合法用户点名旧节点）",
		);
	});

	it("捕获钩子返回 undefined（不 patch content，不干扰既有截断链）", async () => {
		resetIdBindingForTest();
		const { harness, handlers } = stubHarness();
		registerCanvasIdBindingHooks(harness);
		const out = await handlers.get("after_tool")!({
			runId: "r12",
			toolName: "upsert_media_node",
			isError: false,
			content: upsertContent("image-12"),
		} as never);
		assert.equal(out, undefined);
	});

	it("终审 I1：rewrite/block 落 console.warn 观测（含 runId/toolName/from→to/reason），返回值不变", async () => {
		resetIdBindingForTest();
		const { harness, handlers } = stubHarness();
		registerCanvasIdBindingHooks(harness);
		const beforeTool = handlers.get("before_tool")!;
		const warns: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...parts: unknown[]) => {
			warns.push(parts.map(String).join(" "));
		};
		try {
			// rewrite 分支：观测触发且 {args} 返回值逐字节不变
			recordUpsertedNode("r13", upsertContent("image-13"));
			const rewritten = (await beforeTool({
				runId: "r13",
				toolName: "propose_generation",
				args: { node_id: "image-old" },
			} as never)) as { args?: Record<string, unknown> };
			assert.deepEqual(rewritten, { args: { node_id: "image-13" } });
			assert.equal(warns.length, 1);
			assert.ok(warns[0].startsWith("[pi-runtime] canvas-id-binding rewrite:"));
			assert.ok(warns[0].includes("runId=r13") && warns[0].includes("toolName=propose_generation"));
			assert.ok(warns[0].includes("image-old") && warns[0].includes("→ image-13"));

			// block 分支（多 upsert 无法消歧）：观测触发且 block 返回值不变
			recordUpsertedNode("r14", upsertContent("image-a"));
			recordUpsertedNode("r14", upsertContent("image-b"));
			const blocked = (await beforeTool({
				runId: "r14",
				toolName: "set_node_generation_params",
				args: { node_id: "image-a" },
			} as never)) as { block?: { reason: string } };
			assert.ok(blocked?.block?.reason);
			assert.equal(warns.length, 2);
			assert.ok(warns[1].startsWith("[pi-runtime] canvas-id-binding block:"));
			assert.ok(warns[1].includes("runId=r14") && warns[1].includes("reason="));
		} finally {
			console.warn = originalWarn;
			resetIdBindingForTest();
		}
	});
});

// ── A3 改写留痕（2026-11-02 老黄牛死循环护栏，RCA v2 §4-A3 / 根因 R1）─────────
describe("canvas-id-binding: A3 改写留痕（rewrite 必须模型可见）", () => {
	function stubHarness() {
		const handlers = new Map<string, (event: never) => Promise<unknown>>();
		const harness = {
			hooks: {
				on: (name: string, fn: never) => {
					handlers.set(name, fn as never);
				},
			},
		} as unknown as AgentHarness<LnkpiToolContext>;
		return { harness, handlers };
	}

	it("rewrite 后同 callId 结算 → content 尾部追加纠偏说明（含旧 id 与新 id）", async () => {
		resetIdBindingForTest();
		resetIdBindingRewritesForTest();
		const { harness, handlers } = stubHarness();
		registerCanvasIdBindingHooks(harness);
		const afterTool = handlers.get("after_tool")!;
		const beforeTool = handlers.get("before_tool")!;

		await afterTool({
			runId: "rA3",
			toolName: "upsert_media_node",
			isError: false,
			content: upsertContent("image-new"),
		} as never);
		const rewritten = (await beforeTool({
			runId: "rA3",
			toolCallId: "callA3",
			toolName: "propose_generation",
			args: { node_id: "image-old" },
		} as never)) as { args?: Record<string, unknown> };
		assert.deepEqual(rewritten, { args: { node_id: "image-new" } });

		const patched = (await afterTool({
			runId: "rA3",
			toolCallId: "callA3",
			toolName: "propose_generation",
			isError: false,
			args: { node_id: "image-new" },
			content: [{ type: "text", text: '{"ok":true}' }],
		} as never)) as { content: Array<{ type: string; text: string }> } | undefined;
		assert.ok(patched, "改写过的调用结算必须带留痕 patch");
		const trace = patched.content.at(-1);
		assert.ok(trace?.text.includes("image-old") && trace?.text.includes("image-new"), `留痕须含新旧 id：${trace?.text}`);
		assert.ok(trace?.text.includes("自动纠偏") && trace?.text.includes("不要对它重复提议"));
	});

	it("留痕一次性：取后即删，同 callId 再结算不重复追加", async () => {
		resetIdBindingForTest();
		resetIdBindingRewritesForTest();
		const { harness, handlers } = stubHarness();
		registerCanvasIdBindingHooks(harness);
		const afterTool = handlers.get("after_tool")!;
		const beforeTool = handlers.get("before_tool")!;
		await afterTool({ runId: "rA4", toolName: "upsert_media_node", isError: false, content: upsertContent("image-new") } as never);
		await beforeTool({ runId: "rA4", toolCallId: "callA4", toolName: "propose_generation", args: { node_id: "image-old" } } as never);
		const event = {
			runId: "rA4",
			toolCallId: "callA4",
			toolName: "propose_generation",
			isError: false,
			args: { node_id: "image-new" },
			content: [{ type: "text", text: "{}" }],
		} as never;
		assert.ok(await afterTool(event));
		assert.equal(await afterTool(event), undefined, "第二次结算不得再追加");
	});

	it("无改写的结算 → 逐字节旧行为（return undefined）", async () => {
		resetIdBindingForTest();
		resetIdBindingRewritesForTest();
		const { harness, handlers } = stubHarness();
		registerCanvasIdBindingHooks(harness);
		const out = await handlers.get("after_tool")!({
			runId: "rA5",
			toolCallId: "callA5",
			toolName: "propose_generation",
			isError: false,
			args: { node_id: "n1" },
			content: [{ type: "text", text: "{}" }],
		} as never);
		assert.equal(out, undefined);
	});
});

// ── 2026-11-07 跨轮文本写入纠偏（生产事故 cmw56hqit00nck801povzca3e）─────────
describe("canvas-id-binding: 跨轮 set_node_text 纠偏（新建文本节点内容错绑根治）", () => {
	/** 模拟 Nest upsert-media-node(target_type=text) 的真实返回形态（含 add_node actions）。 */
	function textUpsertContent(nodeId: string) {
		return [
			{
				type: "text",
				text: JSON.stringify({
					ok: true,
					data: {
						nodeId,
						actions: [
							{
								type: "add_node",
								payload: {
									id: nodeId,
									nodeType: "text",
									data: { manifestKey: "upsert_media_text", status: "draft" },
								},
							},
						],
					},
				}),
			},
		];
	}

	function mediaUpsertContent(nodeId: string) {
		return [
			{
				type: "text",
				text: JSON.stringify({
					ok: true,
					data: {
						nodeId,
						actions: [
							{
								type: "add_node",
								payload: {
									id: nodeId,
									nodeType: "image",
									data: { manifestKey: "upsert_media_image", status: "draft" },
								},
							},
						],
					},
				}),
			},
		];
	}

	it("事故形态：upsert 后跨一次请求，set_node_text(content, 旧id) → rewrite 到新建节点", () => {
		resetIdBindingForTest();
		recordUpsertedNode("tx1", textUpsertContent("text-1794018409058-4"));
		// 生产 executionEvents messageIndex 6 → 7：中间的 before_request 只消耗 TTL，不关窗
		closeBindingWindow("tx1");
		assert.deepEqual(
			decideBinding(
				"set_node_text",
				{ node_id: "text-1794017787677-3", content: "<!DOCTYPE html>…", format: "html" },
				"tx1",
			),
			{ kind: "rewrite", nodeId: "text-1794018409058-4" },
		);
	});

	it("再跨一次请求即关窗：合法提名旧节点不再被误重写（spec「不按 runId 作用域」裁决）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("tx2", textUpsertContent("text-new"));
		closeBindingWindow("tx2");
		closeBindingWindow("tx2");
		assert.deepEqual(decideBinding("set_node_text", { node_id: "text-old", content: "c" }, "tx2"), {
			kind: "passthrough",
		});
	});

	it("prompt-only 不介入；媒体节点 upsert 不开窗（不误伤合法挂参）", () => {
		resetIdBindingForTest();
		recordUpsertedNode("tx3", textUpsertContent("text-new"));
		assert.deepEqual(decideBinding("set_node_text", { node_id: "text-old", prompt: "标题" }, "tx3"), {
			kind: "passthrough",
		});
		resetIdBindingForTest();
		recordUpsertedNode("tx3", mediaUpsertContent("image-new"));
		assert.deepEqual(decideBinding("set_node_text", { node_id: "text-old", content: "c" }, "tx3"), {
			kind: "passthrough",
		});
	});

	it("node_id 已等于新建节点 → passthrough；多个新建文本节点 → fail-closed block", () => {
		resetIdBindingForTest();
		recordUpsertedNode("tx4", textUpsertContent("text-new"));
		assert.deepEqual(decideBinding("set_node_text", { node_id: "text-new", content: "c" }, "tx4"), {
			kind: "passthrough",
		});
		recordUpsertedNode("tx4", textUpsertContent("text-new2"));
		const d = decideBinding("set_node_text", { node_id: "text-old", content: "c" }, "tx4");
		assert.equal(d.kind, "block");
		assert.ok(d.kind === "block" && d.reason.includes("text-new") && d.reason.includes("text-new2"));
	});

	it("端到端钩子：开窗 → before_request → 重写 {args}，结算追加 A3 留痕，且只纠偏一次", async () => {
		resetIdBindingForTest();
		resetIdBindingRewritesForTest();
		const handlers = new Map<string, (event: never) => Promise<unknown>>();
		const harness = {
			hooks: { on: (name: string, fn: never) => handlers.set(name, fn as never) },
		} as unknown as AgentHarness<LnkpiToolContext>;
		registerCanvasIdBindingHooks(harness);
		const afterTool = handlers.get("after_tool")!;
		const beforeTool = handlers.get("before_tool")!;
		const beforeRequest = handlers.get("before_request")!;

		await afterTool({
			runId: "tx5",
			toolName: "upsert_media_node",
			isError: false,
			content: textUpsertContent("text-5"),
		} as never);
		await beforeRequest({ runId: "tx5" } as never);
		const rewritten = (await beforeTool({
			runId: "tx5",
			toolCallId: "call5",
			toolName: "set_node_text",
			args: { node_id: "text-old", content: "<html/>" },
		} as never)) as { args?: Record<string, unknown> };
		assert.deepEqual(rewritten, { args: { node_id: "text-5", content: "<html/>" } });

		// A3 留痕：模型可见「节点定位已由平台自动纠偏」
		const settled = (await afterTool({
			runId: "tx5",
			toolCallId: "call5",
			toolName: "set_node_text",
			isError: false,
			content: [{ type: "text", text: "{}" }],
		} as never)) as { content: { type: string; text: string }[] };
		assert.ok(settled?.content?.some((c) => c.text.includes("text-5") && c.text.includes("text-old")));

		// 窗口一次性：同 run 后续 content 写入不再纠偏
		assert.equal(
			await beforeTool({
				runId: "tx5",
				toolName: "set_node_text",
				args: { node_id: "text-old", content: "again" },
			} as never),
			undefined,
		);
	});
});
