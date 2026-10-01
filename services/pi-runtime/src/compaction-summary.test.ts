import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { missingSummarySections, REQUIRED_SECTIONS } from "./compaction-summary.js";

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
