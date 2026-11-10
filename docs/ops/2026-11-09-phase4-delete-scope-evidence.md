# Phase 4 删除域重界定 · 本地验收证据

> 规格：`docs/superpowers/specs/2026-11-09-phase4-delete-scope-rebaseline-design.md`
> 计划：`docs/superpowers/plans/2026-11-09-phase4-delete-scope-rebaseline.md`
> runbook：`docs/ops/2026-11-09-phase4-delete-scope-runbook.md`
> 真值基线：`75f597c765a8cec5eca79a26911773d6ffa9d0a9`（`gh api` true master）

## 1. 取证：删除对象已消解（本刀最重要的结论）

以 `gh api repos/sev7n4/pi-lnk/git/trees/<sha>?recursive=1` 取 true master 全树（4911 blobs），
筛出 `apps/web/src` 下 951 个源文件；本地工作树逐文件裸 blob sha 比对结果：

```
master 源文件 951 | 本地全等 944 | SHA 不同 7 | 本地缺失 0
```

7 个差异文件（含 `AgentSideRail.vue`、`AgentSvgCard.vue`）全部按 master blob 重新取回，
在 `/tmp/knives-master-full` 重建完整镜像沙箱（含 docs / scripts / CI / fixture / baseline / 快照）。
**主仓脏文件一个未动。**

| 取证项 | 母规格 §9 / §13.1 口径 | true master 实证 |
| --- | --- | --- |
| §13.1 #3 的 10 个组件 | 约 1100–1450 行「PC 冗余」 | 合计 **1460 行**，全部有生产引用 |
| `presentation/` 目录 | 待删区 | **27 个 blob**（26 源 + 1 `__snapshots__/*.snap`）；非测试条目 **16 个全部 ≥1 生产引用，零孤儿** |
| `AgentPresentationHost.vue` + 7 子组件 | 归为冗余 | 被 `AgentSideRail.vue` / `agentInterruptGate.ts` / `executionTraceReducer.ts` 消费；Host 在模板挂载 7 个子组件（各 3 次命中 = import + 开闭标签） |
| `NodeTileView.vue` / `NodeViewerView.vue` | 当时未抬升 | **1419 + 1407 = 2826 行**，Phase 0–1 锚抬升后的共享层本体；由 `MobileNodeTile.vue` / `MobileNodeViewer.vue` 薄壳消费 |
| `AgentNodeGraph.vue` 618 / `AgentSvgCard.vue` 85 | 归为冗余 | 被 `AgentSideRail.vue` / `agentMessageRender.ts` / `CanvasPage.vue` / `AgentNodeGraph.vue` 消费 |
| PC 画布 legacy 渲染 | §13 #1 记「已退役」 | 实际在 `components/canvas/`：`NeoBaseNode` 331 / `NodeRenderer` 126 / 4 个 `CanvasNode*`；`CanvasPage.vue:1490` 的 `nodeTypes` 把 image/video/text/audio 全注册到 `NodeRenderer`，其 `isMobileLayout ? MobileNodeTile : legacy[type]` 是**活跃分支** |

**孤儿扫描**：`ORPHANS: []`（16 个非测试条目全部有生产引用）。

### 1.1 护栏与删除刀互斥（新发现）

② PR #791 的 `scripts/fixtures/pc-visual-fixture.json` 只有 `prose_block` / `shot_table` 两组 envelope，
`pc-visual-page.html` 挂载的真实组件是 `AgentPresentationHost.vue`。
⇒ **母规格 §9 要删的对象 = 护栏保护的对象**。
按 §9 删除必然 `diff_count>0` ⇒ 护栏 RED；而 runbook §7 又要求删除刀附 `diff_count=0`
且不得改 `pc-visual-baseline.json` / fixture / 采集脚本 / verifier。
二者构成规格级互斥，不能靠「照 §9 开刀」解决，也不得放宽护栏绕过。

## 2. V1–V7 判据结果

`python3 scripts/verify-phase4-delete-scope.py`（主仓与 master 镜像沙箱双跑）：

```
PASS  V1  27 个文件全登记
PASS  V2  引用图一致且零孤儿
PASS  V3  删除目标 0 项 / NO_DELETE_TARGET
PASS  V4  双锚与 Host 均有真实消费
PASS  V5  只追加前缀 sha256 相等 + §15.8 登记完备
PASS  V6  CI 挂载有效
PASS  V7  实现层判据齐备
VERDICT ALL_PASS NO_DELETE_TARGET
```

- 主仓直接跑 `exit 0`、镜像沙箱 `--root /tmp/knives-master-full` 跑 `exit 0`：引用图对 7 个脏文件的差异不敏感，判据稳定。
- manifest：`schema=lnkpi.phase4-delete-scope.v1`、`inventory=27`、`delete_targets=[]`、`verdict=NO_DELETE_TARGET`、
  `append_only_prefix_bytes=30150`、`append_only_prefix_sha256=151b0105a2e00a47…`。

## 3. 只追加校验

母规格 `docs/superpowers/specs/2026-11-05-sse-conversation-view-unification-design.md`：

```
pre-append  bytes 30150  sha256 151b0105a2e00a47…
post-append bytes 34217  prefix_sha256 151b0105a2e00a47…
added bytes 4067        字符级只追加 old == new[:len(old)]
```

§15.8 登记：§15.4 三格闭环、§9 删除对象漂移表、护栏互斥、本轮 `NO_DELETE_TARGET` 结论、
后继约束与诚实边界。§2 / §6.2 / §9 / §13 / §15.1–§15.7 零删除改写。

`ci.yml` 只追加 2 行到既有 `spec-figures` job：

```yaml
      - name: Verify phase4 delete scope (NO_DELETE_TARGET ratchet)
        run: python3 scripts/verify-phase4-delete-scope.py
```

不新建 job、不改 `package.json`。

## 4. 变异测试 14/14

在 `/tmp/knives-mutation` 沙箱副本上注入，恢复后 `VERDICT ALL_PASS NO_DELETE_TARGET`、`exit 0`。

| ID | 注入 | 结果 |
| --- | --- | --- |
| M1 | manifest 漏登记 1 项 | `V1,V2` RED |
| M2 | 伪造 `prod_refs` | `V2` RED |
| M3 | `delete_targets` 塞活代码 | `V3` RED |
| M4 | 双锚之一标为可删 | `V3,V4` RED |
| M5 | **行为级**：真实删掉 `AgentShotTable.vue` | `V1,V2` RED |
| M6 | 母规格 §2 改一个字 | `V5` RED |
| M7 | YAML `#` 注释伪装 CI 挂载 | `V6` RED |
| M8 | 只加注释不动实现 | 对照绿 `exit 0` |
| M9 | 掏空 `within_ratchet` 保护名单分支 | `V3` RED |
| M10 | `NO_DELETE_TARGET` → `ALL_PASS` | `V3` RED |
| M11 | 实现层 `strip_comments` 改名（别名字典保运行） | `V7` RED |
| M12 | manifest 伪造不存在文件 | `V1` RED |
| M13 | §15.8 编号被改 | `V5` RED |
| M14 | runbook 删掉准入契约锚点 | `V5` RED |

```
MUTATION 14/14 ALL_PASS   MUTATION_EXIT=0
```

### 4.1 伪变异实证（两条，按纪律先怀疑伪变异）

- **M9 首轮不 RED**：注入只删掉保护名单特判，而探针 `NodeTileView.vue` 恰好也是活代码 ⇒
  下游「零引用」检查照样拒绝 ⇒ 行为零变化。**修法**：V3 增加**合成探针**
  （人为把保护对象的 `prod_refs` 清空后再断言棘轮仍拒绝），只有保护名单分支能拦住它；
  另加「活代码」探针覆盖另一条拒绝路径。修后 M9 精确 `V3` RED。
- **M11 首轮不 RED**：注入把实现层函数改名导致脚本 `NameError` 崩溃，`exit 1` 但无 FAIL 行，
  属崩溃而非判据转红。**修法**：改名同时加别名保持脚本可运行，验证
  `implementation_code()` 剔除判据函数体后 V7 找不到实现层锚点 ⇒ 精确 `V7` RED。

## 5. 全量门禁

```
verify-spec-figures --file <本规格>      0 error / 0 warning
verify-spec-figures (全量)              0 error / 2 warning（既有，来自 2026-10-04-metrics-observability-design.md R4，非本刀引入）
verify-agent-rail-gates                 SUMMARY: 11/11 passed; failed=none
verify-is-mobile-layout-scope.py        VERDICT ALL_PASS
verify-phase4-delete-scope.py           VERDICT ALL_PASS NO_DELETE_TARGET
```

## 6. 改动文件清单（8 路径：6 新增 + 2 修改）

| 文件 | 动作 |
| --- | --- |
| `scripts/verify-phase4-delete-scope.py` | 新增 |
| `scripts/fixtures/phase4-delete-scope-manifest.json` | 新增 |
| `docs/ops/2026-11-09-phase4-delete-scope-runbook.md` | 新增 |
| `docs/ops/2026-11-09-phase4-delete-scope-evidence.md` | 新增（本文） |
| `docs/superpowers/specs/2026-11-09-phase4-delete-scope-rebaseline-design.md` | 新增 |
| `docs/superpowers/plans/2026-11-09-phase4-delete-scope-rebaseline.md` | 新增 |
| `docs/superpowers/specs/2026-11-05-sse-conversation-view-unification-design.md` | 只追加 §15.8 |
| `.github/workflows/ci.yml` | 只追加 2 行 |

## 7. 诚实边界

- **不宣称** Phase 4 删除动作已完成；母规格 Phase 4 仍为 ⏳ 未闭环，但闭环前置已从「护栏就绪」升级为「先重新界定删除对象」。
- **不宣称** §9 原文被修正、护栏被修改或放宽、新增 required check、任何产品代码改动。
- **不宣称** `components/canvas/` 的 PC legacy 分支已处理。
- **不宣称** PR #625 / A-6 / 逐处搬 21 点读取有任何进展；三者维持独立窗口。
- 本刀零生产发布：`deploy.yml` 的 `push.paths` 不含 `docs/` / `scripts/` / `ci.yml`。
- 全量 `verify-spec-figures` 的 2 个既有 warning 非本刀引入。

## 8. 推送时基线前移（只追加状态回填）

本节写作时 true master 为 `75f597c765a8cec5eca79a26911773d6ffa9d0a9`；实际推 PR 前已前移至
`e5ee59a46b231cb94f956ff245888f589dc0a038`（并行 PR 改动 4 个源文件：`AgentSideRail.vue` /
`AgentSideRail.canvasRefEntry.test.ts` / `MobileTabBar.vue` / 新增 `useMobileComposerFocus.ts`）。

- `MASTER_MOVED_SAFE`：8 个改动路径在新旧 master 的 blob **全等** ⇒ 本刀改用新 HEAD 作 parent、`base_tree` 取新 master tree，不回退并行的 4 个改动。
- ⭐ **引用图重新验证**：前移包含 `AgentSideRail.vue`，它是 `presentation/` 组件的主要消费方。按新 master 的 4 个 blob 重建镜像沙箱后重算 `compute_inventory`，与 manifest 逐项比对 `DIFF_COUNT 0`；V1–V7 在新基线上再跑一次仍 `VERDICT ALL_PASS NO_DELETE_TARGET`、`exit 0`。
- 字符级核对：母规格 30150 → 34217 字节，前缀 sha256 相等（`151b0105a2e00a47…`），零删除改写；`ci.yml` 的 diff 恰为 **1 处纯插入、128 字符、零删除**（`INSERT_ONLY True`）——是在既有 `spec-figures` job 内插入 2 行，不是尾部追加。
- 上文 §1–§7 出现的 `75f597c7` 均为写作时点记录，按「历史时点结论不追溯改写，只做只追加状态回填」原样保留。

## 9. 状态更正（2026-11-10 只追加）

- 本证据文档 §7 写「母规格 Phase 4 仍为 ⏳ 未闭环」——此为写作时点（2026-11-09）状态。**2026-11-10 该 gate 已 adjudicate 闭环**：对应设计规格 `2026-11-09-phase4-delete-scope-rebaseline-design.md` 顶部状态由「待评审」改为「已闭环（adjudicated NO_DELETE_TARGET）」，并新增 §15 状态收口段。
- 闭环语义：经实证 `NO_DELETE_TARGET`，删除刀按母规格 §9 字面**终止**（无待办功能），后继转入 ② 删除刀重定义（独立、不在路线 ③ 主线）。删除域 gate 自此不再产生"进行中"信号。
- 上文 §7「⏳ 未闭环」按「历史时点结论不追溯改写」原样保留，本段仅作状态更正，不抹除时点记录。
