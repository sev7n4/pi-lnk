/**
 * 记忆作用域回填的**纯逻辑**部分（IO 在 scripts/backfill-memory-scope.ts）。
 * spec: docs/superpowers/specs/2026-10-03-agent-memory-scope-isolation-design.md §7
 *
 * 为什么放在 server 包里而不是 scripts/：`scripts/` 不属于任何 workspace package，
 * vitest 跑不到 ⇒ 写在那儿的测试永远不会被执行（假保障）。这里能被 `pnpm test:server` 覆盖。
 *
 * 分类原则（顺序即优先级）：
 * 1. 凭据 / 偏好 / 交付规格 ⇒ user（安全侧优先，哪怕同一条里也有项目词）
 * 2. 明确的项目 / 角色 / 剧本 / 分镜知识 ⇒ canvas
 * 3. 判不出来 ⇒ user（保守，先不丢；source='promoted' 留痕供后续人工看）
 * 另外：归属画布已不存在的行必须回退 user，不留悬空 canvas（召回时它本来也 fail-closed）。
 */

export interface ClassifyResult {
  scope: 'canvas' | 'user'
  reason: string
}

/**
 * 规则表刻意写成显式常量而非模糊匹配：回填结果要能人工复核。
 *
 * 分三档（终审 I-2 修正）：
 * - CREDENTIAL_RULES：凭据级，**最高优先级**，同句含项目词也仍判 user（安全侧不可让步）
 * - CANVAS_RULES：项目知识判定
 * - PREFERENCE_RULES：偏好/交付规格，**仅在不含项目词时**才判 user
 *   （原实现把偏好词排在项目词之前，导致「小柚以后都用齐刘海低马尾」这类**项目知识**
 *    被降级成跨画布可见 —— 那正是 G1 要禁止的方向）
 */
export const CREDENTIAL_RULES: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /暗号|密码|口令|凭据|账号|密钥|token|secret|api[\s_-]?key|门禁码|\bpin\b/i, reason: '凭据级内容，必须留 user 层' },
]

export const CANVAS_RULES: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /项目信息|项目设定|项目资料|本项目|本剧/, reason: '项目知识' },
  // 剧名（《…》/「…」/书名号）是最强的项目信号——它出现即说明说的是某个具体项目
  { re: /《[^》]{2,}》/, reason: '具体项目名' },
  { re: /角色设定|角色档案|角色\s*bible|主角|配角|人物/, reason: '角色设定' },
  // 「集」单字会命中「合集 / 集合 / 素材集」这类泛化词，收窄为集数表述
  { re: /剧本|分镜|台词|第\s*\d+\s*集|全集|\d+\s*集|ep\d+/i, reason: '剧本/分镜' },
]

export const PREFERENCE_RULES: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /品牌色|配色|字体|偏好|喜欢|习惯|以后|永远|默认用|风格偏/, reason: '用户偏好，跨画布有效' },
  { re: /\d{3,4}\s*[x×*]\s*\d{3,4}|分辨率|尺寸|画幅|比例/, reason: '交付规格偏好，跨画布有效' },
]

/** 旧名（凭据 + 偏好的合集），保留供文档/调试引用；判定逻辑请用 classifyMemory。 */
export const USER_RULES: ReadonlyArray<{ re: RegExp; reason: string }> = [...CREDENTIAL_RULES, ...PREFERENCE_RULES]

export function classifyMemory(content: string): ClassifyResult {
  const text = content ?? ''
  // 1) 凭据最高优先：同句含项目词也仍留 user（凭据跨画布可达是 spec 明确要的 G3）
  for (const rule of CREDENTIAL_RULES) {
    if (rule.re.test(text)) return { scope: 'user', reason: rule.reason }
  }
  // 2) 项目词命中即判 canvas（含「项目里的偏好」——它描述的是这个项目，不是用户本人）
  for (const rule of CANVAS_RULES) {
    if (rule.re.test(text)) return { scope: 'canvas', reason: rule.reason }
  }
  // 3) 无项目词时，偏好 / 交付规格判 user
  for (const rule of PREFERENCE_RULES) {
    if (rule.re.test(text)) return { scope: 'user', reason: rule.reason }
  }
  return { scope: 'user', reason: '判不出归属，保守留 user' }
}

/**
 * 回填的一行：DB 真实值与目标值必须**分开**传。
 *
 * 终审 C-2：原实现只有一个 `scope`，语义是「DB 旧值」；调用方（scripts/backfill-memory-scope.ts）
 * 却把 `classifyMemory` 的**判定值**当入参传⇒ `changed` 恒为 false（两边看起来都没变），
 * `--apply` 一行都不写，目标态只存在于打印输出里。
 */
export interface BackfillTargetRow {
  id: string
  /** DB 里的真实当前值（来自 agent_memories.scope）。 */
  dbScope: string
  dbSessionId: string | null
  /** 目标值（classifyMemory 判定 + 人工映射的结果）。 */
  targetScope: 'canvas' | 'user'
  targetSessionId: string | null
}

export interface BackfillPlanRow {
  id: string
  /** 回填后的目标作用域。 */
  scope: 'canvas' | 'user'
  sessionId: string | null
  reason: string
  /** 是否需要写库（false = 已是目标态，脚本跳过，天然幂等）。 */
  changed: boolean
}

/**
 * 计算回填计划。`liveSessions` 是仍存在的画布 id 集合（从 Session 表读）。
 * 纯函数：不碰 DB，便于在测试里穷举边界。
 */
export function planBackfill(rows: BackfillTargetRow[], liveSessions: Set<string>): BackfillPlanRow[] {
  return rows.map((row) => {
    const target: BackfillPlanRow = { id: row.id, scope: 'user', sessionId: null, reason: '', changed: false }
    if (row.targetScope === 'canvas') {
      if (!row.targetSessionId) {
        target.reason = '归属为空，回退 user（悬空 canvas 召回时会被 fail-closed）'
      } else if (!liveSessions.has(row.targetSessionId)) {
        // Review Focus #5：画布已被删 ⇒ 回退 user，不留指向不存在 Session 的归属
        target.reason = `画布已不存在（${row.targetSessionId}），回退 user`
      } else {
        target.scope = 'canvas'
        target.sessionId = row.targetSessionId
        target.reason = '归属有效，落画布级'
      }
    } else {
      target.reason = '判为跨会话内容，留 user'
    }
    // changed = 目标与 DB **真实值**有差异（这才是「需要写库」）
    target.changed = target.scope !== row.dbScope || target.sessionId !== (row.dbSessionId ?? null)
    if (!target.changed) target.reason += '（已是目标态）'
    return target
  })
}

/**
 * 人工归属映射：`关键词 → 画布 id`。
 *
 * 为什么需要它：生产存量记忆表里**没有 sessionId**（这列本来就是这次迁移才加的），
 * 而 `Session.title` 在生产上几乎全是 `layout-smoke-<ts>` 这类自动化噪声
 * （连 2026-10-02 事故画布 `cmur1im5y0002lk01vukfb949` 的标题都是 layout-smoke-1790950215），
 * 所以**无法自动反推**某条项目知识属于哪个画布。分类判出 canvas 但找不到归属时只能留 user，
 * 由人给出「项目名 → 画布 id」的映射才能真正收紧。
 *
 * 键是子串（对记忆内容做 includes 匹配），第一个命中的键生效；命中的画布不存在则抛错。
 *
 * ⚠️ 参数名是 `judgedScope` 而不是 `scope`：调用方手上通常有两个 scope
 * （DB 里的旧值 vs classifyMemory 的判定结果），用 `scope` 这种泛名极易传错字段——
 * 实测传错时映射会静默 0 命中（`r.scope !== 'canvas'` 恒成立），回填"看起来跑了"却什么都没收紧。
 */
export function applyManualMap(
  rows: ReadonlyArray<{ id: string; content: string; judgedScope: 'canvas' | 'user' }>,
  map: Record<string, string>,
  liveSessions: Set<string>,
): Map<string, string> {
  const entries = Object.entries(map)
  const out = new Map<string, string>()
  for (const r of rows) {
    if (r.judgedScope !== 'canvas') continue
    for (const [keyword, sessionId] of entries) {
      if (r.content.includes(keyword)) {
        if (!liveSessions.has(sessionId)) {
          throw new Error(`映射「${keyword}」指向的画布 ${sessionId} 不存在，拒绝对齐（防悬空归属）`)
        }
        out.set(r.id, sessionId)
        break
      }
    }
  }
  return out
}
