/**
 * 只读可视投影（tier="present"）的统一返回构造器。
 *
 * ⚠️ `canvasCommands` **必须**在 `details` 下：Nest 侧 `extractCanvasCommands`
 * 只从 `tool_execution_end.result.details.canvasCommands` / `tool_execution_update
 * .partialResult.details.canvasCommands` 提取（apps/server/src/agent/pi-runtime/
 * pi-events.ts:297-326）。放回 content 会被模型当文本读、卡片不落屏——
 * 与 `result-with-actions.ts` 文件头记录的 PR #65 同款失败模式。
 * 故 `content` 只回摘要（`type` / `title` / `bytes` / `truncated`），**不回载荷本体**。
 *
 * 语义约定：`ok` 恒为 true（工具本身成功执行）。截断只经 `truncated` 表达、**不复用 `ok`**
 * ——本项目里 `ok:false` 一律读作「工具失败、agent 该重试」，而截断不是失败。
 */
import type { SvgCardPayload } from "./types-payload.js";

/**
 * SVG 长度上界：超界的载荷被**整块丢弃**（`svg: ""` + `truncated: true`），前端降级为 `pre` 占位。
 *
 * 不做部分渲染是有意的：`slice` 会从标签/属性中间切断并丢掉 `</svg>`，产出无法解析的
 * XML，下游渲染卡拿到就崩。本构造器是通用载荷容器、**不解析 SVG 结构**；保证产物
 * 良构是 Task 2 各 `build*` 函数的职责（它们应在界内产出良构 SVG）。
 */
export const SVG_MAX_CHARS = 20000;

export function presentResult(payload: SvgCardPayload): {
	content: [{ type: "text"; text: string }];
	details: { ok: true; canvasCommands: SvgCardPayload[]; truncated?: boolean };
} {
	const truncated = payload.svg.length > SVG_MAX_CHARS;
	const svg = truncated ? "" : payload.svg;
	const clipped: SvgCardPayload = { ...payload, svg };
	const details: {
		ok: true;
		canvasCommands: SvgCardPayload[];
		truncated?: boolean;
	} = { ok: true, canvasCommands: [clipped] };
	if (truncated) details.truncated = true;
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					ok: true,
					type: payload.type,
					...(payload.title ? { title: payload.title } : {}),
					bytes: clipped.svg.length,
					truncated,
				}),
			},
		],
		details,
	};
}
