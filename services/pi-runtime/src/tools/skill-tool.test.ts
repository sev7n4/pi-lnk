/** load_skill 本地工具（D-η'）契约测试：空 entries 无工具、正文不截断、未知 name fail-soft。 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverSkills } from "../skills/loader.js";
import { createSkillTools } from "./skill-tool.js";
import { Metrics } from "../metrics.js";
import type { LnkpiTool } from "./types.js";

function setup(root: string, name: string, body: string) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: "测试技能"\n---\n\n${body}\n`, "utf8");
}

/** 对齐 harness execute 六参签名（同 ui-command.test.ts 的调用方式）。 */
async function run(tool: LnkpiTool, params: unknown) {
	return tool.execute!(
		"t1",
		params as never,
		() => {},
		{ sessionId: "s1" } as never,
		{} as never,
		undefined as never,
	);
}

test("empty entries yields no tools", () => {
	assert.deepEqual(createSkillTools([], new Metrics()), []);
});

test("load_skill returns full body without truncation", async () => {
	const root = mkdtempSync(join(tmpdir(), "skills-"));
	try {
		const bigBody = "很长的正文。".repeat(5000); // 30k 字符
		setup(root, "big-skill", bigBody);
		const [tool] = createSkillTools(discoverSkills(root), new Metrics());
		assert.equal(tool.name, "load_skill");
		assert.equal(tool.tier, "skill");
		const res = await run(tool, { name: "big-skill" });
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.body, bigBody);
		assert.deepEqual(res.details, { ok: true, body: bigBody });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("load_skill 观测：成功与未知分别按技能名打卡（Round2 W2② · P1-6 路由判据）", async () => {
	const root = mkdtempSync(join(tmpdir(), "skills-"));
	try {
		setup(root, "real-skill", "body");
		const metrics = new Metrics();
		const [tool] = createSkillTools(discoverSkills(root), metrics);
		await run(tool, { name: "real-skill" });
		await run(tool, { name: "no-such-skill" });
		const out = metrics.render(0, "test");
		assert.match(out, /pi_runtime_skill_loads_total\{skill="real-skill",outcome="ok"\} 1/);
		assert.match(out, /pi_runtime_skill_loads_total\{skill="no-such-skill",outcome="unknown"\} 1/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("load_skill returns error content for unknown name (no throw)", async () => {
	const root = mkdtempSync(join(tmpdir(), "skills-"));
	try {
		setup(root, "real-skill", "body");
		const [tool] = createSkillTools(discoverSkills(root), new Metrics());
		const res = await run(tool, { name: "no-such-skill" });
		const parsed = JSON.parse((res.content[0] as { text: string }).text);
		assert.equal(parsed.ok, false);
		assert.ok(parsed.error.includes("no-such-skill"));
		assert.deepEqual(res.details, { ok: false, error: "unknown skill: no-such-skill" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
