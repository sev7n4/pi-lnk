/**
 * SKILL.md 加载器（D-η'）：格式对齐 Anthropic 事实标准（github.com/anthropics/skills）。
 * 通用约定 TS 移植自老 runtime app/skills/loader.py（name=目录名、≤64 字符、
 * description≤1024、坏 skill 跳过）；lnkpi.* 扩展元数据与 prompt_version 机制不迁。
 * 渐进披露：index（name+description）常驻 systemPrompt，正文经 load_skill 按需加载。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface SkillIndexEntry {
	skillId: string;
	name: string;
	description: string;
	dir: string;
}

export interface LoadedSkill extends SkillIndexEntry {
	body: string;
}

export function discoverSkills(root: string): SkillIndexEntry[] {
	let children: string[];
	try {
		children = readdirSync(root);
	} catch {
		return [];
	}
	const entries: SkillIndexEntry[] = [];
	for (const child of children.sort()) {
		const dir = join(root, child);
		try {
			if (!statSync(dir).isDirectory() || child.startsWith("_")) continue;
			const { frontmatter } = parseSkillMd(readFileSync(join(dir, "SKILL.md"), "utf8"));
			const name = String(frontmatter.name ?? "");
			const description = String(frontmatter.description ?? "");
			validateName(name, child);
			validateDescription(description);
			entries.push({ skillId: child, name, description, dir });
		} catch (err) {
			console.warn(`[skills] skipping ${child}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return entries;
}

export function loadSkill(entry: SkillIndexEntry): LoadedSkill {
	const { frontmatter, body } = parseSkillMd(readFileSync(join(entry.dir, "SKILL.md"), "utf8"));
	validateName(String(frontmatter.name ?? ""), entry.skillId);
	validateDescription(String(frontmatter.description ?? ""));
	return { ...entry, body };
}

export function buildSkillIndexBlock(entries: SkillIndexEntry[]): string {
	if (entries.length === 0) return "";
	const lines = entries.map((e) => `- ${e.name}: ${e.description}`);
	return [
		"## 可用技能（Skills）",
		"用户意图匹配某技能描述时，先调用 load_skill 工具加载完整说明，再按说明执行；未匹配到技能时不要调用 load_skill。",
		...lines,
	].join("\n");
}

function parseSkillMd(content: string): { frontmatter: Record<string, unknown>; body: string } {
	if (!content.startsWith("---")) throw new Error("SKILL.md must begin with YAML frontmatter");
	// 手动解析 frontmatter：首个 "---" 与下一个 "\n---" 之间
	const end = content.indexOf("\n---", 3);
	if (end === -1) throw new Error("invalid frontmatter in SKILL.md");
	const raw = content.slice(4, end);
	const body = content.slice(end + 4).replace(/^\n+/, "").trimEnd();
	return { frontmatter: parseSimpleYaml(raw), body };
}

/** 最小 YAML 子集解析：仅支持 `key: value` 行（name/description 已够用；值可带引号）。 */
function parseSimpleYaml(raw: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const line of raw.split("\n")) {
		const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (!m) continue;
		let v: unknown = m[2].trim();
		if (typeof v === "string" && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		out[m[1]] = v;
	}
	return out;
}

function validateName(name: string, dirName: string): void {
	if (!name) throw new Error("name is required in frontmatter");
	if (name.length > 64) throw new Error("name must be at most 64 characters");
	if (!NAME_PATTERN.test(name)) throw new Error("name must use lowercase letters, digits, and hyphens only");
	if (name !== dirName) throw new Error("name must match the skill directory name");
}

function validateDescription(description: string): void {
	if (!description) throw new Error("description is required in frontmatter");
	if (description.length > 1024) throw new Error("description must be at most 1024 characters");
}
