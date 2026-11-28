# 实施计划：生图 n=1 约束 + invalid_request 归类

> 配套规格：`docs/superpowers/specs/2026-11-28-image-n1-and-invalid-input-design.md`
> 基线：worktree `fix/image-n1-and-invalid-input` @ `6e09cd10`（origin/master）

## 步骤

### 0. 准备（已完成）
- [x] fetch + 扫所有远端分支：4 个目标文件与 master 零差异，无重复劳动
- [x] 开隔离 worktree `fix/image-n1-and-invalid-input`
- [x] 规格落地（含第一原则等价物检索表）

### 1. TDD 红：先写失败测试
- [ ] `packages/shared/src/imageModelProfiles.test.ts`
  - agnes profile `maxN===1`（新断言）
  - `clampImageGenerationInput(agnes, {n:3})` → `n===1` + `droppedFields` 含 field='n'
- [ ] `packages/shared/src/generationDiagnostics.test.ts`
  - 生产原文 `Image API 400: ... "n must be 1" ... "code":"invalid_request"` → `mapMessageToErrorCode` = `invalid_input`
  - `translateUpstreamFailure(同原文)` → 非 undefined 中文文案
- [ ] 跑这两个 test 文件确认 **红**（改实现前）。

### 2. 绿：实施
- [ ] `packages/shared/src/imageModelProfiles.ts`：`AGNES_PROFILE.maxN: 4 → 1`（含注释说明生产取证依据）
- [ ] `packages/shared/src/generationDiagnostics.ts`：
  - `mapMessageToErrorCode` 追加 invalid_request 参数类规则 → `invalid_input`
  - `translateUpstreamFailure` 追加对应中文文案
- [ ] `apps/server/src/studio/studio.service.ts` `generateImage`：
  - `buildImageProviderOptions` 提前到 `pricing.quote` 之前
  - `quote({count: built.n})` + metadata `count: built.n`
  - 加 `canvas_image_count_clamped` 风格的日志（复用事件名或同族，记录 requested/effective）
- [ ] 跑步骤 1 的两个 test 文件确认 **绿**。

### 3. 补集成断言（防资损回归）
- [ ] 若现有 studio.service 测试骨架可承接，加一条：count=3 + agnes 模型 ⇒ quote count=1、metadata count=1。
  - 若骨架过重，至少用静态测试断言 `generateImage` 源码里 `quote({count: built.n})` 与 `count: built.n`（照仓库既有静态契约风格）。

### 4. 全量验证（本机 4 核，串行）
- [ ] 依赖：worktree 借主仓 node_modules（如 pnpm install 被拒）
- [ ] 定向 vitest：shared / agent / server 相关文件
- [ ] `vue-tsc -b`（不加 --noEmit）
- [ ] 全量 vitest（web 22min 后台）——按改动面决定是否全量；至少 server + shared + agent 三个包全量
- [ ] 变异自检：回退任一处修复，目标测试必须变红（证明测试真的抓住 bug）

### 5. 提交 + PR
- [ ] commit：`fix(image): 生图 agnes 强制 n=1 并将 invalid_request 归类为 invalid_input`
- [ ] 按记忆纪律用 `gh api` 推分支（git push 502）、建 PR
- [ ] 盯 CI 全绿 + mergeStateStatus CLEAN
- [ ] 合并前四项前置检查（CI / 队列 / 可合并 / 行级对账）

### 6. 合并 + 部署 + 生产取证复测（需授权，用户本轮已授权）
- [ ] squash 合并
- [ ] 盯 deploy.yml（api + web）+ 派发 runtime-deploy（本刀只改 api/shared/agent，runtime 无改动 ⇒ 仅需 deploy.yml，但按纪律确认）
- [ ] 上线判据：容器内 dist 行为断言 / healthz 版本
- [ ] 生产复测：用 agnes-image-2.1-flash + imageCount=3 真实生成一次，取证 n=1 生效、成功产出、计费 count=1、errorCode 正确
- [ ] 写回取证结论到当日日志

## 验收清单
- [ ] 规格与计划均含第一原则等价物检索表
- [ ] 红→绿验证完成
- [ ] 全量测试 + 静态门禁 + 变异自检通过
- [ ] PR CI 全绿并合并
- [ ] 生产取证证明根因消除且无新回归