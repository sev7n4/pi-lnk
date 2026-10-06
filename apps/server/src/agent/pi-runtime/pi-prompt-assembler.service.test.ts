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
	STATIC_BUDGET_CHARS,
} from "./prompt-registry.loader";
import {
	CORE_RULES_PREFIX,
	RULE_3_NO_GEN,
	RULE_3_GEN,
	CORE_RULES_TAIL,
	WRITE_TOOLS_RULES,
	CANVAS_VIEW_POLICY,
	CANVAS_DAILY_OPS,
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
		// 规则 4 原文特征句（2026-10-04 W4 压缩措辞：「建/更新节点」→「建节点」、
		// 「并等待用户确认」→「等用户确认」，约束未变）
		expect(prompt.includes("upsert_media_node 建节点（可带 prompt）")).toBe(true);
		expect(prompt.includes("mentioned_keys 用 I1/I2 芯片序")).toBe(true);
		// 规则 5 原文特征句
		expect(prompt.includes("口语搭骨架")).toBe(true);
		expect(prompt.includes("不要把 @I* 芯片连成边")).toBe(true);
		// 第 10 条守卫退出
		expect(prompt.includes("写操作尚未开放")).toBe(false);
		// 规则 6（tool_search 旧路径）与 8/9 不注入（见计划 §1.2 声明偏离）
		// ⚠️ 但W4 新增的 canvas_daily_ops 规则 22 **确实**提到 tool_search
		//（那是「用 tool_search 搜」的行为约定，不是渐进披露的规则 6 原条）
		expect(prompt.includes("upscale_image")).toBe(false);
		// ⭐ W4（2026-10-04）：画布日常操作规则必须进 writeTools 组
		// —— L1 实测 `tool-discovery-001`（话术「把 30 个节点按左右关系重新排一下」
		// 期望 arrange_nodes，实际只调 get_canvas_summary/layout）的根因就是它缺位。
		expect(prompt.includes("arrange_nodes")).toBe(true);
		// ⭐ 2026-10-06 减点名第一批：规则 20/21 改写为能力描述 + tool_search 指引，
		// 读类诊断工具名不再出现在下发静态段（对应 tiering.ts 的下沉）。
		expect(prompt.includes("tool_search 搜「画布/节点/任务/进度/资产/文档」")).toBe(true);
		expect(prompt.includes("list_generation_tasks")).toBe(false);
		expect(prompt.includes("get_canvas_summary")).toBe(false);
	});

	it("规则 14：无工作流模板能力——如实说明，禁止虚构模板（B 决策：workflow 不迁 pi）", async () => {
		const asm = makeAssembler({ nodes: [] });
		// core 组即注入（与是否启用 writeTools/genTools 无关）
		for (const groups of [["core"], ["core", "writeTools"], ["core", "writeTools", "genTools"]] as const) {
			const prompt = await asm.assembleStatic({
				ruleGroups: groups as Array<"core" | "writeTools" | "genTools">,
			});
			expect(prompt.includes("本会话没有工作流模板能力")).toBe(true);
			// 2026-10-04 W4 压缩：「直接用节点 + 连线搭骨架来替代」→「直接用节点+连线搭骨架替代」
			expect(prompt.includes("直接用节点+连线搭骨架替代")).toBe(true);
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
		expect(prompt.includes("12. run_* 返回 timeout")).toBe(true);
		expect(prompt.includes("fallback_pending")).toBe(true);
		expect(prompt.includes("cancel_generation")).toBe(true);
		// U8 TTS 边界（2026-10-06）：规则 23 随 genTools 注入
		expect(prompt.includes("23. run_audio_generation 只做配音/朗读")).toBe(true);
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
	// canvas_view_policy（order 45）与 canvas_daily_ops（order 46）夹在
	// writeTools(40) 与 genTools(50) 之间，与磁盘 order 一致
	"core+writeTools": `${CORE}\n${WRITE_TOOLS_RULES}\n${CANVAS_VIEW_POLICY}\n${CANVAS_DAILY_OPS}`,
	// 守卫排在 11/12/13 之后（push 顺序 core → GEN → GUARD；按 order 排 guard 也落在最后）
	"core+genTools": `${CORE_GEN}\n${GEN_TOOLS_RULES}\n${RULE_10_WRITE_GUARD}`,
	// genTools 开 → core 内部用规则 3'（否则会与「genTools 未启用」那版同时出现）
	"core+writeTools+genTools": `${CORE_GEN}\n${WRITE_TOOLS_RULES}\n${CANVAS_VIEW_POLICY}\n${CANVAS_DAILY_OPS}\n${GEN_TOOLS_RULES}`,
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

/**
 * §8.1 组装管线契约测试（进 PR 门禁，M3）。
 *
 * 用 `renderStaticFallback`（内嵌常量）而非 `renderStatic`：门禁判据逐字可查、
 * 不依赖磁盘，环境差异为零；两路等价由上方 W1a 的「四组合逐字符等于磁盘渲染」保证。
 *
 *⚠️ **防假绿纪律**（本任务前三个任务在同一坑上踩了三次：判据看似存在、实则永不匹配）：
 * - 每条判据都成对：正例（该报的报）+ 反例（不该报的不报），见各 case 注释里的「反例对照」标记；
 * - 长度表把「规则正文被改动」变成红灯（预算基线锁），避免 `not.toContain` 靠「两路都空」蒙混过关；
 * - 互斥类断言前置「两版文本都非空且长度不同」守卫，否则 `""` 也能满足 not.toContain。
 *
 * ⚠️ **基线锁自己也踩过一次假绿**（2026-10-05，PR #182 CI 红灯）：
 * 本表的 `core+writeTools` 曾写成 2478，实际是 2493——写表时用的是「上一轮的数字」而非
 * 在目标 commit 上实测。**基线锁能挡住"规则被改"，但挡不住"基线本身抄错"**。
 * ⇒ 填表纪律：先 `git worktree add /tmp/x <commit>`拿到目标代码，`npx tsx` 实测四个组合，再填。
 */
describe("组装管线契约（spec §8.1，M3 PR 门禁）", () => {
	/**
	 * 长度基线。**改动规则正文后必须同步更新这张表**——这是本测试存在的意义：
	 * 让「规则正文被改了但基线没更新」变成红灯，而不是静默放过。
	 *
	 * 数字来源（2026-10-06 用 `npx tsx` 在本 worktree 上实测，不是推算）。
	 * 相对 #215 合并点的逐组增量（`renderStaticFallback` 逐组合实跑）：
	 * - core：693 → 693（Δ=0，未动 core 段）
	 * - core+genTools：1132 → 1113（**Δ=−19**，`gen_tool_policy` 规则 12 删工具名「可 get_generation_status 再查」→「可再查生成状态」）
	 * - core+writeTools：2756 → 2622（**Δ=−134**，`canvas_daily_ops` 规则 20/21 删 7 个读工具名、改写为能力描述 + tool_search 指引）
	 * - 全组合：3195 → 3042（**Δ=−153**）
	 * ⇒ 余量 3200 − 3042 = **158（大幅缓解 #208 以来的贴线状态）**
	 * 同一笔改动把读类诊断 9 工具下沉延迟集（tiering.ts），点名撤除是下沉前提——见该文件头注释。
	 *
	 * ⚠️ 抬 `STATIC_BUDGET_CHARS` 属 `AGENTS.md` 红线第3 条（须人工决策），AI 不得自行改。
	 * ⚠️ 本表曾把 master 的 writeTools 段误记为 2478（实际 2473），导致 CI 红灯。
	 * **填表前必须在目标 commit 上实测**，别用上一轮的数推算。
	 */
	const BASELINE: Record<string, number> = {
		core: 693,
		"core+writeTools": 2656,
		"core+genTools": 1113,
		"core+writeTools+genTools": 3076,
	};

	it("长度基线锁：四组合静态段长度与预算余量（规则正文改动 ⇒ 红灯）", () => {
		for (const [name, groups] of Object.entries(GROUPS)) {
			expect({ [name]: renderStaticFallback(groups).length }).toEqual({ [name]: BASELINE[name] });
		}
		// 预算余量可见：全组合距硬线还剩多少（spec §L6 门禁数字的单一事实源）
		// 2026-10-06 减点名第一批：规则 20/21/12 删读工具名改能力描述，3195→3042（余量 5→158，贴线状态解除）。
		// 2026-10-06 规则 22 压「叙述代替调用」失败形态（分级下发实验残余 ~10-20%）：+34 字符，3042→3076（余量 158→124）。
		// **本断言不做"余量必须为正"的门禁**——那是 `prompt-lint` 的 L6 职责，
		// 且抬预算属人工决策；这里只如实锁住实测值，避免文档/基线与实跑漂移。
		expect(STATIC_BUDGET_CHARS - BASELINE["core+writeTools+genTools"]!).toBe(124);
	});

	// ── case 1：no_gen_claim.gen / .nogen 互斥（§8.1 表格 #1）──────────────
	it("case1a：genTools 启用时含「已 propose_generation 且用户明确同意」", () => {
		const on = renderStaticFallback(["core", "writeTools", "genTools"]);
		expect(on).toContain("已 propose_generation 且用户明确同意");
		// 同组必须注入规则 11/12/13（否则上面那句可能来自别处）
		expect(on).toContain("11. run_image/video/text/prompt/audio_generation");
	});

	it("case1b：genTools 未启用时改为「禁止调用任何 run_*」", () => {
		const off = renderStaticFallback(["core", "writeTools"]);
		expect(off).toContain("禁止调用任何 run_*");
		// 未启用 ⇒ 生成闭环规则 11/12/13 不该出现
		expect(off).not.toContain("11. run_image/video/text/prompt/audio_generation");
	});

	it("case1c：两版互斥——不会同时出现（反例对照：正例证明判据会命中，反例证明不是恒真）", () => {
		const on = renderStaticFallback(["core", "writeTools", "genTools"]);
		const off = renderStaticFallback(["core", "writeTools"]);
		// 反例对照：on 里不得有 nogen 版措辞，off 里不得有 gen 版措辞
		expect(on).not.toContain("禁止调用任何 run_*");
		expect(off).not.toContain("已 propose_generation 且用户明确同意");
		//⚠️ 防「两版都空 ⇒ not.toContain 恒真」：两版都必须非空、且长度不同
		expect(on.length).toBeGreaterThan(0);
		expect(off.length).toBeGreaterThan(0);
		expect(on).not.toBe(off);
		// 且两版都真的带规则 3（互斥发生在规则 3 内部，不是靠整条规则缺席）
		expect(on).toContain("用户明确同意前禁止调用 run_*_generation");
		expect(off).toContain("不要调用 run_*_generation");
	});

	// ── case 2：write_guard 的 unlessGroup（§8.1 表格 #2）────────────────────
	it("case2a：只读会话注入只读守卫", () => {
		expect(renderStaticFallback(["core"])).toContain("当前会话仅开放只读查询工具");
		// 整段常量在（不只是碰巧含那几个字）
		expect(renderStaticFallback(["core"])).toContain(RULE_10_WRITE_GUARD);
	});

	it("case2b：有写工具时绝不注入只读守卫", () => {
		const withWrite = renderStaticFallback(["core", "writeTools"]);
		expect(withWrite).not.toContain("仅开放只读查询工具");
		expect(withWrite).not.toContain(RULE_10_WRITE_GUARD);
		// 守卫确实退场了、且不是靠整段 core 消失（core 恒注入）
		expect(withWrite).toContain("你是 lnkpi 无限画布助手");
	});

	it("case2c：genTools 不影响守卫的注入判据（反例对照：两组只差 writeTools，守卫结论相反）", () => {
		// 反例对照的核心：同样开着 genTools，只切writeTools ⇒ 守卫结论必须翻转。
		// 若守卫判据被错写成 groups.includes("genTools")，这两条会同时成立并红。
		expect(renderStaticFallback(["core", "genTools"])).toContain("当前会话仅开放只读查询工具");
		expect(renderStaticFallback(["core", "writeTools", "genTools"])).not.toContain("仅开放只读查询工具");
		// 且守卫位置在生成规则之后（core → GEN → GUARD 的push 顺序）
		const t = renderStaticFallback(["core", "genTools"]);
		expect(t.indexOf("11. run_image/video/text/prompt/audio_generation")).toBeLessThan(
			t.indexOf(RULE_10_WRITE_GUARD),
		);
	});

	// ── case 5：组装幂等（§8.1 表格 #5）────────────────────────────────────
	// ⚠️ 这里**不再**写 `promptHash(renderStaticFallback(g)) === promptHash(renderStaticFallback(g))`
	// 那条自比较是恒真断言：两侧是同一个表达式，`renderStaticFallback` 对同一组恒返回同一常量，
	// `promptHash` 又是纯 sha256（无随机源）⇒ 它在任何实现下都不会红。
	// RED 取证：把它换成返回空串 / 漏拼全部规则 / 截断乱序 / 恒返回无关常量 4种坏实现，
	// 该断言**全部仍绿**；唯一能让它转红的是「函数非确定性」，而那不是本条要守的性质。
	// 幂等性由下面case5b（跨组装路径 hash 相等 + 换组必换 hash）与 case5c（端到端两次装配）覆盖。

	it("case5b：跨组装路径（内嵌常量 vs 磁盘Registry）同一 hash（反例对照：换组必换hash）", () => {
		const groups = ["core", "writeTools", "genTools"] as const;
		const fromConstants = renderStaticFallback(groups);
		const fromDisk = renderStatic(loadRegistry(resolveRegistryRoot()), groups);
		expect(promptHash(fromConstants)).toBe(promptHash(fromDisk));
		// 反例对照：hash 不是常量，组变化必须改变它（否则上一条是恒真的"同一个字符串算两次"）
		expect(promptHash(fromConstants)).not.toBe(promptHash(renderStaticFallback(["core"])));
		expect(promptHash(renderStaticFallback(["core"]))).toMatch(/^[0-9a-f]{12}$/);
	});

	it("case5c：assembleStatic 端到端逐字节稳定（同一 ruleGroups 两次装配 hash 相同）", async () => {
		const a = makeAssembler({ nodes: [] });
		const b = makeAssembler({ nodes: [] });
		const groups = ["core", "writeTools", "genTools"] as const;
		const p1 = await a.assembleStatic({ ruleGroups: [...groups] });
		const p2 = await b.assembleStatic({ ruleGroups: [...groups] });
		expect(p1).toBe(p2);
		expect(promptHash(p1)).toBe(promptHash(p2));
		// 反例对照：不同组必须换 hash
		const c = makeAssembler({ nodes: [] });
		expect(promptHash(await c.assembleStatic({ ruleGroups: ["core"] }))).not.toBe(promptHash(p1));
	});
});


// ── SEL-REF：指代信号动态块（R-S6：块体自解释、只含 id/type/标题）────────
describe("PiPromptAssembler 动态段（assembleDynamic：SEL-REF 指代块）", () => {
	it("selectedNodeIds 非空时追加 digest 块", async () => {
		const asm = makeAssembler({ nodes: [{ id: "a", type: "image", title: "小柚定妆照", status: "ready" }] });
		const blocks = await asm.assembleDynamic({
			sessionId: "s1",
			selectedNodeIds: ["a"],
			selectedNodeLookup: (id) =>
				id === "a" ? { type: "image", title: "小柚定妆照", x: 0, y: 0 } : undefined,
		});
		expect(blocks.some((b) => b.startsWith("【用户当前选中】"))).toBe(true);
	});

	it("selectedNodeIds 为空时不追加该块", async () => {
		const asm = makeAssembler({ nodes: [] });
		const blocks = await asm.assembleDynamic({ sessionId: "s1", selectedNodeIds: [] });
		expect(blocks.some((b) => b.startsWith("【用户当前选中】"))).toBe(false);
	});

	it("selectedNodeIds 缺省时不追加该块", async () => {
		const asm = makeAssembler({ nodes: [] });
		const blocks = await asm.assembleDynamic({ sessionId: "s1" });
		expect(blocks.some((b) => b.startsWith("【用户当前选中】"))).toBe(false);
	});

	it("全部 id 查不到时返回 null ⇒ 不注入半截列表（R-S7 fail-open）", async () => {
		const asm = makeAssembler({ nodes: [] });
		const blocks = await asm.assembleDynamic({
			sessionId: "s1",
			selectedNodeIds: ["x"],
			selectedNodeLookup: () => undefined,
		});
		expect(blocks.some((b) => b.startsWith("【用户当前选中】"))).toBe(false);
	});
});
