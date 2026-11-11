#!/usr/bin/env tsx
/**
 * 只读取证 + 对账回填：steer / followUp 插话内容是否真的进入模型上下文并被接住。
 *
 * 规格：docs/superpowers/specs/2026-11-11-queue-user-bubble-context-verify-design.md §4.5 / AC2 / AC3。
 * 来源：2026-11-11 生产只读取证的 throwaway 脚本（/tmp/verify-queue-context*.js|sh）固化入仓。
 *
 * ## 用法（operator 工具，不进 CI）
 *
 * 1) 导出插话行（CVM 上，只读副本）：
 *    docker cp lnkpi-api:/app/apps/server/data/lnkpi.db /tmp/lnkpi-verify.db
 *    sqlite3 -json /tmp/lnkpi-verify.db "SELECT id,threadId,entryId,createdAt FROM AgentMessage
 *      WHERE role='user' AND queued=1 AND entryId IS NOT NULL AND entryId<>'';" > /tmp/qrows.json
 *    # 阳性对照（正常发送 queued=0）：追加一个 threadId:entryId 参数
 *
 * 2) 在 pi-runtime pod 内跑（sessions 目录只在该 pod 可见；恒定内存逐行读，防 OOM）：
 *    kubectl cp /tmp/qrows.json <pod>:/tmp/qrows.json
 *    kubectl exec <pod> -- node --max-old-space-size=256 <repo>/scripts/verify-queue-context.js \
 *      /tmp/qrows.json /data/sessions [normalThreadId:normalEntryId]
 *    （pod 内无 tsx ⇒ 用仓库构建产物或直接以 node 跑同目录 .js 版本；本 TS 为判据 SSOT。）
 *
 * 3) 对账回填（--emit-sql）：打印 UPDATE 语句，由 operator 在 DB 侧执行：
 *    - entry=true（已物化 transcript）⇒ `queued=0, consumedAt=now`（权威「已接住」）；
 *    - entry=false（从未物化，无论是否仍在 inbox）⇒ `reconciled=1`（滞留终态「未接住」，
 *      绝不因「有后续回答」而误显已发送）。
 *
 * ## 分层判据（全部精确 JSON 解析；子串只用于「这一行要不要解析」的预筛）
 *   L1 pending   : pi.pending.entry 或 pi.lane.state.inbox 登记过该 entryId（入队）
 *   L2 entry     : kind=entry 且 id=entryId、message.role=user（写进 transcript）
 *   L3 msgEnd    : events.jsonl 里 message_end{data.entryId, data.message.role=user}（SSE 广播过）
 *   L4 trigger   : pi.op.state.generationContext.triggerEntryId === entryId（触发新一轮 generation）
 *   L5 assistant : 存在 parentId=entryId 的 assistant entry（模型在这条之后产出）
 *   L6 answered  : 该 assistant entry 的 content 有非空 text/thinking/toolCall（不是空壳）
 *
 * ## 变异自检（防恒真 / 恒假，规格 §2.2）
 *   NEG 随机 entryId ⇒ L1..L6 必须全 false（混入同批扫描，零额外 IO）
 *   POS 第一条真实插话 ⇒ L2 与 L5 必须为 true，否则 ANCHOR_FAIL
 *   CTRL 正常发送（queued=0）的 entryId ⇒ L2 应为 true（判据不是只对插话生效）
 *
 * ## ⭐ 伪锚点教训（实测踩过，勿回退）
 *   全量 `"entryId":"X"` 子串会命中 `queue_update`（66 条虚高到 65 条"已消费"）。
 *   L2 必须收紧为 `kind:'entry' && id===entryId`；L3 必须收紧为
 *   `type==='message_end' && data.entryId===entryId` 同行判定。
 */
'use strict'
import { openSync, readSync, closeSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const rowsFile = process.argv[2] ?? ''
const root = process.argv[3] ?? ''
const ctrlArg = process.argv[4] ?? ''
const emitSql = process.argv.includes('--emit-sql')
const ctrlParts = ctrlArg.split(':')
const normalThreadId = ctrlParts.length === 2 ? ctrlParts[0] : ''
const normalEntryId = ctrlParts.length === 2 ? ctrlParts[1] : ''

if (!rowsFile || !root) {
  console.error('usage: tsx scripts/verify-queue-context.ts <rows.json> <sessionsRoot> [normalThreadId:normalEntryId] [--emit-sql]')
  process.exit(2)
}

interface QRow { id: string; threadId: string; entryId: string; createdAt?: string }
type Flags = { dir: boolean; pending: boolean; entry: boolean; msgEnd: boolean; trigger: boolean; assistant: boolean; answered: boolean }
const rows: QRow[] = JSON.parse(readFileSync(rowsFile, 'utf8')) as QRow[]

/** 恒定内存逐行读（jsonl 单文件可达数十 MB，整文件 split 会 OOM / 被 kill）。 */
function* linesOf(file: string): Generator<string> {
  const fd = openSync(file, 'r')
  const dec = new StringDecoder('utf8')
  const CH = 64 * 1024
  const buf = Buffer.alloc(CH)
  let carry = ''
  let n: number
  try {
    while ((n = readSync(fd, buf, 0, CH, null)) > 0) {
      const s = carry + dec.write(buf.subarray(0, n))
      const parts = s.split('\n')
      carry = parts.pop() as string
      for (const p of parts) yield p
    }
    carry += dec.end()
    if (carry) yield carry
  } finally {
    closeSync(fd)
  }
}

function sessionDir(threadId: string): string | null {
  let hit: string[] = []
  try {
    hit = readdirSync(root).filter((name: string) => name.indexOf(threadId + '-') === 0)
  } catch {
    return null
  }
  if (!hit.length) return null
  const d = join(root, hit[0] as string)
  return existsSync(d) ? d : null
}

function transcriptFiles(dir: string): string[] {
  const base = join(dir, 'sessions')
  if (!existsSync(base)) return []
  const out: string[] = []
  for (const sub of readdirSync(base)) {
    const p = join(base, sub)
    let st
    try { st = statSync(p) } catch { continue }
    if (!st.isDirectory()) continue
    for (const f of readdirSync(p)) {
      if (f.slice(-6) === '.jsonl') out.push(join(p, f))
    }
  }
  return out
}

function hasVisibleContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some((p: unknown) => {
    if (!p || typeof p !== 'object') return false
    const part = p as { type?: string; text?: unknown; thinking?: unknown }
    if (part.type === 'toolCall') return true
    const t = typeof part.text === 'string' ? part.text : (typeof part.thinking === 'string' ? part.thinking : '')
    return t.trim().length > 0
  })
}

function blank(hasDir: boolean): Flags {
  return { dir: hasDir, pending: false, entry: false, msgEnd: false, trigger: false, assistant: false, answered: false }
}

/** 预筛：这一行是否含任一目标 entryId（只是省掉 JSON.parse，不作为判据）。 */
function hitIds(line: string, ids: string[]): string[] {
  const out: string[] = []
  for (const id of ids) if (line.indexOf(id) >= 0) out.push(id)
  return out
}

function analyzeThread(threadId: string, ids: string[]): Record<string, Flags> {
  const res: Record<string, Flags> = {}
  const dir = sessionDir(threadId)
  for (const id of ids) res[id] = blank(Boolean(dir))
  if (!dir) return res

  const ev = join(dir, 'events.jsonl')
  if (existsSync(ev)) {
    for (const line of linesOf(ev)) {
      if (!hitIds(line, ids).length) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      const e = (o && typeof o === 'object' ? (o.event ?? o) : o) as { type?: string; data?: { entryId?: string; message?: { role?: string } } }
      const d = (e?.data ?? {}) as { entryId?: string; message?: { role?: string } }
      // ⭐ 伪锚点防线：message_end 同行判定（不认 queue_update 的 entryId 子串）
      if (e?.type === 'message_end' && d.entryId && res[d.entryId] && d.message?.role === 'user') {
        res[d.entryId].msgEnd = true
      }
    }
  }

  for (const f of transcriptFiles(dir)) {
    for (const line of linesOf(f)) {
      if (!hitIds(line, ids).length) continue
      let ops
      try { ops = JSON.parse(line) } catch { continue }
      if (!Array.isArray(ops)) ops = [ops]
      for (const op of ops as Array<Record<string, unknown>>) {
        if (!op || typeof op !== 'object') continue
        if (op.kind === 'value' && op.namespace === 'pi.pending.entry' && typeof op.key === 'string' && res[op.key]) {
          res[op.key].pending = true
        }
        if (op.kind === 'value' && op.namespace === 'pi.lane.state' && op.value && Array.isArray((op.value as { inbox?: unknown }).inbox)) {
          for (const item of (op.value as { inbox: Array<{ entryId?: string }> }).inbox) {
            if (item && typeof item.entryId === 'string' && res[item.entryId]) res[item.entryId].pending = true
          }
        }
        // ⭐ L2 收紧锚点：kind:'entry' 且 id 精确相等（子串命中不算）
        if (op.kind === 'entry' && typeof op.id === 'string' && res[op.id] && op.type === 'message' && op.message
          && (op.message as { role?: string }).role === 'user') {
          res[op.id].entry = true
        }
        if (op.kind === 'entry' && typeof op.parentId === 'string' && res[op.parentId] && op.message
          && (op.message as { role?: string }).role === 'assistant') {
          res[op.parentId].assistant = true
          if (hasVisibleContent((op.message as { content?: unknown }).content)) res[op.parentId].answered = true
        }
        if (op.kind === 'value' && op.namespace === 'pi.op.state' && op.value) {
          const gc = (op.value as { generationContext?: { triggerEntryId?: string } }).generationContext
          if (gc?.triggerEntryId && res[gc.triggerEntryId]) res[gc.triggerEntryId].trigger = true
        }
      }
    }
  }
  return res
}

// ── 按 thread 批量扫描（每条消息只扫一遍所属会话的文件） ───────────────────
const byThread = new Map<string, string[]>()
for (const r of rows) {
  if (!byThread.has(r.threadId)) byThread.set(r.threadId, [])
  byThread.get(r.threadId)!.push(r.entryId)
}

const FAKE = '00000000-0000-0000-0000-000000000000'
const flags = new Map<string, Flags>()
const maxThreads = parseInt(process.env.VQC_MAX_THREADS || '0', 10)
let scanned = 0
for (const [tid, ids] of byThread) {
  if (maxThreads && scanned >= maxThreads) break
  console.error('SCAN ' + tid + ' ids=' + ids.length)
  scanned += 1
  // 阴性样本混进同一批扫描：判据必须对它全程无命中
  const got = analyzeThread(tid, ids.concat([FAKE]))
  for (const id of ids) flags.set(id, got[id] as Flags)
  if (!flags.has('__neg__')) flags.set('__neg__', got[FAKE] as Flags)
}

// 阳性对照：正常发送的 user 消息（queued=0）也应在 transcript 里
let ctrl: Flags | null = null
if (normalThreadId && normalEntryId) ctrl = analyzeThread(normalThreadId, [normalEntryId])[normalEntryId] ?? null

const KEYS: Array<keyof Flags> = ['dir', 'pending', 'entry', 'msgEnd', 'trigger', 'assistant', 'answered']
const results = rows.map((r) => ({ id: r.id, threadId: r.threadId, entryId: r.entryId, ...(flags.get(r.entryId) ?? blank(false)) }))
const neg = flags.get('__neg__')
const pos = results[0]
const negClean = Boolean(neg && KEYS.slice(1).every((k) => !neg[k]))
const posOk = Boolean(pos && pos.entry && pos.assistant)
const ctrlOk = !ctrl || ctrl.entry

const summary: Record<string, number> = { total: results.length, distinct_threads: byThread.size }
for (const k of KEYS) summary[k] = results.filter((r) => r[k]).length
summary.not_in_context = results.filter((r) => !r.entry).length
summary.in_context_no_assistant = results.filter((r) => r.entry && !r.assistant).length
summary.full_chain = results.filter((r) => r.entry && r.trigger && r.assistant && r.answered).length
summary.stuck_candidates = results.filter((r) => r.dir && !r.entry).length

console.log('=== VERIFY queue -> context -> model (read-only) ===')
console.log('SUMMARY ' + JSON.stringify(summary))
console.log('SELFTEST ' + JSON.stringify({
  neg_random_entry_all_false: negClean,
  pos_first_row_entry_and_assistant: posOk,
  ctrl_normal_prompt_entry: ctrlOk,
  verdict: negClean && posOk && ctrlOk ? 'JUDGMENT_VALID' : 'ANCHOR_FAIL',
}))
console.log('POS_SAMPLE ' + JSON.stringify({ entryId: pos?.entryId, flags: pos }))
console.log('NEG_SAMPLE ' + JSON.stringify({ entryId: FAKE, flags: neg }))
if (ctrl) console.log('CTRL_SAMPLE ' + JSON.stringify({ entryId: normalEntryId, flags: ctrl }))
const bad = results.filter((r) => !r.entry || !r.assistant || !r.answered)
console.log('INCOMPLETE ' + JSON.stringify(bad.slice(0, 12).map((r) => ({ id: r.id, entryId: r.entryId, flags: KEYS.filter((k) => r[k]) }))))

// ── 对账回填 SQL（--emit-sql）：consumed / stuck 两类终态 ───────────────────
if (emitSql) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const consumed = results.filter((r) => r.entry)
  const stuck = results.filter((r) => r.dir && !r.entry)
  const noDir = results.filter((r) => !r.dir)
  console.log('=== RECONCILE SQL（operator 在 DB 侧执行；noDir 行不判定，显式保留人工裁决） ===')
  for (const r of consumed) {
    console.log(`UPDATE AgentMessage SET queued=0, consumedAt='${now}' WHERE id='${r.id}' AND queued=1; -- consumed entry=${r.entryId}`)
  }
  for (const r of stuck) {
    console.log(`UPDATE AgentMessage SET reconciled=1 WHERE id='${r.id}' AND queued=1 AND consumedAt IS NULL; -- stuck entry=${r.entryId}`)
  }
  console.log(`-- NO_DIR（会话目录已清理，无法判定，不回填）: ${noDir.length} 行: ${noDir.map((r) => r.id).join(',')}`)
}
