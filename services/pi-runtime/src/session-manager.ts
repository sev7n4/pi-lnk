/**
 * 会话管理（spec §6.2.0 B8 pi-runtime 侧）
 *
 * 职责：把 vendored pi 的 AgentHarness 会话生命周期封装为可被 Nest RPC 的形态。
 * 所有 API 均基于 PoC（packages/pi-poc 5/5 PASS）实测过的调用模式。
 *
 * 事件归一（实测校准，对应 spec §8.5.1 命名）：
 *   pi harness 层事件名与底层 Agent.subscribe() 的 AgentEvent 有命名差：
 *     run_start      → agent_start
 *     run_end        → agent_end
 *     tool_start     → tool_execution_start
 *     tool_update    → tool_execution_update
 *     tool_end       → tool_execution_end
 *   message_* / turn_* 同名直传；fault / handler_error 归一为 error（spec 称 pi
 *   无独立 error 事件是指 AgentEvent 层——harness 层有，必须转发否则丢错）。
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	AgentHarness,
	type AgentHarnessTool,
	type Context,
	BACKGROUND_CONTEXT,
	JsonlSessionRepo,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { assembleModel } from "./model-assembly.js";
import type { LnkpiToolContext } from "./tools/types.js";

export type NormalizedEventType =
	| "agent_start"
	| "agent_end"
	| "turn_start"
	| "turn_end"
	| "message_start"
	| "message_update"
	| "message_end"
	| "tool_execution_start"
	| "tool_execution_update"
	| "tool_execution_end"
	| "error";

export interface NormalizedEvent {
	type: NormalizedEventType;
	lane?: string;
	ts: number;
	data: unknown;
}

export type EventListener = (event: NormalizedEvent) => void;

const DATA_ROOT = process.env.PI_RUNTIME_DATA_DIR ?? join(process.cwd(), ".pi-runtime-data");

/** harness 事件类型 → SSE 归一事件类型（同名直传的映射也显式列出，便于审计）。 */
const EVENT_MAP: ReadonlyArray<readonly [string, NormalizedEventType]> = [
	["run_start", "agent_start"],
	["run_end", "agent_end"],
	["turn_start", "turn_start"],
	["turn_end", "turn_end"],
	["message_start", "message_start"],
	["message_update", "message_update"],
	["message_end", "message_end"],
	["tool_start", "tool_execution_start"],
	["tool_update", "tool_execution_update"],
	["tool_end", "tool_execution_end"],
	["fault", "error"],
	["handler_error", "error"],
];

interface SessionEntry {
	id: string;
	harness: AgentHarness<LnkpiToolContext>;
	env: NodeExecutionEnv;
	repo: JsonlSessionRepo;
	listeners: Set<EventListener>;
	buffer: NormalizedEvent[];
	unsubscribes: Array<() => void>;
	prompting: boolean;
}

const BUFFER_LIMIT = 500;

export class SessionManager {
	private readonly sessions = new Map<string, SessionEntry>();
	private readonly context: Context = BACKGROUND_CONTEXT;

	constructor(
		private readonly tools: AgentHarnessTool<LnkpiToolContext>[] = [],
		private readonly systemPromptDefault = process.env.PI_RUNTIME_SYSTEM_PROMPT ?? "",
	) {}

	has(id: string): boolean {
		return this.sessions.has(id);
	}

	count(): number {
		return this.sessions.size;
	}

	async create(
		id: string,
		opts: { systemPrompt?: string; workingDir?: string; userId?: string } = {},
	): Promise<{ provider: string; model: string }> {
		if (this.sessions.has(id)) throw new ConflictError(id);
		const { models, model, providerId } = assembleModel();

		const cwd = opts.workingDir ?? join(DATA_ROOT, id);
		await mkdir(cwd, { recursive: true });
		const env = new NodeExecutionEnv({ cwd });
		const repo = new JsonlSessionRepo({ fileSystem: env, sessionsRoot: join(cwd, "sessions") });
		const session = await repo.create({ cwd }, this.context);

		const { harness } = await AgentHarness.create<LnkpiToolContext>(
			{
				session,
				models,
				model,
				tools: this.tools,
				toolContext: { sessionId: id, userId: opts.userId },
				systemPrompt: opts.systemPrompt || this.systemPromptDefault,
			},
			this.context,
		);

		const entry: SessionEntry = {
			id,
			harness,
			env,
			repo,
			listeners: new Set(),
			buffer: [],
			unsubscribes: [],
			prompting: false,
		};

		for (const [harnessType, sseType] of EVENT_MAP) {
			entry.unsubscribes.push(
				harness.events.on(harnessType as never, (evt: { lane?: string }) => {
					this.dispatch(entry, {
						type: sseType,
						lane: evt.lane,
						ts: Date.now(),
						data: evt,
					});
				}),
			);
		}

		this.sessions.set(id, entry);
		return { provider: providerId, model: model.id };
	}

	subscribe(id: string, listener: EventListener): NormalizedEvent[] {
		const entry = this.require(id);
		entry.listeners.add(listener);
		return [...entry.buffer];
	}

	unsubscribe(id: string, listener: EventListener): void {
		this.sessions.get(id)?.listeners.delete(listener);
	}

	/** 触发一次 prompt。不 await 完成——事件经 events 总线流出；run 结束由 agent_end 表达。 */
	async prompt(id: string, text: string, laneName = "main"): Promise<{ accepted: boolean }> {
		const entry = this.require(id);
		const lane = await entry.harness.lane(laneName, this.context);
		entry.prompting = true;
		void lane
			.prompt(text, undefined, this.context)
			.then((result) => {
				if (!result.ok) {
					this.dispatch(entry, {
						type: "error",
						lane: laneName,
						ts: Date.now(),
						data: { source: "prompt", message: String(result.error) },
					});
				}
			})
			.catch((err: unknown) => {
				this.dispatch(entry, {
					type: "error",
					lane: laneName,
					ts: Date.now(),
					data: { source: "prompt", message: err instanceof Error ? err.message : String(err) },
				});
			})
			.finally(() => {
				entry.prompting = false;
			});
		return { accepted: true };
	}

	async remove(id: string): Promise<boolean> {
		const entry = this.sessions.get(id);
		if (!entry) return false;
		for (const unsub of entry.unsubscribes) unsub();
		entry.listeners.clear();
		this.sessions.delete(id);
		try {
			await entry.harness.close(this.context);
			await entry.repo.close(this.context);
			await entry.env.cleanup(this.context);
		} catch {
			// 清理失败不阻塞删除响应（会话目录留待 K8s PVC 生命周期回收）
		}
		await rm(join(DATA_ROOT, id), { recursive: true, force: true }).catch(() => {});
		return true;
	}

	private dispatch(entry: SessionEntry, event: NormalizedEvent): void {
		entry.buffer.push(event);
		if (entry.buffer.length > BUFFER_LIMIT) entry.buffer.shift();
		for (const listener of entry.listeners) {
			try {
				listener(event);
			} catch {
				// 单个订阅者异常不阻断其他订阅者（对齐 HarnessEventBus 的隔离语义）
			}
		}
	}

	private require(id: string): SessionEntry {
		const entry = this.sessions.get(id);
		if (!entry) throw new NotFoundError(id);
		return entry;
	}
}

export class ConflictError extends Error {
	constructor(id: string) {
		super(`session exists: ${id}`);
	}
}

export class NotFoundError extends Error {
	constructor(id: string) {
		super(`session not found: ${id}`);
	}
}
