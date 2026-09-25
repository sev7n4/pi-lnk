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

/** 与 Nest 侧 PiPromptAssembler 一致的 token 估算口径（follow-up-1）。 */
export function approxTokens(s: string): number {
	return Math.ceil(s.length / 4);
}
