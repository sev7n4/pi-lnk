/**
 * Eval canvas provisioning（P1，立项 spec `2026-11-15-eval-canvas-provisioning-design.md`）。
 *
 * 方案 A（CLI 内建）：run 开始时用测试账号经 Nest internal 端点自建新画布，
 * 新 id 注入本轮全部 case；run 结束**只归档改名不删**（D2，保留取证现场）。
 * 建画布失败 ⇒ 整 run error（D3 fail-fast，不回落共享画布——回落会把环境
 * 问题伪装成行为问题，重蹈 q3-07 画布污染覆辙）。
 *
 * 适用范围：**仅 eval 跑批 CLI**（显式运行才触发，测试账号自建自用）；
 * 生产用户路径零接触。显式传 `PI_EVAL_CANVAS_SESSION_ID` ⇒ 不供给
 * （单画布复现模式保留，验收 3）。
 */

export interface NestEndpoint {
	baseUrl: string;
	token: string;
}

export interface ProvisionDecision {
	provision: boolean;
	reason: string;
}

/**
 * 供给触发判定（纯函数，可测）：
 * - 显式给了画布 id ⇒ 不供给（复现模式，验收 3）；
 * - userId 或 nest 缺 ⇒ 不供给（交给 runL1 既有 fail-fast，文案已教怎么补）；
 * - 其余（自动模式）⇒ 供给。
 */
export function decideProvisioning(env: {
	canvasSessionId?: string;
	userId?: string;
	nest?: NestEndpoint;
}): ProvisionDecision {
	if (env.canvasSessionId) {
		return { provision: false, reason: "explicit-canvas-session" };
	}
	if (!env.userId || !env.nest) {
		return { provision: false, reason: "missing-user-or-nest（回落 runL1 既有 fail-fast）" };
	}
	return { provision: true, reason: "auto-provision-mode" };
}

export interface ProvisionedCanvas {
	sessionId: string;
	title: string;
	/** run 结束归档用的目标标题（eval-used-<runStamp>）。 */
	archiveTitle: string;
}

/** run 标识（D2 归档命名用）：本地时间 yyyymmdd-HHMMSS。 */
export function runStamp(now = new Date()): string {
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return (
		`${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
		`-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
	);
}

async function postInternal(
	nest: NestEndpoint,
	path: string,
	body: unknown,
	fetchImpl: typeof fetch,
): Promise<unknown> {
	const base = nest.baseUrl.replace(/\/+$/, "");
	let res: Response;
	try {
		res = await fetchImpl(`${base}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				// ⭐ Nest internal 鉴权是 x-lnkpi-service-token 原值 header（非 Bearer）。
				"x-lnkpi-service-token": nest.token,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15_000),
		});
	} catch (err) {
		throw new Error(
			`POST ${path} 失败：${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const text = await res.text();
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error(`${path} 响应非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
	}
	if (!res.ok) {
		const msg =
			(payload as { message?: string } | null)?.message ?? text.slice(0, 200);
		throw new Error(`POST ${path} HTTP ${res.status}：${msg}`);
	}
	return payload;
}

/**
 * D1：经 Nest internal `create-canvas` 建画布（canvasService.create 透传）。
 * 失败即抛（D3 fail-fast，由 CLI 层转 exit 2 + 明确文案）。
 */
export async function createEvalCanvas(
	nest: NestEndpoint,
	userId: string,
	opts: { runStamp?: string; fetchImpl?: typeof fetch } = {},
): Promise<ProvisionedCanvas> {
	const stamp = opts.runStamp ?? runStamp();
	const title = `eval-run-${stamp}`;
	const payload = (await postInternal(
		nest,
		"/agent/internal/create-canvas",
		{ userId, title },
		opts.fetchImpl ?? fetch,
	)) as { data?: { id?: string } } | null;
	const sessionId = payload?.data?.id;
	if (!sessionId) {
		throw new Error(`create-canvas 响应缺 data.id（画布未建成）：${JSON.stringify(payload)?.slice(0, 200)}`);
	}
	return { sessionId, title, archiveTitle: `eval-used-${stamp}` };
}

/**
 * D2 归档：run 结束把本轮画布改名 `eval-used-<runStamp>`（不删，保留取证现场）。
 * 归档失败**不抛**——运行结论已产出，归档只是命名 hygiene；返回错误信息给 CLI 记 warning。
 */
export async function archiveEvalCanvas(
	nest: NestEndpoint,
	sessionId: string,
	userId: string,
	archiveTitle: string,
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; error?: string }> {
	try {
		await postInternal(
			nest,
			"/agent/internal/rename-canvas",
			{ sessionId, userId, title: archiveTitle },
			opts.fetchImpl ?? fetch,
		);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
