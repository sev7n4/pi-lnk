/**
 * load_skill（D-η'）：SKILL.md 正文按需加载工具。
 * index（name+description）常驻 systemPrompt（SessionManager 注入），模型意图匹配后
 * 调用本工具取正文；只读本地文件，不走 Nest、不经 Gate。
 */
import { Type } from "typebox";
import type { LnkpiTool } from "./types.js";
import type { Metrics } from "../metrics.js";
import { loadSkill, type SkillIndexEntry } from "../skills/loader.js";

export function createSkillTools(entries: SkillIndexEntry[], metrics: Metrics): LnkpiTool[] {
	if (entries.length === 0) return [];
	const byName = new Map(entries.map((e) => [e.name, e]));
	return [
		{
			tier: "skill",
			name: "load_skill",
			label: "加载技能说明",
			description:
				"Load the full instructions of a skill by name. Call this when the user's intent matches a skill listed in the 可用技能 section, then follow the returned instructions.",
			parameters: Type.Object({
				name: Type.String({ description: "Skill name, exactly as listed in 可用技能" }),
			}),
			execute: async (_id, p: { name: string }) => {
				const entry = byName.get(p.name);
				if (!entry) {
					// 2026-10-04：不再自计 tool_calls_total（移交事件层，避免与
					// harness 的 tool_start/tool_end 双计）。observeSkillLoad 保留：
					// 它按**技能名**分组，是路由对不对的判据，事件层给不出。
					metrics.observeSkillLoad(p.name, "unknown");
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `unknown skill: ${p.name}` }) }],
						details: { ok: false as const, error: `unknown skill: ${p.name}` },
					};
				}
				try {
					const loaded = loadSkill(entry);
					metrics.observeSkillLoad(entry.name, "ok");
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: true, body: loaded.body }) }],
						details: { ok: true as const, body: loaded.body },
					};
				} catch (err) {
					metrics.observeSkillLoad(entry.name, "read_error");
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: msg }) }],
						details: { ok: false as const, error: msg },
					};
				}
			},
		},
	];
}
