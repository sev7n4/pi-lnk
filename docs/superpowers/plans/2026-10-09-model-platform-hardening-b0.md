# 平台模型体系加固 B0 批次 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** B0 止血三件套——幽灵模型下架（S0-1）、错误语义映射（S0-2）、部署后冒烟探针（S0-3），分别服务总体规格 G1/G2/G3 的手工形式。

**Architecture:** 三个分项零耦合（不同文件集），可在同一分支顺序实现。S0-1 只删目录条目并验证 #306 既有 sync 闭环；S0-2 只在既有分类器补两条规则；S0-3 新增 shared 纯函数 + ops 脚本，diff 逻辑必须落 shared 供 S1-1 复用。

**Tech Stack:** TypeScript · Vitest · pnpm workspace · Node ≥22（脚本）

**Spec:** `docs/superpowers/specs/2026-10-09-model-platform-hardening-design.md`（总体）+ `2026-10-09-mph-s01/s02/s03-*-design.md`（分项，冲突时以分项为准）

---

## Global Constraints

- **工作分支**：`feat/model-platform-hardening-b0`（从 origin/master 新建 worktree，勿向本地 master 提交）
- **Node runtime**：`/Users/4seven/.workbuddy/binaries/node/versions/22.22.2-6/bin/node`
- **测试命令**：
  - shared 包：`pnpm --filter @lnkpi/shared exec vitest run`
  - server 包：`pnpm --filter @lnkpi/server exec vitest run`
- **worktree 依赖安装**：本机 worktree 中 `pnpm install` 已知会在符号链接步反复 broker-deny（ENOENT/EEXIST 交替，非沙箱问题）。降级方案：从主工作区 `cp -a` 复制根 `node_modules` 与各 `apps/*`、`packages/*` 下的 `node_modules`（pnpm 相对符号链接经 cp -a 保留仍有效），复制后先跑一次既有测试冒烟验证环境再开工。
- **fixture 纪律**：所有上游错误 fixture 必须逐字取自总体规格 §2.4 的生产取证原文，禁止臆造
- **⛔ 规则不写宽**（S0-2）：只匹配 `model_not_found` 与 `No available channel` 两个已取证字面量族
- **⛔ 不建长期设施**（S0-3）：定时化、告警、灰显回流归 S1-1；`upstreamReconciliation.ts` 必须是 shared 纯函数，S1-1 直接 import，禁止重写第二套
- **⛔ 探活只读**（S0-3）：只调 `/v1/models`，禁止发真实生成请求；脚本绝不落盘/打印任何密钥
- **⛔ 不改**：`vendor/` · `providerCredentials` resolver 链 · `model-catalog-sync.ts` 同步逻辑本体（S0-1 只喂新目录+补测试）
- **门禁**（总体规格 §3.3）：S1-1 探活能力就绪前，禁止在目录上架任何新模型（含 agnes-2.5/3.0 系补货）——本批次不做任何上架

## Review Focus

1. **幽灵条目删除引发衍生逻辑连锁**：`modelCapability`/`resolveModelKey` 等对已删 key 的行为必须保持「确定性抛错」而非静默。→ Task 1
2. **sync 对「同形歧义」复合 fixture 的处理**：同一模型既在 `selectableTextModels` 又在 `disabledModels`（#306 核心已知坑）。→ Task 1
3. **错误规则误伤近似串**：`'model_not_found_x'`、`'Text API 503: Internal Error'` 不得命中新规则。→ Task 2
4. **diff 纯函数把「上游不可达」误报成 ghost**：402/403/超时必须记 `unavailable(reason)`，不产生 ghost。→ Task 3
5. **脚本密钥泄漏**：grep `sk-` 断言脚本输出与代码无密钥。→ Task 3

---

## File Structure

| 文件 | 责任 | Task |
|---|---|---|
| `packages/shared/src/studioModelCatalog.ts` | 目录删 3 条幽灵 + 留档注释 | 1 |
| `packages/shared/src/studioModelCatalog.ghost-retirement.test.ts` | A1/A4（目录断言 + resolveModelKey 抛错） | 1 |
| `apps/server/src/provider/model-catalog-sync.test.ts` | 追加 A2/A3（镜像清理 + 用户偏好清理） | 1 |
| `packages/shared/src/generationDiagnostics.ts` | `mapMessageToErrorCode`/`translateUpstreamFailure` 各 +1 规则 | 2 |
| `packages/shared/src/generationDiagnostics.model-not-found.test.ts` | A1/A2/A3（生产 fixture 正反例） | 2 |
| `apps/server/src/studio/studio.diagnostic.test.ts` | 追加「503 → 新文案」渲染用例 | 2 |
| `packages/shared/src/upstreamReconciliation.ts` | diff 纯函数（S1-1 复用） | 3 |
| `packages/shared/src/upstreamReconciliation.test.ts` | A1/A2/A3 | 3 |
| `ops/probe-upstream-models.mjs` | 冒烟探针脚本（IO 壳，逻辑全下沉 shared） | 3 |
| `docs/ops/2026-10-09-upstream-probe-runbook.md` | 运行手册 | 3 |

---

## Task 1: S0-1 幽灵模型下架

- [ ] 1.1 `packages/shared/src/studioModelCatalog.ts`：从 `STUDIO_MODEL_CATALOG` 移除 `deepseek-v4`、`gemini-1.5-flash`（即目录中的 gemini-3.1-flash）、`gpt-5.5` 三条文本条目（以文件内实际 key 为准，先 grep 确认精确 key），原位置保留注释块：「2026-10-09 探活下架（agnes hub 无渠道，见 docs/superpowers/specs/2026-10-09-model-platform-hardening-design.md §2.4），上游开通后按 S1-1 探活对账结果重新上架」
- [ ] 1.2 新建 `packages/shared/src/studioModelCatalog.ghost-retirement.test.ts`：
  - A1：文本模型恰剩 1 个（agnes-2.0-flash）；目录总数 25
  - A4：`resolveModelKey('text', 'deepseek-v4')` 抛确定性错误（断言错误类型/消息，非静默返回）
- [ ] 1.3 `apps/server/src/provider/model-catalog-sync.test.ts` 追加：
  - A2：预置 28 条含 3 幽灵的镜像行 → sync 后 25 条且幽灵消失
  - A3：预置 `selectableTextModels` 含 deepseek-v4 的用户行 + `disabledModels` 含其停用记录的复合形态（同形歧义）→ sync 后两者均清理
- [ ] 1.4 跑 shared + server 测试全绿；提交 `feat(b0-s01): 下架 3 个幽灵文本模型并验证 sync 闭环`

## Task 2: S0-2 错误语义映射

- [ ] 2.1 `packages/shared/src/generationDiagnostics.ts`：
  - `mapMessageToErrorCode()`：timeout 规则之后、unknown 兜底之前加 `if (/model_not_found|No available channel/i.test(text)) return 'model_unavailable'`
  - `translateUpstreamFailure()`：同字面量族返回 `'平台暂未开通该模型（上游无可用渠道），请换个模型或联系管理员'`
  - 复用既有 `ErrorCode` 的 `model_unavailable`，不新增枚举值
- [ ] 2.2 新建 `packages/shared/src/generationDiagnostics.model-not-found.test.ts`：
  - A1：生产 503 原文（总体规格 §2.4 逐字）→ `model_unavailable`
  - A2：同原文 → 新中文文案；402 原文（总体规格 §2.4 逐字）→ 既有欠费文案（回归）
  - A3：反例 `'Text API 503: Internal Error'`、`'model_not_found_x'` 不命中新规则（但 `No available channel` 路径仍命中）
  - A4：既有规则（积分不足/timeout/已取消/停用）回归——跑既有 `generationDiagnostics.test.ts` 全绿
- [ ] 2.3 `apps/server/src/studio/studio.diagnostic.test.ts` 追加：生产 503 原文走真实渲染路径 → userMessage = 新文案（不直调共享函数）
- [ ] 2.4 确认 httpStatus：503 文本路径已把 httpStatus 填进 diagnostic（若已有测试覆盖则引用之，否则补断言）
- [ ] 2.5 跑 shared + server 测试全绿；提交 `feat(b0-s02): distributor model_not_found 映射 model_unavailable + 中文文案`

## Task 3: S0-3 冒烟探针（shared 纯函数 + ops 脚本 + runbook）

- [ ] 3.1 新建 `packages/shared/src/upstreamReconciliation.ts`：
  - `diffCatalogAgainstUpstream(catalogEntries, upstreamModelIds, routingMap)` → `{ ghosts, missing, matched }`
  - ghost = 目录有（按路由表归到该上游）而上游无；missing = 上游有而目录无；matched = 交集
  - 集合比较、不依赖输入顺序；纯函数零 IO 零依赖
  - routingMap 类型与 platformCredentials 的 family→upstream 映射同形；注释注明「与 platformCredentials.ts 保持一致，S2-2 路由表落地后改为 import」
  - 上游不可达不在函数签名内表达（调用方传 `upstreamModelIds: null` 表示 unavailable → 函数返回 ghosts=[]，不可达由脚本层记录 reason）
- [ ] 3.2 新建 `packages/shared/src/upstreamReconciliation.test.ts`：
  - A1：fixture = 目录（含 3 幽灵的两态参数化：含/不含）× agnes hub 真实 12 个（总体规格 §2.4 逐字清单）→ ghosts 两态恰为 `['gemini-3.1-flash','deepseek-v4','gpt-5.5']` / `[]`
  - A2：打乱 upstreamModelIds 顺序 + 增删无关字段 → 结果不变
  - A3：`upstreamModelIds: null` → ghosts=[]（不误报）
- [ ] 3.3 新建 `ops/probe-upstream-models.mjs`（Node ≥22，零三方依赖）：
  - 5 上游 env：`OPENAI_BASE_URL`/`OPENAI_API_KEY`、`APIMART_BASE_URL`/`APIMART_API_KEY`、`FAL_*`、`MINIMAX_*`、`STEPFUN_*`
  - 每上游 `GET /v1/models`（非 200/超时 → `unavailable(reason)`；无 /models 端点 → `NO_MODELS_ENDPOINT` 跳过）
  - diff 调 shared 纯函数（脚本用相对路径 import shared 源码；脚本只做 IO 壳）
  - 输出 stdout Markdown 报告；有 ghost 或任一上游 402/403 → `exit 1`
  - 不写文件、不打印密钥（代码与输出 grep `sk-` 必须为 0 命中）
- [ ] 3.4 新建 `docs/ops/2026-10-09-upstream-probe-runbook.md`：本地直跑 / `ssh → docker exec -i lnkpi-api node -` 两种命令模板、报告解读表（ghost/missing/unavailable 各自含义与动作）、归档约定（`docs/ops/probe-<date>.md`）、⚠️ 探活只读 /models 禁止真实生成请求
- [ ] 3.5 跑 shared 测试全绿 + `node ops/probe-upstream-models.mjs --help` 冒烟（无 env 时应输出可读的 unavailable 报告而非 crash）；提交 `feat(b0-s03): 上游对账纯函数 + 冒烟探针脚本 + runbook`

---

## 验收（批次出口）

| # | 判据 |
|---|---|
| V1 | shared + server 测试全绿（`pnpm -r --if-present test` 或两包分别跑） |
| V2 | 本地 `node --experimental-strip-types scripts/verify-spec-figures.ts` 对新增 runbook 不报错（含图才需 §0，纯文档无图可跳过） |
| V3 | 部署后生产复测（合并后由 controller 执行，不在本 plan 内）：镜像 25 条、Dock 无幽灵可选、新失败 errorCode≠unknown |
