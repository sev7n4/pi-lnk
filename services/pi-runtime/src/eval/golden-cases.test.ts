import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { GOLDEN_CASES, evaluateCase, type GoldenCase } from "./golden-cases.js";
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
	// C-1a 起种子集在 canvas-decomposition-cases.ts —— 两个源文件都搜。
	const selfDir = dirname(fileURLToPath(import.meta.url));
	for (const file of ["golden-cases.ts", "canvas-decomposition-cases.ts"]) {
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
			if (!c.expectTools && !c.forbidTools) {
				problems.push(`${c.id}: 有 expectTodoSnapshot 但无 expectTools/forbidTools`);
			}
			// 负例形态：快照判据缺席时，禁拆解负例必须同时禁两个拆解工具
			if (
				!s &&
				c.forbidTools?.includes("todo_write") &&
				!c.forbidTools.includes("propose_plan")
			) {
				problems.push(`${c.id}: 禁 todo_write 却不禁 propose_plan——拆解禁列不完整`);
			}
			if (
				!s &&
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
		const problems: string[] = [];
		for (const c of GOLDEN_CASES) {
			const mentioned = new Set(c.about.match(/\b([a-z][a-z0-9]+_[a-z0-9_]+)\b/g) ?? []);
			const judged = new Set([...(c.expectTools ?? []), ...(c.forbidTools ?? [])]);
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
				if (!explained && !negated) {
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
			const hasExpect = (c.expectTools ?? []).length > 0;
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
		const noAssert = GOLDEN_CASES.filter(
			(c) =>
				(c.expectTools ?? undefined) === undefined &&
				(c.forbidTools ?? undefined) === undefined &&
				(c.expectTextIncludes ?? undefined) === undefined &&
				(c.forbidText ?? undefined) === undefined &&
				(c.expectTodoSnapshot ?? undefined) === undefined,
		).map((c) => c.id);
		assert.deepEqual(noAssert, [], `无可判定判据：${noAssert.join(", ")}`);
		// 反向自检：上面那条判据本身要能识别「空数组算判据」——
		// 故意造一条只有 expectTools: [] 的 case，它不该进 noAssert。
		const emptyIsAssert: GoldenCase = { ...GOLDEN_CASES[0], id: "probe", expectTools: [] };
		const probeList = [emptyIsAssert].filter(
			(c) =>
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

	it("case 文本非空且不是占位", () => {
		for (const c of GOLDEN_CASES) {
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
