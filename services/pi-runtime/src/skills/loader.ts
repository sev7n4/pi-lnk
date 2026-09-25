/**
 * SKILL.md 加载器（D-η'）：格式对齐 Anthropic 事实标准（github.com/anthropics/skills）。
 * 通用约定 TS 移植自老 runtime app/skills/loader.py（name=目录名、≤64 字符、
 * description≤1024、坏 skill 跳过）；lnkpi.* 扩展元数据与 prompt_version 机制不迁。
 * 渐进披露：index（name+description）常驻 systemPrompt，正文经 load_skill 按需加载。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LnkpiTool } from "../tools/types.js";
import type { Metrics } from "../metrics.js";
import { createSkillTools } from "../tools/skill-tool.js";

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

/**
 * 技能注册表（D-η' Task 4）：进程内加载一次（构造时扫描），把 index 块与
 * load_skill 工具一并暴露给 SessionManager 注入。skills 目录缺失/为空时
 * indexBlock 为 ""、tools 为空数组——会话行为与未配置 skills 时逐字节一致。
 */
export class SkillRegistry {
	readonly entries: SkillIndexEntry[];
	readonly indexBlock: string;
	readonly tools: LnkpiTool[];

	constructor(root: string, metrics: Metrics) {
		this.entries = discoverSkills(root);
		this.indexBlock = buildSkillIndexBlock(this.entries);
		this.tools = createSkillTools(this.entries, metrics);
	}
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

/**
 * 最小 YAML 子集解析：`key: value` 单行（值可带引号）+ `>`/`|` 多行块标量
 * （含 `-`/`+` chomping 后缀；`>` 折叠为空格、`|` 保留换行）。
 * 第三方 Anthropic 格式 skill 常用 `>` 写长 description（drop-in 验收覆盖），
 * 为此扩展解析器而非引入 `yaml` 依赖（Task 2 注记：禁止轻率新增）。
 */
function parseSimpleYaml(raw: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const lines = raw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
		if (!m) continue;
		const header = m[2].trim();
		if (/^[|>][+-]?$/.test(header)) {
			out[m[1]] = parseBlockScalar(lines, i, header[0] as ">" | "|", (end) => {
				i = end;
			});
		} else {
			let v: unknown = header;
			if (typeof v === "string" && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
			out[m[1]] = v;
		}
	}
	return out;
}

/**
 * 多行块标量：从 header 行之后收集缩进更深的行直至 dedent，返回折叠后的字符串。
 * `>`：段内换行折叠为空格、空行折叠为换行（YAML folding 语义）；`|`：保留换行。
 * chomping 默认/`-`/`+` 对 trim 后的结果无差异，统一 strip 首尾空白。
 */
function parseBlockScalar(
	lines: string[],
	headerIdx: number,
	style: ">" | "|",
	setIndex: (end: number) => void,
): string {
	const baseIndent = /^ */.exec(lines[headerIdx])![0].length;
	const body: string[] = [];
	let j = headerIdx + 1;
	while (j < lines.length) {
		const line = lines[j];
		if (line.trim() === "") {
			body.push("");
			j++;
			continue;
		}
		const indent = /^ */.exec(line)![0].length;
		if (indent <= baseIndent) break;
		body.push(line.slice(indent));
		j++;
	}
	setIndex(j - 1);
	if (style === "|") return body.join("\n").trim();
	// `>` folding：按空行分段，段内行以空格连接，段间以换行连接
	const paragraphs: string[][] = [[]];
	for (const line of body) {
		if (line === "") {
			if (paragraphs[paragraphs.length - 1].length > 0) paragraphs.push([]);
		} else {
			paragraphs[paragraphs.length - 1].push(line);
		}
	}
	return paragraphs
		.filter((p) => p.length > 0)
		.map((p) => p.join(" "))
		.join("\n");
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
