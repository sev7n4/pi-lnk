/**
 * verify-links —— Markdown 相对链接断链校验
 *
 * 存在的理由（一次真实审计）：
 *   手工扫 583 个 md 找断链，**两次都超时**（跑不完）⇒ 人工审计不可持续。
 *   而断链在持续产生：`docs/discussion/` 里2026-10-04 新增的那份 vendor 评审
 *   就有 3 条 ADR 链接点不开（写成了同目录 `./0009-xxx.md`，实际在 `docs/adr/`）。
 *
 * ⭐ 核心设计：**按区段判定，只管活跃资产**
 *   断链审计最大的成本是噪音。全仓原始命中 604 条，真断链只有 14 条：
 *     · vendor/ 约 500 条 —— 第三方镜像，文档里写的是他们自己的仓库结构，
 *       **禁止改**（改了无法与上游合并）。排除。
 *     · docs/superpowers/ 约 260 条 —— 历史 plan/spec 里的「要创建 XXX 文件」
 *       是当初的任务描述，文件不在了很正常。按 ADR-0008 **刻意保留**
 *       （篡改历史记录比留死链更糟）。排除。
 *     · 裸文件名引用（`prompt-registry.loader.ts`）—— 省略了子目录，
 *       上下文里完全合法。**不判为断链** —— 只查 markdown 链接语法 `](...)`。
 *     · .workbuddy/（私有记忆）与 .superpowers/（临时产物）—— 非仓库资产。排除。
 *
 * 剩下的才是真断链，分两类：
 *   · 「相对链接」：markdown 链接语法 `](./x.md)`，点得开才算 —— **修**
 *   · 「路径引用」：反引号包裹的路径，可能是历史记录 —— **只报告不改**
 *
 * 用法：
 *   node --import tsx scripts/verify-links.ts [--json] [--all]
 *     --json   机器可读输出（供CI 摘要用）
 *     --all    含历史区（docs/superpowers/），默认不含
 * 退出码：0 = 活跃资产无断链；1 = 有断链
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = process.argv.includes('--json');
const includeHistory = process.argv.includes('--all');

/**
 * 不扫描的目录：第三方镜像 / 私有记忆 / 临时产物 / 依赖
 *
 * ⚠️ `.worktrees` 必须在列表里 —— 本机并行开发时 git worktree 会在仓库内建
 * `.worktrees/<slug>/`，里面是**另一个 checkout 的完整副本**。漏掉它会：
 *   ① 扫出 3000+ 个重复 md（实测 66 → 3006）
 *   ② 报一堆假断链（副本里的链接指向副本自己的相对路径）
 *   ③ 本机跑直接 SIGTERM（exit 137）—— 就是这么发现的
 * CI 上是干净 checkout 所以不会触发，但本机跑会误导人。
 */
const EXCLUDE_DIRS = new Set([
	'node_modules', '.git', 'dist', '.next', 'out', 'coverage',
	'.workbuddy',     // 私有记忆，非仓库资产
	'.superpowers',    // SDD 临时产物
	'.worktrees',      // git worktree 副本（内容重复 + 相对路径失真 + 拖慢扫描）
	'uploads', 'assets',
	// 常见构建/工具缓存，顺手排除避免以后踩同类坑
	'__pycache__', '.venv', 'venv', '.pytest_cache', '.turbo', '.cache',
]);

/** 历史区：断链刻意保留（ADR-0008：篡改历史记录比留死链更糟） */
const HISTORY_SEGMENTS = ['docs/superpowers/'];

/** vendor 单独处理：它是上游只读镜像，内部链接指向他们自己的仓库结构 */
function inVendor(rel: string): boolean {
	return rel.startsWith('vendor/');
}

function inHistory(rel: string): boolean {
	return HISTORY_SEGMENTS.some((s) => rel.startsWith(s));
}

function* walkMd(dir: string = ROOT): Generator<string> {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, e.name);
		if (e.isDirectory()) {
			if (EXCLUDE_DIRS.has(e.name)) continue;
			// ⚠️ 必须显式传子目录 —— 靠 e.path 会在 symlink/相对路径下退化，
			//  导致 join('.', name) 恒等于当前层 ⇒ 无限递归 ⇒ 栈溢出。
			yield* walkMd(abs);
		} else if (e.name.endsWith('.md')) {
			yield relative(ROOT, abs).split(sep).join('/');
		}
	}
}

type Broken = { file: string; line: number; target: string; resolved: string; kind: '相对链接' | '路径引用' };

const broken: Broken[] = [];
let scanned = 0;
let vendorSkipped = 0;

for (const rel of walkMd()) {
	const abs = join(ROOT, rel);
	if (inVendor(rel)) {
		vendorSkipped++;
		continue;
	}
	if (inHistory(rel) && !includeHistory) continue;
	scanned++;

	const text = readFileSync(abs, 'utf8');
	const dir = dirname(abs);
	const lines = text.split('\n');

	lines.forEach((line, i) => {
		// ① markdown 链接语法：只查 ./ 或 ../ 开头的（站内相对链接）
		for (const m of line.matchAll(/\]\((\.{1,2}\/[^)#\s]+?)(?:#[^)]*)?\)/g)) {
			const target = m[1];
			const resolved = resolve(dir, target);
			if (!existsSync(resolved)) {
				broken.push({ file: rel, line: i + 1, target, resolved: relative(ROOT, resolved), kind: '相对链接' });
			}
		}
		// ② 反引号包裹的带前缀路径：只报告，不阻断
		//    （可能是历史记录，也可能是裸文件名省略子目录 —— 后者靠去重后人工判断）
		for (const m of line.matchAll(
			/`((?:docs|services|apps|packages|deploy|charts|scripts|prompt-registry|vendor)\/[A-Za-z0-9_./-]+?\.(?:md|ts|tsx|yml|yaml|json|html))`/g
		)) {
			const target = m[1];
			const cands = [target, resolve(dir, target), resolve(ROOT, target), resolve(ROOT, 'docs', target)];
			if (cands.some((c) => existsSync(c))) continue;
			broken.push({ file: rel, line: i + 1, target, resolved: target, kind: '路径引用' });
		}
	});
}

// 去重（同一 file+target 只报一次，行号取第一条）
const seen = new Set<string>();
const uniq = broken.filter((b) => {
	const k = `${b.file}|${b.target}`;
	if (seen.has(k)) return false;
	seen.add(k);
	return true;
});

const linkBroken = uniq.filter((b) => b.kind === '相对链接');
const pathBroken = uniq.filter((b) => b.kind === '路径引用');

if (json) {
	console.log(JSON.stringify({ scanned, vendorSkipped, linkBroken, pathBroken }, null, 2));
} else {
	console.log(`扫描 ${scanned} 个 md（跳过 vendor ${vendorSkipped} 个${inHistory('') || includeHistory ? '' : '、历史区'}）`);
	console.log('');
	if (linkBroken.length === 0) {
		console.log('✓ 活跃资产无断链（markdown 相对链接全部可达）');
	} else {
		console.log(`✗ 相对链接断链 ${linkBroken.length} 条（点不开，必须修）：`);
		for (const b of linkBroken) {
			console.log(`   ${b.file}:${b.line}  →  ${b.target}`);
			console.log(`      解析为 ${b.resolved}（不存在）`);
		}
	}
	if (pathBroken.length > 0) {
		console.log('');
		console.log(`⚠ 路径引用失效 ${pathBroken.length} 条（可能是历史记录，按 ADR-0008 登记不改）：`);
		for (const b of pathBroken) {
			console.log(`   ${b.file}:${b.line}  →  ${b.target}`);
		}
	}
}

// 只有「相对链接断链」阻断 —— 路径引用可能是刻意保留的历史记录
process.exit(linkBroken.length > 0 ? 1 : 0);
