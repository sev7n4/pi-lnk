# PC 画布 legacy 合并裁决 · 证据（2026-11-09）

> 对应规格：`docs/superpowers/specs/2026-11-09-pc-canvas-legacy-adjudication-design.md`
> 对应计划：`docs/superpowers/plans/2026-11-09-pc-canvas-legacy-adjudication.md`
> 运行手册：`docs/ops/2026-11-09-pc-canvas-legacy-scope-runbook.md`

## 1. 取证基线

- true master：`d7c8246b2f9acd7a5f7d6431aec3523da2b358ce`，`gh api` Git Data API tree `recursive=1`，`blobs=4918`、`truncated=False`。
- `apps/web/src` 共 965 个源文件；本次 10 个目标条目 + 母规格 + `ci.yml` + ② 护栏文件，**逐路径裸 blob sha 与 master 全等**（`MATCH`），因此主仓计算结果等价于 true master 计算。
- ⚠️ 反例登记：本地工作树 `AgentSideRail.vue` 裸 blob sha `47885faf0d` ≠ master `93f3541391`，再次印证「并行工作树不可采信」。本刀不读该文件。

## 2. 引用图与架构事实

| 条目 | kind | 行数 | 生产引用数 | 引用来源 |
| --- | --- | --- | --- | --- |
| `CanvasNodeImage.vue` | vue | 253 | 3 | `NodeRenderer` / `CanvasReadonlyPage` / `ReplayPage` |
| `CanvasNodeVideo.vue` | vue | 311 | 3 | 同上 |
| `CanvasNodeAudio.vue` | vue | 280 | 2 | `NodeRenderer` / `CanvasReadonlyPage` |
| `CanvasNodeText.vue` | vue | 181 | 3 | 同上（同 Image） |
| `NodeRenderer.vue` | vue | 126 | 1 | `CanvasPage` |
| `MobileNodeTile.vue` | vue | 279 | 1 | `NodeRenderer` |
| `NodeTileView.vue` | vue | 1419 | 1 | `MobileNodeTile` |
| `CanvasPage.vue` | page | 6807 | 2 | `useRoutePreload` / `router/index.ts` |
| `CanvasReadonlyPage.vue` | page | 123 | 1 | `router/index.ts` |
| `ReplayPage.vue` | page | 233 | 1 | `router/index.ts` |

- 四个 legacy 组件合计 **1025 行**，生产引用 3 / 3 / 2 / 3 ⇒ **零孤儿**。
- `NodeRenderer.vue` 的 `Target = computed(() => isMobileLayout.value ? MobileNodeTile : legacy[props.type])` 是**唯一**布局分派点；`components/canvas/` 全目录 251 文件中仅 3 个含 `isMobileLayout`（`NodeRenderer` 2 处、`DockStudioToolbar` 5 处、`ProposeConfirmOverlay` 2 处）。
- `NodeTileView.vue` 1419 行是移动端薄壳本体，与 PC 画布节点形态不同。
- 结论：`NO_MERGE` / `NO_DELETE_TARGET` / `DELETE_ACTION_CLOSED_NO_TARGET`。四条裁决理由见母规格 §15.9 与 manifest `merge_decision.reasons`。

## 3. V1–V7 主仓与沙箱双跑

两处均 `exit 0`，输出逐字一致：

```text
PASS  V1  10 个条目全登记，动态发现 4 个 legacy
PASS  V2  引用图一致且四个 legacy 均有多处生产引用
PASS  V3  删除目标 0 项 / NO_DELETE_TARGET
PASS  V4  NO_MERGE 四理由齐备，只读页 / 回放页 / 画布页分派链在位
PASS  V5  只追加前缀 sha256 相等 + §15.9 登记完备 + ② 护栏只读
PASS  V6  CI 挂载有效
PASS  V7  实现层判据齐备
VERDICT ALL_PASS NO_MERGE_NO_DELETE_TARGET
```

- 主仓：`python3 scripts/verify-pc-canvas-legacy-scope.py`
- 沙箱：`python3 /tmp/pc-legacy-sandbox/scripts/verify-pc-canvas-legacy-scope.py --root /tmp/pc-legacy-sandbox`（沙箱由 `gh api` true master 镜像 + 本刀交付文件构建）

## 4. 变异测试 12/12

| 组 | 变异 | 期望 | 实测 | 恢复后 |
| --- | --- | --- | --- | --- |
| M1 | manifest 漏登记一个组件 | V1 RED | `V1,V2` | ALL_PASS |
| M2 | 某组件 `prod_refs` 改成空 | V2 RED | `V2` | ALL_PASS |
| M3 | `delete_targets` 塞入活跃组件 | V3 RED | `V3` | ALL_PASS |
| M4 | `merge_decision` 改成 `MERGE` | V4 RED | `V4` | ALL_PASS |
| M5 | 母规格按字节截回 34217（删 §15.9） | V5 RED | `V5` | ALL_PASS |
| M6 | 删 CI 挂载 | V6 RED | `V6` | ALL_PASS |
| M7 | 挂载只写进 YAML 注释 | V6 RED | `V6` | ALL_PASS |
| M8 | 实现层 `compute_inventory` 改名并加别名 | V7 RED | `V7` | ALL_PASS |
| M9 | 行为级：真实删除 `CanvasNodeImage.vue` | V1/V2 RED | `V1,V2` | ALL_PASS |
| M10 | 掏空保护名单特判 | V3 RED（合成探针） | `V3` | ALL_PASS |
| M11 | 组件名只写进注释 | 全绿 | `ALL_PASS` | ALL_PASS |
| M12 | 无关注释追加 | 全绿 | `ALL_PASS` | ALL_PASS |

`MUTATIONS 12/12`、`ALL_LOCAL_MATCH True`（脚本 / manifest / ci.yml / 母规格四项恢复后与主仓裸 blob sha 全等）。

⭐ **两条伪变异防护实证**：M10 针对「删保护名单特判但探针恰是活代码 ⇒ 下游零引用检查兜住」——用合成探针（人为清空 `NodeTileView.vue` 的 `prod_refs`）使只有保护名单分支能拦住；M8 针对「函数改名致 `NameError` 崩溃、`exit 1` 但无 FAIL 行」——改名同时加别名保持脚本可运行，验证 V7 精确 RED。M11 若把注释加进清单内文件会改 `lines` 造成假红，故注入到非目标文件 `CanvasNodeGroup.vue`，验证「不误报」。

## 5. 全量门禁

| 门禁 | 结果 |
| --- | --- |
| `pnpm verify-spec-figures --file <本规格>` | 0 error / 0 warning |
| `pnpm verify-spec-figures`（全量 214 篇） | 0 error / 2 个既有历史 warning，不归因本刀 |
| `python3 scripts/verify-is-mobile-layout-scope.py` | `VERDICT ALL_PASS` |
| `python3 scripts/verify-phase4-delete-scope.py` | `VERDICT ALL_PASS NO_DELETE_TARGET` |
| `pnpm verify-agent-rail-gates` | 11/11 |
| `pnpm verify-links` | 全绿（既有历史链接提示不归因本刀） |
| `pnpm verify-claims` | 7/7 |
| `python3 scripts/verify-web-upload.py` | 13/13 |

## 6. 只追加与零改动

- 母规格 `34217 → 37706` 字节，`APPEND_ONLY True`，`sha256(raw[:34217]) = b55f26c2ecb6060010c2617af9dc97feb3171591fef245a53116d3d753e30e8b` 与追加前一致。
- `ci.yml` 只在既有 `spec-figures` job 内追加 2 行（`- name` + `run`），不改既有行、不新建 job、不改 `package.json`。
- **零产品代码改动**：`apps/**`、`package.json`、`deploy.yml`、`pc-visual-baseline.json`、② / ④ 交付文件全部零改动 ⇒ 本刀零行为变更、零生产发布。

## 7. 实现期修正（只追加，不改写规格 §1–§13）

1. `discover_legacy()` 首版以三个消费页为发现源，额外命中 `CanvasNodeGroup.vue` / `CanvasNodePrompt.vue`（只读页还引用它们），集合 6 ≠ 4 ⇒ V1 假红。改为**只以 `NodeRenderer.vue` 的 legacy 分派源码**为发现源，仍属动态反推而非手写常量。
2. V4 首版用「引用链计数 ≥ 8」，真实值为 7（只读页 4 + 回放页 3 + 画布页 0）⇒ 假红。改为逐页精确断言（只读页 4 条、回放页 3 条、`CanvasPage` 消费 `NodeRenderer`），消除余量。
3. V5 首版校验 ② runbook 含字面「四项」，实际标题为「删除刀准入契约」⇒ 假红。改校验标题 + 四项内容 token。
4. manifest 的 `prod_refs` 为**引用文件路径列表**（非整数）；规格 §6 的「≥ 2」按列表长度判定，逐项与真实计算值比较。
5. 中文母规格按字节切片（§4 判据 G）实证有效；M5 用字节截断验证 V5 精确 RED。

## 8. 诚实边界

- 本刀**不宣称**母规格 Phase 4 功能闭环、**不宣称**删除动作已执行、**不宣称** ② 护栏被修改、**不宣称** §9 原文被修正。
- `NO_MERGE` 是架构裁决 + `DELETE_ACTION_CLOSED_NO_TARGET` 动作终止；「无可删对象」不等于「删 PC 冗余渲染已实现」。
- 本门禁只约束源码引用图与裁决字段，**不覆盖像素或运行时形态**；将来若重启合并，须按 runbook §7 补 `components/canvas/` 侧行为级护栏并做生产复测。
- 本机无移动设备；本刀不涉及真机复测，A-6 仍为独立窗口待办。


## 9. 推送时基线前移（只追加，不改写上文）

- 写作时 true master `d7c8246b2f9a`；推前核对时前移至 `2b6693c579ffb2931a84d1954e93fecf5617db91`（4918 → 4919 blobs），全树差异恰 2 路径：`apps/web/src/components/agent/AgentSideRail.vue`（`93f3541391` → `47885faf0d`）与新增 `apps/web/src/composables/useMobileKeyboardInset.ts`。
- `MASTER_MOVED_SAFE True`：本刀 8 个交付路径在新旧 master 的 blob **逐项全等**；母规格 `PREFIX_OK True`（本地 37706 字节的前 34217 字节恰等于新 master 全文），`ci.yml` 为纯插入。
- 按新 master 重建 966 文件 `apps/web/src` 镜像（`MIRROR_REFRESHED 0`，镜像已与新 master 全等），沙箱基线 `ALL_PASS`、12 组变异 12/12、`ALL_LOCAL_MATCH True` 全部重跑通过 ⇒ 引用图与裁决不受前移影响。
- 按「历史时点结论不追溯改写，只做只追加状态回填」纪律：§1 的基线值、manifest 的 `baseline_sha` 与 `append_only_prefix_sha256` 均保留原值；本节只登记执行时状态。
