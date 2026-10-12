/**
 * 信号层 golden cases（P1 Task 9 · spec docs/superpowers/specs/2026-10-12-tool-details-contract-design.md §6）。
 *
 * 4 条 golden case 全部来自已知真实失败（G3），锁「生产病例 → 可判读信号」链路：
 * ① agnes 429 → vendor 分类器 retryable:true → content 退避提示（此前 429 与配额耗尽不可判读）；
 * ② propose_generation 缺 confirmed → partial + 调参重试提示（真实分支产出由 canvas-write.test.ts 锁，
 *    此处锁 listener 对该信号的渲染契约）；
 * ③ get_canvas_summary 局部采样 → coverage 告警（防「局部当全量」静默答错）；
 * ④ errorCode 缺失/unknown → ⭐ retryable 缺省**不写 false**（§5 三态语义回归锁）+ hedge 文本。
 *
 * 零 LLM 依赖（L0 契约层），PR 必跑。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signalFromUpstream } from "./tools/result-signal.js";
import { registerResultSignalListener, type SignalToolEvent } from "./result-signal-wiring.js";
import { Metrics } from "./metrics.js";

class FakeHooks {
	readonly handlers: ((event: SignalToolEvent) => unknown)[] = [];
	on(_name: string, handler: (event: SignalToolEvent) => unknown): () => void {
		this.handlers.push(handler);
		return () => {};
	}
}

const TIERS = new Map<string, string | undefined>([
	["gen_image", "gen"],
	["propose_generation", "write_light"],
	["get_canvas_summary", "read"],
]);

async function dispatch(event: SignalToolEvent, metrics = new Metrics()) {
	const hooks = new FakeHooks();
	registerResultSignalListener(hooks, {}, { tiers: TIERS, metrics });
	const patch = (await hooks.handlers[0](event)) as
		| { content?: { type: string; text?: string }[]; details?: Record<string, unknown> }
		| undefined;
	const text = patch?.content
		?.map((b) => (typeof b.text === "string" ? b.text : ""))
		.join("\n");
	return { patch, text: text ?? "", metrics };
}

describe("golden cases（spec §6）", () => {
	it("① agnes 429 → vendor 分类器 retryable:true → content 退避提示", async () => {
		// 真实病例形态：agnes hub 免费档 429 限流（errorCode 未覆盖 429 分类的时期）。
		const sig = signalFromUpstream({
			ok: false,
			message: "agnes hub: 429 Too Many Requests, please retry later",
		});
		assert.equal(sig.status, "failed");
		assert.equal(sig.retryable, true, "429 限流必须判 true（vendor 分类器唯一接触点）");

		const { text, metrics } = await dispatch({
			toolCallId: "t1",
			toolName: "gen_image",
			args: { prompt: "cat" },
			content: [{ type: "text", text: "generation failed" }],
			details: { ok: false, _signal: sig },
			isError: true,
		});
		assert.ok(text.includes("⚠️[gen]"), `tier 标签应入 content：${text}`);
		assert.ok(text.includes("可退避重试"), `退避提示应入 content：${text}`);
		assert.ok(
			metrics.render(0, "test").includes('pi_runtime_result_signal_total{tier="gen",status="failed"} 1'),
		);
	});

	it("② propose_generation 缺 confirmed → partial + 调参重试提示（confirmed 契约键保留）", async () => {
		// 真实病例：模型把缺 confirmed 当执行成功/盲目 run_*。分支真实产出（含 _signal）
		// 由 canvas-write.test.ts「取消路径」用例锁；此处锁 listener 渲染契约。
		const { patch, text } = await dispatch({
			toolCallId: "t2",
			toolName: "propose_generation",
			args: { node_id: "n1" },
			content: [
				{
					type: "text",
					text: JSON.stringify({ ok: false, confirmed: false, reason: "rejected", message: "未检测到该节点的生成确认" }),
				},
			],
			details: {
				ok: false,
				confirmed: false,
				_signal: { status: "partial", retryable: false, errorCode: "rejected" },
			},
			isError: false,
		});
		assert.ok(patch, "缺 confirmed 必须出 patch");
		assert.ok(text.includes("⚠️[write_light]"), `tier 标签应入 content：${text}`);
		assert.ok(text.includes("调整参数后重试"), `调参重试提示应入 content：${text}`);
		assert.equal(patch?.details?.confirmed, false, "confirmed 是 gate 消费契约，绝不能被 patch 抹掉");
	});

	it("③ get_canvas_summary 局部采样 → coverage 告警入 content（防局部当全量）", async () => {
		const { text } = await dispatch({
			toolCallId: "t3",
			toolName: "get_canvas_summary",
			args: {},
			content: [{ type: "text", text: '{"nodes": 5}' }],
			details: { coverage: "partial", scope: "visible", _signal: { status: "ok", coverage: "partial" } },
			isError: false,
		});
		assert.ok(text.includes("coverage=partial"), `coverage 告警应入 content：${text}`);
		assert.ok(text.includes("局部采样，非全量结果"), `自解释文案应入 content：${text}`);
	});

	it("④ errorCode 缺失/unknown → retryable 缺省不写 false（§5 三态锁）+ hedge 文本", async () => {
		// vendor 分类器对未识别 pattern 返回 false ⇒ 按三态语义一律「未判明」，绝不写 retryable:false。
		const sig = signalFromUpstream({ ok: false, error: "mystery upstream failure" });
		assert.equal(sig.status, "failed");
		assert.equal(
			"retryable" in sig,
			false,
			"⭐ 三态语义回归锁：未判明必须缺省，不得写 false（防回归成保守 false）",
		);

		const { text } = await dispatch({
			toolCallId: "t4",
			toolName: "gen_image",
			args: { prompt: "cat" },
			content: [{ type: "text", text: "generation failed" }],
			details: { ok: false, _signal: sig },
			isError: true,
		});
		assert.ok(text.includes("未判明"), `hedge 文本应入 content：${text}`);
		assert.ok(!text.includes("无意义"), `未判明不得断言同参重试无意义：${text}`);
		assert.ok(
			sig.retryable === undefined,
			"信号对象不得含 retryable:false",
		);
	});
});
