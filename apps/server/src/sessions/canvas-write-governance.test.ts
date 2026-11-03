import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * P1-C 写路径治理守卫（规格 docs/superpowers/specs/2026-11-02-p1c-write-path-governance-design.md §4）。
 *
 * 规则：服务端写画布节点数据必须走合规通道——op 语义 + 事务 + stagedActions 守卫
 * （共享通道 `sessions/canvas-op-write.ts` 的 transactGovernedCanvasOps，或 persist 家族
 * 同款事务内 applier 模式）。禁止新增「事务外 read-modify-write 整份 canvasData」的侧道写者。
 *
 * 判据（行为级 + 扫全目录）：
 * - 写点签名 = `canvasData: JSON.stringify(...)`（整份序列化覆盖）
 *   或 `canvasData: <expr>.canvasData,`（行级 copy-through；带 `? JSON.parse` 的格式化/读取行不匹配）。
 * - 每个非测试 .ts 文件的写点数必须等于白名单登记值。新增写点 → 本测试失败，
 *   除非 (a) 迁移到 transactGovernedCanvasOps / persist 家族模式后在白名单登记，或
 *   (b) 属 session.create 创建时种子/整份拷贝（无丢更新面），登记时注明。
 * - 白名单每一项必须写明合规理由；改白名单 = 审计动作，PR 里必须给出依据。
 */

const SRC_DIR = fileURLToPath(new URL('../', import.meta.url))

/** 匹配「整份画布覆盖写」：JSON.stringify 序列化、行级 copy-through 赋值、
 *  裸局部变量赋值（历史 `canvas.service.update` 用 `data: { ...data, canvasData }`
 *  spread 形态逃过前两类签名——C2② 关 PUT 时补上，防同类形态复发） */
const WRITE_SITE =
  /canvasData\s*:\s*(JSON\.stringify\b|[A-Za-z_$][\w.$]*\.canvasData\s*(?:,|$)|canvasData\b\s*(?:,|$))/

/** 白名单：文件（相对 apps/server/src）→ 登记写点数 → 合规理由 */
const ALLOWLIST: Record<string, { expected: number; reason: string }> = {
  'sessions/canvas-op-write.ts': {
    expected: 1,
    reason: '合规通道本体：transactGovernedCanvasOps（事务内读→op 语义→事务内写回+staged 守卫）',
  },
  'agent/agent-canvas-tools.service.ts': {
    expected: 5,
    reason: 'persist 家族：事务 + stagedActions 409 + applier（C1 之前的既合规范式）',
  },
  'agent/agent.service.ts': {
    expected: 1,
    reason: 'finalizeTurn rewriteCanvasData 分支：applier op 语义（现无 rewriteCanvasData:true 调用方，保留兜底）',
  },
  'sessions/sessions.service.ts': {
    expected: 2,
    reason:
      ':171 PATCH /sessions/:id/canvas 主通道（op 语义 + 白名单）；' +
      ':202 duplicate() 的 session.create 整份拷贝（新建，无丢更新面）。' +
      '（PUT 弃用期写点已于 2026-11-03 C2② 关闭删除——带 canvasData 的 PUT 现只打 canvas_put_rejected 不落库）',
  },
  'sessions/sessions-canvas-node-status.service.ts': {
    expected: 1,
    reason: 'B2/B3 状态机对账：事务 + staged skip + 状态机（审计已合规）',
  },
  'stories/stories.service.ts': {
    expected: 1,
    reason: 'create() 的 session.create 种子画布（新建，text-1 种子节点，无丢更新面）',
  },
  'works/works.service.ts': {
    expected: 1,
    reason: 'forkCanvas() 的 session.create 整份拷贝（新建副本，无丢更新面）',
  },
}

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full))
      continue
    }
    if (name.endsWith('.test.ts') || name.endsWith('.spec.ts') || !name.endsWith('.ts')) continue
    out.push(full)
  }
  return out
}

describe('canvas-write-governance（服务端画布写合规守卫）', () => {
  it(
    '全部 canvasData 写点必须在白名单内且数量一致',
    () => {
    const violations: string[] = []
    const seen = new Map<string, number>()

    for (const file of listTsFiles(SRC_DIR)) {
      const rel = relative(SRC_DIR, file).split('\\').join('/')
      const lines = readFileSync(file, 'utf8').split('\n')
      let count = 0
      lines.forEach((line, i) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
        if (WRITE_SITE.test(line)) {
          count += 1
          if (!ALLOWLIST[rel]) {
            violations.push(
              `${rel}:${i + 1} 未登记的画布写点 → ${trimmed.trim()}\n` +
                `  服务端写画布必须走合规通道（op 语义 + 事务 + stagedActions 守卫）：\n` +
                `  复用 sessions/canvas-op-write.ts 的 transactGovernedCanvasOps，\n` +
                `  或 persist 家族同款事务内 applier 模式；session.create 种子/拷贝除外。\n` +
                `  规格见 docs/superpowers/specs/2026-11-02-p1c-write-path-governance-design.md`,
            )
          }
        }
      })
      if (count > 0) seen.set(rel, count)
    }

    expect(violations, violations.join('\n\n')).toEqual([])

    // 白名单里的文件若写点消失/数量漂移，也要报——防止白名单腐化成摆设
    for (const [rel, { expected, reason }] of Object.entries(ALLOWLIST)) {
      const actual = seen.get(rel) ?? 0
      expect(
        actual,
        `${rel} 登记写点数 ${expected} 与实际 ${actual} 不符；合规理由：${reason}\n` +
          `若写点已合法迁移/删除，请同步更新 canvas-write-governance.test.ts 白名单（审计动作）`,
      ).toBe(expected)
    }
    },
    // 全目录扫描 ~千文件（4 核共享机），默认 5s 会抖红
    { timeout: 30_000 },
  )
})
