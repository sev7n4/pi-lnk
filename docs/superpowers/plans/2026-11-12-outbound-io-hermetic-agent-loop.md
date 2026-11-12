# 出网 I/O 有界化 + Agent Loop 协作层全缝化（治本）实施计划

状态：待评审（对应规格 `docs/superpowers/specs/2026-11-12-outbound-io-hermetic-agent-loop-design.md`）
原则：优先吃满本仓已有 injectable 缝与行业 agent-loop 端口化实践，不重复造轮子；每阶段独立 PR + squash merge + 生产复测。

## 阶段 0 · 运行时纪律门（docs-only，零发布）

- 目标：消除"本地腐坏树误带陈旧文件导致 CI 红"（本会话实发两轮）。
- 动作：`docs/agent/delivery.md` 写入"**PR 必须基于 `gh api` 权威 GitHub 树构建，禁止用本地磁盘文件**"，附 `gh api` 取权威 blob 的构建模板；PR 模板加提示。
- 验收：`delivery.md` 含该硬门 + 模板；本会话的 `gh api` 重建流程可作为范本。
- 风险：低。仅文档变更，不触发部署（`ci.yml` 对 docs 路径不跑 build/test）。

## 阶段 1 · 主线 B：出网 I/O 统一 client 端口（代码刀，先评审）

- 目标：把散落的 `withTimeout` 升级为统一出网 client 端口，默认带 AbortSignal + 超时。
- 动作：
  1. 新增 `apps/server/src/libs/http/client.ts`：封装 `fetch` + `AbortSignal.timeout` + 内部 `withTimeout`，签名 `get(url, {timeoutMs?})`，默认 5000ms（允许按场景覆盖）。
  2. 全仓 `grep "upstreamFetch(" apps/server/src` 扫出所有下行调用点（预期含 `direct-image-payload.ts` / `upstream-ref-inline.ts` / `upstream-ref-downscale.ts` 3 处 + 可能的其他散落点），统一改走 client 端口；删除各处的 ad-hoc `withTimeout` 调用。
  3. `http-timeout.util.ts` 保留为 client 端口内部工具。
- 验收：
  - 单测：client 端口覆盖"黑洞连接 → 超时 reject"；无直接 `upstreamFetch(url)` 散落调用（`grep` 判据 R-IO-1）。
  - 生产复测：同 PR #849 验证路径（镜像 tag = 合并提交、健康绿、产物含新端口、日志无回归）。
- 风险：R-B（默认 5000ms 与"视频预检拒绝路径"预算冲突）——端口允许覆盖，迁移时逐处确认。

## 阶段 2 · 主线 A：协作层全缝化（代码刀，先评审）

- 目标：`streamConversation` 全部协作者可注入，单测零真实 I/O。
- 动作：
  1. `agent.service.ts` 的 `buildSidebarVisionBlock` 改走 `createVisionBlockBuilder()` 缝（注入 `providerResolver` 端口）；`buildSelectionLookup` 改走 `createSelectionLookup()` 缝（注入 `canvasTools` 端口）；`assembleDynamic` 已部分走 `createPiPromptAssembler`，确认其 `canvasTools` 依赖也经端口。
  2. 全仓 `grep` 扫 `buildSidebarVisionBlock` / `buildSelectionLookup` 调用方，确保缝化无遗漏（R-A 风险）。
  3. `agent.service.pi-runtime.test.ts` 中 vision / SEL-REF 用例改注 fake 端口，新增"零真实 `upstreamFetch`"断言。
- 验收：
  - 单测：注入端口命中 fake 即判定协作层已缝化；CI 在网络受限环境（无 `upstreamFetch` 出口）下仍全绿。
  - 纯推导逻辑（焦点派生、selection digest、vision 块格式化）各自单测独立。

## 阶段 3 · 测试分层收口（代码刀，依附阶段 2）

- 目标：当前 drain 完整 `streamConversation` 的用例回归为纯单测或集成测试，端到端 ≤ 2 条。
- 动作：
  1. `agent.service.pi-runtime.test.ts` 中"披单测外衣的集成测试"拆分为纯单测（依赖注入 fake：spy `createPiRuntimeClient` / `createDirectImagePayloadBuilder` / `canvasTools` / `providerResolver`）+ 零真实出网断言（已完成，PR #855）。
  2. **集成测试采用 hermetic 本地 SSE 契约仿真**（非真实容器）：新增 `apps/server/src/agent/pi-runtime/pi-runtime.client.integration.test.ts`，用本地环回 HTTP 服务器仿真 pi-runtime SSE 协议，驱动**真实** `PiRuntimeClient` + **真实** `fetch` 验证 SSE 解析 / 跨分片帧 / 心跳忽略 / 404 终止 / `prompt()` 契约（已完成，PR #856）。
- ⚠️ **真实 pi-runtime 容器集成测试不采用**：CI 起容器 + 出网 → flaky + 违反气密目标（R-TEST-1 本意是单测不触真实 I/O）。行业最佳实践（claude/codex/workbuddy）一致推荐本地契约仿真服务器验证真实客户端代码路径。
- 验收：集成测试 hermetic（仅 `127.0.0.1` 环回）、可重复、不 flaky；单测零真实 I/O。

## 执行纪律

- 每阶段独立 feature 分支 + PR + squash merge；合并触发 `deploy.yml` 后按本会话已验证的取证清单复测（镜像 tag = 合并提交、健康端点、产物含修复、日志无回归）。
- 所有代码刀在 plan-gate 评审通过后再实施；docs-only 阶段（阶段 0）可即时落地。
- 不改动 `@earendil-works/pi-agent-core` 内核、不重造上游 fetch（遵守 ADR-0009 vendor 禁止业务 patch）。
