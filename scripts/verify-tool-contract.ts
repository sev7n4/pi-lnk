#!/usr/bin/env npx tsx
/**
 * Tool framework contract verification (pi-runtime ↔ vendored pi-agent-core).
 *
 * WHY THIS EXISTS
 * ---------------
 * `services/agent-runtime` was deleted, so `scripts/verify-contract.ts` has been
 * failing with `ModuleNotFoundError: No module named 'app'` and was never wired
 * into CI. That script compares Zod↔Pydantic HTTP contracts — a different surface
 * from the tool framework. This script covers the OTHER half: the vendored
 * `pi-agent-core` hook/tool surface that pi-runtime consumes.
 *
 * The concrete failure mode it prevents: hooks are consumed by *reading fields
 * at runtime* inside `harness.hooks.on("<name>", (event) => ...)`. The `event`
 * parameter is inferred from `Harnesses["on"]`'s generic, so a renamed field is
 * only caught if some consuming file is type-checked — and when the field is a
 * free-form one (`details?: JsonValue`, `payload: unknown`), an `as` cast silences
 * the compiler and the hook silently degrades to "never fires".
 *
 * 0.x has no semver floor, so this is the only thing standing between an upstream
 * bump and a silent functional regression.
 *
 * Exit codes:
 * - 0: tool framework contract intact
 * - 1: contract drift detected (or vendor surface missing)
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Hooks pi-runtime actually registers, and the event fields pi-runtime relies on.
 * `fixtures` are the exact field spellings consumed in src/, used to prove the
 * baseline is not aspirational — if upstream renames one, this fails.
 */
const BASELINE: Record<
	string,
	{
		/** Every field upstream currently exposes for this hook's event, in order. */
		eventFields: string[]
		/** Fields pi-runtime dereferences; a remove/rename here breaks us at runtime. */
		consumed: string[]
	}
> = {
	before_tool: {
		eventFields: ['toolCallId', 'toolName', 'args'],
		consumed: ['toolName', 'args'],
	},
	after_tool: {
		eventFields: ['toolCallId', 'toolName', 'args', 'content', 'details', 'isError', 'usage'],
		consumed: ['toolName', 'args', 'content', 'details', 'isError'],
	},
	transform_context: {
		eventFields: ['messages', 'systemPrompt'],
		consumed: ['messages'],
	},
	before_payload: {
		eventFields: ['model', 'payload'],
		consumed: ['payload'],
	},
}

const VENDOR_HOOK_MAP = 'vendor/earendil-works/pi/packages/agent/src/harness/agent-harness.ts'
const CONSUMER_DIR = 'services/pi-runtime/src'

/* ------------------------------------------------------------------ parsing */

/** Pushes `cur` and returns the split parts; keeps `<>,{}[],()` nesting intact. */
function splitTopLevel(src: string): string[] {
	const parts: string[] = []
	let cur = ''
	let brace = 0
	let bracket = 0
	let paren = 0
	let angle = 0

	for (const c of src) {
		if (c === '<') angle++
		else if (c === '>') angle--
		else if (c === '{') brace++
		else if (c === '}') brace--
		else if (c === '[') bracket++
		else if (c === ']') bracket--
		else if (c === '(') paren++
		else if (c === ')') paren--

		if (brace === 0 && bracket === 0 && paren === 0 && angle === 0 && (c === ',' || c === ';')) {
			parts.push(cur.trim())
			cur = ''
			continue
		}
		cur += c
	}
	if (cur.trim()) parts.push(cur.trim())
	return parts.filter(Boolean)
}

/** Reads `export interface HookMap` and returns its body text (inside braces). */
function extractHookMapBody(src: string): string | null {
	const at = src.indexOf('export interface HookMap')
	if (at < 0) return null
	const open = src.indexOf('{', at)
	if (open < 0) return null

	let depth = 0
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++
		else if (src[i] === '}') {
			depth--
			if (depth === 0) return src.slice(open + 1, i)
		}
	}
	return null
}

/** Returns `{ ... }` contents starting at the first `{` after `from`. */
function readBraced(src: string, from: number): { body: string; next: number } | null {
	const open = src.indexOf('{', from)
	if (open < 0) return null
	let depth = 0
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++
		else if (src[i] === '}') {
			depth--
			if (depth === 0) return { body: src.slice(open + 1, i), next: i }
		}
	}
	return null
}

/** Parses the HookMap body into hook name → event field names. */
function parseHookMap(body: string): Record<string, string[]> {
	const out: Record<string, string[]> = {}

	for (const hook of splitTopLevel(body)) {
		const name = hook.split(':')[0]?.trim()
		if (!name) continue
		const braced = readBraced(hook, hook.indexOf(':'))
		if (!braced) continue
		const atEvent = braced.body.indexOf('event')
		if (atEvent < 0) continue
		const eventBlock = readBraced(braced.body, atEvent)
		if (!eventBlock) continue
		out[name] = splitTopLevel(eventBlock.body)
			// `details?: JsonValue` → field name is `details`, not `details?`
			.map((f) => f.split(':')[0]?.trim().replace(/\?+$/, ''))
			.filter(Boolean)
	}
	return out
}

/* ------------------------------------------------------------------ checks */

const errors: string[] = []
const notes: string[] = []

let vendorSrc: string
try {
	vendorSrc = readFileSync(VENDOR_HOOK_MAP, 'utf-8')
} catch {
	console.error(`❌ Cannot read vendored HookMap at ${VENDOR_HOOK_MAP}`)
	process.exit(1)
}

const hookMapBody = extractHookMapBody(vendorSrc)
if (!hookMapBody) {
	console.error('❌ Vendor HookMap not found — did the harness move agents out of agent-harness.ts?')
	process.exit(1)
}

const actual = parseHookMap(hookMapBody)
notes.push(`Parsed ${Object.keys(actual).length} hooks from vendored HookMap`)

for (const [hook, spec] of Object.entries(BASELINE)) {
	const fields = actual[hook]
	if (!fields) {
		errors.push(`hook "${hook}": disappeared from HookMap (consumed by pi-runtime)`)
		continue
	}

	// Renames / drops: the field we dereference is gone.
	for (const f of spec.consumed) {
		if (!fields.includes(f)) {
			errors.push(
				`hook "${hook}": event field "${f}" is consumed by pi-runtime but no longer in upstream ` +
					`(upstream now exposes: ${fields.join(', ') || 'nothing'}) — this hook would fail-soft`,
			)
		}
	}

	// Additions are informational, not fatal: extra upstream fields are free wins.
	const added = fields.filter((f) => !spec.eventFields.includes(f))
	if (added.length) notes.push(`hook "${hook}": upstream added ${added.map((a) => `"${a}"`).join(', ')} (no action needed)`)

	// Shape drift outside the consumed field set is still worth failing on: it means
	// someone bumped the vendor and the baseline above is now stale.
	const changed = spec.eventFields.filter((f) => !fields.includes(f))
	if (changed.length) {
		errors.push(
			`hook "${hook}": event shape drifted vs baseline ` +
				`(baseline has ${changed.map((c) => `"${c}"`).join(', ')}) — update BASELINE deliberately`,
		)
	}
}

/* ---- the baseline must not be aspirational: prove src/ really reads those fields ---- */

function collectTsFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry)
		if (statSync(p).isDirectory()) collectTsFiles(p, acc)
		else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) acc.push(p)
	}
	return acc
}

let consumerSrc = ''
try {
	consumerSrc = collectTsFiles(CONSUMER_DIR).map((f) => readFileSync(f, 'utf-8')).join('\n')
} catch {
	console.error(`❌ Cannot read consumer sources under ${CONSUMER_DIR}/`)
	process.exit(1)
}

for (const [hook, spec] of Object.entries(BASELINE)) {
	for (const f of spec.consumed) {
		// Match event.field / event?.field where `event` is this hook's parameter.
		const re = new RegExp(`\\bevent\\??\\.\\s*${f}\\b`)
		if (!re.test(consumerSrc)) {
			errors.push(
				`hook "${hook}": baseline claims pi-runtime consumes event.${f}, but no ` +
					`event.${f} reference was found under ${CONSUMER_DIR}/ — stale baseline`,
			)
		}
	}
}

/* ------------------------------------------------------------------ report */

for (const n of notes) console.log(`ℹ️  ${n}`)
if (errors.length) {
	for (const e of errors) console.error(`❌ ${e}`)
	console.error(`\n❌ Tool framework contract verification failed (${errors.length})`)
	process.exit(1)
}
console.log(`✅ Tool framework contract intact (${Object.keys(BASELINE).length} hooks guarded)`)
