import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { discoverSkills } from "./loader.js";

const SKILLS_ROOT = fileURLToPath(new URL("../../../../skills", import.meta.url));

/** 规格 §10 skill 接线守卫：html-craft 必须能被 loader 发现且描述含触发词——
 *  装了但路由不到 = 重演 tool_search 触发率为 0 的失效（observeSkillLoad 无样本可观测）。 */
describe("html-craft skill wiring", () => {
	it("discoverSkills 含 html-craft 且描述含触发词", () => {
		const entries = discoverSkills(SKILLS_ROOT);
		const entry = entries.find((e) => e.name === "html-craft");
		assert.ok(entry, "html-craft 未被 loader 发现（检查目录名/frontmatter name）");
		for (const word of ["网页", "原型", "HTML"]) {
			assert.ok(entry.description.includes(word), `description 缺触发词: ${word}`);
		}
	});
	it("loader 解析的 description 完整（>-> 折叠生效，含强制加载句与不适用边界）", () => {
		// 守卫 parseSimpleYaml 截断回归：frontmatter 若退回多行 plain scalar，
		// description 会截断到首行（~38 字符），路由索引丢失强制加载句与不适用边界。
		const entries = discoverSkills(SKILLS_ROOT);
		const entry = entries.find((e) => e.name === "html-craft");
		assert.ok(entry, "html-craft 未被 loader 发现");
		assert.ok(
			entry.description.length > 100,
			`loader 解析的 description 被截断（length=${entry.description.length}）：${entry.description}`,
		);
		assert.ok(entry.description.includes("必须先加载本 skill"), "description 缺强制加载句");
		assert.ok(entry.description.includes("不适用"), "description 缺不适用边界");
	});
	it("正文含环境硬约束关键句（CSP 白名单/图片禁外链/弹窗失效/数据边界）", () => {
		const body = readFileSync(new URL("../../../../skills/html-craft/SKILL.md", import.meta.url), "utf8");
		for (const needle of [
			"cdnjs.cloudflare.com",
			"远程图片",
			"alert / confirm / prompt",
			"取不到的字段一律不写、不编造",
			// 规格 §10 的「先 load_skill html-craft」线索归 set_node_text 工具描述守卫（§10 #212）；
			// 逐字 SKILL.md 不含字面 load_skill，此处以 description 逐字句守卫同意图。
			"必须先加载本 skill",
		]) {
			assert.ok(body.includes(needle), `SKILL.md 缺关键约束: ${needle}`);
		}
	});
});
