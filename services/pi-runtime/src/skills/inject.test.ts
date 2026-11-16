import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mergeSkillResources,
	parseIncomingResources,
	readUserSkills,
	writeUserSkills,
	MAX_SKILL_CONTENT_BYTES,
} from "./inject.js";
import type { Skill } from "@earendil-works/pi-agent-core";

function builtin(name: string, content = `builtin-${name}`): Skill {
	return { name, description: `内置 ${name}`, content, filePath: `/skills/${name}/SKILL.md` };
}

function incoming(name: string, over: Partial<{ content: string; description: string }> = {}) {
	return {
		name,
		description: over.description ?? `用户装 ${name}`,
		content: over.content ?? `user-body-${name}`,
	};
}

describe("parseIncomingResources（契约 1：畸形 fail-closed 400）", () => {
	it("undefined/null/非对象 → error（调用方映 400）", () => {
		assert.equal(parseIncomingResources(undefined).ok, false);
		assert.equal(parseIncomingResources(null).ok, false);
		assert.equal(parseIncomingResources("x").ok, false);
		assert.equal(parseIncomingResources([]).ok, false);
	});
	it("resources 缺 skills 键 → 空集合法（显式清空语义）", () => {
		const r = parseIncomingResources({});
		assert.ok(r.ok);
		assert.deepEqual(r.ok ? r.skills : [], []);
	});
	it("skills: [] 空集合法（M0 行为不变）", () => {
		const r = parseIncomingResources({ skills: [] });
		assert.ok(r.ok);
	});
	it("缺 name / description / content 逐项拒绝", () => {
		assert.equal(parseIncomingResources({ skills: [{ description: "d", content: "c" }] }).ok, false);
		assert.equal(parseIncomingResources({ skills: [{ name: "a", content: "c" }] }).ok, false);
		assert.equal(parseIncomingResources({ skills: [{ name: "a", description: "d" }] }).ok, false);
	});
	it("content 空串拒绝；超 64KB 拒绝（错误含上限值）", () => {
		assert.equal(parseIncomingResources({ skills: [incoming("a", { content: "" })] }).ok, false);
		const big = "x".repeat(MAX_SKILL_CONTENT_BYTES + 1);
		const r = parseIncomingResources({ skills: [incoming("a", { content: big })] });
		assert.equal(r.ok, false);
		assert.ok(!r.ok && r.error.includes("体积上限"));
	});
	it("重复技能名拒绝（去重是 Nest 责任，runtime fail-closed）", () => {
		assert.equal(parseIncomingResources({ skills: [incoming("a"), incoming("a")] }).ok, false);
	});
	it("超条数上限拒绝", () => {
		const many = Array.from({ length: 25 }, (_, i) => incoming(`s${i}`));
		assert.equal(parseIncomingResources({ skills: many }).ok, false);
	});
	it("disableModelInvocation / filePath 类型错误拒绝；合法布尔透传", () => {
		assert.equal(
			parseIncomingResources({ skills: [{ ...incoming("a"), disableModelInvocation: "yes" }] }).ok,
			false,
		);
		assert.equal(parseIncomingResources({ skills: [{ ...incoming("a"), filePath: 3 }] }).ok, false);
		const r = parseIncomingResources({ skills: [{ ...incoming("a"), disableModelInvocation: true }] });
		assert.ok(r.ok);
		assert.equal(r.ok ? r.skills[0].disableModelInvocation : undefined, true);
	});
});

describe("mergeSkillResources（契约 2：传入覆盖同名内置，新名追加）", () => {
	it("无传入 → 内置原样（M0 逐字节不变）", () => {
		const b = [builtin("a"), builtin("b")];
		assert.deepEqual(mergeSkillResources(b, []), b);
	});
	it("同名覆盖：用户 content 逐字替换，索引位置保持内置行位置（A2 前置）", () => {
		const b = [builtin("a"), builtin("demo"), builtin("c")];
		const merged = mergeSkillResources(b, [incoming("demo", { content: "USER BODY 逐字" })]);
		assert.equal(merged.length, 3);
		assert.equal(merged[0].name, "a");
		assert.equal(merged[1].name, "demo");
		assert.equal(merged[1].content, "USER BODY 逐字");
		assert.equal(merged[2].name, "c");
	});
	it("新名追加尾部；filePath 缺省补虚拟路径", () => {
		const merged = mergeSkillResources([builtin("a")], [incoming("u1")]);
		assert.equal(merged.length, 2);
		assert.equal(merged[1].name, "u1");
		assert.equal(merged[1].filePath, "<virtual>/u1/SKILL.md");
	});
	it("disableModelInvocation 透传（上游原义）", () => {
		const merged = mergeSkillResources([], [
			{ ...incoming("u1"), disableModelInvocation: true } as never,
		]);
		assert.equal(merged[0].disableModelInvocation, true);
		const plain = mergeSkillResources([], [incoming("u2")]);
		assert.equal(plain[0].disableModelInvocation, undefined);
	});
});

describe("user-skills.json sidecar（U-11：宿主持久化 + resume 重注入）", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-runtime-inject-test-"));
	it("write → read 往返逐字一致；content 不被 trim", async () => {
		const skills = [incoming("keep", { content: "  正文含首尾空格 \n" })];
		await writeUserSkills(dir, skills);
		const back = await readUserSkills(dir);
		assert.equal(back[0].content, "  正文含首尾空格 \n");
		// 落盘 JSON 可直接回读
		const raw = JSON.parse(readFileSync(join(dir, "user-skills.json"), "utf8")) as unknown[];
		assert.equal((raw[0] as { name: string }).name, "keep");
	});
	it("文件不存在 / 半截写入 / 非法 JSON → 空集（resume 不失败）", async () => {
		assert.deepEqual(await readUserSkills(join(dir, "nope-dir")), []);
		writeFileSync(join(dir, "user-skills.json"), '{"skills":[{"na');
		assert.deepEqual(await readUserSkills(dir), []);
	});
	it("被篡改成非法形状（重复名）→ 空集回落", async () => {
		writeFileSync(
			join(dir, "user-skills.json"),
			JSON.stringify([incoming("x"), incoming("x")]),
		);
		assert.deepEqual(await readUserSkills(dir), []);
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
});
