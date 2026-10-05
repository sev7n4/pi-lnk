#!/usr/bin/env tsx
/**
 * A/B 场景集结构校验（task-5评审 Important 5）。
 *
 * ⚠️ **不进 CI**（spec §8.2硬约束 2）。这是发版前手工跑的一次性校验，
 * 与场景集本身同属「人工闸」，不是测试框架。
 *
 *   用法：npx tsx scripts/verify-ab-scenarios.ts
 *
 * ── 为什么需要 (b) ──────────────────────────────────────────────
 * 最初的设想只有 (a)「anchor 在其 groups 下可达」。但 (a) 会**放绿**
 * `readonly-session-refuse`：该场景 groups=["core"] 下 `write_guard` 确实进 prompt，
 * (a) 通过 —— 而这恰恰是 8 个场景里**最跑不起来的那一个**
 * （生产 ruleGroups 硬编码三组，压根产不出 ["core"]）。
 * 检查绿灯、场景废掉，属于最坏的失效模式：**机检制造了它本该防止的假绿**。
 *
 * ⇒ (a) 与 (b) 是两条**独立**的失效模式，必须一起断言，缺一则另一条单独上线仍假绿：
 *   (a) anchor 在其 groups 下可达        —— 防「规则没进 prompt，场景空跑」
 *   (b) groups 是生产链路实际能产出的取值 —— 防「场景在生产不可达，跑不起来」
 */
import { resolve } from "node:path";
import { loadRegistry, resolveRegistryRoot } from "../apps/server/src/agent/pi-runtime/prompt-registry.loader.js";
import { PRODUCTION_RULE_GROUPS } from "../apps/server/src/agent/pi-runtime/rule-groups.js";
import { PROMPT_AB_SCENARIOS } from "../services/pi-runtime/src/evals/prompt-ab-scenarios.js";

const ROOT = resolve(import.meta.dirname ?? process.cwd(), "..");

/** anchor → 该规则的注入条件（复刻 loader.renderStatic 的过滤语义，只读不改）。 */
function isReachable(
	entry: { group?: string; unlessGroup?: string },
	groups: readonly string[],
): boolean {
	const coreOn = groups.includes("core");
	if (entry.group) {
		if (!groups.includes(entry.group)) return false;
	} else if (!coreOn) {
		return false;
	}
	if (entry.unlessGroup && groups.includes(entry.unlessGroup)) return false;
	return true;
}

/**
 * 已知例外：声明式场景里用了生产链路**当前产不出**的 groups。
 *
 * ⚠️ 实测结论比预期广：生产 ruleGroups 硬编码三组全开，而**任何**子集都产不出来。
 * 即8 个场景里有 6 个需要先改 `agent.service.ts` 的 ruleGroups 才能跑
 * （不是只有 readonly-session-refuse 一个）。
 *
 * 这些场景**仍然必须存在**：它们检验的正是「某组缺席时生效的负向守卫」
 * （`write_guard` 的 unlessGroup: writeTools、`no_gen_claim.nogen` 的 unlessGroup: genTools）。
 * 生产三组全开 ⇒ 这两条规则在生产**永不注入**⇒ 只有手动构造子集才能验它们。
 *
 * 这不是「校验失败」，也不是「默默放过」——它们被显式登记在此，
 * 跑手册的人必须先读到 runbook 对应小节才知道怎么跑。
 * 新增非生产场景时必须登记，否则 (b) 硬失败（防止例外登记簿无限膨胀而失去意义）。
 */
const KNOWN_UNREACHABLE_EXCEPTIONS: Record<string, string> = {
	"readonly-session-refuse":
		"需ruleGroups=['core']。测write_guard（unlessGroup: writeTools）——生产三组全开时它永不注入。",
	"multi-node-view": "需 ruleGroups=['core','writeTools']。测 canvas-view-card（group: writeTools）。",
	"single-node-no-view": "需 ruleGroups=['core','writeTools']。测 canvas-view-card 的负向边界。",
	"no-template-claim": "需 ruleGroups=['core','writeTools']。测 no-template（core 组即可，但需与生产同形便于对比）。",
	"cross-canvas-memory": "需 ruleGroups=['core','writeTools']。测 memory-scope-isolation（core 组即可）。",
	"chat-no-node": "需 ruleGroups=['core','writeTools']。测 media-tool-policy 的闲聊负向边界。",
};
/** 上面每条都需要切同一个开关，故统一给出改法，避免 6 份重复文案各自漂移。 */
const HOW_TO_SWITCH_GROUPS =
	`设 AGENT_RULE_GROUPS env（如 AGENT_RULE_GROUPS=core,writeTools；fail-closed，未知值拒绝启动），` +
	`见 docs/ops/prompt-ab-runbook.md「groups 怎么切」小节。仅限评测环境设置，生产发版不得携带。`;

const errors: string[] = [];
const warnings: string[] = [];

const snapshot = loadRegistry(resolveRegistryRoot());
const byAnchor = new Map(snapshot.entries.map((e) => [e.anchor!, e]));
const prod: { groups: readonly string[] } = { groups: PRODUCTION_RULE_GROUPS };

console.log(`生产 ruleGroups（import 自 rule-groups.ts 单一真值源）: [${prod.groups.join(", ")}]`);
console.log(`场景数: ${PROMPT_AB_SCENARIOS.length}｜ 规则数: ${snapshot.entries.length}\n`);

// ── (0) anchor 必须真实存在于 registry ──────────────────────────
const seenIds = new Set<string>();
for (const s of PROMPT_AB_SCENARIOS) {
	if (seenIds.has(s.id)) errors.push(`场景 id 重复: ${s.id}`);
	seenIds.add(s.id);
	for (const a of s.anchors) {
		if (!byAnchor.has(a)) errors.push(`${s.id}: anchor "${a}" 在 registry 中不存在`);
	}
	if (s.groups.length === 0) errors.push(`${s.id}: groups 为空 ⇒ 没有任何规则会进 prompt`);
}

// ── (a) anchor 在其 groups 下可达 ───────────────────────────────
console.log("(a) anchor 可达性：");
for (const s of PROMPT_AB_SCENARIOS) {
	const dead = s.anchors.filter((a) => {
		const e = byAnchor.get(a);
		return e ? !isReachable(e, s.groups) : false;
	});
	if (dead.length) {
		errors.push(
			`${s.id}: anchor 在 groups=[${s.groups.join(",")}] 下不可达 ⇒ 规则不进 prompt，场景空跑：` +
				dead.join(", "),
		);
		console.log(`  ✗ ${s.id} groups=[${s.groups.join(",")}] 不可达: ${dead.join(", ")}`);
	} else {
		console.log(`  ok ${s.id} groups=[${s.groups.join(",")}]`);
	}
}

// ── (b) groups 是生产链路实际能产出的取值 ──────────────────────
console.log("\n(b) 生产可达性：");
const prodKey = [...prod.groups].sort().join(",");
for (const s of PROMPT_AB_SCENARIOS) {
	const key = [...s.groups].sort().join(",");
	if (key === prodKey) {
		console.log(`  ok ${s.id} groups 与生产一致`);
		continue;
	}
	const note = KNOWN_UNREACHABLE_EXCEPTIONS[s.id];
	if (note) {
		warnings.push(`${s.id}: groups=[${s.groups.join(",")}] 非生产取值（已知例外）—— ${note} ${HOW_TO_SWITCH_GROUPS}`);
		console.log(`  ⚠ ${s.id} groups=[${s.groups.join(",")}] 非生产取值（已知例外）`);
	} else {
		// 未登记的偏离 = 硬失败。否则新增一个非生产场景就会静默「已知例外」，
		// 登记簿也就失去意义。
		errors.push(
			`${s.id}: groups=[${s.groups.join(",")}] 与生产 ruleGroups=[${prod.groups.join(",")}] 不一致，` +
				`且未登记为 KNOWN_UNREACHABLE_EXCEPTIONS ⇒ 生产链路产不出该场景。`,
		);
		console.log(`  ✗ ${s.id} groups=[${s.groups.join(",")}] 生产产不出且未登记例外`);
	}
}

// ── (c) 空跑防护：至少有一项可判据 ────────────────────────────
// 三种判据任一非空即可：expectTools（该调什么）/ forbidTools（不该调什么）/ manualJudge（该说什么）。
// ⚠️ `forbidTools` 也是判据——「道谢时不该建节点」这类负向边界场景正是靠它判定，
// 只看 expectTools 会把它误判成「无判据」。
console.log("\n(c) 空跑防护：");
for (const s of PROMPT_AB_SCENARIOS) {
	const hasCriteria =
		s.expectTools.length > 0 || (s.forbidTools?.length ?? 0) > 0 || !!s.manualJudge;
	if (!hasCriteria) {
		errors.push(
			`${s.id}: expectTools / forbidTools / manualJudge 全空 ⇒ 该场景不产生任何判据`,
		);
		console.log(`  ✗ ${s.id} 无任何判据`);
	} else {
		const parts = [
			s.expectTools.length ? `expect=${s.expectTools.length}` : "",
			s.forbidTools?.length ? `forbid=${s.forbidTools.length}` : "",
			s.manualJudge ? "manualJudge" : "",
		].filter(Boolean);
		console.log(`  ok ${s.id} (${parts.join(" ")})`);
	}
}

// ── 覆盖面：registry 里没有场景覆盖的 anchor ────────────────────
const covered = new Set(PROMPT_AB_SCENARIOS.flatMap((s) => [...s.anchors]));
const uncovered = snapshot.entries.map((e) => e.anchor!).filter((a) => !covered.has(a));
if (uncovered.length) warnings.push(`未被任何场景覆盖的 anchor: ${uncovered.join(", ")}`);

console.log("");
for (const w of warnings) console.log(`⚠ warn: ${w}`);
if (errors.length) {
	console.error(`\n✗ verify-ab-scenarios: ${errors.length} 项失败`);
	for (const e of errors) console.error(`  - ${e}`);
	process.exit(1);
}
console.log(`✔ verify-ab-scenarios: ok（${PROMPT_AB_SCENARIOS.length} 场景，(a)(b)(c) 全过，${warnings.length} 警告）`);
