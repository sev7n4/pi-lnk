/** 注册工厂：按批次组合工具集。后续批次（B-3+）在此追加，不改调用方。 */
import type { NestClient } from "./nest-client.js";
import type { LnkpiTool } from "./types.js";
import type { Metrics } from "../metrics.js";
import { createCanvasReadTools } from "./canvas-read.js";
import { createCanvasWriteTools } from "./canvas-write.js";
import { createUiCommandTools } from "./ui-command.js";

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
