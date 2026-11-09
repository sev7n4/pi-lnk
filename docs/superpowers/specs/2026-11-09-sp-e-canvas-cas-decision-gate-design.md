# SP-E 画布并发写 CAS：决策门规格（v2.1，13 章）

> **状态**：⏳ 阶段 0 交付，待审阅；**零代码改动、零生产发布**
> **承接**：PR #625 的 `2026-11-02-sp-e-canvas-write-cas-design-v2.md`（仍 open、未修订）
> **上游**：`docs/superpowers/specs/2026-11-02-p1c-write-path-governance-design.md` §7-4
> **事实基线**：true master `2b6693c579ff2931a84d1954e93fecf5617db91`（tree `c246b370af827b15dc3624c2c730c498c9fe14d7`）；取证窗口 2026-11-09 17:56–18:09 GMT+8
> **取证纪律**：本机 ↔ GitHub 全链路阻断（HTTPS git 代理 502 / SSH publickey denied），**只有 `gh api` 可达** ⇒ 全部源码经 Git Data REST 按裸 blob sha 拉取，不信任本地 ref、不信任本地工作树（本地主仓脏且落后）。
> **历史纪律**：本规格取代 v2 的「立即实施 CAS」主张，但**不追溯改写** v2 正文、11-06 评审意见、上游 §7-4 的历史陈述；一切更新以「只追加状态回填」形式落盘（§12）。

---

## 1. 决策门与本次裁决

### 1.1 问题不是「CAS 怎么做」，而是「还值不值得做」

上游 P1-C 规格 §7-4 第 4 条拍板原文：

> **SP-E PR #625 处置**：并入 C1（canvasVersion 作为 PATCH 可选响应字段+冲突 409，opt-in）vs 维持独立评审（C1 先行、CAS 后叠）。建议：**维持独立**——C1 已含并发语义改善，CAS 作为独立增强在 C1 落地后重新评审其必要性（冲突面已缩小，CAS 的边际价值需重估）。

C1 及后续 P1b / C2② / Phase 5 已全部落地（§3）。**这次重估此前从未发生**：v2 只把收益主体从「PUT 整份覆盖」换成「PATCH op 流」，没有回答边际价值问题；11-06 的「有条件通过」评审意见同样建立在 11-02 基线上。PR #625 的 `updated_at` 停在 `2026-11-06T16:32:26Z`、head 仍为 `bdc2bd9713e36d9d01f998f2ded24b4cb48d9326`，实证两者都未修订。

### 1.2 裁决：`A — 决策门`，三阶段

| 阶段 | 交付 | 发布面 | 用户可见行为变化 |
|---|---|---|---|
| **0**（本刀） | 本规格 + 上游只追加回填 + 实施计划 + 文档登记 + PR 草稿 | **零发布**（`deploy.yml` `push.paths` 不含 `docs/`） | 无 |
| **1** | 零契约观测 + op 幂等加固（§9） | 一次生产发布（改 `apps/server/**`、`apps/web/**`、`packages/**`） | **零 409、零拒绝、零 UX 变化** |
| **2** | 14 天数据门（§10） | 达标才升级 409；不达标则 NO-GO 定案 | 达标才有 |

**本轮执行边界**：只做阶段 0。阶段 1 的代码实施与生产发布**需另行授权**；阶段 2 的 409 升级需数据门通过 + 新规格评审。

### 1.3 决策门的三条升级条件（须同时满足）

1. 观测窗口内 `stale_conflict`（同一 session、不同 `clientId`、目标键相交、间隔 ≤2s）**≥ 30 次且涉及 ≥ 3 个不同 session**；
2. 至少 **1 起可复现的用户可感知丢失**（工单 / 录屏 / 生产对账记录），而非理论推演；
3. 用同一份埋点回放预估 **409 率 < 0.5%**，且后台写者造成的用户版本顶掉次数为 0（§11 的 `userRev/sysRev` 分离已验证）。

三条不全满足 ⇒ **NO-GO 定案**：关闭或改写 PR #625 为「观测结项 + 幂等加固」，并把结论只追加回填进上游 §7-4（§12）。**不得**用「再观察一阵」无限延期，也不得在证据不足时宣告 ALL_PASS。

### 1.4 改判条件（本建议可能错在哪）

| 触发 | 改为 |
|---|---|
| 出现确凿客诉 / 事故工单证明画布丢失 | 直接走「B：重修规格后实施」，且优先做 op 幂等加固，不等 14 天 |
| PR #625 有对外承诺 / 合同 / 合规硬要求 | 直接走 B，把「成本不划算」从否决理由降级为已知代价 |
| 产品战略把「多人实时协作」定为一等公民 | **方向重选**：应上 CRDT / OT 或操作变换，CAS 只是单人多标签止血，v2 规格本身选错武器 |

---

## 2. 事实基线、取证方法与执行时状态回填

### 2.1 可复现取证命令

```bash
# 真实 HEAD（禁信本地 ref）
gh api repos/sev7n4/pi-lnk/commits/master --jq '{sha,date:.commit.author.date,tree:.commit.tree.sha}'

# 全树 → 路径:裸 blob sha 映射（tree sha 取自上一条命令）
gh api "repos/sev7n4/pi-lnk/git/trees/c246b370af827b15dc3624c2c730c498c9fe14d7?recursive=1" > tree.json

# 按裸 sha 取单文件（示例：上游 P1-C 规格；内容寻址、幂等）
gh api "repos/sev7n4/pi-lnk/git/blobs/76d006cd87c8b3039dd828bddfda2a83541c0ae6" --jq '.content' | base64 -d > p1c-spec.md

# 裸 blob sha 校验（禁走 index / git hash-object，非 ASCII 会乱码）
python3 -c 'import sys,hashlib;d=open(sys.argv[1],"rb").read();print(hashlib.sha1(b"blob %d\0"%len(d)+d).hexdigest())' p1c-spec.md
```

⚠️ zsh 里变量紧跟冒号必须加花括号：`git show ${REV}:<path>`；`2>/dev/null` 会把 `fatal:` 吞掉，让「命令拼错」伪装成「符号不存在」。

### 2.2 三个时点的状态（只追加，不追溯改写）

| 时点 | master | 说明 |
|---|---|---|
| v2 规格基线（11-02） | `d407ad98` | 规格 §2 全部陈述的取证时点 |
| 本轮首次审视（11-09 17:56） | `d7c8246b` | 比基线前进 **121 提交 / 300 文件**；9 条证伪 + 10 条遗漏基于此 |
| **执行时回填（11-09 18:09）** | `2b6693c5` | 又 +1 提交（#797 移动端键盘修复），`compare/d7c8246b...master` 得 `ahead_by=1`、`files=[apps/web/src/components/agent/AgentSideRail.vue, apps/web/src/composables/useMobileKeyboardInset.ts]` ⇒ **与画布写路径零相交**，§4 全部结论仍成立 |

生产侧：容器 `lnkpi-api:b1190a2a`（11-08 #783）比 master 滞后，#797 是 web-only（API 构建 skipped）⇒ **服务端写路径治理代码不受影响**；已在生产 bundle 命中 `canvas_put_rejected` 与 `transactGovernedCanvasOps`，`/api/health` ok。

### 2.3 关键源码锚点索引（本规格每条代码陈述均可回查）

| 主题 | 精确位置 |
|---|---|
| PUT 关闭 | `apps/server/src/sessions/sessions.service.ts:100-115`、`apps/server/src/canvas/canvas.service.ts:71-84`；行为级锁定 `canvas.service.put-rejected.test.ts:13` |
| `canvas_put_rejected` 打点 | `sessions.service.ts:107` |
| 写点白名单守卫 | `apps/server/src/sessions/canvas-write-governance.test.ts:35-58`（7 文件 / 12 写点） |
| PATCH 主通道 | `sessions.service.ts:160-176`（`$transaction` 读最新 → `applyCanvasActions` → 写回 → 返回 `{ applied }`） |
| PATCH DTO | `apps/server/src/sessions/sessions.controller.ts:22-26`（`PatchCanvasDto` 仅 `ops!` 带 `@IsArray/@ArrayMaxSize(200)`） |
| 全局管道 | `apps/server/src/main.ts:31` `new ValidationPipe({ transform: true, whitelist: true })` |
| 八键 ratchet | `apps/server/src/sessions/sessions-canvas-patch.ts:28-37`（`CLIENT_FORBIDDEN_NODE_DATA_KEYS`）；`apps/web/src/utils/canvasDiff.ts:35-44` |
| 统一事务通道 | `apps/server/src/sessions/canvas-op-write.ts:75-104` `transactGovernedCanvasOps(...)`；`GovernedCanvasOpOpts` 已有 `onGuardReject?: (nodeId: string) => void`（:67） |
| applier SSOT | `packages/shared/src/canvasActionApplier.ts`；`update_node` :135-156、`add_edge` :158-165 |
| 前端 diff | `canvasDiff.ts:157,162` 生成的 `add_edge` **带 id**；`canvasDiff.test.ts:121` 断言之 |
| 前端保存 | `apps/web/src/pages/CanvasPage.vue:5266-5372`；失败对账纪律 `:5332-5357` |
| 前端 API | `apps/web/src/services/canvas-api.ts:17-18` `patchCanvas(id, ops)` |
| 静态契约锚点 | `apps/web/src/pages/canvas/canvasLoadGuard.wiring.test.ts:46`、`apps/web/src/pages/CanvasPage.mobileChromeHygiene.test.ts:84`（均锚定 `await canvasApi.patchCanvas(` 字面量） |
| 度量模式 | `apps/server/src/studio/notify-metrics.ts`（进程内存 `NotifyMetrics`）；`apps/server/src/health/health.controller.ts:22-33` `GET /api/health/notify-metrics` |
| 发布触发 | `.github/workflows/deploy.yml:4-23` `push.paths` |
| 迁移 | `deploy/docker/docker-entrypoint.sh:32` `prisma migrate deploy` |

---

## 3. 现状写路径架构（代码事实，非规格转述）

```
web CanvasPage.saveCanvas()
  ├─ diffCanvasData(lastSavedCanvasSnapshot, 本次形状)   ← 8 键剥除 + 只提交变化键
  ├─ canvasApi.patchCanvas(id, ops)  ── PATCH /sessions/:id/canvas { ops }
  │     └─ sessions.service.ts:160-176  $transaction
  │          读当前 canvasData → sanitize(8 键) → applyCanvasActions(shared SSOT)
  │          → tx.session.update → 返回 { applied }
  └─ 失败：全量 GET 对账重建基线 + 丢弃 diff，不本地重放
                                        （10-26 抹画布事故纪律）

后台写者（digest / url 回写 / node status / composition / stories / works）
  └─ canvas-op-write.ts:75  transactGovernedCanvasOps(...)  ← 同一事务 + op 语义
```

四条已生效的结构性保护：

1. **整份 PUT 已关闭**（11-03 C2②）：带 `canvasData` 的 PUT 只落 title 并打 `canvas_put_rejected` warn，不落库；`canvas.service.put-rejected.test.ts` 行为级锁定。
2. **写点全部治理化**：7 文件 / 12 写点由 `canvas-write-governance.test.ts` 白名单全目录扫描守卫；composition / persist-remote 已迁统一事务通道，新增 status 服务与 create 种子均已登记。
3. **服务端专属键已剥**：8 键（含 P1b 生产事故后补的 `digest` / `digestVersion` / `source`）前后端双端 ratchet。
4. **op 应用只有一处**：Phase 5 收敛到 `packages/shared/src/canvasActionApplier.ts`，两端薄适配器委托；键级 merge 取代整份覆盖。

`Session` 模型**无 `canvasVersion` 列**；`formatSession()` / `canvas-api.ts` / `lastSavedCanvasSnapshot` 均无版本字段；`PATCH` 请求 `{ops}`、响应 `{applied}`，无版本、无 409。

---

## 4. 三张清单：证伪 / 仍成立 / 被遗漏

### 4.1 被最新代码证伪（9 条，v2 与 11-06 评审意见均失效）

| # | v2 陈述 | 代码事实 |
|---|---|---|
| 1 | PUT 处于弃用期，需给 PUT 加 bump | 已关闭；给 PUT 加 bump 会让「改标题」也 bump ⇒ 假 409，`sessions.service.ts:100-115` |
| 2 | 写者矩阵「9 处」 | 实为 **7 文件 / 12 写点**，既有守卫白名单逐项吻合 |
| 3 | `rewriteCanvasData` 分支需事务化 | 三条 finalize 路径全传 `false`，**零 true 调用方**，是死分支 |
| 4 | 「五键剥除」 | 已扩 **8 键**（P1b 11-07 生产事故） |
| 5 | `applyActionsToFlow` 独立 switch | Phase 5 已收敛为 shared 单一 SSOT |
| 6 | PATCH 只有 web 一家调用方 | `deploy/prod-layout-workflow-verify.py:187` 直接 PATCH 且不带版本；V-2「legacy 连续 7 天 0」另有旧 web 缓存污染面 |
| 7 | 需新建 bump 守卫 | master 已有全目录扫描 + 白名单 + 变异纪律的守卫，再建第二套必冲突 |
| 8 | C2② 存在时序风险 | 已完成 |
| 9 | 存在「两处 op 应用器」 | 实现已一处 |

### 4.2 仍成立（6 条，是残损面的输入）

PATCH 仍 `{ops}`→`{applied}` 无版本；`formatSession` / `canvas-api` / 快照均无版本；Session 无 `canvasVersion`；`update_node` 打已删节点确为静默 no-op（`canvasActionApplier.ts:135-156` 的 `if (node)` 无 else）；8 类 op；`deploy-api` 与 `deploy-web` 并行无依赖；ADR-0016 编号未占用；生产启动会跑 `migrate deploy`（`docker-entrypoint.sh:32`）。

### 4.3 v2 与 11-06 评审意见都漏掉（10 条，按风险排序）

1. **DTO 假绿（最高）**：`main.ts:31` 全局 `whitelist:true`；`PatchCanvasDto` 新增 `expectedVersion?` 若不配 `@IsOptional/@IsInt/@Min(0)`，字段被静默剥掉 ⇒ CAS 永不生效、legacy 恒增，绕过管道的测试还全绿。仓库有 8+ 个同管道透传测试先例（如 `agent.controller.messages-dto.test.ts`、`share.controller.test.ts:16`）。
2. **保存重入**：`CanvasPage.vue:5267` 的 `saving.value` 只是状态位不是锁，全页 ≥12 处 `void saveCanvas()` 并发；v2 只写「快照与版本同源同刻」，未定在途锁 / 保存令牌。
3. **与事故纪律冲突**：`CanvasPage.vue:5332-5357` 规定任何 PATCH 失败 ⇒ 全量 GET 对账 + **丢弃 diff、不做本地重放**；上游 P1-C 规格 §8 亦定 staged 409「对账重试一次」。v2 图 2 的「重放重发」在推翻这条纪律，且未论证未裁决。
4. **重放不幂等**：`canvasActionApplier.ts:158-165` `add_edge` 无条件 `result.edges.push(...)`。注释 `:15-16` 声称「缺 id 时按 `e-${source}-${target}` 生成……重放幂等」，但实现**未查重**；而 `canvasDiff.ts:157,162` 生成的 `add_edge` **带 id**（`canvasDiff.test.ts:121` 断言）⇒ 原样重发会造重复边。v2 未定「重新 diff」还是「原 ops 重放」。
5. **静态契约会撞门**：`canvasLoadGuard.wiring.test.ts:46` 与 `mobileChromeHygiene.test.ts:84` 锚定 `await canvasApi.patchCanvas(` 字面量，§9 清单未列。
6. **agent 观测落不了地**：`persist(sessionId, actions)` 无版本参数，owner / detached / out-of-turn 三路径无「回合首次装载基线」统一取点（评审 C1/C2 成立）。
7. **CAS 原语歧义**：§5.2 既说「事务首个 select 取版本」又写 `where { canvasVersion: expected }` —— 必须钉死 where 用**客户端 expected**，select 只用于 409 回传 actual；误用 select 值 ⇒ 永不冲突。`updateMany` 不返回行，新版本取 `expected+1` 也未写明。
8. **后台写者 bump 风暴**：状态机对账 / url 回写 / 侧车 / Canvas Digest 每回合都写画布；若 G-1「任何写都 +1」，用户编辑会被后台写频繁顶掉 ⇒ 409 循环。v2 未定义「什么算用户可感知版本」，未评 409 频率与重试上界。
9. **发布面**：本刀必动 `apps/server/**` + schema/migrations + `apps/web/**` ⇒ 命中 `deploy.yml:4-23`，合并即触发生产发布；迁移在容器启动时与 web 并行，无回滚 / 迁移失败 / 502 预案；生产还滞后 master。
10. **双 409 优先级 + 409 body 形状**未定（`stagedActions` 既有 409 at `sessions.service.ts:161-165` vs 新版本 409；Nest `ConflictException` 默认体 vs 前端 `error.response.data`）。

**对 11-06 评审意见的校正**：#3「PG MVCC 让条件写静默失效」机理存疑 —— `UPDATE … WHERE canvasVersion = expected` 在 READ COMMITTED 下会重评条件，原子性不依赖「读持锁」；真风险是参数来源（见 4.3 #7）。建议**采纳其 S8 集成测试**，但不要把错误机理写进规格。#1/#2/C1/C2/C4/C5/C6 成立，须按新事实改写（C5 已从「待核实」变成「实证存在第二调用方」）。

---

## 5. 生产证据：流量与可观测性分辨率

数据源：生产 nginx `/var/log/nginx/access.log` + 8 份轮转（含 `.gz`），窗口 **2026-11-02 ~ 11-09**，只读统计，未改生产。

| 指标 | 实测 |
|---|---|
| `PATCH /api/sessions/:id/canvas` 总量 | **9088** |
| 涉及 session | **83**（62 个有多次 PATCH） |
| 相邻 PATCH ≤2s / ≤10s | **3534 对** / 7779 对；58 个 session 有 2s 内相邻写 |
| 状态分布 | `200=9019`、`404=57`（集中 1 个 session，疑旧缓存）、`502=4`（11-05 16:06-16:07 部署窗）、`401=7`、`403=1`；**零 409、零冲突信号** |
| UA / IP | 100% Mozilla（urllib 验证脚本 `prod-layout-workflow-verify.py:69-77` 不设 UA，此窗未命中）；4 个移动网 IP 占 >90% |
| 同 session ≤2s 相邻对中来自不同 IP | **1 对** |

### 5.1 这份数据能证明什么、不能证明什么

- **能**：写路径有真实量；2s 近距写有 **3534 对**的量级 ⇒ 若按 G-1「任何写都 bump + 前端带 expected」，后台写者插入即制造假 409，**bump 风暴不是理论风险**。
- **不能**：现有日志的分辨率只有 `(IP, UA, 秒)`。CAS 要防的是「同一 session 的两个客户端**内存基线**」，同 IP + 同 UA 的两个标签页 / 两台设备在日志里完全同形。⇒ **无法证明、也无法证伪「过期基线冲突」的存在与频率**。v2 的收益论证缺少分母。
- **不能**：access log 不含 body，无法得知 ops 的目标键是否相交，也无法判断 `applied` 里有多少 `skipped`。

⇒ 结论：要么先补一层能观测到「客户端实例 × 目标键 × stale」的服务端结构化埋点（§9），要么承认这是无证据决策。**先补证据**是本次裁决 A 的第一原理。

现有可复用埋点基础设施：`studio/notify-metrics.ts` 的进程内存 `NotifyMetrics`（`incrNotified` / `incrScan` / `snapshot` / `reset`）+ `health/health.controller.ts:22` 的 `GET /api/health/notify-metrics`；`canvas_put_rejected` 为 `Logger.warn` 单行。尚无 PATCH 级埋点。

---

## 6. 残损面精算与「更便宜的 80%」

到 `2b6693c5`，真实残损面只剩两类：

| 残损 | 现状 | 触发条件 |
|---|---|---|
| **R1 过期基线 op 静默 no-op** | `update_node` 命中已删节点时 `if (node)` 无 else（applier :135-156），响应仍 `{applied}` 计数 | 一端删节点、另一端持旧快照改同一节点 |
| **R2 同字段后写赢** | 键级 merge，无版本比较 | 两端同刻改同一字段 |

**已被消解、不该再算收益的**：整份覆盖抹画布、后台写者整份回灌、服务端专属键被客户端陈旧值覆盖（P1b 事故）、双 applier 漂移、PUT 通道。

为 R1+R2 引入「DB 列 + 迁移 + 前后端契约 + 409 UX + 3 个计数 + 一次生产发布」，成本远大于残损。更便宜的 80% 是：

1. **`add_edge` 查重**：重复 id 不再 push ⇒ 重放安全，也顺带修掉注释与实现不符的隐患；
2. **`update_node` 目标缺失留痕**：通过可选回调上报 `skipped`，让 R1 从「静默」变成「可观测」；
3. **PATCH 级结构化埋点**：给 R2 一个可量化的分母。

这三项**不改契约、不加列、不拒绝任何请求、不改变用户可见行为**，且能独立回滚（§9）。

---

## 7. 方案比选

| 路径 | 内容 | 成本 | 裁决 |
|---|---|---|---|
| **A（推荐）决策门** | 阶段 0 重估 + 阶段 1 零契约观测 + 阶段 2 数据门 | 一次文档刀 + 一次低风险发布 + 14 天观测 | ✅ **采纳**：唯一能在有分母的前提下决策的路径 |
| B 认定必做，只修规格 | 基于 `2b6693c5` 重写 13 章，闭合 9 证伪 + 10 遗漏 | 仍然一次生产发布 + 全部 CAS 复杂度 | ❌ 修的是文档，漏的是上游 §7-4 要求的「重估必要性」 |
| C 缩小范围 | 只做 `canvasVersion` 列 + 回传 + 计数 | DB 列 + 迁移 + 半套前端契约 | ❌ 无数据支撑，且留下没有消费者的版本字段；半吊子契约比没有更贵 |
| D 按 v2 原样实施 | 直接落地 | 同上 + 已知缺陷 | ❌ 会引入假 409、DTO 假绿，并推翻 10-26 事故纪律 |

A 与 C 的关系：C 的「计数」价值被吸收进 A 的阶段 1，但 A **不引入版本列 / 版本回传**，避免迁移与半契约。

评审意见中「S8 集成测试」在阶段 1 的 Task 8（生产验收）体现；「PG MVCC」错误机理不写入规格（§4.3 校正）。

---

## 8. 阶段 0 设计（本刀交付物与零发布证明）

| # | 交付物 | 路径 | 性质 |
|---|---|---|---|
| 1 | 13 章决策门规格 | `docs/superpowers/specs/2026-11-09-sp-e-canvas-cas-decision-gate-design.md` | 新建 |
| 2 | 阶段 1 实施计划 | `docs/superpowers/plans/2026-11-09-sp-e-phase1-observability.md` | 新建 |
| 3 | 回填与登记补丁包 | `outputs/sp-e-stage0-append-pack.md` | 新建（含上游 §7-4 追加段、`docs/README.md` 登记行、PR #625 评论草稿、`append_only` 校验命令） |
| 4 | 上游 §7-4 只追加回填 | `docs/superpowers/specs/2026-11-02-p1c-write-path-governance-design.md` | **待应用**（补丁包 §A） |
| 5 | 文档登记 | `docs/README.md` | **待应用**（补丁包 §B） |
| 6 | PR #625 审视结论回填 | PR 评论 | **待发**（补丁包 §C） |

**为何 4/5/6 不直接落盘 / 不自动发**：本地工作树与 master 不一致 —— 上游 P1-C 规格本地 **ABSENT**（master 裸 blob sha `76d006cd87c8b3039dd828bddfda2a83541c0ae6`），`docs/README.md` 本地裸 blob sha `2e0d21f65f13…` ≠ master `19c3a619286a65ef50f9ce4eab722dc13b3d35e6`（落后约 9 行）；直接追加会基于落后副本，违反「逐路径裸 blob sha 比对」纪律。PR 评论是外部动作，需用户单独授权。**补丁包给出基于 master 裸 blob 的精确追加内容与 `append_only` 校验命令**，推 PR 时应用。

**零发布证明**：`.github/workflows/deploy.yml:4-23` 的 `push.paths` 只含 `apps/server/**` / `apps/web/**` / `packages/**` / `deploy/**`（含两条 exclude）/ `prompt-registry/**` / `package.json` / lock / workspace / `.dockerignore` / `.github/workflows/deploy.yml`；**不含 `docs/`、`scripts/`、`ci.yml`** ⇒ 纯文档刀零生产发布。本刀不碰上述任一路径。

---

## 9. 阶段 1 设计：零契约观测 + op 幂等加固

### 9.1 不变式（Invariants）

| ID | 不变式 |
|---|---|
| I1 | `PATCH /sessions/:id/canvas` 的请求体与响应体**形状不变**：仍 `{ops}` → `{applied}`；不新增必填字段、不新增状态码 |
| I2 | 不新增 Prisma 列、不新增 migration、不改 `schema.prisma` |
| I3 | 不新增 409 / 不拒绝任何请求；失败语义沿用 `CanvasPage.vue:5332-5357` 的对账纪律 |
| I4 | `clientId` 仅用于观测，不参与鉴权、不参与任何判定；缺失时降级为 `unknown` 且不报错 |
| I5 | `applyCanvasActions` 的返回形状不变；新增能力一律走可选回调（沿用 `ApplyCanvasActionsOpts.onGuardReject` 的既有模式，applier :20-27） |
| I6 | 不改 `CanvasPage.vue` 中 `await canvasApi.patchCanvas(` 字面量（两处静态契约锚点） |

### 9.2 组件与数据流

```
[web] canvasClientId（sessionStorage 随机，per-tab）
        └─ canvas-api.patchCanvas 增加可选第 3 参数 / 或内部注入 header
              PATCH 带 x-lnkpi-canvas-client
                    ↓
[server] sessions.controller.ts 读 header（@Req，不进 DTO ⇒ 绕开 whitelist 风险）
        └─ sessions.service.ts:160-176 事务内
              ├─ 每条 op 记录 { type, targetKey, clientId, sessionId, ts }
              ├─ applyCanvasActions(current, ops, { onSkipped })
              │      ├─ add_edge：若 edges.some(e => e.id === edgeId) ⇒ 不 push + onSkipped
              │      └─ update_node：node 不存在 ⇒ onSkipped('node_not_found')
              └─ canvasPatchMetrics.incr(...)  ← 进程内存，仿 NotifyMetrics
                    ↓
[health] GET /api/health/canvas-patch-metrics  → snapshot()
```

**为何 header 不进 DTO**：`main.ts:31` 的 `whitelist:true` 会静默剥掉未装饰字段（§4.3 #1）。阶段 1 完全不碰 DTO，从根上规避该类假绿。将来若阶段 2 真要加 `expectedVersion`，必须配齐装饰器 + 同管道透传回归（§11）。

### 9.3 埋点字段（最小充分集）

| 字段 | 含义 | 用途 |
|---|---|---|
| `patches` | PATCH 请求数 | 分母 |
| `ops` / `applied` / `skipped` | op 总数 / 落地数 / 跳过数 | R1 量化 |
| `skippedByType` | 按 op type 分组的 skip | 定位 R1 集中点 |
| `distinctClients` | 同 session 观测到的不同 `clientId` 数 | 多写者上界 |
| `nearConcurrentPairs` | 同 session 相邻 PATCH ≤2s 且 `clientId` 不同 | **数据门主指标** |
| `keyOverlapPairs` | 上一对中目标键相交的对数 | `stale_conflict` 计数 |

计数器为**进程内存单例**（与 `notifyMetrics` 同模式），重启清零 ⇒ 观测窗口以「上次部署后」为界，生产取数须记录容器启动时间；**不落库、不加列**。

### 9.4 错误处理

- header 缺失 / 非法 ⇒ `clientId = 'unknown'`，计数照常，不抛错（I4）。
- 埋点自身异常 ⇒ `try/catch` 吞掉并 `Logger.warn`，**绝不影响 PATCH 主流程**（观测不得成为故障源）。
- `onSkipped` 回调仅计数，不改变 op 的落地结果（I5）。
- `add_edge` 查重是行为修正（重复 id 不再产生第二条边），有行为级测试 + 变异测试覆盖（§12）。

### 9.5 测试分层

| 层 | 内容 |
|---|---|
| 纯函数 | `canvasClientId` 同 tab 稳定 / 新 tab 不同 / 无 `sessionStorage` 降级；`applyCanvasActions` 重复边、缺失节点回调 |
| 管道级 | header 读取不进 DTO；`NotifyMetrics` 同款计数器的 `snapshot/reset` |
| 行为级 | 真实 PATCH 调用后 `applied/skipped` 与 `skippedByType` 精确值；`nearConcurrentPairs` 只在 clientId 不同且 ≤2s 时 +1 |
| 静态契约 | 两处 `patchCanvas(` 锚点仍命中；`deploy.yml` paths 未新增 docs |
| 生产验收 | `GET /api/health/canvas-patch-metrics` 可读、字段齐；`PATCH` 响应形状逐字节比对（I1） |

---

## 10. 阶段 2 数据门与 NO-GO 定案

### 10.1 观测窗口

14 个自然日，自阶段 1 生产部署成功且 health 端点可读起算。窗口内**禁止**改动 PATCH 契约，否则样本作废。

### 10.2 取数与判据

```bash
curl -sS --noproxy '*' https://<prod>/api/health/canvas-patch-metrics | jq .
```

| 门 | 阈值 | 不满足时 |
|---|---|---|
| G1 真实冲突 | `stale_conflict ≥ 30` 且涉及 `≥ 3` 个 session | NO-GO |
| G2 用户可感知 | ≥1 起可复现丢失证据 | NO-GO |
| G3 409 预算 | 回放预估 `409 / patches < 0.5%` 且后台写顶掉 = 0 | NO-GO |

`stale_conflict` 定义：同 session、不同 `clientId`、相邻 ≤2s、目标键相交的 PATCH 对。该定义必须在阶段 1 代码里以常量与注释固定，避免取数时口径漂移。

### 10.3 NO-GO 定案动作

1. PR #625 关闭或改写为「观测结项 + 幂等加固」，正文附取数快照与三条门的实测值；
2. 上游 §7-4 追加「重估已执行，结论 NO-GO」（只追加，不改写原裁决）；
3. 本规格 §1.3 状态改为 `DECIDED_NO_GO`，记录日期与证据路径；
4. **不宣告未闭环项 ALL_PASS**；剩余 R1/R2 作为已知残损登记，不隐性留白。

### 10.4 若门通过

须另起规格：闭合 §4.3 全部 10 条、满足 §11 全部硬约束、走「规格评审 → 实施计划 → 执行授权」完整链路，不得凭本规格直接开刀。

---

## 11. 升级 409 的前置硬约束（阶段 2 通过才适用）

| # | 约束 |
|---|---|
| H1 | `expectedVersion` 必须配 `@IsOptional() @IsInt() @Min(0)`；必须有**真实 `ValidationPipe({transform:true,whitelist:true})` 透传回归测试**（先写失败测试），断言字段未被剥除 |
| H2 | CAS 的 `where` **只能用客户端传入的 expected**；事务内 `select` 读到的版本只用于 409 回传 `actual`。误用 select 值 ⇒ 永不冲突 |
| H3 | `updateMany` 不返回行 ⇒ 新版本取 `expected + 1`，并在同事务内写回；`updateMany` 的 `count` 必须为 1 才提交 |
| H4 | **双 409 优先级**：既有 `stagedActions` 409（`sessions.service.ts:161-165`）优先于版本 409；409 body 形状显式定义（含 `code` / `expected` / `actual`），前端按 `error.response.data` 消费 |
| H5 | **userRev / sysRev 分离**：只有用户编辑 bump `userRev`；后台写者（digest / url 回写 / node status / 侧车）只 bump `sysRev`，不得顶掉用户 expected ⇒ 消除 §5 的 3534 对近距写风暴 |
| H6 | **不得违反丢弃 diff 纪律**：409 后只允许「全量 GET 对账重建基线 → 丢弃本次 diff」，**禁止原 ops 重放**（`add_edge` 重放不幂等，§4.3 #4）；重试上界 **1 次** |
| H7 | 同步两处静态契约锚点（`canvasLoadGuard.wiring.test.ts:46`、`mobileChromeHygiene.test.ts:84`），以及 `deploy/prod-layout-workflow-verify.py:187` 的第二 PATCH 调用方 |
| H8 | 保存重入：`saving.value` 不是锁 ⇒ 必须定义在途锁 / 保存令牌，否则「快照与版本同源同刻」无法成立 |
| H9 | agent 侧：`persist(sessionId, actions)` 增加回合首次装载基线的统一取点，覆盖 owner / detached / out-of-turn 三路径 |
| H10 | 生产发布预案：迁移与 web 并行（`deploy.yml`）、`docker-entrypoint.sh:32` 失败语义、502 窗（约 30s）、回滚顺序（先 revert 前端契约还是先回滚 DB 列）必须写进实施计划并复测 |

---

## 12. 发布面、验收判据与准入三问

### 12.1 发布面

阶段 1 改动 `apps/server/**`、`apps/web/**`、`packages/**` ⇒ 命中 `deploy.yml:4-23`，**合并即触发生产发布**（`deploy-api` 与 `deploy-web` 并行无依赖）。生产当前比 master 滞后 ⇒ 推前必须重取 true master 并逐路径裸 blob sha 比对，禁止从落后 worktree 建包（历史事故：曾回退 17 个 master 提交）。合并时 master 可能再前移一次，须按 commit 真实 parent 核对 `ALL_PARALLEL_KEPT`。

阶段 1 **无 migration**（I2）⇒ 规避 `migrate deploy` 与 web 并行的最大风险面，也是选「零契约」的重要理由。

### 12.2 验收判据（行为级）

| ID | 判据 |
|---|---|
| V1 | 阶段 0：三份新文件存在；`docs/` 之外零改动；`deploy.yml` 未触发 |
| V2 | 上游 §7-4 回填 `append_only=True`（前缀字节与 master 裸 blob 全等） |
| V3 | `PATCH` 请求 / 响应形状逐字段不变（I1），生产 curl 复现 |
| V4 | 重复 `add_edge` 不产生第二条边；`update_node` 打已删节点触发 `onSkipped` 且 `skipped` +1 |
| V5 | health 端点六项计数可读，缺失 clientId 降级不报错 |
| V6 | 两处静态契约锚点仍命中；全目录扫描守卫白名单无新增未登记写点 |
| V7 | 变异测试：至少 7 组行为级变异全部 RED；警惕伪变异（注入点被下游过滤 / 余量吞掉）与判据自匹配恒绿（断言锚点写在判据函数自身 ⇒ 用 `implementation_code()` 剔除判据体） |

### 12.3 准入三问（阶段 2 数据门能否挂 CI）

| 问 | 答 |
|---|---|
| 零外部依赖？ | ❌ 依赖生产 access log / health 端点 / 14 天真实流量 |
| 确定性？ | ❌ 用户行为样本非确定性 |
| 可失败？ | ✅ 但失败不能归因到代码回归 |

⇒ **结论：数据门不挂 CI**，只做人工 + 脚本取证（与 CDP 冒烟、PC 视觉护栏同纪律）。CI 只承载零外部依赖、确定性、可失败的静态契约与单测。

### 12.4 完成定义

阶段 0 完成 = 三份新文件落盘 + 四项自审通过（§13）+ 补丁包 `append_only` 校验命令可执行。**不含**：PR 推送、评论发布、代码实施、生产发布、14 天观测。

---

## 13. 只追加回填、文档登记、自审记录与未闭环清单

### 13.1 上游 §7-4 回填（只追加）

追加位置：`docs/superpowers/specs/2026-11-02-p1c-write-path-governance-design.md` 文件末尾（§8 风险表之后），**新增 §9**，不改动 §7-4 原文一个字节。追加内容见补丁包 §A，含：重估执行日期、true master SHA、生产证据摘要、裁决 `A / NO_GO_FOR_IMPLEMENTATION`、后继规格链接。

校验（推 PR 前必跑）：

```bash
python3 - <<'PY'
import hashlib,subprocess,base64
p='docs/superpowers/specs/2026-11-02-p1c-write-path-governance-design.md'
sha='76d006cd87c8b3039dd828bddfda2a83541c0ae6'
master=base64.b64decode(subprocess.check_output(
  ['gh','api','repos/sev7n4/pi-lnk/git/blobs/'+sha,'--jq','.content'],text=True).replace('\n',''))
new=open(p,'rb').read()
assert new.startswith(master), 'APPEND_ONLY_VIOLATED'
assert hashlib.sha1(b'blob %d\0'%len(master)+master).hexdigest()==sha
print('APPEND_ONLY_OK prefix_bytes=',len(master),'appended_bytes=',len(new)-len(master))
PY
```

⚠️ 中文文档按**字节**切片，不按字符；`.snap` / 换行一并计入。master 裸 blob sha（本轮实测）`76d006cd87c8…`；推前须用 `gh api` 重取，若 master 前移且该路径 blob 不变则 `MASTER_MOVED_SAFE` 换 parent/base_tree 即可。

### 13.2 文档登记

`docs/README.md` 新增文档必须登记（`docs/agent/docs.md:26`）。补丁包 §B 给出两行表格（spec + plan）与插入位置（「架构审视」章节之后）。`docs/superpowers/INDEX.md` 是生成产物、**禁止手改**；新增文档后跑：

```bash
python3 scripts/docs/gen_index.py > scripts/docs/index_data.json && python3 scripts/docs/gen_index_md.py
```

### 13.3 四项自审

| 项 | 检查 | 结果 |
|---|---|---|
| 占位符 | 逐项检查「延后实现 / 待补细节 / 泛化措辞 / 相似任务引用 / 未定义符号」五类**实例**（检查项名称本身不算实例） | 0 个实例；所有步骤有精确路径、行号、命令；文中 sha 均为真实 40 位值，无尖括号参数 |
| 一致性 | 三阶段编号 / master SHA / 9088 / 3534 / 7 文件 12 写点 / 8 键 / 13 章编号在全文、`outputs/sp-e-stage0-append-pack.md` 与实施计划间一致 | 一致 |
| 范围 | 阶段 0 不碰 `apps/**` / `packages/**` / `deploy/**` / `schema.prisma`；阶段 1 才有发布面 | 边界明确 |
| 歧义 | 「冲突」一律指 §10.2 定义的 `stale_conflict`；「版本」在阶段 1 不存在、在 §11 才定义；「观测」与「实施」分阶段 | 已消歧 |

### 13.4 连续追问充分性与遗漏（自问自答）

- **Q：9088 次 PATCH 会不会大多是脚本？** 已按 UA 分类：100% Mozilla；`prod-layout-workflow-verify.py:69-77` 使用 urllib 且不设 UA（默认 `Python-urllib`），此窗口未命中。但 UA 可伪造，故 §5.1 只把它当「上界代理」，不据此断言真人比例。
- **Q：3534 对 ≤2s 能不能直接当冲突数？** 不能。同页 debounce 连发也会产生；且 access log 无 body。故只用于估「假 409 风暴」的量级，不当收益证据。
- **Q：为什么不在阶段 1 顺手把 `canvasVersion` 列加上，省一次发布？** 会引入 migration（与 web 并行、无回滚预案）+ 半套无消费者契约，正是 §7 否决 C 的理由。
- **Q：`add_edge` 查重会不会改变现有 web 行为？** 会：重复 id 不再产生第二条边。这是**有意的行为修正**，需行为级测试 + 变异测试，并在生产验收里比对边数量（§12.2 V4）。
- **Q：改 `packages/shared` 会不会波及 agent 侧？** 会，它是 Phase 5 的单一 SSOT，两端薄适配器都委托它。故 I5 限制为「只加可选回调，不改返回形状」，且计划里 agent 侧回归测试必须跑。
- **Q：阶段 1 的埋点算不算「新写点」会撞 `canvas-write-governance.test.ts`？** 不算：埋点只读 `ops` 与事务内状态，不新增 `canvasData:` 落库语句；但计划里仍要求跑该守卫确认零漂移。
- **Q：本地工作树与 master 不一致，写文档会不会污染？** 三份交付物均为**新文件**（已确认目标路径 NEW）；既有文件一律不落盘改写，追加内容进补丁包。
- **Q：会不会漏掉 `docs/README.md` 登记？** 已列入补丁包 §B 与完成定义，且注明 INDEX.md 禁止手改。

### 13.5 未闭环清单（不宣告 ALL_PASS）

| 项 | 状态 |
|---|---|
| PR #625 审视结论回填 / 关闭或改写 | ⏳ 未发（外部动作，需授权） |
| 上游 §7-4 只追加回填落盘 | ⏳ 补丁已备好，待推 PR 时按 master 裸 blob 应用 |
| `docs/README.md` 登记 + INDEX 重生成 | ⏳ 同上 |
| 阶段 1 代码实施与生产发布 | ⏳ 未授权 |
| 14 天观测窗口 / 三条数据门 | ⏳ 未开始 |
| 阶段 2 通过后的 409 规格（H1–H10） | ⏳ 未发生 |
| 真机复测（A-6）与既有独立窗口议题 | ⏳ 与本规格无关，仍挂账 |
