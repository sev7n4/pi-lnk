/**
 * PendingToolRegistry（spec 2026-09-30 §4.1/§4.4）：阻塞式确认类工具的等待注册表。
 *
 * 键 = 画布会话 id（tc.sessionId，工具域一致）：工具只有 toolContext.sessionId（画布 id），
 * abort 联动（session-manager）与 /answers 端点（index 侧）经 entry.canvasSessionId /
 * getCanvasSessionId 换算到本键，pi-runtime 内不做二次解析。
 * 语义铁律（B-4）：**resolve 不 reject** —— 超时/中止一律以带 status 的正常值交还，
 * 模型看到的是工具结果而非异常。
 *
 * ⚠️ 刻意不提供「部分答案」语义（2026-10-02 删除旧的 `recordPartial` API）：
 * 交互主路径是**单题即提交 / 多题答满即提交**，「答了几题就发呆到超时」本就是发呆态，
 * 带回半个答案只会让模型基于不完整输入继续推进。超时一律交还空 answers + 逐题 skipped，
 * 让模型明确知道「这轮没拿到任何答案」。
 */
export type PendingResolution =
	| { status: "answered"; answers: Record<string, string[]> }
	| { status: "timeout"; answers: Record<string, string[]> }
	| { status: "aborted" };

export interface PendingInfo {
	callId: string;
	toolName: string;
}

interface PendingEntry {
	toolName: string;
	resolve: (r: PendingResolution) => void;
	timer: NodeJS.Timeout;
	settled: boolean;
}

/**
 * 等待生命周期回调（2026-10-01 阻塞等待可见化）。
 *
 * 存在理由：阻塞式工具（ask_user / propose_generation）的 tool_result 要等**等待结束**
 * 才发出，前端据此推导「等待中」在本语义下永远不成立 —— 等待期间状态行会一直显示
 * 「生成回复中 · Ns」，用户看到的就是「卡死」（生产实证：cmuog0ye90005pp01t1mn1bk9
 * 12:23 轮，被用户判定为卡住）。因此等待**开始**必须由 registry 主动广播，
 * 而不是等 tool_result 反推。
 *
 * 回调是可选的：缺省 no-op，registry 保持纯数据结构（既有单测零改动仍通过）。
 */
export interface PendingHooks {
	/** 等待开始（条目已注册、timer 已武装）→ 广播 status="waiting"。 */
	onWaitStart?: (info: {
		sessionId: string;
		callId: string;
		toolName: string;
		timeoutMs: number;
		meta?: Record<string, unknown>;
	}) => void;
	/** 等待结束（answered / timeout / aborted 任一）→ 广播 status="resolved"。 */
	onSettled?: (info: {
		sessionId: string;
		callId: string;
		toolName: string;
		status: PendingResolution["status"];
	}) => void;
}

export class PendingToolRegistry {
	private readonly entries = new Map<string, Map<string, PendingEntry>>();

	constructor(private readonly hooks: PendingHooks = {}) {}

	/**
	 * @param meta 透传给前端的上下文（如 propose 的 nodeId，供「定位节点」按钮）；
	 *             不进 registry 内部语义，只原样随 waiting 事件下发。
	 */
	waitForUser(
		sessionId: string,
		callId: string,
		toolName: string,
		timeoutMs: number,
		meta?: Record<string, unknown>,
	): Promise<PendingResolution> {
		const byCall = this.entries.get(sessionId);
		if (byCall?.has(callId)) {
			throw new Error(`duplicate pending callId: ${callId} (session ${sessionId})`);
		}
		return new Promise<PendingResolution>((resolve) => {
			const entry: PendingEntry = {
				toolName,
				resolve: (r) => {
					if (entry.settled) return;
					entry.settled = true;
					clearTimeout(entry.timer);
					this.entries.get(sessionId)?.delete(callId);
					// 广播必须在 resolve **之前**：等待方（工具 execute）紧接着会继续跑
					// 并可能立刻发下一批事件，晚一步前端就会多闪一帧「等待你确认」。
					this.hooks.onSettled?.({ sessionId, callId, toolName, status: r.status });
					resolve(r);
				},
			timer: undefined as never,
			settled: false,
		};
		entry.timer = setTimeout(() => {
			// 一律空 answers（无部分作答语义，见文件头）：工具层据此把每道题都标 skipped
			entry.resolve({ status: "timeout", answers: {} });
		}, timeoutMs);
			// 不 unref：unref 后唯一 pending 工作是该 timer 时事件循环直接 resolve，
			// waitForUser 的 promise 永不 settle（node:test 实测 ERR_TEST_FAILURE）。
			// 泄漏防护已由 settle 路径 clearTimeout + session 关闭 abortAll 覆盖。
			if (!byCall) this.entries.set(sessionId, new Map([[callId, entry]]));
			else byCall.set(callId, entry);
			this.hooks.onWaitStart?.({ sessionId, callId, toolName, timeoutMs, meta });
		});
	}

	/** 幂等：未知 callId / 已 settle 一律 {ok:true, deduped:true}（回答端点重试安全，spec §6.2）。 */
	answer(sessionId: string, callId: string, answers: Record<string, string[]>): { ok: true; deduped: boolean } {
		const entry = this.entries.get(sessionId)?.get(callId);
		if (!entry) return { ok: true, deduped: true };
		entry.resolve({ status: "answered", answers });
		return { ok: true, deduped: false };
	}

	/**
	 * 用户**显式拒绝**（2026-10-06）：propose 卡的「取消」走这里，而不是让工具靠 SSOT 轮询推断。
	 *
	 * 与 `answer` 的区别是语义而非实现：`answer` = 用户作答（propose 语义下 = 确认生成），
	 * `decline` = 用户明确说不（propose 语义下 = 取消该节点的生成提议）。
	 * 两者都幂等（未知/已 settle 一律 `{ok:true, deduped:true}`），回答端点重试安全。
	 *
	 * 存在理由（生产事故 cmus6ha64001dk601lzsymqfa 的第二处）：取消此前只写 Nest SSOT，
	 * 工具侧靠「连续两次读到 draft」**推断**用户拒绝 —— 推断链上任何一次 stale 写入都会
	 * 让模型收到错误的用户意图（修 bug 时只能给中性文案「不要断定用户已取消」，
	 * 于是用户真按了取消，模型也不知道）。显式 decline 让「取消」成为确定性事实。
	 */
	decline(sessionId: string, callId: string): { ok: true; deduped: boolean } {
		const entry = this.entries.get(sessionId)?.get(callId);
		if (!entry) return { ok: true, deduped: true };
		entry.resolve({ status: "aborted" });
		return { ok: true, deduped: false };
	}

	/**
	 * propose 确认轮询收尾：清条目清 timer，等待方（Promise.race 另一臂）不消费此 resolve。
	 *
	 * @param resolution 缺省 `aborted`（用户中止/取消）。
	 *        ⚠️ **用户确认成功时必须显式传 `answered`** —— 收尾 cancel 也会触发
	 *        `onSettled` 广播，若一律按 aborted 上报，前端/排障会看到「用户已中止」
	 *        而 tool_result 明明是 confirmed:true（生产实证 2026-10-01：确认成功却
	 *        广播 `waiting_user resolved reason=aborted`）。
	 */
	cancel(sessionId: string, callId: string, resolution: PendingResolution = { status: "aborted" }): void {
		this.entries.get(sessionId)?.get(callId)?.resolve(resolution);
	}

	abortAll(sessionId: string): number {
		const byCall = this.entries.get(sessionId);
		if (!byCall) return 0;
		const n = byCall.size;
		for (const entry of [...byCall.values()]) entry.resolve({ status: "aborted" });
		this.entries.delete(sessionId);
		return n;
	}

	hasPending(sessionId: string): boolean {
		return (this.entries.get(sessionId)?.size ?? 0) > 0;
	}

	pendingInfo(sessionId: string): PendingInfo | null {
		const first = this.entries.get(sessionId)?.entries().next();
		if (!first || first.done) return null;
		return { callId: first.value[0], toolName: first.value[1].toolName };
	}
}
