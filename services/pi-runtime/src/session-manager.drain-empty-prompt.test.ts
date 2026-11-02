/**
 * 回归测试：idle 状态下 followUp / 回合外生成终态通报必须被 drain 真正送达用户。
 *
 * 生产实证（2026-11-02 鲸鱼用例）：`drainQueued` 用 `lane.prompt("")` 空 prompt 兜底开一轮，
 * 被 harness 验收门禁（lane.ts:614-626）以「Acceptance must append at least one message」拒掉，
 * 导致 `[系统通报·回合外生成终态]` 永远睡在 vendor inbox 里、用户收不到完成通知。
 *
 * 本文件在真 harness（faux 模型）下复现该流失路径，并锁定修复后：
 * 1. followUp 入队后 idle drain 必须消费它（snapshot.queues 清空）；
 * 2. 必须产出自带 assistant 消息（模型据此向用户简报）；
 * 3. 通知文案必须进入 transcript（被模型看到，而非空转）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { SessionManager } from "./session-manager.js";
import { Metrics } from "./metrics.js";
import type { RuntimeConfig } from "./runtime-config.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-drain-real-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `dr${++cfgSeq}`),
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		toolTiering: false,
		compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	};
}

async function makeRealHarnessManager(metrics: Metrics, key: string) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const modelFactory = () => ({ models, model: faux.getModel(), providerId: faux.provider.id });
	const sm = new SessionManager(
		[],
		"",
		modelFactory,
		undefined,
		undefined,
		undefined,
		testConfig(),
		undefined,
		metrics,
	);
	await sm.create(key, { userId: "u1" });
	return { sm, faux };
}

async function waitFor(
	predicate: (snapRef: { current?: ReturnType<SessionManager["snapshot"]> }) => Promise<boolean>,
	what: string,
	timeoutMs = 20_000,
): Promise<ReturnType<SessionManager["snapshot"]>> {
	const deadline = Date.now() + timeoutMs;
	const ref: { current?: ReturnType<SessionManager["snapshot"]> } = {};
	let last = "";
	while (Date.now() < deadline) {
		let ok = false;
		try {
			ok = await predicate(ref);
		} catch {
			ok = false;
		}
		if (ok && ref.current) return ref.current;
		const snap = ref.current;
		if (snap) {
			last =
				JSON.stringify(
					(snap.transcriptTail ?? []).map((m: { role?: string }) => m.role),
				) +
				" queues=" +
				((snap.queues ?? []).length ?? "?");
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	console.error(`[DIAG] 超时于 ${what}; last snap=`, last);
	assert.fail(`等待超时：${what}`);
}

const NOTICE =
	"[系统通报 · 回合外生成终态] 画布节点 n1 的生成已完成，产物 url：http://x/y.png。" +
	"这条生成是在本回合之外落定终态的：请先用画布工具核实节点当前状态，再向用户一句话简报结果。";

test("idle followUp → drainQueued 必须消费 followUp 并驱动一轮把通知送达用户", async () => {
	const metrics = new Metrics();
	const { sm, faux } = await makeRealHarnessManager(metrics, "sess-drain");
	faux.setResponses([fauxAssistantMessage("已收到系统通报，节点生成完成，已向你简报。", { stopReason: "stop" })]);

	await sm.followUp("sess-drain", NOTICE);

	const snap = await waitFor(async (ref) => {
		ref.current = await sm.snapshot("sess-drain");
		const s = ref.current;
		const hasAssistant = (s?.transcriptTail ?? []).some((m) => m.role === "assistant");
		const noQueues = (s?.queues ?? []).length === 0;
		return hasAssistant && noQueues;
	}, "idle followUp 被 drain 消费并产出 assistant 消息");

	const transcriptText = (snap.transcriptTail ?? []).map((m) => m.text ?? "").join("\n");
	assert.ok(
		transcriptText.includes("系统通报"),
		"followUp 文案未进入 transcript（drain 空 prompt 被拒，通知未落地）",
	);
});

test("idle notifyGenerationTerminal → 完成通知必须送达用户", async () => {
	const metrics = new Metrics();
	const { sm, faux } = await makeRealHarnessManager(metrics, "sess-notify");
	faux.setResponses([fauxAssistantMessage("已收到系统通报，生成完成。", { stopReason: "stop" })]);

	await sm.notifyGenerationTerminal("sess-notify", {
		nodeId: "n1",
		kind: "图像",
		status: "completed",
		url: "http://x/y.png",
	});

	const snap = await waitFor(async (ref) => {
		ref.current = await sm.snapshot("sess-notify");
		const s = ref.current;
		const hasAssistant = (s?.transcriptTail ?? []).some((m) => m.role === "assistant");
		const noQueues = (s?.queues ?? []).length === 0;
		return hasAssistant && noQueues;
	}, "notifyGenerationTerminal 通知被 drain 消费并产出 assistant 消息");

	const transcriptText = (snap.transcriptTail ?? []).map((m) => m.text ?? "").join("\n");
	assert.ok(
		transcriptText.includes("系统通报") || transcriptText.includes("生成完成"),
		"notifyGenerationTerminal 通知未进入 transcript（drain 空 prompt 被拒）",
	);
});
