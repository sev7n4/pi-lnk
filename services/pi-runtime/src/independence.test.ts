/**
 * 独立边界守卫（两产品线拆分 path C）
 *
 * 背景：`services/pi-runtime` 是「智能体产品线」的种子，测绘结论见
 * docs/superpowers/specs/2026-09-28-two-product-line-boundary-mapping.md。
 * 它当前零 workspace 依赖（只依赖 @earendil-works/pi-*、fastify、typebox、node:*），
 * 因此**可以**被整体摘出去而不拖出画布侧代码。
 *
 * 但「现在独立」不等于「将来独立」——只要有人在 pi-runtime 里 import 一次
 * `@lnkpi/shared`，这颗种子就被焊死在 monorepo 上，物理拆仓时又要重新劈一遍。
 * 本测试在 CI 里守住这条边界：任何指向外部 workspace 包的依赖直接失败。
 *
 * ⚠️ 这是**守卫**不是架构改造：不改任何产品代码，只把已有的独立性固化为可执行约束。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));
const PKG_JSON = join(SRC_ROOT, "..", "package.json");

/**
 * 本 monorepo 中「其它」workspace 包（本包 @pi-lnk/pi-runtime 除外）。
 * 列表而非前缀匹配：新增 workspace 包时这里会显式提示维护者重新判断归属。
 */
const FOREIGN_WORKSPACE_PACKAGES = [
	"@lnkpi/agent",
	"@lnkpi/shared",
	"@lnkpi/server",
	"@lnkpi/web",
	"@pi-lnk/pi-poc",
];

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const child of readdirSync(dir)) {
		const p = join(dir, child);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (p.endsWith(".ts")) out.push(p);
	}
	return out;
}

/** 提取所有 import/export-from 的模块说明符（不解析语法，够用且零依赖）。 */
function extractImports(content: string): string[] {
	const out: string[] = [];
	for (const m of content.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) out.push(m[1]);
	return out;
}

test("pi-runtime 源码不 import 任何外部 workspace 包", () => {
	const offenders: string[] = [];
	for (const file of walk(SRC_ROOT)) {
		for (const spec of extractImports(readFileSync(file, "utf8"))) {
			if (FOREIGN_WORKSPACE_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`))) {
				offenders.push(`${relative(SRC_ROOT, file)} -> ${spec}`);
			}
		}
	}
	assert.deepEqual(
		offenders,
		[],
		`pi-runtime 必须保持零 workspace 依赖（否则物理拆仓要重新劈）。违规 import：\n${offenders.join("\n")}`,
	);
});

test("pi-runtime package.json 不声明外部 workspace 依赖", () => {
	const pkg = JSON.parse(readFileSync(PKG_JSON, "utf8")) as Record<string, Record<string, string>>;
	const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
	const offenders = declared.filter((d) => FOREIGN_WORKSPACE_PACKAGES.includes(d));
	assert.deepEqual(
		offenders,
		[],
		`package.json 不得声明外部 workspace 依赖（声明即绑定）：${offenders.join(", ")}`,
	);
});
