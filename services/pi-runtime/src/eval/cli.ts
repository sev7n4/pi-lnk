#!/usr/bin/env node
/**
 * L1 行为回归 CLI 入口（W1b）。
 *
 * 用法：
 * ```bash
 * # 全量 12 条
 * PI_RUNTIME_URL=http://127.0.0.1:8100 node dist/eval/cli.js
 *
 * # 只跑一条（快速迭代单条）
 * ... node dist/eval/cli.js --only gen-claim-001
 *
 * # 机器可读（供 CI 存baseline / 对比）
 * ... node dist/eval/cli.js --json > baseline.json
 *
 * # 行为不符即非零退出（CI 卡闸用）
 * ... node dist/eval/cli.js --strict
 * ```
 *
 * ## 退出码约定（CI 靠这个判断）
 *
 * | 码 | 含义 | CI 该怎么做 |
 * |---|---|---|
 * 0 | 全过，或有 fail 但未加 `--strict` | — |
 * 1 | 有 case 判为 fail（且加了 `--strict`） | **卡闸** —— 行为退化了 |
 * 2 | 环境问题（`degraded`：多数 case 是 error） | **别卡闸** —— 是凭据/上游坏了，不是行为问题 |
 *
 * ⭐ 2 与 1 必须分开：把「上游 503」当成「行为退化」会让 CI 阻塞，
 * 而正确的处置是重跑或修环境。
 */
import { runL1 } from "./runner.js";

function parseArgs(argv: string[]): {
	only?: string[];
	json: boolean;
	strict: boolean;
	timeoutMs?: number;
	intervalMs?: number;
} {
	const out: ReturnType<typeof parseArgs> = { json: false, strict: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--only" && argv[i + 1]) out.only = argv[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
		else if (arg === "--json") out.json = true;
		else if (arg === "--strict") out.strict = true;
		else if (arg === "--timeout" && argv[i + 1]) out.timeoutMs = Number(argv[++i]);
		else if (arg === "--interval" && argv[i + 1]) out.intervalMs = Number(argv[++i]);
	}
	return out;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const baseUrl = process.env.PI_RUNTIME_URL ?? "http://127.0.0.1:8100";

	// 预检：pi-runtime 不在就立刻退出，不要浪费一轮模型调用去发现它不通。
	try {
		const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/readyz`, {
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (err) {
		process.stderr.write(
			`pi-runtime 不可达（${baseUrl}）：${err instanceof Error ? err.message : String(err)}\n` +
				"请先启动 pi-runtime 或设 PI_RUNTIME_URL 指向它。\n",
		);
		process.exit(2);
		return;
	}

	//⭐ 画布上下文从环境变量读（不硬编码进仓库）：这些是**环境事实**，
	// 不是代码配置。缺了 runL1 会 fail-fast 并说清怎么补。
	const canvasSessionId = process.env.PI_EVAL_CANVAS_SESSION_ID;
	const userId = process.env.PI_EVAL_USER_ID;
	const summary = await runL1({
		baseUrl,
		...(canvasSessionId ? { canvasSessionId } : {}),
		...(userId ? { userId } : {}),
		...(args.only ? { only: args.only } : {}),
		...(args.timeoutMs !== undefined ? { caseTimeoutMs: args.timeoutMs } : {}),
		...(args.intervalMs !== undefined ? { intervalMs: args.intervalMs } : {}),
		onProgress: (done, total, r) => {
			const mark = r.verdict === "pass" ? "✓" : r.verdict === "fail" ? "✗" : "!";
			process.stderr.write(`  [${done}/${total}] ${mark} ${r.caseId} (${r.durationMs}ms)\n`);
		},
	});

	if (args.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					pass: summary.pass,
					fail: summary.fail,
					error: summary.error,
					total: summary.total,
					passRate: summary.passRate,
					degraded: summary.degraded,
					totalTokens: summary.totalTokens,
					...(summary.canvasSessionId ? { canvasSessionId: summary.canvasSessionId } : {}),
					...(summary.staticPrompt
						? {
								registryHash: summary.staticPrompt.registryHash,
								registryVersion: summary.staticPrompt.registryVersion,
								chars: summary.staticPrompt.chars,
								appliedIds: summary.staticPrompt.appliedIds,
								degraded: summary.staticPrompt.degraded,
							}
						: {}),
					results: summary.results,
				},
				null,
				2,
			)}\n`,
		);
	} else {
		process.stdout.write(`${summary.report}\n`);
	}

	// ⭐ degraded 优先于 fail 判定：环境坏了的时候，「有多少 case 行为不符」
	// 这个数字本身不可信，先报环境问题。
	if (summary.degraded) process.exit(2);
	if (args.strict && summary.fail > 0) process.exit(1);
	process.exit(0);
}

// ⭐ 不用 top-level await：CJS 产物下它非法（TS1378）。
// 同时 catch uncaught rejection —— 否则退出码是 1（像fail）而不是 2（环境问题），
// CI 会把「环境挂了」误判成「行为退化」。
main().catch((err: unknown) => {
	process.stderr.write(`L1 runner 自身异常：${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(2);
});
