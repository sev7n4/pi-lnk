import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sql = readFileSync(
  resolve(__dirname, '../../prisma/migrations/20261112120000_add_subagent_task/migration.sql'),
  'utf8',
)
const schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8')

describe('D2 migration：纯 additive、零破坏', () => {
  it('只 CREATE TABLE，不 ALTER / DROP / UPDATE 存量', () => {
    expect(sql).toMatch(/CREATE TABLE "SubagentTask"/)
    expect(sql).not.toMatch(/\b(ALTER|DROP|DELETE|UPDATE|INSERT)\b/i)
  })

  it('唯一键与两个索引齐备（幂等 + sweep 可寻址）', () => {
    expect(sql).toMatch(/"SubagentTask_threadId_callId_key"/)
    expect(sql).toMatch(/"SubagentTask_requestId_key"/)
    expect(sql).toMatch(/"SubagentTask_threadId_status_idx"/)
    expect(sql).toMatch(/"SubagentTask_status_expiresAt_idx"/)
  })

  it('schema model 字段与 migration 逐字段对齐，且无 FK relation', () => {
    const start = schema.indexOf('model SubagentTask {')
    const model = schema.slice(start, schema.indexOf('\n}', start))
    for (const col of ['requestId', 'callId', 'runId', 'parentSessionKey',
      'taskPreview', 'outcomeJson', 'reason', 'expiresAt', 'endedAt']) {
      expect(model).toContain(col)
    }
    expect(model).not.toMatch(/@relation\(/)
    expect(model).toMatch(/@@unique\(\[threadId, callId\]\)/)
  })

  it('status 是 String + default spawned（SQLite 无 enum；不改存量）', () => {
    expect(sql).toMatch(/"status" TEXT NOT NULL DEFAULT 'spawned'/)
  })
})
