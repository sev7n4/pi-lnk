/** 工具装配与降级守卫：NEST env 齐全才启用工具，否则保持纯文本模式。 */
import { NestClient, loadNestConfig } from "./nest-client.js";
import { buildCanvasReadTools, buildCanvasWriteTools, buildUiCommandTools, buildAskUserTools, buildArrangeNodesTools, buildGenerationTools, buildWebTools, buildDeleteNodesTools, buildReadDocumentTools, buildMemoryTools, buildRemoveEdgesTools, buildRenderCanvasViewTools } from "./registry.js";
import type { LnkpiTool } from "./types.js";
import type { Metrics } from "../metrics.js";
import type { PendingToolRegistry } from "../pending-registry.js";

let warned = false;

/** 超时覆盖表（对齐老链路档位）：10s 默认 / 120s grid / 210s image 系 / 690s video 系（B-5）。 */
export const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = {
	"/agent/internal/grid-slice-image": 120_000,
	"/agent/internal/run-image-generation": 210_000,
	"/agent/internal/wait-image-generation": 210_000,
	"/agent/internal/run-text-generation": 210_000,
	"/agent/internal/run-prompt-generation": 210_000,
	"/agent/internal/run-audio-generation": 210_000,
	"/agent/internal/run-video-generation": 690_000,
	"/agent/internal/wait-video-generation": 690_000,
};

export function resolveTools(metrics: Metrics): LnkpiTool[] {
	return resolveToolsWithClient(metrics).tools;
}

/** B-5：连同 client 一并返回——HITL Gate（checkGenerationGate）需要复用同一实例查画布 SSOT。
 * deps.registry（2026-09-30-ask-user-blocking B-1）：阻塞式确认类工具的等待注册表，透传给 ask_user。 */
export function resolveToolsWithClient(
	metrics: Metrics,
	deps: { registry?: PendingToolRegistry } = {},
): { tools: LnkpiTool[]; client: NestClient | null; registry: PendingToolRegistry | null } {
	const cfg = loadNestConfig();
	if (!cfg) {
		if (!warned) {
			warned = true;
			console.warn(
				"[pi-runtime] NEST_BASE_URL/NEST_SERVICE_TOKEN not set — canvas tools disabled (pure-text mode)",
			);
		}
		return { tools: [], client: null, registry: deps.registry ?? null };
	}
	const client = new NestClient({
		...cfg,
		// M-3：超时覆盖表导出为常量以便测试断言
		timeoutOverrides: TOOL_TIMEOUT_OVERRIDES,
		onCall: (tool, _outcome, info) => {
			// tool_calls_total 的计数与耗时由事件层统一结算（见 spec §3.2）：本次调用同样会触发
			// harness 的 tool_start/tool_end，此处再计一次就是双计，故删掉计数调用。
			// 但 errorKind 必须留：它是 Nest 侧返回的结构化分类，比事件层拿 resultText 正则猜精确。
			// 体积观测（observeToolResult）**不**在此打：它已于 2026-10-04 统一移到 after_tool hook
			// （那里量的是真正进上下文的 content 字节，且覆盖本地工具），两处都打会双计。
			if (info?.errorKind) metrics.observeToolErrorKind(tool, info.errorKind);
		},
	});
	const hasTavily = !!process.env.TAVILY_API_KEY && process.env.TAVILY_API_KEY !== "REPLACE_ME";
	const tools: LnkpiTool[] = [
		...buildCanvasReadTools(client),
		...buildCanvasWriteTools(client, deps.registry),
		...buildUiCommandTools(),
		...buildAskUserTools(deps.registry),
		...buildArrangeNodesTools(client),
		...buildGenerationTools(client),
		...(hasTavily ? buildWebTools() : []),
		...buildDeleteNodesTools(client),
		...buildReadDocumentTools(),
		...buildMemoryTools(client),
		...buildRemoveEdgesTools(client),
		// present 批次（2026-10-03 spec §5.1）：只读 SVG 卡片渲染，无条件注册。
		...buildRenderCanvasViewTools(client),
	];
	return { tools, client, registry: deps.registry ?? null };
}
