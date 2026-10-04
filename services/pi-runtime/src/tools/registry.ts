/** 注册工厂：按批次组合工具集。后续批次（B-3+）在此追加，不改调用方。 */
import type { NestClient } from "./nest-client.js";
import type { LnkpiTool } from "./types.js";
import type { PendingToolRegistry } from "../pending-registry.js";
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
import { buildRemoveEdgesTools } from "./remove-edges.js";
import { createRenderCanvasViewTools } from "./render-canvas-view.js";

/** P0 批次：web_search/web_fetch（感知层）。TAVILY_API_KEY 未配置时由 config.ts 条件装配。 */
export { buildWebTools };

/** S4 批次：remove_edges（tier=write_light，复用 Nest remove-edges，id 来自 get_canvas_layout）。 */
export { buildRemoveEdgesTools };

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
 * registry 可选注入（2026-09-30-ask-user-blocking B-2）：注入且开关开 → propose_generation 阻塞分支。
 */
export function buildCanvasWriteTools(client: NestClient, registry?: PendingToolRegistry): LnkpiTool[] {
	return createCanvasWriteTools(client, { registry });
}

/** UI_COMMAND 批次：5 个本地 UI 命令工具（不依赖 NestClient）。
 *  2026-10-04：去掉 `metrics` 形参——工具计数已由事件层统一结算（spec §3.2）。 */
export function buildUiCommandTools(): LnkpiTool[] {
	return createUiCommandTools();
}

/** ask_user 批次：向用户提问/选项卡工具（spec docs/superpowers/specs/2026-09-28-ask-user-tool-design.md，D1-D5 已拍板）。
 * registry 可选注入（2026-09-30-ask-user-blocking B-1）：注入且开关开 → 阻塞分支。
 * 2026-10-04：去掉 `metrics` 形参（计数移交事件层，见 spec §3.2）。 */
export function buildAskUserTools(registry?: PendingToolRegistry): LnkpiTool[] {
	return createAskUserTools(registry);
}

/** arrange_nodes 批次：自动排列节点工具（spec docs/superpowers/specs/2026-09-28-arrange-nodes-tool-design.md，D1-D5 已拍板）。
 * client 可选注入（2026-10-02 L2）：有则 execute 内只读校验 node_ids/edges 并富化工具结果。
 * 与 buildCanvasReadTools 同款 NestClient 实例，纯读不写。
 * 2026-10-04：去掉 `metrics` 形参——L3 by-mode 计数移交事件层，动态
 * `arrange_nodes_<mode>` label 正是 spec §3.2 要消除的基数风险。 */
export function buildArrangeNodesTools(client?: NestClient): LnkpiTool[] {
	return createArrangeNodesTools(client);
}

/**
 * B-5/B-3 批次：5 个 run_* 生成工具（tier=gen）+ cancel_generation（tier=lifecycle）。
 * HITL 由 before_tool Gate 强制（generation-gate.ts），工具本身不含门禁逻辑。
 */
export function buildGenerationTools(client: NestClient): LnkpiTool[] {
	return createGenerationTools(client);
}

/**
 * present 批次：render_canvas_view（tier=present，spec 2026-10-03 §5.1）。
 * 纯只读：只走 client.post /agent/internal/get-canvas-layout（Nest 转发层只有 post 方法，
 * 只读端点同样是 POST 语义），不 POST 任何写端点。
 */
export function buildRenderCanvasViewTools(client: NestClient): LnkpiTool[] {
	return createRenderCanvasViewTools({
		fetchLayout: async (sessionId) => client.post("/agent/internal/get-canvas-layout", { sessionId }),
	});
}
