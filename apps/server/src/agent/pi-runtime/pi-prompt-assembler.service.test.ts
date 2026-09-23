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

	it("ruleGroups 含 writeTools 时组文本被注入（B-2 占位，原文断言随 B-2 替换）", async () => {
		const asm = makeAssembler({ nodes: [] });
		const prompt = await asm.assemble({ sessionId: "s1", ruleGroups: ["core", "writeTools"] });
		expect(prompt.includes("writeTools 组占位")).toBe(true);
	});

	it("侧栏块 + 第 10 条守卫始终存在", async () => {
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
