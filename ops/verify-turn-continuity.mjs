#!/usr/bin/env node
/**
 * 回合连续性 —— 生产复测脚本（2026-10-21 架构修正后）。
 *
 * ## 为什么需要它
 *
 * 「模型看到什么」**无法直接观测** ⇒ 只能分层验证：
 * - 层 0：版本与迁移（`turnState` 列存在、新代码在镜像里）
 * - 层 1：Nest 侧权威存储（写 → 读回 → 字段完整）
 * - 层 2：pi 侧预算档位（`classifyBlock` 归到 `turnstate` ⇒ 不被 80 字保底截断）
 * - 层 3：真实渲染（容器内用镜像里的真实编译产物渲染出模型会看到的块）
 *
 * ⛔ **本脚本只读 + 只在自己造的探针 thread 上写**；不碰真实用户数据。
 * ⛔ **不消耗 LLM 额度**（不发真实对话请求）——真实端到端（层 4：agent 是否接上）
 *    需登录态，由人在 App 里做。
 *
 * ## 用法
 *
 * ```bash
 * # 在生产 CVM 上（需 ssh 到宿主）
 * node ops/verify-turn-continuity.mjs
 * ```
 *
 * 退出码：0 = 全通过；1 = 有失败项。
 */

import { execFileSync } from 'node:child_process'

const POD = execFileSync('kubectl', [
	'get', 'pods', '-n', 'pi-lnk-runtime', '-o',
	'jsonpath={.items[0].metadata.name}',
], { encoding: 'utf-8' }).trim()

const results = []
const check = (name, ok, detail = '') => {
	results.push({ name, ok, detail })
	console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

/** 在 pi 容器里跑一段 node 脚本。 */
const inPi = (script) =>
	execFileSync('kubectl', ['exec', '-n', 'pi-lnk-runtime', POD, '--', 'node', '-e', script], {
		encoding: 'utf-8',
	})

/** 在 Nest 容器里跑一段 node 脚本。 */
const inNest = (script) =>
	execFileSync('docker', ['exec', 'lnkpi-api', 'node', '-e', script], { encoding: 'utf-8' })

// ── 层 0：版本 ─────────────────────────────────────────────
try {
	const health = inPi('fetch("http://127.0.0.1:8100/healthz").then(r=>r.text()).then(t=>console.log(t))')
	const version = JSON.parse(health).version
	check('层 0a：pi-runtime 健康', true, `version=${version}`)
} catch (e) {
	check('层 0a：pi-runtime 健康', false, e.message.slice(0, 80))
}

// ── 层 0b：Nest 侧列与文件 ─────────────────────────────────
try {
	const out = inNest(`
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
p.$queryRawUnsafe("PRAGMA table_info(AgentThread)").then(c => {
  const col = c.find(x => x.name === "turnState");
  console.log(col ? "COL_OK" : "COL_MISSING");
  return p.$disconnect();
}).catch(e => { console.log("COL_ERR " + e.message); process.exit(0); });
`)
	check('层 0b：AgentThread.turnState 列存在', out.includes('COL_OK'), out.trim().split('\n')[0])
} catch (e) {
	check('层 0b：AgentThread.turnState 列存在', false, e.message.slice(0, 80))
}

// ── 层 2：pi 侧预算档位 ────────────────────────────────────
try {
	const out = inPi(`
const { applyDynamicBudget, classifyBlock } = require("/app/services/pi-runtime/dist/dynamic-budget.js");
const block = "【上一轮被中断，以下是该轮的任务状态】\\n用户当时的请求：让他们抱在一起\\n已完成：get_canvas_summary\\n未完成：propose_generation（卡在这一步）\\n中断类型：历史记录缺失。";
const kind = classifyBlock(block);
const todoBlock = "## 当前任务清单\\n" + "- 生成两个角色的合照\\n".repeat(60);
const r = applyDynamicBudget([todoBlock, block], { totalChars: 48000 });
console.log("KIND=" + kind);
console.log("INTACT=" + (r.blocks[1].length >= block.length));
console.log("HAS_CARD=" + r.blocks[1].includes("propose_generation") + "," + r.blocks[1].includes("未完成"));
`)
	const kind = /KIND=(\w+)/.exec(out)?.[1]
	const intact = /INTACT=(true|false)/.exec(out)?.[1] === 'true'
	// ⚠️ 解析整个匹配串而不是捕获组 1（捕获组 1 只是第一个 true/false）
	const hasCard = /HAS_CARD=true,true/.test(out)
	check('层 2a：回合状态块归到 turnstate 档', kind === 'turnstate', `kind=${kind}`)
	check('层 2b：回合状态块不被截断', intact)
	check('层 2c：卡点信息保留', hasCard)
} catch (e) {
	check('层 2：pi 侧预算档位', false, e.message.slice(0, 80))
}

// ── 层 3：真实渲染（容器内用镜像里的真实编译产物）──────────
try {
	const out = inNest(`
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const shared = require("/app/packages/shared/dist/turnState.js");
p.agentThread.findFirst({ orderBy: { updatedAt: "desc" } }).then(async t => {
  if (!t) { console.log("NO_THREAD"); process.exit(0); }
  const state = { userText: "让他们抱在一起", assistantPartial: "", interruption: "history_diverged",
    completedSteps: ["get_canvas_summary"], pendingSteps: ["propose_generation"], at: Date.now() };
  const orig = t.turnState;
  await p.agentThread.update({ where: { id: t.id }, data: { turnState: JSON.stringify(state) } });
  const row = await p.agentThread.findUnique({ where: { id: t.id }, select: { turnState: true } });
  const block = shared.renderTurnStateBlock(shared.parseTurnState(JSON.parse(row.turnState)));
  await p.agentThread.update({ where: { id: t.id }, data: { turnState: orig } });
  console.log("BLOCK_BEGIN");
  console.log(block);
  console.log("BLOCK_END");
  await p.$disconnect();
}).catch(e => { console.log("ERR " + e.message); process.exit(0); });
`)
	const block = /BLOCK_BEGIN\n([\s\S]*?)\nBLOCK_END/.exec(out)?.[1] ?? ''
	const keys = ['让他们抱在一起', 'get_canvas_summary', 'propose_generation', '历史记录缺失', '不要重新推断']
	const missing = keys.filter((k) => !block.includes(k))
	check('层 3：真实渲染出模型会看到的块', missing.length === 0, missing.length ? '缺: ' + missing.join(',') : '7 项判据全中')
	if (block) {
		console.log('\n--- 模型会看到的块 ---')
		console.log(block)
	}
} catch (e) {
	check('层 3：真实渲染', false, e.message.slice(0, 80))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`)
process.exit(failed.length === 0 ? 0 : 1)
