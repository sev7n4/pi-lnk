# PR-D 实施计划：侧栏参考图绑定观测批（RB-D9）

> 日期：2026-10-14
> 父规格：[2026-10-13-sidebar-ref-bind-invariant-design.md](../specs/2026-10-13-sidebar-ref-bind-invariant-design.md)（RB-D9）
> 前置批次：PR-A #402（止血）/ PR-B #403（契约）/ PR-C #407（门禁，已合并 master `666d4d84`）
> 本批风险：低（纯指标 + 测试 + 文档，不改执行语义、不碰 vendor/prompt）

## 0. 背景与范围

事故复盘三部曲第四批，实现规格 RB-D9（观测即验收）：

- **`pi_runtime_sidebar_ref_bind_total{outcome="ok|invalid_params|upstream_error|short_circuit"}`**：把「参考图绑定链路」的每一跳结果变成可查询信号。SSOT 在 runtime（它是调 Nest 的那一侧，能看到 apply 的 400/5xx 与 propose 短路）。
- **`pi_runtime_propose_missing_refs_total`**：门禁（RB-D5）触发的累计计数——PR-C 已在短路点调用 `onProposeOutcome?.("missing_refs", false)`（落入 `pi_runtime_propose_outcome_total{reason="missing_refs"}`），本批补一个**语义独立**的计数器，让「门禁拦截量」从 outcome 分布里单列出来。
- **`nest_zod_reject_total{endpoint}`**：Nest 侧 Zod 拒绝（400）的 endpoint 维度计数。Nest 进程**无独立 Prometheus 导出器**，但 runtime 是调 Nest 的那侧、其 `/metrics` 已被 Prometheus 抓取（routeLabel 含 `metrics`）；故在 runtime 观测 Nest 返回的 400（结构化 errorKind/status）并 key 到 endpoint，等价于在可查询平面上补这个指标，避免跨进程指标管线膨胀（scope 纪律）。
- **golden case**：事故形态（无 @ + 本轮新图 + 换装口语，模型伪造 `[{source,target_node_id}]` 形态参数）进 `golden-cases.ts`，补「畸形 attachments 被消毒后回落成功」用例。
- **告警（按静默降级家族纪律接入）**：`deploy/observability/prometheus/rules/` 目录**刻意留空**（需 ≥1 个发布周期真实基线才能校准阈值，否则「无错误」只是「无流量」的假象，见该目录 README）。故本批**不部署会误报的硬告警规则**，只落一份**待校准 PromQL 草稿文档**（`.md`，非 `.yml`），纪律对齐。

## 1. 全局约束（绑定，任一违反即打回）

- ❌ 不改执行语义：apply_sidebar_attachments / propose_generation 的成功/失败**行为逐字节不变**，只新增「旁路观测」（回调里 Map.set，绝不抛错、绝不改返回）。
- ❌ 不引入跨包运行时依赖：指标写入走 runtime 自有 `Metrics` 类（与 PR-B RB-D7 同纪律）；Nest 改动只在其侧 DTO/拦截器，且本批**不新增 Nest 指标导出**（用 runtime 侧观测替代）。
- ❌ 不改 vendor/ 代码、不改 prompt-registry 任何文件、不改前端代码。
- ✅ 工具层不持 `Metrics`（2026-10-04 纪律）：观测经 `createCanvasWriteTools` 的 opts 回调注入，由 `config.ts` 接线到 `metrics.*`——与 PR-C 的 `onProposeOutcome` 同路。
- ✅ 回调约定：只做 Map.set，**不得抛**（调用点无 try/catch，抛错会污染结算路径，见 canvas-write.ts:87 注释）。

## 2. Task 0：worktree 与软链（已完成，记录）

- worktree `.worktrees/prd-obs`（分支 `feat/sidebar-ref-bind-prd`，off master `666d4d84`）。
- 软链纪律（PR-A 修正版）：`apps/server`、`apps/web`、`services/pi-runtime` 的 `node_modules` 逐项软链主仓同路径（含 `.bin`）；`@lnkpi/shared`、`@lnkpi/agent`、`@lnkpi/pi-poc` 指向**本 worktree** `packages/*`（绝对路径）。
- 冒烟：`cd services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts` 可跑；`cd apps/server && ./node_modules/.bin/vitest run src/agent/agent-canvas-tools.service.test.ts` 可跑。

## 3. Task 1：Runtime 指标（RB-D9 核心）

### 3.1 `services/pi-runtime/src/metrics.ts`
- 新增私有字段（Map，key 语义见下）：
  - `private sidebarRefBind = new Map<string, number>(); // key: outcome (ok|invalid_params|upstream_error|short_circuit)`
  - `private proposeMissingRefs = 0; // 门禁短路累计`
  - `private nestZodReject = new Map<string, number>(); // key: endpoint（如 apply-sidebar-attachments）`
- 新增方法（与既有 `observe*` 同款风格，纯 Map.set）：
  - `observeSidebarRefBind(outcome: "ok" | "invalid_params" | "upstream_error" | "short_circuit"): void`
  - `observeProposeMissingRefs(): void`（`this.proposeMissingRefs += 1`）
  - `observeNestZodReject(endpoint: string): void`
- `render()` 末尾（事件层 settler 之前或之后均可，建议紧邻 `pi_runtime_propose_outcome_total` 族，保持语义邻近）：追加三段 HELP/TYPE/数据行，命名严格为：
  - `# HELP pi_runtime_sidebar_ref_bind_total Reference-image bind link outcomes (apply ok/400/5xx + propose gate short_circuit).`
  - `# TYPE pi_runtime_sidebar_ref_bind_total counter`
  - `# HELP pi_runtime_propose_missing_refs_total propose_generation gate short-circuits (RB-D5 missing_refs).`
  - `# TYPE pi_runtime_propose_missing_refs_total counter`
  - `# HELP nest_zod_reject_total Nest Zod/validation 400s observed by runtime, by endpoint.`
  - `# TYPE nest_zod_reject_total counter`
  - 渲染规则沿用既有：counter 型 Map 为空时不渲染数据行（「从未触发」与「触发过但 0」可区分）；gauge 型恒渲染样本行（如 proposeMissingRefs 直接 `${this.proposeMissingRefs}`）。

### 3.2 `services/pi-runtime/src/tools/canvas-write.ts`
- `createCanvasWriteTools` 的 `opts` 类型（canvas-write.ts:91-96）扩展：
  ```ts
  onSidebarRefBind?: (outcome: "ok" | "invalid_params" | "upstream_error" | "short_circuit") => void;
  onProposeMissingRefs?: () => void;
  onNestZodReject?: (endpoint: string) => void;
  ```
  并 `const onSidebarRefBind = opts.onSidebarRefBind;` 等同捕获（仿 line 100）。
- **apply_sidebar_attachments**（execute 体，现 canvas-write.ts:644-668）包裹 try/catch：
  - 成功路径（现有 `withWriteSignal(await client.post(...))` 之后，`usedPlatformFill` 分支前/后均可，建议紧接 POST 成功）→ `onSidebarRefBind?.("ok")`。
  - catch：`err instanceof NestToolError && err.status === 400` ⇒ `onSidebarRefBind?.("invalid_params")` + `onNestZodReject?.("apply-sidebar-attachments")`；其余（5xx/网络）⇒ `onSidebarRefBind?.("upstream_error")`。
  - ⚠️ 现有体在 404（无侧栏附件，line 641 `textRaw({error:"没有侧栏附件"})`）早退，**不**计入指标（那是用户侧无图，非链路失败）。
- **propose_generation 短路**（canvas-write.ts:407-409，PR-C 已落）：在 `if (gate && gate.confirmed === false && gate.reason === "missing_refs")` 块内，现有 `onProposeOutcome?.("missing_refs", false)` 之后追加 `onSidebarRefBind?.("short_circuit")` + `onProposeMissingRefs?.()`。

### 3.3 `services/pi-runtime/src/tools/config.ts`
- `buildCanvasWriteTools(client, deps.registry, {...})` 第三个参数（现 line 83-85）扩展为：
  ```ts
  {
    onProposeOutcome: (reason) => metrics.observeProposeOutcome(reason),
    onSidebarRefBind: (outcome) => metrics.observeSidebarRefBind(outcome),
    onProposeMissingRefs: () => metrics.observeProposeMissingRefs(),
    onNestZodReject: (endpoint) => metrics.observeNestZodReject(endpoint),
  }
  ```

### 3.4 测试
- `services/pi-runtime/src/metrics.test.ts`：新增 3 个用例——`observeSidebarRefBind` 四个 outcome 分别累加、`observeProposeMissingRefs` 累加到 `pi_runtime_propose_missing_refs_total`、`observeNestZodReject` endpoint 维度累加；并校验 `render()` 输出含三段 HELP 行。
- `services/pi-runtime/src/tools/canvas-write.test.ts`：新增 describe「RB-D9 指标发射」，用 stub `NestClient` + 注入三个回调，断言：
  1. apply 成功（stub 200）→ `onSidebarRefBind("ok")` 调用一次；
  2. apply 返回 400（stub 抛 `NestToolError` status 400）→ `onSidebarRefBind("invalid_params")` + `onNestZodReject("apply-sidebar-attachments")`；
  3. apply 返回 500（stub 抛 5xx）→ `onSidebarRefBind("upstream_error")`；
  4. propose 短路（stub propose-generation 返回 `{confirmed:false,reason:"missing_refs"}`）→ `onSidebarRefBind("short_circuit")` + `onProposeMissingRefs()`。
  - ⚠️ 沿用 PR-C 的 stub 风格（从既有 canvas-write.test.ts 的 `findTool`/`run` 辅助复制），回调断言用 `assert.equal(calls.length, 1)` 等真断言，禁止恒真假。

### 3.5 验收
- `cd services/pi-runtime && node --import tsx --test src/tools/canvas-write.test.ts src/metrics.test.ts` 全绿。
- `cd services/pi-runtime && ./node_modules/.bin/tsc --noEmit`：改动文件零新增错误（已知 28 个软链 packages/agent 预存噪音与本次无关）。

## 4. Task 2：golden case（事故形态回归）

- **确定性单测（主载体）**：在 `canvas-write.test.ts` 现有「畸形 attachments 消毒」用例基础上，新增一个**端到端**用例——模拟模型伪造参数 `[{source:"I1",target_node_id:"image-x"}]`（事故 G2 形态），断言：
  - `prepareArguments` 消毒删除该伪造项；
  - `client.post(apply-sidebar-attachments)` 收到的 body.attachments === `tc.attachments` 实体（回落 SM-D4 路径）；
  - **apply 成功**（stub 200）→ `onSidebarRefBind("ok")` 调用一次。
  - 即「畸形被消毒后回落成功」的确定性证据，规避 L1 评测的画布/随机性风险（纪律：宁可不测假的）。
- **L1 行为回归登记**：`services/pi-runtime/src/eval/golden-cases.ts` 的 `GOLDEN_CASES` 追加一条 `sidebar-ref-001`（origin:`"audit"`）：
  - `about`: "侧栏参考图绑定：事故形态下不得 500、不得假称已挂载，应回落本轮侧栏附件"
  - `text`: "让这个小姑娘换上黑丝，更性感迷人"（G1 事故原句，无 @）
  - `repeat: 3`（行为有随机性，取多数，见 golden-cases.ts:106 纪律）
  - `forbidText: ["参考图会自动使用", "已自动使用侧栏"]`（假承诺词，对应复盘「平台会自动用参考图」幻觉）
  - `expectTools: ["apply_sidebar_attachments"]`（应走挂载而非跳过）
  - ⚠️ 若 eval runner 不支持注入「本轮侧栏附件 / 画布节点」上下文，则该 L1 case 仅作登记、以确定性单测为唯一可跑判据；实现者在 brief 中裁定并注明 runner 能力缺口。
- 验收：`node --import tsx --test src/tools/canvas-write.test.ts` 含该用例全绿；`golden-cases.ts` 类型检查通过（`tsc`/现有 eval 测试 `golden-cases.test.ts` 不红）。

## 5. Task 3：告警草稿（纪律接入，不部署硬规则）

- 新增文档 `deploy/observability/prometheus/rules/sidebar-ref-bind.md`，内容：
  - 说明本批新增三个指标及其语义；
  - 给出**待校准**的 PromQL 草稿（非 `.yml`，不进抓取）：
    - 门禁拦截率：`sum(rate(pi_runtime_propose_missing_refs_total[1h])) / sum(rate(pi_runtime_sidebar_ref_bind_total{outcome="ok"}[1h]))`
    - Zod 拒绝残留（门禁上线后理论上应趋零，若 >0 说明模型仍在伪造）：`sum(rate(nest_zod_reject_total{endpoint="apply-sidebar-attachments"}[1h]))`
    - 上游错误突增：`sum(rate(pi_runtime_sidebar_ref_bind_total{outcome="upstream_error"}[1h]))`
  - 明确标注：**阈值待 ≥1 发布周期真实流量校准后，再落成 `rules/*.yml`**（复用 README 的窗口校正原则：带 `or vector(0)`、窗口 < 典型重启间隔、先确认分母非零）。
- ❌ 不创建 `rules/*.yml`（纪律：目录刻意留空）。

## 6. Task 4：全量回归 + push + 开 PR

- 范围回归（与 PR-C 同裁决）：本机跑 scoped 套件（runtime canvas-write + metrics + server 触碰文件单测 + web 既有），全量信号交 CI（4 核机全量性价比极低）。
- `git status --short` 必须干净（勿加 node_modules/.pi-runtime-data）。
- push 走隧道（CVM github:443 间歇超时，22 通；或 harness 代理直连）。
- 开 PR #（新）：标题 `feat: 侧栏参考图绑定观测批（RB-D9 metrics + golden case）`，正文列三指标 + golden case + 告警草稿指向。
- 终审（SDD 终态）：最强模型全分支评审，关注：指标命名/标签与 spec RB-D9 一致、回调零抛错、短路点双计数不失真、golden case 不假测、告警草稿不落地 .yml。

## 7. Ruling（关键裁决，实现/评审不得违背）

1. **指标位置**：`nest_zod_reject_total` 落在 runtime 观测侧而非 Nest 新导出器——避免跨进程指标管线膨胀；endpoint 维度由 runtime 在 catch 400 时 key 入。
2. **short_circuit 双计数**：短路点同时 `observeSidebarRefBind("short_circuit")` + `observeProposeMissingRefs()` + 既有 `observeProposeOutcome("missing_refs", false)`——三者各管各的语义（链路 outcome / 门禁拦截量 / propose 结算分布），不互相替代。
3. **apply 早退不计数**：`textRaw({error:"没有侧栏附件"})` 早退（无图可用）**不**计入 `sidebar_ref_bind_total`（那是用户侧无输入，非链路失败）；只计真正打到 Nest 的 POST 结果。
4. **回调零抛错**：三个新回调与 `onProposeOutcome` 同纪律——只 Map.set，调用点无 try/catch。
5. **金标对齐**：golden case 禁 `forbidText` 含「参考图会自动使用」类幻觉词，对应复盘根因；`expectTools` 锁 `apply_sidebar_attachments` 行为（不得跳过挂载）。
6. **告警不落地**：`rules/` 仍只留 README，新增 `.md` 草稿；绝不创建 firing `.yml`。

## 8. 验收判据（上线后，对齐 prod-deploy-verify 惯例，归生产取证）

1. 重放 G1（上传图 + 事故原句、无 @）：apply 成功且 `pi_runtime_sidebar_ref_bind_total{outcome="ok"}` 有计数。
2. 若模型仍伪造参数被消毒回落：`outcome="ok"` 仍计数（消毒后成功），`nest_zod_reject_total{endpoint="apply-sidebar-attachments"}` 体现「曾尝试伪造」。
3. 门禁拦截场景：`pi_runtime_propose_missing_refs_total` 有计数、`sidebar_ref_bind_total{outcome="short_circuit"}` 同步。
4. 5xx 上游故障时 `outcome="upstream_error"` 有计数，且不涉及 500 穿透（RB-D3 已修）。
5. RB-D10 三条回归路径行为零退化。
