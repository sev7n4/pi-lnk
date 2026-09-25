import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSkillIndexBlock, discoverSkills, loadSkill } from "./loader.js";
import { createSkillTools } from "../tools/skill-tool.js";
import { Metrics } from "../metrics.js";
import type { LnkpiTool } from "../tools/types.js";

/** 对齐 harness execute 六参签名（同 skill-tool.test.ts 的调用方式）。 */
async function run(tool: LnkpiTool, params: unknown) {
	return tool.execute!(
		"t1",
		params as never,
		() => {},
		{ sessionId: "s1" } as never,
		{} as never,
		undefined as never,
	);
}

function makeSkill(root: string, dirName: string, frontmatter: string, body = "正文内容。"): string {
	const dir = join(root, dirName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
	return dir;
}

test("discovers valid skills with name and description", () => {
	const root = mkdtempSync(join(tmpdir(), "skills-"));
	makeSkill(root, "good-skill", 'name: good-skill\ndescription: "做某事。当用户要求某事时使用。"');
	const entries = discoverSkills(root);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].name, "good-skill");
	assert.equal(entries[0].skillId, "good-skill");
	rmSync(root, { recursive: true, force: true });
});

test("skips invalid skill dirs without throwing (missing description)", () => {
	const root = mkdtempSync(join(tmpdir(), "skills-"));
	makeSkill(root, "bad-skill", "name: bad-skill");
	makeSkill(root, "good-skill", 'name: good-skill\ndescription: "ok"');
	assert.equal(discoverSkills(root).length, 1); // 坏的跳过，好的仍在
	rmSync(root, { recursive: true, force: true });
});

test("skips skill whose name != dir name and over-length description", () => {
	const root = mkdtempSync(join(tmpdir(), "skills-"));
	makeSkill(root, "dir-a", 'name: other-name\ndescription: "x"');
	makeSkill(root, "dir-b", `name: dir-b\ndescription: "${"长".repeat(1025)}"`);
	assert.equal(discoverSkills(root).length, 0);
	rmSync(root, { recursive: true, force: true });
});

test("missing root returns empty array", () => {
	assert.deepEqual(discoverSkills("/nonexistent-skills-dir-xyz"), []);
});

test("buildSkillIndexBlock empty when no entries", () => {
	assert.equal(buildSkillIndexBlock([]), "");
});

test("loadSkill returns body", () => {
	const root = mkdtempSync(join(tmpdir(), "skills-"));
	makeSkill(root, "sk1", 'name: sk1\ndescription: "d"', "## 步骤\n1. 先做 A");
	const [entry] = discoverSkills(root);
	const loaded = loadSkill(entry);
	assert.equal(loaded.body, "## 步骤\n1. 先做 A");
	rmSync(root, { recursive: true, force: true });
});

test("drop-in 验收：第三方 Anthropic 格式 skill（> 多行 description + references/）零改动接入", async () => {
	// 模拟外部作者：把一个「第三方风格」skill 目录原样丢进临时 skills 根目录，
	// 不改任何业务代码，discover → index → load_skill 全链路可用 = 验收线成立。
	const root = mkdtempSync(join(tmpdir(), "skills-dropin-"));
	try {
		const dir = join(root, "third-party-skill");
		mkdirSync(join(dir, "references"), { recursive: true });
		writeFileSync(
			join(dir, "references", "style-guide.md"),
			"# 商品图参考样式\n\n白底、居中、柔光。\n",
			"utf8",
		);
		// 第三方作者手写的 SKILL.md：YAML `>` 多行 description（Anthropic 事实标准常见写法）
		writeFileSync(
			join(dir, "SKILL.md"),
			[
				"---",
				"name: third-party-skill",
				"description: >",
				"  为电商商品生成白底商品图。当用户要求制作商品白底图、",
				"  抠图换背景或商品主图时使用。",
				"---",
				"",
				"# 商品图制作",
				"",
				"1. 调用图像生成工具，输出 1024x1024 白底图。",
				"2. 样式细节见 references/style-guide.md。",
				"",
			].join("\n"),
			"utf8",
		);

		// 1) discoverSkills 发现且 description 按 YAML `>` 折叠语义解析正确
		const entries = discoverSkills(root);
		assert.equal(entries.length, 1); // references/ 子目录无 SKILL.md，被跳过且不影响发现
		assert.equal(entries[0].skillId, "third-party-skill");
		assert.equal(entries[0].name, "third-party-skill");
		assert.equal(
			entries[0].description,
			// YAML `>` folding 语义：换行折叠为空格（与标准 YAML 解析器逐字节一致）
			"为电商商品生成白底商品图。当用户要求制作商品白底图、 抠图换背景或商品主图时使用。",
		);

		// 2) index block 含其 name（渐进披露入口）
		const indexBlock = buildSkillIndexBlock(entries);
		assert.ok(indexBlock.includes("third-party-skill"));
		assert.ok(indexBlock.includes("白底商品图"));

		// 3) load_skill 工具取到正文
		const [tool] = createSkillTools(entries, new Metrics());
		assert.equal(tool.name, "load_skill");
		const res = await run(tool, { name: "third-party-skill" });
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.ok, true);
		assert.equal(
			parsed.body,
			"# 商品图制作\n\n1. 调用图像生成工具，输出 1024x1024 白底图。\n2. 样式细节见 references/style-guide.md。",
		);
		assert.deepEqual(res.details, { ok: true, body: parsed.body });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
