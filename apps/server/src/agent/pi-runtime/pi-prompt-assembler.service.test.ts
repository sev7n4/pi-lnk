import { describe, expect, it } from "vitest";
import { PiPromptAssembler } from "./pi-prompt-assembler.service";

const makeAssembler = (summary: { nodes: unknown[] }) =>
	new PiPromptAssembler({
		getCanvasSummary: async () => summary,
	} as never);

const makeAssemblerThrows = (err: Error) =>
	new PiPromptAssembler({
		getCanvasSummary: async () => {
			throw err;
		},
	} as never);

const CORE_PREFIX = "你是 lnkpi 无限画布助手。用简洁中文回答。";

describe("PiPromptAssembler（#12 每轮 system prompt 组装）", () => {
	it("默认注入 core 组 + 摘要 JSON + 近期摘要", async () => {
		const asm = makeAssembler({ nodes: [{ id: "n1", type: "image", title: "T", status: "ready" }] });
		const prompt = await asm.assemble({
			sessionId: "s1",
			priorMessages: [{ role: "user", content: "u1" }],
		});
		expect(prompt.startsWith(CORE_PREFIX)).toBe(true);
		expect(prompt.includes("当前画布摘要：")).toBe(true);
		expect(prompt.includes('"id":"n1"')).toBe(true);
		expect(prompt.includes("近期对话摘要：\n用户: u1")).toBe(true);
		expect(prompt.includes("instantiate_workflow_template")).toBe(false); // writeTools 组未启用
	});

	it("getCanvasSummary 抛错：摘要块省略、prompt 仍完整返回", async () => {
		const asm = makeAssemblerThrows(new Error("session missing"));
		const prompt = await asm.assemble({ sessionId: "s1" });
		expect(prompt.startsWith(CORE_PREFIX)).toBe(true);
		expect(prompt.includes("当前画布摘要：")).toBe(false);
	});

	it("ruleGroups 含 writeTools 时注入规则 4/5 原文，且不再注入第 10 条守卫（B-2）", async () => {
		const asm = makeAssembler({ nodes: [] });
		const prompt = await asm.assemble({ sessionId: "s1", ruleGroups: ["core", "writeTools"] });
		// 规则 4 原文特征句（explore.py:95 逐字，含无空格拼接点）
		expect(prompt.includes("用 upsert_media_node创建或更新节点（可带 prompt）")).toBe(true);
		expect(prompt.includes("mentioned_keys 用 I1/I2芯片序")).toBe(true);
		// 规则 5 原文特征句
		expect(prompt.includes("口语搭骨架")).toBe(true);
		expect(prompt.includes("不要把 @I* 芯片连成边")).toBe(true);
		// 第 10 条守卫退出
		expect(prompt.includes("写操作尚未开放")).toBe(false);
		// 规则 6（tool_search）与 8/9 不注入（见计划 §1.2 声明偏离）
		expect(prompt.includes("tool_search")).toBe(false);
		expect(prompt.includes("upscale_image")).toBe(false);
	});

	it("core 规则 3 为 explore.py 原文（F1：恢复 run_*_generation 措辞）", async () => {
		const asm = makeAssembler({ nodes: [] });
		const prompt = await asm.assemble({ sessionId: "s1" });
		expect(prompt.includes("不要调用 run_*_generation（禁止调用任何 run_*）")).toBe(true);
	});

	it("侧栏块存在；默认组（writeTools 未启用）含第 10 条守卫", async () => {
		const asm = makeAssembler({ nodes: [] });
		const prompt = await asm.assemble({
			sessionId: "s1",
			attachments: [{ url: "https://x/a.png", mediaType: "image" }],
		});
		expect(prompt.includes("侧栏参考素材：\nI1=a.png")).toBe(true);
		expect(prompt.includes("写操作尚未开放")).toBe(true);
	});

	it("无 priorMessages / 无 attachments：无近期摘要块、无侧栏块", async () => {
		const asm = makeAssembler({ nodes: [] });
		const prompt = await asm.assemble({ sessionId: "s1" });
		expect(prompt.includes("近期对话摘要：")).toBe(false);
		expect(prompt.includes("侧栏参考素材：")).toBe(false);
	});
});
