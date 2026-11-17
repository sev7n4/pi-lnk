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

export interface MultiForceResult {
	forceSkills?: string[];
	promptText: string;
	/** 被 fail-soft 过滤的未知名（供调用点记日志/计观测），已知名缺失时不阻断发送。 */
	dropped: string[];
}

/**
 * P3 多胶囊（composer 技能 chips）→ forceSkills 数组。
 * 与单版同构的裁决语义：
 * - 文本 /skill 命令命中 → 命令名居首，胶囊命中名并入去重（保序），promptText 走命令 rest/默认语；
 * - 命令存在但未知名 → 胶囊不背命令的锅：胶囊照常校验注入，promptText 保持原文；
 * - 胶囊逐个对 known 校验，未知名 fail-soft 进 dropped（不阻断发送）；known 不可用 → 全部降级原文；
 * - 全空/全未命中 → forceSkills=undefined，promptText 原样。
 * id→名映射（内置/用户已装/运行时名三通道）由调用点经 resolveDockSkillTarget 完成后再传入。
 */
export function resolveForceSkillsMulti(
	skillIds: string[],
	userMessage: string,
	known: Array<{ name: string }> | null,
): MultiForceResult {
	const cmd = parseSkillCommand(userMessage);
	const valid: string[] = [];
	const dropped: string[] = [];
	// known 不可用（listSkills 故障降级）≠ 未知名：整体 fail-soft 降级，不计 dropped。
	if (known?.length) {
		for (const id of skillIds) {
			const name = id?.trim();
			if (!name) continue;
			if (known.some((s) => s.name === name)) {
				if (!valid.includes(name)) valid.push(name);
			} else {
				dropped.push(name);
			}
		}
	}
	if (cmd && known?.some((s) => s.name === cmd.name)) {
		const merged = [cmd.name, ...valid.filter((n) => n !== cmd.name)];
		return { forceSkills: merged, promptText: cmd.rest || `请使用 skill ${cmd.name} 完成我的需求`, dropped };
	}
	return { forceSkills: valid.length ? valid : undefined, promptText: userMessage, dropped };
}
