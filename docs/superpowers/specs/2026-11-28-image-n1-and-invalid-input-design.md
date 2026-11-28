# 生图 n=1 约束 + invalid_request 错误归类 设计规格

> 取证基线：`origin/master` @ `6e09cd10`
> 生产取证：会话 `cmx05m9d200a6pb01n0dxfvd7`，23/23 image `GenerationRecord` 全 failed，`errorRaw` 一致为
> `Image API 400: {"error":{"message":"n must be 1",...,"code":"invalid_request"}}`，
> `nativeParams.n=3` / `count=3` / 模型 `agnes-image-2.1-flash` / 渠道 `platform` / `errorCode=unknown`，
> 23 笔全部 charged=99→refunded=99（退款链路完整，无资损）。
> 结论口径：**已实测**（生产取证）/ **代码可证**，两者严格区分。

## 1. 目标 / 非目标

**目标**
1. 让 agnes-image 系列（2.0/2.1/2.5 flash 共用 profile）的生图请求恒以 `n=1` 发往上游，不再触发 `n must be 1` 400。
2. 让这类上游参数错误在 `GenerationRecord.metadata.errorCode` 落 `invalid_input`（而非 `unknown`），并在 UI 侧有可理解文案。
3. 不产生「按 3 张收费、实际只出 1 张」的资损缺口。

**非目标**
- 不改 seedream / gpt-image-2 / apimart generic 的 maxN（它们有各自真实能力，本刀不动）。
- 不引入新的字段、错误码、数据面（复用既有 `droppedFields` / `ErrorCode.invalid_input`）。
- 不改上游模型本身、不改前端 count 选择器（保留用户意图，由服务端 clamp 并记录降级）。

## 2. 第一原则声明 + 等价物检索结论（不重复造轮子）

**第一原则**：吃满上游、不重复造轮子。任何新增判据 / 工具 / 字段 / 引擎前，先查等价物，能接线就不新建，禁造数禁自报。

| 检索项 | 等价物 | 结论 |
|---|---|---|
| 多张 count 收敛到 1 的既有实现 | `apps/server/src/canvas/material.service.ts:416-425` 的 `canvas_image_count_clamped` + `count:1` 报价 | ✅ 复用其语义（clamp 后报价、按 1 张计费），不新造机制 |
| profile 层的 clamp 能力 | `packages/shared/src/imageModelProfiles.ts:173-189 clampImageGenerationInput` 已按 `profile.maxN` 收敛并写 `droppedFields` | ✅ **接线**：把 `AGNES_PROFILE.maxN` 从 4 改为 1，clamp 与降级记录自动生效，零新增字段 |
| clamped n 的传递 | `packages/agent/src/studio/generation-adapter.ts:442,449` 的 `result.n` / `nativeParams.n` 已取 `clamped.n` | ✅ 无需改 adapter，profile 一改即传导到上游请求 |
| 错误码类型 | `packages/shared/src/generationDiagnostics.ts:8` 已有 `ErrorCode = ... | 'invalid_input' | ...` | ✅ 复用既有错误码，不新增枚举 |
| 错误归类函数 | `mapMessageToErrorCode`（同文件 :123-149） | ✅ **接线**：加一条 `invalid_request` / `n must be 1` 规则产出 `invalid_input` |
| 用户文案 | `studio.service.ts:308,333` 已对 `invalid_input` 接好 hint / userMessage case | ✅ 无需新增文案分支 |
| 反向取证（判"不存在"） | `git grep` 全仓：现有 `invalid_input` 只有类型声明与 UI case，无任何映射规则产出；`grep -rn "n must be 1"` 只有历史诊断文档与记忆 | ✅ 确认非重复劳动，所有远端分支在这 4 个目标文件上与 master 零差异 |

## 3. 方案（最小改动，两个独立改动点）

### 改动 A：agnes profile 强制 n=1（治根因 + 防资损）

- `packages/shared/src/imageModelProfiles.ts`：`AGNES_PROFILE.maxN: 4` → `1`。
  - 效果：`clampImageGenerationInput` 对 `n=3` 收敛为 1，并往 `droppedFields` 追加
    `{field:'n', reason:'agnes-image-... supports at most n=1, clamped from 3'}`。
  - 传导：`generation-adapter.ts` 的 `nativeParams.n=1` / `result.n=1` / `meta.droppedFields` 自动带上降级记录。
- `apps/server/src/studio/studio.service.ts` `generateImage`：
  - 把 `buildImageProviderOptions(...)` 的调用**提前到报价之前**，用 `built.n` 取代原始 `n`
    作为 `pricing.quote({count})` 与 metadata `count` 的值。
  - 这样「用户选 3 → 实际 clamp 1 → 按 1 张计费 + metadata count=1 + droppedFields 记录意图」，与 legacy material 路径语义一致。
  - ⚠️ 该调整需保证 `resolved` 先解析（buildImageProviderOptions 依赖 resolved.modelName / byok / channelBaseUrl），
    报价依赖 built.n ⇒ 顺序为：resolve → build → quote → 其余原逻辑不变。
- `agent-canvas-tools.service.ts` 的 `clampImageGenCount` 保持 1–4（**不改**）：它钳的是用户输入上限，
  与 profile 能力 clamp 是两层，保留以维护「用户意图 → 服务端能力收敛」的分层；且 `droppedFields` 会记录真实降级。

### 改动 B：invalid_request 归类（治可观测缺口）

- `packages/shared/src/generationDiagnostics.ts` `mapMessageToErrorCode`：新增一条，命中
  `invalid_request` / `n must be 1` / `Image API 400` 等**参数类 4xx** → 返回 `invalid_input`。
  - 位置：在 `model_unavailable` 之后、`return 'unknown'` 之前（不与 timeout/429/model 规则抢优先级）。
  - 判据要精确：`\binvalid_request\b` 或 `n must be 1`，避免把其它 400 误归类。
- `translateUpstreamFailure`：同步加一条，把这类错误翻译为可理解中文
  （如「生成参数不被该模型支持，已按模型限制重试 / 请减少生成张数」）。
  - ⚠️ 由于改动 A 已让 agnes 不再发 n>1，这条主要是给**历史失败记录 / 其它参数类错误**兜底，属于可观测性补全。

## 4. 风险与回滚

- **改动面**：`studio.service.ts` 调整调用顺序，需确认 resolve 阶段副作用（BYOK fallback 提示）时序不变。
- **并行窗口**：`generationDiagnostics.ts` 昨日刚合入 `video_queue_full` 分类（#1022）；本刀只在其后追加规则，不触碰既有分支。
- **回滚**：两处均为纯逻辑改动，无 DB migration；回滚只需还原 profile.maxN 与两条分类规则。
- **兼容性**：新服务端 clamp n=1 对旧前端仍是「用户选 3、实得 1」，向后兼容（旧行为是 400 全失败，严格更好）。

## 5. 验收判据

1. **单测**（红→绿）：
   - `imageModelProfiles.test.ts`：`resolveImageModelProfile('agnes-image-2.1-flash',...).maxN === 1`；
     `clampImageGenerationInput(agnesProfile,{n:3,...}).n === 1` 且 `droppedFields` 含 n 记录。
   - `generationDiagnostics.test.ts`：生产原文 `Image API 400: {"error":{"message":"n must be 1",...}}` → `invalid_input`；
     `translateUpstreamFailure` 返回非 undefined 的中文文案。
   - `studio.service` 计费/clamp 集成断言（若现有测试骨架可承接）：count=3 时报价 count=1。
2. **静态**：`vue-tsc -b` / tsc 全绿；相关 test 文件全绿。
3. **生产取证**（合并部署后）：
   - 同模型（agnes-image-2.1-flash）+ `imageCount=3` 真实发起一次生成，确认成功产出 URL、`nativeParams.n=1`、
     `metadata.count=1`、`droppedFields` 有 n 降级记录、errorCode 不再 unknown。
   - 历史那 23 条失败记录不追溯改写（只保证新记录正确）。

## 6. 等价物检索取证命令（留痕）

```bash
git grep -n "invalid_input" origin/master -- packages/shared/src/generationDiagnostics.ts  # 仅类型+UI case
git grep -rn "n must be 1" origin/master -- packages apps                                 # 0 命中（仅文档/记忆）
for b in $(git branch -r --format='%(refname:short)'); do git diff --name-only origin/master...$b -- <目标4文件>; done  # 全空
```