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

	// ========== 多次执行（repeat / 多数表决）==========
	// ⭐ 背景（2026-10-05 A/B 实测）：同一 prompt 同一话术，模型行为本身随机。
	// arrange_nodes 那条 case 现状 description 下触发率 3/11≈27%、
	// 改过description 后 7/10=70% ⇒ **都不是 0%**。
	// ⇒ 单次 pass/fail 表达的是「抽中没抽中」，必须多次取多数。

	it("⭐ 多次执行 ⇒ 报告显式列出各次判定与通过数（不隐藏「3 次过 2 次」）", () => {
		const s = summarize([
			resultOf({
				caseId: "arrange",
				verdict: "pass",
				attempts: 3,
				attemptVerdicts: ["pass", "fail", "pass"],
			}),
		]);
		assert.ok(
			s.report.includes("多数表决明细"),
			"报告必须有一节说明这条是多次执行出来的",
		);
		assert.ok(
			s.report.includes("arrange") && s.report.includes("2/3 通过"),
			`报告应含 caseId 与通过数，实际：\n${s.report}`,
		);
		assert.ok(
			s.report.includes("pass / fail / pass"),
			`报告应含各次判定序列，实际：\n${s.report}`,
		);
	});

	it("⭐ 未设 repeat 的 case 不进「多数表决明细」（避免噪音）", () => {
		const s = summarize([resultOf({ caseId: "single", verdict: "pass" })]);
		assert.ok(
			!s.report.includes("多数表决明细"),
			"单次 case 不该出现在多数表决节",
		);
	});

	it("⭐ 多数表决的失败明细按出现次数排序并标注频次（第一即主因）", () => {
		// 「缺少 arrange_nodes」出现 2 次、「不该调X」1 次 ⇒ 主因应排第一。
		const r = resultOf({
			caseId: "arrange",
			verdict: "fail",
			failures: [
				"缺少期望工具 [arrange_nodes]（2/3 次）",
				"不该调用 [set_node_text]（1/3 次）",
			],
		});
		const s = summarize([r]);
		const line = s.failures.find((f) => f.includes("arrange")) ?? "";
		assert.ok(
			line.indexOf("arrange_nodes") < line.indexOf("set_node_text"),
			`高频原因应排前面（它才是主因），实际：${line}`,
		);
	});

	it("⭐ 平票（pass 与 fail 各半）⇒ 保守判 fail", () => {
		// 不能因为「有一半对」就放过 —— 那会让真实缺陷在抖动掩盖下漏网。
		const s = summarize([
			resultOf({
				caseId: "tie",
				verdict: "fail",
				failures: ["多次执行结果不一致（pass / fail），保守判 fail"],
				attempts: 2,
				attemptVerdicts: ["pass", "fail"],
			}),
		]);
		assert.equal(s.fail, 1, "平票应计入 fail 而不是 pass");
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
					// ⭐ 真实 SSE（见 app.ts `/events`）会**立刻 flush 响应头**；
					// driver 现在把「响应头到达」当作**订阅就绪**信号，据此才发 prompt。
					// 这里不 flush 就会与下面「等 prompt 再吐事件」互相死等，
					// 直到 tick 的 5s 放弃 ⇒ 全部 case 落进超时分支（2026-10-06 实测）。
					res.flushHeaders();
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
		// ⚠️ 只用**非 requiresConfirm** 的 case：阻塞型会被 runner 跳过（durationMs=0），
		// 端到端就验不到「真跑一轮」这条路径了。
		const { runL1 } = await import("./runner.js");
		await withFakeRuntime(
			(text) => {
				if (text.includes("谢谢")) {
					// 闲聊 case：期望不调任何工具 ⇒ pass
					return [{ type: "agent_end", data: { status: "completed" } }];
				}
				if (text.includes("构图")) {
					// vision-002：纯识图问句却建了节点 ⇒ fail（forbid upsert_media_node）
					return [
						{ type: "tool_execution_start", data: { toolName: "upsert_media_node", toolCallId: "c1" } },
						{ type: "message_end", data: { text: "这是一张海报" } },
						{ type: "agent_end", data: { status: "completed" } },
					];
				}
				// 其余（vision-001）：模拟上游报错 ⇒ error
				return [
					{ type: "error", data: { message: "upstream 503" } },
					{ type: "agent_end", data: { status: "completed" } },
				];
			},
			async (baseUrl) => {
				const summary = await runL1({
					baseUrl,
					only: ["tool-discovery-002", "vision-002", "vision-001"],
					intervalMs: 0,
					caseTimeoutMs: 5000,
					// 显式给 staticPrompt：本文件验 driver/判定/汇总，
					// 不该依赖磁盘 registry（跑测试时可能没挂载 prompt-registry）。
					staticPrompt: "test-static-prompt",
					// ⭐ 画布参数：非 requiresConfirm 的 case 必须给，否则 runL1 fail-fast
					userId: "test-user",
					canvasSessionId: "test-canvas",
				});
				assert.equal(summary.total, 3);
				const byId = new Map(summary.results.map((r) => [r.caseId, r]));
				assert.equal(byId.get("tool-discovery-002")?.verdict, "pass", "闲聊 case 应 pass");
				assert.equal(byId.get("vision-002")?.verdict, "fail", "纯识图却建节点应 fail");
				assert.match(
					byId.get("vision-002")?.failures.join("; ") ?? "",
					/upsert_media_node/,
					"失败信息应含实际调用的被禁工具",
				);
				assert.equal(byId.get("vision-001")?.verdict, "error", "上游报错应 error 而非 fail");
				// ⭐ error 不进分母：pass 1 / (pass+fail 2) = 0.5
				assert.equal(summary.passRate, 0.5);
			},
		);
	});
});


describe("L1 runner · skipped 态（requiresConfirm）", () => {
	/**
	 * ⭐ 这组测试锁的是「主动不跑」与「跑了但挂了」的分离。
	 * 混为一谈会让「4 条跑不了」看起来像「4 条环境坏了」——
	 * 而处置完全相反（补 harness vs 查凭据）。
	 */
	it("requiresConfirm 的 case 被跳过，不发起模型调用（durationMs=0）", async () => {
		const { runL1 } = await import("./runner.js");
		const { GOLDEN_CASES } = await import("./golden-cases.js");
		const blocking = GOLDEN_CASES.filter((c) => c.requiresConfirm);
		assert.ok(blocking.length > 0, "预置case 里应有 requiresConfirm 的");
		// 指向一个不存在的端口：若真发起了调用，会得到 error（连接失败）而不是 skipped
		const summary = await runL1({
			baseUrl: "http://127.0.0.1:1",
			only: blocking.map((c) => c.id),
			intervalMs: 0,
			caseTimeoutMs: 3000,
			// 显式给 staticPrompt：本文件验 driver/判定/汇总，
			// 不该依赖磁盘 registry（跑测试时可能没挂载 prompt-registry）。
			staticPrompt: "test-static-prompt",
		});
		assert.equal(summary.skipped, blocking.length, "应全部 skipped");
		for (const r of summary.results) {
			assert.equal(r.verdict, "skipped", `${r.caseId} 应 skipped`);
			assert.equal(r.durationMs, 0, `${r.caseId} 不该真发起调用（durationMs 必须为 0）`);
			assert.match(r.skipReason ?? "", /用户点确认/);
		}
		assert.equal(summary.error, 0, "skipped 不该被算成 error（环境问题）");
	});

	it("⭐ skipped 不进 passRate 分母", () => {
		const summary = summarize([
			{ caseId: "a", verdict: "pass", failures: [], durationMs: 1, toolNames: [] },
			{ caseId: "b", verdict: "pass", failures: [], durationMs: 1, toolNames: [] },
			{ caseId: "c", verdict: "skipped", failures: [], skipReason: "需确认", durationMs: 0, toolNames: [] },
			{ caseId: "d", verdict: "skipped", failures: [], skipReason: "需确认", durationMs: 0, toolNames: [] },
		]);
		// 分母 = pass+fail = 2（不是 4），通过率 1.0
		assert.equal(summary.passRate, 1);
		assert.equal(summary.skipped, 2);
		assert.equal(summary.total, 4);
	});

	it("⭐ skipped 不让报告看起来 degraded（那是环境问题的信号）", () => {
		const summary = summarize([
			{ caseId: "a", verdict: "pass", failures: [], durationMs: 1, toolNames: [] },
			{ caseId: "b", verdict: "skipped", failures: [], skipReason: "需确认", durationMs: 0, toolNames: [] },
			{ caseId: "c", verdict: "skipped", failures: [], skipReason: "需确认", durationMs: 0, toolNames: [] },
		]);
		//error=0 ⇒ 不 degraded：skip 多不代表环境坏
		assert.equal(summary.degraded, false);
		assert.match(summary.report, /skip 2 条/, "报告应单列 skip 节");
		assert.match(summary.report, /需确认/, "应列出每条跳过原因");
	});

	it("报告里 skipped 与 fail/error 混排时仍可区分", () => {
		const summary = summarize([
			{ caseId: "ok", verdict: "pass", failures: [], durationMs: 1, toolNames: [] },
			{ caseId: "bad", verdict: "fail", failures: ["调了被禁工具 X"], durationMs: 1, toolNames: ["X"] },
			{ caseId: "env", verdict: "error", failures: ["upstream 503"], durationMs: 1, toolNames: [] },
			{ caseId: "skip", verdict: "skipped", failures: [], skipReason: "需确认", durationMs: 0, toolNames: [] },
		]);
		assert.match(summary.report, /\[fail\] bad/);
		assert.match(summary.report, /\[error\] env/);
		assert.match(summary.report, /- skip：需确认/);
	});
});


describe("L1 runner · ⭐ 缺画布上下文时 fail-fast（不跑一遍拿超时）", () => {
	/**
	 * 判据来自 2026-10-04 的真实踩坑：缺 `canvasSessionId` 时 driver 回落到
	 * pi 会话键（`eval-xxx`，不存在的 id）⇒ 画布工具全 4xx ⇒ 模型反复重试
	 * ⇒ **每条 case 跑满超时**（实测 7/7 全超时，`get_canvas_summary` 22 次 4xx）。
	 *
	 * ⭐ 为什么必须 fail-fast 而不是「跑完看结果」：
	 * 跑完得到的是「本轮未正常结束」，看起来像**行为不符**（fail），
	 * 而正确处置是「传对参数重跑」。⇒ 两者必须严格区分。
	 */
	it("非 requiresConfirm 的 case 缺 canvasSessionId ⇒ 直接抛错", async () => {
		const { runL1 } = await import("./runner.js");
		await assert.rejects(
			() =>
				runL1({
					baseUrl: "http://127.0.0.1:1",
					only: ["tool-discovery-003"],
					staticPrompt: "x",
					userId: "u",
					// canvasSessionId 故意不给
				}),
			/需要真实画布上下文/,
		);
	});

	it("缺 userId 同样抛错（画布工具要它做归属校验）", async () => {
		const { runL1 } = await import("./runner.js");
		await assert.rejects(
			() =>
				runL1({
					baseUrl: "http://127.0.0.1:1",
					only: ["tool-discovery-003"],
					staticPrompt: "x",
					canvasSessionId: "c",
					// userId 故意不给
				}),
			/需要真实画布上下文/,
		);
	});

	it("⭐ 全是 requiresConfirm 的 case 时不要求画布（它们本来就不跑）", async () => {
		const { runL1 } = await import("./runner.js");
		const { GOLDEN_CASES } = await import("./golden-cases.js");
		const blocking = GOLDEN_CASES.filter((c) => c.requiresConfirm).map((c) => c.id);
		const summary = await runL1({
			baseUrl: "http://127.0.0.1:1", // 不可达，但不该被用到
			only: blocking,
			staticPrompt: "x",
			// 不给画布：合法，因为这些 case 会被skip
		});
		assert.equal(summary.skipped, blocking.length);
	});

	// ========== 画布规模预检（requiresCanvasNodes）==========
	// ⭐ 背景（2026-10-05 实测）：`tool-discovery-001` 话术说「30 个节点」，
	// 在 2 节点画布上 3 次只过 1 次（模型「先查数量、发现对不上就问用户」——
	// 此环境下是**合理行为**）；63 节点画布则 3/3 通过。
	// ⇒ 仅换画布就 1/3 → 3/3 ⇒「模型不行」与「环境不对」在结果里长得一模一样。
	// ⇒ 预检必须在跑之前拦住，否则会误导人去改本来正确的 prompt/工具。

	it("⭐ 没传 nest 但 case 声明了 requiresCanvasNodes ⇒ fail-fast并说清怎么补", async () => {
		// 与本文件其他 runL1 用例一致：用动态 import
		const { runL1 } = await import("./runner.js");
		await assert.rejects(
			() =>
				runL1({
					baseUrl: "http://127.0.0.1:1", // 不该被用到：预检应先抛
					only: ["tool-discovery-001"],
					staticPrompt: "x",
					canvasSessionId: "cs-1",
					userId: "u-1",
				}),
			// ⭐ 报错必须**明确说这是环境问题**，否则人还是会去改提示词
			(err: Error) => {
				assert.match(err.message, /环境问题|画布规模/);
				assert.match(err.message, /NEST_BASE_URL|NEST_SERVICE_TOKEN/);
				return true;
			},
		);
	});

	it("⭐ 探针报 error（如画布不存在）⇒ fail-fast，且区分「环境问题」", async () => {
		const { runL1 } = await import("./runner.js");
		await assert.rejects(
			() =>
				runL1({
					baseUrl: "http://127.0.0.1:1",
					only: ["tool-discovery-001"],
					staticPrompt: "x",
					canvasSessionId: "cs-1",
					userId: "u-1",
					// 地址不可达 ⇒ 探针必然失败
					nest: { baseUrl: "http://127.0.0.1:1/api", token: "t" },
				}),
			(err: Error) => {
				assert.match(err.message, /画布规模预检失败/);
				assert.match(err.message, /不要据此改提示词/);
				return true;
			},
		);
	});
});

describe("L1 runner · ⭐⭐ error（限流）补跑 —— 别让环境废票偷走判据强度", () => {
	/**
	 * 实测（2026-10-06 真模型基线，免费额度）：`tool-discovery-001` 三次 attempt 里
	 * **两次撞 429**。`error` 不参与表决是对的（环境问题不是行为问题），
	 * 但它**占掉票位** ⇒ 「多数表决」静默退化成**一票定生死**，
	 * 而报告上仍写着「3 次」—— 判据强度被偷走却不显形。
	 *
	 * 本组锁两件事：① 补跑能把废票补成真实票；② 废票数如实进报告。
	 */
	const LIMIT_429 = "429 您已达到免费用户的 API 速率限制";

	/**
	 * 假 runtime：**按 prompt 的到达序号**决定吐什么事件。
	 * ⚠️ 必须按 sessionId 门控（同 `withFakeRuntime` 的注释）：
	 * 若只看「有没有收到过 prompt」，本轮的 events 连接会读到**上一轮**的序号。
	 */
	async function withSeqRuntime(
		errorCalls: Set<number>,
		fn: (baseUrl: string) => Promise<void>,
	): Promise<void> {
		const { createServer } = await import("node:http");
		const seqBySession = new Map<string, number>();
		let seq = 0;
		const server = createServer((req, res) => {
			const body: Buffer[] = [];
			req.on("data", (c: Buffer) => body.push(c));
			req.on("end", () => {
				const path = req.url ?? "";
				if (path.includes("/prompt")) {
					const sid = /\/sessions\/([^/]+)\/prompt/.exec(path)?.[1] ?? "?";
					seq++;
					seqBySession.set(sid, seq);
					res.writeHead(202, { "content-type": "application/json" });
					res.end("{}");
					return;
				}
				if (path.includes("/events")) {
					const sid = /\/sessions\/([^/]+)\/events/.exec(path)?.[1] ?? "?";
					res.writeHead(200, { "content-type": "text/event-stream" });
					res.flushHeaders();
					const started = Date.now();
					const tick = (): void => {
						const n = seqBySession.get(sid);
						if (n !== undefined) {
							if (errorCalls.has(n)) {
								res.write(
									`data: ${JSON.stringify({ type: "error", data: { message: LIMIT_429 } })}\n\n`,
								);
								res.write(
									`data: ${JSON.stringify({ type: "agent_end", data: { status: "failed" } })}\n\n`,
								);
							} else {
								res.write(
									`data: ${JSON.stringify({ type: "agent_end", data: { status: "completed" } })}\n\n`,
								);
							}
							res.end();
						} else if (Date.now() - started < 3000) {
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

	const runOpts = (baseUrl: string, errorRetries: number) => ({
		baseUrl,
		// tool-discovery-003：repeat=3、只禁写工具 ⇒ 「不调任何工具」即 pass，判据最干净
		only: ["tool-discovery-003"],
		intervalMs: 0,
		caseTimeoutMs: 5000,
		staticPrompt: "test-static-prompt",
		userId: "test-user",
		canvasSessionId: "test-canvas",
		errorRetries,
	});

	it("⭐ 关闭补跑（errorRetries=0）⇒ 3 次全限流就只能是 error（环境问题，不判 pass/fail）", async () => {
		const { runL1 } = await import("./runner.js");
		await withSeqRuntime(new Set([1, 2, 3]), async (baseUrl) => {
			const s = await runL1(runOpts(baseUrl, 0));
			const r = s.results[0];
			assert.equal(r.verdict, "error", `全限流必须是 error，实际 ${r.verdict}`);
			assert.equal(s.passRate, 0, "error 不进分母 ⇒ passRate 0（不是 NaN）");
		});
	});

	it("⭐⭐ 补跑（errorRetries=2）⇒ 3 次限流被顶掉，拿到真实票并判出结论", async () => {
		const { runL1 } = await import("./runner.js");
		await withSeqRuntime(new Set([1, 2, 3]), async (baseUrl) => {
			const s = await runL1(runOpts(baseUrl, 2));
			const r = s.results[0];
			// 无补跑时这条是 error（上一用例已证）；补跑后应拿到真实票并给出 pass
			assert.equal(r.verdict, "pass", `补跑后应判 pass，实际 ${r.verdict}（${r.attemptVerdicts?.join("/")}）`);
			assert.equal(r.errorAttempts, 3, `应记录 3 次废票，实际 ${r.errorAttempts}`);
			assert.equal(
				r.attempts,
				r.attemptVerdicts?.length,
				"attempts 必须是**真实票数**，不能写 repeat（否则看不出票被顶掉）",
			);
			assert.ok(
				(r.attempts ?? 0) < 3,
				`总尝试上界=repeat+errorRetries=5 ⇒ 3 张废票后最多 2 张真实票，实际 ${r.attempts}`,
			);
			assert.match(
				s.report,
				/环境 error 已补跑、不计票/,
				"报告必须显示废票数 —— 否则「2/3 通过」看不出其实只跑了 2 次真票",
			);
		});
	});

	it("⭐ 废票不污染判定：限流只在部分 attempt 出现时，仍按真实票多数表决", async () => {
		const { runL1 } = await import("./runner.js");
		// 第 2 次限流，其余正常 ⇒ 3 张真实票全 pass，且记 1 次废票
		await withSeqRuntime(new Set([2]), async (baseUrl) => {
			const s = await runL1(runOpts(baseUrl, 2));
			const r = s.results[0];
			assert.equal(r.verdict, "pass");
			assert.equal(r.attempts, 3, "应拿满 3 张真实票");
			assert.equal(r.errorAttempts, 1, "应记录 1 次废票");
			assert.deepEqual(r.attemptVerdicts, ["pass", "pass", "pass"]);
		});
	});
});
