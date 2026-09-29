/**
 * B-5/B-3 批次：生成执行 + 生命周期（6 个）。
 * 端点/body 对照 services/agent-runtime/app/tools/nest_client.py:335-499 与 （注：老 LangGraph runtime 已于 2026-09-27 退役删除，该路径为历史语义出处）
 * apps/server/src/agent/agent-canvas-tools.controller.ts:1037-1127（2026-09-24 逐条核对）。
 *
 * 声明偏离（计划 §已知偏离）：
 *  - start/wait_* 变体不迁（graph 专用 task_update 进度发射，pi 无 graph）；
 *  - upscale_image 不迁（roadmap D4 断头工具）；run_icon_refine 为 stub；
 *  - confirm/cancel_platform_fallback 不迁为 LLM 工具（D3：fallback_pending 确认入口
 *    = 前端 ByokFallbackConfirmDialog 直连 studio HTTP，模型不批自己的审批）。
 *  - 无自动重试（老 graph max 2 次；pi 侧由模型依 error tool result 决定重试）。
 *
 * HITL：run_* 由 before_tool Gate 强制（src/gate/generation-gate.ts），此处不含门禁逻辑。
 */
import { Type } from "typebox";
import type { Context } from "@earendil-works/pi-agent-core";
import type { LnkpiTool, LnkpiToolContext } from "./types.js";
import type { NestClient } from "./nest-client.js";
import { fetchImageAsBlock, isImageRefineEnabled, type ImageBlock } from "./image-refine.js";

function extractActions(data: unknown): Record<string, unknown>[] {
	const actions = (data as { actions?: unknown } | null | undefined)?.actions;
	if (!Array.isArray(actions)) return [];
	return actions.filter((a): a is Record<string, unknown> => !!a && typeof a === "object");
}

function resultWithActions(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data }) }],
		// B-5：Nest 返回的 CanvasAction[] 进 details.actions，由 Nest pi-events 派生 canvas_action SSE
		details: { actions: extractActions(data) },
	};
}

/**
 * 视觉自评闭环（spec 2026-09-29 §4.2）：把 imageRefine 标记并入文本 JSON 的 data，
 * 保持原有 key 顺序（`{ ...data, imageRefine }`），按 resultWithActions 的方式重建 content[0]，
 * details 原样透传。
 */
function withImageRefine(
	base: ReturnType<typeof resultWithActions>,
	data: Record<string, unknown>,
	mark: "attached" | "skipped" | "n/a",
	reason?: string,
): ReturnType<typeof resultWithActions> {
	const nextData: Record<string, unknown> = { ...data, imageRefine: mark };
	if (reason !== undefined) nextData.imageRefineReason = reason;
	return { ...base, content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data: nextData }) }] };
}

export function createGenerationTools(
	client: NestClient,
	deps: { fetchImpl?: typeof fetch } = {},
): LnkpiTool[] {
	const gen = { tier: "gen" as const };
	const runTool = (
		name: string,
		label: string,
		description: string,
		path: string,
	): LnkpiTool => ({
		...gen,
		name,
		label,
		description,
		parameters: Type.Object({
			node_id: Type.String({
				description: "Media node id to generate for (from canvas summary, not title text)",
			}),
		}),
		execute: async (
			_id,
			p: { node_id: string },
			_u,
			tc: LnkpiToolContext,
			_invocation,
			context: Context,
		) => {
			if (!tc.userId) throw new Error(`${name} requires userId in toolContext`);
			// P0-②：run abort 时 gate signal 触发 context.abortSignal → fetch 立即中断，
			// 工具以 error result 收尾（用户取消的 error 事件由 SessionManager.userAborted 抑制）
			const data = (await client.post(
				path,
				{ sessionId: tc.sessionId, userId: tc.userId, nodeId: p.node_id },
				{ signal: context?.abortSignal ?? undefined },
			)) as { url?: string } & Record<string, unknown>;
			const base = resultWithActions(data);
			// 视觉自评闭环（spec 2026-09-29 §4.2）只回流 run_image_generation；其余 run_* 形态不变
			if (name !== "run_image_generation") return base;
			// Review Focus ④：开关 off → 逐字节等同旧行为（不加字段、不附加 block）
			if (!isImageRefineEnabled()) return base;
			const url = typeof data.url === "string" ? data.url : "";
			// Review Focus ③：成功但无 url（timeout/fallback_pending）→ 不 fetch，仅标注 n/a
			if (!url) return withImageRefine(base, data, "n/a");
			const fetched = await fetchImageAsBlock(url, { fetchImpl: deps.fetchImpl });
			if (!fetched.ok) return withImageRefine(base, data, "skipped", fetched.reason);
			const attached = withImageRefine(base, data, "attached");
			return { ...attached, content: [...attached.content, fetched.block satisfies ImageBlock] };
		},
	});

	return [
		runTool(
			"run_image_generation",
			"执行图片生成",
			"Run image generation for a canvas media node and wait for completion (up to ~3 min). Requires the node to be pending user confirmation. Returns url on success; status=timeout means unfinished (use get_generation_status later); status=fallback_pending means user must confirm platform fallback on the canvas node. When the result includes imageRefine=\"attached\", the generated image is attached — inspect it against the task checklist before reporting; if it fails, revise the prompt (set_node_text) and run once more, then report honestly.",
			"/agent/internal/run-image-generation",
		),
		runTool(
			"run_video_generation",
			"执行视频生成",
			"Run video generation for a canvas media node and wait for completion (up to ~11 min). Same confirmation and status semantics as run_image_generation.",
			"/agent/internal/run-video-generation",
		),
		runTool(
			"run_text_generation",
			"执行文案生成",
			"Run text generation for a canvas media node (writes generated copy into node content). Requires pending confirmation.",
			"/agent/internal/run-text-generation",
		),
		runTool(
			"run_prompt_generation",
			"执行提示词生成",
			"Run prompt generation for a canvas media node (writes generation prompt into node). Requires pending confirmation.",
			"/agent/internal/run-prompt-generation",
		),
		runTool(
			"run_audio_generation",
			"执行音频生成",
			"Run audio (TTS) generation for a canvas media node using node audio params. Requires pending confirmation.",
			"/agent/internal/run-audio-generation",
		),
		{
			tier: "lifecycle" as const,
			name: "cancel_generation",
			label: "取消生成",
			description:
				"Cancel an in-progress generation by generation_record_id or node_id (at least one; resolve node_id from canvas summary, not title text). Only generating records can be cancelled.",
			parameters: Type.Object({
				generation_record_id: Type.Optional(Type.String({ description: "GenerationRecord id" })),
				node_id: Type.Optional(Type.String({ description: "Canvas node id" })),
			}),
			execute: async (
				_id,
				p: { generation_record_id?: string; node_id?: string },
				_u,
				tc: LnkpiToolContext,
				_invocation,
				context: Context,
			) => {
				if (!tc.userId) throw new Error("cancel_generation requires userId in toolContext");
				if (!p.generation_record_id && !p.node_id) {
					throw new Error("cancel_generation requires generation_record_id or node_id (at least one)");
				}
				const body: Record<string, unknown> = { sessionId: tc.sessionId, userId: tc.userId };
				if (p.generation_record_id) body.generationRecordId = p.generation_record_id;
				if (p.node_id) body.nodeId = p.node_id;
				return resultWithActions(
					await client.post("/agent/internal/cancel-generation", body, {
						signal: context?.abortSignal ?? undefined,
					}),
				);
			},
		},
	];
}
