import { describe, it } from "node:test";
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
