import { parseSkillCommand } from "./skill-command.js";

/**
 * P1 skillId 转接：dock 技能选择器 skillId → forceSkills。
 * 优先级：文本 /skill 显式命令优先于 skillId（用户显式指令不被动选择器覆盖）；
 * 未知名一律 fail-soft（原文发送，由模型隐性匹配兜底），保证不因选择器脏值阻断对话。
 */
export function resolveForceSkills(
	skillId: string | undefined,
	userMessage: string,
	known: Array<{ name: string }> | null,
): { forceSkills?: string[]; promptText: string } {
	// ① 文本 /skill 命令优先：沿用 P0 行为（校验命中才转发，rest 为空回退默认请求语，未知名降级原文）
	const cmd = parseSkillCommand(userMessage);
	if (cmd) {
		if (known?.some((s) => s.name === cmd.name)) {
			return {
				forceSkills: [cmd.name],
				promptText: cmd.rest || `请使用 skill ${cmd.name} 完成我的需求`,
			};
		}
		return { forceSkills: undefined, promptText: userMessage };
	}
	// ② 无命令时 dock skillId 命中白名单 → 注入 forceSkills，消息原文不变
	const trimmed = skillId?.trim();
	if (trimmed && known?.some((s) => s.name === trimmed)) {
		return { forceSkills: [trimmed], promptText: userMessage };
	}
	// ③ 其余（无 skillId / 未知名 / known 不可用）→ 原样
	return { forceSkills: undefined, promptText: userMessage };
}
