#!/usr/bin/env tsx
/**
 * 存量用户「可选音频模型」回填（一次性运维脚本，dry-run 默认）。
 * spec: docs/superpowers/specs/2026-10-06-audio-node-unified-capability-design.md
 * runbook: docs/ops/RUNBOOK-audio-model-backfill.md（何时跑 / 怎么核对 / 怎么回滚）
 *
 * 背景：画布「音」节点新增 `design` / `music` 两个分类，依赖两条新模型
 * （`stepaudio-3-gen-preview` / `stepaudio-3-music-preview`）。但新模型只进
 * `STUDIO_MODEL_CATALOG`，落库只发生在 `ensurePreferences` 的 **create 分支** ⇒
 * 存量用户的 `selectableAudioModels` 与平台渠道 `models` 都是历史快照。
 * 前端按 kind 过滤后交集为空 ⇒ 用户点「音乐」chip 只会切 kind 不换模型 ⇒ 服务端必撞 400。
 * `apps/web` 也没有任何地方调 `providerApi.updatePreferences` ⇒ 用户无处可去。
 *
 * ⛔ 为什么**不**改 `ensurePreferences` / `ensurePlatformChannel` 自动补齐：
 * DB 里「用户主动停用某模型」与「该模型是新上架的」同形（都是快照里少一条），
 * 自动补齐会复活用户主动停用的模型。只能走一次性人工口径的脚本。
 *
 * 用法（生产容器内）：
 *   # 1) 先看会改什么（不写库）—— 这是默认模式
 *   docker exec -i lnkpi-api sh -c 'cd /app/apps/server && node_modules/.bin/tsx scripts/backfill-audio-models.ts'
 *   # 2) 人工核对上面的 added 列表后写库（会先自动备份 *.db）
 *   docker exec -i lnkpi-api sh -c '... --apply'
 *   # 3) 再跑一次（不带 --apply）确认 0 变更 ⇒ 幂等
 *
 * ⚠️ 脚本必须放在 `apps/server/scripts/`（与 `backfill-point-transactions.ts` 同处）：
 * 仓库根的 `scripts/` 会经 pnpm 的隐藏提升目录解析到**主仓**的 `packages/shared`
 * （本 worktree 里实测：根目录跑只看到 4 条 audio，apps/server 下跑才是 6 条），
 * 于是回填会按**旧目录**补齐、漏掉本次的新模型。放错位置 = 静默补漏。
 *
 * 安全约束：
 * - dry-run 是默认，必须显式 --apply 才写
 * - 写库前自动备份 *.db（同目录 .bak-<ts>）
 * - 幂等：已是目标态的行不写，重复跑结果不变
 * - 口径：只并入「目录里有、快照里没有」的条目，绝不删除/重排快照已有条目
 *   （含用户主动停用后留下的其他条目、BYOK 自定义模型）。代价见 runbook §4。
 */
import { copyFileSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { STUDIO_MODEL_CATALOG, encodeChannelModel } from '@lnkpi/shared'
import {
  planAudioModelBackfill,
  planPlatformChannelSync,
  type AudioModelBackfillInputRow,
} from '../src/provider/audio-model-backfill.js'

const APPLY = process.argv.includes('--apply')
const PLATFORM_CHANNEL_ID = 'platform'

/** 目录的 audio 桶，按目录给定序编码 —— 顺序稳定是幂等的前提之一。 */
const CATALOG_AUDIO_ENCODED = STUDIO_MODEL_CATALOG.filter((e) => e.modality === 'audio').map((e) =>
  encodeChannelModel(PLATFORM_CHANNEL_ID, e.modelKey),
)
/** 平台渠道的 models 是全模态目录镜像（不只是 audio）。 */
const CATALOG_ALL_MODELS = STUDIO_MODEL_CATALOG.map((e) => ({
  name: e.modelKey,
  capability: e.modality,
}))

async function main() {
  const prisma = new PrismaClient()
  try {
    const rows = (await prisma.userAiPreferences.findMany({
      select: { userId: true, selectableAudioModels: true },
      orderBy: { userId: 'asc' },
    })) as AudioModelBackfillInputRow[]
    const platform = await prisma.providerChannel.findUnique({ where: { id: PLATFORM_CHANNEL_ID } })

    console.log(
      `[backfill] 偏好行 ${rows.length} 条 / 平台渠道 ${platform ? '存在' : '不存在'}｜` +
        `模式=${APPLY ? 'APPLY（会写库）' : 'DRY-RUN（不写库）'}`,
    )
    console.log(`[backfill] 目录 audio 桶 ${CATALOG_AUDIO_ENCODED.length} 条：${CATALOG_AUDIO_ENCODED.join(', ')}`)

    const plan = planAudioModelBackfill(rows, CATALOG_AUDIO_ENCODED)
    for (const p of plan) {
      if (!p.changed) continue
      console.log(`CHANGE ${p.userId.padEnd(28)} +${p.added.length}  ${p.added.join(', ')}`)
    }
    const changes = plan.filter((p) => p.changed)
    const kept = plan.length - changes.length
    console.log(
      `[backfill] 用户快照：${changes.length} 条待写 / ${kept} 条已是目标态` +
        (changes.length ? '' : '（无需回填）'),
    )

    // 平台渠道：只对齐 id='platform' 这一行；用户渠道（userId != null）一律不碰。
    const channelPlan = platform
      ? planPlatformChannelSync(platform.models, CATALOG_ALL_MODELS)
      : null
    if (!platform) {
      console.log(
        '[backfill] 平台渠道不存在 ⇒ 无需同步（下次 ensurePlatformChannel 的 create 分支会' +
          '用当前目录建行，已含新模型）。',
      )
    } else if (channelPlan) {
      console.log(
        `[backfill] 平台渠道 models：${channelPlan.changed ? '待同步' : '已一致'} —— ${channelPlan.reason}`,
      )
    }

    if (!APPLY) {
      const total = changes.length + (channelPlan?.changed ? 1 : 0)
      console.log(`[backfill] DRY-RUN 结束：${total} 处待写。加 --apply 执行。`)
      return
    }
    if (changes.length === 0 && !channelPlan?.changed) {
      console.log('[backfill] 无需写入（已是目标态）。')
      return
    }

    // 写库前备份
    const dbPath = process.env.DATABASE_URL?.replace(/^file:/, '') ?? '/app/apps/server/data/lnkpi.db'
    const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(dbPath, backup)
    console.log(`[backfill] 已备份 ${dbPath} → ${backup}`)

    const before = rows.length
    for (const p of changes) {
      await prisma.userAiPreferences.update({
        where: { userId: p.userId },
        data: { selectableAudioModels: JSON.stringify(p.target) },
      })
    }
    if (channelPlan?.changed) {
      await prisma.providerChannel.update({
        where: { id: PLATFORM_CHANNEL_ID },
        data: { models: JSON.stringify(channelPlan.target) },
      })
      console.log(`[backfill] 平台渠道 models 已同步（${channelPlan.target.length} 条）`)
    }
    const after = await prisma.userAiPreferences.count()
    console.log(`[backfill] 写入用户快照 ${changes.length} 行；偏好行数 ${before} → ${after}`)
    // 只增不删 ⇒ 行数必须守恒。变了说明有并发删除/插入，重跑一次即可收敛。
    if (before !== after) console.warn(`[backfill] 警告：偏好行数变化 ${before} → ${after}（并发写入？请重跑核对）`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error('[backfill] 失败：', e instanceof Error ? e.message : e)
  process.exit(1)
})
