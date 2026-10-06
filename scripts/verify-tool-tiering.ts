#!/usr/bin/env npx tsx
/**
 * 工具分层一致性门禁（常驻集 ⇄ 资产点名）
 *
 * WHY THIS EXISTS
 * ---------------
 * `ALWAYS_ON_TOOL_NAMES` 的判定准绳是「**有没有会下发的资产按名字点名它**」
 * （AGENTS.md「改工具分层」节）。但这条准绳此前只存在于注释里，于是漂移了两个月
 * 都没人发现：`focus_nodes`（复数）被 `canvas_daily_ops` 第 19 条逐字点名，
 * 却在延迟集里 —— 判据当时只核了 `skills/*`（注释原文：「未被 skill 点名」），
 * **漏了 prompt 规则这一侧**。生产后果：模型读完规则直调，吃 vendor 硬编码的
 * `Tool focus_nodes is unavailable`，且无恢复路径（`drive/tools.ts:686` 只把
 * `activeToolNames` 传给 `prepareToolCall`）。
 *
 * 注释维护不住判据，必须机检。四个断言：
 *
 *   A1（红线）延迟集 ∩ 会下发的资产点名 = ∅
 *      「会下发」= COMPOSED_IDS 内的规则（每轮进 prompt） + skills/*.md（load_skill 后进）。
 *      不含 PROMPT_SPEC.md（规范文档，不参与组合，点名它模型看不见）。
 *   A2 ALWAYS_ON ⊆ 注册集 —— 名单里不得有已删除/拼错的名字（幽灵项）
 *   A3 注册集 ∩ ALWAYS_ON = ALWAYS_ON 的反向 —— 常驻工具必须真的注册（防注释与实现脱节）
 *   A4 回归锁：`focus_node` 与 `focus_nodes` 必须同时常驻
 *      两者只差一个字母、语义不同（单节点定位 / 批量定位），历史上被当成一个而错改。
 *
 * Exit codes:
 * - 0: 分层一致
 * - 1: 检出漂移（任一断言失败）
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const TOOLS_DIR = join(ROOT, "services/pi-runtime/src/tools");
const TIERING = join(TOOLS_DIR, "tiering.ts");
const LOADER = join(ROOT, "apps/server/src/agent/pi-runtime/prompt-registry.loader.ts");
const RULES_DIR = join(ROOT, "prompt-registry/rules");
const SKILLS_DIR = join(ROOT, "skills");

const errors: string[] = [];
const notes: string[] = [];
const fail = (m: string) => errors.push(m);

/* ---------- 1. 常驻集 ---------- */
const tiering = readFileSync(TIERING, "utf8");
const setStart = tiering.indexOf("ALWAYS_ON_TOOL_NAMES");
if (setStart < 0) {
	console.error("✗ tiering.ts 里找不到 ALWAYS_ON_TOOL_NAMES");
	process.exit(1);
}
const open = tiering.indexOf("new Set([", setStart);
if (open < 0) {
	console.error("✗ ALWAYS_ON_TOOL_NAMES 的 new Set([ 入口找不到");
	process.exit(1);
}
// 花括号深度计数找匹配括号（用独立变量存入口，勿复用循环下标——踩过：返回空串）
let depth = 0;
let close = -1;
for (let i = open + "new Set(".length; i < tiering.length; i++) {
	const ch = tiering[i];
	if (ch === "(" || ch === "[" || ch === "{") depth++;
	else if (ch === ")" || ch === "]" || ch === "}") {
		depth--;
		if (depth === 0) {
			close = i;
			break;
		}
	}
}
if (close < 0) {
	console.error("✗ ALWAYS_ON_TOOL_NAMES 的括号未闭合");
	process.exit(1);
}
const alwaysOn = new Set(
	[...tiering.slice(open, close).matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]),
);

/* ---------- 2. 注册集（源码里真实构造的工具） ---------- */
function walk(dir: string, exts: string[], out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, exts, out);
		else if (exts.some((e) => name.endsWith(e))) out.push(p);
	}
	return out;
}
const registered = new Set<string>();
for (const file of walk(TOOLS_DIR, [".ts"]).filter((f) => !f.endsWith(".test.ts"))) {
	const src = readFileSync(file, "utf8");
	for (const m of src.matchAll(/^\s*name:\s*"([a-z_0-9]+)"/gm)) registered.add(m[1]);
	// 工厂构造：runTool("run_image_generation", label, description, path)
	for (const m of src.matchAll(/runTool\(\s*"([a-z_0-9]+)"/g)) registered.add(m[1]);
}
// tool_search 是元工具，由 createLoadToolsTool 构造
registered.add("tool_search");

/* ---------- 3. 会下发的资产 ---------- */
const loader = readFileSync(LOADER, "utf8");
const idsBlock = loader.match(/COMPOSED_IDS\s*=\s*\[([\s\S]*?)\]/);
if (!idsBlock) {
	console.error("✗ 解析不了 COMPOSED_IDS");
	process.exit(1);
}
const composedIds = [...idsBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const ruleFiles = readdirSync(RULES_DIR)
	.filter((f) => f.endsWith(".md"))
	.map((f) => f.slice(0, -3));
const downRules = new Set(composedIds.filter((id) => ruleFiles.includes(id)));
const nonComposed = ruleFiles.filter((f) => !downRules.has(f));
if (nonComposed.length) notes.push(`非组合规则（不点名计分）：${nonComposed.join(", ")}`);

const skillFiles = walk(SKILLS_DIR, [".md"]);
const names = [...registered].sort();
const hit = (n: string, text: string) => new RegExp(`\\b${n}\\b`).test(text);

const byRule = new Map<string, string[]>();
for (const id of downRules) {
	const p = join(RULES_DIR, `${id}.md`);
	const txt = readFileSync(p, "utf8");
	for (const n of names) if (hit(n, txt)) (byRule.get(n) ?? byRule.set(n, []).get(n)!).push(`${id}.md`);
}
const bySkill = new Map<string, string[]>();
for (const file of skillFiles) {
	const txt = readFileSync(file, "utf8");
	const rel = file.slice(SKILLS_DIR.length + 1);
	for (const n of names) if (hit(n, txt)) (bySkill.get(n) ?? bySkill.set(n, []).get(n)!).push(rel);
}

/* ---------- 4. 断言 ---------- */
const deferred = names.filter((n) => !alwaysOn.has(n));

// A1（红线）
for (const n of deferred) {
	const where = [...(byRule.get(n) ?? []).map((f) => `规则 ${f}`), ...(bySkill.get(n) ?? []).map((f) => `skill ${f}`)];
	if (where.length) {
		fail(
			`A1 延迟集 ∩ 资产点名 ≠ ∅：\`${n}\` 在延迟集，却被 ${where.join(" / ")} 按名字点名。\n` +
				`     模型会直调 → 吃 vendor "Tool ${n} is unavailable" 且无恢复路径。\n` +
				`     修法二选一：把它移进 ALWAYS_ON_TOOL_NAMES，或从点名资产里去掉该名字。`,
		);
	}
}

// A2 幽灵项
for (const n of alwaysOn) {
	if (!registered.has(n)) fail(`A2 ALWAYS_ON 里有未注册的工具名 \`${n}\`（已删除或拼错？）。`);
}
// A3 常驻未注册（防御性，正常恒成立，因为 A2 已覆盖命名空间）
// A4 回归锁
for (const n of ["focus_node", "focus_nodes"]) {
	if (!alwaysOn.has(n)) fail(`A4 回归锁：\`${n}\` 必须常驻（规则/技能点名它，延迟即不可达）。`);
	if (!registered.has(n)) fail(`A4 回归锁：\`${n}\` 应存在于注册集。`);
}

/* ---------- 5. 报告 ---------- */
const zeroNamed = [...alwaysOn].filter((n) => !byRule.has(n) && !bySkill.has(n));
console.log(`解析：注册 ${registered.size} / 常驻 ${alwaysOn.size} / 延迟 ${deferred.length}`);
console.log(`下发规则 ${downRules.size} 条（COMPOSED_IDS），skill ${skillFiles.length} 份`);
console.log(`常驻里零资产点名（可下沉候选）：${zeroNamed.length ? zeroNamed.join(", ") : "无"}`);
for (const n of notes) console.log(`ℹ ${n}`);

if (errors.length) {
	console.error(`\n✗ 工具分层漂移检出 ${errors.length} 项：`);
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}
console.log("\n✓ 分层一致：延迟集无资产点名（延迟即不可达的风险为 0）");
