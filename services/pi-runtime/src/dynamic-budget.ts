/**
 * dynamicBlocks 分类预算（spec §2.1，T3）：
 * 每轮易变块（画布摘要/识图/素材/记忆）按 kind 封顶，超限块内截断 + 尾注，从不整块丢弃。
 *
 * 硬不变式（dynamic-budget.test.ts 钉死）：
 * - byte-stable：输入不变 → 输出逐字节相同（无时间/随机源；截断判定只依赖块内容）
 * - 不超限块零改动直通
 * - 截断块必含截断尾注；尾注承诺按 kind 定制（只有 sidebar 素材承诺 read_document——
 *   画布摘要/识图文本/记忆都不是 attachments，read_document 读不到，M3）
 *
 * Ruling（见 ledger）：只做 kind 层封顶，不做二次总量闸——份额和 ≤1.0，kind 封顶已把
 * 膨胀限制在 O(totalChars)；二次截断会显著复杂化截断方向策略，无观测数据前不引入。
 * general（真未知标记）份额 0：只享 MIN_BLOCK_CHARS 保底，且计 unknown_kind 告警。
 */

export type BlockKind = "canvas" | "vision" | "sidebar" | "memory" | "general";

/** kind → 占总预算比例（canvas 55% + vision 25% + sidebar 10% + memory 10% = 1.0；general 0=只享保底）。 */
const DEFAULT_SHARES: Record<BlockKind, number> = {
	canvas: 0.55,
	vision: 0.25,
	sidebar: 0.1,
	memory: 0.1,
	general: 0,
};

/** 每块保底长度（chars）：份额耗尽/无份额时仍保一小段，从不整块丢弃（spec §2.1 业务下限）。 */
const MIN_BLOCK_CHARS = 80;

/** 尾注按 kind 定制（M3）：只有 sidebar（素材=attachments）可承诺 read_document 取回。 */
export function truncationNote(kind: BlockKind, n: number): string {
	if (kind === "sidebar") return `\n\n（本段已截断 ${n} 字，可用 read_document 取回全文）`;
	if (kind === "canvas") return `\n\n（本段已截断 ${n} 字，可刷新画布或缩小画布范围获取最新摘要）`;
	return `\n\n（本段已截断 ${n} 字）`;
}

/**
 * 块首标记识别 kind。
 * ⚠️ 标记 = 真实生产约定（C1 hotfix，勿改回占位标记）：
 * - canvas: pi-prompt-assembler.service.ts `当前画布摘要：\n{JSON}`
 *         + agent.service.ts `【用户当前选中】`（SEL-REF digest 块，R-S6）
 * - vision: sidebar-vision.ts `【侧栏参考图解析】`（全角括号）
 * - sidebar: sidebar-block.ts `侧栏参考素材：`（I1=... 是块内行格式，不是块首）
 * - memory: agent.service.ts `## 长期记忆（用户历史偏好，供参考）`
 * 未识别 → general（份额 0，只享保底；由调用方计 unknown_kind 告警）。
 */
export function classifyBlock(block: string): BlockKind {
	const t = block.trimStart();
	if (t.startsWith("当前画布摘要")) return "canvas";
	if (t.startsWith("【用户当前选中】")) return "canvas";
	if (t.startsWith("【侧栏参考图解析】")) return "vision";
	if (t.startsWith("侧栏参考素材")) return "sidebar";
	if (t.startsWith("## 长期记忆")) return "memory";
	return "general";
}

export interface BudgetOptions {
	totalChars: number;
	shares?: Partial<Record<BlockKind, number>>;
}

export interface BudgetResult {
	blocks: string[];
	/** 发生截断的块数（按 kind 计）。 */
	dropped: Record<BlockKind, number>;
}

export function applyDynamicBudget(blocks: readonly string[], opts: BudgetOptions): BudgetResult {
	const shares = { ...DEFAULT_SHARES, ...(opts.shares ?? {}) };
	const dropped: Record<BlockKind, number> = { canvas: 0, vision: 0, sidebar: 0, memory: 0, general: 0 };
	const used: Record<BlockKind, number> = { canvas: 0, vision: 0, sidebar: 0, memory: 0, general: 0 };

	const out = blocks.map((block) => {
		if (block.trim().length === 0) return block; // 空块原样（不进预算、不计数）
		const kind = classifyBlock(block);
		const cap = Math.max(MIN_BLOCK_CHARS, Math.floor(opts.totalChars * shares[kind]));
		const remain = cap - used[kind];
		const allow = Math.max(MIN_BLOCK_CHARS, remain);
		if (block.length <= allow) {
			used[kind] += block.length;
			return block;
		}
		// 超限截断：canvas=保头保尾掐中段（新节点按时间追加在尾部）；其余保头部。
		const noteBudget = 120;
		// I1：正文保底 ≥ min(MIN_BLOCK_CHARS, 原长)——份额耗尽后后续块不再退化成 1 字符。
		const body = Math.max(Math.min(MIN_BLOCK_CHARS, block.length), allow - noteBudget);
		let truncated: string;
		if (kind === "canvas") {
			const headLen = Math.floor(body * 0.7);
			const tailLen = Math.max(0, body - headLen);
			truncated = block.slice(0, headLen) + block.slice(block.length - tailLen);
		} else {
			truncated = block.slice(0, body);
		}
		const cut = block.length - truncated.length;
		used[kind] += truncated.length;
		dropped[kind] += 1;
		return truncated + truncationNote(kind, cut);
	});

	return { blocks: out, dropped };
}
