# pi-runtime 能力吃满（T1/T2/T3/T4）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 vendor 上下文能力欠账——dynamicBlocks 预算（T3）、多模态直通（T1）、出站 payload 治理（T2）、压缩图片占位（T4）。

**Architecture:** 两批交付。PR-A 纯 pi-runtime 内部（新纯函数 + composeSystemPrompt 接线）；PR-B 跨服务（Nest 读盘转 base64 → prompt 载荷顶层 `images` 字段 → session-manager 透传 `lane.prompt` 第二参；`before_payload`/`before_compaction` 两个 vendor hook 做出站治理与压缩占位）。识图前置保留为兜底不删。

**Tech Stack:** TypeScript / Fastify（pi-runtime）、NestJS、node:test（pi-runtime 测试）、vitest（Nest）、Prometheus 文本 metrics。

**Spec:** `docs/superpowers/specs/2026-10-02-pi-runtime-capability-fullfillment-design.md`（v2）

## Global Constraints

- 不碰 `vendor/earendil-works/pi/**`（vendor 零改动）
- 主工作区正被并行窗口改动：worktree 自 `origin/master` 新起（建分支前必 `git fetch`），绝不 touch 主工作区未提交文件
- pi-runtime 测试判据 = `tsc -p` + 全量 `node --import tsx --test "src/**/*.test.ts"`，**全部绝对路径**：`RT=/Users/4seven/workspace/pi-lnk/.worktrees/<name>/services/pi-runtime`；`$RT/node_modules` 软链主仓；长命令落盘 `/tmp` + `run_in_background`（Bash 会无故 SIGTERM）
- 部署：合并前查部署队列空；dispatch 前必查 `gh api repos/sev7n4/pi-lnk/actions/workflows/runtime-deploy.yml/runs?per_page=5` 防撞 tag；新增 env 必 `--set-string` + 同步补 runtime-deploy.yml triple verify 断言串；纯文档/服务目录改动注意 `deploy.yml` paths 触发面
- 识图兜底路径（sidebar-vision.ts 全链路）**不删不改语义**，仅加配置化名单
- byte-stable 不变式：输入不变 → systemPrompt 输出逐字节相同
- metrics 遵循 `metrics.ts` 既有模式（Map 计数 + render 渲染 + `# HELP/# TYPE` 注释行）

## Review Focus（五类最易咬人的输入）

1. **空 images / data 为空的直通请求** → 必须跳过 images 纯文本发送，不得发空数组（Task 5 测试钉死）
2. **单图 data 超硬上限（8MB base64）** → before_payload 剔除该 part + 转占位 + 计数，不炸整请求（Task 6 测试钉死）
3. **历史图片无 `[I1=文件名]` 标记（T1 前的旧会话）** → T4/T2 占位用 `I?` 兜底编号，不抛错（Task 6/7 测试钉死）
4. **dynamicBlocks 未知块首标记** → 落 general 配额不丢块 + `unknown_kind` 计数（Task 1 测试钉死）
5. **同轮 5+ 张图（Nest 门控 ≤4 被绕过，如 API 直调）** → before_payload 本轮优先裁剪到 ≤4，多出转占位（Task 6 测试钉死）

---

## Phase A：T3 dynamicBlocks 预算（worktree `feat/dynamic-budget` → 0.0.36）

### Task A1: dynamic-budget.ts 纯函数（TDD）

**Files:**
- Create: `services/pi-runtime/src/dynamic-budget.ts`
- Test: `services/pi-runtime/src/dynamic-budget.test.ts`
- Modify: `services/pi-runtime/src/runtime-config.ts`（+2 字段）

**Interfaces:**
- Produces:
  ```ts
  export type BlockKind = "canvas" | "vision" | "sidebar" | "general";
  export function classifyBlock(block: string): BlockKind; // 块首标记：[画布快照|canvas、[I\d=|vision、[侧栏素材|sidebar、其他 general
  export interface BudgetOptions { totalChars: number; shares?: Partial<Record<BlockKind, number>>; }
  export interface BudgetResult { blocks: string[]; dropped: Record<BlockKind, number>; }
  export function applyDynamicBudget(blocks: readonly string[], opts: BudgetOptions): BudgetResult;
  ```
- 语义：超限块内截断（canvas=保头保尾掐中段，其他=保头部），尾注 `\n\n（本段已截断 N 字，可用 read_document 取回全文）`；从不整块丢弃；unknown→general（由 classifyBlock 保证，无 unknown 出口）

- [ ] **Step 1: 写失败测试**（要点用例，直接可跑）

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDynamicBudget, classifyBlock } from "./dynamic-budget.js";

const NOTE = (n: number) => `（本段已截断 ${n} 字，可用 read_document 取回全文）`;

test("不超限：输出与输入 join 逐字节一致", () => {
  const blocks = ["[画布快照] a".repeat(10), "[I1=x.png] 图"].map((s) => s.slice(0, 50));
  const r = applyDynamicBudget(blocks, { totalChars: 10000 });
  assert.equal(r.blocks.join(""), blocks.join(""));
  assert.deepEqual(Object.values(r.dropped).flat(), []);
});

test("canvas 超限：保头保尾、含尾注、总长≤预算份额", () => {
  const big = "[画布快照]" + "节点甲。".repeat(2000) + "最新节点乙。".repeat(500);
  const r = applyDynamicBudget([big], { totalChars: 4800 }); // canvas 份额 60% → 2880
  const out = r.blocks[0];
  assert.ok(out.startsWith("[画布快照]"));
  assert.ok(out.includes("最新节点乙。"), "必须保尾");
  assert.ok(out.includes("可用 read_document 取回全文"));
  assert.ok(out.length <= 2880 + 200, "截断+尾注仍应在份额附近");
});

test("vision 超限：保头截断", () => {
  const big = "[I1=a.png]" + "识图文本".repeat(3000);
  const r = applyDynamicBudget([big], { totalChars: 4800 });
  assert.ok(r.blocks[0].includes("可用 read_document 取回全文"));
  assert.equal(r.dropped.vision, 1);
});

test("多块同 kind 共享份额：先到先得，后者截断", () => {
  const a = "[I1=a.png]" + "甲".repeat(1400); // vision 份额 25% of 4800 = 1200
  const b = "[I2=b.png]" + "乙".repeat(1400);
  const r = applyDynamicBudget([a, b], { totalChars: 4800 });
  assert.equal(r.dropped.vision, 1);
  assert.ok(r.blocks[1].length < b.length, "第二块被截断而非丢弃");
});

test("byte-stable：同输入两次调用输出相同", () => {
  const blocks = ["[画布快照]" + "x".repeat(5000), "[I1=a.png]" + "y".repeat(2000)];
  assert.equal(
    applyDynamicBudget(blocks, { totalChars: 4800 }).blocks.join(""),
    applyDynamicBudget(blocks, { totalChars: 4800 }).blocks.join(""),
  );
});

test("空数组/全空块：返回空且 dropped 全零", () => {
  const r = applyDynamicBudget(["", "  "], { totalChars: 4800 });
  assert.deepEqual(r.blocks, ["", "  "].map((s) => s.trim()).filter(Boolean).length ? r.blocks : []);
  assert.equal(Object.values(r.dropped).reduce((a, b) => a + b, 0), 0);
});
```

- [ ] **Step 2: 跑红灯** `node --import <主仓>/services/pi-runtime/node_modules/tsx/dist/loader.mjs --test $RT/src/dynamic-budget.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现** `dynamic-budget.ts`（纯函数：classifyBlock 用 startsWith 于 trim 后块首；按 kind 累计已用 chars，超限按策略截断 + 尾注；无随机/时间源）
- [ ] **Step 4: 跑绿灯**（同 Step 2）→ PASS
- [ ] **Step 5: Commit** `git add src/dynamic-budget.ts src/dynamic-budget.test.ts && git commit -m "feat(pi-runtime): dynamicBlocks 分类预算纯函数（T3/2.1-2.2）"`

### Task A2: runtime-config + composeSystemPrompt 接线 + metrics

**Files:**
- Modify: `services/pi-runtime/src/runtime-config.ts`（接口 + load 两处，照 `toolTiering`/`parseBool` 既有模式）
- Modify: `services/pi-runtime/src/session-manager.ts:386`（composeSystemPrompt 入口过 budget）与 `:963`（resolveSystemPromptForTest 同步）
- Modify: `services/pi-runtime/src/metrics.ts` + `metrics.test.ts`（照 `observeToolSearch` 模式）

**Interfaces:**
- Consumes: `applyDynamicBudget`（Task A1）
- Produces: runtimeConfig 新字段 `dynamicBudget: boolean`（env `PI_RUNTIME_DYNAMIC_BUDGET`，缺省 true）、`dynamicBudgetTotalChars: number`（env `PI_RUNTIME_DYNAMIC_BUDGET_TOTAL_CHARS`，缺省 48000，`parseInt`）；metrics `observeDynamicBudgetDrop(kind)`、`observeSystemPromptBytes(n)` → 渲染 `pi_runtime_dynamic_budget_drops_total{kind}`、`pi_runtime_system_prompt_bytes`

- [ ] **Step 1: metrics 失败测试**（新增 2 例：drops 计数渲染、gauge 渲染 0 缺省）
- [ ] **Step 2: 红灯 → 实现 metrics 三处（字段区/observe/render）→ 绿灯**
- [ ] **Step 3: runtime-config 测试**（缺省 48000/on；`PI_RUNTIME_DYNAMIC_BUDGET=off` → false）→ 红灯 → 实现 → 绿灯
- [ ] **Step 4: session-manager 接线**：`composeSystemPrompt(staticPart, dynamicBlocks, budget?)` 加第三可选参（**不改既有两参调用方的行为**：无 budget 时直通原路径，保证 byte-stable 回退）——`:709` 与 `:963` 两处调用传 `runtimeConfig.dynamicBudget ? { totalChars, onDrop: metrics } : undefined`；生成后调 `observeSystemPromptBytes(out.length)`
- [ ] **Step 5: session-manager 现有测试回归**：`--test $RT/src/session-manager*.test.ts` 全绿（byte-stable：未超限会话 systemPrompt 不变）
- [ ] **Step 6: Commit** `feat(pi-runtime): composeSystemPrompt 接入 dynamicBlocks 预算 + metrics（T3/2.1）`

### Task A3: 全量验证 → PR → 0.0.36 部署 → E2E

- [ ] **Step 1: tsc** `$MAIN/services/pi-runtime/node_modules/.bin/tsc -p $RT` → 除已知 web.ts 噪音外干净
- [ ] **Step 2: 全量测试**（后台落盘 `/tmp/pi-rt-dbudget.log`）→ 426+ 全过（4 个 jsdom 噪音除外）
- [ ] **Step 3: `git status --short` 核验落盘 → push → `gh pr create`（标题 `feat(pi-runtime): dynamicBlocks token 预算（审计 T3）`，正文引 spec §2）→ 后台守望 check-runs**
- [ ] **Step 4: CI 绿 → 查部署队列空 → squash 合并 → `gh workflow run runtime-deploy.yml --ref master -f tag=0.0.36 -f feature_grep=dynamic-budget`（dispatch 前查最近 runs 防撞）→ 守望 success**
- [ ] **Step 5: CVM 实证**：registry tag 0.0.36、helm rev deployed、`/metrics` 含 `dynamic_budget_drops_total` HELP 行、helm values 含 `PI_RUNTIME_DYNAMIC_BUDGET_TOTAL_CHARS=48000`（--set-string 已进 workflow）
- [ ] **Step 6: E2E**：免 token 直连 `:30100`，e2e 会话发超长画布相关 prompt → 验证截断尾注进入 systemPrompt（可用 `resolveSystemPromptForTest` 行为从 metrics/logs 侧证）+ `system_prompt_bytes` 有值；`PI_RUNTIME_DYNAMIC_BUDGET=off` 行为在 staging 类比（单测覆盖即可，生产不折腾）

---

## Phase B：T1/T2/T4（worktree `feat/direct-images` → 0.0.37；自 PR-A 合并后的 origin/master 新起）

### Task B1: 前置取证（只读，产出决策记录）

- [ ] **signal**：vendor `drive/lane prompt` 路径（`runtime/lane.ts:1133` → `driveRunRequest`）确认 `run.context`（withCancel）承载取消——`:995` 注释已自证，落一句结论即可
- [ ] **retry**：vendor `config.ts DEFAULT_RETRY_POLICY` 消费点（grep `retryPolicy`）确认图片 400 是否原样重试；结论写入 PR 描述（若原样重试，Task B3 的 hook 顺带 strip-images 降级重试）
- [ ] **summary 模型**：`grep -n "generateSummary" vendor/.../compaction/*.ts` 确认摘要请求模型（预期文本模型，T4 策略成立）
- [ ] **before_compaction result 语义**：`hooks.ts` HookMap `before_compaction` 的 `result` 类型 + `firstStructural` 消费方式 → 决定 Task B4 走 hook 还是宿主预变换（结论写入 Task B4 的实现选型）
- [ ] **uploads 保留期**：`grep -rn "retention\|cleanup\|prune" apps/server/src` uploads 清理策略；确认或列风险进 PR 描述

### Task B2: pi-runtime images 接收（TDD）

**Files:**
- Modify: `services/pi-runtime/src/app.ts:170`（Body +`images?: DirectImage[]`，透传 `manager.prompt(..., { images })`）
- Modify: `services/pi-runtime/src/session-manager.ts:962`（opts +`images?: DirectImage[]`；`:1001` `lane.prompt(effectiveText, toImageContents(opts?.images), run.context)`；`withCancel`/`entry.cancelRun` 不动）
- Create: `services/pi-runtime/src/direct-images.ts`（纯函数：`toImageContents(images?: DirectImage[]): ImageContent[] | undefined`——空/undefined/全空 data → undefined（Review Focus 1）；`{type:"image",data,mimeType}`）
- Modify: `services/pi-runtime/src/runtime-config.ts`（+`directImages: boolean`，env `PI_RUNTIME_DIRECT_IMAGES` 缺省 true；off → toImageContents 恒 undefined）
- Modify: `services/pi-runtime/src/metrics.ts`（`observeDirectImage(outcome: "sent"|"downscaled"|"fallback", tokensEst)` → `pi_runtime_direct_images_total{outcome}` + `pi_runtime_direct_image_tokens_estimated`；tokens 估算：`ceil(width*height/750)` 无尺寸时按 data 长度 `ceil(len*3/4/1000)*565` 兜底）

- [ ] Step 1: 失败测试（direct-images.test.ts：undefined→undefined、空数组→undefined、正常映射、off 门控、tokens 估算单调）→ 红灯
- [ ] Step 2: 实现 direct-images.ts + 接线 app.ts/session-manager.ts → 绿灯
- [ ] Step 3: app.ts 既有契约测试回归（prompt 202/409/503 不变）
- [ ] Step 4: Commit `feat(pi-runtime): prompt 顶层 images 接收 + 直通 metrics（T1 宿主侧）`

### Task B3: before_payload 治理 hook（TDD）

**Files:**
- Create: `services/pi-runtime/src/payload-images.ts`（纯函数核心）
- Modify: `services/pi-runtime/src/index.ts`（onSessionCreated 注册 `harness.hooks.on("before_payload")`，fail-soft 照 transform_context 同款 try/catch）
- Test: `services/pi-runtime/src/payload-images.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TrimResult { messages: unknown; trims: { reason: "history_image" | "overflow" | "text_overflow"; count: number }[]; }
  export function governImagePayload(payload: PayloadShape, historyRounds: number, maxImages: number): TrimResult;
  ```
- 语义（spec §3.2）：①非本轮（最后一条 user 之前）消息中的 image parts → 替换为 text part `[图片已从上下文移除，可用 read_document 取回]`；②全体 image parts 计数 >maxImages(4) → 当前轮优先、新→旧历史回填，超出替换占位（无标记文件名 → 占位用 `图片`，**不抛错**，Review Focus 3/5）；③单 image part data base64 >8MB → 剔除+占位；④text part >200k chars 截断+告警；⑤无图片/无超限 → payload 原样返回（引用相等，零拷贝）

- [ ] Step 1: 失败测试（≥6 例：历史降级/本轮优先裁剪顺序/**不得取前 4**/8MB 剔除/无图片零拷贝/空 data 边界）→ 红灯
- [ ] Step 2: 实现纯函数 → 绿灯
- [ ] Step 3: index.ts 注册 + metrics `pi_runtime_before_payload_trims_total{reason}`（照 observeToolSearch 模式）+ metrics 测试
- [ ] Step 4: Commit `feat(pi-runtime): before_payload 图片治理——历史渐进降级+本轮优先裁剪（T2）`

### Task B4: before_compaction 图片占位（TDD）

**Files:**
- Create: `services/pi-runtime/src/compaction-images.ts` + `.test.ts`
- Modify: `services/pi-runtime/src/index.ts`（按 Task B1 取证结论注册 hook 或在宿主 compaction 路径预变换）

**Interfaces:**
- Produces: `export function annotateImagesForSummary(messages: AgentMessage[]): AgentMessage[]`——对含 image parts 的消息生成文本侧注 `[图片 I{n}: {文件名} | {mimeType} | 全文可用 read_document 取回]`（I 编号从**同消息 text 尾部** `[I1=文件名]` 恢复，无标记 → `I?`；只变换喂给摘要模型的副本，不落历史）

- [ ] Step 1: 失败测试（有标记恢复编号/无标记 I?/纯文本消息零变换/不可变量：输入数组不被 mutate）→ 红灯
- [ ] Step 2: 实现 → 绿灯（若 B1 结论为 fallback 路径，则在 session-manager compaction 触发处调用；若 hook 可行则在 index.ts 注册——**二选一，测试相同**）
- [ ] Step 3: Commit `feat(pi-runtime): 压缩摘要图片占位（T4）`

### Task B5: Nest 侧直通组装（vitest）

**Files:**
- Modify: `apps/server/src/agent/sidebar-vision.ts:36-53`（`supportsVisionModel` 读 env `SIDEBAR_VISION_MODELS`——非空时解析逗号分隔正则并优先命中，空回落现有三正则；**三正则保留为缺省**）
- Modify: `apps/server/src/agent/agent.service.ts`（`:635` 起的附件处理：模型过 `supportsVisionModel` → 复用 upstream-ref-inline 读取点取 ≤4 张 → 单张原始 >5MB 走 `downscaleOversizedReferenceImages` 重试一次 → 产出 `images: {name,mimeType,data}[]`；非视觉/装不下 → 现有识图路径原样，`images` 不发）
- Modify: `apps/server/src/agent/pi-runtime/pi-runtime.client.ts:160`（prompt body 顶层 +`images`）
- Modify: 直通生效时 Nest 侧把 `[I1=文件名]` 标记行并入发送文本尾部（与 dynamicBlocks I 编号同源：sidebar-block.ts:13-50 的编号逻辑）
- Test: `apps/server/src/agent/agent.service.pi-runtime.test.ts`（扩例）、`sidebar-vision.test.ts`（env 名单例）

- [ ] Step 1: sidebar-vision env 名单失败测试（自定义模型命中/缺省回落/空 env 回落）→ 红灯 → 实现 → 绿灯
- [ ] Step 2: agent.service 失败测试（视觉模型+图→payload.images 含 base64 且 text 尾带 [I1=]；非视觉模型→无 images 且识图路径触发（现断言不变）；>5MB→downscale 后入 payload）→ 红灯 → 实现 → 绿灯
- [ ] Step 3: client 测试（body 含顶层 images/不含 turnContext 泄漏）→ 绿
- [ ] Step 4: Commit `feat(server): 侧栏图片多模态直通组装 + 视觉名单配置化（T1 Nest 侧）`

### Task B6: 全量验证 → PR → 0.0.37 部署 → E2E 矩阵

- [ ] Step 1: pi-runtime `tsc` + 全量 `--test`（后台落盘）；Nest `./node_modules/.bin/vitest run`（apps/server，本地环境差异失败对照 CI 甄别）
- [ ] Step 2: `git status --short` 核验 → push → PR（正文含 Task B1 四项取证结论）→ 守 CI → 查队列空 → squash 合并
- [ ] Step 3: dispatch **tag=0.0.37** `feature_grep=directImages`（先查撞 tag）→ 守望 → CVM 实证 tag/rev/metrics 新 HELP 行/env（`PI_RUNTIME_DIRECT_IMAGES=on`、`PI_RUNTIME_DIRECT_IMAGE_HISTORY_ROUNDS=2` 均在 helm values）
- [ ] Step 4: E2E（免 token 直连 `:30100`，一次性 canvasSessionId）：
  1. **直通实证**：上传小图到会话（Nest 鉴权路径不可用时用资产 URL 直构 payload）→ prompt「描述这张图的内容」→ 回答含图片真实视觉内容（非兜底话术）
  2. **回退**：`SIDEBAR_VISION_MODELS` 临时置为不命中模型 → 同 prompt → 识图兜底话术出现，metrics `fallback` 计数 +1 → 恢复 env
  3. **成本闸门**：同会话连发 3 轮 → 第 1 轮后的请求中历史图片已转占位（metrics `history_image` 计数 +1；`direct_image_tokens_estimated` 增速放缓）
  4. **T4**：该会话塞大上下文触发 compaction → 摘要/ContextSnapshot 中含 `[图片 I` 占位
- [ ] Step 5: 工作日志 + MEMORY.md 版本链更新（0.0.36(rev52)=T3 → 0.0.37(rev53)=T1/T2/T4）

---

## Self-Review 记录

- **Spec 覆盖**：spec §2.1-2.3→A1/A2/A3；§3.0→B1；§3.1→B2+B5；§3.2→B3；§3.3→B4+B1(uploads)；§3.4→B6；§5 env 全部落在 A2/B2/B3/B5 且 A3/B6 Step 验证——无缺口
- **占位扫描**：所有代码步含真实测试/实现要点；B4 的「二选一路径」是 spec 声明的实施期取证点，B1 产出结论后按既定规则路由，非占位
- **类型一致性**：`DirectImage{name,mimeType,data}`、`BudgetResult.dropped`、`TrimResult` 跨任务引用一致；`toImageContents` 仅 Task B2/B5 间传递（Nest 侧同名结构、无共享包）
- **Review Focus 回填**：5 条已分别钉进 A1(4)、B2(1)、B3(2/3/5)、B4(3) 的测试步
