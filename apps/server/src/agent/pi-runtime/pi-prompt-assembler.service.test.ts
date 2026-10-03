import { describe, expect, it } from "vitest";
import {
	PiPromptAssembler,
	approxTokens,
	promptHash,
} from "./pi-prompt-assembler.service";
import {
	loadRegistry,
	renderStatic,
	renderStaticFallback,
	resolveRegistryRoot,
} from "./prompt-registry.loader";
import {
	CORE_RULES_PREFIX,
	RULE_3_NO_GEN,
	RULE_3_GEN,
	CORE_RULES_TAIL,
	WRITE_TOOLS_RULES,
	GEN_TOOLS_RULES,
	RULE_10_WRITE_GUARD,
	MEMORY_SCOPE_RULES,
} from "./prompt-registry.fallback";


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

describe("长期记忆动态注入（审计 #7：PromptLayerKind.memory 空壳落地）", () => {
	const NODES = { nodes: [{ id: "n1", type: "image", title: "T", status: "ready" }] };

	it("memoryBlock 非空 → 追加为动态块，manifest 记 memory kind", async () => {
		const asm = makeAssembler(NODES);
		const blocks = await asm.assembleDynamic({
			sessionId: "s1",
			memoryBlock: "## 长期记忆（用户历史偏好，供参考）\n- 喜欢深色主题",
		});
		expect(blocks.at(-1)).toContain("长期记忆");
		expect(blocks.at(-1)).toContain("喜欢深色主题");
		expect(asm.lastManifestDetail.layers.some((l) => l.kind === "memory")).toBe(true);
	});

	it("memoryBlock 缺省/空串 → 不产生 memory 层（向后兼容）", async () => {
		const asm = makeAssembler(NODES);
		const blocks = await asm.assembleDynamic({ sessionId: "s1" });
		expect(blocks.join("\n")).not.toContain("长期记忆");
		expect(asm.lastManifestDetail.layers.some((l) => l.kind === "memory")).toBe(false);

		const asm2 = makeAssembler(NODES);
		const blocks2 = await asm2.assembleDynamic({ sessionId: "s1", memoryBlock: "   " });
		expect(blocks2.join("\n")).not.toContain("长期记忆");
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

describe("approxTokens（CJK-aware，审计 P0-②）", () => {
	it("CJK 每字约 1 token（旧口径低估 3 倍）", () => {
		expect(approxTokens("四个中文字符")).toBe(6);
	});
	it("纯 ASCII 维持 1/4 口径", () => {
		expect(approxTokens("abcdefgh")).toBe(2);
	});
	it("混合文本（4 CJK + 8 ASCII → 4 + 2）", () => {
		expect(approxTokens("两个汉字abcdefgh")).toBe(6);
	});
	it("CJK 标点/全角也按 1 计", () => {
		expect(approxTokens("，。！")).toBe(3);
	});
	it("空串为 0", () => {
		expect(approxTokens("")).toBe(0);
	});
});

describe("assembleDynamic 焦点过滤透传（审计 P0-①）", () => {
	const makeFocusAssembler = (result: unknown, spy: (input: unknown) => void) =>
		new PiPromptAssembler({
			getCanvasSummary: async (input: never) => {
				spy(input);
				return result;
			},
		} as never);

	it("有 focusNodeId 时透传给 getCanvasSummary", async () => {
		let received: unknown;
		const assembler = makeFocusAssembler({ nodes: [{ id: "a", type: "prompt", title: "A", status: "draft" }] }, (i) => (received = i));
		await assembler.assembleDynamic({ sessionId: "s1", focusNodeId: "image-1" });
		expect((received as { focusNodeId?: string }).focusNodeId).toBe("image-1");
	});

	it("omittedCount > 0 时摘要带提示行（告知模型可 get_canvas_layout 取全量）", async () => {
		const assembler = makeFocusAssembler(
			{
				nodes: [{ id: "a", type: "prompt", title: "A", status: "draft" }],
				omittedCount: 40,
				focusNodeId: "image-1",
			},
			() => {},
		);
		const blocks = await assembler.assembleDynamic({ sessionId: "s1", focusNodeId: "image-1" });
		expect(blocks[0]).toContain("40");
		expect(blocks[0]).toContain("get_canvas_layout");
		expect(blocks[0]).toContain("image-1");
	});

	it("无 focusNodeId / omittedCount → 行为与现状一致（纯 JSON 摘要）", async () => {
		const assembler = makeFocusAssembler(
			{ nodes: [{ id: "a", type: "prompt", title: "A", status: "draft" }] },
			() => {},
		);
		const blocks = await assembler.assembleDynamic({ sessionId: "s1" });
		expect(blocks[0]).toContain('"id":"a"');
		expect(blocks[0]).not.toContain("get_canvas_layout");
	});
});

// W1a 字节等价护栏：期望串按「搬家前的 composeRuleText」逐段拼出来
// （core = 前缀 + 规则 3 + 尾部；writeTools 开 → 规则 4/5；否则补第 10 条守卫；genTools 开 → 追加 11/12/13）
// 记忆归属规则（order 35）排在 sidebar_vision.tail 之后，与磁盘 Registry 的 order 排序一致
const CORE = `${CORE_RULES_PREFIX}\n${RULE_3_NO_GEN}\n${CORE_RULES_TAIL}\n${MEMORY_SCOPE_RULES}`;
const CORE_GEN = `${CORE_RULES_PREFIX}\n${RULE_3_GEN}\n${CORE_RULES_TAIL}\n${MEMORY_SCOPE_RULES}`;

const GROUPS: Record<string, Array<"core" | "writeTools" | "genTools">> = {
	core: ["core"],
	"core+writeTools": ["core", "writeTools"],
	"core+genTools": ["core", "genTools"],
	"core+writeTools+genTools": ["core", "writeTools", "genTools"],
};

const EXPECTED: Record<string, string> = {
	core: `${CORE}\n${RULE_10_WRITE_GUARD}`,
	"core+writeTools": `${CORE}\n${WRITE_TOOLS_RULES}`,
	// 守卫排在 11/12/13 之后（push 顺序 core → GEN → GUARD；按 order 排 guard 也落在最后）
	"core+genTools": `${CORE_GEN}\n${GEN_TOOLS_RULES}\n${RULE_10_WRITE_GUARD}`,
	// genTools 开 → core 内部用规则 3'（否则会与「genTools 未启用」那版同时出现）
	"core+writeTools+genTools": `${CORE_GEN}\n${WRITE_TOOLS_RULES}\n${GEN_TOOLS_RULES}`,
};

describe("W1a 字节等价：Registry 渲染 == 搬家前的 composeRuleText", () => {
	for (const [name, groups] of Object.entries(GROUPS)) {
		it(`组合 ${name} 逐字符相等`, async () => {
			const asm = makeAssembler({ nodes: [] });
			const text = await asm.assembleStatic({ ruleGroups: groups });
			expect(text).toBe(EXPECTED[name]);
			// 第二重保险：与内嵌常量兜底路径渲染结果一致
			expect(text).toBe(renderStaticFallback(groups));
			// 第三重保险：与磁盘 Registry 渲染一致
			expect(text).toBe(renderStatic(loadRegistry(resolveRegistryRoot()), groups));
		});
	}

	it("renderStaticFallback 在 !writeTools 时补写守卫", () => {
		expect(renderStaticFallback(["core"]).includes(RULE_10_WRITE_GUARD)).toBe(true);
		expect(renderStaticFallback(["core", "writeTools"]).includes(RULE_10_WRITE_GUARD)).toBe(false);
	});

	it("manifest 行带 Registry 版本身份", async () => {
		const asm = makeAssembler({ nodes: [] });
		await asm.assembleStatic({ ruleGroups: ["core"] });
		expect(asm.lastManifest).toContain("registry=");
		expect(asm.lastManifest).toContain("registryHash=");
		expect(asm.lastManifestDetail?.registryHash).toBeTruthy();
	});
});
