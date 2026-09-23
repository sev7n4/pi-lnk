/** 注册工厂：按批次组合工具集。后续批次（B-2+）在此追加，不改调用方。 */
import type { NestClient } from "./nest-client.js";
import type { LnkpiTool } from "./types.js";
import { createCanvasReadTools } from "./canvas-read.js";

export function buildCanvasReadTools(client: NestClient): LnkpiTool[] {
	return createCanvasReadTools(client);
}
