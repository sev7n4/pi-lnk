/**
 * pi-runtime HTTP 驱动（W1b）。
 *
 * ## 为什么驱动的是 HTTP 而不是进程内调用
 *
 * 被测对象是**部署形态**的 pi-runtime：Fastify + SSE + `/sessions` 幂等 upsert +
 * 事件缓冲/replay。进程内直调 `SessionManager` 会绕过 HTTP 契约、SSE 归一与
 * `from=now` 订阅裁决 —— 那三处恰好是真实链路上出问题的地方。
 * eval 必须测「上线后那个」，不是「源码里那个」。
 *
 * ## 依赖策略
 *
 * ⭐ **不引 `@earendil-works/pi-coding-agent`**（vendor 的 harness 依赖它，
 * 但那是交互式终端宿主层，本项目刻意不依赖 —— 见 `DEPENDENCIES.md` / ADR-0001）。
 * `vitest-evals` 本身是**npm 公开包**（Apache-2.0），不引入它。
 *
 * 因此本模块**不 import `vitest-evals`**，只产出 vitest-evals 认识的
 * `SimpleHarnessResult` 形状（结构化类型，见 `harness-types.ts` 的注释）。
 * 这样 `harness.ts` 里的 `createHarness(...)` 适配层是唯一接触该包的地方，
 * 依赖面收敛到一文件；且本模块可独立单测（不需要跑 eval 框架）。
 */
import { foldRuntimeEvents, type EvalCaseInput, type EvalTranscript, type RuntimeEvent } from "./transcript.js";

export interface RuntimeDriverOptions {
	/** pi-runtime 基址，如 `http://127.0.0.1:8100`。 */
	baseUrl: string;
	/** 单轮超时（ms）。超时按「失败」记，不静默挂住。 */
	timeoutMs?: number;
}

/** 一轮的执行结果（adapter 交给 vitest-evals 的形状）。 */
export interface RuntimeRunResult {
	transcript: EvalTranscript;
	/** 归一化 transcript 事件，供 vitest-evals 记录（工具调用轨迹要能 diff）。 */
	events: RuntimeEvent[];
	usage?: EvalTranscript["usage"];
	errors: string[];
}

/**
 * 跑一轮：建会话 → 订阅 SSE → 发prompt → 收`agent_end`。
 *
 * ## 顺序为什么是「先订阅后prompt」
 *
 * 与 Nest 生产链路同构（`agent.service.ts` 里"先订阅再 prompt，避免首事件竞态，
 * SSE缓冲重放兜底"）。反过来会有真实概率丢首帧 —— 而丢首帧在评测里表现为
 * 「模型没调工具」，看起来像提示词问题，实际是 harness 竞态。**这种假失败最贵。**
 */
export async function runEvalCase(
	options: RuntimeDriverOptions,
	input: EvalCaseInput,
): Promise<RuntimeRunResult> {
	const base = options.baseUrl.replace(/\/+$/, "");
	const timeoutMs = options.timeoutMs ?? 120_000;
	const sessionId = `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

	// ① 建会话。⚠️ 订阅必须先于 prompt（见函数注释）。
	const created = await postJson(`${base}/sessions`, {
		sessionId,
		// ⚠️ `userId` 必须是**真实**的 Nest userId：pi-runtime 的画布工具会用它做
		// 归属校验（`propose_generation` 甚至直接要求 `tc.userId`），填假值会让
		// 所有 `/agent/internal/*` 调用 4xx ⇒ 模型反复重试工具、评测只能拿到超时。
		// 实证：首跑 7 条全 120s 超时，根因正是这里（get_canvas_summary 22 次 4xx）。
		userId: input.userId ?? "eval",
		systemPrompt: input.systemPrompt,
		// ⭐ `canvasSessionId` 缺省**不能**回落到 pi 会话键：那是个不存在的 id，
		// 查画布必然 404/401。缺省时留空并由调用方显式传。
		...(input.canvasSessionId ? { canvasSessionId: input.canvasSessionId } : {}),
	});
	if (created.status >= 400) {
		return failure(`createSession failed: HTTP ${created.status} ${created.body}`);
	}

	// ② 订阅 live（from=now：只要未来事件，不要上一轮的全量重放）。
	//    这是 vendor `resolveEventsSubscribeMode` 的生产取值 —— 用 replay 模式
	//    会把上一轮的 agent_end 当成本轮的，提前结束评测。
	const collected: RuntimeEvent[] = [];
	//⭐ 持有 AbortController：超时/出错时必须 abort，否则底层 socket 仍挂着。
	//   fetch 的 body reader 不被 cancel 的话，进程不会退出（Node 会一直等）——
	//   那会让「eval 跑一次挂住整个 CI」变成可能。
	const streamAbort = new AbortController();
	const streamDone = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`eval timeout after ${timeoutMs}ms (session=${sessionId})`));
		}, timeoutMs);
		void streamEvents(
			`${base}/sessions/${encodeURIComponent(sessionId)}/events?from=now`,
			streamAbort.signal,
		)
			.then((evts) => {
				collected.push(...evts);
				clearTimeout(timer);
				resolve();
			})
			.catch((err: unknown) => {
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			});
	});

	// ③ 发 prompt。
	await postJson(`${base}/sessions/${encodeURIComponent(sessionId)}/prompt`, {
		text: input.text,
		lane: "main",
	});

	// ④ 等本轮 agent_end。若 SSE 提前关闭但已见 agent_end，视为正常。
	try {
		await streamDone;
	} catch (err) {
		// 释放底层连接，否则 Node 会等它 ⇒ 挂住整个进程
		streamAbort.abort();
		// 超时/网络错误：把已收事件照样折叠返回，让 case 断言能看到「跑到哪一步」，
		// 而不是只丢一个错误 —— 后者无法区分「没调工具」与「根本没跑起来」。
		const transcript = foldRuntimeEvents(collected);
		return {
			transcript,
			events: collected,
			usage: transcript.usage,
			errors: [...transcript.errors, err instanceof Error ? err.message : String(err)],
		};
	}

	const transcript = foldRuntimeEvents(collected);
	if (!collected.some((e) => e.type === "agent_end") && transcript.errors.length === 0) {
		// SSE 结束但从未 agent_end：不能算「跑完了」
		return {
			transcript,
			events: collected,
			usage: transcript.usage,
			errors: [...transcript.errors, "stream ended without agent_end"],
		};
	}
	return { transcript, events: collected, usage: transcript.usage, errors: transcript.errors };
}

function failure(message: string): RuntimeRunResult {
	return {
		transcript: {
			assistantText: "",
			toolNames: [],
			toolCalls: [],
			completed: false,
			errors: [message],
		},
		events: [],
		errors: [message],
	};
}

/**
 * 查画布当前节点数（**环境前置检查用**，不发模型请求、不烧 token）。
 *
 * ## 为什么需要它（2026-10-05 实测踩出来的）
 *
 * `tool-discovery-001` 话术是「把这 **30 个**节点按左右关系重新排一下」。实测对照：
 *
 * | 画布节点数 | 3 次判定 | 结论 |
 * |---|---|---|
 * | 2 | `fail / pass / fail` ⇒ 1/3 | ❌ 模型「先查数量、发现对不上就问用户」——**此环境下是合理行为** |
 * | 63 | `pass / pass / pass` ⇒ 3/3 | ✅ 正常触发 `arrange_nodes` |
 *
 * ⇒ 同一条 case、同一模型、同一份 prompt，**仅换画布就 1/3 → 3/3**。
 * ⇒ 「模型做不到」与「环境不对」在单次判据下**无法区分**——
 *不预检就会把环境问题误读成模型问题，然后去改本来正确的 prompt/工具。
 *
 * ## 契约（⚠️ 已对生产实测校验，勿凭直觉改）
 *
 * - 端点：`POST {NEST_BASE_URL}/agent/internal/get-canvas-summary`
 * - 鉴权头：**`x-lnkpi-service-token`**（不是 `x-service-token`）
 * - body：**`{ sessionId }`**（⚠️ **不是** `canvasSessionId`——pi-runtime 侧的
 *   `canvasSessionId` 到 Nest 这一层已改名为 `sessionId`；传错会得 400）
 * - 成功返回：**信封格式** `{ code, message, data: { nodes: [...] } }`（实测 HTTP 201）
 *   —— ⚠️ **不是**裸 `{ nodes }`（我第一版按裸对象解析，预检直接报「探针失效」）
 * - Nest 地址来自 `NEST_BASE_URL`（如 `http://10.1.0.12:5100/api`），
 *   **不是** `127.0.0.1:5100`——那在本 pod 内拒绝连接
 *
 * 三条都踩过 ⇒ 改之前先跑一次探针核对，别照抄记忆。
 */
export async function fetchCanvasNodeCount(
	nest: { baseUrl: string; token: string },
	input: { canvasSessionId: string },
): Promise<{ nodeCount: number } | { error: string }> {
	// ⭐⭐ 必须把 fetch 自身的异常也兜住：`fetch` 在连不上时会**抛**
	//（`TypeError: fetch failed`），而不是返回 4xx/5xx。
	// 漏了这层 ⇒ 「Nest 不可达」会以裸 `fetch failed` 冒到调用方，
	// 丢掉「这是环境问题、不是模型问题」这个关键信息 ——
	// 而这正是本预检存在的意义（实测踩过：改前就是这条）。
	let res: { status: number; body: string };
	try {
		res = await postJson(`${nest.baseUrl}/agent/internal/get-canvas-summary`, {
			sessionId: input.canvasSessionId,
		}, { "x-lnkpi-service-token": nest.token });
	} catch (err) {
		// 网络层失败（Nest 不可达 / DNS / 超时）⇒ 同样是「环境问题」
		return { error: `Nest 不可达（${nest.baseUrl}）：${err instanceof Error ? err.message : String(err)}` };
	}
	if (res.status >= 400) {
		// ⭐ 4xx 与 5xx 必须分开：前者是「画布不存在/参数错（换画布或改参数能解）」，
		// 后者是「服务端故障（重试能解）」—— 合并成一句会让排查无从下手。
		const kind = res.status >= 500 ? "Nest 服务端故障" : "画布不存在或参数错";
		return { error: `${kind}（HTTP ${res.status}）：${res.body.slice(0, 200)}` };
	}
	try {
		// ⚠️ Nest 的成功响应是**信封格式** `{ code, message, data: {...} }`
		// （实测：`{"code":0,"message":"ok","data":{"nodes":[...]}}`），
		// **不是**裸 `{ nodes }`。两种都兼容——工具层未来若改成裸对象也不至于失效。
		const parsed = JSON.parse(res.body) as {
			data?: { nodes?: unknown[] };
			nodes?: unknown[];
		};
		const nodes = parsed.data?.nodes ?? parsed.nodes;
		if (!Array.isArray(nodes)) {
			// ⚠️ 探针失效（响应结构变了）⇒ 报 error，**绝不谎报 0**——
			// 谎报 0 会让所有 requiresCanvasNodes 检查误判成「环境不足」。
			return { error: `探针失效：响应里没有 nodes 数组（${res.body.slice(0, 200)}）` };
		}
		return { nodeCount: nodes.length };
	} catch (err) {
		return { error: `探针响应不是 JSON：${err instanceof Error ? err.message : String(err)}` };
	}
}

async function postJson(
	url: string,
	body: unknown,
	extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...extraHeaders },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.text() };
}

/**
 * 读 SSE 直到连接关闭。
 *
 * ⚠️ 事件名是 `event:` 行、数据在 `data:` 行（Fastify SSE 约定）。
 * 解析必须容忍注释行（`:keep-alive`）与空行分隔。
 */
async function streamEvents(url: string, signal: AbortSignal): Promise<RuntimeEvent[]> {
	const res = await fetch(url, {
		headers: { accept: "text/event-stream" },
		signal,
	});
	if (!res.body) throw new Error(`SSE response has no body: ${url}`);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	const events: RuntimeEvent[] = [];
	let buffer = "";

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			// SSE 以空行分帧
			const frames = buffer.split(/\r?\n\r?\n/);
			buffer = frames.pop() ?? "";
			for (const frame of frames) {
				const dataLines = frame
					.split(/\r?\n/)
					.filter((l) => l.startsWith("data:"))
					.map((l) => l.slice(5).trim());
				if (dataLines.length === 0) continue; // 注释帧 / 心跳
				for (const line of dataLines) {
					let event: RuntimeEvent;
					try {
						event = JSON.parse(line) as RuntimeEvent;
					} catch {
						// 非 JSON 数据帧：跳过而不是崩（评测不该因日志行失败）
						continue;
					}
					events.push(event);
					// ⭐⭐ **见 agent_end 立即收手**。
					//
					// 为什么：`/events` 是**长连接**，`agent_end` 之后服务端**不关闭**
					//（前端还要靠它接下一轮）。所以「等流结束」永远不会来
					//⇒ 只能等 `timeoutMs`兜底 ⇒ **每条 case 都超时**，
					// 而模型其实早已完成（生产实测：模型正确调了
					// `get_canvas_summary` 并正确作答，`agent_end` 也到了，
					// 但 driver 收不到 ⇒ 报「本轮未正常结束」）。
					// ⇒ 判据是**收到即完成**，不是**流结束才完成**。
					if (event.type === "agent_end") return events;
				}
			}
		}
	} finally {
		//⭐ 释放 reader：否则 abort 后底层连接仍被持有，Node 会等它 ⇒ 进程不退出。
		//cancel 本身可能抛（连接已断），吞掉即可 —— 已经在收尾路径上。
		await reader.cancel().catch(() => {});
	}
	return events;
}
