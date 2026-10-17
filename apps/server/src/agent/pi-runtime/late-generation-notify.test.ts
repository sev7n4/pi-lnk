/**
 * 回合外生成终态通报扫描测试（2026-10-18 上游对齐）。
 * 覆盖：过滤（agentTurnNotified / 无目标 / 无线程）、通报成功落标记、
 * suppressed 也落标记（防重发）、瞬时失败不落标记（下轮重试）。
 */
import { describe, expect, it } from "vitest";
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
				threads[where.sessionId] ? { threadId: threads[where.sessionId] } : null,
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
