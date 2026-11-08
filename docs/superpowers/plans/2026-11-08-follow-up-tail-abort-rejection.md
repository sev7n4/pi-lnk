# follow-up-tail AbortError 未处理 rejection 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

spec-figures: off —— 理由：实施计划按 writing-plans 模板组织，结构图已在同名 spec 的 §0 / §5 承载，计划不重复配图。

**Goal:** 消除 `follow-up-tail.ts` 两条被丢弃 Promise 造成的浏览器 `Uncaught (in promise) AbortError`，用行为级 `unhandledRejection` 契约 + 类别化源级门禁钉住边界，独立小 PR 落地。

**Architecture:** 不改订阅状态机、不改导出契约、不收紧类型。仅在 `launch()` 与内层 `finally` 两处给被丢弃的 Promise 挂 `.catch`；新增一个 vitest 文件，以真实工厂函数驱动假 SSE 流并捕获运行时事件。

**Tech Stack:** TypeScript、Vitest（jsdom）、`vue-tsc -b`、`pnpm -r build`、`pnpm verify-spec-figures`、Node 24 + `env -u NODE_OPTIONS`、`gh api` Git-Data 链、GitHub Actions 三 required check。

**Spec:** `docs/superpowers/specs/2026-11-08-follow-up-tail-abort-rejection-design.md`（执行者须同时读 `docs/ops/2026-11-08-phase3-prod-smoke.md` §3 了解 F1 取证）。

## Global Constraints

- 分支约定：feature 分支 + PR + squash merge；本仓 `git push` 被网络阻断，提交走 `gh api` Git-Data 链（`docs/agent/delivery.md`）。
- `gh api` Git-Data tree entry **必须 repo-root 相对**（`apps/web/src/components/agent/...`）；用 app 相对路径会产生幻影文件（#774 事故）。
- master 真值只认 `gh api`（当前 `91822caf77370aa622be05dfb524e1fc7a70bd32`），不信本地 ref；推前/推后逐路径核对裸 blob sha。
- 本机 vitest / vue-tsc / pnpm 用 `export PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH` 且 `unset NODE_OPTIONS`；本机 `PATH` 前段有 WorkBuddy 的 node22 shim，`nvm use 24` 单独不足以生效。
- vitest 加 `--maxWorkers=1 --no-file-parallelism`；`pnpm -r build` 的 tsc 会编译 `*.test.ts` ⇒ 测试断言**禁用 `as never`**。
- CI 三个 required check = `Verify spec figures` / `Build monorepo`（含全量 vitest）/ `Build API Docker image`。
- 判据必须能真的失败：每条否定断言配肯定断言；基线 RED 且 exit≠0；实现后逐条变异 RED；测试读真实源文件 / 真实工厂函数，不复刻逻辑副本。
- 本机 `grep -rn` 可能被 shim 包装返回 0 命中 ⇒ 一律 Python 直读复核。
- `deploy.yml` paths 白名单含 `apps/web/**` ⇒ 本刀合并会触发自动部署；纯文档部分不触发。
- 不改 `docs/agent/*.md`（否则触发 `pnpm verify-claims`）、不改 `docs/superpowers/INDEX.md`、不改 `prompt-registry/**`。

## Review Focus

| # | 隐含失败模式 | 合理预期 | 钉住它的测试 |
| --- | --- | --- | --- |
| 1 | 探针没接线，前两例「零事件」是假绿 | 人为制造的 rejection 必被捕获 1 次 | Task 1 S3 |
| 2 | 只补 `cancel` 的 handler，漏 `run` 的 | `baseUrl()` 抛错路径也必须零事件 | Task 1 S2 + 变异 M1 |
| 3 | 只补 `run` 的 handler，漏 `cancel` 的 | abort 路径也必须零事件 | Task 1 S1 + 变异 M2 |
| 4 | 把 `cancel()` 整个删掉来「消掉」rejection | 肯定断言要求 cancel 确实被调用 | Task 1 S1 + 变异 M4 |
| 5 | 今后新增 `void someAsync()` 又静默丢弃 | 类别化门禁立刻拦下 | Task 1 S4 |
| 6 | 修复顺带改变 `launch()` 的就绪 / 挂起语义 | 不新增 `mark()` 调用；既有两组 follow-up-tail 测试全绿 | Task 5 定向全组 |

---

### Task 1: 写行为级契约测试并证明基线 RED

**Files:**
- Create: `apps/web/src/components/agent/follow-up-tail.unhandledRejection.test.ts`

**Interfaces:**
- Consumes: `createFollowUpTailListener` / `FollowUpTailDeps` / `TailResponseLike`（真实导出）、同目录 `follow-up-tail.ts` 磁盘文本。
- Produces: 5 个 vitest 用例，供 Task 2 转绿、Task 3 变异验证。

- [ ] **Step 1: 写测试文件**

```ts
/**
 * F1 行为级契约：被丢弃的 Promise 不得产生未处理 rejection。
 *
 * 现象（生产 CDP 取证，见 docs/ops/2026-11-08-phase3-prod-smoke.md §3）：
 *   Uncaught (in promise) AbortError: signal is aborted without reason
 * 复刻链路：建连 → 显式 abort → pending read() 以 AbortError reject
 *         → finally 里 cancel() 对已 errored 的流返回被拒 Promise
 *         → 该 Promise 被 `void` 丢弃 ⇒ 浏览器 Runtime.exceptionThrown。
 *
 * 判据出口是**运行时事件**，不是源码文本；源码文本判据另设 S4 作第二道门禁。
 * 探针临时独占 process 的 unhandledRejection 监听，结束后完整恢复，
 * 避免 vitest 自身的处理器把本用例的预期 rejection 计成 unhandled error。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createFollowUpTailListener,
  type FollowUpTailDeps,
  type TailResponseLike,
} from './follow-up-tail'

type UnhandledHandler = (reason: unknown, promise: Promise<unknown>) => void

function installProbe() {
  const seen: unknown[] = []
  const prior = process.listeners('unhandledRejection') as UnhandledHandler[]
  process.removeAllListeners('unhandledRejection')
  const handler: UnhandledHandler = (reason) => { seen.push(reason) }
  process.on('unhandledRejection', handler)
  return {
    seen,
    restore: () => {
      process.off('unhandledRejection', handler)
      for (const l of prior) process.on('unhandledRejection', l)
    },
  }
}

/** 真实时钟等一拍：unhandledRejection 在微任务队列排空后由 Node 触发。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const abortError = () => new DOMException('signal is aborted without reason', 'AbortError')

function makeDeps(overrides: Partial<FollowUpTailDeps> = {}) {
  const state = { fetchCalls: 0, cancelCalls: 0, baseCalls: 0 }
  const base: FollowUpTailDeps = {
    idleMs: 60_000,
    baseUrl: () => {
      state.baseCalls += 1
      return '/api/agent/runs/events?sessionId=s1&threadId=t1'
    },
    headers: () => ({}),
    fetchImpl: (_url, init) => {
      state.fetchCalls += 1
      const signal = init.signal
      return Promise.resolve({
        status: 200,
        ok: true,
        body: {
          getReader: () => ({
            read: () =>
              new Promise<{ done: boolean; value?: Uint8Array }>((_resolve, reject) => {
                const onAbort = () => reject(abortError())
                if (signal.aborted) onAbort()
                else signal.addEventListener('abort', onAbort, { once: true })
              }),
            cancel: () => {
              state.cancelCalls += 1
              // Streams 规范：流已 errored 时 cancel 返回被拒 Promise
              return Promise.reject(abortError())
            },
          }),
        },
      } as TailResponseLike)
    },
  }
  return { deps: { ...base, ...overrides }, state }
}

describe('F1 · 被丢弃的 Promise 不得产生未处理 rejection', () => {
  it('S1 abort 后 cancel 异步 reject：零 unhandledRejection', async () => {
    const probe = installProbe()
    try {
      const { deps, state } = makeDeps()
      const listener = createFollowUpTailListener(deps)
      await listener.start()
      listener.abort()
      await tick()
      // 肯定配对：链路确实走到了 abort → finally → cancel，不能靠「什么都没发生」变绿
      expect(state.fetchCalls, '前置：确实建连').toBe(1)
      expect(state.cancelCalls, '前置：abort 后 reader.cancel 确实被调用').toBeGreaterThanOrEqual(1)
      expect(probe.seen, 'cancel 的异步 reject 必须被吞掉，否则浏览器抛 AbortError').toEqual([])
    } finally {
      probe.restore()
    }
  })

  it('S2 run 在首个响应前 reject：零 unhandledRejection', async () => {
    const probe = installProbe()
    try {
      const { deps, state } = makeDeps({
        baseUrl: () => {
          state.baseCalls += 1
          throw new Error('baseUrl failed before first response')
        },
      })
      const listener = createFollowUpTailListener(deps)
      // 故意不 await：launch 等不到 ready 是既有语义，本刀不改变它
      void listener.start()
      await tick()
      expect(state.fetchCalls, '前置：首个响应未到达').toBe(0)
      expect(probe.seen, 'run 的 Promise 必须挂 catch，否则产生未处理 rejection').toEqual([])
    } finally {
      probe.restore()
    }
  })

  it('S3 探针自检：人为制造的未处理 rejection 必被捕获', async () => {
    const probe = installProbe()
    try {
      void Promise.reject(new Error('probe'))
      await tick()
      expect(probe.seen, '探针必须能捕获事件；否则 S1/S2 的零事件是假绿').toHaveLength(1)
    } finally {
      probe.restore()
    }
  })

  it('S5 cancel 同步抛错仍被既有 try/catch 吞掉', async () => {
    const probe = installProbe()
    try {
      const { deps, state } = makeDeps({
        fetchImpl: (_url, init) => {
          const signal = init.signal
          return Promise.resolve({
            status: 200,
            ok: true,
            body: {
              getReader: () => ({
                read: () =>
                  new Promise<{ done: boolean; value?: Uint8Array }>((_resolve, reject) => {
                    const onAbort = () => reject(abortError())
                    if (signal.aborted) onAbort()
                    else signal.addEventListener('abort', onAbort, { once: true })
                  }),
                cancel: () => {
                  state.cancelCalls += 1
                  throw new Error('sync cancel failure')
                },
              }),
            },
          } as TailResponseLike)
        },
      })
      const listener = createFollowUpTailListener(deps)
      await listener.start()
      listener.abort()
      await tick()
      expect(state.cancelCalls).toBeGreaterThanOrEqual(1)
      expect(probe.seen).toEqual([])
    } finally {
      probe.restore()
    }
  })
})

describe('F1 · 类别化源级门禁', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, 'follow-up-tail.ts'), 'utf8')
  const voidLines = src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^void\s/.test(l))

  it('S4 所有以 void 丢弃的 Promise 调用都必须显式接 catch', () => {
    // 存在性配对：防止「把两条语句删空」也能绿
    expect(src).toContain('async function launch()')
    expect(src).toContain('r.cancel?.()')
    expect(voidLines.length, '该文件确实存在被丢弃的 Promise 调用').toBeGreaterThanOrEqual(2)
    for (const line of voidLines) {
      expect(line, '被 void 丢弃的异步调用必须挂 catch，否则迟早复现 F1').toContain('.catch(')
    }
  })
})
```

- [ ] **Step 2: 跑基线，必须 RED**

```bash
cd apps/web
export PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH && unset NODE_OPTIONS
./node_modules/.bin/vitest run src/components/agent/follow-up-tail.unhandledRejection.test.ts \
  --maxWorkers=1 --no-file-parallelism > /tmp/f1-red.log 2>&1; echo "EXIT=$?"
tail -40 /tmp/f1-red.log
```

预期：S1、S2、S4 失败（3 failed），S3、S5 通过（2 passed），`EXIT≠0`。
若 S1/S2 也全绿 ⇒ 探针或假流没接线，**禁止继续**，先修判据（不得改实现）。
若 5 例全红 ⇒ 检查 `installProbe` 是否把 vitest 处理器恢复错，或 `DOMException` 在 jsdom 缺失。

---

### Task 2: 最小修复，转 PASS

**Files:**
- Modify: `apps/web/src/components/agent/follow-up-tail.ts`（仅 2 行）

- [ ] **Step 1: 改 `launch()`**

```ts
// 旧
    void run(mark)
// 新（不改 await / 不新增 mark 调用）
    // 常驻循环在 abort 前不结束；它若意外 reject，不能变成未处理 rejection（F1）。
    void run(mark).catch(() => {})
```

- [ ] **Step 2: 改内层 `finally` 的 cancel**

```ts
// 旧
              void r.cancel?.()
// 新
              // cancel 对已 errored 的流会以 AbortError reject；同步抛错由外层 try 接住，
              // 异步 reject 必须由这里吞掉，否则浏览器抛 Uncaught (in promise)（F1）。
              void Promise.resolve(r.cancel?.()).catch(() => {})
```

- [ ] **Step 3: 复跑同命令，必须 5/5 PASS 且 `EXIT=0`**

---

### Task 3: 变异测试（每条必须 RED）

| 变异 | 注入方式 | 期望 |
| --- | --- | --- |
| M1 | 仅把 `void run(mark).catch(() => {})` 还原为 `void run(mark)` | S2 + S4 红 |
| M2 | 仅把 `void Promise.resolve(r.cancel?.()).catch(() => {})` 还原为 `void r.cancel?.()` | S1 + S4 红 |
| M3 | M1 + M2 同时还原 | S1 / S2 / S4 全红 |
| M4 | 把 `if (reader) {` 改成 `if (false && reader) {` | S1 的肯定断言红（cancel 未被调用） |
| M5 | 在文件末尾追加一行 `void Promise.reject(new Error('future'))` | S4 红（类别化门禁挡新增同类写法） |

每条变异后跑 Task 1 Step 2 的命令，记录 `EXIT` 与失败用例；恢复后用 Python 裸 blob sha 确认与 Task 2 产物逐字节相等，再复跑一次 `EXIT=0`。

---

### Task 4: 文档衔接（与 Task 2/3 产物一起提交）

- [ ] `docs/ops/2026-11-08-phase3-prod-smoke.md`：§3 标题加「已由 F1 独立刀承接」；「建议修复（独立刀，本轮不动）」改为「修复落地（见 2026-11-08-follow-up-tail-abort-rejection-design.md）」并保留三条建议的修订说明；§6 结论第 2/3 条更新 F1 状态。
- [ ] `docs/superpowers/specs/2026-11-08-agent-siderail-phase3-closeout.md`：完成定义表「生产业务链路验收」行尾部追加 F1 状态演进（**不改写当时的历史结论**）。
- [ ] 不新增图、不改 §0 索引（两份既有文档都不在本次配图范围）。

---

### Task 5: 本地全量门禁 + 浏览器级 CDP 复核

- [ ] **Step 1: 定向 / 全组 vitest**

```bash
cd apps/web
export PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH && unset NODE_OPTIONS
./node_modules/.bin/vitest run \
  src/components/agent/follow-up-tail.test.ts \
  src/components/agent/follow-up-tail.main.test.ts \
  src/components/agent/follow-up-tail.unhandledRejection.test.ts \
  --maxWorkers=1 --no-file-parallelism
./node_modules/.bin/vitest run src/components/agent --maxWorkers=1 --no-file-parallelism
```

基线：全组 44 files / 221 tests 全绿 ⇒ 新增 5 例后应为 **45 files / 226 tests**。
同时看 `Errors 0 errors` 与末尾 `Exit status`（`delivery.md`：全 passed 但 Errors 非零仍算失败）。

- [ ] **Step 2: 类型 / 构建 / 文档门禁**

```bash
cd apps/web && ./node_modules/.bin/vue-tsc -b            # EXIT=0
cd <repo> && pnpm -r build                                # EXIT=0
cd <repo> && pnpm verify-spec-figures                     # 0 error
cd <repo> && pnpm verify-spec-figures --file docs/superpowers/specs/2026-11-08-follow-up-tail-abort-rejection-design.md
cd <repo> && pnpm verify-links && pnpm verify-claims
```

- [ ] **Step 3: 浏览器级 CDP 复核（P0 建议 ③ 的确定性替身）**

用 esbuild 分别对「修复前 / 修复后」的 `follow-up-tail.ts` 打 IIFE；页面里注入同一假流（read 随 abort reject、cancel 返回被拒 Promise），监听 `window.onunhandledrejection`；headless Chrome 用 `--headless=new --no-sandbox --remote-debugging-port=<port>`，CDP 侧同时计 `Runtime.exceptionThrown`。判据：**修复前 ≥1 个事件、修复后 0 个**。脚本属一次性取证，落 `/tmp`，不入库；结果写进本刀日志。

---

### Task 6: 推 PR、CI、squash、合并后核验

- [ ] **Step 1: 推前核对**（用 Python 裸 blob sha，不用 `git ls-files` / `hash-object --stdin-paths`）

```bash
MASTER=$(gh api repos/sev7n4/pi-lnk/commits/master --jq .sha)
gh api "repos/sev7n4/pi-lnk/git/trees/$MASTER?recursive=1" --jq '.tree[] | [.path,.sha] | @tsv' > /tmp/f1-master-tree.tsv
# 对 §9 的 6 个路径逐一核对：本地裸 sha vs master blob sha；只有本次要改的 2 个实现/测试文件允许差异
```

- [ ] **Step 2: Git-Data 链**（`--input` 传 JSON body，大 blob 加 retry/backoff；tree entry 一律 `apps/web/...` / `docs/...` repo-root 相对）

```
POST /repos/sev7n4/pi-lnk/git/blobs        × 6（新增/修改文件）
POST /repos/sev7n4/pi-lnk/git/trees        base_tree=<master tree sha>
POST /repos/sev7n4/pi-lnk/git/commits      parent=<MASTER>
POST /repos/sev7n4/pi-lnk/git/refs         refs/heads/phase4/f1-abort-rejection-20261108
POST /repos/sev7n4/pi-lnk/pulls             base=master
```

推后立刻 `GET /repos/.../compare/master...<branch>` 核对**恰好 6 个文件**，且 `AgentSideRail.vue` 不在其中。

- [ ] **Step 3: CI 三必需全绿 → squash**

```bash
gh run list --branch phase4/f1-abort-rejection-20261108 --limit 3
gh pr checks <PR>            # Verify spec figures / Build monorepo / Build API Docker image 全 pass
gh api -X PUT repos/sev7n4/pi-lnk/pulls/<PR>/merge --input /tmp/f1-merge.json   # merge_method=squash
```

- [ ] **Step 4: 合并后核验 + 清理**

合并树 6 个 blob sha 与本地逐字节相等；`gh api -X DELETE` 删分支；`/api/health` 200；查看 `Deploy to Tencent Cloud` run 状态——**若 scp 再挂死，cancel 不 rerun**（持久 stall 空耗 30min），生产复验登记为待部署窗口，不作为本刀合并闸门。

- [ ] **Step 5: 日志**：追加 `.workbuddy/memory/2026-11-08.md`（不入库），记录 RED/PASS 数字、5 条变异、CDP 复核、PR 号与 merge sha。
