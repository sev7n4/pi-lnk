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

async function postJson(
	url: string,
	body: unknown,
): Promise<{ status: number; body: string }> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
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
