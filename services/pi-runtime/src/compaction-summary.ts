/**
 * 压缩摘要必需段白名单校验（审计 #6）。
 *
 * vendor SUMMARIZATION_PROMPT（compaction.ts:424-455）要求 EXACT format：
 * 8 段 = H2×6（Goal / Constraints & Preferences / Progress / Key Decisions /
 * Next Steps / Critical Context）+ Progress 下 H3×3（Done / In Progress / Blocked）。
 * 空段约定 `(none)`；split-turn 摘要以 `---` 追加 Turn Context 段（标题为
 * Original Request / Early Progress / Context for Suffix，不属于必需段）；
 * 末尾可能追加 <read-files>/<modified-files> XML 块。
 *
 * 纯观测告警：缺失只计数不阻断（host 无权干预 vendor 摘要生成）。
 */
export const REQUIRED_SECTIONS = [
	"## Goal",
	"## Constraints & Preferences",
	"### Done",
	"### In Progress",
	"### Blocked",
	"## Key Decisions",
	"## Next Steps",
	"## Critical Context",
] as const;

/**
 * 压缩保留段（Round2 判断 4 / 首轮 P2-1）——喂给 `lane.compact({customInstructions})` 的领域策略。
 *
 * 通道：vendor `lane.ts:1204` 只在字段 !== undefined 时透传，`compaction.ts:567` 拼成
 * `\n\nAdditional focus: <本段>` 追加进摘要 prompt。这是唯一能在不改 vendor 的前提下让摘要
 * 带上"必须跨压缩保留"指令的手段——换摘要骨架要 fork vendor，触碰 D-γ'（vendor 只读）。
 *
 * 为什么必须有这一段：vendor 默认模板（compaction.ts:424-455）是**为编码助手写的**，
 * 结尾只要求"保留精确的文件路径、函数名、报错信息"。画布会话里真正一丢就出事的东西
 * （节点 id、待确认态、用户偏好、工具结论）在默认指令里一个都没有 ⇒ 压完就漂移。
 *
 * ⚠️ 这是**追加 focus**，不是替换骨架。中文生产会话仍可能产出英文摘要，那是另一个
 * 需要单独决策的产品问题（Round2 已把它列入"明确不做清单"）。
 *
 * 长度约束：每次压缩都要把整段拼进摘要 prompt，是纯 token 成本 ⇒ 控制在 800 字符内。
 * 内容约束：不得含反引号 / `${`（会被 vendor 的模板拼接当成替换语法）。
 */
export const COMPACTION_RETENTION_INSTRUCTIONS = [
	"这是一个画布创作助手的会话，压缩会丢掉细节历史。写摘要时必须显式保留以下四类信息，缺失任一类都会让后续回合做出错误动作：",
	"1. 画布节点 id：已创建、已修改、已引用的每个节点的 id 及其当前含义，不要用「某个节点」这类代词替代 id；",
	"2. 待用户确认态：哪些产出仍在等待用户点头、等待的具体内容是什么，以及上一轮向用户提出的建议；",
	"3. 用户已确认的偏好：本轮明确说过的构图、配色、比例、语气、格式等要求及其适用范围；",
	"4. 本轮关键工具结论：工具调用返回的成功或失败事实，尤其是生成类工具的 record_id、失败原因与报错原文要点。",
	"其余内容按通用摘要结构压缩，不要因为上述四类而挤压掉常规段落。",
].join("\n");

/** 主摘要体：砍掉 `---` 分隔的 split-turn 尾巴（Turn Context 段标题不算必需段）。 */
function mainBody(summary: string): string {
	return summary.split(/\n-{3,}\n/)[0] ?? summary;
}

export function missingSummarySections(summary: string): string[] {
	const found = new Set<string>();
	for (const line of mainBody(summary).split(/\r?\n/)) {
		const m = line.match(/^(#{2,3})\s+(.+?)\s*$/);
		if (m) found.add(`${m[1]} ${m[2]}`.toLowerCase());
	}
	return REQUIRED_SECTIONS.filter((s) => !found.has(s.toLowerCase()));
}
