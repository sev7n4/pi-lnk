import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "./session-manager.js";
import type { RuntimeConfig } from "./runtime-config.js";
import type { Skill } from "@earendil-works/pi-agent-core";

/**
 * M0 W3（规格 v2 §7.3）：forceSkills 显式调用收敛到上游 `lane.skill()`。
 *
 * - 命中：`lane.skill(name, instructions)` 被调（instructions = extras 的上游
 *   `formatSkillInvocation` 块 + 用户原文），`lane.prompt` 不被调。
 * - 未知名：`InvalidInputError`（路由 400）**fail-closed**，取代旧 fail-soft 文案
 *   （U-7/U-8：未命中即 UnknownSkill 硬拒零副作用）。
 * - 空 forceSkills：`lane.prompt` 原文直通（逐字节现状）。
 * - 带图：`lane.skill` 无 images 参数 ⇒ 回落 `lane.prompt`，正文仍由上游 formatter 组装。
 */

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-forced-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let cfgSeq = 0;
function testConfig(): RuntimeConfig {
	return {
		dataRoot: join(TEST_ROOT, `fs${++cfgSeq}`),
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

const SKILLS: Skill[] = [
	{ name: "alpha", description: "A", content: "ALPHA BODY", filePath: "/app/skills/alpha/SKILL.md" },
	{ name: "beta", description: "B", content: "BETA BODY", filePath: "/app/skills/beta/SKILL.md" },
];

interface Captured {
	skill?: { name: string; instructions: string };
	prompt?: { text: string; images?: unknown };
}

async function makeManager(key: string, resources: Skill[] = SKILLS) {
	const captured: Captured = {};
	const factory = async () =>
		({
			harness: {
				events: { on: () => () => {} },
				getResources: async () => ({ skills: resources }),
				lane: async () => ({
					skill: async (name: string, instructions: string) => {
						captured.skill = { name, instructions };
						return { ok: true, value: undefined };
					},
					prompt: async (text: string, images?: unknown) => {
						captured.prompt = { text, images };
						return { ok: true, value: undefined };
					},
					dispose: async () => {},
				}),
				close: async () => {},
			},
		}) as never;
	const sm = new SessionManager([], "", undefined, factory, undefined, undefined, testConfig(), undefined, undefined);
	await sm.create(key, { userId: "u1" });
	return { sm, captured };
}

test("命中：走 lane.skill，instructions 含用户原文，prompt 通道未被调", async () => {
	const { sm, captured } = await makeManager("s1:t1");
	await sm.prompt("s1:t1", "帮我做白底图", "main", { forceSkills: ["alpha"] });
	assert.ok(captured.skill, "必须走 lane.skill");
	assert.equal(captured.skill!.name, "alpha");
	// 首个技能的正文块由 vendor lane.skill 内部注入（formatSkillInvocation(skill, instructions)），
	// 宿主只传 additionalInstructions —— 里面应含用户原文，且不得再出现旧自研装饰格式。
	assert.ok(captured.skill!.instructions.includes("帮我做白底图"));
	assert.ok(!captured.skill!.instructions.includes("[用户显式调用 skill:"), "旧自研装饰必须消失");
	assert.equal(captured.prompt, undefined);
});

test("多技能：首个走 lane.skill，其余以 formatSkillInvocation 块并入 instructions", async () => {
	const { sm, captured } = await makeManager("s2:t1");
	await sm.prompt("s2:t1", "做图", "main", { forceSkills: ["alpha", "beta"] });
	assert.ok(captured.skill);
	assert.equal(captured.skill!.name, "alpha");
	assert.match(captured.skill!.instructions, /<skill name="beta" location="\/app\/skills\/beta\/SKILL.md">/);
	assert.ok(captured.skill!.instructions.includes("BETA BODY"));
	assert.ok(captured.skill!.instructions.includes("做图"));
});

test("未知名：InvalidInputError（fail-closed），零副作用", async () => {
	const { sm, captured } = await makeManager("s3:t1");
	await assert.rejects(
		() => sm.prompt("s3:t1", "做图", "main", { forceSkills: ["ghost-skill"] }),
		/unknown skill: ghost-skill/,
	);
	assert.equal(captured.skill, undefined);
	assert.equal(captured.prompt, undefined, "不得往对话注入任何消息");
});

test("空 forceSkills：原文走 lane.prompt（逐字节现状）", async () => {
	const { sm, captured } = await makeManager("s4:t1");
	await sm.prompt("s4:t1", "原始请求", "main", { forceSkills: [] });
	// prompting 复位走 promise 链 .finally（微任务落地），紧接的第二个 prompt 需等它结算。
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(captured.prompt);
	assert.equal(captured.prompt!.text, "原始请求");
	assert.equal(captured.skill, undefined);
	await sm.prompt("s4:t1", "原始请求2", "main", {});
	assert.equal(captured.prompt!.text, "原始请求2");
});

test("带图 + forceSkills：回落 lane.prompt（上游 formatter 组装正文），images 透传", async () => {
	const { sm, captured } = await makeManager("s5:t1");
	const images = [{ name: "a.png", mimeType: "image/png", data: "QUJD" }];
	await sm.prompt("s5:t1", "看图做图", "main", { forceSkills: ["alpha"], images });
	assert.ok(captured.prompt, "带图必须走 prompt 通道");
	assert.match(captured.prompt!.text, /<skill name="alpha" location="\/app\/skills\/alpha\/SKILL.md">/);
	assert.ok(captured.prompt!.text.includes("看图做图"));
	assert.deepEqual(captured.prompt!.images, [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
});
