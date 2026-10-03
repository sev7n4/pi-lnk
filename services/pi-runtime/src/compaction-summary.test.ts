import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	COMPACTION_RETENTION_INSTRUCTIONS,
	missingSummarySections,
	REQUIRED_SECTIONS,
} from "./compaction-summary.js";

const FULL = [
	"## Goal",
	"做成画布",
	"",
	"## Constraints & Preferences",
	"(none)",
	"",
	"## Progress",
	"### Done",
	"x",
	"### In Progress",
	"y",
	"### Blocked",
	"(none)",
	"## Key Decisions",
	"d",
	"## Next Steps",
	"n",
	"## Critical Context",
	"(none)",
].join("\n");

describe("missingSummarySections（审计 #6 必需段白名单）", () => {
	it("8 段齐全 → 空数组；(none) 算段存在", () => {
		assert.deepEqual(missingSummarySections(FULL), []);
	});
	it("缺段 → 按标题列出缺失项", () => {
		const s = FULL.replace("## Key Decisions\nd\n", "").replace("### Blocked\n(none)\n", "");
		assert.deepEqual(missingSummarySections(s), ["### Blocked", "## Key Decisions"]);
	});
	it("split-turn 尾巴整体排除：--- 之后与 <read-files> 块不参与判定", () => {
		const s =
			FULL +
			"\n\n---\n\n**Turn Context (split turn):**\n\n## Original Request\nfoo\n\n<read-files>\na\n</read-files>";
		assert.deepEqual(missingSummarySections(s), []);
	});
	it("标题大小写不敏感匹配（LLM 不保证 EXACT format）", () => {
		assert.deepEqual(missingSummarySections(FULL.replace("## Goal", "## goal")), []);
	});
	it("空摘要 → 全部缺失", () => {
		assert.deepEqual(missingSummarySections(""), [...REQUIRED_SECTIONS]);
	});
});

/**
 * 压缩保留段（Round2 判断 4 / 首轮 P2-1）。
 * vendor `compaction.ts:567` 把它拼成 `\n\nAdditional focus: <本段>` 追加进摘要 prompt——
 * 这是唯一能在不改 vendor 的前提下，让摘要带上"必须跨压缩保留"指令的通道。
 */
describe("COMPACTION_RETENTION_INSTRUCTIONS（压缩保留段 · 领域策略）", () => {
	it("非空且是中文（摘要 prompt 是英文通用模板，追加段必须说中文才有对齐效果）", () => {
		assert.ok(COMPACTION_RETENTION_INSTRUCTIONS.length > 0);
		assert.match(COMPACTION_RETENTION_INSTRUCTIONS, /[一-龥]/);
	});

	it("覆盖 Round2 点名的四类必须跨压缩保留的信息", () => {
		const s = COMPACTION_RETENTION_INSTRUCTIONS;
		assert.match(s, /节点\s*id/, "缺① 画布节点 id");
		assert.match(s, /待.*确认/, "缺② 待用户确认态");
		assert.match(s, /偏好/, "缺③ 用户已确认偏好");
		assert.match(s, /工具(调用)?结论/, "缺④ 本轮关键工具结论");
	});

	it("长度受控：每次压缩都要追加进摘要 prompt，是纯 token 成本", () => {
		assert.ok(COMPACTION_RETENTION_INSTRUCTIONS.length <= 800, "保留段过长，会白烧摘要 token");
	});

	it("不含会污染 vendor prompt 拼接的字符（换行之外要保证可单行嵌入）", () => {
		assert.doesNotMatch(COMPACTION_RETENTION_INSTRUCTIONS, /`/);
		assert.doesNotMatch(COMPACTION_RETENTION_INSTRUCTIONS, /\$\{/);
	});
});
