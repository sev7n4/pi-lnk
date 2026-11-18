import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import { buildSkillResources } from "./resources.js";
import type { SkillIndexEntry } from "./loader.js";

/** M0 W1（规格 v2 §7.3/§8）：registry entries → 上游 `Skill[]` 的唯一转换层。
 *  content=正文内联（U-1）、filePath=`<dir>/SKILL.md`、空集 `[]`、body 缺失=`""`。
 *  禁自建等价物（§4.8）：只做转换，不做解析/裁剪/签名。 */

const entry = (name: string, dir = `/app/skills/${name}`): SkillIndexEntry => ({
	skillId: name,
	name,
	description: `desc of ${name}`,
	dir,
});

describe("buildSkillResources", () => {
	it("转换：content=loadBody 正文、description/name 透传、filePath=dir/SKILL.md", () => {
		const out = buildSkillResources([entry("alpha")], (n) => (n === "alpha" ? "# ALPHA BODY" : undefined));
		assert.equal(out.skills.length, 1);
		const s = out.skills[0];
		assert.equal(s.name, "alpha");
		assert.equal(s.description, "desc of alpha");
		assert.equal(s.content, "# ALPHA BODY");
		assert.equal(s.filePath, "/app/skills/alpha/SKILL.md");
	});

	it("空集 → { skills: [] }（formatter 空集返空串的前提）", () => {
		assert.deepEqual(buildSkillResources([], () => undefined).skills, []);
	});

	it("body 缺失 → content=''（不产出 undefined 正文）", () => {
		const out = buildSkillResources([entry("ghost")], () => undefined);
		assert.equal(out.skills[0].content, "");
	});

	it("disableModelInvocation 透传（上游 filter 消费，宿主不自己过滤）", () => {
		const out = buildSkillResources([entry("alpha")], () => "B");
		assert.equal((out.skills[0] as { disableModelInvocation?: boolean }).disableModelInvocation, undefined);
	});

	// ── G3（2026-11-18）：宿主镜像 → 上游 Skill[] → formatter 原生过滤 ──
	it("G3-A2: disableModelInvocation=true 映射到上游 Skill，formatSkillsForSystemPrompt 原生从隐式 index 过滤", () => {
		const visible = entry("visible-skill");
		const hidden: SkillIndexEntry = { ...entry("hidden-skill"), disableModelInvocation: true };
		const out = buildSkillResources([visible, hidden], () => "B");
		const hiddenSkill = out.skills.find((s) => s.name === "hidden-skill")!;
		assert.equal((hiddenSkill as { disableModelInvocation?: boolean }).disableModelInvocation, true);

		// 上游 formatter 原生过滤：隐式 index 不含 hidden，仍含 visible
		const index = formatSkillsForSystemPrompt(out.skills);
		assert.ok(index.includes("visible-skill"), "可见技能仍在 index");
		assert.ok(!index.includes("hidden-skill"), "disable 技能不得进入隐式 index");
	});

	it("G3-A3: 被过滤的技能 content 仍在 resources（lane.skill 显式调用通路不关）", () => {
		const hidden: SkillIndexEntry = { ...entry("hidden-skill"), disableModelInvocation: true };
		const out = buildSkillResources([hidden], () => "# HIDDEN BODY");
		// 显式调用消费的是 resources.skills 全量，不是 formatter 输出——正文必须保留
		assert.equal(out.skills.find((s) => s.name === "hidden-skill")!.content, "# HIDDEN BODY");
		assert.equal(formatSkillsForSystemPrompt(out.skills), "", "全部 disable 时隐式 index 为空串（上游语义）");
	});
});
