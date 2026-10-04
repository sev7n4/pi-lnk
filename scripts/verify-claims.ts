/**
 * verify-claims —— AGENTS.md 事实性断言的机器校验
 *
 * 存在的理由（一次真实事故）：
 *   评审整改时，AGENTS.md 里留下过3 处会漂移的计数（测试文件 97/176/26、
 *   ADR「0001-0008」、superpowers「283 份」），而文档第 159 行自己写着
 *   「别抄本文档的旧数字，要数字时实测」—— 自相矛盾。
 *   更糟的是：清理这些旧值后，同一批任务新写的DoD 又引入了
 *   「180 files / 1449 tests」，因为**验收判据是枚举式的**（只查已知旧值）。
 *
 * 本脚本把判据从「枚举已知值」改成「卡类别 + 卡契约」：
 *   ① 任何测试文件数/文档份数出现在 AGENTS.md 正文 → 报错（附获取命令）
 *   ② 被ADR / charts 按名引用的章节名必须存在 → 报错（防断链）
 *   ③ 关键事实断言（workflow 名、tag 规则、端口）必须与仓库实况一致 → 报错
 *
 * 设计原则（见 ~/.workbuddy/skills/spec-driven-doc-hardening）：
 *   - 判据卡类别，不卡具体值。枚举式判据挡不住新引入的同类问题。
 *   - 每条判据可单独豁免（allowlist），且豁免必须写理由，避免"改判据绕过"。
 *   - 叙述类表述（如「当天补录 8 份 ADR」是历史事件）不算漂移，靠豁免清单区分。
 *
 * 用法：
 *   node --import tsx scripts/verify-claims.ts         # 校验
 *   node --import tsx scripts/verify-claims.ts --quiet # 只输出结果
 * 退出码：0 = 全通过；1 = 有error
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = join(ROOT, 'AGENTS.md');
const quiet = process.argv.includes('--quiet');

type Result = { ok: true } | { ok: false; msg: string };

const results: Result[] = [];
const errors: string[] = [];

function check(name: string, fn: () => Result) {
	try {
		const r = fn();
		results.push(r);
		if (!r.ok) errors.push(`${name}: ${r.msg}`);
		if (!quiet) console.log(`${r.ok ? '✓' : '✗'} ${name}`);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		results.push({ ok: false, msg });
		errors.push(`${name}: threw ${msg}`);
		if (!quiet) console.log(`✗ ${name} (threw)`);
	}
}

// ── 允许出现计数的行（叙述类/ 受控事实）────────────────────────────────
const COUNT_ALLOWLIST: Array<{ re: RegExp; why: string }> = [
	// 历史事件叙述，不是对现状的计数断言
	{ re: /当天删除、同日恢复.*补录\s*\d+\s*份\s*ADR/, why: '历史事件叙述（2026-10-03 清理记录），非现状计数' },
	// 符号分布结构描述（X 个源文件 + Y 个测试文件），不是仓库规模计数
	{ re: /在\s*\d+\s*个源文件\s*\+\s*\d+\s*个测试文件出现/, why: '符号分布结构，非仓库规模计数' },
	// 受控事实：pi 内核版本号有明确三处核对位置
	{ re: /0\.85\.1/, why: 'pi 内核版本号，属受控事实（VENDORED.md / package.json / ADR）' },
	// 预算与限额（配置常量，非漂移计数；由 prompt-lint 门禁守护）
	{ re: /L6\s*预算上限\s*\d+\s*字符/, why: '配置常量 STATIC_BUDGET_CHARS，非漂移计数' },
	{ re: /余量约\s*\d+/, why: '余量估算，随规则增删变化；由 prompt:lint 门禁校验' },
];

function isAllowlisted(line: string): boolean {
	return COUNT_ALLOWLIST.some((a) => a.re.test(line));
}

// ── 判据 1：不得有会漂移的规模计数 ──────────────────────────────────────
const COUNT_PATTERNS: Array<{ re: RegExp; label: string }> = [
	{ re: /\b\d+\s+(?:test\s+)?files?\b/i, label: '测试文件数' },
	{ re: /\b\d+\s+tests?\b/i, label: '测试用例数' },
	{ re: /\d+\s*份(?!\s*ADR)/, label: '文档份数' },
	{ re: /\d+\s*个测试文件/, label: '测试文件数' },
	{ re: /实测[:：]\s*server\s*\d+/i, label: '实测测试规模' },
];

check('判据1 · AGENTS.md 正文无会漂移的规模计数', () => {
	const text = readFileSync(AGENTS, 'utf8');
	const lines = text.split('\n');
	const hits: string[] = [];
	lines.forEach((line, i) => {
		for (const { re, label } of COUNT_PATTERNS) {
			if (re.test(line) && !isAllowlisted(line)) {
				hits.push(`  L${i + 1} [${label}] ${line.trim().slice(0, 90)}`);
			}
		}
	});
	if (hits.length > 0) {
		return {
			ok: false,
			msg:
				`发现 ${hits.length} 处规模计数：\n${hits.join('\n')}\n` +
				`  ⇒ AGENTS.md 自己规定「不写会漂移的计数，要数字时给获取命令」。\n` +
				`  ⇒ 改法：删除该数字，改为给出获取命令（如 ` +
				`find <dir> -name '*.test.ts' | wc -l）。`,
		};
	}
	return { ok: true };
});

// ── 判据 2：受保护的章节名必须存在（防外部引用断链）─────────────────────
// 这些名字被 ADR 与 charts README 按名引用，改标题会静默断链。
// ⚠️ 校验用「标题行包含关键词」而非「## + 裸名」——实际标题含 emoji 与副标题
//    （真实例：`## ⭐ 分支纪律（最高优先级）`）。
// ── 判据 2：受保护的章节名必须存在（防外部引用断链）─────────────────────
// ⚠️ 校验范围是「规范体系」而非单一文件：AGENTS.md 拆分后章节下沉到 docs/agent/*.md，
//    引用方指向的是「哪个文件里有个叫这个名字的章节」，不是「AGENTS.md 里有」。
//    只扫 AGENTS.md 会让拆分必然红 —— 那就成了拦路石而非护栏。
// 这些名字被 ADR 与 charts README 按名引用，改标题会静默断链。
// ⚠️ 校验用「标题行包含关键词」而非「## + 裸名」——实际标题含 emoji 与副标题
//    （真实例：`## ⭐ 分支纪律（最高优先级）`）。
const SPEC_FILES = [
	join(ROOT, 'AGENTS.md'),
	...['delivery.md', 'architecture.md', 'docs.md', 'environment.md'].map((f) =>
		join(ROOT, 'docs/agent', f)
	),
];

const PROTECTED_HEADINGS = [
	'分支纪律',
	'文档管理规范',
	'pi 内核版本',
	'端口约定',
	'仓库结构',
	'必须先做的事',
	'核心 skill 路由',
	'本机环境',
	'系统地图',
	'你的角色与边界',
	'变更影响面矩阵',
	'完成定义',
	'PR 规范',
];

check('判据2 · 受保护章节名在规范体系内全部在位（防 ADR/charts 引用断链）', () => {
	const allHeads: string[] = [];
	const foundIn = new Map<string, string>();
	for (const f of SPEC_FILES) {
		if (!existsSync(f)) continue;
		const heads = readFileSync(f, 'utf8')
			.split('\n')
			.filter((l) => l.startsWith('## '));
		for (const h of heads) {
			allHeads.push(h);
			for (const k of PROTECTED_HEADINGS) {
				if (h.includes(k) && !foundIn.has(k)) foundIn.set(k, f.replace(ROOT + '/', ''));
			}
		}
	}
	const missing = PROTECTED_HEADINGS.filter((k) => !foundIn.has(k));
	if (missing.length > 0) {
		const scanned = SPEC_FILES.filter((f) => existsSync(f))
			.map((f) => f.replace(ROOT + '/', ''))
			.join('、');
		return {
			ok: false,
			msg:
				`缺失章节：${missing.join('、')}\n` +
				`  ⇒ 已扫描：${scanned}\n` +
				`  ⇒ 这些章节名被 ADR-0001/0008/0009 与 charts/pi-lnk-runtime/README.md 按名引用。\n` +
				`  ⇒ 若确实要改标题，必须同步改引用方，并更新 docs/README.md 的「外部引用契约」。`,
		};
	}
	return { ok: true };
});

// ── 判据 3：关键事实断言必须与仓库实况一致 ──────────────────────────────
check('判据3 · 四条 workflow 名与 .github/workflows/ 实际文件一致', () => {
	const dir = join(ROOT, '.github/workflows');
	const actual = existsSync(dir)
		? require('node:fs')
				.readdirSync(dir)
				.filter((f: string) => f.endsWith('.yml') || f.endsWith('.yaml'))
				.map((f: string) => f.replace(/\.ya?ml$/, ''))
		: [];
	const text = readFileSync(AGENTS, 'utf8');

	// ⚠️ 只认「.github/workflows/ 语境下」出现过的文件名。
	// 全仓还有 values.yaml（chart 配置）等同扩展名文件，全局正则会误判成
	// 「引用了不存在的 workflow」—— 第一次跑就踩到了这个假阳性。
	const wfCtx = /\.github\/workflows\/[^\n]{0,200}/g;
	const claimedSet = new Set<string>();
	for (const m of text.matchAll(wfCtx)) {
		for (const f of m[0].matchAll(/([a-z0-9-]+\.ya?ml)/g)) {
			claimedSet.add(f[1].replace(/\.ya?ml$/, ''));
		}
	}
	// 「系统地图」那张表里会裸列 workflow 名（`` `runtime-deploy.yml` | ... ``），
	// 路径语境那一路匹配不到，所以按「表格行内的 .yml 名」补上。
	// ⚠️ 必须排除带路径分隔符的（`charts/.../values.yaml:15` 是 chart 配置，
	//    不是 workflow）—— 第一次跑就被这个假阳性绊过两次。
	const inTableRow = text
		.split('\n')
		.filter((l) => l.trimStart().startsWith('|'))
		.join('\n');
	for (const f of inTableRow.matchAll(/(?:^|[^/\w.-])([a-z0-9-]+\.ya?ml)/g)) {
		claimedSet.add(f[1].replace(/\.ya?ml$/, ''));
	}
	const claimed = [...claimedSet];
	const stale = claimed.filter((c) => !actual.includes(c));
	const undeclared = actual.filter((a) => !claimedSet.has(a));
	if (stale.length > 0) {
		return { ok: false, msg: `AGENTS.md 引用了不存在的 workflow：${stale.join('、')}` };
	}
	if (undeclared.length > 0) {
		return {
			ok: false,
			msg:
				`有 workflow 未在 AGENTS.md 声明：${undeclared.join('、')}\n` +
				`  ⇒ 「系统地图」节要求列出全部流水线触发面，漏了会导致改那层时不发对应流水线。`,
		};
	}
	return { ok: true };
});

check('判据4 · pi 内核版本与 services/pi-runtime/package.json 一致', () => {
	const pkgPath = join(ROOT, 'services/pi-runtime/package.json');
	// 版本声明随「pi 内核版本」节搬到了 docs/agent/architecture.md，
	// 所以在整个规范体系里找，而不是只找 AGENTS.md。
	let claimed: RegExpMatchArray | null = null;
	let where = '';
	for (const f of SPEC_FILES) {
		if (!existsSync(f)) continue;
		const m = readFileSync(f, 'utf8').match(/当前唯一版本：`([\d.]+)`/);
		if (m) {
			claimed = m;
			where = f.replace(ROOT + '/', '');
			break;
		}
	}
	if (!claimed) {
		return {
			ok: false,
			msg: `规范体系内未找到「当前唯一版本」声明（扫了 ${SPEC_FILES.length} 个文件），无法校验`,
		};
	}
	const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
	const actual = (pkg.dependencies ?? {})['@earendil-works/pi-agent-core'];
	if (!actual) {
		return { ok: false, msg: 'package.json 里找不到 @earendil-works/pi-agent-core 依赖' };
	}
	if (actual !== claimed[1]) {
		return {
			ok: false,
			msg:
				`${where} 声称 ${claimed[1]}，package.json 实际 ${actual}\n` +
				`  ⇒ 改 package.json 时必须同步改该文件「pi 内核版本」节。`,
		};
	}
	return { ok: true };
});

check('判据5 · prompt-registry 六处同步点符号仍存在于仓库', () => {
	// 只校验「符号仍存在」——不校验数量，避免符号增减时误报
	const symbols = ['COMPOSED_IDS', 'FALLBACK_BY_ID', 'renderStaticFallback', 'contentHash'];
	const roots = ['apps/server/src'];
	const missing: string[] = [];
	for (const sym of symbols) {
		let found = false;
		for (const r of roots) {
			const base = join(ROOT, r);
			if (!existsSync(base)) continue;
			for (const file of walk(base)) {
				if (!file.endsWith('.ts')) continue;
				if (readFileSync(file, 'utf8').includes(sym)) {
					found = true;
					break;
				}
			}
			if (found) break;
		}
		if (!found) missing.push(sym);
	}
	if (missing.length > 0) {
		return {
			ok: false,
			msg:
				`符号在仓库中找不到：${missing.join('、')}\n` +
				`  ⇒ 要么符号被重命名（AGENTS.md「变更影响面矩阵」需同步），\n` +
				`     要么它搬到了 apps/server/src 之外（需扩展本判据的扫描根）。`,
		};
	}
	return { ok: true };
});

// ── 判据 6：不得把「工具故障」写成「仓库事实」 ─────────────────────────
check('判据6 · 无「已知假阴性」类工具故障断言', () => {
	const text = readFileSync(AGENTS, 'utf8');
	// 一次真实事故：把 grep shim 大范围扫描超时（exit 137）写成了
	// 「git grep 对这些符号返 0 命中（已知假阴性）」，并推荐了一个本身会崩的替代方案。
	const banned = [
		/已知假阴性/,
		/会返\s*0\s*命中/,
		/必须用\s*python\s*直读/,
		/git grep.*(不可用|不能信|别信)/,
	];
	const hits = banned.filter((re) => re.test(text)).map((re) => re.source);
	if (hits.length > 0) {
		return {
			ok: false,
			msg:
				`发现工具故障类断言：${hits.join('、')}\n` +
				`  ⇒ 工具报错 ≠ 仓库事实。写进规范前必须用两种不同方式验证同一结论。`,
		};
	}
	return { ok: true };
});

// ── helpers ────────────────────────────────────────────────────────────
function* walk(dir: string): Generator<string> {
	for (const e of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
			yield* walk(p);
		} else {
			yield p;
		}
	}
}

// ── 汇总 ────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.ok).length;
console.log('');
if (errors.length === 0) {
	console.log(`verify-claims: ${passed}/${results.length} 判据通过`);
	process.exit(0);
} else {
	console.error(`verify-claims: ${passed}/${results.length} 判据通过，${errors.length} 项失败\n`);
	for (const e of errors) console.error(`✗ ${e}\n`);
	process.exit(1);
}
