/**
 * 规则地图生成器（spec §6.3）。
 *
 * 为什么必须生成而非手写：手写索引必然与磁盘脱节——这与「编号引用会静默断链」同源。
 *
 * 用法：
 *   npx tsx scripts/gen-prompt-spec-map.ts          # 打印到 stdout
 *   npx tsx scripts/gen-prompt-spec-map.ts --check  # 校验 PROMPT_SPEC.md 里的片段是否最新（CI 用）
 *   npx tsx scripts/gen-prompt-spec-map.ts --write  # 就地替换 PROMPT_SPEC.md 的 §3 片段
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	loadRegistry,
	renderStatic,
	resolveRegistryRoot,
	STATIC_BUDGET_CHARS,
	STATIC_BUDGET_WARN_CHARS,
	summarize,
	type RuleMeta,
} from "../apps/server/src/agent/pi-runtime/prompt-registry.loader";

const BEGIN = "<!-- BEGIN:rule-map -->";
const END = "<!-- END:rule-map -->";
// §5 预算表：与 §3 规则地图同源思路——**生成而非手写**。
// 动机：该表曾手工维护、无任何机检，因此漂移过两次（#218/#231 改规则正文均未同步本表），
// 读者按过期余量（"只剩 6 字符"）做决策 ⇒ 改为与 L6 判据同一算法生成。
const BEGIN_BUDGET = "<!-- BEGIN:budget-table -->";
const END_BUDGET = "<!-- END:budget-table -->";

export type { RuleMeta };

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
	const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
	if (!m) return { fields: {}, body: raw };
	const fields: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const kv = line.match(/^(\w+):\s*(.*)$/);
		if (kv) fields[kv[1]] = kv[2].trim();
	}
	return { fields, body: raw.slice(m[0].length) };
}

function readRules(): RuleMeta[] {
	const root = resolveRegistryRoot();
	const out: RuleMeta[] = [];
	for (const file of readdirSync(join(root, "rules")).filter((f) => f.endsWith(".md")).sort()) {
		const { fields, body } = parseFrontmatter(readFileSync(join(root, "rules", file), "utf8"));
		const first = summarize(body);
		out.push({
			id: fields.id ?? file.replace(/\.md$/, ""),
			title: fields.title ?? "", order: Number(fields.order ?? 0),
			group: fields.group, unlessGroup: fields.unlessGroup,
			anchor: fields.anchor ?? "", firstSentence: first,
		});
	}
	return out.sort((a, b) => a.order - b.order);
}

export function renderRuleMap(rules: readonly RuleMeta[]): string {
	const rows = rules.map((r) => {
		const scope = r.group ?? "core";
		const excl = r.unlessGroup ? `（除非 ${r.unlessGroup}）` : "";
		return `| ${r.order} | \`${r.anchor}\` | ${r.title} | ${scope}${excl} | ${r.firstSentence} |`;
	});
	return [
		"| order | 语义 id | 标题 | 生效范围 | 管什么 |",
		"|---|---|---|---|---|",
		...rows,
	].join("\n");
}

/**
 * §5 预算表（生成式）。⚠️ **必须与 loader 的 L6 判据同源同一算法**：
 * 用 `renderStatic(磁盘 registry, 同一组合)` 取长度，而不是 `renderStaticFallback`（fallback 常量），
 * 也不用任何写死的字符数——否则"生成式"只是把手工漂移换成算法漂移。
 * 组合取 loader `BUDGET_COMBOS` 里最紧的那一组（三组全开）。
 */
export function renderBudget(): string {
	const snap = loadRegistry(resolveRegistryRoot());
	const n = renderStatic(snap, ["core", "writeTools", "genTools"]).length;
	const margin = STATIC_BUDGET_CHARS - n;
	const state =
		n > STATIC_BUDGET_CHARS ? "**超硬线**" : n >= STATIC_BUDGET_WARN_CHARS ? "（已过预警线，硬线内）" : "（预警线内）";
	return [
		"| 项 | 值 |",
		"|---|---|",
		`| 硬线 \`STATIC_BUDGET_CHARS\` | ${STATIC_BUDGET_CHARS} |`,
		`| 预警线 \`STATIC_BUDGET_WARN_CHARS\` | ${STATIC_BUDGET_WARN_CHARS}（= ${STATIC_BUDGET_CHARS} × 0.85） |`,
		`| 全组合当前实测 | **${n}**${state} |`,
		`| **余量** | **${margin} 字符**（硬线 ${STATIC_BUDGET_CHARS} − 实测 ${n}） |`,
	].join("\n");
}

function main(): void {
	const specPath = join(dirname(fileURLToPath(import.meta.url)), "..", "prompt-registry", "PROMPT_SPEC.md");
	const mode = process.argv[2];

	// 两个生成块：§3 规则地图 + §5 预算表。--check/--write 共用同一份定义，避免两处漂移。
	const blocks = (): Array<{ name: string; begin: string; end: string; body: string }> => [
		{ name: "rule-map", begin: BEGIN, end: END, body: renderRuleMap(readRules()) },
		{ name: "budget-table", begin: BEGIN_BUDGET, end: END_BUDGET, body: renderBudget() },
	];

	if (mode === "--check") {
		const spec = readFileSync(specPath, "utf8");
		for (const b of blocks()) {
			// ⚠️ END 前的 \n 是可选的：PROMPT_SPEC.md 的标记块在首次 --write 之前是**空的**，
			// 若强制要求 `\nEND`，空块永远匹配不上 ⇒ --write 静默 no-op（还打印 written），
			// --check 紧接着报「缺标记块」，看起来像 CI 配置错而不是判据错。
			const m = spec.match(new RegExp(`${b.begin}\\n([\\s\\S]*?)\\n?${b.end}`));
			if (!m) { console.error(`gen-prompt-spec-map: PROMPT_SPEC.md 缺 ${b.name} 标记块`); process.exit(1); }
			if ((m[1] ?? "").trim() !== b.body.trim()) {
				console.error(`gen-prompt-spec-map: ${b.name} 与磁盘不一致，请跑 --write`); process.exit(1);
			}
		}
		console.log("gen-prompt-spec-map: ok");
		return;
	}
	if (mode === "--write") {
		const spec = readFileSync(specPath, "utf8");
		let next = spec;
		for (const b of blocks()) {
			const re = new RegExp(`(${b.begin}\\n)[\\s\\S]*?\\n?(${b.end})`);
			if (!re.test(next)) { console.error(`gen-prompt-spec-map: PROMPT_SPEC.md 缺 ${b.name} 标记块`); process.exit(1); }
			// ⚠️ `\n?` 必须在捕获组**外**：它在组内时本组的`\n?` 会吃掉 END 前那个换行，
			// 而replacer 又无条件补一个 ⇒ 每次 --write 都在 END 前多插一个空行（非幂等），
			// 且该空行对 --check 的 .trim() 比较完全不可见（静默污染）。
			// 组外的 `\n?` 在匹配时被消费掉，replacer 补的 `\n` 就是唯一那个换行。
			// 用函数式 replacer 而非 `$1${body}$2`：body 里有 $ 时（规则正文含 `$&` / `$1` 等）
			// 字符串替换会把它当替换模式展开，生成出静默损坏的地图。
			next = next.replace(re, (_all, begin: string, end: string) => `${begin}${b.body}\n${end}`);
		}
		// 已经是最新 ≠ 缺标记块：两者都要正常退出 0，--write 必须可重复执行。
		if (next === spec) { console.log("gen-prompt-spec-map: already up to date"); return; }
		writeFileSync(specPath, next, "utf8");
		console.log("gen-prompt-spec-map: written");
		return;
	}
	console.log(renderRuleMap(readRules()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
