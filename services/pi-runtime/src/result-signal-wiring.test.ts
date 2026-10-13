/**
 * 信号 listener 接线测试（P1 · spec 2026-10-12-tool-details-contract-design.md §4/§6）。
 *
 * 用 fake hooks 注册器驱动 registerResultSignalListener（真实 AgentHarness 的 hooks
 * 只在集成测试里起）——锁的是接线契约：
 * - kill switch：resultSignals===false → 不注册（vendor 对未注册 hook 零分发的「不注册」语义）；
 * - 注册序：必须排在既有合并 after_tool listener **之后**（HookMap 链式 replace，spec §4）；
 * - registration id："lnkpi.result-signals"（vendor pi.harness.hook span 可识别，§4 handler 容错）；
 * - patch 面：只返回 content/details，绝不返回 isError/usage/terminate（§4 patch 面纪律）；
 * - metrics：observeResultSignal(tier,status) 活性探针 + errorCode=unknown 单独计数（§6）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerResultSignalListener, type SignalHooksRegistrar, type SignalToolEvent } from "./result-signal-wiring.js";
import { Metrics } from "./metrics.js";

type RecordedHandler = (event: SignalToolEvent) => unknown;

class FakeHooks implements SignalHooksRegistrar {
	readonly names: string[] = [];
	readonly ids: (string | undefined)[] = [];
	readonly handlers: RecordedHandler[] = [];
	on(name: string, handler: RecordedHandler, options?: { id?: string }): () => void {
		this.names.push(name);
		this.ids.push(options?.id);
		this.handlers.push(handler);
		return () => {};
	}
}

const TIERS = new Map<string, string | undefined>([
	["gen_image", "gen"],
	["delete_nodes", "destructive"],
	["remove_edges", "destructive"],
]);

function renderHas(metrics: Metrics, needle: string): boolean {
	return metrics.render(0, "test").includes(needle);
}

describe("registerResultSignalListener", () => {
	it("kill switch：resultSignals===false → 不注册任何 hook", () => {
		const hooks = new FakeHooks();
		registerResultSignalListener(hooks, { resultSignals: false }, { tiers: TIERS, metrics: new Metrics() });
		assert.equal(hooks.names.length, 0);
	});

	it("缺省开启 → 注册 after_tool，registration id = lnkpi.result-signals", () => {
		const hooks = new FakeHooks();
		registerResultSignalListener(hooks, {}, { tiers: TIERS, metrics: new Metrics() });
		assert.equal(hooks.names.length, 1);
		assert.equal(hooks.names[0], "after_tool");
		assert.equal(hooks.ids[0], "lnkpi.result-signals");
	});

	it("⭐ 注册序：wiring 是后注册者——调用方必须先注册合并 listener 再调本函数（fake 记录顺序断言）", () => {
		const hooks = new FakeHooks();
		// 先注册合并 after_tool listener（index.ts:89 的既有块），再调本接线。
		hooks.on("after_tool", () => undefined);
		registerResultSignalListener(hooks, {}, { tiers: TIERS, metrics: new Metrics() });
		assert.equal(hooks.names[1], "after_tool");
		assert.ok(hooks.names.indexOf("after_tool", 1) > 0, "信号 listener 必须在合并 listener 之后注册");
	});

	it("异常结果 → 尾部信号行 + details 展开保留 actions（patch 面只含 content/details）", async () => {
		const hooks = new FakeHooks();
		const metrics = new Metrics();
		registerResultSignalListener(hooks, {}, { tiers: TIERS, metrics });
		const patch = (await hooks.handlers[0]({
			toolCallId: "c1",
			toolName: "gen_image",
			args: { prompt: "cat" },
			content: [{ type: "text", text: "boom" }],
			details: {
				ok: false,
				actions: [{ type: "canvas_create_node" }],
				_signal: { status: "failed", retryable: true, errorCode: "rate_limited" },
			},
			isError: true,
		})) as { content?: unknown[]; details?: Record<string, unknown> } | undefined;

		assert.ok(patch, "异常结果必须出 patch");
		const text = (patch.content?.[0] as { text?: string })?.text ?? "";
		assert.ok(text.includes("⚠️[gen] rate_limited"), `退避提示应入 content：${text}`);
		assert.deepEqual(patch.details?.actions, [{ type: "canvas_create_node" }], "actions 绝不能被抹掉");
		// patch 面纪律：只 content/details
		assert.ok(!("isError" in patch), "禁止 patch isError");
		assert.ok(!("terminate" in patch), "禁止 patch terminate");
		assert.ok(!("usage" in patch), "禁止 patch usage");
		// metrics 活性探针
		assert.ok(
			renderHas(metrics, 'pi_runtime_result_signal_total{tier="gen",status="failed"} 1'),
			"observeResultSignal 应按 tier|status 计数",
		);
	});

	it("成功且无告警 → undefined（零注入）且 metrics 仍计 ok（活性探针）", async () => {
		const hooks = new FakeHooks();
		const metrics = new Metrics();
		registerResultSignalListener(hooks, {}, { tiers: TIERS, metrics });
		const patch = await hooks.handlers[0]({
			toolCallId: "t",
			toolName: "gen_image",
			args: {},
			content: [{ type: "text", text: "ok" }],
			details: { ok: true, _signal: { status: "ok" } },
			isError: false,
		});
		assert.equal(patch, undefined);
		assert.ok(renderHas(metrics, 'pi_runtime_result_signal_total{tier="gen",status="ok"} 1'));
	});

	it("对账：delete_nodes 请求 5 生效 3 → 部分生效行入 content；完全生效 → 无注入", async () => {
		const hooks = new FakeHooks();
		registerResultSignalListener(hooks, {}, { tiers: TIERS, metrics: new Metrics() });
		const partial = (await hooks.handlers[0]({
			toolCallId: "t",
			toolName: "delete_nodes",
			args: { node_ids: ["a", "b", "c", "d", "e"] },
			content: [{ type: "text", text: "deleted" }],
			details: { ok: true, affectedCount: 3, _signal: { status: "partial" } },
			isError: false,
		})) as { content?: { text?: string }[] } | undefined;
		assert.ok(partial);
		assert.ok(
			partial.content?.[0].text?.includes("请求 5 项，实际生效 3 项"),
			`对账行应入 content：${JSON.stringify(partial.content)}`,
		);

		const full = await hooks.handlers[0]({
			toolCallId: "t",
			toolName: "delete_nodes",
			args: { node_ids: ["a", "b"] },
			content: [{ type: "text", text: "deleted" }],
			details: { ok: true, affectedCount: 2, _signal: { status: "ok" } },
			isError: false,
		});
		assert.equal(full, undefined, "请求数=生效数 → 零注入");
	});

	it("errorCode=unknown → observeResultSignalUnknown 单独计数（§6 根因修复驱动）", async () => {
		const hooks = new FakeHooks();
		const metrics = new Metrics();
		registerResultSignalListener(hooks, {}, { tiers: TIERS, metrics });
		await hooks.handlers[0]({
			toolCallId: "t",
			toolName: "gen_image",
			args: {},
			content: [{ type: "text", text: "fail" }],
			details: { ok: false, _signal: { status: "failed", errorCode: "unknown" } },
			isError: true,
		});
		assert.ok(renderHas(metrics, 'pi_runtime_result_signal_unknown_total{tool="gen_image"} 1'));
	});

	it("coverage partial（get_canvas_summary）→ coverage 告警行入 content（golden case ③ 接线层）", async () => {
		const hooks = new FakeHooks();
		registerResultSignalListener(hooks, {}, { tiers: TIERS, metrics: new Metrics() });
		const patch = (await hooks.handlers[0]({
			toolCallId: "t",
			toolName: "get_canvas_summary",
			args: {},
			content: [{ type: "text", text: "summary" }],
			details: { coverage: "partial", scope: "visible", _signal: { status: "ok", coverage: "partial" } },
			isError: false,
		})) as { content?: { text?: string }[] } | undefined;
		assert.ok(patch);
		assert.ok(patch.content?.[0].text?.includes("partial"));
	});

	it("契约外工具（无 _signal）→ 零接触：不出 patch 也不计 metrics", async () => {
		const hooks = new FakeHooks();
		const metrics = new Metrics();
		registerResultSignalListener(hooks, {}, { tiers: TIERS, metrics });
		const patch = await hooks.handlers[0]({
			toolCallId: "t",
			toolName: "ask_user",
			args: {},
			content: [{ type: "text", text: "waiting" }],
			details: { some: "detail" },
			isError: false,
		});
		assert.equal(patch, undefined);
		assert.ok(!renderHas(metrics, "pi_runtime_result_signal_total{tier="), "非契约工具不打活性探针");
	});

	it("RB-D4：nest 4xx throw（无 _signal）⇒ 注入 ⚠️ 行 + metrics 计 failed", async () => {
		const hooks = new FakeHooks();
		const metrics = new Metrics();
		registerResultSignalListener(hooks, {}, { tiers: TIERS, metrics });
		const patch = (await hooks.handlers[0]({
			toolCallId: "c9",
			toolName: "apply_sidebar_attachments",
			args: { node_ids: ["n1"] },
			content: [{ type: "text", text: "nest /x http 400: attachments 校验失败" }],
			isError: true,
		})) as { content?: unknown[]; details?: Record<string, unknown> } | undefined;
		assert.ok(patch, "throw 路径必须有 patch");
		assert.ok(JSON.stringify(patch.content).includes("⚠️[unknown]"));
		assert.equal((patch.details?._signal as { errorCode?: string }).errorCode, "invalid_params");
		assert.ok(
			renderHas(metrics, 'pi_runtime_result_signal_total{tier="unknown",status="failed"} 1'),
			"throw 路径合成信号应计 metrics（tier=unknown fallback）",
		);
	});
});
