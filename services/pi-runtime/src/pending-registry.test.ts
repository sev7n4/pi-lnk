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

/**
 * 等待可见化（2026-10-01 生产事故修复）：等待**开始**必须广播，不能靠 tool_result 反推。
 * 阻塞工具的 tool_result 在等待结束才发 → 前端「等待中」状态恒不成立 → 整段等待期
 * 显示「生成回复中 · Ns」，用户判定卡死。
 */
describe("PendingToolRegistry 等待生命周期回调", () => {
	it("waitForUser 同步触发 onWaitStart（含 meta），不会等到 resolve", () => {
		const seen: unknown[] = [];
		const reg = new PendingToolRegistry({
			onWaitStart: (info) => seen.push({ phase: "start", ...info }),
		});
		void reg.waitForUser("s1", "c1", "propose_generation", 60_000, { nodeId: "node-7" });
		// 关键：还没 answer/超时，start 回调已经到了
		assert.deepEqual(seen, [
			{ phase: "start", sessionId: "s1", callId: "c1", toolName: "propose_generation", timeoutMs: 60_000, meta: { nodeId: "node-7" } },
		]);
		reg.abortAll("s1");
	});

	it("settled 回调在 resolve 之前触发，且带结束原因", async () => {
		const seen: string[] = [];
		const reg = new PendingToolRegistry({
			onSettled: (info) => seen.push(info.status),
		});
		let settledBeforePromise = false;
		const p = reg.waitForUser("s", "c", "ask_user", 60_000).then((r) => {
			settledBeforePromise = seen.length === 1;
			return r;
		});
		reg.answer("s", "c", { style: ["ink"] });
		await p;
		assert.deepEqual(seen, ["answered"]);
		assert.equal(settledBeforePromise, true); // 广播先于工具续行，前端不闪帧
	});

	it("超时路径同样走 settled（status=timeout）", async () => {
		const seen: string[] = [];
		const reg = new PendingToolRegistry({ onSettled: (i) => seen.push(i.status) });
		void reg.waitForUser("s", "c", "propose_generation", 5);
		await new Promise((r) => setTimeout(r, 30));
		assert.deepEqual(seen, ["timeout"]);
	});

	it("cancel 默认 aborted；确认成功须显式传 answered（否则前端收到「已中止」误报）", async () => {
		const seen: string[] = [];
		const reg = new PendingToolRegistry({ onSettled: (i) => seen.push(i.status) });
		const p1 = reg.waitForUser("s1", "c1", "propose_generation", 60_000);
		reg.cancel("s1", "c1", { status: "answered", answers: {} }); // propose 确认成功收尾
		assert.deepEqual(await p1, { status: "answered", answers: {} });

		const p2 = reg.waitForUser("s2", "c2", "propose_generation", 60_000);
		reg.cancel("s2", "c2"); // 取消/中止收尾 → 默认 aborted（旧行为逐字节保留）
		assert.deepEqual(await p2, { status: "aborted" });

		assert.deepEqual(seen, ["answered", "aborted"]);
	});

	it("无回调时（缺省构造）行为逐字节不变——既有调用点零改动", async () => {
		const reg = new PendingToolRegistry();
		const p = reg.waitForUser("s", "c", "ask_user", 60_000);
		reg.answer("s", "c", { a: ["1"] });
		assert.deepEqual(await p, { status: "answered", answers: { a: ["1"] } });
	});
});
