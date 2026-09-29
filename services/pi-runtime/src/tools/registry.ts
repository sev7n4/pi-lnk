/** 注册工厂：按批次组合工具集。后续批次（B-3+）在此追加，不改调用方。 */
import type { NestClient } from "./nest-client.js";
import type { LnkpiTool } from "./types.js";
import type { Metrics } from "../metrics.js";
import { createCanvasReadTools } from "./canvas-read.js";
import { createCanvasWriteTools } from "./canvas-write.js";
import { createUiCommandTools } from "./ui-command.js";
import { createAskUserTools } from "./ask-user.js";
import { createArrangeNodesTools } from "./arrange-nodes.js";
import { createGenerationTools } from "./generation.js";
import { buildWebTools } from "./web.js";
import { buildDeleteNodesTools } from "./delete-nodes.js";
import { buildReadDocumentTools } from "./read-document.js";
import { buildMemoryTools } from "./memory.js";

/** P0 批次：web_search/web_fetch（感知层）。TAVILY_API_KEY 未配置时由 config.ts 条件装配。 */
export { buildWebTools };

/** P0 批次：delete_nodes（tier=destructive，复用 Nest remove-nodes）。 */
export { buildDeleteNodesTools };

/** P1 批次：read_document（tier=read，读 toolContext.attachments，零 Nest 改动）。 */
export { buildReadDocumentTools };

/** P1 批次：save_memory / recall_memory（跨会话记忆，走 Nest internal 端点）。 */
export { buildMemoryTools };

export function buildCanvasReadTools(client: NestClient): LnkpiTool[] {
	return createCanvasReadTools(client);
}

/**
 * B-2 批次：写工具 + connect_nodes（自 B-6 提前）。
 * introduce_nodes_to_agent 属老链路 DEFERRED，默认不暴露（includeDeferred 显式开启）。
 */
export function buildCanvasWriteTools(client: NestClient): LnkpiTool[] {
	return createCanvasWriteTools(client);
}

/** UI_COMMAND 批次：5 个本地 UI 命令工具（不依赖 NestClient）。 */
export function buildUiCommandTools(metrics: Metrics): LnkpiTool[] {
	return createUiCommandTools(metrics);
}

/** ask_user 批次：向用户提问/选项卡工具（spec docs/superpowers/specs/2026-09-28-ask-user-tool-design.md，D1-D5 已拍板）。 */
export function buildAskUserTools(metrics: Metrics): LnkpiTool[] {
	return createAskUserTools(metrics);
}

/** arrange_nodes 批次：自动排列节点工具（spec docs/superpowers/specs/2026-09-28-arrange-nodes-tool-design.md，D1-D5 已拍板）。 */
export function buildArrangeNodesTools(metrics: Metrics): LnkpiTool[] {
	return createArrangeNodesTools(metrics);
}

/**
 * B-5/B-3 批次：5 个 run_* 生成工具（tier=gen）+ cancel_generation（tier=lifecycle）。
 * HITL 由 before_tool Gate 强制（generation-gate.ts），工具本身不含门禁逻辑。
 */
export function buildGenerationTools(client: NestClient): LnkpiTool[] {
	return createGenerationTools(client);
}
