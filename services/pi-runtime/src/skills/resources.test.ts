import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
});
