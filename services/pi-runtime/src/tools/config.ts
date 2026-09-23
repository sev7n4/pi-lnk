/** 工具装配与降级守卫：NEST env 齐全才启用工具，否则保持纯文本模式。 */
import { NestClient, loadNestConfig } from "./nest-client.js";
import { buildCanvasReadTools, buildCanvasWriteTools } from "./registry.js";
import type { LnkpiTool } from "./types.js";
import type { Metrics } from "../metrics.js";

let warned = false;

/** 超时覆盖表（对齐老链路档位）：grid_slice_image 是 10/210/690 之外的第 4 档 120s。 */
export const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = {
	"/agent/internal/grid-slice-image": 120_000,
};

export function resolveTools(metrics: Metrics): LnkpiTool[] {
	const cfg = loadNestConfig();
	if (!cfg) {
		if (!warned) {
			warned = true;
			console.warn(
				"[pi-runtime] NEST_BASE_URL/NEST_SERVICE_TOKEN not set — canvas tools disabled (pure-text mode)",
			);
		}
		return [];
	}
	const client = new NestClient({
		...cfg,
		// M-3：超时覆盖表导出为常量以便测试断言
		timeoutOverrides: TOOL_TIMEOUT_OVERRIDES,
		onCall: (tool, outcome) => metrics.observeToolCall(tool, outcome),
	});
	return [...buildCanvasReadTools(client), ...buildCanvasWriteTools(client)];
}
