/**
 * 侧栏参考素材块（#12）。key 分配 1:1 平移
 * services/agent-runtime/app/graph/sidebar_attachments.py:29-43（T/I/V/A 按 mediaType 计数）。
 * vision 解析块（_PARSE_FAIL_NO_EMPTY_LISTING 等）明确后置，见审计 §4。
 */

export interface SidebarBlockInput {
	url?: string;
	text?: string;
	mediaType?: string;
}

const REF_PREFIX: Record<string, string> = { text: "T", image: "I", video: "V", audio: "A" };

export function assignSidebarRefKeys(attachments: Array<{ mediaType?: string }>): string[] {
	const counters: Record<string, number> = {};
	const keys: string[] = [];
	for (const item of attachments) {
		const mediaType = (item.mediaType ?? "").trim();
		const prefix = REF_PREFIX[mediaType];
		if (!prefix) continue;
		counters[mediaType] = (counters[mediaType] ?? 0) + 1;
		keys.push(`${prefix}${counters[mediaType]}`);
	}
	return keys;
}

function labelOf(item: SidebarBlockInput): string {
	const text = (item.text ?? "").trim();
	if (text) return text;
	const url = (item.url ?? "").split("?")[0].split("#")[0];
	const parts = url.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? url;
}

/** F6：text 素材截断（老链路侧栏块无截断，此处按评审建议收口为 200 字上限）。 */
const TEXT_LABEL_MAX = 200;

function labelOf(item: SidebarBlockInput): string {
	const text = (item.text ?? "").trim();
	if (text) return text.slice(0, TEXT_LABEL_MAX);
	const url = (item.url ?? "").split("?")[0].split("#")[0];
	const parts = url.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? url;
}

export function buildSidebarBlock(attachments: SidebarBlockInput[]): string {
	if (!attachments.length) return "";
	// F2：先过滤合法 mediaType 再 zip keys（未知 mediaType 直接跳过，避免 index 错位）
	const valid = attachments.filter((item) => Boolean(REF_PREFIX[(item.mediaType ?? "").trim()]));
	if (!valid.length) return "";
	const keys = assignSidebarRefKeys(valid);
	const lines = ["侧栏参考素材："];
	valid.forEach((item, i) => {
		if (keys[i]) lines.push(`${keys[i]}=${labelOf(item)}`);
	});
	return lines.join("\n");
}
