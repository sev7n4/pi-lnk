import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, toSessionKey, type HarnessFactory } from "./session-manager.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { Metrics } from "./metrics.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * P0-3 / L-2 接线层测试：prompt 版本指纹从 turnContext → 指标 / session meta。
 *
 * ⭐ 与metrics.prompt-info.test.ts 的分工：那边锁**渲染**（标签、转义、n/a 兜底），
 * 这边锁**接线**（指纹真的到了指标、真的落进了 meta.json）。
 * 纯渲染测试全绿而没接线，是这类「加个指标」改动最典型的假绿。
 */

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-promptinfo-"));
let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `c${++cfgSeq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		toolTiering: false,
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	} as RuntimeConfig;
}

function makeFactory(): HarnessFactory {
	return (async () => ({
		harness: {
			events: { on: () => () => {} },
			lane: async () => ({ prompt: async () => ({ ok: true }) }),
			close: async () => {},
		},
	})) as unknown as HarnessFactory;
}

const INFO = {
	promptVersion: "1.0.0@9e8e28f11bc7",
	promptHash: "abc123",
	registryVersion: "1.0.0",
	registryHash: "9e8e28f11bc7",
};

describe("P0-3 / L-2 接线：prompt 指纹 → 指标 / meta.json", () => {
	let metrics: Metrics;
	beforeEach(() => {
		metrics = new Metrics();
	});

	it("⭐ turnContext 带 promptInfo ⇒ 指标 gauge 输出该版本", async () => {
		const sm = new SessionManager(
			[{ name: "t" } as never],
			"",
			undefined,
			makeFactory(),
			undefined,
			undefined,
			testConfig(),
			undefined, // 第8 位 onCompaction
			metrics, // 第 9 位 metrics
		);
		await sm.create("s1", { userId: "u1", systemPrompt: "SYS" });
		sm.setTurnContext("s1", { promptInfo: INFO });

		const text = metrics.render(1, "0.0.15");
		assert.ok(
			text.includes('pi_runtime_prompt_info{promptVersion="1.0.0@9e8e28f11bc7"'),
			`指标应含 promptVersion，实际输出片段：${text.split("\n").filter((l) => l.includes("prompt_info")).join(" | ")}`,
		);
		assert.ok(text.includes('promptHash="abc123"'));
	});

	it("⭐ promptInfo 参与变更判定 ⇒ changed=true 且指标同步更新", async () => {
		// 这条锁两件事：
		// ① `samePromptInfo` 生效 ⇒ 仅 promptInfo 变化也让 changed=true
		//② 指标随之更新到新版本
		// ⭐ 判定的意义：若promptInfo **不**参与相等判定，则 changed=false，
		// 而指标接线若放在 `if (changed)` 之外仍会更新 —— 但那样「本轮上下文变了
		// 却没有重新求值 systemPrompt」就再也没人能发现了。
		// 两个信号必须一起变，否则其中一个静默失效。
		const sm = new SessionManager(
			[{ name: "t" } as never],
			"",
			undefined,
			makeFactory(),
			undefined,
			undefined,
			testConfig(),
			undefined,
			metrics,
		);
		await sm.create("s2", { userId: "u1", systemPrompt: "SYS" });
		sm.setTurnContext("s2", { promptInfo: { ...INFO, promptVersion: "v1" } });
		const changed = sm.setTurnContext("s2", { promptInfo: { ...INFO, promptVersion: "v2" } });
		assert.equal(changed, true, "仅 promptVersion 变化也应判定 turnContext 变了");

		const text = metrics.render(1, "0.0.15");
		assert.ok(
			text.includes('promptVersion="v2"'),
			`指标应更新到 v2（实际：${text.split("\n").filter((l) => l.includes("prompt_info")).join(" | ")}）`,
		);
	});

	it("create 带 promptInfo ⇒ 落进 meta.json（磁盘 resume 的比对依据）", async () => {
		const dataRoot = join(TEST_ROOT, "meta-case");
		const sm = new SessionManager(
			[{ name: "t" } as never],
			"",
			undefined,
			makeFactory(),
			undefined,
			undefined,
			{ ...testConfig(), dataRoot },
		);
		await sm.create("s3", { userId: "u1", systemPrompt: "SYS", promptInfo: INFO });

		const key = toSessionKey("s3");
		const raw = readFileSync(join(dataRoot, key, "meta.json"), "utf8");
		const meta = JSON.parse(raw) as Record<string, unknown>;
		assert.equal(meta.promptVersion, INFO.promptVersion, "meta.json 应记 promptVersion");
		assert.equal(meta.promptHash, INFO.promptHash, "meta.json 应记 promptHash");
	});

	it("create 不带 promptInfo ⇒ meta.json 正常写且字段为 undefined（不崩）", async () => {
		const dataRoot = join(TEST_ROOT, "meta-none");
		const sm = new SessionManager(
			[{ name: "t" } as never],
			"",
			undefined,
			makeFactory(),
			undefined,
			undefined,
			{ ...testConfig(), dataRoot },
		);
		await sm.create("s4", { userId: "u1", systemPrompt: "SYS" });
		const key = toSessionKey("s4");
		const meta = JSON.parse(
			readFileSync(join(dataRoot, key, "meta.json"), "utf8") as string,
		) as Record<string, unknown>;
		// JSON.stringify 会丢掉 undefined ⇒ 键不存在。这正是「读时当未知」的设计前提。
		assert.ok(!("promptVersion" in meta), "未传时不应凭空造出版本号");
		// 关键：provider/model 必须在（磁盘 resume 的 fail-closed 依赖它们）
		assert.ok(typeof meta.provider === "string" && typeof meta.model === "string");
	});

	it("⭐ promptInfo 参与 turnContext 相等判定（漏了会让指标停在旧版）", async () => {
		const sm = new SessionManager(
			[{ name: "t" } as never],
			"",
			undefined,
			makeFactory(),
			undefined,
			undefined,
			testConfig(),
		);
		await sm.create("s5", { userId: "u1", systemPrompt: "SYS" });
		const changed = sm.setTurnContext("s5", { promptInfo: { ...INFO, promptHash: "different" } });
		assert.equal(changed, true, "仅 promptHash 变化也应判定 turnContext 变了");
	});

	it("存量 meta.json（无 prompt 字段）读回时当『未知』而非报错", async () => {
		// 判据：升级 pi-runtime 后，全部存量会话目录都没有这两个键。
		// 若读时判成「不匹配」⇒ 全部会话不可 resume ⇒ 那才是真正的故障。
		const dataRoot = join(TEST_ROOT, "legacy");
		const sm = new SessionManager(
			[{ name: "t" } as never],
			"",
			undefined,
			makeFactory(),
			undefined,
			undefined,
			{ ...testConfig(), dataRoot },
		);
		await sm.create("s6", { userId: "u1", systemPrompt: "SYS" });
		// 手工抹掉字段模拟存量目录
		const key = toSessionKey("s6");
		const metaPath = join(dataRoot, key, "meta.json");
		const meta = JSON.parse(readFileSync(metaPath, "utf8") as string) as Record<string, unknown>;
		delete meta.promptVersion;
		delete meta.promptHash;
		rmSync(metaPath);
		const { writeFileSync } = await import("node:fs");
		writeFileSync(metaPath, JSON.stringify(meta), "utf8");

		const sm2 = new SessionManager(
			[{ name: "t" } as never],
			"",
			undefined,
			makeFactory(),
			undefined,
			undefined,
			{ ...testConfig(), dataRoot },
		);
		// 带新版本再 create 一次：不应抛 ConflictError
		await assert.doesNotReject(
			() => sm2.create("s6", { userId: "u1", systemPrompt: "SYS", promptInfo: INFO }),
			"存量 meta 缺 prompt 字段时不得判成冲突",
		);
	});
});
