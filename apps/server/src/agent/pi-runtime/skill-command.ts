/** /skill 显性指令解析（可观测性专项 ④）：仅精确匹配 "/skill <name>[ <rest>]"。 */
const SKILL_COMMAND_RE = /^\/skill\s+([^\s]+)(?:\s+([\s\S]*))?$/;

export function parseSkillCommand(text: string): { name: string; rest: string } | null {
	const m = text.match(SKILL_COMMAND_RE);
	if (!m) return null;
	return { name: m[1], rest: (m[2] ?? "").trim() };
}
