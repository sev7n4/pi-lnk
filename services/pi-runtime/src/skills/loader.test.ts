import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSkillIndexBlock, discoverSkills, loadSkill } from "./loader.js";

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
