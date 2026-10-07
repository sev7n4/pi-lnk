/**
 * 存量用户「可选音频模型」回填的**纯逻辑**部分（IO 在 scripts/backfill-audio-models.ts）。
 *
 * 背景（spec: docs/superpowers/specs/2026-10-06-audio-node-unified-capability-design.md）：
 * 画布「音」节点新增 `design` / `music` 两个分类，依赖两条**新模型**
 * （`stepaudio-3-gen-preview` / `stepaudio-3-music-preview`）。但新模型只进
 * `STUDIO_MODEL_CATALOG`，落库只发生在 `ProviderService.ensurePreferences` 的 **create 分支**
 * —— 存量用户的 `UserAiPreferences.selectableAudioModels` 与平台渠道 `models` 都是**历史快照**。
 * 前端按 kind 过滤后交集为空 ⇒ 用户点「音乐」chip 只会切 kind 不换模型 ⇒ 服务端必撞 400。
 *
 * ⛔ 为什么**不能**改 `ensurePreferences` / `ensurePlatformChannel` 自动补齐：
 * DB 里「用户主动停用某模型」与「该模型是新上架的」**无法区分**（前者表现为快照里少一条，
 * 后者也表现为快照里少一条）。自动补齐会复活用户主动停用的模型。
 * 所以只能走**一次性人工口径的脚本**：跑一次、留下审计记录、之后不再自动执行。
 *
 * 为什么纯逻辑放在 server 包里而不是 `scripts/`：`scripts/` 不属于任何 workspace package，
 * vitest 跑不到 ⇒ 写在那儿的测试永远不会被执行（假保障）。这里能被 `pnpm test:server` 覆盖。
 */

/** 回填的输入行：DB 真实值。 */
export interface AudioModelBackfillInputRow {
  userId: string
  /**
   * DB 里的真实当前值（`UserAiPreferences.selectableAudioModels`，JSON 字符串）。
   *
   * ⚠️ 字段名**必须**与 Prisma 的列名逐字一致。历史教训（`memory-scope-classify` 的终审 C-2）：
   * 入参字段名与调用方实际持有的字段不一致时，纯函数读到的恒是 `undefined` ⇒
   * 「解析失败 ⇒ 当空数组」分支把**每一行**都判成待写，且 `target` 变成完整目录 ——
   * 脚本看起来跑了、dry-run 也有输出，实则已丢失全部用户既有选择。
   */
  selectableAudioModels: string
}

export interface AudioModelBackfillPlanRow {
  userId: string
  /** 回填后的目标值（已按目录顺序去重后的完整数组）。 */
  target: string[]
  /** 本次**新增**的条目（编码后的 `platform::<modelKey>`）。空数组 = 已是目标态。 */
  added: string[]
  /** 是否需要写库。false 时脚本跳过 —— 这是幂等的来源。 */
  changed: boolean
  reason: string
}

/**
 * 🔴 对「用户主动停用」的明确口径（可审计、可复现）：
 *
 * **只并入「目录里存在、但该用户快照里没有」的条目；绝不删除、绝不重排快照里已有的条目。**
 *
 * 后果（必须让运维知道，见 docs/ops/RUNBOOK-audio-model-backfill.md）：
 * - 用户**主动停用**的模型，只要它仍在目录里，就会被这次回填**重新加回来**。
 *   这是「一次性人工口径」的已知代价：新上架与主动停用在 DB 里同形，无法自动区分。
 *   脚本因此在 dry-run 里逐用户打印 `added`，让人工在 apply 前核对。
 * - 用户**主动停用**一个已被从目录**移除**的模型：不受影响（目录里没有 ⇒ 不会并入）。
 * - BYOK 自定义模型（`ch_xxx::custom`）不在目录里 ⇒ 快照原样保留，不会被本脚本碰到。
 */
export function planAudioModelBackfill(
  rows: readonly AudioModelBackfillInputRow[],
  /** 目录里 audio 桶的全部模型（已编码成 `platform::<modelKey>`）。 */
  catalogEncodedModels: readonly string[],
): AudioModelBackfillPlanRow[] {
  return rows.map((row) => {
    const current = parseStringArray(row.selectableAudioModels)
    const currentSet = new Set(current)
    // 目录里存在但快照里没有的 ⇒ 新增。顺序按目录给定序，稳定 ⇒ 跑两次结果一致。
    const added = catalogEncodedModels.filter((m) => !currentSet.has(m))
    if (added.length === 0) {
      return { userId: row.userId, target: current, added: [], changed: false, reason: '已是目标态' }
    }
    return {
      userId: row.userId,
      // 已有条目在前（保持用户既有顺序，不重排），新增条目追加在后。
      target: [...current, ...added],
      added,
      changed: true,
      reason: `并入目录中新上架的 ${added.length} 条`,
    }
  })
}

/**
 * 平台渠道 `models` 的同步计划。
 *
 * 口径与用户快照**不同**，因为语义不同：平台渠道是**只读的系统目录镜像**
 * （`updateChannel` 对 `platform` 直接抛 Forbidden），用户无法个性化它 ⇒
 * 它的正确状态就是「等于当前目录」，直接对齐即可。
 * 用户渠道（`userId != null`）**一律不碰** —— 那是用户自己配置的。
 */
export interface PlatformChannelSyncPlan {
  /** 目标值（序列化前的数组）。 */
  target: { name: string; capability: string }[]
  /** 是否需要写库。 */
  changed: boolean
  reason: string
}

export function planPlatformChannelSync(
  dbModelsJson: string,
  catalogModels: readonly { name: string; capability: string }[],
): PlatformChannelSyncPlan {
  const current = parseModelEntries(dbModelsJson)
  const same =
    current.length === catalogModels.length &&
    current.every(
      (m, i) => m.name === catalogModels[i]!.name && m.capability === catalogModels[i]!.capability,
    )
  if (same) {
    return { target: current, changed: false, reason: '已与目录一致' }
  }
  return {
    target: catalogModels.map((m) => ({ name: m.name, capability: m.capability })),
    changed: true,
    reason: `平台渠道目录镜像落后：${current.length} 条 → ${catalogModels.length} 条`,
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    // 存量脏数据：解析不出来就当空数组处理，但仍会把目录条目补进去（保守向可用性倾斜）。
    // ⚠️ 这会**丢弃**该用户原本的（无法解析的）选择 —— 脚本会把它计入 changed 并在
    // dry-run 打印出来，apply 前必须核对。
    return []
  }
}

function parseModelEntries(raw: string): { name: string; capability: string }[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is { name: string; capability: string } =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { name?: unknown }).name === 'string' &&
        typeof (item as { capability?: unknown }).capability === 'string',
    )
  } catch {
    return []
  }
}
