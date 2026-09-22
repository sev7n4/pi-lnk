/**
 * B3: Zod ↔ TypeBox 桥接（spec §6.2.0，~50 行纪律）
 *
 * 方向：Nest / L2 侧用 Zod 定义工具 schema（项目既有习惯，packages/shared 已依赖 zod），
 * pi-agent-core 的 AgentHarnessTool.parameters 需要 TypeBox TSchema。
 *
 * 实现策略（PoC + pi 源码实测依据）：
 *  - pi agent 包内部不使用 @sinclair/typebox/value 做运行时校验（全仓 0 命中
 *    Value.Check/Value.Decode），TSchema 只被序列化为 JSON Schema 传给 LLM。
 *  - 因此「zod → JSON Schema → Type.Unsafe 包装」是完整正确的路径，
 *    无需为每个 zod 类型手写 TypeBox 等价物。
 *  - $refStrategy: "none" 内联全部定义，产出对 LLM function-calling 友好的扁平 schema。
 *
 * 边界（R9 风险登记）：zod 的 transform/preprocess/superrefine 等运行时副作用
 * 不会体现在 JSON Schema 中 —— 桥接前应使用「纯描述型」schema。
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Type, type TSchema } from "typebox";

/** 把 Zod schema 转成 pi AgentHarnessTool.parameters 可直接使用的 TypeBox TSchema。 */
export function zodToTypeBox(schema: z.ZodType): TSchema {
	// zod 3.25 classic API 与 zod-to-json-schema 的泛型签名存在 TS2589 深递归，
	// 桥接输入约定为「纯描述型」schema（见文件头边界说明），cast 绕过 assignability 检查
	type ZodToJsonSchemaInput = Parameters<typeof zodToJsonSchema>[0];
	const json = zodToJsonSchema(schema as unknown as ZodToJsonSchemaInput, {
		$refStrategy: "none",
	}) as Record<string, unknown>;
	// zod-to-json-schema 顶层可能带 $schema 元属性，LLM function calling 不需要
	const { $schema: _schema, ...rest } = json;
	return Type.Unsafe(rest);
}

/** 从 TypeBox TSchema 提取纯 JSON Schema（调试 / 日志 / 透传给非 TypeBox 消费方）。 */
export function typeBoxToJsonSchema(schema: TSchema): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (typeof key === "string") out[key] = value;
	}
	return out;
}

/** 运行时守卫：桥接结果的形状自检（防止 zod-to-json-schema 升级后输出漂移）。 */
export function assertObjectSchema(schema: TSchema): void {
	const t = (schema as unknown as Record<string, unknown>).type;
	if (t !== "object") {
		throw new Error(`pi 工具 schema 必须是 z.object(...) 顶层（得到 type=${String(t)}）`);
	}
}
