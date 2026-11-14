import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { discoverSkills } from "./loader.js";

const SKILLS_ROOT = fileURLToPath(new URL("../../../../skills", import.meta.url));

/** 刀C（spec 2026-11-14-subagent-contract-d2-nonblock-design.md §5）skill 接线守卫：
 *  research-delegate 必须能被 loader 发现且 description 含触发词——装了但路由不到 =
 *  重演 tool_search / spawn_subagent 激活率为 0 的失效（点名缺失家族，B-4 教训）。 */
describe("research-delegate skill wiring", () => {
	it("discoverSkills 含 research-delegate 且 description 含触发词族", () => {
		const entries = discoverSkills(SKILLS_ROOT);
		const entry = entries.find((e) => e.name === "research-delegate");
		assert.ok(entry, "research-delegate 未被 loader 发现（检查目录名/frontmatter name）");
		for (const word of ["调研", "研究", "探索", "spawn_subagent", "不适用"]) {
			assert.ok(entry.description.includes(word), `description 缺触发词: ${word}`);
		}
	});
	it("loader 解析的 description 完整（>100 字，防 parseSimpleYaml 截断回归）", () => {
		const entries = discoverSkills(SKILLS_ROOT);
		const entry = entries.find((e) => e.name === "research-delegate");
		assert.ok(entry, "research-delegate 未被 loader 发现");
		assert.ok(
			entry.description.length > 100,
			`loader 解析的 description 被截断（length=${entry.description.length}）：${entry.description}`,
		);
	});
	it("正文含硬约束关键句（三段写法/报告形态/mode/来源标注/写操作不派）", () => {
		const body = readFileSync(new URL("../../../../skills/research-delegate/SKILL.md", import.meta.url), "utf8");
		for (const needle of [
			"background",
			"reportFormat",
			"collect_subagent_result",
			"【期望报告形态】",
			"改画布",
			"来源",
		]) {
			assert.ok(body.includes(needle), `SKILL.md 缺关键约束: ${needle}`);
		}
	});
});
