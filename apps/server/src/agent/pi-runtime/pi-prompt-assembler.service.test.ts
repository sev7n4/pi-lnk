import { describe, expect, it } from "vitest";
import {
	PiPromptAssembler,
	approxTokens,
	promptHash,
} from "./pi-prompt-assembler.service";

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

describe("PiPromptAssembler 静态段（assembleStatic：规则组文本，会话期内不变）", () => {
	it("默认注入 core 组（无画布/侧栏/近期摘要）", async () => {
		const asm = makeAssembler({ nodes: [{ id: "n1", type: "image", title: "T", status: "ready" }] });
		const text = await asm.assembleStatic({});
		expect(text.startsWith(CORE_PREFIX)).toBe(true);
		expect(text.includes("instantiate_workflow_template")).toBe(false); // writeTools 组未启用
	});

	it("assembleStatic 只含规则段，不含画布/侧栏/近期摘要", async () => {
		const asm = makeAssembler({ nodes: [{ id: "n1", type: "image", title: "T", status: "ready" }] });
		const text = await asm.assembleStatic({ ruleGroups: ["core", "writeTools", "genTools"] });
		expect(text).toContain("1.");
		expect(text).not.toContain("当前画布摘要");
		expect(text).not.toContain("近期对话摘要");
		// 注意：规则正文本身含「侧栏」二字（规则 4/7 讲侧栏参考图），故断言侧栏**块**的头
		expect(text).not.toContain("侧栏参考素材：");
	});

	it("固定不查画布摘要（静态段不依赖 world state）", async () => {
		const asm = makeAssemblerThrows(new Error("session missing"));
		const text = await asm.assembleStatic({ ruleGroups: ["core"] });
		expect(text.startsWith(CORE_PREFIX)).toBe(true);
	});

	it("ruleGroups 含 writeTools 时注入规则 4/5 原文，且不再注入第 10 条守卫（B-2）", async () => {
		const asm = makeAssembler({ nodes: [] });
		const prompt = await asm.assembleStatic({ ruleGroups: ["core", "writeTools"] });
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

	it("规则 14：无工作流模板能力——如实说明，禁止虚构模板（B 决策：workflow 不迁 pi）", async () => {
		const asm = makeAssembler({ nodes: [] });
		// core 组即注入（与是否启用 writeTools/genTools 无关）
		for (const groups of [["core"], ["core", "writeTools"], ["core", "writeTools", "genTools"]] as const) {
			const prompt = await asm.assembleStatic({
				ruleGroups: groups as Array<"core" | "writeTools" | "genTools">,
			});
			expect(prompt.includes("本会话没有工作流模板能力")).toBe(true);
			expect(prompt.includes("直接用节点 + 连线搭骨架来替代")).toBe(true);
			// 规则正文不得再引用 pi 侧不存在的 workflow 工具名
			expect(prompt.includes("instantiate_workflow_template")).toBe(false);
			expect(prompt.includes("import_workflow")).toBe(false);
		}
	});

	it("core 规则 3 为 explore.py 原文（F1：恢复 run_*_generation 措辞）", async () => {
		const asm = makeAssembler({ nodes: [] });
		const prompt = await asm.assembleStatic({});
		expect(prompt.includes("不要调用 run_*_generation（禁止调用任何 run_*）")).toBe(true);
	});

	it("默认组（writeTools 未启用）含第 10 条守卫", async () => {
		const asm = makeAssembler({ nodes: [] });
		const prompt = await asm.assembleStatic({});
		expect(prompt.includes("写操作尚未开放")).toBe(true);
	});

	it("assembleStatic 返回值与 rules 层 content 一致（单层，无拼接）", async () => {
		const asm = makeAssembler({ nodes: [] });
		const out = await asm.assembleStatic({ ruleGroups: ["core"] });
		expect(asm.lastLayers?.map((l) => l.kind)).toEqual(["rules"]);
		expect(out).toBe(asm.lastLayers![0].content);
	});
});

describe("PiPromptAssembler 动态段（assembleDynamic：每轮变化的世界状态）", () => {
	it("assembleDynamic 返回画布摘要与侧栏块（数组，供 runtime 尾部追加）", async () => {
		const asm = makeAssembler({ nodes: [{ id: "n1", type: "image", title: "T", status: "ready" }] });
		const blocks = await asm.assembleDynamic({
			sessionId: "s1",
			attachments: [{ url: "https://x/a.png", mediaType: "image" }],
		});
		expect(blocks[0]).toContain("当前画布摘要");
		expect(blocks.some((b) => b.includes("a.png"))).toBe(true);
	});

	it("画布摘要不可用时 assembleDynamic 不抛，仅返回侧栏块", async () => {
		const asm = makeAssemblerThrows(new Error("session missing"));
		const blocks = await asm.assembleDynamic({
			sessionId: "s1",
			attachments: [{ text: "TXT", mediaType: "text" }],
		});
		expect(blocks.some((b) => b.includes("当前画布摘要"))).toBe(false);
		expect(blocks.length).toBeGreaterThan(0);
	});

	it("无 attachments：仅画布摘要块；摘要 JSON 不截断（有意对齐老链路）", async () => {
		const asm = makeAssembler({ nodes: [{ id: "n1", type: "image", title: "T", status: "ready" }] });
		const blocks = await asm.assembleDynamic({ sessionId: "s1" });
		expect(blocks).toHaveLength(1);
		expect(blocks[0].includes('"id":"n1"')).toBe(true);
		expect(blocks[0].includes("侧栏参考素材：")).toBe(false);
	});

	it("侧栏块格式与老链路一致（I1=a.png）", async () => {
		const asm = makeAssembler({ nodes: [] });
		const blocks = await asm.assembleDynamic({
			sessionId: "s1",
			attachments: [{ url: "https://x/a.png", mediaType: "image" }],
		});
		expect(blocks.some((b) => b.includes("侧栏参考素材：\nI1=a.png"))).toBe(true);
	});

	it("摘要与侧栏都不可用：返回空数组（不抛，调用方按「无动态块」处理）", async () => {
		const asm = makeAssemblerThrows(new Error("session missing"));
		const blocks = await asm.assembleDynamic({ sessionId: "s1", attachments: [] });
		expect(blocks).toEqual([]);
	});

	it("画布无节点（nodes: []）仍产出摘要块——与老链路一致（空数组为真值，块不省略）", async () => {
		const asm = makeAssembler({ nodes: [] });
		const blocks = await asm.assembleDynamic({ sessionId: "s1" });
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain("当前画布摘要");
	});
});

describe("genTools 规则组（B-5 生成闭环）", () => {
	it("genTools 未启用：规则 3 仍是「禁止调用任何 run_*」原文，无 11/12/13", async () => {
		const asm = makeAssembler({ nodes: [] });
		const prompt = await asm.assembleStatic({ ruleGroups: ["core", "writeTools"] });
		expect(prompt.includes("禁止调用任何 run_*")).toBe(true);
		expect(prompt.includes("fallback_pending")).toBe(false);
		expect(prompt.includes("11. run_image/video/text/prompt/audio_generation")).toBe(false);
	});

	it("genTools 启用：规则 3' 替换原文，注入规则 11/12/13 与 cancel_generation", async () => {
		const asm = makeAssembler({ nodes: [] });
		const prompt = await asm.assembleStatic({ ruleGroups: ["core", "writeTools", "genTools"] });
		expect(prompt.includes("禁止调用任何 run_*")).toBe(false);
		expect(prompt.includes("用户明确同意前禁止调用 run_*_generation")).toBe(true);
		expect(prompt.includes("11. run_image/video/text/prompt/audio_generation")).toBe(true);
		expect(prompt.includes("status=fallback_pending")).toBe(true);
		expect(prompt.includes("cancel_generation")).toBe(true);
		// 规则 4/5（writeTools）与第 10 条守卫（writeTools 已启用 → 退出）不受影响
		expect(prompt.includes("口语搭骨架")).toBe(true);
		expect(prompt.includes("写操作尚未开放")).toBe(false);
		// D4：规则 9 / upscale_image 工具名不出现（「冒充放大」句不含工具名）
		expect(prompt.includes("upscale_image")).toBe(false);
	});

	it("genTools 单独启用（无 writeTools）：第 10 条守卫仍在", async () => {
		const asm = makeAssembler({ nodes: [] });
		const prompt = await asm.assembleStatic({ ruleGroups: ["core", "genTools"] });
		expect(prompt.includes("11. run_image/video/text/prompt/audio_generation")).toBe(true);
		expect(prompt.includes("写操作尚未开放")).toBe(true);
	});
});

describe("注入 manifest 观测（WorkBuddy 对齐 §4-2）", () => {
	it("每层自带 approxTokens，且等于 approxTokens(content)", async () => {
		const asm = makeAssembler({ nodes: [{ id: "n1", type: "image", title: "T", status: "ready" }] });
		await asm.assembleDynamic({ sessionId: "s1", attachments: [{ text: "TXT", mediaType: "text" }] });
		const layers = asm.lastLayers!;
		expect(layers.length).toBeGreaterThan(1);
		for (const l of layers) {
			expect(l.approxTokens).toBe(approxTokens(l.content));
		}
	});

	it("layers 覆盖两段（静态段与动态段各自记录一次）", async () => {
		const asm = makeAssembler({ nodes: [{ id: "n1", type: "image", title: "T", status: "ready" }] });
		await asm.assembleStatic({ ruleGroups: ["core"] });
		expect(asm.lastLayers?.map((l) => l.kind)).toEqual(["rules"]);
		await asm.assembleDynamic({ sessionId: "s1" });
		expect(asm.lastLayers?.map((l) => l.kind)).toEqual(["canvas"]);
	});

	it("manifest 一行日志含 total 与 hash；动态段日志带 sessionId", async () => {
		const asm = makeAssembler({ nodes: [] });
		await asm.assembleDynamic({ sessionId: "s1" });
		const logged = asm.lastManifest as string;
		expect(logged).toMatch(/total=\d+tok/);
		expect(logged).toMatch(/hash=[0-9a-f]{12}/);
	});

	it("promptHash 稳定：同输入两次 hash 相同，内容变化则不同", async () => {
		const a = makeAssembler({ nodes: [] });
		const b = makeAssembler({ nodes: [] });
		const p1 = await a.assembleStatic({ ruleGroups: ["core"] });
		const p2 = await b.assembleStatic({ ruleGroups: ["core"] });
		expect(promptHash(p1)).toBe(promptHash(p2));
		expect(a.lastManifestDetail!.promptHash).toBe(promptHash(p1));
		// 换规则组 → 内容变 → hash 变
		const c = makeAssembler({ nodes: [] });
		await c.assembleStatic({ ruleGroups: ["core", "genTools"] });
		expect(c.lastManifestDetail!.promptHash).not.toBe(a.lastManifestDetail!.promptHash);
	});

	it("结构化 manifest：layers 列表 + totalTokens 为各层之和 + sessionId 透传", async () => {
		const asm = makeAssembler({ nodes: [{ id: "n1", type: "image", title: "T", status: "ready" }] });
		await asm.assembleDynamic({ sessionId: "s1", attachments: [{ text: "TXT", mediaType: "text" }] });
		const m = asm.lastManifestDetail!;
		expect(m.sessionId).toBe("s1");
		expect(m.layers.map((l) => l.id)).toEqual(asm.lastLayers!.map((l) => l.id));
		expect(m.layers.map((l) => l.id)).toEqual(["canvas-summary", "sidebar"]);
		expect(m.totalTokens).toBe(m.layers.reduce((s, l) => s + l.tokens, 0));
	});

	it("静态段 manifest：sessionId 为空串（静态段不归属某轮会话）", async () => {
		const asm = makeAssembler({ nodes: [] });
		await asm.assembleStatic({ ruleGroups: ["core"] });
		expect(asm.lastManifestDetail!.sessionId).toBe("");
		expect(asm.lastManifestDetail!.layers[0]).toMatchObject({ id: "rules", kind: "rules" });
	});
});
