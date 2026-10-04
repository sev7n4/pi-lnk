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
import { loadStaticPromptForEval, PLAN_CONVENTION_TAIL, type StaticPromptResult } from "./registry.js";
import type { EvalTranscript } from "./transcript.js";

/**
 * 单条 case 的判定。
 *
 * ⭐ `error` / `fail` / `skipped` **三态分离**，每一态都对应完全不同的处置：
 *
 * | 态 | 含义 | 处置 |
 * |---|---|---|
 * | `pass` | 行为符合预期 | 无 |
 * | `fail` | 行为不符（真问题） | 改提示词 / 修工具 |
 * | `error` | 环境问题（上游/凭据/网络） | 重跑或修环境，**别改提示词** |
 * | `skipped` | **本 runner 跑不了这条**（需外部动作） | 补环境后单跑，**不计入通过率** |
 *
 * `skipped` 与 `error` 必须分开：前者是「主动不跑」（harness 能力边界），
 * 后者是「跑了但挂了」（环境故障）。混为一谈会让「4 条跑不了」看起来像
 * 「4 条环境坏了」—— 而正确处置完全不同。
 */
export type Verdict = "pass" | "fail" | "error" | "skipped";

export interface CaseResult {
	caseId: string;
	verdict: Verdict;
	/** 失败明细（verdict=fail 时是行为问题；=error 时是运行错误；=skipped 时是跳过原因）。 */
	failures: string[];
	/** verdict=skipped 时的原因（人话，能直接贴进报告）。 */
	skipReason?: string;
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
	/** ⭐ 本runner 跑不了的case 数（需外部动作，如「用户点确认」）。 */
	skipped: number;
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
	/**
	 * ⭐ 本轮用的静态段来源信息（方案 A）。
	 *
	 * **必须记进 baseline**：只存通过率而不存「测的是哪版权限」，
	 * 三天后没人说得清这份数据对应的是哪个规则集。
	 */
	staticPrompt?: StaticPromptResult;
	/**
	 * ⭐ 方案 A 的**已知盲区**，写进报告而不只是注释 ——
	 * 否则会有人拿「方案 A 跑通了」论证「装配层没问题」。
	 */
	coverageNote?: string;
	/** 本轮用的真实画布 id（方案 B）。 */
	canvasSessionId?: string;
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
export function summarize(
	results: CaseResult[],
	meta?: { staticPrompt?: StaticPromptResult; coverageNote?: string; canvasSessionId?: string },
): RunSummary {
	const pass = results.filter((r) => r.verdict === "pass").length;
	const fail = results.filter((r) => r.verdict === "fail").length;
	const error = results.filter((r) => r.verdict === "error").length;
	// ⭐ skipped 不进passRate 分母，也不算 error —— 它是「没跑」，不是「跑坏了」。
	const skipped = results.filter((r) => r.verdict === "skipped").length;
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
	// ⭐ skipped 单列一节：让「这轮没覆盖什么」显式可见，而不是悄悄从分母里消失。
	const skipSection =
		skipped > 0
			? [
					`skip ${skipped} 条（本 harness 跑不了，需外部动作；未计入通过率）：`,
					...results
						.filter((r) => r.verdict === "skipped")
						.map((r) => `  - ${r.caseId}：${r.skipReason ?? r.failures.join("; ")}`),
				]
			: [];
	const lines = [
		header,
		`L1 行为回归：${pass}/${judged} 通过（${(passRate * 100).toFixed(1)}%）· fail ${fail} · error ${error} · skip ${skipped}`,
		`token：total ${totalTokens}（output ${totalOutputTokens}）`,
		...(meta?.staticPrompt
			? [
					`规则集：registry ${meta.staticPrompt.registryVersion} hash=${meta.staticPrompt.registryHash} ` +
						`chars=${meta.staticPrompt.chars}` +
						(meta.staticPrompt.degraded ? " ⚠️**degraded（读不到磁盘，用了内嵌回退常量）**" : "") +
						` | 生效规则：${meta.staticPrompt.appliedIds.join(", ")}`,
				]
			: []),
			...(meta?.canvasSessionId
			? [`画布：canvasSessionId=${meta.canvasSessionId}（真实 Nest 画布，工具可回查）`]
			: []),
		...(meta?.coverageNote ? [`⚠️ 覆盖盲区：${meta.coverageNote}`] : []),
		...skipSection,
		...results
			.filter((r) => r.verdict === "fail" || r.verdict === "error")
			.map((r) => `  [${r.verdict}] ${r.caseId} (${r.durationMs}ms)：${r.failures.join("; ")}`),
	]
		.filter(Boolean)
		.map((l) => String(l));

	return {
		total: results.length,
		pass,
		fail,
		error,
		skipped,
		passRate,
		degraded,
		totalTokens,
		totalOutputTokens,
		report: lines.join("\n"),
		results,
		failures,
		...(meta?.staticPrompt ? { staticPrompt: meta.staticPrompt } : {}),
		...(meta?.coverageNote ? { coverageNote: meta.coverageNote } : {}),
		...(meta?.canvasSessionId ? { canvasSessionId: meta.canvasSessionId } : {}),
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
	/**
	 * ⭐ 静态段（systemPrompt）。**不给就用真实规则集现装配**（方案 A）。
	 *
	 * 为什么不给默认值是错的：首跑时driver 传的是一句极简提示词，
	 * 模型在无规则环境里对每条 case 都反复探索工具、跑满超时
	 * ⇒ **测到的是「另一个 prompt 的行为」**，不是生产行为。
	 */
	staticPrompt?: string;
	/** 跳过 requiresConfirm 的 case（缺省 true）。置 false 可用来验证「跳过是否合理」。 */
	skipBlocking?: boolean;
	/** 规则集装配信息，仅用于报告（由 runL1 内部填）。 */
	registryInfo?: StaticPromptResult;
	/**
	 * ⭐ 真实 Nest userId（画布工具做归属校验）。
	 * **不传 = 每条 case 都会 4xx 超时**（见 `EvalCaseInput.userId` 的说明）。
	 */
	userId?: string;
	/**
	 * ⭐ 真实画布会话 id。
	 *
	 * ⚠️⚠️ **不传就不该跑**：`canvasSessionId` 缺省会回落到 pi 会话键
	 * （`eval-xxx`），而那是**不存在的 id** ⇒ 查画布必然 4xx ⇒ 模型反复重试、
	 * 评测只能拿到超时。首跑 7 条全超时就是这个原因。
	 *
	 * ⇒ 未传时 `runL1` **直接抛错**而不是跑一遍拿超时 ——
	 * 「拿不到数据」和「数据说明行为不符」必须区分，否则会误判成行为问题。
	 */
	canvasSessionId?: string;
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
	// ⭐⭐ 没有真实画布就**直接抛**，不跑一遍拿超时。
	// 为什么：缺 `canvasSessionId` 时 driver 会回落到 pi 会话键（`eval-xxx`），
	// 那是**不存在的 id** ⇒ 模型每次查画布都 4xx ⇒ 反复重试直到超时。
	// 实测 7 条全 120s 超时、`get_canvas_summary` 22 次 4xx。
	// ⇒ 「拿不到数据」必须与「数据说明行为不符」严格区分，否则会误判成
	// 「模型行为退化」—— 而正确处置是传对参数重跑。
	const needsCanvas = cases.some((c) => !c.requiresConfirm);
	if (needsCanvas && (!options.canvasSessionId || !options.userId)) {
		throw new Error(
			`L1 需要真实画布上下文才能跑（非 requiresConfirm 的 case 会调画布工具）：\n` +
				`  canvasSessionId = ${options.canvasSessionId ?? "（未传）"}\n` +
				`  userId          = ${options.userId ?? "（未传）"}\n` +
				`不传会怎样：driver 回落到 pi 会话键（不存在的 id）⇒ 画布工具全 4xx ` +
				`⇒ 模型反复重试 ⇒ 每条 case 跑满超时。\n` +
				`怎么拿：见 docs 里 L1 评测说明（用测试账号登录 Nest 换一个已有画布 / 新建画布）。`,
		);
	}
	const intervalMs = options.intervalMs ?? 500;
	const results: CaseResult[] = [];

	// ⭐ 方案 A：用**真实规则集**装配静态段。给显式 staticPrompt 才用之，
	// 否则现装（读prompt-registry + renderStatic，见 registry.ts）。
	// 装配失败**直接抛**不降级：拿不到规则集就跑出来的行为数据
	// 对应的是「不知道是哪个 prompt」⇒ 不该产出 baseline。
	// 只装一次，两个用途（给 driver 的 prompt + 报告里的元信息）。
	// ⚠️ 显式给了 staticPrompt 就**不装** registry：装配要读磁盘 + import 生产 loader，
	// 那是「跑真实回归」才需要的；测试传prompt 是为了**隔离**这两件事。
	const registryInfo = options.staticPrompt
		? undefined
		: await loadStaticPromptForEval({ extraTail: PLAN_CONVENTION_TAIL });
	const staticPrompt = options.staticPrompt ?? registryInfo!.prompt;
	// ⚠️ 覆盖盲区：方案 A 绕过了 Nest 的 PiPromptAssembler。
	// 这句会进baseline 报告 —— 不写的话会有人拿「A 跑通了」论证装配层没问题。
	const coverageNote =
		"方案 A 直调 loadRegistry+renderStatic，**未覆盖 Nest 装配层**" +
		"（动态段拼装 / STATIC_BUDGET 截断 / 静态段-动态段分工）。补齐需方案 B（runner 经 Nest 跑）。";

	for (const [i, testCase] of cases.entries()) {
		const started = Date.now();
		let result: CaseResult;
		// ⭐ requiresConfirm 的 case 直接跳过，**不发起任何模型调用**。
		// 为什么不能「跑一下看看」：propose_generation 一旦被调用就挂在
		// waitForUser 上直到 ASK_USER_TIMEOUT_MS（生产 5 分钟），
		// 而 harness 无法完成「用户点确认」⇒ 每跳一条就白等 5 分钟 + 烧一轮token，
		// 最后还会因收不到 agent_end 而被误判成 error（环境问题）。
		// ⇒ 主动跳过 + 显式记录，代价是零、且报告里可见。
		if (testCase.requiresConfirm) {
			result = {
				caseId: testCase.id,
				verdict: "skipped",
				failures: [],
				skipReason: "需要「用户点确认」动作（propose_generation 阻塞等 DockStudio 生成触发）",
				durationMs: 0,
				toolNames: [],
			};
			results.push(result);
			options.onProgress?.(i + 1, cases.length, result);
			continue;
		}
		try {
			const run = await runEvalCase(
				{
					baseUrl: options.baseUrl,
					...(options.caseTimeoutMs !== undefined
						? { timeoutMs: options.caseTimeoutMs }
						: {}),
				},
				{
					text: testCase.text,
					systemPrompt: staticPrompt,
					...(options.userId ? { userId: options.userId } : {}),
					...(options.canvasSessionId ? { canvasSessionId: options.canvasSessionId } : {}),
				},
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

	return summarize(results, {
		staticPrompt: registryInfo,
		coverageNote,
		...(options.canvasSessionId ? { canvasSessionId: options.canvasSessionId } : {}),
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
