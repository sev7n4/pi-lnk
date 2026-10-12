#!/usr/bin/env npx tsx
/**
 * Tool details contract verification（P0 契约机检，spec 2026-10-12 §2.3）。
 *
 * WHY THIS EXISTS
 * ---------------
 * P0 为 8 个文件的工具建立了显式 details 契约（`_signal` 注入键 + 族字段
 * affectedCount/modelUsed/generationParams/coverage/scope）。契约靠约定维持时
 * 必然回退：有人新写一个 `resultWithActions(...)` 裸 return、或手滑写下无下划线的
 * `details.signal`，工具结果信号层就静默缺一块——本脚本是防回退闸门。
 *
 * 规则（全部 grep 级，启动 <1s）：
 *   R1  8 文件内 `resultWithActions(` 出现必须被 withSignal/withGenSignal/
 *       withWriteSignal 包装（裸 return = 违例）。
 *   R2  8 文件内 `details.signal`（无下划线）零命中——注入键约定是 `details._signal`。
 *   R3  注册序前瞻：index.ts 的信号 listener 注册行号 > 合并 after_tool listener
 *       行号。P0 阶段 listener 未落地 → SKIP 并说明（P1 落地后自动生效）。
 *
 * Exit codes: 0 = 契约完好；1 = 违例（打印 文件:行号）。
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const REPO = join(import.meta.dirname ?? '.', '..')
const P0_FILES = [
	'services/pi-runtime/src/tools/generation.ts',
	'services/pi-runtime/src/tools/canvas-write.ts',
	'services/pi-runtime/src/tools/delete-nodes.ts',
	'services/pi-runtime/src/tools/remove-edges.ts',
	'services/pi-runtime/src/tools/arrange-nodes.ts',
	'services/pi-runtime/src/tools/present-result.ts',
	'services/pi-runtime/src/tools/canvas-read.ts',
	// image-refine.ts 无直接 return 点（细节见 spec §2.3 规则 1 注），
	// 由 generation.ts 流路覆盖——仅校验其存在清单内：
	'services/pi-runtime/src/tools/image-refine.ts',
]

/** 剥掉块注释与行注释，避免注释里的示例文本触发误报。 */
function stripCommentsSafe(src: string): string {
	// 简化版：块注释 → 空格（保留换行），行注释 → 行内清空
	const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
	return noBlock
		.split('\n')
		.map((line) => {
			const idx = line.indexOf('//')
			// 粗略处理：字符串里的 "//"（如 url）极少出现在这些工具文件的行注释位置，
			// 误伤面可忽略；有冲突时以 R1/R2 的行号输出人工复核。
			return idx >= 0 ? line.slice(0, idx) : line
		})
		.join('\n')
}

let failures = 0
const fail = (msg: string) => {
	failures++
	console.error(`  ✗ ${msg}`)
}
const ok = (msg: string) => console.log(`  ✓ ${msg}`)

console.log('R1: resultWithActions 裸调用检查（必须经 withSignal/withGenSignal/withWriteSignal 包装）')
for (const rel of P0_FILES) {
	const abs = join(REPO, rel)
	let src: string
	let rawLines: string[]
	try {
		src = readFileSync(abs, 'utf8')
		rawLines = src.split('\n')
	} catch {
		fail(`${rel}: 文件不存在（P0 清单与实际不符）`)
		continue
	}
	const lines = stripCommentsSafe(src).split('\n')
	lines.forEach((line, i) => {
		if (!line.includes('resultWithActions(')) return
		// 显式豁免：调用点前两行内带 `verify-details:ignore <理由>` 注释（审计勾选不进信号层的工具，
		// 如 cancel_generation=lifecycle 自描述）。豁免必须留理由，防滥用。在原始行上判定（注释会被剥离）。
		const prev = (rawLines[i - 1] ?? '') + (rawLines[i - 2] ?? '')
		if (prev.includes('verify-details:ignore')) return
		// helper 自身的定义点（const base = resultWithActions(data)）允许存在——
		// 它是包装器的内部实现；判定方法：同一行有 withXxx( 前缀 or 上一行是 helper 定义的 return/const base。
		const wrappedInline =
			/withSignal\(/.test(line) ||
			/withGenSignal\(/.test(line) ||
			/withWriteSignal\(/.test(line) ||
			/const base = resultWithActions\(data\)/.test(line) ||
			/function withGenSignal|function withWriteSignal/.test(lines.slice(0, i + 1).join('\n').slice(-200))
		if (!wrappedInline) fail(`${rel}:${i + 1} 裸 resultWithActions（未包装信号；如属审计豁免，上一行加 verify-details:ignore <理由>）`)
	})
}
if (failures === 0) ok('R1 通过：8 文件无裸调用')

const beforeR2 = failures
console.log('R2: details.signal（无下划线）零命中')
for (const rel of P0_FILES) {
	const abs = join(REPO, rel)
	let src: string
	try {
		src = stripCommentsSafe(readFileSync(abs, 'utf8'))
	} catch {
		continue
	}
	src.split('\n').forEach((line, i) => {
		if (/details\.signal\b/.test(line)) fail(`${rel}:${i + 1} 使用了 details.signal（应为 details._signal）`)
	})
}
if (failures === beforeR2) ok('R2 通过：无无下划线注入键')

console.log('R3: 信号 listener 注册序（P1 前瞻）')
const indexPath = join(REPO, 'services/pi-runtime/src/index.ts')
const indexSrc = readFileSync(indexPath, 'utf8')
const mergedListener = indexSrc.indexOf('harness.hooks.on("after_tool"')
const signalListener = indexSrc.indexOf('result-signal-listener')
if (signalListener === -1) {
	console.log('  SKIP：P1 信号 listener 尚未落地（result-signal-listener 未在 index.ts 引用）；P1 合入后本规则自动生效')
} else if (mergedListener === -1) {
	fail('index.ts 未找到合并 after_tool listener 注册点（结构漂移？）')
} else {
	const mergedLine = indexSrc.slice(0, mergedListener).split('\n').length
	const signalLine = indexSrc.slice(0, signalListener).split('\n').length
	if (signalLine <= mergedLine) {
		fail(`信号 listener（行 ${signalLine}）必须注册在合并 after_tool listener（行 ${mergedLine}）之后——链式 replace 语义，见 spec §4`)
	} else {
		ok(`R3 通过：信号 listener（行 ${signalLine}）在合并 listener（行 ${mergedLine}）之后`)
	}
}

if (failures > 0) {
	console.error(`\nverify:details FAILED — ${failures} 处违例`)
	process.exit(1)
}
console.log('\nverify:details PASS — details 契约完好')
