/**
 * 生成等待期 onUpdate 进度 ticker（2026-10-18 上游对齐 vendor onUpdate 通道）。
 *
 * 上游语义（harness/types.ts:83-93 + drive/tools.ts:386-388）：工具经
 * `onUpdate(partial, {checkpoint:true})` 全量快照上报进度 → `tool_update` 事件 →
 * SSE `tool_execution_update`；`checkpoint:true` 顺带把它写成 durable 恢复检查点
 * （中断恢复据此合成工具结果，bash.ts:96-104 同款先例）。宿主的两个实效应：
 *  ① run_* / propose 终态等待期（最长 13min）可能整段无 harness 事件 —— 15min
 *     stall watchdog 只认 harness 事件刷新的进度戳（attachEvents 逐事件刷新
 *     lastProgressAt），ticker 是阻塞期的活性证据；
 *  ② partial 是全量快照语义（非增量 delta），每次都带最新 elapsedSec。
 *
 * generation.ts（run_* HTTP 阻塞期）与 canvas-write.ts（propose 终态轮询期）共用一份，
 * 发射形状必须一致（Nest pi-events 按 details.generating 派生 generation_progress）。
 */
import type { AgentHarnessToolUpdateCallback } from "@earendil-works/pi-agent-core";

/** 发射间隔：30s 一拍——相对 11min 视频阻塞期，stall watchdog（15min）要的是
 *  「还有人在动」的证据而非逐秒进度；checkpoint 持久化频率随之压在每生成 ≤26 次。 */
export const GENERATION_PROGRESS_INTERVAL_MS = 30_000;

/**
 * 启动进度 ticker。
 *
 * @param onUpdate harness 注入的更新回调；缺省（legacy 4 参形态/直测）时不启动，
 *        返回的停表函数为 no-op——调用方无需判空。
 * @param nodeId  进度归属的画布节点 id（Nest 派生 generation_progress 的路由键）。
 * @param intervalMs 发射间隔（测试用小值覆盖）。
 * @returns 停表函数（重复调用无害）。
 */
export function startGenerationProgressTicker(
	onUpdate: AgentHarnessToolUpdateCallback<unknown> | undefined,
	nodeId: string,
	intervalMs = GENERATION_PROGRESS_INTERVAL_MS,
): () => void {
	if (!onUpdate) return () => {};
	const startedAt = Date.now();
	const emit = () => {
		try {
			const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
			onUpdate(
				{
					content: [{ type: "text", text: JSON.stringify({ status: "generating", nodeId, elapsedSec }) }],
					details: { ok: true, generating: true, nodeId, elapsedSec },
				},
				{ checkpoint: true },
			);
		} catch {
			/* 进度上报绝不在工具主链路上炸 */
		}
	};
	const timer = setInterval(emit, intervalMs);
	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
	};
}
