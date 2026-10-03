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

/** 规则表刻意写成显式常量而非模糊匹配：回填结果要能人工复核。 */
export const USER_RULES: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /暗号|密码|口令|凭据|账号|密钥|token|secret|api[\s_-]?key/i, reason: '凭据级内容，必须留user 层' },
  { re: /品牌色|配色|字体|偏好|喜欢|习惯|以后|永远|默认用|风格偏/, reason: '用户偏好，跨画布有效' },
  { re: /\d{3,4}\s*[x×*]\s*\d{3,4}|分辨率|尺寸|画幅|比例/, reason: '交付规格偏好，跨画布有效' },
]

export const CANVAS_RULES: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /项目信息|项目设定|项目资料/, reason: '项目知识' },
  { re: /角色设定|角色|主角|配角|人物/, reason: '角色设定' },
  { re: /剧本|分镜|台词|场景|集/, reason: '剧本/分镜' },
]

export function classifyMemory(content: string): ClassifyResult {
  const text = content ?? ''
  for (const rule of USER_RULES) {
    if (rule.re.test(text)) return { scope: 'user', reason: rule.reason }
  }
  for (const rule of CANVAS_RULES) {
    if (rule.re.test(text)) return { scope: 'canvas', reason: rule.reason }
  }
  return { scope: 'user', reason: '判不出归属，保守留 user' }
}

export interface BackfillInputRow {
  id: string
  scope: string
  sessionId: string | null
}

export interface BackfillPlanRow extends BackfillInputRow {
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
export function planBackfill(rows: BackfillInputRow[], liveSessions: Set<string>): BackfillPlanRow[] {
  return rows.map((row) => {
    // 已是 user 层：目标态，什么都不改
    if (row.scope !== 'canvas') {
      return { ...row, scope: 'user', sessionId: null, reason: '已是用户级，保持', changed: false }
    }
    if (!row.sessionId) {
      return { ...row, scope: 'user', sessionId: null, reason: '归属为空，回退 user（悬空 canvas 召回时会被fail-closed）', changed: true }
    }
    if (!liveSessions.has(row.sessionId)) {
      // Review Focus #5：画布已被删 ⇒ 回退 user，不留指向不存在 Session 的归属
      return { ...row, scope: 'user', sessionId: null, reason: `画布已不存在（${row.sessionId}），回退 user`, changed: true }
    }
    return { ...row, scope: 'canvas', sessionId: row.sessionId, reason: '归属有效，保持画布级', changed: false }
  })
}

/** 供 CLI 打印的分类明细（不含写库动作）。 */
export function formatPlan(
  rows: Array<BackfillInputRow & { content: string }>,
  liveSessions: Set<string>,
): BackfillPlanRow[] {
  const plan = planBackfill(rows, liveSessions)
  const byId = new Map(rows.map((r) => [r.id, r.content]))
  return plan.map((p) => ({ ...p, reason: `${p.reason}｜${(byId.get(p.id) ?? '').slice(0, 40)}` }))
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
