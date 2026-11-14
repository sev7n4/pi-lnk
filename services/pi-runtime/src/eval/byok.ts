/**
 * eval BYOK 密钥装载（B 路线：让评测跑批走你自己的模型渠道，绕开 AGNES 429）。
 *
 * ## 安全红线（最重要）
 *
 * ⭐ **本文件不持有、不拼接、不打印任何明文 key。** 真实 `apiKey` 只来自进程环境变量
 * （`EVAL_BYOK_API_KEY`），由你在运行 eval 的机器上设置，**不进代码、不进聊天、不进 git**。
 * 代码里出现的只有变量名，从不会出现 `sk-...` 之类的值。
 *
 * 提供 key 的方式（任选其一，都不写进对话）：
 *   1. shell 导出：`export EVAL_BYOK_API_KEY=sk-xxxx`（你终端里敲，不进聊天）
 *   2. `.env` 文件：`echo "EVAL_BYOK_API_KEY=sk-xxxx" > services/pi-runtime/src/eval/.env`
 *      （`.env` 已被 gitignore；本仓库不提交任何真实值）
 *   3. K3s 场景：把同值写进 helm secret / pod env
 *
 * ## 行为
 *
 * - 未设 `EVAL_BYOK_API_KEY` ⇒ 返回 `undefined` ⇒ 会话走部署 env 的 AGNES（既有行为不变）。
 * - 设了 key 但 `BASE_URL`/`MODEL` 缺 ⇒ 告警（不回显 key）并回落 AGNES，让运行者立刻发现配置不全。
 * - 全部齐 ⇒ 返回 `EvalLlmOverride`，`source:"user"`（个人渠道覆盖）。
 */
import type { EvalLlmOverride } from "./transcript.js";

/**
 * 从环境变量装 BYOK 覆盖。
 *
 * @returns 配置完整时返回覆盖对象；未配置或配置不全时返回 `undefined`（回落 AGNES）。
 */
export function loadEvalByokOverride(env: NodeJS.ProcessEnv = process.env): EvalLlmOverride | undefined {
	const apiKey = env.EVAL_BYOK_API_KEY?.trim();
	// 未配置：正常路径，回落 AGNES（既有行为），不告警。
	if (!apiKey) return undefined;

	const baseUrl = env.EVAL_BYOK_BASE_URL?.trim();
	const model = env.EVAL_BYOK_MODEL?.trim();
	const providerRef = env.EVAL_BYOK_PROVIDER?.trim() || "eval-byok";
	const reasoning = /^(1|true|yes)$/i.test(env.EVAL_BYOK_REASONING?.trim() ?? "");

	if (!baseUrl || !model) {
		// ⚠️ 配置不全：告警但不回显 key，回落 AGNES。
		// 运行者会立刻看到 AGNES 429，从而发现 BYOK 没生效 —— 这比静默失败易排查。
		process.stderr.write(
			"[eval-byok] EVAL_BYOK_API_KEY 已设，但缺 EVAL_BYOK_BASE_URL / EVAL_BYOK_MODEL，BYOK 未生效，回落 AGNES。\n",
		);
		return undefined;
	}

	return { model, apiKey, baseUrl, providerRef, source: "user", reasoning };
}

/** `.env.example` 里应出现的变量名清单（供校验/文档使用，不含任何值）。 */
export const EVAL_BYOK_ENV_KEYS = [
	"EVAL_BYOK_API_KEY",
	"EVAL_BYOK_BASE_URL",
	"EVAL_BYOK_MODEL",
	"EVAL_BYOK_PROVIDER",
	"EVAL_BYOK_REASONING",
] as const;
