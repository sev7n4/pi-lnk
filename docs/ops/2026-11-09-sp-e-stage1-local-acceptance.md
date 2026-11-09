# SP-E 阶段 1 · 本地验收记录（LOCAL only）

- 日期：2026-11-09
- 工作树：`/tmp/sp-e-sdd`（隔离重建仓库；基线 = true master `5ca09b1d716115d47edca75773d78b4f3e8b6285` 的逐字节重建，本地基线提交 `482e5945a8c841739a2442a1dff6db3a1480a538`）
- 授权范围（控制器裁定 R2）：**只执行 Step 1 / Step 2 / Step 3**。Step 4（合并 + 生产发布验收）、Step 5（14 天观测窗口）标 `DEFERRED_PENDING_DEPLOY_AUTHORIZATION`，不执行。brief 的 Step 6「commit 验收记录」替换为本文件（诚实的 LOCAL 验收报告）。
- 环境口径（R1 已验证）：`export PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH`；所有命令 `env -u NODE_OPTIONS`；逐 workspace `pnpm --filter <ws> exec ...`，vitest 均带 `--maxWorkers=1 --no-file-parallelism`（I10）。根 `npx vitest` 在本仓库不可用。

---

## Step 1 · 本地全量回归

全部命令均 `cd /tmp/sp-e-sdd &&` 后执行，`node v24.13.0` / `pnpm 9.15.0` / `vitest 3.2.7`。

### 1.1 测试套件（4 条绑定命令）

| # | 命令 | 真实结果 |
|---|---|---|
| 1 | `env -u NODE_OPTIONS pnpm --filter @lnkpi/server exec vitest run src/sessions src/health --maxWorkers=1 --no-file-parallelism` | **8 files / 63 tests passed**，exit 0（含既有 `canvas-write-governance.test.ts` 1/1、`canvas-patch-metrics.test.ts` 9/9、`health.controller.test.ts` 5/5、`sessions.service.test.ts` 15/15、`sessions-patch.service.test.ts` 11/11 等）。非阻塞噪声：`canvas-write-governance.test.ts` 输出一条 Vitest 弃用告警「Using an object as a third argument is deprecated」，不影响通过。 |
| 2 | `env -u NODE_OPTIONS pnpm --filter @lnkpi/shared exec vitest run src/canvasActionApplier.test.ts --maxWorkers=1 --no-file-parallelism` | **1 file / 21 tests passed**，exit 0 |
| 3 | `env -u NODE_OPTIONS pnpm --filter @lnkpi/agent exec vitest run src/tools/executor.test.ts --maxWorkers=1 --no-file-parallelism` | **1 file / 15 tests passed**，exit 0 |
| 4 | `env -u NODE_OPTIONS pnpm --filter @lnkpi/web exec vitest run src/utils/canvasClientId.test.ts src/services/canvas-api.patch-header.test.ts src/pages/canvas/canvasLoadGuard.wiring.test.ts src/pages/CanvasPage.mobileChromeHygiene.test.ts --maxWorkers=1 --no-file-parallelism` | **4 files / 32 tests passed**，exit 0 |

合计 **14 test files / 131 tests 全绿**。Step 2 全部变异还原后复跑，四条命令摘要仍为 `8/63`、`1/21`、`1/15`、`4/32`，`git status --porcelain` 为空。

### 1.2 类型检查（真实结果，含一处不可行与一处不适用）

| 检查 | 命令 | 真实结果 |
|---|---|---|
| server | `env -u NODE_OPTIONS pnpm --filter @lnkpi/server exec tsc --noEmit` | **exit 0，0 errors** |
| shared | `env -u NODE_OPTIONS pnpm --filter @lnkpi/shared exec tsc --noEmit` | **exit 0，0 errors** |
| agent | `env -u NODE_OPTIONS pnpm --filter @lnkpi/agent exec tsc --noEmit` | **exit 0，0 errors** |
| web（plain tsc） | `env -u NODE_OPTIONS pnpm --filter @lnkpi/web exec tsc --noEmit` | **exit 1，227 条错误，全部为 `error TS2307: Cannot find module '*.vue'`**（`apps/web/tsconfig.json` 含 `src/**/*.vue` 但无 `declare module '*.vue'` shim，`vite-env.d.ts` 仅 `/// <reference types="vite/client" />`）。plain `tsc` 不能解析 Vue SFC，属既有环境不适用项、非本刀回归：227 条里无一条是 14 个变更文件的真实类型错误，`CanvasPage.mobileChromeHygiene.test.ts(12,30)` 那一条同样是 `@/components/mobile/MobileSaveStatus.vue` 的 `.vue` 解析。不隐藏此失败。 |
| web（权威门） | `env -u NODE_OPTIONS pnpm --filter @lnkpi/web exec vue-tsc -b` | **exit 0，0 errors**（与既有 Task 报告及 `apps/web` 的 `build` 脚本一致，是 web 的权威类型门） |
| 根 `npx tsc` | `env -u NODE_OPTIONS npx --no-install tsc --noEmit` | **不可行**：仓库无根 `tsconfig.json`、根 `node_modules/.bin/tsc` 与 `node_modules/typescript` 均不存在；`npx tsc` 解析到 npm 的 `tsc` 占位包，输出「This is not the tsc command you are looking for」，安装 typescript 又受网络阻断。按 R1 要求显式说明，**未伪装为通过**。 |
| CI 全量构建 | `env -u NODE_OPTIONS pnpm -r build` | **exit 0**，`Scope: 6 of 7 workspace projects`，5 个带 build 脚本的 workspace 全部 `Done`（shared / pi-runtime / agent / server / web；web 含 `vue-tsc -b && vite build`，`✓ built in 49.50s`），日志无 `error TS` / `Failed` / `ELIFECYCLE`。这是 I10 所指「CI `pnpm -r build` 编译 `*.test.ts`」的门。`dist/` 被 `.gitignore` 忽略，`git status --porcelain` 保持为空。 |

---

## Step 2 · 行为级变异测试（7/7 全部 RED）

**纪律**：逐一注入、逐一确认判据 RED、逐一以原始字节还原后再进入下一组。三份源码在变异前用 `shutil.copyfile` 备份到 `/tmp/sp-e-mutation-backups/`（原始字节，不经 git filter），每次还原用 `copyfile` 回写并用 sha256 校验；每组结束 `git diff --exit-code -- <file>` = 0 且 `git status --porcelain` 为空。

变异前 sha256：`canvasActionApplier.ts = 0a940ea4ae2464b61df19bebb5e1f72680c0a0fc91aa2c207a222cd08bdade75`（10195 B）；`canvas-patch-metrics.ts = 3465b8289d6b22b652a2db8987e35af202f125c1d7424c9b754baae36ac90630`（2699 B）；`sessions.service.ts = cf89bcda047bb430ce3caa2e6fa0532e6b9ad30fc2eb0b66715b70422a547451`（10181 B）。

| # | 变异（注入点） | 守卫用例 | RED 证据（命令 + 关键输出） | 还原校验 |
|---|---|---|---|---|
| 1 | 删 `packages/shared/src/canvasActionApplier.ts` 的 `add_edge` 查重块（`if (result.edges.some(...)) { onSkipped?.('add_edge','duplicate_edge',edgeId); break }`） | `applyCanvasActions —— op 幂等 & onSkipped 留痕 > add_edge 重复 id ⇒ 只产生一条边 + onSkipped` | `env -u NODE_OPTIONS pnpm --filter @lnkpi/shared exec vitest run src/canvasActionApplier.test.ts --maxWorkers=1 --no-file-parallelism` → **exit 1**，`1 failed \| 20 passed (21)`；`AssertionError: expected [ …(2) ] to have a length of 1 but got 2` | sha256 复原 `0a940ea4…`，`git diff --exit-code` 0，status 空 |
| 2 | 删 `canvasActionApplier.ts` 的 `opts?.onSkipped?.('update_node','node_not_found', …)` | `… > update_node 打已删节点 ⇒ onSkipped(node_not_found)` | 同上命令 → **exit 1**，`1 failed \| 20 passed (21)`；`AssertionError: expected [] to deeply equal [ 'update_node:node_not_found:gone' ]` | sha256 复原 `0a940ea4…`，diff 0，status 空 |
| 3 | `canvas-patch-metrics.ts` `NEAR_CONCURRENT_MS = 2000 → 0` | `CanvasPatchMetrics > 不同 clientId + 2s 内 + 键相交 ⇒ stale_conflict`（硬编码 `ts:1500`，不依赖该常量） | `env -u NODE_OPTIONS pnpm --filter @lnkpi/server exec vitest run src/sessions/canvas-patch-metrics.test.ts --maxWorkers=1 --no-file-parallelism` → **exit 1**，`4 failed \| 5 passed (9)`；守卫 `AssertionError: expected { … } to match object { nearConcurrentPairs: 1, … }` | sha256 复原 `3465b828…`，diff 0，status 空 |
| 4 | `record` 条件去掉 `last.clientId !== s.clientId` | `CanvasPatchMetrics > R5：同 clientId 2s 内连发不自计` | 同上命令 → **exit 1**，`2 failed \| 7 passed (9)`；守卫 `→ expected 1 to be +0`（`R12 非相邻对` 同因亦 RED） | sha256 复原 `3465b828…`，diff 0，status 空 |
| 5 | 埋点从 `$transaction` 之后挪到之前（args 适配为事务前可得值：`targetKeysOf(sanitized)` / `sanitized.length` / `[]`，否则引用未声明的 `applied` 会编译失败） | `SessionsService.patchCanvas —— 埋点观测 > R3：stagedActions 409 ⇒ 不记样本` | 先 `pnpm --filter @lnkpi/server exec tsc --noEmit` → **exit 0**（证明是行为级 RED 而非编译 RED）；再 `… vitest run src/sessions/sessions.service.test.ts …` → **exit 1**，`2 failed \| 13 passed (15)`；守卫 `→ expected 1 to be +0`（失败 PATCH 仍记了样本）。`成功 PATCH ⇒ 记录样本，skipped 精确` 因 skips 尚未在事务内算出亦 RED；`R2` 仍绿 | sha256 复原 `cf89bcda…`，diff 0，status 空 |
| 6 | 去掉埋点 `try/catch`（`canvasPatchMetrics.record` 变为裸调用） | `… > R2：埋点抛错 ⇒ PATCH 仍成功` | 先 `tsc --noEmit` → **exit 0**；再 vitest → **exit 1**，`1 failed \| 14 passed (15)`；`Error: boom` 未被吞、PATCH 抛出 | sha256 复原 `cf89bcda…`，diff 0，status 空 |
| 7 | 删 `targetKeysOf` 的 `edge:` 分支（`else if (op.type.includes('edge'))` 那行，push `edge:` 前缀键） | ① 注册守卫 `targetKeysOf > 提取 node/edge 目标键`；② 临时行为级探针 `_sp_e_m7_probe.test.ts`「相邻两 PATCH 命中同一 edge 键 ⇒ keyOverlapPairs = 1」 | 探针在**原始码**先跑 → **GREEN `1 passed (1)`**（证其为有效判据、非恒绿）；注入后 `… vitest run src/sessions/canvas-patch-metrics.test.ts src/sessions/_sp_e_m7_probe.test.ts …` → **exit 1**，`2 failed \| 8 passed (10)`；① `AssertionError: expected [ 'node:n1' ] to deeply equal [ 'node:n1', 'edge:e1' ]`；② 探针 `→ expected +0 to be 1`（键相交场景 RED） | sha256 复原 `3465b828…`；**临时探针已删除**；三文件 `git diff --exit-code` 全 0；全量 `git status --porcelain` 空 |

**合计**：7/7 变异全部使对应守卫 RED，0 编译假 RED，0 残留变异 diff。

### 伪变异（pseudo-mutation）主动排查结果

全部 7 组都 RED，无「注入后不 RED」的情况。但按要求主动排查注入点是否被下游过滤 / 余量吞掉，发现**两处确凿陷阱**：

1. **M3 余量/锚点自适应**：`canvas-patch-metrics.test.ts` 里 `R5：同 clientId 2s 内连发不自计` 与 `超过 2s / 不同 session 均不计` 的时间戳用 `1000 + NEAR_CONCURRENT_MS`（同一被变异常量）计算。常量改 0 时这两条的锚点自适应、保持 GREEN。若误把它们当守卫会得假绿。守卫必须选硬编码 `ts:1500`（Δ=500ms）的「不同 clientId + 2s 内 + 键相交」用例 —— 该用例实测 RED。
2. **M7 下游吞掉注入点**：8 条 `record()` 用例把 `targetKeys` 以字面量直接传入（如 `['node:n1']`），**绕过 `targetKeysOf`**，故删 `edge:` 分支对它们无影响而恒绿。守卫必须落在 `targetKeysOf` 输出断言或一个真正走 `targetKeysOf → record → 键相交` 的场景上 —— 我补了临时行为探针显式覆盖「键相交场景」（原始 GREEN / 变异 RED）。

### 判据自匹配恒绿（self-matching guard）主动排查结果

- 检查对象：7 条守卫断言的锚点字面量是否写在**被变异的谓词函数体内**、随实现一起变动而恒绿。
- 结果：**7 条守卫全部是行为级用例**，均调用真实实现（`applyCanvasActions` / `CanvasPatchMetrics.record` / `SessionsService.patchCanvas` / `targetKeysOf`）并断言可观测输出或计数器；**没有一条是 `readFileSync` 源码字符串断言**。期望值都是测试文件内的字面量（`toHaveLength(1)`、`['add_edge:duplicate_edge']`、`nearConcurrentPairs: 1`、`{applied:1}`、`['node:n1','edge:e1']`），不由被变异谓词推导 ⇒ 非自匹配。
- 针对性核对：M3 守卫的 `ts:1500` 是硬编码、与 `NEAR_CONCURRENT_MS` 无关；M7 守卫的 `'edge:e1'` 字面量在实现层只以 `` `edge:${op.payload.id}` `` 动态拼接、实现里并不存在该字面量 ⇒ 均非「锚点写在谓词里」。等价于 `implementation_code()` 的「只看实现层」推理。
- 仓库两处静态契约（`canvasLoadGuard.wiring.test.ts` 的 `bodyOf()` 按大括号配平取函数体、`canvas-api.patch-header.test.ts` 的 I6 锚点）本身即「剥离/定位实现层」写法，但**不在本 7 组变异的守卫集合内**（本刀未触碰 `CanvasPage.vue` 的 `await canvasApi.patchCanvas(` 字面量）。
- M7 临时探针先在原始码跑 GREEN、再在变异码跑 RED，直接证伪「恒绿」。

### 还原与工作树硬门

- 每次变异后从备份以原始字节 `copyfile` 回写；三个源码文件 sha256 与变异前逐一一致（Step 3 另证 `disk bare sha == git tree sha` mismatch = 0，无 git filter / 非 ASCII 损坏）。
- 7 组全部结束后：`git diff --exit-code -- packages/shared/src/canvasActionApplier.ts apps/server/src/sessions/canvas-patch-metrics.ts apps/server/src/sessions/sessions.service.ts` = 0；临时探针文件已 `os.remove`；`git status --porcelain` **输出为空**。

---

## Step 3 · 推前逐路径裸 blob sha 核对（I11/I12，只读 REST，未 push）

### 真实 master（check 时点）

```
gh api repos/sev7n4/pi-lnk/commits/master --jq '.sha'   → e743c469becb61e4186cbf9c1963a37f431a8048
gh api repos/sev7n4/pi-lnk/commits/master --jq '.commit.tree.sha' → 3622f5ad5bf34baf50aa45bfbab9fe02b719bebd
```
- master commit：`2026-11-09T13:34:47Z`，`fix(mobile-composer): 键盘贴边丝滑化 + 留 8px 空隙（rAF 逐帧跟随 + 状态随键盘翻转 + bottom 过渡）`，parent `a16717524fddf3615e6f00078399a9042a59f53a`。
- `gh api repos/sev7n4/pi-lnk/compare/5ca09b1d…...e743c469… --jq '.status,.ahead_by'` → `ahead` / `2`（`a167175…`、`e743c469…`），即 **master 自基线前移**。

### 方法（严格按 I11 口径）

- master tree：`gh api "repos/sev7n4/pi-lnk/git/trees/3622f5ad…?recursive=1"` → 4930 blob + 474 tree 条目，`truncated: False`。
- baseline tree：`gh api "repos/sev7n4/pi-lnk/git/trees/b1dbf8ab5bc4dd5bf82f9b1c70ff8fa29facbd25?recursive=1"` → 4930 blob，`truncated: False`。
- 裸 blob sha：`hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()`，数据取自 **worktree 文件原始字节**。`git ls-tree -r -z HEAD` 仅用于枚举 commit tree 里的**路径名**（非 index、非 sha）；**未使用 `git ls-files` / `git hash-object`**。
- 本地 HEAD：4936 个 blob 路径（4930 基线 + 6 新增），0 缺失；`disk bare sha == local git tree sha` **mismatch = 0**（重建逐字节精确）。

### 14 个变更路径（本分支 `git diff --name-only 482e594..HEAD`）与裸 blob sha

`wt` = worktree 裸 blob sha；`base` / `master` = 对应 tree 的 blob sha（`(absent)` 表示该 tree 无此路径）。

| St | 路径 | wt | base | master |
|---|---|---|---|---|
| M | `apps/server/src/health/health.controller.test.ts` | `4d53602a33faaf9e90d7a984c4b64a97ae7be791` | `981def7bf850d08f16661acc5e67d0e38ec2986a` | `981def7bf850d08f16661acc5e67d0e38ec2986a` |
| M | `apps/server/src/health/health.controller.ts` | `5d4ac11f972a5fb795d177209f22129cce2c5fa6` | `6236bed6ab0ff7f7becf3ca272db7da9a07c0d02` | `6236bed6ab0ff7f7becf3ca272db7da9a07c0d02` |
| A | `apps/server/src/sessions/canvas-patch-metrics.test.ts` | `849f1249a674a3e32f9782a791044c5ce891f05f` | (absent) | (absent) |
| A | `apps/server/src/sessions/canvas-patch-metrics.ts` | `e4bd5b263cee916bf1962ed086764a457714d751` | (absent) | (absent) |
| A | `apps/server/src/sessions/sessions.controller.headers.test.ts` | `da0441cbd5485132a8675df16f09291773da813f` | (absent) | (absent) |
| M | `apps/server/src/sessions/sessions.controller.ts` | `54116c0b13f114cfd3011281c6f146efefbe63d9` | `a365c41c212e0494d8885b537e903328e5495ecf` | `a365c41c212e0494d8885b537e903328e5495ecf` |
| M | `apps/server/src/sessions/sessions.service.test.ts` | `8ae69d1018e0ecba3fb475d3cc8a46b908645417` | `b499f8160b2370cd42fe55262e0c286376760501` | `b499f8160b2370cd42fe55262e0c286376760501` |
| M | `apps/server/src/sessions/sessions.service.ts` | `ce702ca83daa158c477982bab09fbe4d472d544c` | `587a8c339ec3df26a0509ba78f1a4658c2ab922a` | `587a8c339ec3df26a0509ba78f1a4658c2ab922a` |
| A | `apps/web/src/services/canvas-api.patch-header.test.ts` | `b0a7861f2c369ac9fe1d304997e5f243c77a475d` | (absent) | (absent) |
| M | `apps/web/src/services/canvas-api.ts` | `4641aa86599e2b941a250096a59bc3e0297084ee` | `671c9c4e988e2ed15a7f7758a1b7faabdc0cf213` | `671c9c4e988e2ed15a7f7758a1b7faabdc0cf213` |
| A | `apps/web/src/utils/canvasClientId.test.ts` | `deff5792db56e1c9346f38b26d319704e7b6d157` | (absent) | (absent) |
| A | `apps/web/src/utils/canvasClientId.ts` | `f5e5ed1a42059f22435cbd152f948bf525eb6642` | (absent) | (absent) |
| M | `packages/shared/src/canvasActionApplier.test.ts` | `836733d702914fd5a4cb70948e317915a4aba1b3` | `1f4a5e2dde3559118b7eab9e1e643c2fb699c4f0` | `1f4a5e2dde3559118b7eab9e1e643c2fb699c4f0` |
| M | `packages/shared/src/canvasActionApplier.ts` | `89b5758b8d23a8e6759b03c58589eac9f941b252` | `aedd981ae489b8106de0c34bb14aac32c0e1e959` | `aedd981ae489b8106de0c34bb14aac32c0e1e959` |

这 14 个路径恰等于 8 份 task brief 的 Files 清单汇总（task-1…task-7 声明的 14 个运行时文件；task-8 声明「Modify: 无」）。

### 判定

- **分支差异集 = 计划文件清单**：以裸 blob sha 对 baseline 逐路径比对，`bare-diff = 14` 且 `EXACTLY == git diff --name-only baseline..HEAD (14)` → **True**；`added_local = 6`（恰为 6 个 A 路径），`deleted_local = 0`。
- **`ALL_LOCAL_MATCH: True`** —— 4922 个非变更本地路径的裸 blob sha 全部等于 baseline tree，`drift_count = 0`；且 `disk bare sha == git tree sha` mismatch = 0。
- **`NO_OTHER: True`** —— `bare-diff − 14 = ∅`，无任何未登记改动。
- **无并行工作删除**：本分支 `D` 状态数 0；master 相对 baseline `ADDED=0 / REMOVED=0`；并行改动仅 **3 个 MODIFIED 路径**（`apps/web/index.html`、`apps/web/src/components/agent/AgentSideRail.vue`、`apps/web/src/composables/useMobileKeyboardInset.ts`），我的 worktree 对这 3 条仍保持 baseline 版本、`clobbered = []`，未回退/覆盖。`worktree-vs-master` 原始差异 17 = 14（我的改动）+ 3（上述并行改动，worktree 在 baseline），3 条全部 `byte-equal to baseline`、非我的删除。
- **`MASTER_MOVED_SAFE: True`** —— master 自基线前移（2 个提交），但 14 个被触碰路径在 master tree 的 blob 与 baseline **完全一致**（8 个 M 路径 sha 相同，6 个 A 路径在 master 仍 absent），`unsafe_touched_paths = []` ⇒ 本分支改动可干净叠加上新 master。按 R9，controller 推送时须以 `e743c469…` 为 parent / base_tree 以保留那 3 条并行改动；不追溯改写历史陈述。
- 交付文件 `docs/ops/2026-11-09-sp-e-stage1-local-acceptance.md` 在 master 与 baseline tree 均 absent（无路径冲突）。Step 3 核对针对 14 个 plan 运行时文件；本 Task 另按 R2 裁定新增这 **1 个授权内 docs 交付文件**（非 unregistered change，且**不修改任何运行时源码**）。
- **未 push、未 fetch、未 merge**：全部为 `gh api` 只读 REST，`git` 操作仅限本隔离 worktree。controller 负责推送。

---

## DEFERRED_PENDING_DEPLOY_AUTHORIZATION

以下 brief 步骤**未执行**，按控制器裁定 R2 显式挂账：

| brief 步骤 | 状态 | 原因 |
|---|---|---|
| **Step 4：合并与生产发布验收**（`git squash` 合并、`ALL_PARALLEL_KEPT`、生产 `curl` `https://119.29.173.89:8888/api/health/canvas-patch-metrics` 与 `/api/health`、生产 PATCH 响应形状逐字段比对、502 窗） | **NOT EXECUTED** | 用户授权范围仅「推送 PR + 走 SDD」。merge 即触发生产发布（`deploy.yml:4-23`，I12），合并/发布/生产验收是 SDD 明列停止条件，超出授权。**未 curl 生产、未 merge、未声称任何生产验收结论**。 |
| **Step 5：启动 14 天观测窗口 + 记录**（部署成功时间、镜像 tag、容器启动清零、起始 `snapshot()`、master SHA、§10.2 三门判定） | **NOT EXECUTED** | 窗口依赖 Step 4 的生产部署；无部署授权则窗口不能起算。**未启动窗口、未宣告数据门结果**。 |
| brief Step 6「commit 假生产验收记录」 | **REPLACED** | 改为提交本 LOCAL 验收报告（commit message `docs(sp-e): record stage-1 LOCAL acceptance, mutation matrix and deferred deploy`），不伪造生产/观测记录。 |

**显式挂账后果**：生产 `GET /api/health/canvas-patch-metrics` 六项计数未验收；14 天数据门未启动；阶段 2 无法开始；生产 PATCH 响应形状（I1）未经生产 curl 复核（仅本地回归覆盖）。这些项保持未闭环。

---

## 收尾

本文件仅为 **LOCAL 验收**：本地全量回归（14 files / 131 tests 绿，权威类型门 0 errors，CI `pnpm -r build` 绿）+ 行为级变异（7/7 RED、全部逐字节还原）+ 推前裸 blob sha 核对（`ALL_LOCAL_MATCH / NO_OTHER / MASTER_MOVED_SAFE`）。**不对任何未闭环项（合并发布、生产验收、14 天观测窗口、数据门）宣告 `ALL_PASS`。**
