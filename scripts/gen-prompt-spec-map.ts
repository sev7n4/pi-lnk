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
import { resolveRegistryRoot, summarize, type RuleMeta } from "../apps/server/src/agent/pi-runtime/prompt-registry.loader";

const BEGIN = "<!-- BEGIN:rule-map -->";
const END = "<!-- END:rule-map -->";

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

function main(): void {
	const map = renderRuleMap(readRules());
	const specPath = join(dirname(fileURLToPath(import.meta.url)), "..", "prompt-registry", "PROMPT_SPEC.md");
	const mode = process.argv[2];
	if (mode === "--check") {
		const spec = readFileSync(specPath, "utf8");
		// ⚠️ END 前的 \n 是可选的：PROMPT_SPEC.md 的标记块在首次 --write 之前是**空的**，
		// 若强制要求 `\nEND`，空块永远匹配不上 ⇒ --write 静默 no-op（还打印 written），
		// --check 紧接着报「缺标记块」，看起来像 CI 配置错而不是判据错。
		const m = spec.match(new RegExp(`${BEGIN}\\n([\\s\\S]*?)\\n?${END}`));
		if (!m) { console.error("gen-prompt-spec-map: PROMPT_SPEC.md 缺 rule-map 标记块"); process.exit(1); }
		if ((m[1] ?? "").trim() !== map.trim()) {
			console.error("gen-prompt-spec-map: 规则地图与磁盘不一致，请跑 --write"); process.exit(1);
		}
		console.log("gen-prompt-spec-map: ok");
		return;
	}
	if (mode === "--write") {
		const spec = readFileSync(specPath, "utf8");
		const re = new RegExp(`(${BEGIN}\\n)[\\s\\S]*?\\n?(${END})`);
		if (!re.test(spec)) { console.error("gen-prompt-spec-map: PROMPT_SPEC.md 缺 rule-map 标记块"); process.exit(1); }
		// ⚠️ `\n?` 必须在捕获组**外**：它在组内时本组的`\n?` 会吃掉 END 前那个换行，
		// 而replacer 又无条件补一个 ⇒ 每次 --write 都在 END 前多插一个空行（非幂等），
		// 且该空行对 --check 的 .trim() 比较完全不可见（静默污染）。
		// 组外的 `\n?` 在匹配时被消费掉，replacer 补的 `\n` 就是唯一那个换行。
		// 用函数式 replacer 而非 `$1${map}$2`：map 里有 $ 时（规则正文含 `$&` / `$1` 等）
		// 字符串替换会把它当替换模式展开，生成出静默损坏的地图。
		const next = spec.replace(re, (_all, begin: string, end: string) => `${begin}${map}\n${end}`);
		// 已经是最新 ≠ 缺标记块：两者都要正常退出 0，--write 必须可重复执行。
		if (next === spec) { console.log("gen-prompt-spec-map: already up to date"); return; }
		writeFileSync(specPath, next, "utf8");
		console.log("gen-prompt-spec-map: written");
		return;
	}
	console.log(map);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
