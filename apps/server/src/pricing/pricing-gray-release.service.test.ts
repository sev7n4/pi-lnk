import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { PricingGrayReleaseService } from './pricing-gray-release.service'
import { PricingPublishingService } from './pricing-publishing.service'
import { PricingService } from './pricing.service'
import type { PrismaService } from '../prisma/prisma.service'

/**
 * 灰度发布服务测试（P1-a T5）。
 *
 * 桩模式照 pricing-publishing.service.test.ts（mock PrismaService + $transaction
 * 「缓冲提交」语义）。测试 8 额外用同一 FakeDb 驱动 PricingService，断言 rollback
 * 后名单用户 quote 立即回 global 值（quote 读 status='active'，天然生效）。
 */

type Row = Record<string, any>

let seq = 0

class FakeDb {
  users: Row[] = []
  versions: Row[] = []
  entries: Row[] = []
  releases: Row[] = []
  whitelist: Row[] = []
  transactions: Row[] = []
  auditLogs: Row[] = []
  private pending: Array<() => void> = []

  private nextId() {
    return `id-${++seq}`
  }

  private withEntries(v: Row): Row {
    return { ...v, entries: this.entries.filter((e) => e.versionId === v.id) }
  }

  private withWhitelist(v: Row): Row {
    return { ...v, whitelist: this.whitelist.filter((w) => w.releaseId === v.id) }
  }

  private matchStringCond(value: unknown, cond: any): boolean {
    if (typeof cond === 'string') return value === cond
    if (cond && typeof cond === 'object' && 'not' in cond) return value !== cond.not
    throw new Error(`mock 不支持查询形态: ${JSON.stringify(cond)}`)
  }

  private findReleases(args: any): Row[] {
    let rows = this.releases.slice()
    if (args?.where?.status !== undefined) {
      rows = rows.filter((r) => this.matchStringCond(r.status, args.where.status))
    }
    if (args?.where?.id !== undefined) {
      rows = rows.filter((r) => this.matchStringCond(r.id, args.where.id))
    }
    if (args?.orderBy?.createdAt === 'desc') {
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    }
    return rows
  }

  private relFull(r: Row): Row {
    const version = this.versions.find((v) => v.id === r.versionId)
    return {
      ...r,
      version: version ? this.withEntries(version) : null,
      ...this.withWhitelist(r),
      _count: { whitelist: this.whitelist.filter((w) => w.releaseId === r.id).length },
    }
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
          const rows = this.versions.filter(
            (v) => !args?.where?.status || v.status === args.where.status,
          )
          return rows[0] ? this.withEntries(rows[0]) : null
        },
        update: async (args: any) => {
          const row = this.versions.find((v) => v.id === args.where.id)
          if (!row) throw new Error('tx.update: row not found')
          this.pending.push(() => Object.assign(row, args.data))
          return { ...row, ...args.data }
        },
        updateMany: async (args: any) => {
          const rows = this.versions.filter(
            (v) =>
              (!args?.where?.status || v.status === args.where.status) &&
              (args?.where?.id?.not === undefined || v.id !== args.where.id.not),
          )
          this.pending.push(() => {
            for (const row of rows) Object.assign(row, args.data)
          })
          return { count: rows.length }
        },
      },
      costRate: {
        findMany: async (args: any) => {
          const ids: string[] = args?.where?.id?.in ?? []
          return this.costRates.filter((r) => ids.includes(r.id))
        },
      },
      pricingGrayRelease: {
        create: async (args: any) => {
          const row = {
            id: this.nextId(),
            status: 'active',
            createdBy: 'admin',
            note: null,
            createdAt: new Date(),
            ...args.data,
          }
          this.pending.push(() => this.releases.push(row))
          return { ...row }
        },
        update: async (args: any) => {
          const row = this.releases.find((r) => r.id === args.where.id)
          if (!row) throw new Error('tx.release.update: row not found')
          this.pending.push(() => Object.assign(row, args.data))
          return { ...row, ...args.data }
        },
      },
      pricingGrayWhitelist: {
        createMany: async (args: any) => {
          const rows = (args.data as Row[]).map((d) => ({ id: this.nextId(), note: null, ...d }))
          this.pending.push(() => {
            for (const r of rows) this.whitelist.push(r)
          })
          return { count: rows.length }
        },
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

  costRates: Row[] = []

  readonly prisma = {
    user: {
      findMany: async (args: any) => {
        const phones: string[] = args?.where?.phone?.in ?? []
        return this.users
          .filter((u) => phones.includes(u.phone))
          .map((u) => ({ id: u.id, phone: u.phone }))
      },
    },
    priceListVersion: {
      findUnique: async (args: any) => {
        const row = this.versions.find((v) => v.id === args.where.id)
        return row ? this.withEntries(row) : null
      },
      findFirst: async (args: any) => {
        const rows = this.versions.filter(
          (v) => !args?.where?.status || v.status === args.where.status,
        )
        return rows[0] ? this.withEntries(rows[0]) : null
      },
    },
    pricingGrayRelease: {
      findFirst: async (args: any) => {
        const rows = this.findReleases(args)
        return rows[0] ? this.relFull(rows[0]) : null
      },
      findUnique: async (args: any) => {
        const row = this.releases.find((r) => r.id === args.where.id)
        return row ? this.relFull(row) : null
      },
      findMany: async (args: any) => this.findReleases(args).map((r) => this.relFull(r)),
      update: async (args: any) => {
        const row = this.releases.find((r) => r.id === args.where.id)
        if (!row) throw new Error('release.update: row not found')
        Object.assign(row, args.data)
        return this.relFull(row)
      },
    },
    pointTransaction: {
      findMany: async (args: any) => {
        const rid = args?.where?.grayReleaseId
        return this.transactions.filter((t) => (rid === undefined ? true : t.grayReleaseId === rid))
      },
    },
    adminAuditLog: {
      create: async (args: any) => {
        this.auditLogs.push({ id: this.nextId(), createdAt: new Date(), ...args.data })
        return { id: this.nextId() }
      },
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

/** 基线：u1/u2 两用户；v1 active（text=5）；v2 draft（text=8）。 */
function seed(db: FakeDb) {
  db.users.push(
    { id: 'u1', phone: '13800000001' },
    { id: 'u2', phone: '13800000002' },
    { id: 'u3', phone: '13900000003' },
  )
  db.versions.push(
    {
      id: 'plv-v1',
      version: 'v1',
      status: 'active',
      note: 'baseline',
      publishedAt: new Date('2026-10-01T00:00:00Z'),
      createdAt: new Date('2026-10-01T00:00:00Z'),
    },
    {
      id: 'plv-v2',
      version: 'v2',
      status: 'draft',
      note: '灰度草案',
      publishedAt: null,
      createdAt: new Date('2026-10-13T00:00:00Z'),
    },
  )
  db.entries.push(
    { id: 'e1', versionId: 'plv-v1', matchKey: 'text', capability: 'text', credits: 5, basis: 'legacy-equivalent', costRateId: null },
    { id: 'e2', versionId: 'plv-v2', matchKey: 'text', capability: 'text', credits: 8, basis: 'legacy-equivalent', costRateId: null },
  )
}

const svcOf = (db: FakeDb) =>
  new PricingGrayReleaseService(db.prisma, new PricingPublishingService(db.prisma))

describe('PricingGrayReleaseService.previewWhitelist', () => {
  it('用例 1：换行/逗号/空格切分 + 去重；命中/未命中显式返回', async () => {
    const db = new FakeDb()
    seed(db)
    const svc = svcOf(db)

    // 库内 13800000001(u1)、13800000002(u2) 命中；13999999999 未命中；重复 token 去重
    const out = await svc.previewWhitelist('13800000001, 13800000002\n13800000001 13999999999')
    expect(out.hits).toEqual([
      { userId: 'u1', phone: '13800000001' },
      { userId: 'u2', phone: '13800000002' },
    ])
    expect(out.misses).toEqual(['13999999999'])

    // 全部未命中 → hits 空、misses 全列
    const allMiss = await svc.previewWhitelist('11111111111')
    expect(allMiss.hits).toEqual([])
    expect(allMiss.misses).toEqual(['11111111111'])

    // 空白输入 → 空结果（不炸）
    await expect(svc.previewWhitelist('  \n ,;')).resolves.toEqual({ hits: [], misses: [] })
  })
})

describe('PricingGrayReleaseService.createRelease', () => {
  it('用例 2：空命中 → 400 且错误信息含每个未命中号码；零写入（空集假绿防线）', async () => {
    const db = new FakeDb()
    seed(db)
    const svc = svcOf(db)

    const err = await svc
      .createRelease({ versionId: 'plv-v2', phones: ['19999999999', '18888888888'] })
      .catch((e) => e)
    expect(err).toBeInstanceOf(BadRequestException)
    expect(err.message).toContain('19999999999')
    expect(err.message).toContain('18888888888')

    // 零写入：无 release、无 whitelist、无 audit
    expect(db.releases).toHaveLength(0)
    expect(db.whitelist).toHaveLength(0)
    expect(db.auditLogs).toHaveLength(0)
  })

  it('用例 3：幸福路径——whitelist 行数 = hits；默认窗口 now~now+7d（±60s）；audit 落一条', async () => {
    const db = new FakeDb()
    seed(db)
    const svc = svcOf(db)
    const before = Date.now()

    const out = await svc.createRelease({
      versionId: 'plv-v2',
      phones: ['13800000001, 13800000002\n13800000001'], // 重复 token 去重 → 2 hits
      note: '首轮灰度',
    })

    expect(out.hits).toBe(2)
    expect(out.version).toBe('v2')
    expect(out.window.startsAt.getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(out.window.endsAt.getTime() - out.window.startsAt.getTime()).toBeCloseTo(7 * 24 * 3600 * 1000, -5)
    expect(Date.now() - out.window.startsAt.getTime()).toBeLessThan(60_000)

    expect(db.releases).toHaveLength(1)
    expect(db.releases[0]).toMatchObject({ versionId: 'plv-v2', status: 'active', note: '首轮灰度' })
    expect(db.whitelist).toHaveLength(2)
    expect(db.whitelist.map((w) => w.userId).sort()).toEqual(['u1', 'u2'])
    expect(db.whitelist.every((w) => w.releaseId === db.releases[0].id)).toBe(true)
    expect(db.auditLogs).toHaveLength(1)
    expect(db.auditLogs[0]).toMatchObject({ actor: 'admin', action: 'pricing-gray.create' })
  })

  it('用例 4：已有 active release → 409；versionId 是 active 版本 → 400；不存在 → 404；endsAt ≤ startsAt → 400', async () => {
    const db = new FakeDb()
    seed(db)
    const svc = svcOf(db)
    await svc.createRelease({ versionId: 'plv-v2', phones: ['13800000001'] })

    // 单一 active 灰度约束
    await expect(
      svc.createRelease({ versionId: 'plv-v2', phones: ['13800000002'] }),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(db.releases).toHaveLength(1)

    // 灰度对象必须是 draft：active 版本 → 400
    await expect(
      svc.createRelease({ versionId: 'plv-v1', phones: ['13800000001'] }),
    ).rejects.toBeInstanceOf(BadRequestException)

    // 版本不存在 → 404
    await expect(
      svc.createRelease({ versionId: 'plv-nope', phones: ['13800000001'] }),
    ).rejects.toBeInstanceOf(NotFoundException)

    // 窗口非法 → 400
    const now = Date.now()
    await expect(
      svc.createRelease({
        versionId: 'plv-v2',
        phones: ['13800000001'],
        startsAt: new Date(now),
        endsAt: new Date(now - 1000),
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })
})

describe('PricingGrayReleaseService.listReleases', () => {
  it('用例 5：读时惰性过期——endsAt 已过的 active 返回前置为 expired', async () => {
    const db = new FakeDb()
    seed(db)
    const svc = svcOf(db)
    const now = Date.now()
    await svc.createRelease({
      versionId: 'plv-v2',
      phones: ['13800000001'],
      startsAt: new Date(now - 2 * 24 * 3600 * 1000),
      endsAt: new Date(now - 24 * 3600 * 1000), // 已过期
      note: '过期灰度',
    })

    const list = await svc.listReleases()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ status: 'expired', version: 'v2', hits: 1, note: '过期灰度' })
    // DB 行也已置 expired
    expect(db.releases[0].status).toBe('expired')
  })
})

describe('PricingGrayReleaseService.getReport', () => {
  it('用例 6：按 grayReleaseId 聚合——txCount/txAmountByCategory/refundCount/byUser', async () => {
    const db = new FakeDb()
    seed(db)
    const svc = svcOf(db)
    const out = await svc.createRelease({ versionId: 'plv-v2', phones: ['13800000001', '13800000002'] })
    const rid = out.releaseId

    // 3 条本 release 流水：u1 两条 consume（text=10 / image=20）+ u2 一条 refund；外加 1 条别的 release 流水（隔离）
    db.transactions.push(
      { id: 't1', userId: 'u1', amount: 10, kind: 'consume', category: 'text', grayReleaseId: rid },
      { id: 't2', userId: 'u1', amount: 20, kind: 'consume', category: 'image', grayReleaseId: rid },
      { id: 't3', userId: 'u2', amount: 5, kind: 'refund', category: 'other', grayReleaseId: rid },
      { id: 't4', userId: 'u3', amount: 99, kind: 'consume', category: 'text', grayReleaseId: 'other-release' },
    )

    const report = await svc.getReport(rid)
    expect(report).toMatchObject({
      releaseId: rid,
      version: 'v2',
      status: 'active',
      hits: 2,
      txCount: 3,
      txAmountByCategory: { text: 10, image: 20, other: 5 },
      refundCount: 1,
    })
    expect(report.byUser).toEqual([{ userId: 'u1', consumeCount: 2, consumeTotal: 30 }])

    // 未知 release → 404
    await expect(svc.getReport('nope')).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe('PricingGrayReleaseService.promote / rollback', () => {
  it('用例 7：promote——版本转 active、旧 active 归档、release=promoted、audit 两条（publish + promote）', async () => {
    const db = new FakeDb()
    seed(db)
    const svc = svcOf(db)
    const out = await svc.createRelease({ versionId: 'plv-v2', phones: ['13800000001'] })

    await expect(svc.promote(out.releaseId)).resolves.toEqual({ version: 'v2' })

    expect(db.versions.find((v) => v.version === 'v1')!.status).toBe('archived')
    expect(db.versions.find((v) => v.version === 'v2')!.status).toBe('active')
    expect(db.releases[0].status).toBe('promoted')
    // audit：create 1 条 + promote 时 publish/promote 各 1 条
    const actions = db.auditLogs.map((a) => a.action).sort()
    expect(actions).toEqual(['pricing-gray.create', 'pricing-gray.promote', 'pricing-version.publish'])

    // 非 active release 不可 promote → 400
    await expect(svc.promote(out.releaseId)).rejects.toBeInstanceOf(BadRequestException)
    // 未知 release → 404
    await expect(svc.promote('nope')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('用例 8：rollback——release 置 rolled_back + audit；名单用户 quote 立即回 global 值', async () => {
    const db = new FakeDb()
    seed(db)
    const svc = svcOf(db)
    const out = await svc.createRelease({ versionId: 'plv-v2', phones: ['13800000001'] })

    // 灰度窗口内：名单用户走灰度价 8
    const grayQuote = await new PricingService(db.prisma).quote({ capability: 'text' }, 'u1')
    expect(grayQuote).toEqual({ credits: 8, ruleVersion: 'v2', grayReleaseId: out.releaseId })

    await svc.rollback(out.releaseId)

    expect(db.releases[0].status).toBe('rolled_back')
    expect(db.auditLogs).toHaveLength(2)
    expect(db.auditLogs[1]).toMatchObject({ actor: 'admin', action: 'pricing-gray.rollback' })

    // rollback 后（新 PricingService 实例 = 无缓存）：名单用户回 global 价 5，无 grayReleaseId
    const globalQuote = await new PricingService(db.prisma).quote({ capability: 'text' }, 'u1')
    expect(globalQuote).toEqual({ credits: 5, ruleVersion: 'v1' })
    expect(Object.keys(globalQuote)).not.toContain('grayReleaseId')

    // 版本本身不动（v2 仍 draft，版本回退走 publishing.rollback）
    expect(db.versions.find((v) => v.version === 'v2')!.status).toBe('draft')

    // 未知 release → 404
    await expect(svc.rollback('nope')).rejects.toBeInstanceOf(NotFoundException)
  })
})
