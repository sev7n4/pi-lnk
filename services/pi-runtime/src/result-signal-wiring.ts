/**
 * 信号 listener 接线（P1 · spec 2026-10-12-tool-details-contract-design.md §4/§6）。
 *
 * 从 index.ts 抽成独立模块的原因（gate/plan-gate-wiring.ts 同款先例）：index.ts 是模块级
 * 单例 + env 依赖装配，测试无法 import 驱动；本函数是唯一接线源，index.ts 与测试共调，
 * 杜绝「测试复制接线」漂移。R3 注册序机检锚定 index.ts 内 `registerResultSignalListener`
 * 调用点（合并 after_tool listener 之后），本模块文件名刻意不含 `result-signal-listener`
 * 字面量——否则顶层 import 会让机检首个命中落在 import 行（恒 FAIL）。
 *
 * 职责：
 * - kill switch（§6）：cfg.resultSignals===false → 不注册，回滚 = 环境变量一行；
 * - 注册序（§4 ⭐）：调用方必须把本函数放在既有合并 after_tool listener **之后**——
 *   HookMap 多 listener 链式 replace，后注册者看到前者的 patch，截断终判依赖最终 content；
 * - registration id（§4 handler 容错）：`lnkpi.result-signals` 使 vendor pi.harness.hook
 *   span 可识别（outcome=failed 由 vendor 原生遥测覆盖，不自建失败计数）；
 * - patch 面纪律（§4）：只返回 content/details，绝不返回 isError/usage/terminate；
 * - 对账（§4 ⭐）：批量写/删工具用 args 请求数 vs details.affectedCount 判部分生效；
 * - metrics（§6）：observeResultSignal 活性探针（含 ok）+ errorCode=unknown 单独计数。
 */
import type { Metrics } from "./metrics.js";
import { appendSignalLine, readSignal, reconcileAffected, signalFromErrorContent, type SignalContentBlock } from "./tools/result-signal-listener.js";

/** after_tool 事件窄面（vendor HookMap 形态子集，测试 fake 与本接线共用）。 */
export interface SignalToolEvent {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	content: SignalContentBlock[];
	details?: unknown;
	isError: boolean;
}

/** after_tool patch 窄面：本 listener 只回 content/details（§4 patch 面纪律）。 */
export type SignalToolPatch =
	| { content?: SignalContentBlock[]; details?: unknown }
	| undefined
	| Promise<{ content?: SignalContentBlock[]; details?: unknown } | undefined>;

/** 真实 AgentHarness["hooks"].on 的结构窄面（测试用 fake 实现，避免 import vendor 类型）。 */
export interface SignalHooksRegistrar {
	on(name: "after_tool", handler: (event: SignalToolEvent) => SignalToolPatch, options?: { id?: string }): () => void;
}

/** 批量写/删工具的 args → 请求数映射（§4 对账判据；单对象工具 1:1 无对账价值不入表）。 */
function requestedCountOf(toolName: string, args: Record<string, unknown>): number | undefined {
	const arrLen = (v: unknown): number | undefined => (Array.isArray(v) ? v.length : undefined);
	switch (toolName) {
		case "delete_nodes":
			return arrLen(args.node_ids);
		case "remove_edges":
			return arrLen(args.edge_ids);
		case "connect_nodes":
			return arrLen(args.edges);
		case "introduce_nodes_to_agent":
			return arrLen(args.node_ids);
		case "duplicate_node": {
			const multi = arrLen(args.node_ids);
			if (multi !== undefined) return multi;
			return typeof args.node_id === "string" ? 1 : undefined;
		}
		case "grid_slice_image":
			return typeof args.cols === "number" && typeof args.rows === "number" ? args.cols * args.rows : undefined;
		default:
			return undefined;
	}
}

/** details.affectedCount 窄读（工具直报，§2.1 护栏：不从 actions 反推）。 */
function affectedCountOf(details: unknown): number | undefined {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const v = (details as Record<string, unknown>).affectedCount;
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function registerResultSignalListener(
	hooks: SignalHooksRegistrar,
	cfg: { resultSignals?: boolean },
	deps: {
		tiers: ReadonlyMap<string, string | undefined>;
		metrics: Pick<Metrics, "observeResultSignal" | "observeResultSignalUnknown">;
	},
): void {
	// kill switch（§6）：off = 不注册——无 hook 即零注入，行为与本功能引入前逐字节一致。
	if (cfg.resultSignals === false) return;
	const { tiers, metrics } = deps;
	hooks.on(
		"after_tool",
		(event) => {
			// RB-D4 throw 路径：details._signal 优先；throw（details=undefined）+ isError 时
			// 从错误文本合成 nest 4xx/5xx 信号——非 nest 错误仍零接触（不打点不注入）。
			const signal =
				readSignal(event.details) ?? (event.isError ? signalFromErrorContent(event.content) : undefined);
			if (!signal) return undefined; // 契约外工具 / 非 nest 错误零接触（不打点不注入）
			// 合成信号预合并进 details（展开保留既有键），下游对账/注入看到同一份 details；
			// details._signal 已存在时不重复合并（readSignal 优先，幂等）。
			const details =
				readSignal(event.details) === undefined
					? {
							...((typeof event.details === "object" && event.details !== null && !Array.isArray(event.details)
								? (event.details as Record<string, unknown>)
								: {}) as Record<string, unknown>),
							_signal: signal,
						}
					: event.details;
			const tier = tiers.get(event.toolName) ?? "unknown";
			metrics.observeResultSignal(tier, signal.status);
			if (signal.errorCode === "unknown") metrics.observeResultSignalUnknown(event.toolName);
			const requested = requestedCountOf(event.toolName, event.args);
			const extra = reconcileAffected(requested, affectedCountOf(details));
			const patch = appendSignalLine(event.toolName, tier, event.isError, event.content, details, extra);
			if (!patch) return undefined;
			// patch 面纪律（§4）：只 content/details。
			return { content: patch.content, details: patch.details };
		},
		{ id: "lnkpi.result-signals" },
	);
}
