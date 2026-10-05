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
	const selfDir = dirname(fileURLToPath(import.meta.url));
	const src = readFileSync(join(selfDir, "golden-cases.ts"), "utf8");
	const i = src.indexOf(`id: "${caseId}"`);
	if (i < 0) return "";
	// 到下一个 case 或 1200 字符为止
	const rest = src.slice(i + 1);
	const next = rest.search(/\n\t\{\n\t\tid: "/);
	return src.slice(i, next < 0 ? Math.min(src.length, i + 1200) : i + 1 + next);
}

describe("L0 · 评测集自身契约", () => {
	it("case id 唯一（重复会让报告里两条无法区分）", () => {
		const ids = GOLDEN_CASES.map((c) => c.id);
		const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
		assert.deepEqual(dupes, [], `重复 id：${dupes.join(", ")}`);
	});

	it("⭐ 首批case 全部来自真实失败（origin 不得为 synthetic）", () => {
		// Round 2 明确「首批 case 应直接来自线上真实失败样本，不要自造」。
		// 自造 case 会把「我们想象的失败」当成「真实的失败」，优化方向从一开始就偏。
		const synthetic = GOLDEN_CASES.filter((c) => c.origin === "synthetic").map((c) => c.id);
		assert.deepEqual(synthetic, [], `这批不该有自造 case：${synthetic.join(", ")}`);
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
				(c.forbidText ?? undefined) === undefined,
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
