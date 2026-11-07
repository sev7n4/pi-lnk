/**
 * Canvas Digest 收束契约（2026-11-07 结构性修复守卫）。
 *
 * 两次事故形态：
 *  - `57cf1488b` 用落后基线整文件覆盖，把 #739 的四块挂载全冲掉 ⇒ 线上零调用点、
 *    任何会话都不生成「画布总览」，而既有 2529 个测试全绿（服务单测只测
 *    maybeRender，不测「谁调用它」）。#753 以原样重放修复。
 *  - #739 的规格 v1.2 实施回写只写了「owner 流 + drain」，漏掉 detached 断连，
 *    而规格 §5.1 图 1 明定 finalizeTurn 是三条收束路径共用的唯一点 ⇒ 断连轮
 *    总览停在上一版。本包把触发下沉进 finalizeTurn，杜绝「某条路径漏挂」。
 *
 * ⇒ 本测试两侧同时钉住，缺一不可：
 *   - 静态接线（AST，不认注释/字符串）：import / 构造注入 / 触发源唯一且位于
 *     finalizeTurn / 3 个调用点 / 返回 actions / owner 流 yield 转发 / module provide；
 *   - 行为可达：真实调用收束路径，断言 maybeRender 被触发并返回 actions、
 *     flag off 零调用、抛错 fail-soft 不冒泡、duplicate early return 不触发。
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

/** 取指定方法体源码（AST，不受注释/字符串干扰）。 */
function methodBody(sf: ts.SourceFile, name: string): string {
  let body = ''
  walk(sf, (node) => {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.body
    ) {
      body = node.body.getText(sf)
    }
  })
  return body
}

/** AST 计数：真正的 `.maybeRender(` 调用，注释里的同名文字不算。 */
function countMaybeRenderCalls(sf: ts.SourceFile): number {
  let n = 0
  walk(sf, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'maybeRender'
    ) {
      n += 1
    }
  })
  return n
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

type FinalizeRunner = {
  finalizeTurn(
    sessionId: string,
    threadId: string,
    userId: string | undefined,
    assistantText: string,
    canvasActions: CanvasAction[],
    opts: Record<string, unknown>,
  ): Promise<CanvasAction[]>
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

const OPTS = {
  rewriteCanvasData: false,
  metadata: { outOfTurn: true },
  runId: '',
  sawTerminalEvent: true,
  runStarted: true,
}

describe('Canvas Digest 收束契约', () => {
  it('触发源唯一且落在 finalizeTurn 内；三条路径共用；owner 流只做 yield 转发', () => {
    const sf = parse(SERVICE_FILE)
    let hasImport = false
    let hasInjection = false
    let finalizeTurnCalls = 0
    let ownerYieldForward = false

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
        node.expression.name.text === 'finalizeTurn'
      ) {
        finalizeTurnCalls += 1
      }
      if (ts.isForOfStatement(node)) {
        const body = node.getText(sf)
        if (
          body.includes('digestActions') &&
          body.includes('yield') &&
          body.includes('canvas_action')
        ) {
          ownerYieldForward = true
        }
      }
    })

    const finalizeBody = methodBody(sf, 'finalizeTurn')
    const drainBody = methodBody(sf, 'persistOutOfTurnTurn')

    expect(hasImport, '缺 import { CanvasDigestService }').toBe(true)
    expect(hasInjection, '缺构造函数 @Inject(CanvasDigestService)').toBe(true)
    expect(finalizeTurnCalls, 'owner / detached / drain 三条路径必须都经 finalizeTurn').toBe(3)
    expect(finalizeBody, '唯一触发源必须落在 finalizeTurn 内').toContain('.maybeRender(')
    expect(drainBody, 'drain 不得再自行外挂 maybeRender').not.toContain('maybeRender')
    expect(countMaybeRenderCalls(sf), '全文件只允许一处 maybeRender（防再次分散）').toBe(1)
    expect(finalizeBody, 'finalizeTurn 必须把 actions 返回给 owner 流').toContain('return digestActions')
    expect(ownerYieldForward, 'owner 流缺 digestActions → yield canvas_action 转发').toBe(true)
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

  it('扫全 agent 目录：每份生产 agent.service*.ts 都只有唯一触发源（防第二份旧文件顶替）', () => {
    const files = productionServiceFiles()
    expect(files.length, '至少要找到一份生产 agent.service.ts').toBeGreaterThan(0)
    for (const file of files) {
      const path = join(HERE, file)
      const sf = parse(path)
      expect(countMaybeRenderCalls(sf), `${file} 的收束挂载被冲掉或被分散了`).toBe(1)
      expect(methodBody(sf, 'finalizeTurn'), `${file} 的触发源不在 finalizeTurn 内`).toContain(
        '.maybeRender(',
      )
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

  it('行为：finalizeTurn 返回 digest actions，供 owner 流转成 SSE 帧', async () => {
    const digestAction: CanvasAction = {
      type: 'add_node',
      payload: { id: 'digest-canvas', nodeType: 'text', data: {} },
    }
    const maybeRender = vi.fn().mockResolvedValue({
      nodeId: 'digest-canvas',
      actions: [digestAction],
    })
    const service = makeService({ isEnabled: () => true, maybeRender })

    const result = await (service as unknown as FinalizeRunner).finalizeTurn(
      's1',
      't1',
      'u1',
      '',
      [{ type: 'update_node', payload: { id: 'n1', data: {} } } as CanvasAction],
      OPTS,
    )

    expect(maybeRender).toHaveBeenCalledTimes(1)
    expect(result).toEqual([digestAction])
  })

  it('行为：duplicate runId 的 early return 不触发 digest（规格「finalizeTurn 成功后」）', async () => {
    const maybeRender = vi.fn().mockResolvedValue({ nodeId: 'digest-canvas', actions: [] })
    const service = makeService({ isEnabled: () => true, maybeRender })
    Object.assign(service, {
      piLogger: { warn: () => {}, log: () => {} },
      findTurnByRunId: async () => ({ id: 'already-persisted' }),
    })

    const result = await (service as unknown as FinalizeRunner).finalizeTurn(
      's1',
      't1',
      'u1',
      '',
      [{ type: 'update_node', payload: { id: 'n1', data: {} } } as CanvasAction],
      { ...OPTS, runId: 'duplicate-run' },
    )

    expect(maybeRender).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })
})
