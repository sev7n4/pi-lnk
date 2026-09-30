import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PendingToolRegistry } from "./pending-registry.js";

describe("PendingToolRegistry", () => {
	it("answer resolves waitForUser with answers", async () => {
		const reg = new PendingToolRegistry();
		const p = reg.waitForUser("s1", "c1", "ask_user", 60_000);
		const r = reg.answer("s1", "c1", { style: ["watercolor"] });
		assert.deepEqual(r, { ok: true, deduped: false });
		assert.deepEqual(await p, { status: "answered", answers: { style: ["watercolor"] } });
	});

	it("timeout resolves with partial answers (not reject)", async () => {
		const reg = new PendingToolRegistry();
		const p = reg.waitForUser("s1", "c1", "ask_user", 60_000);
		reg.answer("s1", "c1", { style: ["ink"] }).ok; // 答了一题但 callId 仍 pending？否——answer 即 resolve。
		// 部分作答的正确模拟：waitForUser 期间不 answer，timer 到点 → 已答为空。
		// 部分作答路径由 ask_user 工具层组装（Task 2），registry 只保证 timeout 携带 answered-so-far。
		const partialReg = new PendingToolRegistry();
		const pp = partialReg.waitForUser("s2", "c2", "ask_user", 10);
		const res = await pp;
		assert.equal(res.status, "timeout");
		assert.deepEqual((res as { answers: Record<string, string[]> }).answers, {});
		assert.equal((res as { partial: boolean }).partial, false);
		await p; // 上面已 resolve，防 unhandled
	});

	it("部分作答后超时：timeout 携带已答内容且 partial=true", async () => {
		const reg = new PendingToolRegistry();
		const p = reg.waitForUser("s3", "c3", "ask_user", 30);
		// 模拟「记下第一题答案但不提交」：registry 暴露 recordPartial（见实现）供工具层暂存
		reg.recordPartial("s3", "c3", { style: ["ink"] });
		const res = await p;
		assert.equal(res.status, "timeout");
		assert.deepEqual((res as { answers: Record<string, string[]> }).answers, { style: ["ink"] });
		assert.equal((res as { partial: boolean }).partial, true);
	});

	it("幂等：未知 callId / 重复 answer 返回 deduped=true，不抛错", () => {
		const reg = new PendingToolRegistry();
		assert.deepEqual(reg.answer("sx", "ghost", { a: ["b"] }), { ok: true, deduped: true });
		const reg2 = new PendingToolRegistry();
		void reg2.waitForUser("s", "c", "ask_user", 60_000);
		assert.deepEqual(reg2.answer("s", "c", { a: ["1"] }), { ok: true, deduped: false });
		assert.deepEqual(reg2.answer("s", "c", { a: ["2"] }), { ok: true, deduped: true }); // 已 resolve → deduped
	});

	it("abortAll resolves 所有 pending 为 aborted", async () => {
		const reg = new PendingToolRegistry();
		const p1 = reg.waitForUser("s", "c1", "ask_user", 60_000);
		const p2 = reg.waitForUser("s", "c2", "propose_generation", 60_000);
		assert.equal(reg.abortAll("s"), 2);
		assert.deepEqual(await p1, { status: "aborted" });
		assert.deepEqual(await p2, { status: "aborted" });
		assert.equal(reg.hasPending("s"), false);
	});

	it("cancel 清理条目不 resolve 值语义（供 propose 确认后收尾）", async () => {
		const reg = new PendingToolRegistry();
		const p = reg.waitForUser("s", "c", "propose_generation", 60_000);
		reg.cancel("s", "c");
		assert.equal(reg.hasPending("s"), false);
		assert.deepEqual(await p, { status: "aborted" }); // cancel 以 aborted resolve（等待方用 race 不会消费它）
		assert.equal(reg.abortAll("s"), 0); // timer 已清，不再二次触发
	});

	it("pendingInfo 返回当前 pending（多入口防御性取首个）", () => {
		const reg = new PendingToolRegistry();
		assert.equal(reg.pendingInfo("s"), null);
		void reg.waitForUser("s", "c9", "ask_user", 60_000);
		assert.deepEqual(reg.pendingInfo("s"), { callId: "c9", toolName: "ask_user" });
		reg.abortAll("s"); // 收尾：settle 残留 timer，免拖住 node --test 进程 60s
	});

	it("同 callId 重复 waitForUser 抛错（串行 loop 下不该发生，fail loud）", () => {
		const reg = new PendingToolRegistry();
		void reg.waitForUser("s", "c", "ask_user", 60_000);
		assert.throws(() => reg.waitForUser("s", "c", "ask_user", 60_000), /duplicate pending/i);
		reg.abortAll("s"); // 收尾：settle 残留 timer，免拖住 node --test 进程 60s
	});
});
