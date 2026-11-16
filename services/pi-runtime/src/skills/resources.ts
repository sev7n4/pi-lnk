/**
 * M0 W1（规格 v2 §7.3 / §8 / 附录 C）：宿主唯一 Skill 转换层。
 *
 * 把 pi-runtime 内置 `SkillRegistry` 的 entries 转换为上游
 * `@earendil-works/pi-agent-core` 的 `Skill[]`，供 `AgentHarness.create({ resources })`
 * 注入（U-7/U-11：resources 是 harness 内存 config 不落盘 ⇒ 每次 create 重注入）。
 *
 * ⚠️ §4.8 禁自建等价物：本模块只做「数据形状转换」——解析（frontmatter）、索引格式
 * （formatSkillsForSystemPrompt）、显式调用（lane.skill）、未知名拒绝（UnknownSkill）
 * 全部消费上游原语，宿主不重写任何一个。
 * M1 的 Nest 侧 `buildSkillResources(userId, sessionKey)`（DB 订阅集 → Skill[]）是同一
 * 输出形状的超集实现，届时替换数据源即可，本函数形状不变。
 */
import type { Skill } from "@earendil-works/pi-agent-core";
import { join } from "node:path";
import type { SkillIndexEntry } from "./loader.js";

export function buildSkillResources(
	entries: readonly SkillIndexEntry[],
	loadBody: (name: string) => string | undefined,
): { skills: Skill[] } {
	return {
		skills: entries.map((e) => ({
			name: e.name,
			description: e.description,
			content: loadBody(e.name) ?? "",
			filePath: join(e.dir, "SKILL.md"),
		})),
	};
}
