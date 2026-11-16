// 文件：apps/server/src/skills/skills.service.ts
// M1-1 技能控制面服务（规格 v1 §5.4 十端点 / §7.1 三表 / §7.2 状态机 / ADR-0016）。
// 判据锚：M1-A1（跨用户隔离）/ A3（两通路归一）/ A6（七类拒绝+审计）/ A8（卸载守卫）/ A10（目录与搜索）。
import { BadGatewayException, BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { PiRuntimeClient } from '../agent/pi-runtime/pi-runtime.client'
import { parseSkillPackageText, sha256Hex } from './skills-parse.js'
import { assembleSkillResources, type SkillResourceRow } from './skills-resources.js'
import {
  assertUninstallGuard,
  evaluateCompatibility,
  rankCatalog,
  resolveInvocationMode,
  verifyImport,
  type CatalogSort,
  type InvocationIntent,
} from './skills-pure.js'

const ENVELOPE = { code: 0, message: 'ok' } as const

/** 运行时技能客户端最小面（PiRuntimeClient 的结构子集，测试可注入假实现——同 late-generation-notify 形态）。 */
export interface RuntimeSkillsClient {
  listSkills(): Promise<{ skills: Array<{ name: string; description: string }> }>
}

export interface SkillLifecycleRow {
  id: string
  packageHash: string
  sourceType: string
  trustLevel: string
  enabled: boolean
  installedAt: Date
  uninstalledAt: Date | null
  skill: string
  displayName: string
  publisher: string
  version: string
  compatProfile: string
  disableModelInvocation: boolean
  userInvocable: boolean
}

@Injectable()
export class SkillsService {
  constructor(
    private readonly prisma: PrismaService,
    /** 可选运行时客户端；缺省按既有形态从 PI_RUNTIME_URL 现场构造（同 generation-reaper）。
     *  ⚠️ 必须带 @Optional()：无装饰时 Nest 把 RuntimeSkillsClient 当必需 provider 解析，
     *  容器启动即崩（本地手工 new 绕过 DI 测不到，#929 部署事故实证）。 */
    @Optional() private readonly runtime?: RuntimeSkillsClient,
  ) {}

  private async audit(action: string, resource: string, before: unknown, after: unknown, actor = 'system'): Promise<void> {
    await this.prisma.adminAuditLog.create({
      data: {
        actor,
        action,
        resource,
        before: before === undefined ? null : JSON.stringify(before),
        after: after === undefined ? null : JSON.stringify(after),
      },
    })
  }

  // ─── 目录与搜索（M1-A10）─────────────────────────────────────────────────────

  async getCatalog(params: { q?: string; vertical?: string; tag?: string; sort?: string; limit?: string }) {
    const sort: CatalogSort = (['comprehensive', 'usage', 'installs', 'updated'] as const).includes(
      params.sort as CatalogSort,
    )
      ? (params.sort as CatalogSort)
      : 'comprehensive'
    const limit = Math.min(Math.max(Number(params.limit ?? 50) || 50, 1), 100)
    const where = { reviewStatus: 'approved' as const }
    const rows = await this.prisma.skillCatalog.findMany({
      where,
      take: 200, // 先取候选，rankCatalog 内存排序（目录规模可控）
    })
    const packages = await this.prisma.skillPackage.findMany({
      where: { contentHash: { in: rows.map((r) => r.packageHash) } },
    })
    const pkgByHash = new Map(packages.map((p) => [p.contentHash, p]))
    let items = rows
      .map((c) => ({ catalog: c, pkg: pkgByHash.get(c.packageHash) }))
      .filter((x): x is { catalog: (typeof rows)[number]; pkg: (typeof packages)[number] } => x.pkg !== undefined)
    if (params.vertical) items = items.filter((x) => x.catalog.vertical === params.vertical)
    if (params.tag) {
      items = items.filter((x) => (JSON.parse(x.catalog.tags) as string[]).includes(params.tag as string))
    }
    if (params.q) {
      const q = params.q.toLowerCase()
      items = items.filter(
        (x) =>
          x.pkg.skill.toLowerCase().includes(q) ||
          x.pkg.displayName.toLowerCase().includes(q) ||
          x.pkg.description.toLowerCase().includes(q),
      )
    }
    const ranked = rankCatalog(
      items.map((x) => ({ ...x.catalog, _pkg: x.pkg })),
      sort,
    ).slice(0, limit)
    return {
      ...ENVELOPE,
      data: ranked.map((r) => ({
        packageHash: r.packageHash,
        skill: r._pkg.skill,
        displayName: r._pkg.displayName,
        publisher: r._pkg.publisher,
        version: r._pkg.version,
        summary: r._pkg.summary,
        description: r._pkg.description,
        vertical: r.vertical,
        tags: JSON.parse(r.tags) as string[],
        featured: r.featured,
        usageCount: r.usageCount,
        installCount: r.installCount,
        compatProfile: r._pkg.compatProfile,
        compatScore: r._pkg.compatScore,
        license: r._pkg.license,
        // 热度只作排序展示，不参与 trustLevel（P19）——目录响应不含信任字段。
      })),
    }
  }

  async search(q: string) {
    if (!q.trim()) return { ...ENVELOPE, data: [] }
    // 只返回候选，零安装副作用（M1-A10：search ≠ install）。
    const packages = await this.prisma.skillPackage.findMany({
      where: {
        OR: [
          { skill: { contains: q } },
          { displayName: { contains: q } },
          { description: { contains: q } },
        ],
      },
      take: 20,
    })
    const approved = new Set(
      (
        await this.prisma.skillCatalog.findMany({
          where: { packageHash: { in: packages.map((p) => p.contentHash) }, reviewStatus: 'approved' },
        })
      ).map((c) => c.packageHash),
    )
    return {
      ...ENVELOPE,
      data: packages.map((p) => ({
        packageHash: p.contentHash,
        skill: p.skill,
        displayName: p.displayName,
        publisher: p.publisher,
        version: p.version,
        summary: p.summary,
        license: p.license,
        inCatalog: approved.has(p.contentHash),
      })),
    }
  }

  // ─── 我的技能（M1-A1 跨用户隔离的读取面）─────────────────────────────────────

  /** 运行时内置技能清单（内置技能可发现：事实源=pi-runtime /skills，薄转发零新协议）。
   *  不落库、不进 catalog/mine 两区——内置 ≠ 用户安装（规格 §2.2）。 */
  async listRuntimeSkills() {
    if (!this.runtime) {
      const baseUrl = process.env.PI_RUNTIME_URL?.trim()
      if (!baseUrl) throw new BadRequestException('技能运行时未配置（PI_RUNTIME_URL 缺失）')
      return this.forwardRuntimeList(new PiRuntimeClient({ baseUrl }))
    }
    return this.forwardRuntimeList(this.runtime)
  }

  private async forwardRuntimeList(client: RuntimeSkillsClient) {
    try {
      const { skills } = await client.listSkills()
      return { ...ENVELOPE, data: { skills } }
    } catch (err) {
      throw new BadGatewayException(`技能运行时不可达：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async getMine(userId: string) {
    const rows = await this.prisma.userInstalledSkill.findMany({
      // N2 变异锚：where 必须带 userId —— 跨用户隔离（M1-A1）。
      where: { userId, uninstalledAt: null },
      orderBy: { installedAt: 'desc' },
    })
    const packages = await this.prisma.skillPackage.findMany({
      where: { contentHash: { in: rows.map((r) => r.pinnedHash) } },
    })
    const pkgByHash = new Map(packages.map((p) => [p.contentHash, p]))
    return {
      ...ENVELOPE,
      data: rows
        .filter((r) => pkgByHash.has(r.packageHash))
        .map((r) => {
          const p = pkgByHash.get(r.packageHash)!
          return {
            id: r.id,
            packageHash: r.packageHash,
            sourceType: r.sourceType,
            trustLevel: r.trustLevel,
            enabled: r.enabled,
            pinnedHash: r.pinnedHash,
            installedAt: r.installedAt,
            skill: p.skill,
            displayName: p.displayName,
            publisher: p.publisher,
            version: p.version,
            compatProfile: p.compatProfile,
            disableModelInvocation: p.disableModelInvocation,
            userInvocable: p.userInvocable,
          }
        }),
    }
  }

  // ─── 自定义导入（M1-A1 写入面 / A3 两通路归一）────────────────────────────────

  async importSkill(userId: string, text: string, sourceType = 'paste') {
    const pkg = await parseSkillPackageText(text)
    // 同名冲突面 = 平台精选目录里已发布的同名技能（F26：显式拒绝而非覆盖）。
    const platformRows = await this.prisma.skillPackage.findMany({
      where: { skill: pkg.skill, namespace: 'platform' },
      select: { publisher: true },
    })
    const verdict = verifyImport({ ...pkg, sourceText: text }, {
      publisher: `user-${userId}`,
      reviewedSource: false,
      sameSkillExistingPublishers: [...new Set(platformRows.map((r) => r.publisher))],
    })
    if (!verdict.ok) {
      await this.audit('skills.import.reject', `skill:${pkg.skill}`, null, {
        reasons: verdict.reasons,
        triggeredRules: verdict.triggeredRules,
      })
      throw new ForbiddenException({ reasons: verdict.reasons })
    }

    const compat = evaluateCompatibility(pkg)
    // 内容寻址：正文只存一份（同 hash 复用已有行，行不可变）。
    await this.prisma.skillPackage.upsert({
      where: { contentHash: pkg.contentHash },
      update: {},
      create: {
        contentHash: pkg.contentHash,
        publisher: `user-${userId}`,
        namespace: 'user',
        skill: pkg.skill,
        displayName: pkg.displayName,
        summary: pkg.description.slice(0, 120),
        description: pkg.description,
        version: typeof pkg.frontmatter.version === 'string' ? pkg.frontmatter.version : '0.0.0',
        frontmatter: JSON.stringify(pkg.frontmatter),
        body: pkg.body,
        license: typeof pkg.frontmatter.license === 'string' ? pkg.frontmatter.license : null,
        source: sourceType,
        disableModelInvocation: pkg.disableModelInvocation,
        // 北极星 F54 的真实 frontmatter 键是 user-invocable；camelCase 仅作兼容兜底。
        userInvocable:
          pkg.frontmatter['user-invocable'] !== false && pkg.frontmatter.userInvocable !== false,
        allowedCapabilities: JSON.stringify(
          Array.isArray(pkg.frontmatter.capabilities) ? pkg.frontmatter.capabilities : [],
        ),
        compatProfile: compat.profile,
        compatScore: compat.score,
        scanReport: JSON.stringify({ mappedActions: compat.mappedActions, unmappedActions: compat.unmappedActions }),
      },
    })

    // A3 两通路归一：paste 与 catalog 落同一张 UserInstalledSkill，仅 sourceType/trustLevel 不同。
    // 同技能旧版本：原行钉住新 hash（id 稳定，版本更新语义），新版本重置 enabled=false
    // （新内容仍是未审内容，§4.4 第 6 条）。
    const myRows = await this.prisma.userInstalledSkill.findMany({
      where: { userId, uninstalledAt: null },
    })
    const pinnedPkgs = myRows.length
      ? await this.prisma.skillPackage.findMany({
          where: { contentHash: { in: myRows.map((r) => r.packageHash) } },
        })
      : []
    const pkgByHash = new Map(pinnedPkgs.map((p) => [p.contentHash, p]))
    const stale = myRows.filter((r) => {
      const p = pkgByHash.get(r.packageHash)
      return p && p.skill === pkg.skill && p.publisher === `user-${userId}` && r.packageHash !== pkg.contentHash
    })
    if (stale.length > 0) {
      await this.prisma.userInstalledSkill.updateMany({
        where: { id: { in: stale.map((r) => r.id) } },
        data: { packageHash: pkg.contentHash, pinnedHash: pkg.contentHash, enabled: false },
      })
      await this.audit('skills.import.supersede', `skill:${pkg.skill}`, {
        superseded: stale.map((r) => r.packageHash),
      }, { packageHash: pkg.contentHash })
    }
    const existing = await this.prisma.userInstalledSkill.findUnique({
      where: { userId_packageHash: { userId, packageHash: pkg.contentHash } },
    })
    let row
    if (existing && existing.uninstalledAt === null) {
      // 幂等：同用户同 hash 已装 ⇒ 原样返回，不重复安装审计。
      row = existing
    } else if (existing) {
      // 曾装过同 hash（卸载后重导）：恢复软删行。
      row = await this.prisma.userInstalledSkill.update({
        where: { id: existing.id },
        data: { uninstalledAt: null, enabled: false },
      })
    } else {
      row = await this.prisma.userInstalledSkill.create({
        data: {
          userId,
          packageHash: pkg.contentHash,
          pinnedHash: pkg.contentHash,
          sourceType,
          trustLevel: 'unreviewed', // 未审来源默认 unreviewed；enabled=false 默认（§4.4 第 6 条）
          enabled: false,
        },
      })
      await this.audit('skills.import', `skill-user:${row.id}`, null, {
        userId,
        skill: pkg.skill,
        contentHash: pkg.contentHash,
        triggeredRules: [],
      }, `user:${userId}`)
    }
    return { ...ENVELOPE, data: { id: row.id, packageHash: row.packageHash, skill: pkg.skill, enabled: row.enabled } }
  }


  // ─── 目录安装（M1-A3 catalog 通路 / A10 install 链）───────────────────────────

  async installFromCatalog(userId: string, packageHash: string) {
    const catalog = await this.prisma.skillCatalog.findUnique({ where: { packageHash } })
    if (!catalog || catalog.reviewStatus !== 'approved') {
      throw new NotFoundException('目录中不存在该技能或未过审')
    }
    const existing = await this.prisma.userInstalledSkill.findUnique({
      where: { userId_packageHash: { userId, packageHash } },
    })
    if (existing && existing.uninstalledAt === null) {
      return { ...ENVELOPE, data: { id: existing.id, alreadyInstalled: true } }
    }
    if (existing) {
      // 重装：恢复软删行
      await this.prisma.userInstalledSkill.update({
        where: { id: existing.id },
        data: { uninstalledAt: null, enabled: false, pinnedHash: packageHash },
      })
    } else {
      await this.prisma.userInstalledSkill.create({
        data: {
          userId,
          packageHash,
          pinnedHash: packageHash,
          sourceType: 'catalog',
          trustLevel: 'reviewed', // 平台已审来源（P4）；热度不参与此判定（P19）
          enabled: false,
        },
      })
    }
    await this.prisma.skillCatalog.update({
      where: { packageHash },
      data: { installCount: { increment: 1 } },
    })
    await this.audit('skills.install', `skill-user:${packageHash}`, null, { userId, packageHash, source: 'catalog' }, `user:${userId}`)
    return { ...ENVELOPE, data: { packageHash, enabled: false } }
  }

  // ─── 启停（M1-A7：只写开关列，不碰包行；§7.2 矩阵由 runtime 通道 M1-2 落）─────

  async setEnabled(userId: string, id: string, enabled: boolean) {
    const row = await this.prisma.userInstalledSkill.findFirst({ where: { id, userId } })
    if (!row || row.uninstalledAt !== null) throw new NotFoundException('技能不存在或已卸载')
    const updated = await this.prisma.userInstalledSkill.update({
      where: { id },
      data: { enabled },
    })
    await this.audit(enabled ? 'skills.enable' : 'skills.disable', `skill-user:${id}`, { enabled: row.enabled }, { enabled }, `user:${userId}`)
    return { ...ENVELOPE, data: { id: updated.id, enabled: updated.enabled } }
  }

  // ─── 卸载（M1-A8：守卫 + 软删 + 逐项审计；卸载 ≠ 关闭）────────────────────────

  async uninstall(userId: string, ids: string[], confirmed: boolean) {
    const guard = assertUninstallGuard({ source: 'user-ui', confirmed, targets: ids })
    if (!guard.allowed) throw new BadRequestException(guard.reason)
    const rows = await this.prisma.userInstalledSkill.findMany({
      where: { id: { in: ids }, userId, uninstalledAt: null },
    })
    if (rows.length !== ids.length) throw new NotFoundException('部分技能不存在或不属于当前用户')
    const now = new Date()
    for (const r of rows) {
      // 批量卸载逐项审计（M1-A8）
      await this.prisma.$transaction([
        this.prisma.userInstalledSkill.update({ where: { id: r.id }, data: { uninstalledAt: now, enabled: false } }),
        this.prisma.adminAuditLog.create({
          data: {
            actor: 'system',
            action: 'skills.uninstall',
            resource: `skill-user:${r.id}`,
            before: JSON.stringify({ enabled: r.enabled, packageHash: r.packageHash }),
            after: JSON.stringify({ uninstalledAt: now.toISOString() }),
          },
        }),
      ])
    }
    return { ...ENVELOPE, data: { uninstalled: rows.length } }
  }

  // ─── 回滚（M1-A4：pinnedHash 切回旧版本，下一轮注入正文逐字变回）────────────────

  async rollback(userId: string, id: string) {
    const row = await this.prisma.userInstalledSkill.findFirst({ where: { id, userId } })
    if (!row || row.uninstalledAt !== null) throw new NotFoundException('技能不存在或已卸载')
    const current = await this.prisma.skillPackage.findUnique({ where: { contentHash: row.pinnedHash } })
    if (!current) throw new NotFoundException('当前版本包缺失')
    const versions = await this.prisma.skillPackage.findMany({
      where: { skill: current.skill, publisher: current.publisher },
      orderBy: { publishedAt: 'desc' },
    })
    const previous = versions.find((v) => v.contentHash !== row.pinnedHash)
    if (!previous) throw new BadRequestException('没有可回滚的历史版本')
    const updated = await this.prisma.userInstalledSkill.update({
      where: { id },
      data: { pinnedHash: previous.contentHash },
    })
    await this.audit('skills.rollback', `skill-user:${id}`, { pinnedHash: row.pinnedHash }, { pinnedHash: updated.pinnedHash }, `user:${userId}`)
    return { ...ENVELOPE, data: { id: updated.id, pinnedHash: updated.pinnedHash } }
  }

  // ─── 显式调用裁决（M1-A9；F17：与 runtime forceSkills 同管道，本端点只裁决不注入）─

  async invoke(userId: string, id: string, intent: InvocationIntent = 'explicit') {
    const row = await this.prisma.userInstalledSkill.findFirst({ where: { id, userId } })
    if (!row) throw new NotFoundException('技能不存在')
    const pkg = await this.prisma.skillPackage.findUnique({ where: { contentHash: row.pinnedHash } })
    if (!pkg) throw new NotFoundException('包缺失')
    const mode = resolveInvocationMode(
      {
        disableModelInvocation: pkg.disableModelInvocation,
        userInvocable: pkg.userInvocable,
        uninstalled: row.uninstalledAt !== null,
        reviewed: row.trustLevel === 'reviewed',
        enabled: row.enabled,
      },
      intent,
    )
    if (mode === 'denied') {
      await this.audit('skills.invoke.reject', `skill-user:${id}`, null, { intent, skill: pkg.skill })
      const intentLabel = intent === 'implicit' ? '自动' : intent === 'routed' ? '路由' : '显式'
      throw new ForbiddenException(`技能当前不可被${intentLabel}调用`)
    }
    return { ...ENVELOPE, data: { mode, skill: pkg.skill, packageHash: pkg.contentHash } }
  }

  // ─── M1-3 发起方接线：buildSkillResources(userId) ──────────────────────────────

  /**
   * 组装该用户当前已启用的技能为上游 `Skill[]`（计划 §2 决策 1 / v2 §5.4）。
   * Nest 在 `/sessions` create 时调用，结果放进 body.resources.skills 透传给 runtime；
   * runtime 不查 Nest、不出网。contentHash 逐字校验（正文被篡改 ⇒ 跳过，fail-closed）。
   *
   * ⚠️ 只查 enabled=true 且未卸载的行；返回直接是可 JSON 序列化的上游 Skill[]（能在 4MB bodyLimit 内）。
   */
  async buildSkillResources(userId: string): Promise<Array<import('@earendil-works/pi-agent-core').Skill>> {
    const rows = await this.prisma.userInstalledSkill.findMany({
      where: { userId, uninstalledAt: null },
      orderBy: { installedAt: 'desc' },
    })
    if (rows.length === 0) return []
    const hashes = [...new Set(rows.map((r) => r.pinnedHash))]
    const packages = await this.prisma.skillPackage.findMany({ where: { contentHash: { in: hashes } } })
    const pkgByHash = new Map(packages.map((p) => [p.contentHash, p]))
    const resRows: SkillResourceRow[] = []
    for (const r of rows) {
      const pkg = pkgByHash.get(r.pinnedHash)
      if (!pkg) continue
      // contentHash 协议（计划 §8.1）：sha256("v1:"+skill+":"+body.trimEnd())；不符 = 正文被篡改 ⇒ 跳过。
      if (sha256Hex(`v1:${pkg.skill}:${pkg.body.trimEnd()}`) !== pkg.contentHash) continue
      resRows.push({
        skill: pkg.skill,
        displayName: pkg.displayName,
        summary: pkg.summary,
        body: pkg.body,
        disableModelInvocation: pkg.disableModelInvocation,
        enabled: r.enabled,
        installedAt: r.installedAt,
      })
    }
    return assembleSkillResources(resRows)
  }

  // ─── 详情（兼容评分与不可用动作清单，§6.6）─────────────────────────────────────

  async getDetail(userId: string, id: string) {
    const row = await this.prisma.userInstalledSkill.findFirst({ where: { id, userId } })
    if (!row) throw new NotFoundException('技能不存在')
    const pkg = await this.prisma.skillPackage.findUnique({ where: { contentHash: row.pinnedHash } })
    if (!pkg) throw new NotFoundException('包缺失')
    return {
      ...ENVELOPE,
      data: {
        id: row.id,
        skill: pkg.skill,
        displayName: pkg.displayName,
        publisher: pkg.publisher,
        version: pkg.version,
        compatProfile: pkg.compatProfile,
        compatScore: pkg.compatScore,
        scanReport: JSON.parse(pkg.scanReport) as Record<string, unknown>,
        license: pkg.license,
        enabled: row.enabled,
        trustLevel: row.trustLevel,
        sourceType: row.sourceType,
        pinnedHash: row.pinnedHash,
        userModified: row.userModified,
        installedAt: row.installedAt,
        uninstalledAt: row.uninstalledAt,
      },
    }
  }
}
