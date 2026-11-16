import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, BusyError, NotFoundError, toSessionKey } from "./session-manager.js";
import { SkillRegistry } from "./skills/registry.js";
import { Metrics } from "./metrics.js";
import { readUserSkills } from "./skills/inject.js";
import type { RuntimeConfig } from "./runtime-config.js";
import type { Skill } from "@earendil-works/pi-agent-core";

/**
 * M1-2（计划 §4 判据映射 / 规格 v2 §5.3-§7.2）：Nest→runtime 用户技能通道行为级。
 *
 * 判据落点：
 * - A2 前置：create 注入含传入 Skill 且 content 逐字；
 * - 契约 2：传入覆盖同名内置（用户显式安装优先）；
 * - U-11：磁盘 resume 不带 payload ⇒ sidecar 恢复（resources 不落盘 ⇒ 宿主两层持久化）；
 * - A11 前置：setUserResources 全量换集——新名入、旧名出；
 * - busy/compacting 拒绝（与 prompt 同口径）+ metrics 打点。
 */

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-runtime-ures-"));
after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

let seq = 0;
function testConfig(dataRoot: string): RuntimeConfig {
	return {
		dataRoot,
		sessionTtlMs: 10 ** 9,
		sweepIntervalMs: 10 ** 9,
		sessionsMaxBytes: 10 ** 12,
		sessionsMaxCount: 1000,
		toolTiering: false,
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
	};
}

/** 单个内置技能的临时目录（SkillRegistry 输入）。 */
function makeSkillDir(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-runtime-ures-skills-"));
	mkdirSync(join(root, "demo-skill"));
	writeFileSync(
		join(root, "demo-skill", "SKILL.md"),
		"---\nname: demo-skill\ndescription: 内置演示技能\n---\nBUILTIN BODY demo\n",
	);
	return root;
}

const USER_SKILL = {
	name: "user-html",
	description: "用户装的 HTML 技能",
	content: "USER BODY 逐字 @@MARK@@",
};

interface Capture {
	lastConfig?: unknown;
	resources: Skill[];
	setCalls: Skill[][];
}

/** fake harness：getResources/setResources 走同一内存变量（真实语义：换集后立刻可读）。 */
function makeCaptureFactory(capture: Capture) {
	return (async (cfg: unknown) => {
		capture.lastConfig = cfg;
		let current: Skill[] =
			(cfg as { resources?: { skills?: Skill[] } }).resources?.skills ?? [];
		capture.resources = current;
		const harness = {
			events: { on: () => () => {} },
			lane: async () => ({ prompt: async () => ({ ok: true }) }),
			close: async () => {},
			getResources: async () => ({ skills: current }),
			setResources: async (res: { skills?: Skill[] }) => {
				current = res.skills ?? [];
				capture.setCalls.push(current);
			},
		};
		return { harness };
	}) as never;
}

describe("M1-2 用户技能通道（契约 1/2/3 + U-11）", () => {
	it("create 带 resources.skills：注入 = 内置 ∪ 传入，content 逐字（A2 前置）", async () => {
		const skillDir = makeSkillDir();
		const root = join(TEST_ROOT, `d${++seq}`);
		const capture: Capture = { resources: [], setCalls: [] };
		const sm = new SessionManager(
			[],
			"",
			undefined,
			makeCaptureFactory(capture),
			undefined,
			new SkillRegistry(skillDir, new Metrics()),
			testConfig(root),
		);
		await sm.create("s1", { resources: { skills: [USER_SKILL] } });
		const names = capture.resources.map((s) => s.name);
		assert.deepEqual(names.sort(), ["demo-skill", "user-html"]);
		const user = capture.resources.find((s) => s.name === "user-html");
		assert.ok(user);
		assert.equal(user.content, "USER BODY 逐字 @@MARK@@"); // 逐字透传，不 trim
		assert.equal(user.filePath, "<virtual>/user-html/SKILL.md"); // 缺省虚拟路径
		// sidecar 落盘（U-11 恢复源）
		assert.deepEqual(await readUserSkills(join(root, toSessionKey("s1"))), [USER_SKILL]);
	});

	it("同名覆盖：传入覆盖内置 demo-skill（用户显式安装优先，契约 2）", async () => {
		const skillDir = makeSkillDir();
		const capture: Capture = { resources: [], setCalls: [] };
		const sm = new SessionManager(
			[],
			"",
			undefined,
			makeCaptureFactory(capture),
			undefined,
			new SkillRegistry(skillDir, new Metrics()),
			testConfig(join(TEST_ROOT, `d${++seq}`)),
		);
		await sm.create("s1", {
			resources: { skills: [{ ...USER_SKILL, name: "demo-skill", content: "用户版覆盖内置" }] },
		});
		const demo = capture.resources.find((s) => s.name === "demo-skill");
		assert.ok(demo);
		assert.equal(demo.content, "用户版覆盖内置");
		assert.equal(capture.resources.length, 1); // 覆盖不追加
	});

	it("U-11：磁盘 resume 不带 payload ⇒ sidecar 恢复用户技能集", async () => {
		const skillDir = makeSkillDir();
		const root = join(TEST_ROOT, `d${++seq}`);
		const registry = new SkillRegistry(skillDir, new Metrics());
		const capture1: Capture = { resources: [], setCalls: [] };
		const sm1 = new SessionManager(
			[], "", undefined, makeCaptureFactory(capture1), undefined, registry, testConfig(root),
		);
		await sm1.create("s1", { resources: { skills: [USER_SKILL] } });
		// 新 manager（内存为空）同名会话磁盘恢复：create 不带 resources
		const capture2: Capture = { resources: [], setCalls: [] };
		const sm2 = new SessionManager(
			[], "", undefined, makeCaptureFactory(capture2), undefined, registry, testConfig(root),
		);
		await sm2.create("s1", {});
		const user = capture2.resources.find((s) => s.name === "user-html");
		assert.ok(user, "resume 后 getResources 必须含用户技能（U-11 回归）");
		assert.equal(user.content, "USER BODY 逐字 @@MARK@@");
	});

	it("U-11 负例：无 resources 创建 ⇒ 仅内置（M0 行为不变）", async () => {
		const skillDir = makeSkillDir();
		const capture: Capture = { resources: [], setCalls: [] };
		const sm = new SessionManager(
			[], "", undefined, makeCaptureFactory(capture), undefined,
			new SkillRegistry(skillDir, new Metrics()), testConfig(join(TEST_ROOT, `d${++seq}`)),
		);
		await sm.create("s1", {});
		assert.deepEqual(capture.resources.map((s) => s.name), ["demo-skill"]);
	});

	it("setUserResources 全量换集：新名入、旧名出（A11 前置）+ sidecar 更新", async () => {
		const skillDir = makeSkillDir();
		const root = join(TEST_ROOT, `d${++seq}`);
		const metrics = new Metrics();
		const capture: Capture = { resources: [], setCalls: [] };
		const sm = new SessionManager(
			[], "", undefined, makeCaptureFactory(capture), undefined,
			new SkillRegistry(skillDir, new Metrics()), testConfig(root), undefined, metrics,
		);
		await sm.create("s1", { resources: { skills: [USER_SKILL] } });
		const result = await sm.setUserResources("s1", [
			{ name: "user-audio", description: "换集后的新技能", content: "NEW BODY" },
		]);
		assert.deepEqual(result, { applied: 1 });
		assert.equal(capture.setCalls.length, 1);
		const names = capture.setCalls[0].map((s) => s.name);
		assert.deepEqual(names.sort(), ["demo-skill", "user-audio"]);
		assert.ok(!names.includes("user-html"), "全量换集后旧名必须消失（A11 前置）");
		assert.deepEqual(await readUserSkills(join(root, toSessionKey("s1"))), [
			{ name: "user-audio", description: "换集后的新技能", content: "NEW BODY" },
		]);
		assert.ok(metrics.render(0, "test").includes('pi_runtime_user_skills_swap_total{outcome="ok"} 1'));
	});

	it("setUserResources 显式空集：清空用户技能（保留内置）", async () => {
		const capture: Capture = { resources: [], setCalls: [] };
		const sm = new SessionManager(
			[], "", undefined, makeCaptureFactory(capture), undefined, undefined,
			testConfig(join(TEST_ROOT, `d${++seq}`)),
		);
		await sm.create("s1", { resources: { skills: [USER_SKILL] } });
		await sm.setUserResources("s1", []);
		assert.deepEqual(capture.setCalls[0], []);
	});

	it("setUserResources busy：prompting 中拒绝 BusyError（与 prompt 同口径）+ metrics busy", async () => {
		const capture: Capture = { resources: [], setCalls: [] };
		const metrics = new Metrics();
		// lane.prompt 永不返回 ⇒ prompting 恒真
		const hangFactory = (async () => ({
			harness: {
				events: { on: () => () => {} },
				lane: async () => ({ prompt: () => new Promise<never>(() => {}) }),
				close: async () => {},
				getResources: async () => ({ skills: [] }),
				setResources: async (res: { skills?: Skill[] }) => {
					capture.setCalls.push(res.skills ?? []);
				},
			},
		})) as never;
		const sm = new SessionManager(
			[], "", undefined, hangFactory, undefined, undefined,
			testConfig(join(TEST_ROOT, `d${++seq}`)), undefined, metrics,
		);
		await sm.create("s1", {});
		const pending = sm.prompt("s1", "hang");
		await new Promise((r) => setTimeout(r, 30)); // 让 prompting 置位
		await assert.rejects(() => sm.setUserResources("s1", []), BusyError);
		assert.ok(metrics.render(0, "test").includes('pi_runtime_user_skills_swap_total{outcome="busy"} 1'));
		assert.equal(capture.setCalls.length, 0); // busy 时绝不触碰 harness
		// 收尾：解除挂起态避免泄漏
		const entry = (
			sm as unknown as { sessions: Map<string, { prompting: boolean; compacting: boolean }> }
		).sessions.get(toSessionKey("s1"));
		if (entry) {
			entry.prompting = false;
			entry.compacting = false;
		}
		await pending.catch(() => {});
	});

	it("setUserResources 会话不存在 → NotFoundError", async () => {
		const sm = new SessionManager(
			[], "", undefined, makeCaptureFactory({ resources: [], setCalls: [] }), undefined,
			undefined, testConfig(join(TEST_ROOT, `d${++seq}`)),
		);
		await assert.rejects(() => sm.setUserResources("nope", []), NotFoundError);
	});
});
