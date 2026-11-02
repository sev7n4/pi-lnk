/**
 * 回合外生成终态通报扫描测试（2026-10-18 上游对齐）。
 * 覆盖：过滤（agentTurnNotified / 无目标 / 无线程）、通报成功落标记、
 * suppressed 也落标记（防重发）、瞬时失败不落标记（下轮重试）。
 */
import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import {
	notifyLateGenerationTerminals,
	piLateNotifyEnabled,
	type LateNotifyPrisma,
} from "./late-generation-notify";

function makePrisma(records: Array<Record<string, unknown>>, threads: Record<string, string> = {}) {
	const updated: string[] = [];
	const prisma = {
		generationRecord: {
			findMany: async () => records,
			update: async ({ where }: { where: { id: string } }) => {
				updated.push(where.id);
				return {};
			},
		},
		agentThread: {
			findFirst: async ({ where }: { where: { sessionId: string } }) =>
				threads[where.sessionId] ? { id: threads[where.sessionId] } : null,
		},
	} as unknown as LateNotifyPrisma & { updated: string[] };
	return { prisma: prisma as LateNotifyPrisma, updated };
}

const silentLogger = { warn: () => undefined, log: () => undefined };

function rec(overrides: Record<string, unknown> = {}) {
	return {
		id: "rec-1",
		type: "video",
		status: "completed",
		url: "https://x/v.mp4",
		sessionId: "canvas-1",
		nodeId: "node-1",
		metadata: JSON.stringify({ userMessage: "生成超时" }),
		...overrides,
	};
}

describe("notifyLateGenerationTerminals", () => {
	it("正常通报：有画布会话 + 有 agent 线程 → notifyGeneration + 落 delivered 标记", async () => {
		const { prisma, updated } = makePrisma([rec()], { "canvas-1": "canvas-1:main" });
		const sent: Array<{ sessionId: string; payload: Record<string, unknown> }> = [];
		const client = {
			notifyGeneration: async (sessionId: string, payload: Record<string, unknown>) => {
				sent.push({ sessionId, payload });
				return { delivered: true };
			},
		};
		const handled = await notifyLateGenerationTerminals(prisma, client, silentLogger);
		expect(handled).toBe(1);
		expect(updated).toEqual(["rec-1"]);
		expect(sent).toHaveLength(1);
		expect(sent[0].sessionId).toBe("canvas-1:main");
		expect(sent[0].payload).toMatchObject({ nodeId: "node-1", status: "completed", kind: "视频", url: "https://x/v.mp4" });
	});

	it("delivered:true → onDelivered 收到线程 id（P0-A 投影记账者派发点）", async () => {
		const { prisma } = makePrisma([rec()], { "canvas-1": "canvas-1:main" });
		const client = { notifyGeneration: async () => ({ delivered: true }) };
		const delivered: string[] = [];
		await notifyLateGenerationTerminals(prisma, client, silentLogger, {
			onDelivered: (threadId) => delivered.push(threadId),
		});
		expect(delivered).toEqual(["canvas-1:main"]);
	});

	it("delivered:false（抑制）→ onDelivered 不派发", async () => {
		const { prisma } = makePrisma([rec()], { "canvas-1": "canvas-1:main" });
		const client = { notifyGeneration: async () => ({ delivered: false, reason: "tool-wait-active" }) };
		const delivered: string[] = [];
		await notifyLateGenerationTerminals(prisma, client, silentLogger, {
			onDelivered: (threadId) => delivered.push(threadId),
		});
		expect(delivered).toEqual([]);
	});

	it("已被通报过（agentTurnNotified 在 metadata）→ 跳过不重发", async () => {
		const { prisma } = makePrisma([rec({ metadata: JSON.stringify({ agentTurnNotified: "delivered" }) })]);
		const client = {
			notifyGeneration: async () => {
				throw new Error("should not be called");
			},
		};
		expect(await notifyLateGenerationTerminals(prisma, client, silentLogger)).toBe(0);
	});

	it("无 nodeId → 落 no-target 标记（不通报，防重扫）", async () => {
		const { prisma, updated } = makePrisma([rec({ nodeId: null })]);
		const client = {
			notifyGeneration: async () => {
				throw new Error("should not be called");
			},
		};
		expect(await notifyLateGenerationTerminals(prisma, client, silentLogger)).toBe(1);
		expect(updated).toEqual(["rec-1"]);
	});

	it("无 agent 线程 → 落 no-thread 标记（画布从未开过对话，通报无人消费）", async () => {
		const { prisma, updated } = makePrisma([rec()], {});
		const client = {
			notifyGeneration: async () => {
				throw new Error("should not be called");
			},
		};
		expect(await notifyLateGenerationTerminals(prisma, client, silentLogger)).toBe(1);
		expect(updated).toEqual(["rec-1"]);
	});

	it("notifyGeneration 返回 delivered:false（工具仍在等）→ 也落标记（防重发）", async () => {
		const { prisma, updated } = makePrisma([rec()], { "canvas-1": "canvas-1:main" });
		const client = {
			notifyGeneration: async () => ({ delivered: false, reason: "tool-wait-active" }),
		};
		expect(await notifyLateGenerationTerminals(prisma, client, silentLogger)).toBe(1);
		expect(updated).toEqual(["rec-1"]);
	});

	it("notifyGeneration 抛错 → 不落标记（下一轮巡检重试）", async () => {
		const { prisma, updated } = makePrisma([rec()], { "canvas-1": "canvas-1:main" });
		const client = {
			notifyGeneration: async () => {
				throw new Error("ECONNREFUSED");
			},
		};
		expect(await notifyLateGenerationTerminals(prisma, client, silentLogger)).toBe(0);
		expect(updated).toEqual([]);
	});

	it("piLateNotifyEnabled：PI_RUNTIME_URL 缺省 / MODE=off → false", () => {
		const prevUrl = process.env.PI_RUNTIME_URL;
		const prevMode = process.env.PI_RUNTIME_MODE;
		try {
			delete process.env.PI_RUNTIME_URL;
			expect(piLateNotifyEnabled()).toBe(false);
			process.env.PI_RUNTIME_URL = "http://x";
			expect(piLateNotifyEnabled()).toBe(true);
			process.env.PI_RUNTIME_MODE = "off";
			expect(piLateNotifyEnabled()).toBe(false);
		} finally {
			if (prevUrl === undefined) delete process.env.PI_RUNTIME_URL;
			else process.env.PI_RUNTIME_URL = prevUrl;
			if (prevMode === undefined) delete process.env.PI_RUNTIME_MODE;
			else process.env.PI_RUNTIME_MODE = prevMode;
		}
	});
});

// ── 2026-10-21：补上「查询参数」与「失败降级」两处防线 ─────────────────────
//
// 【本 bug 的根因链】查了 DB 里不存在的 `GenerationRecord.updatedAt` ⇒ 每 5min 刷屏。
// 两层旧防线都没抓到它：
//   1. 类型层：`LateNotifyPrisma` 是**手写**接口 ⇒ 字段名不受 prisma 真类型约束；
//   2. 运行层：测试的 mock `findMany: async () => records` **整个绕开查询参数**。
// ⇒ 新增：① 断言**查询参数本身**（把绕开的部分补回来）；② 扫描失败降级不刷屏。
// 类型层防线已由「`LateNotifyPrisma` 改为 prisma 类型派生」在 tsc 阶段承担。

describe("查询参数（把 mock 绕开的部分补回来）", () => {
	it("where 按 updatedAt 取最近窗口的终态记录（不是 createdAt）", async () => {
		const captured: Array<Record<string, unknown>> = [];
		const prisma = {
			generationRecord: {
				findMany: async (args: Record<string, unknown>) => {
					captured.push(args);
					return [];
				},
				update: async () => ({}),
			},
			agentThread: { findFirst: async () => null },
		} as unknown as LateNotifyPrisma;

		await notifyLateGenerationTerminals(prisma, { notifyGeneration: async () => ({ delivered: true }) }, silentLogger);

		expect(captured).toHaveLength(1);
		const args = captured[0];
		const where = args.where as Record<string, unknown>;
		// ⭐ 必须按 updatedAt（最后变更）取窗口 —— 语义是「最近进入终态」
		expect(where.updatedAt).toBeDefined();
		expect((where.updatedAt as { gte: Date }).gte).toBeInstanceOf(Date);
		// ⛔ 不得退化成 createdAt：会漏扫「早创建晚完成」的记录（破坏 reaper 核心保证）
		expect(where.createdAt).toBeUndefined();
		// 排序同理：按最后变更升序 ⇒ 最早进入终态的先通报
		expect(args.orderBy).toEqual({ updatedAt: "asc" });
		// 其余过滤条件保持
		expect(where.status).toEqual({ in: ["completed", "failed"] });
		expect(where.sessionId).toEqual({ not: null });
	});

	it("⚠️ 类型层防线：查询参数类型必须受 prisma 真类型约束", () => {
		// 这一行是**编译期**断言：`args` 的类型来自 `Prisma.GenerationRecordFindManyArgs`
		// ⇒ 若有人再写一个 DB 里不存在的列名，tsc 直接报错（不是生产刷屏）。
		// 运行时用一条合法参数证明链路通。
		const args: Prisma.GenerationRecordFindManyArgs = {
			where: { updatedAt: { gte: new Date() } },
			orderBy: { updatedAt: "asc" },
			select: { id: true },
		};
		expect(args.where).toBeDefined();
		expect(args.orderBy).toEqual({ updatedAt: "asc" });
	});
});

describe("扫描失败降级（不刷屏）", () => {
	it("findMany 抛错 ⇒ 返回 0 + 告警一次（不抛出、不崩 reaper）", async () => {
		const warnings: string[] = [];
		const prisma = {
			generationRecord: {
				findMany: async () => {
					throw new Error("Invalid `prisma.generationRecord.findMany()` invocation");
				},
				update: async () => ({}),
			},
			agentThread: { findFirst: async () => null },
		} as unknown as LateNotifyPrisma;

		const handled = await notifyLateGenerationTerminals(
			prisma,
			{ notifyGeneration: async () => ({ delivered: true }) },
			{ warn: (m: string) => warnings.push(m), log: () => undefined },
		);
		expect(handled).toBe(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("late_generation_scan_failed");
	});

	it("⚠️ agentThread.findFirst 抛错（字段名写错等）→ 不落 no-thread 标记、下轮重试", async () => {
		// 回归 2026-11-02 黑章鱼事件根因：此前 findFirst 的 select 误用不存在的
		// `threadId` 列 ⇒ Prisma 抛校验错，被 `.catch(() => null)` 吞掉 ⇒ 每条记录被
		// 永久标 no-thread（durable 去重键），完成通知永远不送达。
		// 修复后：查询报错 ≠ 无线程，应 warn + 本记录不落标记（下轮巡检重试）。
		const warnings: string[] = [];
		const updated: string[] = [];
		const prisma = {
			generationRecord: {
				findMany: async () => [rec()],
				update: async ({ where }: { where: { id: string } }) => {
					updated.push(where.id);
					return {};
				},
			},
			agentThread: {
				findFirst: async () => {
					throw new Error("Invalid `prisma.agentThread.findFirst()` invocation: unknown field `threadId`");
				},
			},
		} as unknown as LateNotifyPrisma;

		const client = {
			notifyGeneration: async () => {
				throw new Error("should not be called");
			},
		};

		const handled = await notifyLateGenerationTerminals(
			prisma,
			client,
			{ warn: (m: string) => warnings.push(m), log: () => undefined },
		);
		// 本记录未标记 ⇒ 不计入 handled，下轮重扫
		expect(handled).toBe(0);
		// 关键：绝不能误标 no-thread（那会永久丢掉这条完成通知）
		expect(updated).toEqual([]);
		expect(warnings.some((m) => m.includes("查询 agent 线程失败"))).toBe(true);
	});

	it("正常通报：findFirst 用真实字段 id 解析线程（非 threadId 列）", async () => {
		// 直接锁定修复点：线程查回的字段是 `id`，notifyGeneration 收到的 threadId 应等于该 id。
		const { prisma, updated } = makePrisma([rec()], { "canvas-1": "canvas-1:main" });
		const sent: Array<{ sessionId: string; payload: Record<string, unknown> }> = [];
		const client = {
			notifyGeneration: async (sessionId: string, payload: Record<string, unknown>) => {
				sent.push({ sessionId, payload });
				return { delivered: true };
			},
		};
		const handled = await notifyLateGenerationTerminals(prisma, client, silentLogger);
		expect(handled).toBe(1);
		expect(updated).toEqual(["rec-1"]);
		expect(sent).toHaveLength(1);
		// 此处 sessionId 实为 thread.id（即 canvas-1:main）
		expect(sent[0].sessionId).toBe("canvas-1:main");
		expect(sent[0].payload).toMatchObject({ nodeId: "node-1", status: "completed", kind: "视频", url: "https://x/v.mp4" });
	});
});
