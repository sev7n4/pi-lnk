// apps/server/src/admin/platform-channel.controller.sqlite.integration.test.ts
import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common'
import { PlatformChannelAdminController } from './platform-channel.controller'

const serverRoot = path.resolve(__dirname, '../..')

const MODELS_JSON = JSON.stringify([
  { name: 'm-a', capability: 'text', extraKeep: 'keep-me' },
  { name: 'm-b', capability: 'image', pricing: { inputPerM: 0.5, outputPerM: 2 } },
])

async function seedPlatformChannel(prisma: PrismaClient, modelsRaw: string) {
  await prisma.providerChannel.create({
    data: {
      id: 'platform',
      name: '平台渠道',
      apiFormat: 'openai',
      baseUrl: 'https://platform.example.com',
      models: modelsRaw,
    },
  })
}

describe('PlatformChannelAdminController（Ops Console §5.2）', () => {
  let dir: string
  let prisma: PrismaClient
  let controller: PlatformChannelAdminController

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lnkpi-platform-channel-admin-sqlite-'))
    const dbPath = path.join(dir, 'test.db')
    const databaseUrl = `file:${dbPath}`
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    controller = new PlatformChannelAdminController(prisma as never)
  }, 60_000) // 裁决偏离：集成 harness 高负载下 beforeAll 超 vitest 默认 10s，本文件局部放宽

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await prisma.providerChannel.deleteMany()
    await prisma.adminAuditLog.deleteMany()
  })

  describe('GET', () => {
    it('解析 models 返回条目列表（不含敏感列）', async () => {
      await seedPlatformChannel(prisma, MODELS_JSON)
      const res = await controller.show()
      expect(res.data.id).toBe('platform')
      expect(res.data.parseError).toBe(false)
      expect(res.data.models).toHaveLength(2)
      expect(res.data.models[1]).toMatchObject({ name: 'm-b', pricing: { inputPerM: 0.5 } })
      // 敏感列绝不回显
      expect(JSON.stringify(res.data)).not.toContain('encryptedApiKey')
    })

    it('models JSON 畸形 → fail-soft：models:[] + parseError:true', async () => {
      await seedPlatformChannel(prisma, '{not-json')
      const res = await controller.show()
      expect(res.data.parseError).toBe(true)
      expect(res.data.models).toEqual([])
    })

    it('平台渠道行不存在 → 404', async () => {
      await expect(controller.show()).rejects.toThrow(NotFoundException)
    })

    // Follow-up ②：pull-models 事故可见性盲区——数组混入 null/非对象元素会让前端逐条渲染崩页
    it('GET 消毒：models 数组混入 null/非对象元素 → 过滤后返回，parseError 仍 false', async () => {
      await seedPlatformChannel(
        prisma,
        JSON.stringify([{ name: 'm-ok', capability: 'text' }, null, 'garbage', 42, { name: 'm-2', capability: 'image' }]),
      )
      const res = await controller.show()
      expect(res.data.parseError).toBe(false)
      expect(res.data.models.map((m) => m.name)).toEqual(['m-ok', 'm-2'])
    })

    // Follow-up ③：pricing:null 与未配置同义（键归一移除），前端徽标与计数才能正确显示
    it('GET 归一：条目 pricing:null → 视为未配置（pricing 键被移除）', async () => {
      await seedPlatformChannel(prisma, JSON.stringify([{ name: 'm-n', capability: 'text', pricing: null }]))
      const res = await controller.show()
      expect(res.data.models).toHaveLength(1)
      expect(res.data.models[0]).not.toHaveProperty('pricing')
      expect(res.data.models[0]).toMatchObject({ name: 'm-n', capability: 'text' })
    })
  })

  describe('PUT pricing', () => {
    beforeEach(async () => {
      await seedPlatformChannel(prisma, MODELS_JSON)
    })

    it('set：仅替换目标条目的 pricing 键，其余条目与字段逐字段不动', async () => {
      const res = await controller.setPricing('m-a', { pricing: { inputPerM: 1, outputPerM: 3 } })
      expect(res.data.previousPricing).toBeNull()
      expect(res.data.entry.pricing).toEqual({ inputPerM: 1, outputPerM: 3 })

      const row = await prisma.providerChannel.findUniqueOrThrow({ where: { id: 'platform' } })
      const models = JSON.parse(row.models) as Array<Record<string, unknown>>
      // m-a：pricing 落位、既有字段保留
      expect(models[0]).toMatchObject({ name: 'm-a', capability: 'text', extraKeep: 'keep-me' })
      // m-b：整条原样
      expect(models[1]).toEqual({ name: 'm-b', capability: 'image', pricing: { inputPerM: 0.5, outputPerM: 2 } })
      expect(models).toHaveLength(2)

      const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'platform-channel.pricing.set' } })
      expect(audit.resource).toBe('platform-channel:m-a')
      expect(audit.before).toBeNull()
      expect(audit.after).toBe('{"inputPerM":1,"outputPerM":3}')
    })

    it('overwrite：返回 previousPricing，审计 before 为旧值', async () => {
      await controller.setPricing('m-a', { pricing: { inputPerM: 1 } })
      const res = await controller.setPricing('m-a', { pricing: { inputPerM: 2, cacheReadPerM: 0.1 } })
      expect(res.data.previousPricing).toEqual({ inputPerM: 1 })
      const audits = await prisma.adminAuditLog.findMany({ where: { action: 'platform-channel.pricing.set' }, orderBy: { createdAt: 'asc' } })
      expect(audits).toHaveLength(2)
      expect(JSON.parse(audits[1]!.before!)).toEqual({ inputPerM: 1 })
    })

    it('clear（pricing:null）：pricing 键整键移除，审计 action 为 clear', async () => {
      const res = await controller.setPricing('m-b', { pricing: null })
      expect(res.data.previousPricing).toEqual({ inputPerM: 0.5, outputPerM: 2 })
      const row = await prisma.providerChannel.findUniqueOrThrow({ where: { id: 'platform' } })
      const models = JSON.parse(row.models) as Array<Record<string, unknown>>
      expect(models[1]).toEqual({ name: 'm-b', capability: 'image' })
      const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'platform-channel.pricing.clear' } })
      expect(audit.after).toBeNull()
    })

    it('未知条目 → 404；body 缺 pricing 键 → 400', async () => {
      await expect(controller.setPricing('nope', { pricing: { inputPerM: 1 } })).rejects.toThrow(NotFoundException)
      await expect(controller.setPricing('m-a', {})).rejects.toThrow(BadRequestException)
    })

    it('DTO 负例：负数/非有限数/空对象/非对象 → 400', async () => {
      await expect(controller.setPricing('m-a', { pricing: { inputPerM: -1 } })).rejects.toThrow(BadRequestException)
      await expect(controller.setPricing('m-a', { pricing: { inputPerM: Number.POSITIVE_INFINITY } })).rejects.toThrow(BadRequestException)
      await expect(controller.setPricing('m-a', { pricing: {} })).rejects.toThrow(BadRequestException)
      await expect(controller.setPricing('m-a', { pricing: 'cheap' })).rejects.toThrow(BadRequestException)
    })

    it('models JSON 畸形 → 409 拒盲写（渠道行不被修改）', async () => {
      await prisma.providerChannel.update({ where: { id: 'platform' }, data: { models: '{broken' } })
      await expect(controller.setPricing('m-a', { pricing: { inputPerM: 1 } })).rejects.toThrow(ConflictException)
      const row = await prisma.providerChannel.findUniqueOrThrow({ where: { id: 'platform' } })
      expect(row.models).toBe('{broken')
    })

    it('BYOK 隔离：用户渠道行永不被端点触碰', async () => {
      // 偏离说明：ProviderChannel.userId 有真实 FK，brief 原文未播种 User 会触发外键违约
      await prisma.user.create({ data: { id: 'u1', phone: '13800000001', nickname: 'BYOK 用户' } })
      await prisma.providerChannel.create({
        data: { id: 'user-ch-1', userId: 'u1', name: '我的渠道', apiFormat: 'openai', baseUrl: 'https://byok.example.com', models: MODELS_JSON },
      })
      await controller.setPricing('m-a', { pricing: { inputPerM: 9 } })
      const userRow = await prisma.providerChannel.findUniqueOrThrow({ where: { id: 'user-ch-1' } })
      expect(userRow.models).toBe(MODELS_JSON)
    })

    // Follow-up ①：读取与写回之间存在窗口（pull-models/bootstrap 对齐并发写）→ 乐观锁拒盲写
    it('并发防线：渠道行在读取后被并发改写 → 409，并发写入者的版本不被覆盖', async () => {
      const stale = await prisma.providerChannel.findUniqueOrThrow({ where: { id: 'platform' } })
      // 模拟并发写：controller 将读取到 stale 快照，DB 实际已是 pull-models 重建后的版本
      const concurrentModels = JSON.stringify([{ name: 'm-a', capability: 'text' }])
      await prisma.providerChannel.update({ where: { id: 'platform' }, data: { models: concurrentModels } })
      const spy = vi.spyOn(prisma.providerChannel, 'findUnique').mockResolvedValue(stale)
      try {
        await expect(controller.setPricing('m-a', { pricing: { inputPerM: 1 } })).rejects.toThrow(ConflictException)
      } finally {
        spy.mockRestore()
      }
      const after = await prisma.providerChannel.findUniqueOrThrow({ where: { id: 'platform' } })
      expect(after.models).toBe(concurrentModels)
      // 写回被拒 → 审计不留痕
      expect(await prisma.adminAuditLog.count()).toBe(0)
    })
  })
})
