/** 工具装配与降级守卫：NEST env 齐全才启用工具，否则保持纯文本模式。 */
import { NestClient, loadNestConfig } from "./nest-client.js";
import { buildCanvasReadTools } from "./registry.js";
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
		onCall: (tool, outcome) => metrics.observeToolCall(tool, outcome),
	});
	return buildCanvasReadTools(client);
}
