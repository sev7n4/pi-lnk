/** 工具装配与降级守卫：NEST env 齐全才启用工具，否则保持纯文本模式。 */
import { NestClient, loadNestConfig } from "./nest-client.js";
import { buildCanvasReadTools, buildCanvasWriteTools } from "./registry.js";
import type { LnkpiTool } from "./types.js";
import type { Metrics } from "../metrics.js";

let warned = false;

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
		// grid_slice_image 在老链路是独立 120s 档（10/210/690 之外的第 4 档），此处对齐
		timeoutOverrides: { "/agent/internal/grid-slice-image": 120_000 },
		onCall: (tool, outcome) => metrics.observeToolCall(tool, outcome),
	});
	return [...buildCanvasReadTools(client), ...buildCanvasWriteTools(client)];
}
