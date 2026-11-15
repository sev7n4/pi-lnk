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
import { loadEvalByokOverride } from "./byok.js";
import { archiveEvalCanvas, createEvalCanvas, decideProvisioning, type NestEndpoint } from "./provision.js";

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
	// ⭐⭐ P1 canvas provisioning（立项 spec 2026-11-15 拍板方案 A）：
	// 未显式传画布 id 且 userId/nest 齐 ⇒ run 开始自动建新画布（D1），
	// 新 id 供本轮全部 case；建失败 ⇒ 整 run error（D3 fail-fast，不回落共享画布）。
	// 显式传 PI_EVAL_CANVAS_SESSION_ID ⇒ 行为与历史完全一致（单画布复现模式，验收 3）。
	let canvasSessionId = process.env.PI_EVAL_CANVAS_SESSION_ID;
	const userId = process.env.PI_EVAL_USER_ID;
	// ⭐ Nest 连接信息**仅用于画布规模预检**（见 GoldenCase.requiresCanvasNodes）。
	// 缺了不会静默—— runL1 会 fail-fast 并说清怎么补，
	// 因为「静默跳过预检」正是把环境问题伪装成模型问题的路径。
	// pi-runtime pod 内这两个变量本来就有（NEST_BASE_URL / NEST_SERVICE_TOKEN），
	// 用不同前缀是为了不与pi-runtime 自身的运行时配置混淆。
	const nestBaseUrl = process.env.PI_EVAL_NEST_BASE_URL ?? process.env.NEST_BASE_URL;
	const nestToken = process.env.PI_EVAL_NEST_TOKEN ?? process.env.NEST_SERVICE_TOKEN;
	const nest: NestEndpoint | undefined =
		nestBaseUrl && nestToken ? { baseUrl: nestBaseUrl, token: nestToken } : undefined;
	const decision = decideProvisioning({ canvasSessionId, userId, nest });
	let provisioned: { sessionId: string; title: string; archiveTitle: string } | undefined;
	if (decision.provision && nest && userId) {
		try {
			provisioned = await createEvalCanvas(nest, userId);
			canvasSessionId = provisioned.sessionId;
			process.stderr.write(
				`画布已新建：${provisioned.title} → ${provisioned.sessionId}（run 结束归档为 ${provisioned.archiveTitle}，不删除）\n`,
			);
		} catch (err) {
			// D3 fail-fast：建画布失败就整 run error，不回落共享画布
			//（回落会把环境问题伪装成行为问题，重蹈 q3-07 画布污染覆辙）。
			process.stderr.write(
				`建画布失败（P1 provisioning，D3 fail-fast）：${err instanceof Error ? err.message : String(err)}\n` +
					"处置：检查 NEST_BASE_URL/NEST_SERVICE_TOKEN/PI_EVAL_USER_ID，或显式传 PI_EVAL_CANVAS_SESSION_ID 走单画布复现模式。\n",
			);
			process.exit(2);
			return;
		}
	}
	// ⭐ BYOK（可选）：设了 EVAL_BYOK_* 即让跑批走你自己的渠道，绕开 AGNES 429。
	// 密钥只在环境变量里，本文件不持有明文。未设则回落 AGNES（既有行为不变）。
	const byok = loadEvalByokOverride();
	const summary = await runL1({
		baseUrl,
		...(byok ? { llmOverride: byok } : {}),
		...(canvasSessionId ? { canvasSessionId } : {}),
		...(userId ? { userId } : {}),
		...(nestBaseUrl && nestToken ? { nest: { baseUrl: nestBaseUrl, token: nestToken } } : {}),
		...(args.only ? { only: args.only } : {}),
		...(args.timeoutMs !== undefined ? { caseTimeoutMs: args.timeoutMs } : {}),
		...(args.intervalMs !== undefined ? { intervalMs: args.intervalMs } : {}),
		onProgress: (done, total, r) => {
			const mark = r.verdict === "pass" ? "✓" : r.verdict === "fail" ? "✗" : "!";
			process.stderr.write(`  [${done}/${total}] ${mark} ${r.caseId} (${r.durationMs}ms)\n`);
		},
	});

	// D2 归档：run 结束把本轮画布改名 eval-used-<runStamp>（不删，保留取证现场）。
	// 归档失败只记 warning，不影响退出码——运行结论已产出，归档只是命名 hygiene。
	if (provisioned && canvasSessionId && nest && userId) {
		const archived = await archiveEvalCanvas(nest, canvasSessionId, userId, provisioned.archiveTitle);
		if (!archived.ok) {
			process.stderr.write(
				`⚠️ 画布归档改名失败（不删，现场仍在 ${canvasSessionId}）：${archived.error ?? "unknown"}\n`,
			);
		}
	}

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
					...(provisioned
						? {
								canvasProvisioned: true,
								canvasTitle: provisioned.title,
								canvasArchivedAs: provisioned.archiveTitle,
							}
						: {}),
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
