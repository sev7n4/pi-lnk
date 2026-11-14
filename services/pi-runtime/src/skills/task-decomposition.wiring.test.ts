import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { discoverSkills } from "./loader.js";

const SKILLS_ROOT = fileURLToPath(new URL("../../../../skills", import.meta.url));

/** Skill SOP 接线守卫（spec 2026-11-13-skill-sop-task-decomposition-design.md §4，
 * 仿 html-craft.wiring 先例）：装了但路由不到 = 重演 tool_search/ecommerce 触发率 0
 * 的失效（description 缺触发词 → load_skill 0 调用 → 指引不进上下文）。 */
describe("task-decomposition skill wiring", () => {
	it("discoverSkills 含 task-decomposition 且 description 含触发词族", () => {
		const entries = discoverSkills(SKILLS_ROOT);
		const entry = entries.find((e) => e.name === "task-decomposition");
		assert.ok(entry, "task-decomposition 未被 loader 发现（检查目录名/frontmatter name）");
		// §13.2 时序悖论缓解①：description 关键词化是生命线（触发词族覆盖生产话术形态）
		for (const word of ["多步", "规划", "方案", "任务清单", "一步步"]) {
			assert.ok(entry.description.includes(word), `description 缺触发词: ${word}`);
		}
	});
	it("loader 解析的 description 完整（> 折叠生效，含强制边界句）", () => {
		const entries = discoverSkills(SKILLS_ROOT);
		const entry = entries.find((e) => e.name === "task-decomposition");
		assert.ok(entry, "task-decomposition 未被 loader 发现");
		assert.ok(
			entry.description.length > 100,
			`loader 解析的 description 被截断（length=${entry.description.length}）：${entry.description}`,
		);
		assert.ok(entry.description.includes("不适用"), "description 缺不适用边界句");
	});
	it("正文含判据映射纪律关键句（spec §3 映射表，防 SKILL.md 被无意改写丢纪律）", () => {
		const body = readFileSync(
			new URL("../../../../skills/task-decomposition/SKILL.md", import.meta.url),
			"utf8",
		);
		for (const needle of [
			"propose_plan", // 纪律 3（Q1）
			"至多 6 项", // 纪律 2（Q2 maxItems）
			"全量覆写", // 纪律 4（Q3）
			"id", // 纪律 5（A-2' 契约）
			"空数组清空", // 纪律 6（Q3 收尾）
			"不许标 completed", // 纪律 6（c1b-struct-02）
			"子代理", // 纪律 7（Q4 观测）
		]) {
			assert.ok(body.includes(needle), `SKILL.md 缺判据映射纪律: ${needle}`);
		}
	});
	it("C-2a 最小教学：纪律 6 含 acceptance 声明关键句（防写入率趋零）", () => {
		const body = readFileSync(
			new URL("../../../../skills/task-decomposition/SKILL.md", import.meta.url),
			"utf8",
		);
		for (const needle of ["acceptance", 'kind:"generation"', "requireSucceeded", "证据不足会被工具拒绝"]) {
			assert.ok(body.includes(needle), `SKILL.md 缺 C-2a 教学关键句: ${needle}`);
		}
	});
	it("C-2b 最小教学：纪律 6 含 canvas_state 声明句与两类节点边界", () => {
		const body = readFileSync(
			new URL("../../../../skills/task-decomposition/SKILL.md", import.meta.url),
			"utf8",
		);
		for (const needle of ['kind:"canvas_state"', "nodeCount", "nodeTypeCounts", "分镜 shot 类节点不计入"]) {
			assert.ok(body.includes(needle), `SKILL.md 缺 C-2b 教学关键句: ${needle}`);
		}
	});
});
