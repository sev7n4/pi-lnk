/**
 * 压缩保留段（Round 2 §01 判断 4 / 路线图 W2①）。
 *
 * ## 为什么需要它
 *
 * vendor 的摘要骨架是英文通用 Markdown（`compaction.ts:420-455`：
 * Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context），
 * 为编码助手写的。它**不可能知道**本项目的领域状态里什么必须活过压缩：
 *
 * -哪些画布节点正等着用户确认（`propose_generation` 已调用但用户没点）
 * - 用户已明确确认过的偏好（下一轮不能又问一遍）
 * - 本轮已经跑过的关键工具结论（避免压缩后重复调�� / 谎称已执行）
 *
 * 宿主侧原有的 `compaction-summary.ts` 只有**事后白名单告警**权（缺段只计数不阻断），
 * 属于「发现摘要坏了」而不是「让摘要别坏」。
 *
 * ## 为什么走 `customInstructions`
 *
 * `lane.compact({ customInstructions })` 通道端到端已通：customInstructions 被拼成
 * `\n\nAdditional focus: ${customInstructions}` 追加进摘要 prompt（`compaction.ts:567`），
 * 分支摘要同理（`branch-summarization.ts:256-259`）。
 * 换骨架要 fork vendor（触碰 D-γ' 红线），**追加 focus 是唯一合法手段**。
 *
 * ⚠️ 已知边界：保留段只能**追加**，不能替换摘要骨架 ⇒ vendor 摘要仍是英文。
 * 这是产品决策（要中文骨架就得 fork vendor），不是本模块能解决的。
 *
 * ## 为什么不直接内联字符串常量
 *
 * 因为它要随会话状态变化（待确认节点 id 每轮不同），且**必须可测**：
 * 截断上限、id 清洗（防止伪造 `## Key Decisions` 污染白名单校验）都是容易写错的边界。
 */

/** 保留策略版本。改动内容时必须同步 bump——否则压缩后无法归因是哪一版策略产出的摘要。 */
export const RETENTION_INSTRUCTIONS_VERSION = "2026.10.04-1";

/**
 * 单段最多列出的条目数。
 *
 * vendor 对 customInstructions **只追加不截断**（`compaction.ts:568` 直接模板拼接），
 * 所以这里不设上限的话，一个 50 节点的长会话会把摘要 prompt 撑大，
 * 而压缩本身正是为省token 触发的——等于反向操作。
 */
const MAX_ITEMS = 8;

/** 单条最大长度，防止超长工具结果文本吃掉预算。 */
const MAX_ITEM_LEN = 120;

export interface RetentionState {
	/** 正等待用户确认的画布节点 id（`propose_generation` 已调用、用户未点确认）。 */
	pendingConfirmNodeIds?: string[];
	/** 用户已明确确认过的偏好（下一轮不该重复追问）。 */
	confirmedPreferences?: string[];
	/** 本轮已得出的关键工具结论（压缩后不应重复调用或谎称已执行）。 */
	keyToolConclusions?: string[];
}

/**
 * 清洗单条：裁首尾空白、压掉换行与连续空白、截断。
 *
 * 🔴 换行必须压掉：条目会被拼进摘要 prompt，一个含 `\n## Key Decisions` 的节点 id
 * 就能伪造出一个必需段标题，让 `missingSummarySections` 的白名单校验**假绿**。
 * 这不是洁癖，是防止结构化状态被注入污染校验器。
 */
function sanitizeItem(raw: string): string {
	const flat = raw.replace(/\s+/g, " ").trim();
	return flat.length > MAX_ITEM_LEN ? `${flat.slice(0, MAX_ITEM_LEN)}…` : flat;
}

/** 取前N 条并汇报被省略的条数（让模型知道「还有」而不是以为只有这些）。 */
function renderList(items: string[], label: string): string | undefined {
	const cleaned = items.map(sanitizeItem).filter((s) => s.length > 0);
	if (cleaned.length === 0) return undefined;
	const shown = cleaned.slice(0, MAX_ITEMS);
	const rest = cleaned.length - shown.length;
	const lines = shown.map((s) => `  - ${s}`);
	if (rest > 0) lines.push(`  - …还有 ${rest} ${label}（未逐一列出）`);
	return lines.join("\n");
}

/**
 * 生成中文领域保留策略，作为 `lane.compact({ customInstructions })` 的值。
 *
 * ⭐ **恒返回非空字符串**（即使无任何状态）：空串会被 vendor 判为 falsy 而走原生路径，
 * 保留段就静默失效了——而这正是本模块要根治的「看起来做了、实际没做」的形态。
 * 无状态时返回的是通用兜底要求，仍有语义价值（要求摘要保住目标与待确认项）。
 */
export function buildRetentionInstructions(state: RetentionState = {}): string {
	const parts: string[] = [
		`以下领域状态必须跨压缩保留（保留策略 v${RETENTION_INSTRUCTIONS_VERSION}）：`,
	];

	const nodes = renderList(state.pendingConfirmNodeIds ?? [], "个节点");
	parts.push(
		nodes
			? `1. 待用户确认的画布节点（已 propose_generation，用户尚未确认）：\n${nodes}\n   → 下一轮不要重复创建节点，也不要声称已生成。`
			: "1. 待用户确认的画布节点：若上文提到任何已 propose 但未确认的节点，保留其节点 id 与用途。",
	);

	const prefs = renderList(state.confirmedPreferences ?? [], "条偏好");
	parts.push(
		prefs
			? `2. 用户已确认的偏好：\n${prefs}\n   → 下一轮直接遵守，不要重复追问。`
			: "2. 用户已确认的偏好：上文出现的用户明确要求（比例/构图/风格等）必须保留。",
	);

	const conclusions = renderList(state.keyToolConclusions ?? [], "条结论");
	parts.push(
		conclusions
			? `3. 本轮已得出的关键工具结论：\n${conclusions}\n   → 不要重复调用已完成的工具，更不要谎称未执行的操作已完成。`
			: "3. 本轮已得出的关键工具结论：保留「已调用了什么、等谁确认」的事实，不要重复调用。",
	);

	return parts.join("\n");
}
