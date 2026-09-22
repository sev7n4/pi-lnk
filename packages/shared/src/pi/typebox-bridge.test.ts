import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Type } from "typebox";
import { assertObjectSchema, typeBoxToJsonSchema, zodToTypeBox } from "./typebox-bridge";

describe("B3 Zod↔TypeBox 桥（R9：schema 边界覆盖）", () => {
	it("扁平 object：字段类型/必选性/description 全保留", () => {
		const schema = z.object({
			title: z.string().describe("草稿标题"),
			limit: z.number().int().min(1).max(10).optional(),
			mode: z.enum(["fast", "quality"]),
		});
		const tb = zodToTypeBox(schema);
		expect((tb as unknown as Record<string, unknown>).type).toBe("object");
		const json = typeBoxToJsonSchema(tb) as Record<string, any>;
		expect(json.properties.title.type).toBe("string");
		expect(json.properties.title.description).toBe("草稿标题");
		expect(json.properties.mode.enum).toEqual(["fast", "quality"]);
		expect(json.properties.limit.minimum).toBe(1);
		expect(json.required).toContain("title");
		expect(json.required).not.toContain("limit");
	});

	it("嵌套 object 与数组内联展开（无 $ref）", () => {
		const schema = z.object({
			items: z.array(
				z.object({ id: z.string(), count: z.number() }),
			),
		});
		const json = typeBoxToJsonSchema(zodToTypeBox(schema)) as Record<string, any>;
		const s = JSON.stringify(json);
		expect(s).not.toContain("$ref");
		expect(json.properties.items.type).toBe("array");
		expect(json.properties.items.items.type).toBe("object");
		expect(json.properties.items.items.properties.id.type).toBe("string");
	});

	it("顶层非 object 被守卫拒绝（pi 工具参数约定）", () => {
		const tb = zodToTypeBox(z.string());
		expect(() => assertObjectSchema(tb)).toThrow(/z\.object/);
	});

	it("输出可直接传给 pi：与原生 TypeBox schema JSON 兼容", () => {
		const native = Type.Object({ a: Type.String() });
		const bridged = zodToTypeBox(z.object({ a: z.string() }));
		const b = JSON.parse(JSON.stringify(bridged));
		// zod 语义自带 additionalProperties: false（比原生 TypeBox 更严格，保留是正确行为）
		expect(b.additionalProperties).toBe(false);
		delete b.additionalProperties;
		expect(b).toEqual(JSON.parse(JSON.stringify(native)));
		assertObjectSchema(bridged);
	});
});
