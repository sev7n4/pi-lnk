/**
 * B-5 HITL Gate 状态（roadmap D3：确认权收归 harness，不让模型自批自审）。
 * 语义：propose 与 run 必须隔着至少一次真实用户轮次；同轮 propose→run 一律拦截。
 * 跨轮校验交给画布 SSOT（checkGenerationGate 的 get-node 分支），本 store 只管「同轮自批」。
 * B4 每轮 deleteSession 重建 → resetSession 清态，不影响跨轮放行逻辑。
 */
export class GenerationGateStore {
	private readonly proposals = new Map<string, Map<string, number>>();
	private readonly turns = new Map<string, number>();
	private readonly runs = new Map<string, Map<string, number>>(); // 会话 → 节点 → 已放行 run 次数（V-γ）

	/** propose_generation 成功后由 after_tool hook 调用，记录 {turn}。 */
	markProposed(sessionId: string, nodeId: string): void {
		const turn = this.turns.get(sessionId) ?? 0;
		const map = this.proposals.get(sessionId) ?? new Map<string, number>();
		map.set(nodeId, turn);
		this.proposals.set(sessionId, map);
	}

	/** 仅当该节点的 propose 发生在「当前用户轮」内返回 true（跨轮后放行 → 交给画布 SSOT 校验）。 */
	wasProposedThisTurn(sessionId: string, nodeId: string): boolean {
		const turn = this.turns.get(sessionId) ?? 0;
		return this.proposals.get(sessionId)?.get(nodeId) === turn;
	}

	/** 每次用户 prompt 进入时 turn +1（SessionManager.prompt 调用）。 */
	bumpUserTurn(sessionId: string): void {
		this.turns.set(sessionId, (this.turns.get(sessionId) ?? 0) + 1);
	}

	/** V-γ：该会话该节点已放行的 run 次数（0/1/2）。 */
	runCount(sessionId: string, nodeId: string): number {
		return this.runs.get(sessionId)?.get(nodeId) ?? 0;
	}

	/** V-γ：仅在 checkGenerationGate 的两个放行分支调用（放行才消费预算）；调用方绝不可调。 */
	markRun(sessionId: string, nodeId: string): void {
		const map = this.runs.get(sessionId) ?? new Map<string, number>();
		map.set(nodeId, (map.get(nodeId) ?? 0) + 1);
		this.runs.set(sessionId, map);
	}

	/** 会话重建（create）/删除（remove）时清空该会话状态。 */
	resetSession(sessionId: string): void {
		this.proposals.delete(sessionId);
		this.turns.delete(sessionId);
		this.runs.delete(sessionId);
	}
}

export const GATED_TOOLS: ReadonlySet<string> = new Set([
	"run_image_generation",
	"run_video_generation",
	"run_text_generation",
	"run_prompt_generation",
	"run_audio_generation",
]);

export interface GateCheckResult {
	allowed: boolean;
	reason?: string;
	/** true = 本次放行走的是 V-γ 重试路径（供 index.ts 打 kind="retry"）。 */
	retry?: boolean;
}

interface GateNode {
	data?: { status?: unknown } | undefined;
}

function extractNodeStatus(node: unknown): string | undefined {
	const d = (node as GateNode | null | undefined)?.data;
	return d && typeof d === "object" && typeof d.status === "string" ? d.status : undefined;
}

/**
 * B-5 HITL Gate（roadmap D3）：run_* 生成必须「画布节点处于 pending_confirm 且非本轮自批」。
 * 双重校验：① 同轮 propose→run 内存拦截（GenerationGateStore）；② 画布 SSOT
 * （get-node → node.data.status，跨轮/跨会话重建均成立）。
 * V-γ 重试预算：用户确认后首次 run 走 ①②；第 2 次直接放行（retry=true，用户意图已表达）；
 * 第 3 次拦截转 ask_user / propose_generation。预算只在下方两个放行分支消费（markRun），
 * 被拦/fail-closed 分支零消费；非 GATED 工具在最前早返回，永不触碰预算。
 * 任一校验失败/异常 → fail-closed（block），绝不放行。
 */
export async function checkGenerationGate(
	store: GenerationGateStore,
	client: { post(path: string, body: unknown): Promise<unknown> },
	sessionId: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<GateCheckResult> {
	if (!GATED_TOOLS.has(toolName)) return { allowed: true };
	const nodeId = typeof args.node_id === "string" ? args.node_id : "";
	if (!nodeId) {
		return { allowed: false, reason: "run_* 需要 node_id（从画布摘要解析，不要用标题文本猜 id）" };
	}
	const runs = store.runCount(sessionId, nodeId);
	if (runs >= 2) {
		return {
			allowed: false,
			reason: `节点 ${nodeId} 的重试预算已尽（已尝试 ${runs} 次）；请用 ask_user 向用户说明自评结论与可选方向，或先 propose_generation 重新征得确认`,
		};
	}
	if (runs === 1) {
		store.markRun(sessionId, nodeId); // 放行才消费：1 → 2
		return { allowed: true, retry: true }; // V-γ：用户首次确认已表达该节点生成意图
	}
	// runs === 0：走既有双重校验（同轮自批 + SSOT pending_confirm）
	if (store.wasProposedThisTurn(sessionId, nodeId)) {
		return {
			allowed: false,
			reason: "本轮刚调用过 propose_generation，必须等待用户明确确认（下一条用户消息）后才能执行生成；请先向用户说明将生成什么并等待确认",
		};
	}
	try {
		const node = await client.post("/agent/internal/get-node", { sessionId, nodeId });
		const status = extractNodeStatus(node);
		if (status !== "pending_confirm") {
			return {
				allowed: false,
				reason: `节点 ${nodeId} 不在待确认状态（当前 ${status ?? "unknown"}）；须先用 propose_generation 提议并等用户确认，禁止未经确认直接生成`,
			};
		}
		store.markRun(sessionId, nodeId); // 放行才消费：0 → 1
		return { allowed: true };
	} catch {
		return { allowed: false, reason: "生成前置校验暂时不可用（fail-closed），请稍后重试" };
	}
}
