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
