# `isMobileLayout` 读取域棘轮门禁 · 本地验收证据（2026-11-09）

> 规格：`docs/superpowers/specs/2026-11-09-is-mobile-layout-scope-gate-design.md`（13 章 + §14）
> 计划：`docs/superpowers/plans/2026-11-09-is-mobile-layout-scope-gate.md`
> runbook：`docs/ops/2026-11-09-is-mobile-layout-scope-runbook.md`
> 写作时 true master：`74c5e0c081e75945ecc7274388b09e6b236127a2`；③ PR #792 合并后会前移，推前重核

## 1. 交付清单（5 新增 + 1 修改）

| # | 路径 | 类型 |
| --- | --- | --- |
| 1 | `docs/superpowers/specs/2026-11-09-is-mobile-layout-scope-gate-design.md` | 新增（13 章 + §14 + 图 1） |
| 2 | `docs/superpowers/plans/2026-11-09-is-mobile-layout-scope-gate.md` | 新增（4 Task + 状态回填） |
| 3 | `docs/ops/2026-11-09-is-mobile-layout-scope-runbook.md` | 新增 |
| 4 | `docs/ops/2026-11-09-is-mobile-layout-scope-evidence.md` | 新增（本文） |
| 5 | `scripts/verify-is-mobile-layout-scope.py` | 新增（V1–V6） |
| 6 | `.github/workflows/ci.yml` | **只追加** 2 行（126 字符）到既有 `spec-figures` job |

零改动：`package.json`、`deploy.yml`、`apps/**`、`services/**`、`charts/**`、② / ③ 的全部交付文件、母规格（避免与 ③ PR #792 抢同一路径）。

## 2. T1 · 基线 RED → ALL_PASS

只建 verifier、CI 未挂时：`V1–V4 PASS`、`V5 FAIL`（未挂载）、`V6 FAIL`（初版源级检查写法错误）⇒ `VERDICT HAS_FAILURE V5,V6`、`exit 1`。

挂 CI 并修完实现期三处缺陷后：

```
PASS  V1  零外部依赖（Python 标准库）
PASS  V2  presentation 与 packages/shared 零读取
PASS  V3  Shell 读取点 21 <= 21，方向判据在位
PASS  V4  唯一布局断点定义点
PASS  V5  门禁挂在既有 spec-figures job，未新建 job
PASS  V6  注释剥离与统一计数入口在位
VERDICT ALL_PASS   exit 0
```

**实现期修正（详见规格 §14）**：

1. 上限 `22 → 21`：grep 的 22 行含 1 行文档注释，剥离注释后有效读取点 21。
2. 判据自匹配：初版「源码含某锚点」的断言字面量就写在判据函数里 ⇒ 恒绿；重构为 `implementation_code()` 剔除判据函数体 + 独立纯函数 `within_ratchet(count, limit)`。
3. `function_body` 从 JS 花括号配对改为 Python 顶层定义边界；新增 `strip_yaml_comments()` 防 YAML 注释伪装挂载。

## 3. T2 · 变异 7 组（7/7 OK）

沙箱树 `/tmp/pc-scope-sandbox` 由 `gh api` 从 master 拉真实 `AgentSideRail.vue` 与 `ci.yml` 构建，行为级变异不污染产品代码；每条恢复后 5 个目标文件（沙箱 4 + 真实 verifier）裸 blob sha 全等。

| 组 | 变异 | 结果 |
| --- | --- | --- |
| M1 | Content 注入一处读取 | `V2` RED，exit 1 |
| M2 | Shell 多一处读取 | `V3` RED，exit 1 |
| M3 | 删 CI 挂载 | `V5` RED，exit 1 |
| M4 | 棘轮方向反转 | `V3` RED，exit 1 |
| M5 | 挂载只写进 YAML 注释 | `V5` RED，exit 1 |
| M6 | Content 只写进注释（不误报对照） | 全绿、exit 0 |
| M7 | 无关注释伪变异对照 | 全绿、exit 0 |

⭐ **伪变异实证**：M2 在 `MAX_ALLOWED=22` 时 **不 RED（exit 0）** —— 上限留的 1 点余量把注入吞掉。收紧到 21 后精确 RED。这印证「变异不 RED 先怀疑伪变异」，不是判据通过。

## 4. T3 · CI 挂载与自举

- 本地 `ci.yml` 与 master blob `c6b9518e…` 完全一致，只追加 126 字符（`SequenceMatcher delete_or_replace=0`）。
- 挂载步骤：`- name: Verify isMobileLayout scope (Shell-only ratchet)` / `run: python3 scripts/verify-is-mobile-layout-scope.py`。
- `deploy.yml` 的 `push.paths` 不含 `.github/workflows/ci.yml`，也不含 `docs/` / `scripts/`，且本刀**不改 `package.json`** ⇒ 合并不触发生产发布。
- 本刀 PR 的 `Verify spec figures` job 会实际执行该步骤，日志即自举证明。

## 5. T4 · 全量门禁

| 门禁 | 结果 |
| --- | --- |
| `verify-spec-figures --file <本规格>` | 0 error / 0 warning |
| `verify-spec-figures`（全量 210 篇） | 0 error / 2 个既有 warning |
| `verify-links` / `verify-claims` | exit 0 / 7/7 |
| `verify-agent-rail-gates` | 11/11 |
| `verify-web-upload` | 13/13 |
| `verify-pc-visual-regression`（② 判据未受影响） | ALL_PASS |
| `verify-is-mobile-layout-scope`（本刀） | ALL_PASS |
| 占位符扫描 | 零命中 |

## 6. 诚实边界

- **不宣称** 22 行 / 21 点读取已被搬迁 —— 本刀只立棘轮，逐处搬是后继刀（runbook §6 列了四条准入条件）。
- **不宣称**新建 required check：本门禁挂在既有 `spec-figures` job 内，未新建 job。
- **不宣称**覆盖像素或运行时形态，只约束源码读取域。
- **不宣称**母规格 Phase 4「删 PC 冗余渲染」已实施；② 护栏只是准入前置，③ 只是口径澄清。
- 全量 `spec-figures` 的 2 个 warning 来自历史文档，本刀未触碰。
- CI 以 checkout 源码为准；本机工作树脏状态不参与判据。沙箱基线 `exit 0 / red=[]` 已从 master 真实文件复现。

## 7. 完成定义核对

T1–T4 全绿、7 组变异 7/7、字符级只追加零删除改写。CI 三必需、squash 合并、推后/合并树全量 blob sha 核对、`Issue #755` 第 3 项状态登记属于入库阶段，结论登记在 PR 与当日工作日志。


## 8. 推送时基线前移（2026-11-09，只追加）

本文写作时 true master 为 `74c5e0c0`；实际推 PR 前已前移至 `3d35d42aac75e791ce00b21427b5c9fc9be3bea7`（③ PR #792「Phase 2 口径澄清」，4 个改动路径与本刀 6 路径零重叠）。`gh api` 核对本刀 6 个目标路径在新旧 master 的 blob **完全一致**（5 个新增路径均为 `ABSENT`、`ci.yml` 恒为 `c6b9518e…`）⇒ `MASTER_MOVED_SAFE`，改用新 HEAD 作 parent、`base_tree` 取新 master tree，不回退 ③ 的任何改动。上文出现的 `74c5e0c0` 均为写作时点记录，按「不追溯改写历史结论」保留。
