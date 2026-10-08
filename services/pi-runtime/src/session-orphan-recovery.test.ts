import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";
import type { RuntimeConfig } from "./runtime-config.js";

/** 长 TTL / 大上限：本文件只测孤儿 operation 结算，回收策略归 session-retention。 */
function baseConfig(root: string): RuntimeConfig {
	return {
		dataRoot: root,
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	} as RuntimeConfig;
}

type DriveOutcomeKind = "settled" | "waiting";

interface LaneProbe {
	driveCalls: Array<{ operationId: string }>;
	requestAbortCalls: string[];
	driveResult: { ok: boolean; kind?: DriveOutcomeKind };
	inspectThrows: boolean;
	driveThrows: boolean;
	/** 非空时 inspectExecution 报「lane 上有 current operation」（force 分支的输入） */
	currentOperationId?: string;
}

/**
 * 可观测的 fake harness：
 * - `open` = 模拟 vendor 在 attach 时从盘上还原出来的未完成 operation（生产事故的输入）
 * - lane.drive / requestAbort / inspectExecution 全部被记录，用于断言「是否结算了它」
 */
function makeHarnessFactory(opts: {
	open?: unknown[];
	probe?: Partial<LaneProbe>;
	/** 每个会话一份 probe；默认共用传入的 probe 对象 */
	perSession?: boolean;
}) {
	const probes: LaneProbe[] = [];
	const makeProbe = (): LaneProbe => {
		const p: LaneProbe = {
			driveCalls: [],
			requestAbortCalls: [],
			driveResult: { ok: true, kind: "settled" },
			inspectThrows: false,
			driveThrows: false,
			...opts.probe,
		};
		probes.push(p);
		return p;
	};
	// 无 perSession 时复用同一个 probe：多数用例只建一个会话。
	let shared: LaneProbe | undefined;
	const factory = (async () => {
		const probe = opts.perSession ? makeProbe() : (shared ??= makeProbe());
		const harness = {
			events: { on: () => () => {} },
			lane: async () => ({
				prompt: async () => ({ ok: true }),
				drive: async (o: { operationId: string }) => {
					probe.driveCalls.push({ operationId: o.operationId });
					if (probe.driveThrows) throw new Error("drive boom");
					return probe.driveResult.ok
						? { ok: true, value: { kind: probe.driveResult.kind ?? "settled" } }
						: { ok: false, error: { kind: "Closed", message: "closed" } };
				},
				requestAbort: async (operationId: string) => {
					probe.requestAbortCalls.push(operationId);
					return { ok: true, value: { operationId, newlyRequested: true, steer: [] } };
				},
				inspectExecution: async () => {
					if (probe.inspectThrows) throw new Error("inspect boom");
					const current = probe.currentOperationId
						? {
								id: probe.currentOperationId,
								kind: "run" as const,
								startedAt: Date.now() - 60_000,
								status: "running" as const,
							}
						: null;
					return {
						lane: "main",
						tipId: null,
						configuredModel: { provider: "p", modelId: "m" },
						current,
						lastOperationId: null,
					};
				},
			}),
			close: async () => {},
		};
		return { harness, open: opts.open };
	}) as never;
	return { factory, probes };
}

function withTempDataRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "pi-runtime-orphan-"));
	return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function makeManager(factory: unknown, root: string): SessionManager {
	return new SessionManager([], "", undefined, factory as never, undefined, undefined, baseConfig(root));
}

const OPEN_RUN = [
	{ lane: "main", operationId: "op-orphan-1", kind: "run" as const, startedAt: Date.now() - 3_600_000 },
];

describe("P0-1 create() 结算上一个进程留下的孤儿 operation", () => {
	it("open 里的 operation 被 drive 一次（释放 lane 的唯一手段）", async () => {
		await withTempDataRoot(async (root) => {
			const { factory, probes } = makeHarnessFactory({ open: OPEN_RUN });
			const sm = makeManager(factory, root);
			await sm.create("s1:t1", { userId: "u1" });
			assert.deepEqual(probes[0].driveCalls, [{ operationId: "op-orphan-1" }]);
		});
	});

	it("多个 open operation 全部结算（逐个 drive，不因第一个失败而跳过）", async () => {
		await withTempDataRoot(async (root) => {
			const open = [
				{ lane: "main", operationId: "op-a", kind: "run" as const, startedAt: Date.now() },
				{ lane: "main", operationId: "op-b", kind: "compaction" as const, startedAt: Date.now() },
			];
			const { factory, probes } = makeHarnessFactory({ open });
			const sm = makeManager(factory, root);
			await sm.create("s2:t1", { userId: "u1" });
			assert.deepEqual(
				probes[0].driveCalls.map((c) => c.operationId),
				["op-a", "op-b"],
			);
		});
	});

	it("drive 返回 err 时 fail-soft：create 仍成功，后续会话不受牵连", async () => {
		await withTempDataRoot(async (root) => {
			const { factory, probes } = makeHarnessFactory({
				open: OPEN_RUN,
				probe: { driveResult: { ok: false } },
			});
			const sm = makeManager(factory, root);
			const out = await sm.create("s3:t1", { userId: "u1" });
			assert.equal(out.status, "created");
			assert.equal(probes[0].driveCalls.length, 1);
		});
	});

	it("drive 抛异常时 fail-soft：create 仍成功（不得把孤儿放大成建不起会话）", async () => {
		await withTempDataRoot(async (root) => {
			const { factory, probes } = makeHarnessFactory({ open: OPEN_RUN, probe: { driveThrows: true } });
			const sm = makeManager(factory, root);
			const out = await sm.create("s4:t1", { userId: "u1" });
			assert.equal(out.status, "created");
			assert.equal(probes[0].driveCalls.length, 1);
		});
	});

	it("open 为空或 undefined 时一次都不 drive（新建会话零额外开销）", async () => {
		await withTempDataRoot(async (root) => {
			const a = makeHarnessFactory({ open: [] });
			await makeManager(a.factory, root).create("s5:t1", { userId: "u1" });
			assert.equal(a.probes[0].driveCalls.length, 0);

			const b = makeHarnessFactory({}); // open 为 undefined：兼容只返回 { harness } 的 fake
			await makeManager(b.factory, root).create("s6:t1", { userId: "u1" });
			assert.equal(b.probes[0].driveCalls.length, 0);
		});
	});

	it("内存快路径（第二次 create）不结算：那条路上的 open 是本进程合法在途 run", async () => {
		await withTempDataRoot(async (root) => {
			const { factory, probes } = makeHarnessFactory({ open: OPEN_RUN });
			const sm = makeManager(factory, root);
			await sm.create("s7:t1", { userId: "u1" });
			assert.equal(probes[0].driveCalls.length, 1);
			const second = await sm.create("s7:t1", { userId: "u1" });
			assert.equal(second.status, "resumed");
			// 第二次是内存快路径：不得再次 drive（否则会把在跑的 run 结算掉）
			assert.equal(probes[0].driveCalls.length, 1);
		});
	});
});

describe("P0-2 abort() 的 force 语义（无 cancelRun 时也能解锁）", () => {
	it("lane 上有孤儿 operation：requestAbort + drive，返回 true（旧实现恒 false）", async () => {
		await withTempDataRoot(async (root) => {
			const { factory, probes } = makeHarnessFactory({
				open: [],
				probe: { currentOperationId: "op-stuck" },
			});
			const sm = makeManager(factory, root);
			await sm.create("s8:t1", { userId: "u1" });
			assert.equal(await sm.abort("s8:t1"), true);
			assert.deepEqual(probes[0].requestAbortCalls, ["op-stuck"]);
			assert.deepEqual(probes[0].driveCalls, [{ operationId: "op-stuck" }]);
		});
	});

	it("lane 空闲（真没东西可停）：返回 false，语义与旧实现一致", async () => {
		await withTempDataRoot(async (root) => {
			const { factory, probes } = makeHarnessFactory({ open: [] });
			const sm = makeManager(factory, root);
			await sm.create("s9:t1", { userId: "u1" });
			assert.equal(await sm.abort("s9:t1"), false);
			assert.equal(probes[0].requestAbortCalls.length, 0);
		});
	});

	it("inspectExecution 抛异常时 fail-soft：返回 false 且不抛（「停止」不得变成 500）", async () => {
		await withTempDataRoot(async (root) => {
			const { factory } = makeHarnessFactory({ open: [], probe: { inspectThrows: true } });
			const sm = makeManager(factory, root);
			await sm.create("s10:t1", { userId: "u1" });
			assert.equal(await sm.abort("s10:t1"), false);
		});
	});

	it("未知 session 返回 false（不抛）", async () => {
		await withTempDataRoot(async (root) => {
			const { factory } = makeHarnessFactory({ open: [] });
			const sm = makeManager(factory, root);
			assert.equal(await sm.abort("nope"), false);
		});
	});
});
