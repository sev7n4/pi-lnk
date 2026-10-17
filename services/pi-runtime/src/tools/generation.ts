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
import type { NodeStatusData } from "../session-manager.js";
import { fetchImageAsBlock, isImageRefineEnabled, type ImageBlock } from "./image-refine.js";
// B-5：Nest 返回的 CanvasAction[] 进 details.actions，由 Nest pi-events 派生 canvas_action SSE。
// helper 已抽到 result-with-actions.ts（canvas-write / delete-nodes / 本文件共用一份）。
import { resultWithActions } from "./result-with-actions.js";
// 工具结果质量信号（spec 2026-10-12 §2.2/§3）：_signal 注入 + GenDetails 必填字段。
import { signalFromUpstream, withSignal, type ToolResultSignal } from "./result-signal.js";
// onUpdate 进度 ticker（2026-10-18 上游对齐）：与 canvas-write 终态等待共用一份发射形状。
import { startGenerationProgressTicker } from "./progress-ticker.js";

/** Nest run / wait 响应的 used 回读（agent-canvas-tools.service.ts ImageGenUsedParams）。 */
type NestUsedParams = {
	model?: string;
	aspectRatio?: string;
	resolution?: string;
	count?: number;
	kind?: string;
	voice?: string;
};

/** GenDetails 组装：used 缺失（Nest 版本偏斜）→ "unspecified"/{}，fail-soft 不造值。 */
function genDetailsFromUsed(used: NestUsedParams | undefined): {
	modelUsed: string;
	generationParams: Record<string, unknown>;
} {
	return {
		modelUsed: typeof used?.model === "string" && used.model ? used.model : "unspecified",
		generationParams: {
			...(used?.aspectRatio !== undefined ? { aspectRatio: used.aspectRatio } : {}),
			...(used?.resolution !== undefined ? { resolution: used.resolution } : {}),
			...(used?.count !== undefined ? { count: used.count } : {}),
			...(used?.kind !== undefined ? { kind: used.kind } : {}),
			...(used?.voice !== undefined ? { voice: used.voice } : {}),
		},
	};
}

/** 统一包装：resultWithActions + GenDetails + _signal（actions/confirmed 消费方契约由 withSignal 展开保留）。 */
function withGenSignal(data: unknown): {
	content: [{ type: "text"; text: string }];
	details: { actions: Record<string, unknown>[]; modelUsed: string; generationParams: Record<string, unknown>; _signal: ToolResultSignal };
} {
	const base = resultWithActions(data);
	return withSignal(
		{
			...base,
			details: { ...base.details, ...genDetailsFromUsed((data as { used?: NestUsedParams } | null)?.used) },
		},
		signalFromUpstream(data),
	);
}

/** 成功路径 content 可为「文本 + 图」两 block；details 契约与共享 helper 完全一致。 */
type ToolResultContent = { type: "text"; text: string } | ImageBlock;
type ToolResultWithActions = {
	content: ToolResultContent[];
	details: ReturnType<typeof resultWithActions>["details"];
};

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
): ToolResultWithActions {
	const nextData: Record<string, unknown> = { ...data, imageRefine: mark };
	if (reason !== undefined) nextData.imageRefineReason = reason;
	return { ...base, content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data: nextData }) }] };
}

export function createGenerationTools(
	client: NestClient,
	deps: {
		fetchImpl?: typeof fetch;
		onNodeStatus?: (sessionId: string, data: NodeStatusData) => void;
		/** 生成终态等待登记（2026-10-18 上游对齐）：config.ts 接线到 SessionManager。
		 *  返回解绑函数；工具 finally 必须调用，否则该节点被 notify-generation 永久抑制。 */
		onRegisterGenerationWait?: (sessionId: string, nodeId: string) => () => void;
	} = {},
): LnkpiTool[] {
	const gen = { tier: "gen" as const };
	/** node_status 广播（2026-10-18）：run_* 持有期起手发 generating，终态从结果正据映射。
	 *  fail-soft：广播炸了不影响工具结果（与 onProposeOutcome 同纪律）。 */
	const emitNodeStatus = (tc: LnkpiToolContext, data: NodeStatusData) => {
		try {
			deps.onNodeStatus?.(tc.sessionId, data);
		} catch {
			/* 观察者不得污染工具主链路 */
		}
	};
	/** 阻塞期 onUpdate 进度通道与等待登记（2026-10-18 上游对齐）：
	 *  实现抽到 tools/progress-ticker.ts（与 propose 终态等待共用发射形状），此处只留
	 *  fail-soft 包装——进度/登记都是纯观测面，任何异常不得污染生成主链路。 */
	const startProgressTicker = (
		onUpdate: Parameters<typeof startGenerationProgressTicker>[0],
		nodeId: string,
	): (() => void) => startGenerationProgressTicker(onUpdate, nodeId);
	/** 生成等待期登记（2026-10-18 上游对齐）：notify-generation 通报的抑制判据。
	 *  fail-soft：登记失败只损失「通报抑制」，绝不影响生成主链路。 */
	const withGenerationWait = async <T>(tc: LnkpiToolContext, nodeId: string, run: () => Promise<T>): Promise<T> => {
		let unregister: (() => void) | undefined;
		try {
			unregister = deps.onRegisterGenerationWait?.(tc.sessionId, nodeId);
		} catch {
			/* 登记是纯观测面 */
		}
		try {
			return await run();
		} finally {
			try {
				unregister?.();
			} catch {
				/* 解绑同理 */
			}
		}
	};
	/** 结果 → 终态正据映射（保守口径，与前端 mapNodeStatus 对齐）：有 url 才 done；
	 *  timeout / fallback_pending 不是终态（生成可能仍在跑/等确认），不下发。 */
	const emitTerminalFromResult = (tc: LnkpiToolContext, nodeId: string, data: Record<string, unknown>) => {
		const url = typeof data.url === "string" && data.url ? data.url : undefined;
		if (url) {
			emitNodeStatus(tc, { nodeId, status: "done", url });
			return;
		}
		const status = String(data.status ?? "");
		const error = typeof data.errorMessage === "string" && data.errorMessage ? data.errorMessage : undefined;
		if (status === "error" || status === "failed" || error) {
			emitNodeStatus(tc, { nodeId, status: "failed", error });
		}
		// timeout / fallback_pending / 其他：保持 generating 语义（不下发终态）
	};
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
			onUpdate,
			tc: LnkpiToolContext,
			_invocation,
			context: Context,
		) => {
			if (!tc.userId) throw new Error(`${name} requires userId in toolContext`);
			// node_status：起手即 generating（回合挂住等终态，2026-10-18）——阻塞等待期
			// 前端产物行从「待确认」翻「生成中」，SSE 心跳语义兼喂 stall watchdog 进度戳。
			emitNodeStatus(tc, { nodeId: p.node_id, status: "generating" });
			// P0-②：run abort 时 gate signal 触发 context.abortSignal → fetch 立即中断，
			// 工具以 error result 收尾（用户取消的 error 事件由 SessionManager.userAborted 抑制）
			const data = await withGenerationWait(tc, p.node_id, async () => {
				// onUpdate 进度通道（2026-10-18 上游对齐）：阻塞期 30s 一拍全量快照 + checkpoint，
				// stall watchdog 活性证据 + durable 恢复检查点（见 startProgressTicker 注）。
				const stopTicker = startProgressTicker(onUpdate, p.node_id);
				try {
					return (await client.post(
						path,
						{ sessionId: tc.sessionId, userId: tc.userId, nodeId: p.node_id },
						{ signal: context?.abortSignal ?? undefined },
					)) as { url?: string } & Record<string, unknown>;
				} finally {
					stopTicker();
				}
			});
			emitTerminalFromResult(tc, p.node_id, data);
			const base = withGenSignal(data);
			// 视觉自评闭环（spec 2026-09-29 §4.2）只回流 run_image_generation；其余 run_* 形态不变
			if (name !== "run_image_generation") return base;
			// Review Focus ④：开关 off → 逐字节等同旧行为（不加字段、不附加 block）
			if (!isImageRefineEnabled()) return base;
			const url = typeof data.url === "string" ? data.url : "";
			// Review Focus ③：成功但无 url（timeout/fallback_pending）→ 不 fetch，仅标注 n/a
			if (!url) return withImageRefine(base, data, "n/a");
			const fetched = await fetchImageAsBlock(url, { fetchImpl: deps.fetchImpl });
			if (!fetched.ok) return withImageRefine(base, data, "skipped", fetched.reason);
			// P1（2026-10-14）：canvasNode 锚随文本 JSON 落盘——T2 降级占位（payload-images.labelFor）
			// 据此生成「view_canvas_media(node_id:…)」可恢复提示；锚字段与 labelFor 正则逐字对齐。
			const attached = withImageRefine(base, { ...data, canvasNode: p.node_id }, "attached");
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
		// 被删历史（2026-10-17 prompt 节点下线，PR feat/prompt-node-decommission）：
		// run_prompt_generation（"执行提示词生成" → /agent/internal/run-prompt-generation）
		// 曾以 runTool 同形态定义于此；随 prompt 节点下线整链移除（服务端端点、
		// Nest service 方法、studio.generatePrompt 同批删）。turnaround/四格产品图管线
		// 走 expandPromptContent，不经此工具，不受影响。
		{
			...gen,
			name: "run_audio_generation",
			label: "执行音频生成",
			description:
				"Run audio generation for a canvas media node using node audio params. Requires pending confirmation. `kind` selects the audio sub-type: voice (default, TTS 配音) | design (综合音频：多角色台词+音效+氛围) | music (音乐/BGM). Sub-type-specific params may be passed inline and take precedence over node params: voice uses voice/emotion; design uses roles/scripts/instruction; music uses caption/lyrics/instrumental. Pick the kind that matches the request instead of defaulting to voice; if the requested kind's model is unavailable the tool returns an explicit error — report it, do not silently fall back.",
			parameters: Type.Object({
				node_id: Type.String({
					description: "Media node id to generate for (from canvas summary, not title text)",
				}),
				// ⚠️ 以下参数一律追加在 node_id 之后 —— 本工具的调用按位置对齐，
				// 中间插入会让同型参数错位（不报错、只静默错值）。
				kind: Type.Optional(
					Type.String({ description: "voice | design | music (default: voice)" }),
				),
				voice: Type.Optional(Type.String({ description: "voice: 音色 id" })),
				emotion: Type.Optional(Type.String({ description: "voice: 情绪" })),
				roles: Type.Optional(
					Type.Array(
						Type.Object({ role: Type.String(), voice: Type.String() }),
						{ description: "design: 角色→音色表" },
					),
				),
				scripts: Type.Optional(
					Type.Array(
						Type.Object({
							role: Type.Optional(Type.String()),
							text: Type.String({ description: "台词；() 内为语气、[] 内为音效" }),
						}),
						{ description: "design: 脚本段" },
					),
				),
				instruction: Type.Optional(
					Type.String({ description: "design: 整体演绎指导（≤500 字）" }),
				),
				caption: Type.Optional(Type.String({ description: "music: 风格描述" })),
				lyrics: Type.Optional(Type.String({ description: "music: 歌词（可空）" })),
				instrumental: Type.Optional(
					Type.Boolean({ description: "music: 纯音乐（无歌词）" }),
				),
			}),
			execute: async (
				_id,
				p: {
					node_id: string
					kind?: string
					voice?: string
					emotion?: string
					roles?: Array<{ role: string; voice: string }>
					scripts?: Array<{ role?: string; text: string }>
					instruction?: string
					caption?: string
					lyrics?: string
					instrumental?: boolean
				},
				onUpdate,
				tc: LnkpiToolContext,
				_invocation,
				context: Context,
			) => {
				if (!tc.userId) throw new Error("run_audio_generation requires userId in toolContext");
				emitNodeStatus(tc, { nodeId: p.node_id, status: "generating" });
				// 只把调用方真的给了的字段发出去：缺省 = 沿用节点上的参数（存量语义逐字节不变）。
				const body: Record<string, unknown> = {
					sessionId: tc.sessionId,
					userId: tc.userId,
					nodeId: p.node_id,
				};
				for (const key of [
					"kind",
					"voice",
					"emotion",
					"roles",
					"scripts",
					"instruction",
					"caption",
					"lyrics",
					"instrumental",
				] as const) {
					if (p[key] !== undefined) body[key] = p[key];
				}
				const data = await withGenerationWait(tc, p.node_id, async () => {
					const stopTicker = startProgressTicker(onUpdate, p.node_id);
					try {
						return (await client.post("/agent/internal/run-audio-generation", body, {
							signal: context?.abortSignal ?? undefined,
						})) as { url?: string } & Record<string, unknown>;
					} finally {
						stopTicker();
					}
				});
				emitTerminalFromResult(tc, p.node_id, data);
				return withGenSignal(data);
			},
		},
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
				// verify-details:ignore cancel_generation 是 lifecycle 自描述结果（缺口报告 §3.6 勾选不进信号层）
				return resultWithActions(
					await client.post("/agent/internal/cancel-generation", body, {
						signal: context?.abortSignal ?? undefined,
					}),
				);
			},
		},
	];
}
