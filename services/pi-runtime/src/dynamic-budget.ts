/**
 * dynamicBlocks 分类预算（spec §2.1，T3）：
 * 每轮易变块（画布摘要/识图/素材）按 kind 封顶，超限块内截断 + 尾注，从不整块丢弃。
 *
 * 硬不变式（dynamic-budget.test.ts 钉死）：
 * - byte-stable：输入不变 → 输出逐字节相同（无时间/随机源；截断判定只依赖块内容）
 * - 不超限块零改动直通
 * - 截断块必含 read_document 尾注
 *
 * Ruling（见 ledger）：只做 kind 层封顶，不做二次总量闸——默认份额和 1.05 是上界，
 * kind 封顶已把膨胀限制在 O(totalChars)；二次截断会显著复杂化截断方向策略，无观测
 * 数据前不引入。
 */

export type BlockKind = "canvas" | "vision" | "sidebar" | "general";

/** kind → 占总预算比例（spec §2.1：画布 ≤60%、识图 ≤25%、素材 ≤15%；general 兜底 5%）。 */
const DEFAULT_SHARES: Record<BlockKind, number> = {
	canvas: 0.6,
	vision: 0.25,
	sidebar: 0.15,
	general: 0.05,
};

/** 每块保底长度（chars）：份额耗尽后仍保一小段，从不整块丢弃（spec §2.1 业务下限）。 */
const MIN_BLOCK_CHARS = 80;

export function truncationNote(n: number): string {
	return `\n\n（本段已截断 ${n} 字，可用 read_document 取回全文）`;
}

/** 块首标记识别 kind（约定见 sidebar-block.ts / assembleDynamic 产出；未识别 → general 兜底）。 */
export function classifyBlock(block: string): BlockKind {
	const t = block.trimStart();
	if (t.startsWith("[画布快照")) return "canvas";
	if (/^\[I\d+=/.test(t)) return "vision";
	if (t.startsWith("[侧栏素材")) return "sidebar";
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
	const dropped: Record<BlockKind, number> = { canvas: 0, vision: 0, sidebar: 0, general: 0 };
	const used: Record<BlockKind, number> = { canvas: 0, vision: 0, sidebar: 0, general: 0 };

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
		const noteBudget = 120; // 尾注上界余量
		const body = Math.max(1, allow - noteBudget);
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
		return truncated + truncationNote(cut);
	});

	return { blocks: out, dropped };
}
