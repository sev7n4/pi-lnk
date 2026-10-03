/**
 * 只读可视投影（tier="present"）的统一返回构造器。
 *
 * ⚠️ `canvasCommands` **必须**在 `details` 下：Nest 侧 `extractCanvasCommands`
 * 只从 `tool_execution_end.result.details.canvasCommands` / `tool_execution_update
 * .partialResult.details.canvasCommands` 提取（apps/server/src/agent/pi-runtime/
 * pi-events.ts:297-326）。放回 content 会被模型当文本读、卡片不落屏——
 * 与 `result-with-actions.ts` 文件头记录的 PR #65 同款失败模式。
 */
import type { SvgCardPayload } from "./types-payload.js";

/** SVG 长度上界：超了截断并在 details 显式回报，防超长撑爆气泡。 */
export const SVG_MAX_CHARS = 20000;

export function presentResult(payload: SvgCardPayload): {
	content: [{ type: "text"; text: string }];
	details: { ok: true; canvasCommands: SvgCardPayload[]; truncated?: boolean };
} {
	const truncated = payload.svg.length > SVG_MAX_CHARS;
	const svg = truncated ? payload.svg.slice(0, SVG_MAX_CHARS) : payload.svg;
	const clipped: SvgCardPayload = { ...payload, svg };
	const details: {
		ok: true;
		canvasCommands: SvgCardPayload[];
		truncated?: boolean;
	} = { ok: true, canvasCommands: [clipped] };
	if (truncated) details.truncated = true;
	return {
		content: [{ type: "text", text: JSON.stringify({ ok: !truncated, canvasCommands: [clipped] }) }],
		details,
	};
}
