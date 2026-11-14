/** C-2b · 画布终态判据（C-1 §8.3 / 路标 §14.2「一套 DSL、两个消费方」的**唯一**判据实现）。
 *
 * eval 侧 `golden-cases.judgeCanvasState` 与生产侧 `acceptance.canvasState` 共用本函数，
 * 杜绝「eval 验证过的判据在生产语义不同 ⇒ eval 绿、生产拦」分裂。
 * 纯函数、零 IO：画布读回失败由调用方归 fail-open/error，绝不在此谎报 0。
 *
 * 位置在 src 根层（与 hook-contract.ts 同级）而非 eval/：生产 tools 层不得反向 import
 * eval 资产（会把整份 L0/L1 case 数据拉进生产依赖图）。
 */
export interface CanvasSnapshot {
	nodeCount: number;
	/** 按 node.type 计数（生产实测枚举 image/text/video；未知类型也计数，键为原值）。 */
	typeCounts: Record<string, number>;
}

export type CanvasNodeType = "image" | "text" | "video";

export interface CanvasCountsExpect {
	nodeCount?: { min?: number; max?: number };
	nodeTypeCounts?: Partial<Record<CanvasNodeType, { min?: number; max?: number }>>;
}

/** 返回证据差文案数组；空数组 = 判据满足。文案同时用于 eval failures 与生产拒绝回执。 */
export function judgeCanvasCounts(canvas: CanvasSnapshot, expect: CanvasCountsExpect): string[] {
	const failures: string[] = [];
	if (expect.nodeCount) {
		const { min, max } = expect.nodeCount;
		if (min !== undefined && canvas.nodeCount < min) {
			failures.push(`画布节点数 ${canvas.nodeCount} 低于下限 ${min}（写入未发生或被回滚）`);
		}
		if (max !== undefined && canvas.nodeCount > max) {
			failures.push(`画布节点数 ${canvas.nodeCount} 超过上限 ${max}（跨 case 污染累积或越权写入）`);
		}
	}
	if (expect.nodeTypeCounts) {
		for (const [type, range] of Object.entries(expect.nodeTypeCounts)) {
			const n = canvas.typeCounts[type] ?? 0;
			if (range?.min !== undefined && n < range.min) {
				failures.push(`画布 ${type} 节点数 ${n} 低于下限 ${range.min}`);
			}
			if (range?.max !== undefined && n > range.max) {
				failures.push(`画布 ${type} 节点数 ${n} 超过上限 ${range.max}`);
			}
		}
	}
	return failures;
}
