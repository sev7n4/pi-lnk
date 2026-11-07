/**
 * Canvas Digest 挂载契约（2026-11-06 线上事故回归守卫）。
 *
 * 事故形态：`57cf1488b`（真实流量三连修）用落后基线的 agent.service.ts 覆盖，
 * 把 PR #739 的四块挂载整块冲掉；DI 仍注册、工具仍实现 upsertDigestNode、前端仍
 * 渲染 digest 磁贴，**唯独零调用点** ⇒ 线上任何会话都不生成「画布总览」，
 * 而既有 2529 个测试全绿（服务自身的单测只测 maybeRender，不测「谁调用它」）。
 *
 * ⇒ 本测试两侧同时钉住，缺一不可：
 *   - 静态接线（AST，不认注释/字符串）：import / 构造注入 / 两处 maybeRender /
 *     owner 流 yield / module provide —— 拦「整文件 stale 覆盖」这一事故形态；
 *   - 行为可达：真实调用 out-of-turn 收束路径，断言 maybeRender 被触发、
 *     flag off 不触发、抛错 fail-soft 不冒泡 —— 拦「只剩注释和符号」的假接线。
 */
import 'reflect-metadata'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { AgentService, type OutOfTurnRunSnapshot } from './agent.service'
import type { CanvasAction } from '@lnkpi/shared'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVICE_FILE = join(HERE, 'agent.service.ts')
const MODULE_FILE = join(HERE, 'agent.module.ts')

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

/** 纯文本兜底：确认「全目录只有一份生产 agent.service.ts」的假设没被打破。 */
function productionServiceFiles(): string[] {
  return readdirSync(HERE).filter(
    (f) => /^agent\.service.*\.ts$/.test(f) && !f.includes('.test.'),
  )
}

type DrainRunner = {
  persistOutOfTurnTurn(
    sessionId: string,
    threadKey: string,
    userId: string | undefined,
    snapshot: OutOfTurnRunSnapshot,
  ): Promise<void>
}

function makeService(digest: unknown): AgentService {
  const service = new AgentService(
    {} as ConstructorParameters<typeof AgentService>[0],
    {} as ConstructorParameters<typeof AgentService>[1],
    {} as ConstructorParameters<typeof AgentService>[2],
  )
  // 生产走 Nest DI 注入；单测直接落字段，避免为 13 个 @Optional 依赖造替身。
  Object.assign(service, { canvasDigest: digest })
  return service
}

/** update_node ⇒ persistCanvasEntities 全 continue，行为测试不触碰 prisma。 */
function snapshot(): OutOfTurnRunSnapshot {
  const action: CanvasAction = { type: 'update_node', payload: { id: 'n1', data: {} } }
  return { runId: '', assistantText: '', canvasActions: [action] }
}

describe('Canvas Digest 挂载契约', () => {
  it('agent.service.ts：import / 构造注入 / drain+owner 两处调用 / owner 流 yield 全在位', () => {
    const sf = parse(SERVICE_FILE)
    let hasImport = false
    let hasInjection = false
    let ownerYieldBlock = false
    let maybeRenderCalls = 0

    walk(sf, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === './canvas-digest.service'
      ) {
        const bindings = node.importClause?.namedBindings
        hasImport =
          hasImport ||
          (!!bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.some((e) => e.name.text === 'CanvasDigestService'))
      }
      if (ts.isConstructorDeclaration(node)) {
        hasInjection =
          hasInjection ||
          node.parameters.some(
            (p) =>
              ts.isIdentifier(p.name) &&
              p.name.text === 'canvasDigest' &&
              (ts.getDecorators(p) ?? []).some((d) =>
                d.expression.getText(sf).includes('CanvasDigestService'),
              ),
          )
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'maybeRender'
      ) {
        maybeRenderCalls += 1
      }
      if (ts.isIfStatement(node)) {
        const cond = node.expression.getText(sf)
        const body = node.thenStatement.getText(sf)
        if (
          cond.includes('canvasDigest?.isEnabled()') &&
          cond.includes('canvasActions.length > 0') &&
          body.includes('maybeRender') &&
          body.includes('yield')
        ) {
          ownerYieldBlock = true
        }
      }
    })

    // owner 流专门判据排在总数前面：删 owner 挂载时要给出「缺 yield 块」的精确信号，
    // 而不是被「两处调用」的计数断言抢先失败。
    expect(hasImport, '缺 import { CanvasDigestService }').toBe(true)
    expect(hasInjection, '缺构造函数 @Inject(CanvasDigestService)').toBe(true)
    expect(ownerYieldBlock, 'owner 流缺 maybeRender + yield canvas_action 的挂载块').toBe(true)
    expect(maybeRenderCalls, 'drain + owner 两处 maybeRender 调用应同时存在').toBe(2)
  })

  it('agent.module.ts 仍 provide CanvasDigestService', () => {
    const sf = parse(MODULE_FILE)
    let provided = false
    walk(sf, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(sf) === 'provide' &&
        node.initializer.getText(sf) === 'CanvasDigestService'
      ) {
        provided = true
      }
    })
    expect(provided).toBe(true)
  })

  it('扫全 agent 目录：每份生产 agent.service*.ts 都带两处 maybeRender（防第二份旧文件顶替）', () => {
    const files = productionServiceFiles()
    expect(files.length, '至少要找到一份生产 agent.service.ts').toBeGreaterThan(0)
    for (const file of files) {
      const src = readFileSync(join(HERE, file), 'utf8')
      expect(src.match(/\.maybeRender\(/g)?.length ?? 0, `${file} 的挂载被冲掉了`).toBe(2)
    }
  })

  it('行为：flag on + 有 canvasActions 的 out-of-turn 收束 ⇒ maybeRender 真被调用', async () => {
    const maybeRender = vi.fn().mockResolvedValue({ nodeId: 'digest-canvas', actions: [] })
    const service = makeService({ isEnabled: () => true, maybeRender })

    await (service as unknown as DrainRunner).persistOutOfTurnTurn('s1', 't1', 'u1', snapshot())

    expect(maybeRender).toHaveBeenCalledTimes(1)
    expect(maybeRender).toHaveBeenCalledWith({
      sessionId: 's1',
      userId: 'u1',
      canvasActions: expect.any(Array),
    })
  })

  it('行为：flag off ⇒ 零调用；flag on 但 maybeRender 抛错 ⇒ fail-soft 不冒泡', async () => {
    const off = vi.fn().mockResolvedValue(null)
    await (makeService({ isEnabled: () => false, maybeRender: off }) as unknown as DrainRunner)
      .persistOutOfTurnTurn('s1', 't1', 'u1', snapshot())
    expect(off).not.toHaveBeenCalled()

    const boom = vi.fn().mockRejectedValue(new Error('staged conflict'))
    await expect(
      (makeService({ isEnabled: () => true, maybeRender: boom }) as unknown as DrainRunner)
        .persistOutOfTurnTurn('s1', 't1', 'u1', snapshot()),
    ).resolves.toBeUndefined()
    expect(boom).toHaveBeenCalledTimes(1)
  })
})
