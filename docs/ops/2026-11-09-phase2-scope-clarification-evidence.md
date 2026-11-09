# Phase 2 口径澄清 · 本地验收证据（2026-11-09）

> 规格：`docs/superpowers/specs/2026-11-09-phase2-l1-command-scope-clarification-design.md`
> 计划：`docs/superpowers/plans/2026-11-09-phase2-l1-command-scope-clarification.md`
> 写作时 true master：`74c5e0c081e75945ecc7274388b09e6b236127a2`（PR #791 合并后，`gh api` 读取）

## 1. 交付清单（3 新增 + 1 只追加）

| # | 路径 | 类型 |
| --- | --- | --- |
| 1 | `docs/superpowers/specs/2026-11-09-phase2-l1-command-scope-clarification-design.md` | 新增（13 章 + 图 1） |
| 2 | `docs/superpowers/plans/2026-11-09-phase2-l1-command-scope-clarification.md` | 新增（3 Task） |
| 3 | `docs/ops/2026-11-09-phase2-scope-clarification-evidence.md` | 新增（本文） |
| 4 | `docs/superpowers/specs/2026-11-05-sse-conversation-view-unification-design.md` | 只追加 §15.7 |

零改动：`apps/**`、`services/**`、`charts/**`、`package.json`、`.github/workflows/**`，以及 ② 的全部 10 个新增文件。

## 2. T1 · 只追加校验

- 旧 blob `14117f1ad1ece69e31a7560fbd318da3ec39fa67` 与合并后的 master 母规格完全一致；本刀在其后只追加 §15.7。
- `difflib.SequenceMatcher` 字符级：`delete_or_replace = 0`、追加 **1317 字符**、新 blob `f2541e59ee532fb0e0fa4967dbac144af77a4854`。
- §6.2「SFC 零网络调用」与 §2「不动 L0 拉流」原文一字未改。

## 3. T3 · master 代码取证

以 `gh api` 读 master 的 `apps/web/src/components/agent/AgentSideRail.vue`（5698 行 / 272,156 B）：

| 行 | 端点 / 作用 | 语义 |
| --- | --- | --- |
| 797 | `fetch(apiUrl(url), { ...init, headers: ... })` | 通用请求封装 |
| 950 | `/api/agent/chat/threads?sessionId=…` | 线程列表读取 |
| 1087 | `/api/agent/chat/user/messages?…` | 历史消息首屏 |
| 1170 | `/api/agent/chat/user/messages?…&before=…` | 历史消息翻页 |
| 2060 | `/api/agent/chat/user/messages?…` | 影子回合回查 |

- 5 处全部为历史读取 GET 或其通用封装，**无一为指令 POST**。
- 读取侧均带 `cache: 'no-store'`：Nest ETag 无 `Cache-Control` ⇒ 304 空体 ⇒ `res.json()` 抛错（2026-10-28 生产事故口径），因此搬动需行为级契约测试护航。
- `agentCommandClient` 在 SFC 第 47 行被 import，L1 指令已走独立客户端 ⇒ 「L1 指令零内联调用」与现状一致。
- `isMobileLayout` 在 master 为 22 处（④ 门禁的基线来源）。

## 4. T2 · 门禁

| 门禁 | 结果 |
| --- | --- |
| `verify-spec-figures --file <本规格>` | 0 error / 0 warning |
| `verify-spec-figures`（全量） | 0 error / 2 个既有 warning |
| `verify-links` | exit 0 |
| `verify-claims` | 7/7 |
| `verify-pc-visual-regression.py`（证明未碰 ② 文件） | V1–V7 ALL_PASS |
| 占位符扫描 | 零命中 |

## 5. Issue 同步

`Issue #755` 的 Phase 2 条目打勾并追加说明评论，三处（§15.7 / issue 评论 / 本文）都写明「口径澄清 ≠ 5 处 `fetch` 已上收」。

## 6. 诚实边界

- **不宣称** 5 处 `fetch` 已上收、**不宣称**新增 CI 守卫、**不宣称**母规格 §6.2 原文被修正。
- **不宣称**母规格 Phase 4「删 PC 冗余渲染」已实施；② 的护栏只是准入前置。
- 本刀零产品代码改动，合并不触发 `deploy.yml`（本刀路径不在其 `push.paths` 内）。
- 全量 `spec-figures` 的 2 个 warning 为历史文档既有，本刀未触碰。

## 7. 完成定义核对

T1–T3 全绿、Issue 已同步、只追加零删除改写。CI 三必需、squash 合并、推后/合并树全量 blob sha 核对属于入库阶段，结论登记在 PR 与当日工作日志。
