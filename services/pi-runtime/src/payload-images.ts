/**
 * before_payload 图片治理（T2，spec §3.2）。
 *
 * 作用于出站 LLM 请求体（vendor `before_payload` hook 的 `payload`，provider 格式）。
 * 兼容两种内容格式（生产主路径 OpenAI 兼容 + BYOK claude 系 Anthropic 格式），
 * 其余格式原样放行（零变更零拷贝）。
 *
 * 职责（按序）：
 * 1. 单图 base64 > 8MB → 剔除 + 占位（overflow），不炸整请求；
 * 2. 历史图片渐进降级：仅保留最近 `historyRounds` 轮的 image parts，更早的转文本占位
 *    （history_image，成本主闸门）；
 * 3. 本轮优先裁剪：剩余 image parts > maxImages 时，按「当前轮 → 新→旧历史」保留前
 *    maxImages 张，超出降级占位（overflow）——**不得**「取前 4」（那会裁掉本轮新图）；
 * 4. text part > 200k chars → 截断（text_overflow）。
 *
 * 纯函数：不变式为输入 payload 不被 mutate；零变更时 messages 返回原引用。
 */

export type TrimReason = "history_image" | "overflow" | "text_overflow";

export interface Trim {
	reason: TrimReason;
	count: number;
}

export interface TrimResult {
	/** 治理后的 messages（未知格式 / 无 messages 时为 undefined）。 */
	messages: unknown;
	trims: Trim[];
}

const MAX_IMAGE_BASE64 = 8 * 1024 * 1024; // 8MB base64 字符数
const MAX_TEXT_CHARS = 200_000;

function placeholder(label: string): string {
	return `[图片${label} 已从上下文移除，可用 read_document 取回]`;
}

/** 提取 OpenAI data URL 的 base64 部分；非 data URL 视为超大（无法判定，保守剔除）。 */
function openAiImageBase64(url: string): string {
	const m = /^data:[^;]*;base64,(.*)$/s.exec(url ?? "");
	return m ? m[1] : url ?? "";
}

interface NormalizedPart {
	/** 原始 part 对象引用（变更时按此定位替换）。 */
	raw: Record<string, unknown>;
	kind: "text" | "image";
	text?: string;
	/** base64 字符数（仅 image）。 */
	dataLen?: number;
	/** 8MB 超限。 */
	oversize?: boolean;
}

function normalizeParts(content: unknown): NormalizedPart[] | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts: NormalizedPart[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") return undefined;
		const raw = item as Record<string, unknown>;
		const type = raw.type;
		if (type === "text" && typeof raw.text === "string") {
			parts.push({ raw, kind: "text", text: raw.text });
		} else if (type === "image_url" && raw.image_url && typeof raw.image_url === "object") {
			const url = (raw.image_url as Record<string, unknown>).url;
			const b64 = openAiImageBase64(typeof url === "string" ? url : "");
			parts.push({ raw, kind: "image", dataLen: b64.length, oversize: b64.length > MAX_IMAGE_BASE64 });
		} else if (type === "image" && raw.source && typeof raw.source === "object") {
			const src = raw.source as Record<string, unknown>;
			const data = typeof src.data === "string" ? src.data : "";
			parts.push({ raw, kind: "image", dataLen: data.length, oversize: data.length > MAX_IMAGE_BASE64 });
		} else {
			// 未知 part 类型：无法安全治理，整条消息放弃治理（原样放行）。
			return undefined;
		}
	}
	return parts;
}

interface ImageRef {
	msgIdx: number;
	partIdx: number;
	round: number;
	oversize: boolean;
}

export function governImagePayload(payload: unknown, historyRounds: number, maxImages: number): TrimResult {
	const messages = (payload as { messages?: unknown } | null | undefined)?.messages;
	if (!Array.isArray(messages)) return { messages: undefined, trims: [] };

	// 第一遍：归一化 + 轮号（倒序，最后一条 user = 当前轮 0）。
	const normalized: (NormalizedPart[] | undefined)[] = new Array(messages.length);
	const rounds: number[] = new Array(messages.length);
	const images: ImageRef[] = [];
	let round = -1;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i] as Record<string, unknown> | null | undefined;
		const parts = msg ? normalizeParts(msg.content) : undefined;
		normalized[i] = parts;
		rounds[i] = round;
	}
	round = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as Record<string, unknown> | null | undefined;
		if (msg?.role === "user") round += 1;
		rounds[i] = round;
	}
	for (let i = 0; i < messages.length; i++) {
		const parts = normalized[i];
		if (!parts) continue;
		for (let j = 0; j < parts.length; j++) {
			const p = parts[j];
			if (p.kind !== "image") continue;
			images.push({ msgIdx: i, partIdx: j, round: Math.max(rounds[i], 0), oversize: !!p.oversize });
		}
	}

	// 第二遍：决定每个 image part 的去留。
	const remove = new Map<string, string>(); // "msgIdx:partIdx" -> 占位文本
	const trimCounts: Record<TrimReason, number> = { history_image: 0, overflow: 0, text_overflow: 0 };
	const drop = (ref: ImageRef, reason: TrimReason, label: string) => {
		remove.set(`${ref.msgIdx}:${ref.partIdx}`, placeholder(label));
		trimCounts[reason] += 1;
	};

	const survivors: ImageRef[] = [];
	for (const ref of images) {
		if (ref.oversize) {
			drop(ref, "overflow", "（超大图片）");
		} else if (ref.round >= Math.max(historyRounds, 0)) {
			drop(ref, "history_image", labelFor(messages, normalized, ref));
		} else {
			survivors.push(ref);
		}
	}
	// 本轮优先：round 升序，同轮内消息新→旧、part 消息内新→旧。
	survivors.sort((a, b) => a.round - b.round || b.msgIdx - a.msgIdx || b.partIdx - a.partIdx);
	for (const ref of survivors.slice(maxImages)) {
		drop(ref, "overflow", labelFor(messages, normalized, ref));
	}

	// 第三遍：text 截断 + 应用变更（有变更才拷贝消息数组）。
	const textEdits: { msgIdx: number; partIdx: number }[] = [];
	for (let i = 0; i < messages.length; i++) {
		const parts = normalized[i];
		if (!parts) continue;
		for (let j = 0; j < parts.length; j++) {
			const p = parts[j];
			if (p.kind === "text" && (p.text?.length ?? 0) > MAX_TEXT_CHARS) textEdits.push({ msgIdx: i, partIdx: j });
		}
	}
	trimCounts.text_overflow = textEdits.length;

	const changed = remove.size > 0 || textEdits.length > 0;
	if (!changed) return { messages, trims: [] };

	const nextMessages = [...messages];
	for (let i = 0; i < messages.length; i++) {
		const parts = normalized[i];
		if (!parts) continue;
		const hasEdit = [...remove.keys()].some((k) => k.startsWith(`${i}:`)) || textEdits.some((e) => e.msgIdx === i);
		if (!hasEdit) continue;
		const content = (messages[i] as Record<string, unknown>).content;
		const nextContent = [...(content as unknown[])];
		for (let j = 0; j < parts.length; j++) {
			const ph = remove.get(`${i}:${j}`);
			if (ph !== undefined) {
				nextContent[j] = { type: "text", text: ph };
			} else if (textEdits.some((e) => e.msgIdx === i && e.partIdx === j)) {
				nextContent[j] = { type: "text", text: (parts[j].text ?? "").slice(0, MAX_TEXT_CHARS) };
			}
		}
		nextMessages[i] = { ...(messages[i] as Record<string, unknown>), content: nextContent };
	}

	const trims = (Object.keys(trimCounts) as TrimReason[])
		.filter((r) => trimCounts[r] > 0)
		.map((r) => ({ reason: r, count: trimCounts[r] }));
	return { messages: nextMessages, trims };
}

/** 占位标签：从同消息 text parts 里的 `[I{n}=` 标记恢复编号；无标记用空（占位含「图片」）。 */
function labelFor(
	messages: unknown[],
	normalized: (NormalizedPart[] | undefined)[],
	ref: ImageRef,
): string {
	const parts = normalized[ref.msgIdx];
	if (!parts) return "";
	for (const p of parts) {
		if (p.kind !== "text" || !p.text) continue;
		const m = /\[I(\d+)=/.exec(p.text);
		if (m) return ` I${m[1]}`;
	}
	return "";
}
