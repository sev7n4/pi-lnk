/**
 * L1 行为回归 runner（W1b · Round 2 §07.1）。
 *
 * ## L1 runner 到底做什么（一句话）
 *
 * 把 `golden-cases.ts` 里的 12 条 case 逐条**真的发给模型跑一遍**，
 * 收回来的行为与 `evaluateCase()` 的判据比对，产出一份**可 diff 的通过率 + 失败明细**。
 *
 * ## 为什么必须有它（没有它会怎样）
 *
 * 现状是「改了提示词 → CI绿 → 上线」，但**没有任何机制回答「这次改动让模型行为变好了还是变坏了」**。
 * 后果具体表现为：
 *
 * - W4（规则重写）只能靠人肉感觉决定怎么写 ⇒ 改完不知道有没有反复；
 * - 出了「假称已出图」类事故，事后无法判断是提示词退化还是模型抖动；
 * - 规则越加越多（M3 口径），**没有任何数据说明它们是否真的生效**。
 *
 * ⭐ L1 runner 的价值不是「自动判对错」，而是**给「改提示词」这件事装上回滚依据**：
 * 改前跑一次拿到 baseline，改后再跑一次做对比。没有它，改提示词就是赌博。
 *
 * ## 三条设计红线
 *
 * 1. ⭐ **`error` 与 `fail` 严格分离**。上游 503 / 超时是**环境问题**，
 *    混进通过率会让「网络抖了」看起来像「模型行为变坏」⇒ **诱导人去改不该改的提示词**。
 * 2. ⭐ **passRate 分母只含 pass+fail**。error 不进分母（理由同上）。
 *    error 占比高时报告自报 `degraded`，一眼看出「这轮环境不对，别信这个数」。
 * 3. ⭐ **一条 case 的失败信息必须能直接定位**（期望调 A、实际调了 B），
 *    让人不翻日志就知道该改什么。
 *
 * ## 为什么首批不接 `vitest-evals`
 *
 * `evalHarnessTable` 的 pass-rate lift 需要 **baseline vs candidate 两次运行**才成立。
 * 首批更重要的是「先能跑出可信的单次结果」，故本模块只产出结构化报告，
 * baseline/candidate 的对比留给下一层（判据与报告形态已为此预留：`usage` 汇总 + 可 diff 报告）。
 */
import { runEvalCase, type RuntimeDriverOptions } from "./driver.js";
import { GOLDEN_CASES, evaluateCase, type GoldenCase } from "./golden-cases.js";
import type { EvalTranscript } from "./transcript.js";

/** 单条 case 的判定。⭐ `error` 与 `fail` 分离是本模块的核心红线。 */
export type Verdict = "pass" | "fail" | "error";

export interface CaseResult {
	caseId: string;
	verdict: Verdict;
	/** 失败明细（verdict=fail 时是行为问题；=error 时是运行错误）。 */
	failures: string[];
	durationMs: number;
	/** 实际调用的工具名序列（供人工核对，也便于报告 diff）。 */
	toolNames: string[];
	usage?: EvalTranscript["usage"];
}

export interface RunSummary {
	total: number;
	pass: number;
	fail: number;
	error: number;
	/** pass / (pass + fail)。⭐ error 不进分母；空集为 0（不是 NaN）。 */
	passRate: number;
	/** ⭐ error 占比过半 ⇒ 标记「这轮环境不对」，报告需自报避免误读。 */
	degraded: boolean;
	totalTokens: number;
	totalOutputTokens: number;
	/** 人类可读报告。 */
	report: string;
	/** 结构化明细，供 baseline vs candidate 对比。 */
	results: CaseResult[];
	/** 所有失败明细（每行带 caseId，便于直接贴 issue）。 */
	failures: string[];
}

/**
 * 判一条 case 的 verdict。
 *
 * ⭐ `error` 优先于 `fail`：跑挂了就没有「行为对不对」这回事。
 * 若顺序反过来，上游 503 会让报告出现「应该调 propose_generation 却调了别的」
 * 这类**凭空捏造的失败原因** —— 而实际根因是网络。
 *
 * 返回结构化对象而非 `"pass"` / `"fail: xxx"` 字符串：字符串前缀解析容易在
 * 改文案时静默出错（`fail:` 与 `failure:` 只差一个字母），而 verdict 是
 * 要进报告并驱动 passRate 计算的关键字段，**不该靠字符串约定承载**。
 */
export function verdictOf(
	testCase: GoldenCase,
	transcript: EvalTranscript,
): { verdict: Verdict; failures: string[] } {
	if (transcript.errors.length > 0) {
		return { verdict: "error", failures: [...transcript.errors] };
	}
	const { passed, failures } = evaluateCase(testCase, transcript);
	return { verdict: passed ? "pass" : "fail", failures: passed ? [] : [...failures] };
}

/**
 * error 占比过半 ⇒ degraded。
 *
 * ⭐ 分母是 **total**（含 error），不是 `pass + fail`。这个区别是本函数
 * 存在的全部意义（实测踩到）：`judged > 0` 的写法在「**全部 error**」时
 * `judged === 0` ⇒ 返回 false ⇒ **最该报警的场景反而不报**。
 * 而「全部 error」恰恰是最典型的环境故障（凭据失效/上游全挂）。
 *
 * 另：`error === total` 时通过率已无意义（0/0），必须显式降级而不是给 0%。
 */
function isDegraded(pass: number, fail: number, error: number): boolean {
	const total = pass + fail + error;
	if (total === 0) return false;
	return error / total > 0.5;
}

/** 汇总一份报告。纯函数（可单测）。 */
export function summarize(results: CaseResult[]): RunSummary {
	const pass = results.filter((r) => r.verdict === "pass").length;
	const fail = results.filter((r) => r.verdict === "fail").length;
	const error = results.filter((r) => r.verdict === "error").length;
	const judged = pass + fail;
	// ⭐ 分母只取 judged：error 是环境问题，混进分母会把网络抖动
	// 呈现成「模型行为变坏」⇒ 诱导改提示词。
	const passRate = judged === 0 ? 0 : pass / judged;
	const totalTokens = results.reduce((sum, r) => sum + (r.usage?.total ?? 0), 0);
	const totalOutputTokens = results.reduce((sum, r) => sum + (r.usage?.output ?? 0), 0);
	const degraded = isDegraded(pass, fail, error);
	const failures = results
		.filter((r) => r.failures.length > 0)
		.map((r) => `${r.caseId}: ${r.failures.join("; ")}`);

	const header = degraded
		? `⚠️ **degraded**：${error}/${results.length} 条因运行错误未参与判定，本轮通过率不代表模型行为（先查上游/凭据）`
		: "";
	const lines = [
		header,
		`L1 行为回归：${pass}/${judged} 通过（${(passRate * 100).toFixed(1)}%）· fail ${fail} · error ${error}`,
		`token：total ${totalTokens}（output ${totalOutputTokens}）`,
		...results
			.filter((r) => r.verdict !== "pass")
			.map((r) => `  [${r.verdict}] ${r.caseId} (${r.durationMs}ms)：${r.failures.join("; ")}`),
	]
		.filter(Boolean)
		.map((l) => String(l));

	return {
		total: results.length,
		pass,
		fail,
		error,
		passRate,
		degraded,
		totalTokens,
		totalOutputTokens,
		report: lines.join("\n"),
		results,
		failures,
	};
}

export interface L1RunOptions extends RuntimeDriverOptions {
	/** 只跑这些 case id（缺省跑全部）。用于快速迭代单条。 */
	only?: string[];
	/** 单条 case 之间的间隔（ms）。⚠️ 默认给 500：连续打模型容易被限流，
	 * 而限流会伪装成「模型行为不符」。 */
	intervalMs?: number;
	/** 进度回调（每条跑完触发，便于长跑时看进度）。 */
	onProgress?: (done: number, total: number, result: CaseResult) => void;
	/** 单条 case 的超时（覆盖 driver 默认）。 */
	caseTimeoutMs?: number;
}

/**
 * 跑一轮 L1 行为回归。
 *
 * ⭐ **串行执行，不并发**。理由：并发会让限流/超时互相污染，
 * 一次「上游 503」到底是模型波动还是自己打太猛造成的，无从区分 ——
 * 而这正是 `error` 判定要保护的边界。
 */
export async function runL1(options: L1RunOptions): Promise<RunSummary> {
	const cases = options.only?.length
		? GOLDEN_CASES.filter((c) => options.only?.includes(c.id))
		: GOLDEN_CASES;
	if (cases.length === 0) {
		throw new Error(`no golden cases matched: only=${JSON.stringify(options.only ?? null)}`);
	}
	const intervalMs = options.intervalMs ?? 500;
	const results: CaseResult[] = [];

	for (const [i, testCase] of cases.entries()) {
		const started = Date.now();
		let result: CaseResult;
		try {
			const run = await runEvalCase(
				{
					baseUrl: options.baseUrl,
					...(options.caseTimeoutMs !== undefined
						? { timeoutMs: options.caseTimeoutMs }
						: {}),
				},
				{ text: testCase.text },
			);
			const v = verdictOf(testCase, run.transcript);
			result = {
				caseId: testCase.id,
				verdict: v.verdict,
				failures: v.failures,
				durationMs: Date.now() - started,
				toolNames: run.transcript.toolNames,
				usage: run.transcript.usage,
			};
		} catch (err) {
			// driver 自身抛异常（连接失败等）⇒ 归error，**不**归fail。
			// 理由同 verdictOf：环境问题不是行为问题。
			result = {
				caseId: testCase.id,
				verdict: "error",
				failures: [err instanceof Error ? err.message : String(err)],
				durationMs: Date.now() - started,
				toolNames: [],
			};
		}
		results.push(result);
		options.onProgress?.(i + 1, cases.length, result);
		if (i < cases.length - 1 && intervalMs > 0) await sleep(intervalMs);
	}

	return summarize(results);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
