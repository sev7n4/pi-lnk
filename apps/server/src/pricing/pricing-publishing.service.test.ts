import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { BadRequestException } from '@nestjs/common'
import { PricingPublishingService } from './pricing-publishing.service'
import type { PrismaService } from '../prisma/prisma.service'

/**
 * 发布流服务测试（P1-a T2）。
 *
 * 桩模式照 pricing.service.test.ts（mock PrismaService），但 $transaction 采用
 * 「缓冲提交」语义真实表达事务原子性：回调内的写操作先入 pending 缓冲，回调成功
 * resolve 后才统一落盘；回调内 throw ⇒ 缓冲丢弃 ⇒ 零写入（用例 6 据此断言状态零变化）。
 */

type Row = Record<string, any>

let seq = 0

class FakeDb {
  versions: Row[] = []
  entries: Row[] = []
  costRates: Row[] = []
  auditLogs: Row[] = []
  private pending: Array<() => void> = []

  private nextId() {
    return `id-${++seq}`
  }

  private withEntries(v: Row): Row {
    return { ...v, entries: this.entries.filter((e) => e.versionId === v.id) }
  }

  private matchWhere(row: Row, where: Row | undefined): boolean {
    if (!where) return true
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'id') {
        if (typeof cond === 'string') {
          if (row.id !== cond) return false
        } else if (cond && typeof cond === 'object' && 'not' in cond) {
          if (row.id === (cond as Row).not) return false
        } else {
          throw new Error(`mock 不支持 id 查询形态: ${JSON.stringify(cond)}`)
        }
      } else if (typeof cond === 'string' || typeof cond === 'number') {
        if (row[key] !== cond) return false
      } else {
        throw new Error(`mock 不支持查询形态: ${key}=${JSON.stringify(cond)}`)
      }
    }
    return true
  }

  private findVersionRows(args: any): Row[] {
    let rows = this.versions.filter((v) => this.matchWhere(v, args?.where))
    if (args?.orderBy?.publishedAt === 'desc') {
      rows = rows
        .slice()
        .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
    }
    return rows
  }

  private findCostRates(args: any): Row[] {
    const ids: string[] = args?.where?.id?.in ?? []
    return this.costRates.filter((r) => ids.includes(r.id))
  }

  /** 事务内 tx：读直查状态，写操作进缓冲，commit 由 $transaction 在回调成功后统一执行。 */
  private makeTx() {
    return {
      priceListVersion: {
        findUnique: async (args: any) => {
          const row = this.versions.find((v) => v.id === args.where.id)
          return row ? this.withEntries(row) : null
        },
        findFirst: async (args: any) => {
          const rows = this.findVersionRows(args)
          return rows[0] ? this.withEntries(rows[0]) : null
        },
        update: async (args: any) => {
          const row = this.versions.find((v) => v.id === args.where.id)
          if (!row) throw new Error('tx.update: row not found')
          const result = { ...row, ...args.data }
          this.pending.push(() => Object.assign(row, args.data))
          return result
        },
        updateMany: async (args: any) => {
          const rows = this.findVersionRows(args)
          this.pending.push(() => {
            for (const row of rows) Object.assign(row, args.data)
          })
          return { count: rows.length }
        },
      },
      costRate: {
        findMany: async (args: any) => this.findCostRates(args),
      },
      adminAuditLog: {
        create: async (args: any) => {
          this.pending.push(() =>
            this.auditLogs.push({ id: this.nextId(), createdAt: new Date(), ...args.data }),
          )
          return { id: 'tx-pending' }
        },
      },
    }
  }

  readonly prisma = {
    priceListVersion: {
      findFirst: async (args: any) => {
        const rows = this.findVersionRows(args)
        return rows[0] ? this.withEntries(rows[0]) : null
      },
      findUnique: async (args: any) => {
        const row = this.versions.find((v) => v.id === args.where.id)
        return row ? this.withEntries(row) : null
      },
      findMany: async () =>
        this.versions.map((v) => ({
          ...this.withEntries(v),
          _count: { entries: this.entries.filter((e) => e.versionId === v.id).length },
        })),
      create: async (args: any) => {
        if (this.versions.some((v) => v.version === args.data.version)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
        }
        const { entries: nested, ...data } = args.data
        const row = {
          id: this.nextId(),
          status: 'draft',
          note: null,
          publishedAt: null,
          createdAt: new Date(),
          ...data,
        }
        this.versions.push(row)
        for (const e of nested?.create ?? []) {
          this.entries.push({
            id: this.nextId(),
            versionId: row.id,
            basis: 'legacy-equivalent',
            costRateId: null,
            ...e,
          })
        }
        return this.withEntries(row)
      },
    },
    priceListEntry: {
      upsert: async (args: any) => {
        const { versionId, matchKey } = args.where.versionId_matchKey
        const found = this.entries.find((e) => e.versionId === versionId && e.matchKey === matchKey)
        if (found) {
          Object.assign(found, args.update)
          return found
        }
        const row = {
          id: this.nextId(),
          versionId,
          matchKey,
          basis: 'legacy-equivalent',
          costRateId: null,
          ...args.create,
        }
        this.entries.push(row)
        return row
      },
    },
    costRate: {
      findMany: async (args: any) => this.findCostRates(args),
    },
    $transaction: async (cb: (tx: any) => Promise<any>) => {
      const tx = this.makeTx()
      try {
        const out = await cb(tx)
        for (const op of this.pending) op() // 成功才提交
        return out
      } finally {
        this.pending = [] // throw ⇒ 缓冲丢弃 ⇒ 零写入
      }
    },
  } as unknown as PrismaService
}

/** 基线：v1 active（text=5 无成本引用；image=20 cost-plus/cr_image；video:default=30）。 */
function seedBaseline(db: FakeDb) {
  // cr_text: floor = ceil(0.1 × 105) = ceil(10.5) = 11
  // cr_image: floor = ceil(0.05 × 105) = ceil(5.25) = 6
  db.costRates.push(
    { id: 'cr_text', channel: 'official', modelKey: 'text', spec: '-', costYuan: 0.1 },
    { id: 'cr_image', channel: 'official', modelKey: 'image', spec: '-', costYuan: 0.05 },
  )
  const v1: Row = {
    id: 'plv-v1',
    version: 'v1',
    status: 'active',
    note: 'baseline',
    publishedAt: new Date('2026-10-01T00:00:00Z'),
    createdAt: new Date('2026-10-01T00:00:00Z'),
  }
  db.versions.push(v1)
  db.entries.push(
    { id: 'e1', versionId: v1.id, matchKey: 'text', capability: 'text', credits: 5, basis: 'legacy-equivalent', costRateId: null },
    { id: 'e2', versionId: v1.id, matchKey: 'image', capability: 'image', credits: 20, basis: 'cost-plus', costRateId: 'cr_image' },
    { id: 'e3', versionId: v1.id, matchKey: 'video:default', capability: 'video', credits: 30, basis: 'legacy-equivalent', costRateId: null },
  )
  return v1
}

const svcOf = (db: FakeDb) => new PricingPublishingService(db.prisma)

describe('PricingPublishingService.createDraftFromActive', () => {
  it('用例 1：复制条数 = active 条数；basis/costRateId 逐字保留；重名/空 version → 400', async () => {
    const db = new FakeDb()
    seedBaseline(db)
    const svc = svcOf(db)

    const draft = await svc.createDraftFromActive('v2', '调价草稿')
    expect(draft.entries).toBe(3)
    const got = await svc.getDraft(draft.id)
    expect(got?.status).toBe('draft')
    const image = got!.entries.find((e) => e.matchKey === 'image')
    expect(image).toMatchObject({ credits: 20, basis: 'cost-plus', costRateId: 'cr_image' })

    // 重名 version（Prisma unique 冲突）→ 400
    await expect(svc.createDraftFromActive('v2', '')).rejects.toBeInstanceOf(BadRequestException)
    // 空 version → 400
    await expect(svc.createDraftFromActive('', '')).rejects.toBeInstanceOf(BadRequestException)
  })
})

describe('PricingPublishingService.upsertEntries', () => {
  it('用例 2：draft 可改；active 版本 → 400；credits=0/1.5/NaN/负数 → 400', async () => {
    const db = new FakeDb()
    const v1 = seedBaseline(db)
    const svc = svcOf(db)
    const draft = await svc.createDraftFromActive('v2', '')

    // draft 可改
    await expect(
      svc.upsertEntries(draft.id, [{ matchKey: 'text', capability: 'text', credits: 6 }]),
    ).resolves.toBe(1)
    const got = await svc.getDraft(draft.id)
    expect(got!.entries.find((e) => e.matchKey === 'text')!.credits).toBe(6)

    // active 版本 → 400
    await expect(
      svc.upsertEntries(v1.id, [{ matchKey: 'text', capability: 'text', credits: 6 }]),
    ).rejects.toBeInstanceOf(BadRequestException)

    // credits 非法（0 / 小数 / NaN / 负数）
    for (const bad of [0, 1.5, NaN, -3]) {
      await expect(
        svc.upsertEntries(draft.id, [{ matchKey: 'text', capability: 'text', credits: bad }]),
      ).rejects.toBeInstanceOf(BadRequestException)
    }
    // 非法值未落库
    expect((await svc.getDraft(draft.id))!.entries.find((e) => e.matchKey === 'text')!.credits).toBe(6)
  })
})

describe('PricingPublishingService.diffSummary', () => {
  it('用例 3：added/changed 计数 + maxIncrease pct + noCostCoverage 标注 + 地板违规只算不抛', async () => {
    const db = new FakeDb()
    seedBaseline(db)
    const svc = svcOf(db)
    const draft = await svc.createDraftFromActive('v2', '')
    await svc.upsertEntries(draft.id, [
      // text 5→8：涨 +60%，挂 cr_text（floor=11）→ 地板违规（预览只算不抛）
      { matchKey: 'text', capability: 'text', credits: 8, basis: 'cost-plus', costRateId: 'cr_text' },
      // image 20→10：降 -50%（cr_image floor=6，不违规）
      { matchKey: 'image', capability: 'image', credits: 10, basis: 'cost-plus', costRateId: 'cr_image' },
      // video:default 30→20：降 -33.3%，无 costRateId → noCostCoverage
      { matchKey: 'video:default', capability: 'video', credits: 20 },
      // 新增行
      { matchKey: 'audio:music', capability: 'audio', credits: 15 },
    ])

    const d = await svc.diffSummary(draft.id)
    expect(d.draftVersion).toBe('v2')
    expect(d.activeVersion).toBe('v1')
    expect(d.added).toBe(1)
    expect(d.removed).toBe(0)
    expect(d.changed).toBe(3)
    expect(d.unchanged).toBe(0)
    expect(d.maxIncrease).toMatchObject({ matchKey: 'text', from: 5, to: 8, pct: 0.6 })
    expect(d.maxDecrease?.matchKey).toBe('image') // -0.5 降幅 > video 的 -0.333
    expect(d.maxDecrease?.from).toBe(20)
    expect(d.maxDecrease?.to).toBe(10)
    // image 挂了 costRateId → 只有 video:default 属于无成本覆盖的 changed 条目
    expect(d.noCostCoverage).toEqual(['video:default'])
    expect(d.floorViolations).toEqual([{ matchKey: 'text', credits: 8, floor: 11 }])
    expect(d.missingCost).toEqual([])
  })
})

describe('PricingPublishingService.publish', () => {
  it('用例 4：幸福路径——事务后旧 active=archived、draft=active+publishedAt、audit 落一条', async () => {
    const db = new FakeDb()
    seedBaseline(db)
    const svc = svcOf(db)
    const draft = await svc.createDraftFromActive('v2', '正常调价')
    await svc.upsertEntries(draft.id, [{ matchKey: 'text', capability: 'text', credits: 6 }])

    await expect(svc.publish(draft.id)).resolves.toEqual({ version: 'v2' })

    const v1 = db.versions.find((v) => v.version === 'v1')!
    const v2 = db.versions.find((v) => v.version === 'v2')!
    expect(v1.status).toBe('archived')
    expect(v2.status).toBe('active')
    expect(v2.publishedAt).not.toBeNull()
    expect(db.auditLogs).toHaveLength(1)
    expect(db.auditLogs[0]).toMatchObject({
      actor: 'admin',
      action: 'pricing-version.publish',
      resource: 'price-list-version:v2',
    })
    expect(JSON.parse(db.auditLogs[0].before)).toMatchObject({ version: 'v1', status: 'active' })
    expect(JSON.parse(db.auditLogs[0].after)).toMatchObject({ version: 'v2', status: 'active' })
  })

  it('用例 5：publish 空 draft → 400（空集假绿防线）', async () => {
    const db = new FakeDb()
    seedBaseline(db)
    const svc = svcOf(db)
    db.versions.push({
      id: 'plv-empty',
      version: 'v-empty',
      status: 'draft',
      note: null,
      publishedAt: null,
      createdAt: new Date(),
    })

    await expect(svc.publish('plv-empty')).rejects.toBeInstanceOf(BadRequestException)
    // 状态零变化
    expect(db.versions.find((v) => v.version === 'v-empty')!.status).toBe('draft')
    expect(db.versions.find((v) => v.version === 'v1')!.status).toBe('active')
    expect(db.auditLogs).toHaveLength(0)
  })

  it('用例 6：地板违规 → 400 且状态零变化（事务原子性：回调内 throw ⇒ 无任何写入）', async () => {
    const db = new FakeDb()
    seedBaseline(db)
    const svc = svcOf(db)
    const draft = await svc.createDraftFromActive('v2', '含违规降价')
    await svc.upsertEntries(draft.id, [
      // image floor = ceil(0.05 × 105) = 6，credits=5 < 6 → 违规
      { matchKey: 'image', capability: 'image', credits: 5, basis: 'cost-plus', costRateId: 'cr_image' },
      // costRate 引用缺失 → 跳过地板并记入 missingCost
      { matchKey: 'text', capability: 'text', credits: 1, basis: 'cost-plus', costRateId: 'cr_missing' },
    ])

    const err = await svc.publish(draft.id).catch((e) => e)
    expect(err).toBeInstanceOf(BadRequestException)
    expect(err.message).toContain('image')

    // 状态零变化：draft 仍 draft、旧 active 仍 active、无 audit
    expect(db.versions.find((v) => v.version === 'v2')!.status).toBe('draft')
    expect(db.versions.find((v) => v.version === 'v1')!.status).toBe('active')
    expect(db.versions.find((v) => v.version === 'v2')!.publishedAt).toBeNull()
    expect(db.auditLogs).toHaveLength(0)
  })
})

describe('PricingPublishingService diff 与发布流一致性', () => {
  it('用例 7：changed 计数 = 相对当前 active 的实际变化数（publish 前对 v1、publish 后对 v2 均成立）', async () => {
    const db = new FakeDb()
    seedBaseline(db)
    const svc = svcOf(db)

    // v2 相对 v1 实际改 2 处：text 5→6、video 30→31
    const v2 = await svc.createDraftFromActive('v2', '')
    await svc.upsertEntries(v2.id, [
      { matchKey: 'text', capability: 'text', credits: 6 },
      { matchKey: 'video:default', capability: 'video', credits: 31 },
    ])
    const before = await svc.diffSummary(v2.id)
    expect(before.changed).toBe(2)
    expect(before.activeVersion).toBe('v1')

    await svc.publish(v2.id)

    // publish 后新开 v3 草稿（复制自 active v2），把两处改回 v1 值——对新 active(v2) 的实际变化仍是 2
    const v3 = await svc.createDraftFromActive('v3', '')
    await svc.upsertEntries(v3.id, [
      { matchKey: 'text', capability: 'text', credits: 5 },
      { matchKey: 'video:default', capability: 'video', credits: 30 },
    ])
    const after = await svc.diffSummary(v3.id)
    expect(after.changed).toBe(2)
    expect(after.activeVersion).toBe('v2')
  })
})

describe('PricingPublishingService.rollback', () => {
  it('用例 8：v2 active 时回 v1（可链式回滚）；v1 是唯一版本 → 400', async () => {
    const db = new FakeDb()
    seedBaseline(db)
    const svc = svcOf(db)
    const draft = await svc.createDraftFromActive('v2', '')
    await svc.upsertEntries(draft.id, [{ matchKey: 'text', capability: 'text', credits: 6 }])
    await svc.publish(draft.id)

    // 回滚 v2 → v1
    await expect(svc.rollback()).resolves.toEqual({ version: 'v1' })
    expect(db.versions.find((v) => v.version === 'v1')!.status).toBe('active')
    expect(db.versions.find((v) => v.version === 'v2')!.status).toBe('archived')
    expect(db.auditLogs.at(-1)).toMatchObject({
      action: 'pricing-version.rollback',
      resource: 'price-list-version:v1',
    })

    // 链式回滚：再回一次回到 v2（「最新 archived」判定成立）
    await expect(svc.rollback()).resolves.toEqual({ version: 'v2' })
    expect(db.versions.find((v) => v.version === 'v2')!.status).toBe('active')

    // 唯一版本无可回滚 → 400
    const db2 = new FakeDb()
    seedBaseline(db2)
    const svc2 = svcOf(db2)
    await expect(svc2.rollback()).rejects.toBeInstanceOf(BadRequestException)
    expect(db2.versions.find((v) => v.version === 'v1')!.status).toBe('active')
  })
})
