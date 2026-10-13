/**
 * 信号 listener 纯函数（P1 · spec docs/superpowers/specs/2026-10-12-tool-details-contract-design.md §4/§5/§6）。
 *
 * 职责边界（§4 注入纪律）：
 * - 成功（status=ok 且无 truncated/coverage 告警且无对账差异）→ **零注入**（成功静默）；
 * - 异常才注入一行自解释短告警（15-30 token 预算），格式 `⚠️[<tier>] <现象> <模型可考虑的动作>`；
 * - 注入位置 = 尾部追加（评审拍板，与 tool-result-budget.ts 截断 marker 同通道），
 *   叠加顺序固定：「正文 → 截断 marker → 信号行」——截断在合并 listener 先发生，
 *   本函数追加在最后，顺序天然成立；
 * - ⭐ details patch 必须 `{...details, _signal}` 展开合并：vendor 聚合是整字段替换
 *   （hooks.ts:315），直接 `{_signal}` 会抹掉前序 listener 的 details patch（actions 等）。
 * - patch 面纪律：只改 content + details，**禁止触碰 isError/usage/terminate**（§4）。
 *
 * 纯函数不 import vendor 类型：接线层（result-signal-wiring.ts）传窄化后的字段；
 * _signal 的形态校验复用 Task 1 的 isToolResultSignal（本仓单点，非 vendor）。
 */
import { isToolResultSignal, type ToolResultSignal } from "./result-signal.js";

/** content 块窄形态（对齐 AgentToolResult["content"] 的文本/图片子集，避免 import vendor 类型）。 */
export type SignalContentBlock = { type: string; text?: string };

export interface SignalPatch {
	content: SignalContentBlock[];
	details: Record<string, unknown>;
}

/**
 * details._signal 窄化：非对象 details（契约外形态）或无有效 _signal（非契约工具）→ undefined。
 * 非契约工具（ask_user/load_skill 等）不在注入纪律覆盖范围内：isError 裸真不触发注入
 * （RB-D4 例外：nest 形态错误文本可经 signalFromErrorContent 合成，见 appendSignalLine）。
 * 其错误表现归事件层与既有链路（Ruling 2026-10-12，见 SDD 台账）。
 * 供接线层读信号打 metrics（活性探针不依赖注入发生）。
 */
export function readSignal(details: unknown): ToolResultSignal | undefined {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const raw = (details as Record<string, unknown>)._signal;
	return isToolResultSignal(raw) ? raw : undefined;
}

function isTextBlock(b: SignalContentBlock): b is { type: "text"; text: string } {
	return b.type === "text" && typeof b.text === "string";
}

/**
 * RB-D4（spec 2026-10-13-sidebar-ref-bind-invariant-design.md）：信号层 throw 路径分支。
 * NestToolError 文本模式（nest-client.ts:124）：`nest <path> http <status>: <msg>`。
 * 4xx ⇒ invalid_params（参数错不可重试）；5xx ⇒ upstream_5xx（退避）。
 * envelope(code=)/timeout/network 无状态码 ⇒ undefined 不妄言；非 nest 消息不匹配 ⇒
 * 维持 10-12 Ruling「契约外工具零注入」。
 */
export function signalFromErrorContent(content: SignalContentBlock[]): ToolResultSignal | undefined {
	let text = "";
	for (const b of content) {
		if (isTextBlock(b)) text += `${b.text}\n`;
	}
	const m = /\bhttp ([1-5]\d{2})\b/.exec(text);
	if (!m) return undefined;
	const status = Number(m[1]);
	if (status >= 500) return { status: "failed", retryable: true, errorCode: "upstream_5xx" };
	if (status >= 400) return { status: "failed", retryable: false, errorCode: "invalid_params" };
	return undefined;
}

/** 按信号内容组装告警行（15-30 token 预算；自解释——prompt 预算仅剩 3 字符，禁止外加解读规则）。 */
function signalLines(sig: ToolResultSignal, tier: string, extraLine: string | undefined): string[] {
	const lines: string[] = [];
	const tag = `⚠️[${tier}]`;
	if (sig.status !== "ok") {
		if (sig.retryable === true) {
			// §5 三态：确知可重试（vendor 判 429 限流/5xx/timeout 类）→ 退避提示。
			lines.push(`${tag} ${sig.errorCode ?? "上游请求失败"}：瞬时失败，可退避重试`);
		} else if (sig.retryable === false) {
			// §5 三态：确知不可重试（本地域 invalid_params/empty_result 等）→ 改参提示，不鼓励盲重试。
			lines.push(`${tag} ${sig.errorCode ?? "请求失败"}：重试同参无意义，请调整参数后重试`);
		} else {
			// 缺省 = 未判明：hedge 文本（spec §5 原文），既不断言不可重试也不鼓励盲重试。
			lines.push(`${tag} 上游失败原因未判明；若是瞬时故障，退避重试或换模型通常有效`);
		}
	}
	if (sig.truncated === true) {
		lines.push(`${tag} 结果已截断，仅返回部分内容`);
	}
	if (sig.coverage === "partial") {
		lines.push(`${tag} coverage=partial：数据为局部采样，非全量结果`);
	} else if (sig.coverage === "empty") {
		lines.push(`${tag} coverage=empty：未采样到数据`);
	}
	if (extraLine !== undefined && extraLine !== "") {
		lines.push(extraLine);
	}
	return lines;
}

/**
 * 尾部追加信号行 + details 展开合并。零告警 → undefined（调用方不返回 patch）。
 *
 * 信号来源（RB-D4）：details._signal（readSignal）优先；throw 路径（vendor
 * createErrorToolResult：details=undefined）无 _signal，isError=true 时回退
 * signalFromErrorContent 从错误文本合成——details 已有合法 _signal 时提取不生效。
 *
 * @param isError throw 路径分支开关：true 且无 _signal 时从 content 合成信号。
 * @param extraLine 对账告警（reconcileAffected 产物），与信号行一起统一追加。
 */
export function appendSignalLine(
	_toolName: string,
	tier: string,
	isError: boolean,
	content: SignalContentBlock[],
	details: unknown,
	extraLine?: string,
): SignalPatch | undefined {
	const sig = readSignal(details) ?? (isError ? signalFromErrorContent(content) : undefined);
	if (!sig) return undefined;
	const lines = signalLines(sig, tier, extraLine);
	if (lines.length === 0) return undefined;

	const signalText = `\n${lines.join("\n")}`;
	const out = [...content];
	// 找最后一个文本块（ES2022 无 findLastIndex，手写倒序）。
	let lastTextIdx = -1;
	for (let i = out.length - 1; i >= 0; i--) {
		if (isTextBlock(out[i])) {
			lastTextIdx = i;
			break;
		}
	}
	if (lastTextIdx >= 0) {
		// 不改原对象（纯函数）；替换为新块，正文原样保留在信号行之前。
		const last = out[lastTextIdx] as { type: "text"; text: string };
		out[lastTextIdx] = { type: "text", text: `${last.text}${signalText}` };
	} else {
		// 无文本块（如纯图片/JSON 块）：追加独立文本块，不破坏原块可解析性。
		out.push({ type: "text", text: lines.join("\n") });
	}

	// ⭐ 展开合并（整字段替换陷阱的护栏）：details 的全部既有键（actions/confirmed 等）保留。
	const mergedDetails: Record<string, unknown> =
		typeof details === "object" && details !== null && !Array.isArray(details)
			? { ...(details as Record<string, unknown>), _signal: sig }
			: { _signal: sig };

	return { content: out, details: mergedDetails };
}

/**
 * 副作用对账（§4 ⭐ 判据）：请求数 vs 生效数。请求 5 生效 3 = 部分生效 → 告警行；
 * 完全生效 / 缺任一侧（无法对账）→ undefined 不妄言。
 * requestedCount 由接线层按工具语义从 args 派生（映射表见 result-signal-wiring.ts）。
 */
export function reconcileAffected(
	requestedCount: number | undefined,
	affectedCount: number | undefined,
): string | undefined {
	if (typeof requestedCount !== "number" || typeof affectedCount !== "number") return undefined;
	if (requestedCount === affectedCount) return undefined;
	return `⚠️ 部分生效：请求 ${requestedCount} 项，实际生效 ${affectedCount} 项，建议核对画布实际状态`;
}
