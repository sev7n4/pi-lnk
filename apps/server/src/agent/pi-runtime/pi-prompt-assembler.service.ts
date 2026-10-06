/**
 * PiPromptAssembler（#12）：组装 pi-runtime 会话的 system prompt。
 *
 * P0-① 起按 spec §5.3 拆两段（此前是「每轮重建会话」的单次 assemble）：
 *   - assembleStatic：规则组文本（S 层）。会话期内不变 → 会话创建时作为 systemPrompt 注入一次。
 *   - assembleDynamic：每轮变化的世界状态（G 层：画布快照 + 侧栏素材）。返回**数组**交给
 *     pi-runtime 追加到 systemPrompt 尾部求值，不写入对话历史（spec §4 动态上下文判据；
 *     写进历史会让每个旧轮的快照被反复计费并互相矛盾）。
 *
 * 规则文本出处：services/agent-runtime/app/graph/nodes/explore.py:87-132（_EXPLORE_SYSTEM）。 （注：老 LangGraph runtime 已于 2026-09-27 退役删除，该路径为历史语义出处）
 * 规则分组（B-2 起）：
 *   - core（默认注入）：前缀 + 规则 1/2/3/7（原文）；第 10 条「写操作未开放」守卫
 *     仅在 writeTools 未启用时附加（写工具上线后守卫退出）。
 *   - writeTools（B-2 随写工具注册启用）：规则 4/5 原文（explore.py:95-112 逐字）；
 *     规则 6/8/9 不拷贝（声明偏离，理由见 B-2 计划 §1.2）。
 *
 * 拼装顺序对齐 explore.py:393-408：规则 → 画布摘要 → 侧栏块。
 * 摘要获取失败时省略该块并继续（ Review Focus：prompt 必须始终成立）；
 * 摘要 JSON 不截断（有意对齐老链路）。
 * 早期「近期对话摘要」层随 compress-recent-turns 一起退役——历史现在进原生 context。
 */
import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { buildSelectionDigest } from "@lnkpi/shared";
import { buildSidebarBlock, type SidebarBlockInput } from "./sidebar-block";
import {
  CORE_RULES_PREFIX,
  RULE_3_GEN,
  RULE_3_NO_GEN,
  CORE_RULES_TAIL,
  WRITE_TOOLS_RULES,
  GEN_TOOLS_RULES,
  RULE_10_WRITE_GUARD,
} from "./prompt-registry.fallback";
import {
	describeRegistry,
	loadRegistry,
	renderStatic,
	renderStaticFallback,
	resolveRegistryRoot,
} from "./prompt-registry.loader";

// RuleGroup 定义收敛到 rule-groups.ts（零依赖，verify-ab-scenarios 脚本可安全 import）；
// 此处 re-export 保持既有对外形状。
import type { RuleGroup } from "./rule-groups";
export type { RuleGroup };

/**
 * 分层 kind：rules 属静态段（S 层），canvas/sidebar 属动态段（G 层）；
 * `skill` / `memory` 为 D-η' 与阶段二预留（Seam first —— 先留注入点，策略后定）。
 */
export type PromptLayerKind = "rules" | "canvas" | "sidebar" | "skill" | "memory";

export interface PromptLayer {
	id: string;
	kind: PromptLayerKind;
	content: string;
	/** 该层 token 估算，随层携带（manifest/观测直接消费，无需二次计算）。 */
	approxTokens: number;
}

/**
 * 分段注入 manifest（结构化，供 log/metrics 消费）。
 * 静态段没有归属会话（一次装配多会话共用），其 manifest 的 sessionId 为空串。
 */
/** 进程内只打一次：进程启动后第一个会话创建时能看到当前跑的是哪版提示词。 */
let staticRegistryLogged = false;

export interface PromptManifest {
	sessionId: string;
	layers: Array<{ id: string; kind: PromptLayerKind; tokens: number }>;
	totalTokens: number;
	/** 最终 prompt 的稳定哈希，用于跨轮 diff / 回归比对。 */
	promptHash: string;
	/** Registry 版本（读不到目录时为空串，观测上记为 n/a）。 */
	registryVersion: string;
	/** Registry 内容哈希：判「规则文件被谁改过」用，与 promptHash（本轮拼装结果）区分。 */
	registryHash: string;
}

/** CJK ≈1 token/字 + 其余 ≈1/4 token/字符（审计 P0-②：len/4 对中文低估 3~4 倍）。
 *  与 services/pi-runtime/src/skills/registry.ts 同口径，改必须同步。 */
const CJK_CHAR_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;

export function approxTokens(s: string): number {
	let cjk = 0;
	let other = 0;
	for (const ch of s) {
		if (CJK_CHAR_RE.test(ch)) cjk += 1;
		else other += 1;
	}
	return Math.ceil(cjk + other / 4);
}

/** 构造层并顺带算出 token 估算（避免调用点漏算）。 */
function layer(id: string, kind: PromptLayerKind, content: string): PromptLayer {
	return { id, kind, content, approxTokens: approxTokens(content) };
}

/** 最终 prompt 的稳定哈希（12 位 hex，够做跨轮 diff，不用于安全）。 */
export function promptHash(prompt: string): string {
	return createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 12);
}

/** 与老链路 1:1 的最小结构（getCanvasSummary.data）；焦点过滤命中时附 omittedCount/focusNodeId。 */
export interface CanvasSummaryData {
	nodes: Array<{ id: string; type: string; title: string; status: string }>;
	omittedCount?: number;
	focusNodeId?: string;
}

export interface CanvasSummaryProvider {
	getCanvasSummary(input: { sessionId: string; focusNodeId?: string }): Promise<CanvasSummaryData>;
}

@Injectable()
export class PiPromptAssembler {
	private readonly logger = new Logger(PiPromptAssembler.name);

	/** 测试观测口：最近一次分段装配的 layers 与 manifest 行（non-production API）。 */
	lastLayers?: PromptLayer[];
	/** 测试观测口（non-production API）：人类可读的一行 manifest（含 hash）。 */
	lastManifest?: string;
	/** 测试观测口（non-production API）：结构化 manifest，供 metrics 消费。 */
	lastManifestDetail?: PromptManifest;

	constructor(private readonly canvasTools: CanvasSummaryProvider) {}

	/**
	 * 静态段（S 层）：规则组文本。会话期内不变，创建会话时注入一次。
	 * 不触碰 canvasTools —— 静态段不依赖任何 world state。
	 */
	async assembleStatic(input: { ruleGroups?: RuleGroup[] }): Promise<string> {
		// 有意每次重读目录（会话创建不是热路径）：Registry 文件变了重启即生效，不引入缓存失效的复杂度。
		const groups = input.ruleGroups ?? ["core"];
		const snapshot = loadRegistry(resolveRegistryRoot());
		const text = snapshot.degraded ? renderStaticFallback(groups) : renderStatic(snapshot, groups);
		this.logRegistryOnce();
		this.recordLayers([layer("rules", "rules", text)], "");
		return text;
	}

	/** 首次静态段装配时打印一行 Registry 身份（模块级只打一次）。 */
	private logRegistryOnce(): void {
		if (staticRegistryLogged) return;
		staticRegistryLogged = true;
		this.logger.log(describeRegistry(loadRegistry(resolveRegistryRoot())));
	}

	/**
	 * 动态段（G 层）：每轮变化的世界状态（画布快照 + 侧栏素材）。
	 * 返回数组 —— 由 pi-runtime 追加到 systemPrompt 尾部求值，不写入对话历史（spec §4 动态上下文判据）。
	 * 画布摘要获取失败时省略该块并继续；两者都不可用时返回空数组（调用方 handle 空数组为「无动态块」）。
	 * focusNodeId（审计 P0-①）：传给 getCanvasSummary 做焦点过滤（>30 节点时只回
	 * 焦点 + 1 跳邻居，fail-open）；被裁剪时附提示行，模型可调 get_canvas_layout 取全量。
	 */
	async assembleDynamic(input: {
		sessionId: string;
		attachments?: SidebarBlockInput[];
		focusNodeId?: string;
		/** 审计 #7：长期记忆块（调用方拼好文本；assembler 只透传 + manifest 观测，不碰 prisma）。 */
		memoryBlock?: string;
		/**
		 * SEL-REF：指代信号（本轮选中的节点 id 集合）；与摘要焦点过滤语义无关。
		 * R-S5：不得据此改写 attachments / localRefs（指代 ≠ 素材注入）。
		 */
		selectedNodeIds?: string[];
		/**
		 * 本会话画布节点查找（id → type/title/坐标）；找不到即剔除，**同时承担归属校验**
		 * （调用方用 `getCanvasLayout` 构造，其只返回本会话画布的节点）。
		 */
		selectedNodeLookup?: (id: string) => { type: string; title: string; x: number; y: number } | undefined;
	}): Promise<string[]> {
		const layers: PromptLayer[] = [];

		try {
			const summary = await this.canvasTools.getCanvasSummary({
				sessionId: input.sessionId,
				focusNodeId: input.focusNodeId,
			});
			if (summary?.nodes) {
				const note =
					summary.omittedCount && summary.focusNodeId
						? `\n（画布共 ${summary.omittedCount + summary.nodes.length} 个节点，当前聚焦 ${summary.focusNodeId}，其余 ${summary.omittedCount} 个未列出；需要全量时调用 get_canvas_layout）`
						: "";
				layers.push(
					layer("canvas-summary", "canvas", `当前画布摘要：\n${JSON.stringify(summary)}${note}`),
				);
			}
		} catch (err) {
			this.logger.warn(
				`canvas summary unavailable for ${input.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		if (input.attachments?.length) {
			const block = buildSidebarBlock(input.attachments);
			if (block) layers.push(layer("sidebar", "sidebar", block));
		}

		// SEL-REF：指代信号块（R-S6：只含 id/type/标题 + 自解释尾注；R-S7：查不到就整块不输出）。
		// ⚠️ 必须放在 memory 之前——它描述"用户此刻指着谁"，属世界状态；
		// 块首标记 `【用户当前选中】` 已在 dynamic-budget.classifyBlock 登记为 canvas（R-S6 kind）。
		if (input.selectedNodeIds?.length && input.selectedNodeLookup) {
			const digest = buildSelectionDigest({
				nodeIds: input.selectedNodeIds,
				lookup: input.selectedNodeLookup,
			});
			if (digest) layers.push(layer("selection", "canvas", digest));
		}

		// 审计 #7：memory 层放最后（世界状态之后、模型近期关注），fail-soft 语义由调用方保证。
		if (input.memoryBlock?.trim()) {
			layers.push(layer("memory", "memory", input.memoryBlock));
		}

		this.recordLayers(layers, input.sessionId);
		return layers.map((l) => l.content);
	}

	/** 记录 layers 与 manifest 行（既有观测口语义不变；sessionId 为空串表示静态段）。 */
	private recordLayers(layers: PromptLayer[], sessionId: string): void {
		const totalTokens = layers.reduce((sum, l) => sum + l.approxTokens, 0);
		const hash = promptHash(layers.map((l) => l.content).join("\n"));

		this.lastLayers = layers;
		const snap = loadRegistry(resolveRegistryRoot());
		this.lastManifestDetail = {
			sessionId,
			layers: layers.map((l) => ({ id: l.id, kind: l.kind, tokens: l.approxTokens })),
			totalTokens,
			promptHash: hash,
			registryVersion: snap.registryVersion,
			registryHash: snap.registryHash,
		};
		this.lastManifest = `prompt manifest ${sessionId || "(static)"}: ${layers
			.map((l) => `${l.id}:${l.kind}:${l.approxTokens}tok`)
			.join(" ")} total=${totalTokens}tok hash=${hash} registry=${snap.registryVersion || "n/a"} registryHash=${snap.registryHash}`;
		this.logger.log(this.lastManifest);
	}
}
