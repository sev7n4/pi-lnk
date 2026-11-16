/**
 * M1-2（规格 v2 §5.3/§7.2，计划 §2 契约 1-3）：Nest→runtime 用户技能通道。
 *
 * 契约（计划 §2 已冻结）：
 * 1. Nest `buildSkillResources(userId)` 在服务端组装 `Skill[]`，经 `/sessions` create body
 *    `resources.skills` 透传（无签名/无缓存/无失效判定，v2 E-10）；runtime 不查 Nest、不出网。
 * 2. 合并语义：harness resources = 内置 registry `Skill[]` ∪ 传入（传入覆盖同名内置——用户显式
 *    安装优先；去重按 `name`）。空集 `{skills:[]}` 合法（M0 行为不变）。
 * 3. 即时生效走全量换集 `harness.setResources`（U-6）——不做增量 diff，旧名自然 `UnknownSkill`。
 *
 * ⚠️ §4.8 禁自建等价物：本模块只做「形状校验 + 数据合并 + sidecar 持久化」。解析（frontmatter）、
 * 索引格式（formatSkillsForSystemPrompt）、显式调用（lane.skill）、未知名拒绝（UnknownSkill）
 * 全部消费上游原语。上游 `Skill` 形状（dist/harness/types.d.ts）：name/description/content/
 * filePath/disableModelInvocation?。
 */
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { Skill } from "@earendil-works/pi-agent-core";

/** Nest→runtime 透传的用户技能：上游 `Skill` 的子集（content 必填，filePath 可省略用虚拟路径）。 */
export interface IncomingSkill {
	name: string;
	description: string;
	content: string;
	/** Nest 侧虚拟路径（如 `<virtual>/<name>/SKILL.md>`）；缺省时宿主补虚拟路径。 */
	filePath?: string;
	/** 排除出模型可见列表但仍可显式调用（上游原义透传）。 */
	disableModelInvocation?: boolean;
}

/** per-entry 用户技能 sidecar（会话目录内，meta.json 同层）。 */
export const USER_SKILLS_FILE = "user-skills.json";
/** 单会话用户技能条数上限（Nest 侧先行 ≤12 裁剪；runtime 防御性再收一道）。 */
export const MAX_USER_SKILLS = 24;
/** 单技能正文字节上限（防御内存/索引膨胀；总量由 fastify bodyLimit 4MB 兜底）。 */
export const MAX_SKILL_CONTENT_BYTES = 64 * 1024;
export const MAX_SKILL_NAME_LENGTH = 128;

export type ParseIncomingResult =
	| { ok: true; skills: IncomingSkill[] }
	| { ok: false; error: string };

/**
 * 校验 create body / resources 端点 body 的 `resources` 字段。
 * 畸形 → 400（fail-closed，不静默丢弃）：宁可本轮失败，也不「以为注入了实际没有」。
 */
export function parseIncomingResources(raw: unknown): ParseIncomingResult {
	if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, error: "resources 必须是对象" };
	}
	const skillsRaw = (raw as { skills?: unknown }).skills;
	if (skillsRaw === undefined) return { ok: true, skills: [] };
	if (!Array.isArray(skillsRaw)) return { ok: false, error: "resources.skills 必须是数组" };
	if (skillsRaw.length > MAX_USER_SKILLS) {
		return { ok: false, error: `resources.skills 超上限（最多 ${MAX_USER_SKILLS} 条）` };
	}
	const seen = new Set<string>();
	const skills: IncomingSkill[] = [];
	for (const [i, item] of skillsRaw.entries()) {
		const bad = (why: string) => ({ ok: false as const, error: `resources.skills[${i}]: ${why}` });
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			return bad("必须是对象");
		}
		const it = item as Record<string, unknown>;
		if (typeof it.name !== "string" || !it.name.trim() || it.name.length > MAX_SKILL_NAME_LENGTH) {
			return bad(`name 必须是非空字符串（≤${MAX_SKILL_NAME_LENGTH}）`);
		}
		if (typeof it.description !== "string" || !it.description.trim()) {
			return bad("description 必须是非空字符串");
		}
		if (typeof it.content !== "string" || !it.content) {
			return bad("content 必须是非空字符串");
		}
		if (Buffer.byteLength(it.content, "utf8") > MAX_SKILL_CONTENT_BYTES) {
			return bad(`content 超体积上限（${MAX_SKILL_CONTENT_BYTES} 字节）`);
		}
		if (it.filePath !== undefined && (typeof it.filePath !== "string" || !it.filePath)) {
			return bad("filePath 必须是非空字符串或省略");
		}
		if (it.disableModelInvocation !== undefined && typeof it.disableModelInvocation !== "boolean") {
			return bad("disableModelInvocation 必须是布尔或省略");
		}
		if (seen.has(it.name)) return bad(`重复技能名 ${it.name}`);
		seen.add(it.name);
		// 只收合法键（省略 undefined——落盘 JSON 与 deepEqual 语义都更干净）
		const parsed: IncomingSkill = {
			name: it.name,
			description: it.description,
			content: it.content,
		};
		if (it.filePath !== undefined) parsed.filePath = it.filePath;
		if (it.disableModelInvocation !== undefined) parsed.disableModelInvocation = it.disableModelInvocation;
		skills.push(parsed);
	}
	return { ok: true, skills };
}

/** IncomingSkill → 上游 Skill（补虚拟 filePath；content 逐字透传——A2 判据）。 */
function toUpstreamSkill(s: IncomingSkill): Skill {
	const skill: Skill = {
		name: s.name,
		description: s.description,
		content: s.content,
		filePath: s.filePath ?? `<virtual>/${s.name}/SKILL.md`,
	};
	if (s.disableModelInvocation) skill.disableModelInvocation = true;
	return skill;
}

/**
 * 合并内置 ∪ 传入（契约 2）：Map 按 name 去重，内置先入（保序），传入后入覆盖同名项
 * ——覆盖后的技能保持内置的索引位置（用户装同名替换而非追加行），新名追加在尾部。
 */
export function mergeSkillResources(
	builtin: readonly Skill[],
	incoming: readonly IncomingSkill[],
): Skill[] {
	const byName = new Map<string, Skill>();
	for (const b of builtin) byName.set(b.name, b);
	for (const s of incoming) byName.set(s.name, toUpstreamSkill(s));
	return [...byName.values()];
}

/**
 * 读 per-entry 用户技能 sidecar（U-11：resources 不落盘 ⇒ 宿主持久化 + resume 重注入）。
 * 任何失败（不存在/半截写入/形状不对）→ 空集：按「无用户技能」处理，不让 resume 失败。
 */
export async function readUserSkills(cwd: string): Promise<IncomingSkill[]> {
	try {
		const raw = await readFile(join(cwd, USER_SKILLS_FILE), "utf8");
		const parsed = parseIncomingResources({ skills: JSON.parse(raw) as unknown });
		// 写盘侧只写合法集（writeUserSkills 前置 parse），半截/被篡改 → 空集回落。
		return parsed.ok ? parsed.skills : [];
	} catch {
		return [];
	}
}

/** 写 sidecar；失败不阻断（warn-only，对齐 meta.json 写盘失败不阻断的取舍）。 */
export async function writeUserSkills(cwd: string, skills: readonly IncomingSkill[]): Promise<void> {
	await writeFile(join(cwd, USER_SKILLS_FILE), JSON.stringify(skills), "utf8").catch(
		(err: unknown) => {
			console.warn(
				`[pi-runtime] write user skills failed for ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
			);
		},
	);
}
