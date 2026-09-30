/**
 * PendingToolRegistry（spec 2026-09-30 §4.1/§4.4）：阻塞式确认类工具的等待注册表。
 *
 * 键 = 画布会话 id（tc.sessionId，工具域一致）：工具只有 toolContext.sessionId（画布 id），
 * abort 联动（session-manager）与 /answers 端点（index 侧）经 entry.canvasSessionId /
 * getCanvasSessionId 换算到本键，pi-runtime 内不做二次解析。
 * 语义铁律（B-4）：**resolve 不 reject** —— 超时/中止一律以带 status 的正常值交还，
 * 模型看到的是工具结果而非异常；超时携带 answered-so-far（partial 语义）。
 */
export type PendingResolution =
	| { status: "answered"; answers: Record<string, string[]> }
	| { status: "timeout"; answers: Record<string, string[]>; partial: boolean }
	| { status: "aborted" };

export interface PendingInfo {
	callId: string;
	toolName: string;
}

interface PendingEntry {
	toolName: string;
	resolve: (r: PendingResolution) => void;
	timer: NodeJS.Timeout;
	/** 工具层在用户逐题作答（未提交）期间暂存的答案；超时时作为 partial 交还。 */
	partial: Record<string, string[]>;
	settled: boolean;
}

export class PendingToolRegistry {
	private readonly entries = new Map<string, Map<string, PendingEntry>>();

	waitForUser(sessionId: string, callId: string, toolName: string, timeoutMs: number): Promise<PendingResolution> {
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
					resolve(r);
				},
				timer: undefined as never,
				partial: {},
				settled: false,
			};
			entry.timer = setTimeout(() => {
				entry.resolve({ status: "timeout", answers: { ...entry.partial }, partial: Object.keys(entry.partial).length > 0 });
			}, timeoutMs);
			// 不 unref：unref 后唯一 pending 工作是该 timer 时事件循环直接 resolve，
			// waitForUser 的 promise 永不 settle（node:test 实测 ERR_TEST_FAILURE）。
			// 泄漏防护已由 settle 路径 clearTimeout + session 关闭 abortAll 覆盖。
			if (!byCall) this.entries.set(sessionId, new Map([[callId, entry]]));
			else byCall.set(callId, entry);
		});
	}

	/** 幂等：未知 callId / 已 settle 一律 {ok:true, deduped:true}（回答端点重试安全，spec §6.2）。 */
	answer(sessionId: string, callId: string, answers: Record<string, string[]>): { ok: true; deduped: boolean } {
		const entry = this.entries.get(sessionId)?.get(callId);
		if (!entry) return { ok: true, deduped: true };
		entry.resolve({ status: "answered", answers });
		return { ok: true, deduped: false };
	}

	/** 工具层逐题暂存（未提交）；超时时随 timeout resolution 交还（Review Focus 2）。 */
	recordPartial(sessionId: string, callId: string, answers: Record<string, string[]>): void {
		const entry = this.entries.get(sessionId)?.get(callId);
		if (!entry) return;
		entry.partial = { ...entry.partial, ...answers };
	}

	/** propose 确认轮询收尾：清条目清 timer，等待方（Promise.race 另一臂）不消费此 resolve。 */
	cancel(sessionId: string, callId: string): void {
		this.entries.get(sessionId)?.get(callId)?.resolve({ status: "aborted" });
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
