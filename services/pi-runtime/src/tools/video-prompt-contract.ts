import { readStringField } from "../hook-contract.js";

/**
 * 图生视频 prompt 契约纠偏（spec §5.2 主杠杆 B）。
 *
 * 铁律（skills/drama-motion-video）：「图管外观，prompt 管时间」——参考图已定义
 * 主体/构图/光线/风格，prompt 只写「什么在变」。重述静帧外观会诱导模型重新
 * 解释这一帧，是低质运动提示词的头号根因。
 */
export const VIDEO_MOTION_CONTRACT_REMINDER =
	"【图生视频 prompt 契约】该 video 节点挂有参考图：参考图已定义外观，prompt 必须只描述运动——" +
	"① 一个运镜（带方向与速度）② 一个主体主导动作 ③ 仅必要的环境次运动（发丝/反光/烟尘）" +
	"④ 禁止项（变形/新增物体/崩坏）。检查当前 prompt 是否复述了静帧外观（如「毛发细节」「高精度渲染」），" +
	"若是请在 propose 前用 upsert_media_node 更新该节点改写为纯运动描述。";

/** upsert_media_node 落成 video 节点时返回纠偏文本；其余形态一律 null（不猜）。 */
export function videoContractReminder(args: unknown): string | null {
	// ⚠️ 字段名是 target_type（canvas-write.ts 的参数 schema），不是 type。
	const type = readStringField(args, "target_type", "after_tool.args");
	if (!type.ok || type.value !== "video") return null;
	return VIDEO_MOTION_CONTRACT_REMINDER;
}

/**
 * 把纠偏段拼到工具结果末尾（spec §5.2 接线纯函数）。
 *
 * 只加文本，不改写 args、不拦截工具；调用方（index.ts 合并 after_tool listener）
 * 负责把**截断后**的 content 传入，保证纠偏段在截断后仍可见。
 * 无需纠偏时返回同长度新数组（调用方据 length 判断是否需要 patch）。
 */
export function appendVideoContract<T extends { type: string }>(
	content: readonly T[],
	toolName: string,
	isError: boolean,
	args: unknown,
): T[] {
	if (toolName !== "upsert_media_node" || isError) return [...content];
	const reminder = videoContractReminder(args);
	if (!reminder) return [...content];
	// 文本块是合法 content block；T 是调用方（vendor ContentBlock）的元素类型，
	// 此处受控收窄以保持调用侧零 as（TS 无法从 {type:string} 约束证明子类型，需双跳）。
	return [...content, { type: "text", text: reminder } as unknown as T];
}
