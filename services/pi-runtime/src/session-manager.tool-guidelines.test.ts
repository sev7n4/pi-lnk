import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { SessionManager, renderToolGuidelinesBlock, appendPromptBlocks } from "./session-manager.js";
import { buildTodoTools } from "./tools/todo.js";
import { createProposePlanTool } from "./tools/propose-plan.js";
import type { LnkpiTool } from "./tools/types.js";
import type { RuntimeConfig } from "./runtime-config.js";

// ═══════════════════════════════════════════════════════════════════════════
// B-3 工具引导一等化（spec 2026-11-15-b3-tool-guidelines-design.md §4 验收锚 1/4）
// ① renderToolGuidelinesBlock 渲染三形态；② composeSystemPrompt 接线（wiring）；
// ③ 等量置换对账：todo_write/propose_plan 两条 guidelines 逐字还原原 task_tool.md body。
// ═══════════════════════════════════════════════════════════════════════════

const TEST_ROOT = join(tmpdir(), `b3-guidelines-${process.pid}`);

after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `g${++cfgSeq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	};
}

function makeCapturingHarnessFactory() {
	let captured: Record<string, unknown> | undefined;
	const fakeHarnessFactory = async (cfg: unknown) => {
		captured = cfg as Record<string, unknown>;
		return {
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({ prompt: async () => ({ ok: true }) }),
				close: async () => {},
			},
		} as never;
	};
	return {
		get captured() {
			return captured;
		},
		fakeHarnessFactory,
	};
}

describe("renderToolGuidelinesBlock（B-3 D-3 渲染规则）", () => {
	it("有 guidelines：每条 bullet 带工具名前缀，XML 包装，空白条目跳过", () => {
		const tools = [
			{ name: "todo_write", promptGuidelines: ["第一条", "  第二条  ", "   "] },
			{ name: "no_guide" },
		] as unknown as LnkpiTool[];
		assert.equal(
			renderToolGuidelinesBlock(tools),
			"<tool_guidelines>\n- todo_write: 第一条\n- todo_write: 第二条\n</tool_guidelines>",
		);
	});

	it("无任何工具声明 ⇒ 段空整段不出现（A-3 缺省键不出现纪律）", () => {
		const tools = [{ name: "a" }, { name: "b", promptGuidelines: [] }] as unknown as LnkpiTool[];
		assert.equal(renderToolGuidelinesBlock(tools), "");
		assert.equal(renderToolGuidelinesBlock([]), "");
	});

	it("部分工具声明 ⇒ 只列声明者（无 guidelines 工具不出现）", () => {
		const tools = [
			{ name: "plain" },
			{ name: "propose_plan", promptGuidelines: ["需先出方案时先征确认。"] },
		] as unknown as LnkpiTool[];
		assert.equal(
			renderToolGuidelinesBlock(tools),
			"<tool_guidelines>\n- propose_plan: 需先出方案时先征确认。\n</tool_guidelines>",
		);
	});

	it("appendPromptBlocks 对 guidelines 块同样幂等（base 已含时不重复拼）", () => {
		const block = "<tool_guidelines>\n- todo_write: x\n</tool_guidelines>";
		const base = `BASE\n\n${block}`;
		assert.equal(appendPromptBlocks(base, [block]), base);
	});
});

describe("composeSystemPrompt 接线（B-3 §2.2：staticPrompt 含 tool_guidelines 段）", () => {
	it("带 promptGuidelines 的工具注册 ⇒ captured systemPrompt 含该段与 bullet", async () => {
		const h = makeCapturingHarnessFactory();
		const todo = buildTodoTools()[0];
		assert.ok(todo, "todo_write 默认开启（kill switch env 未设）");
		const sm = new SessionManager(
			[todo],
			"",
			undefined,
			h.fakeHarnessFactory as never,
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("s-b3", { systemPrompt: "BASE" });
		// captured.systemPrompt 是 vendor 直通求值函数（generation.ts 求值后才成为请求 systemPrompt）
		const prompt = String(await (h.captured!.systemPrompt as (tc: unknown) => string | Promise<string>)({}));
		assert.match(prompt, /<tool_guidelines>/);
		assert.match(prompt, /- todo_write: 多步任务开工前 todo_write 提交清单（全量覆写）/, "bullet 带工具名前缀");
		assert.ok(prompt.startsWith("BASE"), "guidelines 段在 base 之后（静态追加）");
	});

	it("全部工具无 guidelines ⇒ captured systemPrompt 不含该段（整段不出现）", async () => {
		const h = makeCapturingHarnessFactory();
		const sm = new SessionManager(
			[{ name: "t_plain", description: "d" } as never],
			"",
			undefined,
			h.fakeHarnessFactory as never,
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("s-b3-none", { systemPrompt: "BASE" });
		const prompt = String(await (h.captured!.systemPrompt as (tc: unknown) => string | Promise<string>)({}));
		assert.equal(prompt.includes("<tool_guidelines>"), false);
	});
});

describe("等量置换对账（B-3 §2.3 / 变异自检②：迁移文本不匹配 ⇒ RED）", () => {
	// 原 prompt-registry/rules/task_tool.md v1.1.0 body（删除 commit 可 diff 回溯）
	const ORIGINAL_TASK_TOOL_BODY =
		"多步任务开工前 todo_write 提交清单（全量覆写），完成即更新，全部完成交空数组；需先出方案时先 propose_plan 征确认再执行，确认前不写画布不调生成。";

	it("todo_write + propose_plan 两条 guidelines 逐字还原原 task_tool body（分号为句界）", () => {
		const todo = buildTodoTools().find((t) => t.name === "todo_write");
		assert.ok(todo?.promptGuidelines?.length === 1, "todo_write 恰好一条 guideline");
		const registryStub = {} as never;
		const metricsStub = {} as never;
		const plan = createProposePlanTool(registryStub, metricsStub);
		assert.ok(plan.promptGuidelines?.length === 1, "propose_plan 恰好一条 guideline");
		const [todoG] = todo.promptGuidelines;
		const [planG] = plan.promptGuidelines;
		// 逐字对账：todo 侧句尾「。」对应原文分号位，拼接还原原文全句
		assert.equal(`${todoG.slice(0, -1)}；${planG}`, ORIGINAL_TASK_TOOL_BODY);
	});
});
