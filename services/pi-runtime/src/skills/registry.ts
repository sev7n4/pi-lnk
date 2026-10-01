/**
 * 技能注册表（D-η' Task 4，follow-up-2 自 loader.ts 迁入以消除循环依赖）：
 * 进程内加载一次（构造时扫描），把 index 块与 load_skill 工具一并暴露给
 * SessionManager 注入。skills 目录缺失/为空时 indexBlock 为 ""、tools 为
 * 空数组——会话行为与未配置 skills 时逐字节一致。
 *
 * 依赖方向：registry → loader / skill-tool；loader 与 skill-tool 互不依赖。
 */
import type { LnkpiTool } from "../tools/types.js";
import type { Metrics } from "../metrics.js";
import { discoverSkills, buildSkillIndexBlock, loadSkill, type SkillIndexEntry } from "./loader.js";
import { createSkillTools } from "../tools/skill-tool.js";

export class SkillRegistry {
	readonly entries: SkillIndexEntry[];
	readonly indexBlock: string;
	readonly tools: LnkpiTool[];

	constructor(root: string, metrics: Metrics) {
		this.entries = discoverSkills(root);
		this.indexBlock = buildSkillIndexBlock(this.entries);
		this.tools = createSkillTools(this.entries, metrics);
	}

	loadBody(name: string): string | undefined {
		const entry = this.entries.find((e) => e.name === name);
		if (!entry) return undefined;
		return loadSkill(entry).body;
	}
}

/** CJK ≈1 token/字 + 其余 ≈1/4 token/字符（审计 P0-②：len/4 对中文低估 3~4 倍）。
 *  与 apps/server/src/agent/pi-runtime/pi-prompt-assembler.service.ts 同口径，改必须同步。 */
const CJK_CHAR_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;

export function approxTokens(s: string): number {
	let cjk = 0;
	let other = 0;
	for (const ch of s) {
		if (CJK_CHAR_RE.test(ch)) cjk += 1;
		else other += 1;
	}
	return Math.ceil(cjk + other / 4);
}
