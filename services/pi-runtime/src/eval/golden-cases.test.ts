import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
	GOLDEN_CASES,
	evaluateCase,
	evaluateStep,
	evaluateMultiStep,
	judgeCanvasState,
	pickLatestPlanSnapshot,
	type GoldenCase,
	type GoldenStep,
} from "./golden-cases.js";
import { verdictOfSteps } from "./runner.js";
import type { EvalTranscript } from "./transcript.js";

/**
 * L0 契约层（零 token，PR 必跑）。
 *
 * ⭐ 这一层**不需要 LLM 凭据、不烧 token**，因此能在每个 PR 上硬卡。
 * 它抓的是「评测集与判据自身的错」—— 那类错会让 L1 跑出**看似合理实则全错**的结论。
 *
 * 对应 Round 2 §07.1 的「L0 契约层：Registry schema、规则编号连续性、工具元信息、
 * prompt hash 稳定性」；Registry 那部分已由 `scripts/prompt-lint.ts` 覆盖，
 * 本文件只管**评测集自身**的契约。
 */

const EMPTY: EvalTranscript = {
	assistantText: "",
	toolNames: [],
	toolCalls: [],
	completed: true,
	errors: [],
};

function transcriptOf(partial: Partial<EvalTranscript>): EvalTranscript {
	return { ...EMPTY, ...partial };
}

/**
 * 判断某工具在 `about` 里的提及是否处于**否定 / 历史**语境
 * （如「不必走 tool_search」「历史写法是 tool_search，已改正」）。
 *
 * ⭐ 为什么不用「整个 about 有没有否定词」：那太脆。
 * 实测 `tool-discovery-001` 写的是「再要求绕 tool_search 会与判据矛盾」，
 * 没有「不必走」三字，但语义上就是在说「不该再用它」。
 * ⇒ 判据必须是**该工具名出现位置的前文**有没有否定/历史标记。
 */
function isNegatedMention(about: string, tool: string): boolean {
	const NEG = /(不必|不应|不用|无需|不需要|不该|勿|别|不再|改为|已回归|历史|原文|原写|已改正|矛盾)/;
	let idx = about.indexOf(tool);
	while (idx >= 0) {
		const before = about.slice(Math.max(0, idx - 40), idx);
		if (NEG.test(before)) return true;
		idx = about.indexOf(tool, idx + 1);
	}
	return false;
}

/**
 * 取某个 case 在**源文件里**的整段原文（含紧随其后的注释）。
 *
 * ⭐ 为什么需要它：`about` 里"为什么故意不写死 expectTools"这类理由
 * 往往写在**代码注释**里而不是 about 字段里（实测 vision-001 就是这样）。
 * 只看 `about` 字段会让一致性检查误报 ⇒ 必须回读源码。
 */
function caseSource(caseId: string): string {
	// ⚠️ 不用 `new Error().stack` 定位：tsx 会转换模块，stack 里的路径不可靠
	//（实测第一次这么写就报 `readFileSync is not defined`，因为 import 也被漏插了）。
	// ⇒ 用 `import.meta.url`（稳定指向本测试文件）。
	// C-1a 起种子集在 canvas-decomposition-cases.ts；C-1b 起多轮集在 canvas-multiturn-cases.ts。
	const selfDir = dirname(fileURLToPath(import.meta.url));
	for (const file of [
		"golden-cases.ts",
		"canvas-decomposition-cases.ts",
		"canvas-multiturn-cases.ts",
	]) {
		const src = readFileSync(join(selfDir, file), "utf8");
		const i = src.indexOf(`id: "${caseId}"`);
		if (i < 0) continue;
		// 到下一个 case 或 1200 字符为止
		const rest = src.slice(i + 1);
		const next = rest.search(/\n\t\{\n\t\tid: "/);
		return src.slice(i, next < 0 ? Math.min(src.length, i + 1200) : i + 1 + next);
	}
	return "";
}

describe("L0 · 评测集自身契约", () => {
	it("case id 唯一（重复会让报告里两条无法区分）", () => {
		const ids = GOLDEN_CASES.map((c) => c.id);
		const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
		assert.deepEqual(dupes, [], `重复 id：${dupes.join(", ")}`);
	});

	it("⭐ 来源纪律：production 必须可溯源，synthetic 必须自带理由（C-1a 双源纪律）", () => {
		// C-1 立项 spec §3：不允许无标注 synthetic。三类各自的硬要求：
		// production ⇒ about 必含 13 位时间戳出处（executionEvents 反查可溯源）；
		//   audit 不要求——首批 12 条早于 executionEvents 取证口径，审计报告即出处；
		// synthetic ⇒ about 必含「synthetic」字样 + 反查不到的理由段。
		const problems: string[] = [];
		for (const c of GOLDEN_CASES) {
			if (c.origin === "production" && !/\d{13}/.test(c.about)) {
				problems.push(`${c.id}: origin=production 但 about 无 13 位生产出处时间戳`);
			}
			if (c.origin === "synthetic" && !/synthetic/.test(c.about)) {
				problems.push(`${c.id}: origin=synthetic 但 about 无理由标注`);
			}
		}
		assert.deepEqual(problems, [], `来源标注违例：\n  ${problems.join("\n  ")}`);
	});

	it("⭐ expectTodoSnapshot 资产合法性（C-1a）", () => {
		const problems: string[] = [];
		for (const c of GOLDEN_CASES) {
			const s = c.expectTodoSnapshot;
			if (!s) continue;
			if (
				s.minItems !== undefined &&
				s.maxItems !== undefined &&
				s.minItems > s.maxItems
			) {
				problems.push(`${c.id}: minItems(${s.minItems}) > maxItems(${s.maxItems})——区间写错`);
			}
			if (
				s.firstStepPredicate !== undefined &&
				!["collect", "clarify", "any"].includes(s.firstStepPredicate)
			) {
				problems.push(`${c.id}: firstStepPredicate 非法值 ${s.firstStepPredicate}`);
			}
			// 快照判据不悬空：必须与工具触发判据并存（Q1 召回 + Q2 结构复合或负例禁列）
			// ⭐ C-1b：steps case 的顶层快照判据不存在（判据在各步），豁免
			if (!c.steps && !c.expectTools && !c.expectAnyTools && !c.forbidTools) {
				problems.push(`${c.id}: 有 expectTodoSnapshot 但无 expectTools/expectAnyTools/forbidTools`);
			}
		}
		// 负例形态：禁拆解负例必须同时禁两个拆解工具（对全部 case 生效——
		// 原版这段写在 `if (!s) continue` 之后，是**不可达死代码**，本次修复）
		for (const c of GOLDEN_CASES) {
			if (
				c.forbidTools?.includes("todo_write") &&
				!c.forbidTools.includes("propose_plan")
			) {
				problems.push(`${c.id}: 禁 todo_write 却不禁 propose_plan——拆解禁列不完整`);
			}
			if (
				c.forbidTools?.includes("propose_plan") &&
				!c.forbidTools.includes("todo_write")
			) {
				problems.push(`${c.id}: 禁 propose_plan 却不禁 todo_write——拆解禁列不完整`);
			}
		}
		assert.deepEqual(problems, [], `expectTodoSnapshot 资产违例：\n  ${problems.join("\n  ")}`);
	});

	it("每条 case 都有 about 说明（无说明的 case 没人能维护）", () => {
		const missing = GOLDEN_CASES.filter((c) => !c.about || c.about.trim().length < 8).map((c) => c.id);
		assert.deepEqual(missing, [], `缺 about：${missing.join(", ")}`);
	});

	// ========== about 与判据的一致性（2026-10-05 审计新增）==========
	// ⭐ 为什么要有这条：`about` 是**后人理解 case 的唯一入口**。
	// 2026-10-05 全量审计发现 `tool-discovery-001` 的 about 写的是
	// 「需要的能力不在手上时应先 tool_search」，而判据却是「期望调 arrange_nodes」
	// ⇒ **照着 about 理解会判错方向**（我2026-10-04~05 就被它误导过）。
	// ⇒ 把它变成可执行断言，而不是靠后人自觉。

	it("⭐ about 里提到的工具，必须出现在判据里（否则 about 在误导人）", () => {
		// ⚠️ 判据要覆盖 expectTools **与** forbidTools 两个数组。
		// 第一版只抓第一个数组 ⇒ 把 gen-claim-001 误报成不一致（它有 forbidTools）。
		// C-1b 起 judged 集合扩展：expectAnyTools（任一命中）+ expectTodoStatus 的
		// status 枚举值（in_progress/pending/completed 含下划线，会被工具名正则误抓）。
		const problems: string[] = [];
		for (const c of GOLDEN_CASES) {
			const mentioned = new Set(c.about.match(/\b([a-z][a-z0-9]+_[a-z0-9_]+)\b/g) ?? []);
			const judged = new Set([
				...(c.expectTools ?? []),
				...(c.forbidTools ?? []),
				...(c.expectAnyTools ?? []),
				...(c.expectTodoStatus?.allOf ?? []),
				...(c.expectTodoStatus?.requireAnyOf ?? []),
				// steps case 的判据在各步——顶层 judged 为空是常态
				...(c.steps?.flatMap((s) => [
					...(s.expectTools ?? []),
					...(s.forbidTools ?? []),
					...(s.expectAnyTools ?? []),
					...(s.expectTodoStatus?.allOf ?? []),
					...(s.expectTodoStatus?.requireAnyOf ?? []),
				]) ?? []),
			]);
			const missing = [...mentioned].filter((t) => !judged.has(t));
			if (missing.length > 0) {
				// ⚠️ 合法例外有两种，且**理由通常写在代码注释里而不是 about 字段里**
				// （实测 vision-001 就是这样：about 写「必须用视觉链路」，
				//  「不写死 expectTools」的理由写在紧随的 // 注释中）
				// ⇒ 判据必须看「about + 其后的注释」，否则会误报。
				const ctx = caseSource(c.id);
				const explained = /不写死|两者都是正确行为|取决于/.test(ctx);
				// ⭐ 否定/历史语境豁免：判据是「该工具名出现处的前文有没有否定或历史标记」，
				// 而不是整个 about 里有没有「不必走」——
				// 后者太脆：`tool-discovery-001` 写的是「再要求绕 tool_search 会与判据矛盾」，
				// 没有「不必走」三字，但语义上同样是在说「不该再用它」。
				const negated = missing.every((t) => isNegatedMention(c.about, t));
				// ⭐ C-1b：steps case 的判据在步内（about 描述的是全链行为）——
				// 源码含 steps 结构即豁免（步内判据已由 steps 专项 L0 校验覆盖）。
				const stepsBased = Boolean(c.steps) && /steps:/.test(ctx);
				if (!explained && !negated && !stepsBased) {
					problems.push(`${c.id}: about 提到 ${missing.join(", ")}，但判据里没有`);
				}
			}
		}
		assert.deepEqual(problems, [], `about 与判据不一致：\n  ${problems.join("\n  ")}`);
	});

	it("⭐ about 不得声称某工具「必须调」却不写进 expectTools", () => {
		// ⭐ 「必须」「一定要」这类**强断言措辞**会让 about 变成事实上的判据描述；
		// 若它与真正的 expectTools 不一致，后人会以为测试在测另一件事。
		// `vision-001` 是合法的反例：它用了「必须用视觉链路」但**故意不写死** expectTools
		// （两条路径都对）⇒ 允许「不写死」+注释说明的组合。
		const problems: string[] = [];
		for (const c of GOLDEN_CASES) {
			if (!/必须|一定要/.test(c.about)) continue;
			// ⭐ C-1b：expectAnyTools（任一命中）同样是「期望调用」判据——q4-02 等观测期 case 用它
			const hasExpect =
				(c.expectTools ?? []).length > 0 ||
				(c.expectAnyTools ?? []).length > 0 ||
				(c.steps?.some((s) => (s.expectTools ?? []).length > 0 || (s.expectAnyTools ?? []).length > 0) ?? false);
			// ⚠️ 同上：理由在代码注释里也算，必须看 case 源码上下文
			const justified = /不写死|两者都是正确行为|取决于/.test(caseSource(c.id));
			if (!hasExpect && !justified) {
				problems.push(`${c.id}: about 用「必须」但没写 expectTools，也无「不写死」的说明`);
			}
		}
		assert.deepEqual(problems, [], `about 强断言与判据不一致：\n  ${problems.join("\n  ")}`);
	});

	it("每条 case 至少有一个可判定判据（否则它不验证任何东西）", () => {
		// ⚠️ 判据是「字段存在」而非「字段为真」：`expectTools: []`（闲聊 case 的核心判据
		// 「不得调任何工具」）是**有效判据**，但 `!c.expectTools` 会把它判成 falsy。
		// 这里踩过一次 —— 用 `== null` 判缺失。
		// ⭐ C-1b：steps case 的判据在各步（顶层判据字段与 steps 互斥）——
		// steps 存在即算有效判据承载（步内判据由 steps 专项校验覆盖）。
		const noAssert = GOLDEN_CASES.filter(
			(c) =>
				!c.steps &&
				(c.expectTools ?? undefined) === undefined &&
				(c.expectAnyTools ?? undefined) === undefined &&
				(c.forbidTools ?? undefined) === undefined &&
				(c.expectTextIncludes ?? undefined) === undefined &&
				(c.forbidText ?? undefined) === undefined &&
				(c.expectTodoSnapshot ?? undefined) === undefined &&
				(c.expectTodoStatus ?? undefined) === undefined &&
				(c.expectCanvasState ?? undefined) === undefined,
		).map((c) => c.id);
		assert.deepEqual(noAssert, [], `无可判定判据：${noAssert.join(", ")}`);
		// 反向自检：上面那条判据本身要能识别「空数组算判据」——
		// 故意造一条只有 expectTools: [] 的 case，它不该进 noAssert。
		const emptyIsAssert: GoldenCase = { ...GOLDEN_CASES[0], id: "probe", expectTools: [] };
		const probeList = [emptyIsAssert].filter(
			(c) =>
				!c.steps &&
				(c.expectTools ?? undefined) === undefined &&
				(c.forbidTools ?? undefined) === undefined &&
				(c.expectTextIncludes ?? undefined) === undefined &&
				(c.forbidText ?? undefined) === undefined,
		);
		assert.deepEqual(probeList, [], "`expectTools: []` 必须被承认为有效判据");
	});

	it("expectTools 与 forbidTools 不含同一工具（自相矛盾）", () => {
		for (const c of GOLDEN_CASES) {
			const expect = new Set(c.expectTools ?? []);
			const clash = (c.forbidTools ?? []).filter((t) => expect.has(t));
			assert.deepEqual(clash, [], `${c.id}: ${clash.join(", ")} 既要求调又禁止调`);
		}
	});

	it("case 文本非空且不是占位（steps case 逐步校验话术）", () => {
		for (const c of GOLDEN_CASES) {
			if (c.steps) {
				// ⭐ C-1b：steps case 顶层无 text（互斥），话术在各步
				for (const [i, s] of c.steps.entries()) {
					assert.ok(s.text.trim().length > 0, `${c.id} step[${i}] 话术为空`);
					assert.ok(!/^(TODO|TBD|xxx)/i.test(s.text.trim()), `${c.id} step[${i}] 话术是占位符`);
				}
				continue;
			}
			// 单轮 case text 必填（runner 直接消费）
			assert.ok(c.text !== undefined, `${c.id} 单轮 case 缺 text`);
			assert.ok(c.text.trim().length > 0, `${c.id} 话术为空`);
			assert.ok(!/^(TODO|TBD|xxx)/i.test(c.text.trim()), `${c.id} 话术是占位符`);
		}
	});

	it("evaluateCase 在全部 case 上不抛异常（判据函数本身的健壮性）", () => {
		for (const c of GOLDEN_CASES) {
			assert.doesNotThrow(() => evaluateCase(c, EMPTY), `${c.id} 触发异常`);
		}
	});
});

describe("L0 · evaluateCase 判定语义", () => {
	const base: GoldenCase = {
		id: "t",
		origin: "audit",
		about: "用于测试判定语义",
		text: "x",
	};

	it("工具命中 ⇒ 通过", () => {
		const r = evaluateCase({ ...base, expectTools: ["a"] }, transcriptOf({ toolNames: ["a", "b"] }));
		assert.equal(r.passed, true);
		assert.deepEqual(r.failures, []);
	});

	it("⭐ 缺工具时失败信息要同时说出「缺什么」与「实际调了什么」", () => {
		// 否则 case 失败后人还得翻日志才知道发生了什么 —— eval 会被绕过。
		const r = evaluateCase(
			{ ...base, expectTools: ["propose_generation"] },
			transcriptOf({ toolNames: ["upsert_media_node"] }),
		);
		assert.equal(r.passed, false);
		assert.match(r.failures[0] ?? "", /propose_generation/);
		assert.match(r.failures[0] ?? "", /upsert_media_node/);
	});

	it("⭐ 调了被禁工具 ⇒ 失败，且报出实际调用序列", () => {
		const r = evaluateCase(
			{ ...base, forbidTools: ["run_image_generation"] },
			transcriptOf({ toolNames: ["upsert_media_node", "run_image_generation"] }),
		);
		assert.equal(r.passed, false);
		assert.match(r.failures[0] ?? "", /run_image_generation/);
	});

	it("期望空工具 + 实际调了 ⇒ 失败（闲聊 case 的核心判据）", () => {
		const r = evaluateCase({ ...base, expectTools: [] }, transcriptOf({ toolNames: ["upsert_media_node"] }));
		assert.equal(r.passed, false);
	});

	it("期望空工具 + 实际没调 + 正常结束 ⇒ 通过", () => {
		const r = evaluateCase(
			{ ...base, expectTools: [] },
			transcriptOf({ toolNames: [], assistantText: "不客气" }),
		);
		assert.equal(r.passed, true);
	});

	it("forbidText 命中虚假承诺 ⇒ 失败", () => {
		const r = evaluateCase(
			{ ...base, forbidText: ["正在生成"] },
			transcriptOf({ assistantText: "正在生成，请稍候" }),
		);
		assert.equal(r.passed, false);
		assert.match(r.failures[0] ?? "", /正在生成/);
	});

	it("未正常结束 ⇒ 失败（且带上原因）", () => {
		const r = evaluateCase(
			{ ...base, forbidText: ["x"] },
			transcriptOf({ completed: false, errors: ["upstream 503"] }),
		);
		assert.equal(r.passed, false);
		assert.ok(r.failures.some((f) => f.includes("未正常结束")));
		assert.ok(r.failures.some((f) => f.includes("upstream 503")));
	});

	it("expectCompleted:false 时未完成不算失败（负例 case 用）", () => {
		const r = evaluateCase(
			{ ...base, forbidTools: ["upsert_media_node"], expectCompleted: false },
			transcriptOf({ completed: false, toolNames: [] }),
		);
		assert.equal(r.passed, true);
	});

	it("多个问题全部报出（不只报第一个）", () => {
		const r = evaluateCase(
			{ ...base, expectTools: ["a"], forbidTools: ["z"], forbidText: ["假话"] },
			transcriptOf({ toolNames: ["z"], assistantText: "假话" }),
		);
		assert.equal(r.passed, false);
		assert.ok(r.failures.length >= 3, `应报出全部 3 个问题，实际 ${r.failures.length}`);
	});
});

describe("L0 · expectTodoSnapshot 判定语义（C-1a）", () => {
	const base: GoldenCase = {
		id: "t-snap",
		origin: "audit",
		about: "用于测试快照判定语义",
		text: "x",
	};

	/** 造一条 todo_write 调用（input 与 SSE 侧 data.input 同构）。 */
	function todoCall(items: Array<{ content?: string }>): EvalTranscript["toolCalls"][number] {
		return { name: "todo_write", callId: `c${todoCallSeq++}`, input: { todos: items } };
	}
	let todoCallSeq = 100;

	function snapCall(
		tool: "todo_write" | "propose_plan",
		items: Array<{ content?: string; summary?: string }>,
	): EvalTranscript["toolCalls"][number] {
		return {
			name: tool,
			callId: `c${todoCallSeq++}`,
			input: tool === "todo_write" ? { todos: items } : { steps: items, summary: "s" },
		};
	}

	it("字段存在但零拆解调用 ⇒ fail（「没拆」与「拆了但差」分别归因）", () => {
		const r = evaluateCase({ ...base, expectTodoSnapshot: { minItems: 2 } }, transcriptOf({}));
		assert.equal(r.passed, false);
		assert.match(r.failures[0] ?? "", /未触发拆解工具/);
	});

	it("条目数低于 minItems ⇒ fail 且报实际条目", () => {
		const r = evaluateCase(
			{ ...base, expectTodoSnapshot: { minItems: 2 } },
			transcriptOf({ toolCalls: [todoCall([{ content: "只有一件事" }])] }),
		);
		assert.equal(r.passed, false);
		assert.match(r.failures[0] ?? "", /低于下限 2/);
		assert.match(r.failures.join("\n"), /只有一件事/);
	});

	it("条目数超过 maxItems ⇒ fail（过碎/巨石未合并）", () => {
		const r = evaluateCase(
			{ ...base, expectTodoSnapshot: { maxItems: 2 } },
			transcriptOf({
				toolCalls: [todoCall([{ content: "a" }, { content: "b" }, { content: "c" }])],
			}),
		);
		assert.equal(r.passed, false);
		assert.match(r.failures[0] ?? "", /超过上限 2/);
	});

	it("requireDistinctContent：精确重复条目 ⇒ fail 且报重复串", () => {
		const r = evaluateCase(
			{ ...base, expectTodoSnapshot: { requireDistinctContent: true } },
			transcriptOf({
				toolCalls: [todoCall([{ content: "生成封面" }, { content: "生成封面" }])],
			}),
		);
		assert.equal(r.passed, false);
		assert.match(r.failures.join("\n"), /生成封面/);
	});

	it("firstStepPredicate=collect：首步非检索类 ⇒ fail 且报首项原文", () => {
		const r = evaluateCase(
			{ ...base, expectTodoSnapshot: { firstStepPredicate: "collect" } },
			transcriptOf({
				toolCalls: [todoCall([{ content: "直接写报告" }, { content: "输出结论" }])],
			}),
		);
		assert.equal(r.passed, false);
		assert.match(r.failures.join("\n"), /首步不是检索/);
		// 对照：检索类首步 ⇒ 该断言不触发
		const ok = evaluateCase(
			{ ...base, expectTodoSnapshot: { firstStepPredicate: "collect" } },
			transcriptOf({
				toolCalls: [todoCall([{ content: "搜索最新一周热点数据" }, { content: "输出结论" }])],
			}),
		);
		assert.equal(ok.passed, true);
	});

	it("⭐ 多次 todo_write 取最后一次（终态语义，与 pickLatestSnapshot 播种精神一致）", () => {
		const r = evaluateCase(
			{ ...base, expectTodoSnapshot: { minItems: 2 } },
			transcriptOf({
				toolCalls: [
					todoCall([{ content: "首稿单项" }]),
					todoCall([{ content: "修订一项" }, { content: "修订二项" }]),
				],
			}),
		);
		assert.equal(r.passed, true);
	});

	it("⭐ propose_plan 的 steps schema 同构解析（content 缺失时兜底 summary）", () => {
		const r = evaluateCase(
			{ ...base, expectTodoSnapshot: { minItems: 2, maxItems: 3 } },
			transcriptOf({
				toolCalls: [
					snapCall("propose_plan", [{ summary: "第一步" }, { content: "第二步" }]),
				],
			}),
		);
		assert.equal(r.passed, true);
		// 无 todos 也无 steps（畸形 input）⇒ items 为空 ⇒ 低于下限
		const bad = evaluateCase(
			{ ...base, expectTodoSnapshot: { minItems: 1 } },
			transcriptOf({ toolCalls: [{ name: "todo_write", callId: "c9", input: {} }] }),
		);
		assert.equal(bad.passed, false);
		assert.match(bad.failures[0] ?? "", /低于下限 1/);
	});

	it("合规快照 + 工具判据同回合 ⇒ 双判据全过", () => {
		const r = evaluateCase(
			{
				...base,
				expectTools: ["todo_write"],
				expectTodoSnapshot: { minItems: 2, maxItems: 4, requireDistinctContent: true },
			},
			transcriptOf({
				toolNames: ["todo_write"],
				toolCalls: [todoCall([{ content: "分析" }, { content: "创作" }])],
			}),
		);
		assert.equal(r.passed, true);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// C-1b · steps 多轮结构与新增判据的 L0 契约
// （实施 spec §7 七类校验 + 语义单测；全部零 token）
// ═══════════════════════════════════════════════════════════════════════════

/** 步判据字段存在性（`[]` 空数组也是有效判据，同顶层校验的教训）。 */
function hasStepCriterion(s: GoldenStep): boolean {
	return (
		(s.expectTools ?? undefined) !== undefined ||
		(s.expectAnyTools ?? undefined) !== undefined ||
		(s.forbidTools ?? undefined) !== undefined ||
		(s.expectTextIncludes ?? undefined) !== undefined ||
		(s.forbidText ?? undefined) !== undefined ||
		(s.expectTodoSnapshot ?? undefined) !== undefined ||
		(s.expectTodoStatus ?? undefined) !== undefined ||
		(s.expectIdentitySurvival ?? undefined) !== undefined ||
		(s.expectCanvasState ?? undefined) !== undefined
	);
}

describe("L0 · steps 多轮结构契约（C-1b 实施规格 §7）", () => {
	const STEPS_CASES = GOLDEN_CASES.filter((c) => c.steps);

	it("Q3/Q4 场景集存在且规模达标（全集 ≥30 条验收口径的组成面）", () => {
		assert.ok(STEPS_CASES.length >= 8, `steps case 至少 8 条（Q3 下限），实际 ${STEPS_CASES.length}`);
		const q4 = GOLDEN_CASES.filter((c) => c.id.startsWith("c1b-q4"));
		assert.ok(q4.length >= 4, `Q4 观测 case 至少 4 条，实际 ${q4.length}`);
		const canvasDomain = GOLDEN_CASES.filter(
			(c) => c.id.startsWith("c1a-") || c.id.startsWith("c1b-"),
		);
		assert.ok(canvasDomain.length >= 25, `canvas 拆解域全集 ≥25（C-1a 9 + C-1b 新增），实际 ${canvasDomain.length}`);
		assert.ok(GOLDEN_CASES.length >= 30, `GOLDEN_CASES 全集 ≥30（C-1 §6 验收），实际 ${GOLDEN_CASES.length}`);
	});

	it("⭐ steps 与顶层判据互斥（两套判据打架 = 判据不可判定）", () => {
		const problems: string[] = [];
		for (const c of STEPS_CASES) {
			const clash: string[] = [];
			if (c.text !== undefined) clash.push("text");
			if (c.expectTools !== undefined) clash.push("expectTools");
			if (c.expectAnyTools !== undefined) clash.push("expectAnyTools");
			if (c.forbidTools !== undefined) clash.push("forbidTools");
			if (c.expectTextIncludes !== undefined) clash.push("expectTextIncludes");
			if (c.forbidText !== undefined) clash.push("forbidText");
			if (c.expectTodoSnapshot !== undefined) clash.push("expectTodoSnapshot");
			if (c.expectTodoStatus !== undefined) clash.push("expectTodoStatus");
			if (c.expectCanvasState !== undefined) clash.push("expectCanvasState");
			if (clash.length > 0) problems.push(`${c.id}: 顶层与 steps 共存 [${clash.join(", ")}]`);
		}
		assert.deepEqual(problems, [], `steps 互斥违例：\n  ${problems.join("\n  ")}`);
	});

	it("每步至少一个可判定判据（否则该步在白跑）", () => {
		const problems: string[] = [];
		for (const c of STEPS_CASES) {
			for (const [i, s] of (c.steps ?? []).entries()) {
				if (!hasStepCriterion(s)) problems.push(`${c.id} step[${i}]: 零判据`);
			}
		}
		assert.deepEqual(problems, [], `零判据步：\n  ${problems.join("\n  ")}`);
	});

	it("⭐ steps case 强制 repeat=1（3 步 × 2–4 调用/步，repeat 3 成本爆炸——spec §3.1 显式例外）", () => {
		const problems: string[] = [];
		for (const c of STEPS_CASES) {
			if ((c.repeat ?? 1) !== 1) problems.push(`${c.id}: steps case repeat=${c.repeat}（只许 1/缺省）`);
		}
		assert.deepEqual(problems, [], `steps repeat 违例：\n  ${problems.join("\n  ")}`);
	});

	it("⭐ expectTodoStatus 枚举白名单校验；requireProgress 不得出现在 step[0]（无上一步可比）", () => {
		const LEGAL = ["pending", "in_progress", "completed"];
		const problems: string[] = [];
		for (const c of GOLDEN_CASES) {
			const check = (owner: string, st: typeof c.expectTodoStatus, atFirstStep: boolean) => {
				if (!st) return;
				for (const key of ["allOf", "requireAnyOf"] as const) {
					for (const v of st[key] ?? []) {
						if (!LEGAL.includes(v)) problems.push(`${owner}: ${key} 含非法枚举 ${v}`);
					}
				}
				if (st.requireProgress && atFirstStep) {
					problems.push(`${owner}: requireProgress 出现在 step[0]（无上一步可比）`);
				}
				if (st.requireProgress && c.steps === undefined) {
					problems.push(`${owner}: 单轮 case 声明 requireProgress（无「上一步」语义）`);
				}
			};
			check(c.id, c.expectTodoStatus, false);
			for (const [i, s] of (c.steps ?? []).entries()) {
				check(`${c.id} step[${i}]`, s.expectTodoStatus, i === 0);
			}
		}
		assert.deepEqual(problems, [], `expectTodoStatus 违例：\n  ${problems.join("\n  ")}`);
	});

	it("⭐ expectIdentitySurvival.itemIndex 越界 = 非法（编写期上界 = 该步 maxItems ?? 6）", () => {
		const problems: string[] = [];
		for (const c of GOLDEN_CASES) {
			for (const [i, s] of (c.steps ?? []).entries()) {
				const mark = s.expectIdentitySurvival;
				if (!mark) continue;
				const bound = s.expectTodoSnapshot?.maxItems ?? 6;
				if (mark.itemIndex < 0 || mark.itemIndex >= bound) {
					problems.push(`${c.id} step[${i}]: itemIndex=${mark.itemIndex} 越界（上界 ${bound}）`);
				}
			}
			// 单轮 case 声明 identity = 无意义（无后续步可存活）
			if (!c.steps && (c as { expectIdentitySurvival?: unknown }).expectIdentitySurvival) {
				problems.push(`${c.id}: 单轮 case 声明 expectIdentitySurvival（无跨步追踪面）`);
			}
		}
		assert.deepEqual(problems, [], `identity 标注违例：\n  ${problems.join("\n  ")}`);
	});

	it("⭐ expectCanvasState：min≤max、type 枚举封死、steps 内只许收尾步、requiresCleanCanvas 必须配对", () => {
		const problems: string[] = [];
		const checkRange = (owner: string, r: { min?: number; max?: number } | undefined) => {
			if (r && r.min !== undefined && r.max !== undefined && r.min > r.max) {
				problems.push(`${owner}: min(${r.min}) > max(${r.max})`);
			}
		};
		for (const c of GOLDEN_CASES) {
			const checkCanvas = (owner: string, cs: typeof c.expectCanvasState) => {
				if (!cs) return;
				checkRange(`${owner} nodeCount`, cs.nodeCount);
				for (const [type, r] of Object.entries(cs.nodeTypeCounts ?? {})) {
					if (!["image", "text", "video"].includes(type)) {
						problems.push(`${owner}: nodeTypeCounts 非法 type ${type}`);
					}
					checkRange(`${owner} ${type}`, r);
				}
			};
			checkCanvas(c.id, c.expectCanvasState);
			for (const [i, s] of (c.steps ?? []).entries()) {
				const isLast = i === (c.steps?.length ?? 0) - 1;
				if (s.expectCanvasState && !isLast) {
					problems.push(`${c.id} step[${i}]: expectCanvasState 出现在中间步（画布是终态语义）`);
				}
				checkCanvas(`${c.id} step[${i}]`, s.expectCanvasState);
			}
			// requiresCleanCanvas 必须配 expectCanvasState（否则「精确初始态」无从定义）
			if (c.requiresCleanCanvas) {
				const paired =
					c.expectCanvasState !== undefined ||
					(c.steps?.some((s) => s.expectCanvasState !== undefined) ?? false);
				if (!paired) problems.push(`${c.id}: requiresCleanCanvas 无 expectCanvasState 配对`);
			}
		}
		assert.deepEqual(problems, [], `expectCanvasState 违例：\n  ${problems.join("\n  ")}`);
	});

	it("⭐ generationSucceeded（成功级）本期不实施——出现即 L0 红（防判据超发）", () => {
		// 类型层无法拦截不存在字段；文本扫描 case 源文件兜底（实施 spec §7.4）
		const selfDir = dirname(fileURLToPath(import.meta.url));
		for (const file of [
			"golden-cases.ts",
			"canvas-decomposition-cases.ts",
			"canvas-multiturn-cases.ts",
		]) {
			const src = readFileSync(join(selfDir, file), "utf8");
			// 排除注释行：允许在注释里登记「不实施」，不允许在判据字面量里出现
			const codeLines = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
			const hit = codeLines.filter((l) => l.includes("generationSucceeded"));
			assert.deepEqual(hit, [], `${file} 判据代码里出现 generationSucceeded（成功级未实施）：\n${hit.join("\n")}`);
		}
	});
});

describe("L0 · expectAnyTools 判定语义（C-1b Q4 观测期）", () => {
	const base: GoldenCase = { id: "t-any", origin: "audit", about: "测试", text: "x" };

	it("任一命中 ⇒ 通过", () => {
		const r = evaluateCase(
			{ ...base, expectAnyTools: ["spawn_subagent", "get_canvas_summary"] },
			transcriptOf({ toolNames: ["get_canvas_summary"] }),
		);
		assert.equal(r.passed, true);
	});

	it("⭐ 全部未命中 ⇒ fail 且列出全部候选与实际调用（防「没派发」被静默放过）", () => {
		const r = evaluateCase(
			{ ...base, expectAnyTools: ["spawn_subagent", "get_canvas_summary"] },
			transcriptOf({ toolNames: ["todo_write"] }),
		);
		assert.equal(r.passed, false);
		assert.match(r.failures[0] ?? "", /spawn_subagent/);
		assert.match(r.failures[0] ?? "", /todo_write/);
	});

	it("expectTools（全部命中）与 expectAnyTools（任一命中）语义互不串扰", () => {
		const all = evaluateCase(
			{ ...base, expectTools: ["a", "b"] },
			transcriptOf({ toolNames: ["a"] }),
		);
		assert.equal(all.passed, false, "expectTools 缺 b 应 fail");
		const any = evaluateCase(
			{ ...base, expectAnyTools: ["a", "b"] },
			transcriptOf({ toolNames: ["a"] }),
		);
		assert.equal(any.passed, true, "expectAnyTools 命中 a 应过");
	});
});

describe("L0 · expectTodoStatus 判定语义（C-1b）", () => {
	const base: GoldenCase = { id: "t-status", origin: "audit", about: "测试", text: "x" };
	let seq = 300;
	function todoCall(items: Array<{ content: string; status?: string }>): EvalTranscript["toolCalls"][number] {
		return { name: "todo_write", callId: `c${seq++}`, input: { todos: items } };
	}

	it("requireAnyOf：无任何 item 落在列表 ⇒ fail", () => {
		const r = evaluateCase(
			{ ...base, expectTodoStatus: { requireAnyOf: ["completed"] } },
			transcriptOf({
				toolCalls: [todoCall([{ content: "a", status: "pending" }, { content: "b", status: "in_progress" }])],
			}),
		);
		assert.equal(r.passed, false);
		assert.match(r.failures.join("\n"), /存在性违例/);
	});

	it("requireAnyOf：存在 completed ⇒ 通过", () => {
		const r = evaluateCase(
			{ ...base, expectTodoStatus: { requireAnyOf: ["completed"] } },
			transcriptOf({
				toolCalls: [todoCall([{ content: "a", status: "completed" }])],
			}),
		);
		assert.equal(r.passed, true);
	});

	it("⭐ allOf 白名单：出现枚举外 status ⇒ fail（schema 漂移信号）", () => {
		const r = evaluateCase(
			{ ...base, expectTodoStatus: { allOf: ["pending", "in_progress"] } },
			transcriptOf({
				toolCalls: [todoCall([{ content: "a", status: "completed" }])],
			}),
		);
		assert.equal(r.passed, false);
		assert.match(r.failures.join("\n"), /白名单违例/);
		// 完全未知的 status 值单独报「schema 漂移」
		const drift = evaluateCase(
			{ ...base, expectTodoStatus: {} },
			transcriptOf({
				toolCalls: [todoCall([{ content: "a", status: "done_x" }])],
			}),
		);
		assert.equal(drift.passed, false);
		assert.match(drift.failures.join("\n"), /未知 status/);
	});

	it("⭐ 声明 expectTodoStatus 但零拆解 ⇒ fail（防静默通过）", () => {
		const r = evaluateCase({ ...base, expectTodoStatus: { requireAnyOf: ["completed"] } }, transcriptOf({}));
		assert.equal(r.passed, false);
		assert.match(r.failures[0] ?? "", /未触发拆解工具/);
	});
});

describe("L0 · requireProgress 判定语义（C-1b steps 专属）", () => {
	let seq = 400;
	function stepTranscript(items: Array<{ content: string; status?: string }>): EvalTranscript {
		return {
			...({ assistantText: "", toolNames: ["todo_write"], toolCalls: [], completed: true, errors: [] } as EvalTranscript),
			toolCalls: [{ name: "todo_write", callId: `c${seq++}`, input: { todos: items } }],
		};
	}
	const step: GoldenStep = { text: "继续", expectTodoStatus: { requireProgress: true } };

	it("content 逐字匹配 + status 前进 ⇒ 通过（生产实证形态）", () => {
		const prev = stepTranscript([
			{ content: "写大纲", status: "in_progress" },
			{ content: "生成配音", status: "pending" },
		]);
		const cur = stepTranscript([
			{ content: "写大纲", status: "completed" },
			{ content: "生成配音", status: "in_progress" },
		]);
		const r = evaluateStep(step, cur, pickSnapOf(prev));
		assert.deepEqual(r.failures, []);
	});

	it("⭐ content 匹配但 status 不变 ⇒ fail（空转回合）", () => {
		const prev = stepTranscript([{ content: "写大纲", status: "in_progress" }]);
		const cur = stepTranscript([{ content: "写大纲", status: "in_progress" }]);
		const r = evaluateStep(step, cur, pickSnapOf(prev));
		assert.equal(r.failures.length, 1);
		assert.match(r.failures[0] ?? "", /没有任何 item status 前进/);
	});

	it("⭐ content 全变（identity 断裂或换任务）⇒ fail 且报匹配率", () => {
		const prev = stepTranscript([{ content: "写大纲", status: "in_progress" }]);
		const cur = stepTranscript([{ content: "全新任务清单", status: "pending" }]);
		const r = evaluateStep(step, cur, pickSnapOf(prev));
		assert.equal(r.failures.length, 1);
		assert.match(r.failures[0] ?? "", /匹配 0\/1/);
	});

	it("上一步无快照 ⇒ fail（换任务场景编写期就该不声明）", () => {
		const cur = stepTranscript([{ content: "a", status: "completed" }]);
		const r = evaluateStep(step, cur, null);
		assert.equal(r.failures.length, 1);
		assert.match(r.failures[0] ?? "", /上一步无清单快照/);
	});

	it("本步未拆解 ⇒ fail（status 归因 + progress 归因两条都报）", () => {
		const prev = stepTranscript([{ content: "写大纲", status: "pending" }]);
		const cur: EvalTranscript = {
			assistantText: "",
			toolNames: ["get_canvas_summary"],
			toolCalls: [],
			completed: true,
			errors: [],
		};
		const r = evaluateStep(step, cur, pickSnapOf(prev));
		// judgeCore（expectTodoStatus 需快照）与 requireProgress 各报一条——归因互补
		assert.ok(r.failures.length >= 1, `应报出失败，实际 ${r.failures.length}`);
		assert.match(r.failures.join("\n"), /本步未触发拆解工具/);
	});

	/** 从 transcript 提取快照（与 evaluateMultiStep 的链路一致）。 */
	function pickSnapOf(t: EvalTranscript) {
		return pickLatestPlanSnapshot(t.toolCalls);
	}
});

describe("L0 · identity 断裂观测语义（C-1b §8.6，只观测不计分）", () => {
	let seq = 500;
	function tOf(items: Array<{ content: string; status?: string }>, errors: string[] = []): EvalTranscript {
		return {
			assistantText: "",
			toolNames: errors.length === 0 ? ["todo_write"] : [],
			toolCalls: errors.length === 0 ? [{ name: "todo_write", callId: `c${seq++}`, input: { todos: items } }] : [],
			completed: errors.length === 0,
			errors,
		};
	}
	const steps: GoldenStep[] = [
		{ text: "拆解", expectTodoSnapshot: { minItems: 2 }, expectIdentitySurvival: { itemIndex: 0 } },
		{ text: "重发", expectTodoSnapshot: { minItems: 2 } },
	];

	it("content 跨步逐字存活 ⇒ broken=0/observed=1", () => {
		const r = evaluateMultiStep(steps, [
			tOf([{ content: "写大纲", status: "in_progress" }, { content: "生成配音", status: "pending" }]),
			tOf([{ content: "写大纲", status: "in_progress" }, { content: "生成配音", status: "in_progress" }]),
		]);
		assert.deepEqual(r.identity, { broken: 0, observed: 1 });
		assert.equal(r.passed, true);
	});

	it("⭐ 措辞变（content 不逐字存活）⇒ broken 计 1（保守口径）但不进 failures（只观测不计分）", () => {
		const r = evaluateMultiStep(steps, [
			tOf([{ content: "写大纲", status: "in_progress" }, { content: "生成配音", status: "pending" }]),
			tOf([{ content: "撰写详细大纲", status: "in_progress" }, { content: "生成配音", status: "pending" }]),
		]);
		assert.deepEqual(r.identity, { broken: 1, observed: 1 });
		// 断裂不产生 failure（判据只锁快照结构，结构合规 ⇒ passed）
		assert.equal(r.passed, true);
	});

	it("标注步无快照（没拆）⇒ broken 计 1（保守口径：无从存活即断裂）", () => {
		const noSnapSteps: GoldenStep[] = [
			{ text: "闲聊", expectTools: [] , expectIdentitySurvival: { itemIndex: 0 } },
			{ text: "继续", expectTools: [] },
		];
		const r = evaluateMultiStep(noSnapSteps, [tOf([]), tOf([])]);
		assert.deepEqual(r.identity, { broken: 1, observed: 1 });
	});
});

describe("L0 · judgeCanvasState 判定语义（C-1b §3.2）", () => {
	it("nodeCount 超上界 ⇒ fail（污染累积/越权写入）", () => {
		const r = judgeCanvasState(
			{ nodeCount: 12, typeCounts: { image: 5, text: 7 } },
			{ nodeCount: { max: 8 } },
		);
		assert.equal(r.length, 1);
		assert.match(r[0] ?? "", /超过上限 8/);
	});

	it("nodeTypeCounts：类型计数断言（生产实证枚举 image/text/video）", () => {
		const ok = judgeCanvasState(
			{ nodeCount: 5, typeCounts: { image: 2, text: 3 } },
			{ nodeTypeCounts: { image: { max: 3 }, text: { min: 2 } } },
		);
		assert.deepEqual(ok, []);
		const bad = judgeCanvasState(
			{ nodeCount: 5, typeCounts: { image: 5, text: 0 } },
			{ nodeTypeCounts: { image: { max: 3 }, text: { min: 2 } } },
		);
		assert.equal(bad.length, 2);
	});

	it("零判据 expect（{}）⇒ 恒过（空 expect 是资产校验要拦的，不是判定层的）", () => {
		const r = judgeCanvasState({ nodeCount: 99, typeCounts: {} }, {});
		assert.deepEqual(r, []);
	});
});

describe("L0 · verdictOfSteps 多轮整链判定（C-1b §3.1）", () => {
	let seq = 600;
	function tOf(items: Array<{ content: string; status?: string }>, errors: string[] = []): EvalTranscript {
		return {
			assistantText: "",
			toolNames: errors.length === 0 ? ["todo_write"] : [],
			toolCalls: errors.length === 0 ? [{ name: "todo_write", callId: `c${seq++}`, input: { todos: items } }] : [],
			completed: errors.length === 0,
			errors,
		};
	}
	const steps: GoldenStep[] = [
		{ text: "拆解", expectTodoSnapshot: { minItems: 2 } },
		{ text: "继续", expectTodoStatus: { requireProgress: true } },
	];

	it("三步全过 ⇒ pass + per-step verdicts 全 pass + identity 汇总", () => {
		const r = verdictOfSteps(steps, [
			tOf([{ content: "写大纲", status: "in_progress" }, { content: "配音", status: "pending" }]),
			tOf([{ content: "写大纲", status: "completed" }, { content: "配音", status: "in_progress" }]),
		]);
		assert.equal(r.verdict, "pass");
		assert.deepEqual(r.stepVerdicts, ["pass", "pass"]);
	});

	it("⭐ 任一步 fail ⇒ case fail 且 failures 带 step[N] 前缀（定位到步）", () => {
		const r = verdictOfSteps(steps, [
			tOf([{ content: "写大纲", status: "pending" }]), // minItems 2 违例
			tOf([{ content: "写大纲", status: "in_progress" }]),
		]);
		assert.equal(r.verdict, "fail");
		assert.ok(r.failures.some((f) => f.startsWith("step[0]")));
		assert.deepEqual(r.stepVerdicts, ["fail", "pass"]);
	});

	it("⭐ error 优先红线：step2 运行错误 ⇒ 整条 error（第 3 步的连带不是行为问题）", () => {
		const threeSteps: GoldenStep[] = [
			...steps,
			{ text: "收尾", expectTodoStatus: { requireAnyOf: ["completed"] } },
		];
		const r = verdictOfSteps(threeSteps, [
			tOf([{ content: "a", status: "pending" }, { content: "b", status: "pending" }]),
			tOf([], ["429: rate limited"]),
			tOf([]), // 若误读成 fail，「step[2] 没拆」会诱导改提示词——必须 error
		]);
		assert.equal(r.verdict, "error");
		assert.match(r.failures.join("\n"), /step\[1\].*429/);
		assert.deepEqual(r.identity, { broken: 0, observed: 0 }, "error 时 identity 不计");
	});

	it("画布终态只在收尾步消费（中间步声明属编写期错误，L0 已拦；此处锁 runner 传参路径）", () => {
		const stepsWithCanvas: GoldenStep[] = [
			{ text: "拆解", expectTodoSnapshot: { minItems: 1 } },
			{ text: "收尾", expectTodoSnapshot: { minItems: 1 }, expectCanvasState: { nodeCount: { max: 100 } } },
		];
		// 传 canvas ⇒ 收尾步消费，全过
		const ok = verdictOfSteps(stepsWithCanvas, [tOf([{ content: "a" }]), tOf([{ content: "b" }])], {
			nodeCount: 3,
			typeCounts: {},
		});
		assert.equal(ok.verdict, "pass");
		// 不传 canvas ⇒ 收尾步报「未提供画布快照」（接线问题显式暴露，不静默放过）
		const missing = verdictOfSteps(stepsWithCanvas, [tOf([{ content: "a" }]), tOf([{ content: "b" }])]);
		assert.equal(missing.verdict, "fail");
		assert.match(missing.failures.join("\n"), /未提供画布快照/);
	});
});
