#!/usr/bin/env npx tsx
/**
 * 图形化表达观测报告 —— D1 的对外交付面（spec §6 D1-4）。
 *
 * 用法：
 *   npx tsx scripts/query-graph-observation.ts --db /path/to/lnkpi.db [--days 7]
 *   npx tsx scripts/query-graph-observation.ts --json /path/to/rows.json
 *
 * 回答四个问题：
 *   1. 该画图的问句里有多少真画了（触发率）
 *   2. 视图选了哪些（分布 + legacy 使用率）
 *   3. 绕路发生在哪个工具之前
 *   4. 哪个参数从没被用过（L6 的删参数依据）
 *
 * ⚠️ 纯逻辑在 `services/pi-runtime/src/graph-observation/report.ts`（有单测），
 *   本文件只负责读库 + 打印 —— 保持薄壳，让「读库」这一部分无法污染判据。
 *
 * ⚠️ 生产库取法（2026-10-08 实测）：库在容器里（`/app/apps/server/data/lnkpi.db`），
 *   容器**无 sqlite3**，故 `docker cp` 出来在本机跑本脚本。
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildReport, type MessageRow } from "../services/pi-runtime/src/graph-observation/report.js";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function readFromDb(dbPath: string, days: number | undefined): MessageRow[] {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		// ⚠️ createdAt 在 Prisma/SQLite 里是**整型毫秒**：拿它和 `strftime('%s',...)`
		// （文本）直接比会**恒假**（整型 < 文本 的存储类序），必须 cast + ×1000。
		const sql = days
			? `SELECT role, content, metadata FROM AgentMessage
			   WHERE createdAt >= cast(strftime('%s', 'now', ?) as integer) * 1000
			   ORDER BY createdAt ASC`
			: `SELECT role, content, metadata FROM AgentMessage ORDER BY createdAt ASC`;
		const stmt = db.prepare(sql);
		const rows = days ? stmt.all(`-${days} days`) : stmt.all();
		return rows.map((r) => ({
			role: String((r as { role?: unknown }).role ?? ""),
			content: String((r as { content?: unknown }).content ?? ""),
			metadata: ((r as { metadata?: unknown }).metadata ?? null) as string | null,
		}));
	} finally {
		db.close();
	}
}

function readFromJson(path: string): MessageRow[] {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!Array.isArray(parsed)) throw new Error("--json 需要一个 MessageRow 数组");
	return parsed as MessageRow[];
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function main(): void {
	const db = arg("db");
	const json = arg("json");
	if (!db && !json) {
		console.error("用法：--db <lnkpi.db> [--days 7]  或  --json <rows.json>");
		process.exit(2);
	}
	const daysRaw = arg("days");
	const days = daysRaw === undefined ? undefined : Number(daysRaw);
	if (days !== undefined && !Number.isFinite(days)) throw new Error("--days 必须是数字");

	const rows = db ? readFromDb(db, days) : readFromJson(json!);
	const r = buildReport(rows);

	const lines: string[] = [];
	lines.push(`# 图形化表达观测报告${days ? `（近 ${days} 天）` : "（全量）"}`);
	lines.push("");
	lines.push(`- 轮次（user→assistant 配对）：${r.turns}`);
	lines.push(`- 命中图形化信号的轮次：${r.signaled}`);
	lines.push(`- 其中真调用了 render_canvas_view：${r.drew}`);
	lines.push(`- **触发率**：${pct(r.triggerRate)}（${r.drew}/${r.signaled}）`);
	lines.push("");
	lines.push("## 视图分布（legacy 已归一，topology 计入 layout）");
	const views = Object.entries(r.views).sort((a, b) => b[1] - a[1]);
	if (views.length === 0) lines.push("- （无数据）");
	for (const [k, v] of views) lines.push(`- ${k}: ${v}`);
	lines.push(`- legacy 别名使用次数：${r.legacy}`);
	lines.push("");
	lines.push("## 前置绕路（画图前先调了谁）");
	const detours = Object.entries(r.detours).sort((a, b) => b[1] - a[1]);
	if (detours.length === 0) lines.push("- （无数据）");
	for (const [k, v] of detours) lines.push(`- ${k}: ${v}`);
	lines.push("");
	lines.push("## 参数使用率（L6：使用率≈0 的参数是「删」的候选）");
	const params = Object.entries(r.paramUsage).sort((a, b) => b[1] - a[1]);
	if (params.length === 0) lines.push("- （无数据）");
	for (const [k, v] of params) lines.push(`- ${k}: ${v}`);
	lines.push("");
	lines.push("## 「该画没画」样本（人工判：规则问题 vs 模型能力问题）");
	if (r.missedSamples.length === 0) lines.push("- （无）");
	for (const s of r.missedSamples) lines.push(`- ${s}`);

	console.log(lines.join("\n"));
}

main();
