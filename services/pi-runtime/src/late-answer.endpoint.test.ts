/**
 * P1-A（规格 2026-11-01 §4.4）：/late-answer 端点行为测试。
 *
 * 场景 = runtime 重启丢失 registry 条目后 Nest 裁决调用：端点幂等激活会话（create），
 * lateAnswerInject 以 followUp 迟到语境注入。断言注入文本含「迟到」语境铁律关键词
 * （防模型把迟到答案当新指令重复执行——红队 Part E 风险②）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { Metrics } from "./metrics.js";
import { DEFAULT_RUNTIME_CONFIG } from "./runtime-config.js";
import { SessionManager } from "./session-manager.js";

function makeAppWithFollowUpSink(sink: string[]) {
	const factory = (async () => ({
		harness: {
			events: { on: () => () => {} },
			lane: async () => ({
				prompt: async () => ({ ok: true }),
				setThinkingLevel: async () => {},
				followUp: async (text: string) => {
					sink.push(text);
					return { ok: true, value: { entryId: "fake-entry" } };
				},
			}),
			close: async () => {},
		},
	})) as never;
	const manager = new SessionManager([], "", undefined, factory, undefined, undefined, {
		...DEFAULT_RUNTIME_CONFIG,
		dataRoot: mkdtempSync(join(tmpdir(), "late-answer-")),
	});
	const app = buildApp(manager, { metrics: new Metrics(), version: "test" });
	return app;
}

describe("POST /sessions/:sessionId/late-answer（P1-A §4.4）", () => {
	it("参数校验：缺 userId / callId / kind / answers 分别 400", async () => {
		const app = makeAppWithFollowUpSink([]);
		for (const [body, why] of [
			[{ callId: "c1", kind: "answer", answers: {} }, "缺 userId"],
			[{ userId: "u1", kind: "answer", answers: {} }, "缺 callId"],
			[{ userId: "u1", callId: "c1", answers: {} }, "缺 kind"],
			[{ userId: "u1", callId: "c1", kind: "answer" }, "answer 缺 answers"],
		] as const) {
			const res = await app.inject({
				method: "POST",
				url: "/sessions/t1/late-answer",
				payload: body as Record<string, unknown>,
			});
			assert.equal(res.statusCode, 400, why);
		}
	});

	it("重启丢失场景：会话未预建 → 端点内激活并注入迟到语境（answer 分支）", async () => {
		const sink: string[] = [];
		const app = makeAppWithFollowUpSink(sink);
		const res = await app.inject({
			method: "POST",
			url: "/sessions/t1/late-answer",
			payload: {
				userId: "u1",
				callId: "c1",
				toolName: "propose_generation",
				kind: "answer",
				answers: { style: ["watercolor"] },
			},
		});
		assert.equal(res.statusCode, 200);
		assert.deepEqual(res.json(), { queued: true, entryId: "fake-entry" });
		assert.equal(sink.length, 1);
		// 语境铁律（规格 §4.4）：迟到声明 + 防重复执行 + 内容透传
		assert.match(sink[0], /迟到答案/);
		assert.match(sink[0], /不要重复执行/);
		assert.match(sink[0], /style: watercolor/);
		assert.match(sink[0], /propose_generation/);
	});

	it("decline 分支：取消语境（不断定用户已同意），不带 answers", async () => {
		const sink: string[] = [];
		const app = makeAppWithFollowUpSink(sink);
		const res = await app.inject({
			method: "POST",
			url: "/sessions/t2/late-answer",
			payload: {
				userId: "u1",
				callId: "c2",
				toolName: "propose_generation",
				kind: "decline",
				note: "用户在画布留言",
			},
		});
		assert.equal(res.statusCode, 200);
		assert.match(sink[0], /迟到取消/);
		assert.match(sink[0], /不要断定用户已同意/);
		assert.match(sink[0], /用户在画布留言/);
	});

	it("A5 守卫：late 路径全程不触碰 registry（不 resolve 任何等待 promise）", async () => {
		const sink: string[] = [];
		const app = makeAppWithFollowUpSink(sink);
		// 无 registry（deps.registry 缺省）→ 端点仍可用（late 语义不依赖 registry）
		await app.inject({
			method: "POST",
			url: "/sessions/t3/late-answer",
			payload: { userId: "u1", callId: "c3", kind: "answer", answers: {} },
		});
		assert.equal(sink.length, 1);
	});
});
