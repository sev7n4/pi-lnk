/**
 * L1 行为回归 runner 的**纯逻辑**测试（零 LLM 调用、零 token）。
 *
 * ⭐ 为什么 runner 的判定逻辑要单独测：真正跑模型的那部分受凭据/网络/模型波动影响，
 * 一次跑要花钱且慢。**能被单测覆盖的是「判定与汇总」** ——
 * 而这部分一旦算错，会把「模型行为变坏」误报成「通过」（最贵的假绿）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarize, verdictOf, type CaseResult, type RunSummary } from "./runner.js";
import type { GoldenCase } from "./golden-cases.js";
import type { EvalTranscript } from "./transcript.js";

function transcriptOf(partial: Partial<EvalTranscript>): EvalTranscript {
	return {
		assistantText: "",
		toolNames: [],
		toolCalls: [],
		completed: true,
		errors: [],
		...partial,
	};
}

const CASE: GoldenCase = {
	id: "t1",
	origin: "audit",
	about: "用于测试 runner 判定语义",
	text: "x",
	expectTools: ["propose_generation"],
};

describe("L1 runner · 判定语义", () => {
	it("通过 ⇒ verdict=pass，failures 为空", () => {
		const v = verdictOf(CASE, transcriptOf({ toolNames: ["propose_generation"] }));
		assert.equal(v.verdict, "pass");
		assert.deepEqual(v.failures, []);
	});

	it("失败 ⇒ verdict=fail 且带可定位的说明", () => {
		const v = verdictOf(CASE, transcriptOf({ toolNames: ["upsert_media_node"] }));
		assert.equal(v.verdict, "fail");
		assert.match(v.failures.join("; "), /缺少期望工具/);
		assert.match(v.failures.join("; "), /upsert_media_node/, "失败信息必须含实际调了什么，否则无法定位");
	});

	it("⭐ 运行错误（errors 非空）⇒ verdict=error，与「行为不符」区分", () => {
		// ⭐ 这是最关键的一条：`error` 与 `fail` 必须分开。
		// 混在一起 ⇒ 上游 503 会让报告里一片「模型行为变坏」，
		// 而真实原因只是网络 —— **会让人去改不该改的提示词**。
		const v = verdictOf(CASE, transcriptOf({ completed: false, errors: ["upstream 503"] }));
		assert.equal(v.verdict, "error");
		assert.match(v.failures.join("; "), /upstream 503/, "error 必须保留原始运行错误原文");
	});

	it("error 优先级高于 fail（跑挂了就不该判行为）", () => {
		const v = verdictOf(
			CASE,
			transcriptOf({ toolNames: [], completed: false, errors: ["timeout"] }),
		);
		assert.equal(v.verdict, "error", "有运行错误时不应报行为失败");
		assert.equal(
			v.failures.some((f) => /应该调|缺少期望|被禁止/.test(f)),
			false,
			"⭐ error 不得携带「行为不符」类说明 —— 那会把网络问题误导成提示词问题",
		);
	});
});

describe("L1 runner · 汇总", () => {
	function resultOf(partial: Partial<CaseResult>): CaseResult {
		return {
			caseId: "c",
			verdict: "pass",
			failures: [],
			durationMs: 100,
			toolNames: [],
			...partial,
		};
	}

	it("空结果 ⇒ 报 0/0 而非除零", () => {
		const s = summarize([]);
		assert.equal(s.total, 0);
		assert.equal(s.pass, 0);
		assert.equal(s.passRate, 0, "空集不该是 NaN");
	});

	it("⭐ passRate 只按 pass+fail 算（error 不进分母）", () => {
		// ⭐ 关键判据：把 error 算进分母会让「上游挂了」变成「通过率下降」，
		// 触发「改提示词」的误判。分子分母都只取行为判定。
		const s = summarize([
			resultOf({ caseId: "a", verdict: "pass" }),
			resultOf({ caseId: "b", verdict: "fail", failures: ["x"] }),
			resultOf({ caseId: "c", verdict: "error", failures: ["upstream 503"] }),
		]);
		assert.equal(s.total, 3);
		assert.equal(s.pass, 1);
		assert.equal(s.fail, 1);
		assert.equal(s.error, 1);
		assert.equal(s.passRate, 0.5, "1 pass / 2 (pass+fail) = 0.5");
	});

	it("⭐ 全部 error ⇒ passRate=0 且能被一眼看出是环境问题", () => {
		const s = summarize([
			resultOf({ caseId: "a", verdict: "error", failures: ["upstream 503"] }),
			resultOf({ caseId: "b", verdict: "error", failures: ["upstream 503"] }),
		]);
		assert.equal(s.passRate, 0);
		assert.equal(s.error, 2);
		// ⭐ 报告必须能区分「行为退化」与「环境全挂」
		assert.equal(s.degraded, true, "error 占多数时应标记 degraded（环境问题）");
	});

	it("正常混合（error 少数）⇒ degraded=false", () => {
		const s = summarize([
			resultOf({ caseId: "a", verdict: "pass" }),
			resultOf({ caseId: "b", verdict: "pass" }),
			resultOf({ caseId: "c", verdict: "fail", failures: ["x"] }),
			resultOf({ caseId: "d", verdict: "error", failures: ["timeout"] }),
		]);
		assert.equal(s.degraded, false);
	});

	it("总 token/成本汇总（供 baseline vs candidate 对比）", () => {
		const s = summarize([
			resultOf({ caseId: "a", verdict: "pass", usage: { input: 100, output: 50, total: 150 } }),
			resultOf({ caseId: "b", verdict: "pass", usage: { input: 200, output: 60, total: 260 } }),
		]);
		assert.equal(s.totalTokens, 410);
		assert.equal(s.totalOutputTokens, 110);
	});

	it("failures 汇总保留每条 case 的明细（便于直接贴 issue）", () => {
		const s = summarize([
			resultOf({ caseId: "a", verdict: "fail", failures: ["该调A却调了B"] }),
			resultOf({ caseId: "b", verdict: "fail", failures: ["缺工具 C"] }),
		]);
		assert.equal(s.failures.length, 2);
		assert.match(s.failures[0] ?? "", /a/);
		assert.match(s.failures[1] ?? "", /b/);
	});
});

describe("L1 runner · 报告形态", () => {
	it("renderReport 含关键数字（不只是一句「通过」）", () => {
		const report: RunSummary = summarize([
			{ caseId: "gen-claim-001", verdict: "fail", failures: ["调用了被禁止的工具 [run_image_generation]"], durationMs: 1234, toolNames: ["run_image_generation"] },
			{ caseId: "vision-001", verdict: "pass", failures: [], durationMs: 999, toolNames: [] },
			{ caseId: "x", verdict: "error", failures: ["upstream 503"], durationMs: 100, toolNames: [] },
		]);
		const text = report.report;
		assert.match(text, /1\/2/, "应含 pass/(pass+fail)");
		assert.match(text, /gen-claim-001/, "失败 case 的 id 必须出现在报告里");
		assert.match(text, /run_image_generation/, "失败原因必须出现");
		assert.match(text, /error/);
	});

	it("⭐ degraded 报告顶部有醒目提示（别让人误读成行为退化）", () => {
		const report = summarize([
			{ caseId: "a", verdict: "error", failures: ["upstream 503"], durationMs: 1, toolNames: [] },
			{ caseId: "b", verdict: "error", failures: ["upstream 503"], durationMs: 1, toolNames: [] },
		]);
		assert.match(report.report, /degraded|环境/i, "degraded 必须自报，避免误读成模型行为问题");
	});
});


describe("L1 runner · 端到端（假 pi-runtime，零 LLM 调用）", () => {
	/**
	 * ⭐ 这条锁的是「runner 真能把一条 case 跑完并落到 summary 里」。
	 * driver 的单测只验「一轮的折叠」，golden-cases 的单测只验「判据」，
	 * 两者之间的接线（case → driver → 判定 → summary）没有测试 ⇒ 可能全绿而实际不通。
	 */
	async function withFakeRuntime(
		handler: (text: string) => Array<Record<string, unknown>>,
		fn: (baseUrl: string) => Promise<void>,
	): Promise<void> {
		const { createServer } = await import("node:http");
		// ⚠️⭐ 必须按 sessionId 存，不能用单个变量。
		// 实测踩到：多个 case 复用同一个 lastText 时，events 请求可能读到
		// **上一条 case** 的 text ⇒ verdict 串台（vision-001 读到 gen-claim 的
		// text 而假pass，tool-discovery 读到空串而假 error）。
		// 这类错看着像「判定逻辑有问题」，根因却在夹具 —— 极难定位。
		const textBySession = new Map<string, string>();
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				const path = req.url ?? "";
				if (path.includes("/prompt")) {
					const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
						text?: string;
					};
					const sid = /\/sessions\/([^/]+)\/prompt/.exec(path)?.[1] ?? "?";
					textBySession.set(sid, body.text ?? "");
					res.writeHead(202, { "content-type": "application/json" });
					res.end("{}");
					return;
				}
				if (path.includes("/events")) {
					res.writeHead(200, { "content-type": "text/event-stream" });
					// ⭐ 等 prompt 到达再吐事件：复刻 `from=now` 的真实语义
					//（driver 必须先订阅后 prompt，这里反过来就等prompt）。
					// 不等的话 handler 读到空 text ⇒ 全部落进「上游报错」分支。
					const sid = /\/sessions\/([^/]+)\/events/.exec(path)?.[1] ?? "?";
					const started = Date.now();
					const tick = (): void => {
						const text = textBySession.get(sid);
						if (text !== undefined) {
							for (const ev of handler(text)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
							res.end();
						} else if (Date.now() - started < 5000) {
							setTimeout(tick, 5);
						} else {
							res.end();
						}
					};
					tick();
					return;
				}
				res.writeHead(201, { "content-type": "application/json" });
				res.end(JSON.stringify({ sessionId: "s", provider: "p", model: "m", status: "created" }));
			});
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		try {
			await fn(`http://127.0.0.1:${port}`);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((r) => server.close(() => r()));
		}
	}

	it("工具被正确调用 ⇒ pass；被禁工具被调用 ⇒ fail；errors ⇒ error", async () => {
		// 同一批 case 走三种结局，验证端到端链路 + verdict 分离都成立。
		const { runL1 } = await import("./runner.js");
		await withFakeRuntime(
			(text) => {
				if (text.includes("谢谢")) {
					// 闲聊 case：期望不调任何工具 ⇒ pass
					return [{ type: "agent_end", data: { status: "completed" } }];
				}
				if (text.includes("夜景")) {
					// gen-claim-001：直接调了被禁的 run_image_generation ⇒ fail
					return [
						{ type: "tool_execution_start", data: { toolName: "run_image_generation", toolCallId: "c1" } },
						{ type: "message_end", data: { text: "正在生成" } },
						{ type: "agent_end", data: { status: "completed" } },
					];
				}
				// 其余：模拟上游报错⇒ error
				return [
					{ type: "error", data: { message: "upstream 503" } },
					{ type: "agent_end", data: { status: "completed" } },
				];
			},
			async (baseUrl) => {
				const summary = await runL1({
					baseUrl,
					only: ["tool-discovery-002", "gen-claim-001", "vision-001"],
					intervalMs: 0,
					caseTimeoutMs: 5000,
				});
				assert.equal(summary.total, 3);
				const byId = new Map(summary.results.map((r) => [r.caseId, r]));
				assert.equal(byId.get("tool-discovery-002")?.verdict, "pass", "闲聊 case 应 pass");
				assert.equal(byId.get("gen-claim-001")?.verdict, "fail", "调了被禁工具应 fail");
				assert.match(
					byId.get("gen-claim-001")?.failures.join("; ") ?? "",
					/run_image_generation/,
					"失败信息应含实际调用的被禁工具",
				);
				assert.equal(byId.get("vision-001")?.verdict, "error", "上游报错应 error 而非 fail");
				// ⭐ error 不进分母：pass 1 / (pass+fail 2) = 0.5
				assert.equal(summary.passRate, 0.5);
			},
		);
	});
});
