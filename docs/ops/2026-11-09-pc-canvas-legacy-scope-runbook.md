# PC 画布 legacy 合并裁决 · 运行手册

> 规格：`docs/superpowers/specs/2026-11-09-pc-canvas-legacy-adjudication-design.md`
> 计划：`docs/superpowers/plans/2026-11-09-pc-canvas-legacy-adjudication.md`
> 脚本：`scripts/verify-pc-canvas-legacy-scope.py`
> CI 挂载：`.github/workflows/ci.yml` 的既有 `spec-figures` job，**不新建 job**
> 真值基线：`d7c8246b2f9acd7a5f7d6431aec3523da2b358ce`（`gh api` true master）

## 1. 这个门禁锁什么

| 区域 | 判据 | 当前值 |
| --- | --- | --- |
| 四个 `CanvasNode*.vue` legacy 组件 | 生产引用数 ≥ 2，零孤儿 | 3 / 3 / 2 / 3 |
| `NodeRenderer.vue` | 唯一 `isMobileLayout` 布局分派点形态在位 | 1 |
| `MobileNodeTile.vue` → `NodeTileView.vue` | 移动端薄壳链仍在 | 1 / 1 |
| `delete_targets` | 空集且显式 `NO_DELETE_TARGET` | `[]` |
| `merge_decision` | `NO_MERGE` + 四条理由 | 4 |
| 母规格 §1–§15.8 | 字节级只追加前缀 sha256 相等 | 34217 字节 |

**为什么是 `NO_MERGE`**：四个 legacy 组件合计 1025 行，被 `CanvasReadonlyPage.vue`、`ReplayPage.vue`、`NodeRenderer.vue` 三条生产链引用；`NodeTileView.vue` 1419 行是移动端锚。既不是死代码，也不与移动端共享锚等价 ⇒ 删除与合并两条路径都被源码事实堵死。详见母规格 §15.9。

## 2. 分组判据

| 组 | 判据 | 失败含义 |
| --- | --- | --- |
| V1 | manifest 恰 10 个真实条目；`discover_legacy()` 动态反推集合相等 | 漏登记 / 伪造清单 / 目标文件被删 |
| V2 | 逐项 `prod_refs` 与 `lines` 等于真实计算值；四个 legacy 引用数 ≥ 2 | 引用图漂移 / 出现孤儿 |
| V3 | 空集显式 `NO_DELETE_TARGET`；三条拒绝路径各配探针 | 棘轮方向被改写 / 保护名单被掏空 |
| V4 | `NO_MERGE` 四条理由锚点齐备；分派链与薄壳链在位 | 裁决被静默改成合并 / 分派点消失 |
| V5 | 母规格前缀 34217 字节 sha256 相等；§15.9 登记完备；② 四项准入只读 | 历史结论被改写 / 护栏被破坏 |
| V6 | `spec-figures` job 剥 YAML 注释后含调用行 | 脚本写了没挂 / 注释伪装挂载 |
| V7 | `implementation_code()` 剔除判据体后实现层仍有 6 个纯函数 | 判据自匹配恒绿 |

⭐ **合成探针（V3）**：真实保护对象都是活代码，只删保护名单特判会被下游「零引用」检查兜住 ⇒ 行为零变化＝伪变异。本门禁人为把 `NodeTileView.vue` 的 `prod_refs` 清空再列入 `delete_targets`，使**只有保护名单分支**能拦住它；另用 `Ghost.vue` 零引用非保护孤儿做方向对照，证明棘轮不是恒 False。

## 3. 运行

```bash
python3 scripts/verify-pc-canvas-legacy-scope.py            # 默认扫仓库根
python3 scripts/verify-pc-canvas-legacy-scope.py --json     # 结构化输出
python3 scripts/verify-pc-canvas-legacy-scope.py --only V3  # 只跑一组
python3 scripts/verify-pc-canvas-legacy-scope.py --root /tmp/pc-legacy-sandbox  # 沙箱变异
python3 scripts/verify-pc-canvas-legacy-scope.py --emit-manifest  # 由源码重算清单
```

- 全绿 ⇒ `VERDICT ALL_PASS NO_MERGE_NO_DELETE_TARGET`、`exit 0`；任一失败 ⇒ `VERDICT HAS_FAILURE V…`、`exit 1`。
- 无必填 env、不连网络、不解析 Vue、不起浏览器 ⇒ 满足门禁准入三问（零外部依赖 / 确定性 / 可失败）。
- CI 中由 `Verify spec figures` job 的 `Verify pc canvas legacy scope (NO_MERGE ratchet)` 步骤执行，PR 的 CI 日志即自举证明。

## 4. 三条坑

1. **中文文档字符切片**：母规格是中文，前缀长度是**字节数**；`spec[34217:]` 字符切片恒空 ⇒ V5 假红。必须 `raw[:n]` 后再 decode。
2. **注释伪装**：组件名只写进 `//`、`/* */`、`<!-- -->` 或 YAML `#` 会误判 ⇒ 四层注释剥离；M7 / M11 分别验证「不假绿」与「不误报」。
3. **函数改名致崩溃**：把实现层函数改名会让脚本 `NameError` 退出，`exit 1` 但无 FAIL 行 ⇒ 是崩溃不是判据转红。变异须同时加别名保持脚本可运行，验证 V7 精确 RED。

## 5. 变异测试

沙箱树由 `gh api` 从 true master 拉真实源码构建；行为级变异不污染产品代码。12 组：

| 组 | 变异 | 期望 |
| --- | --- | --- |
| M1 | manifest 漏登记一个组件 | `V1` RED |
| M2 | 把某组件 `prod_refs` 改成空 | `V2` RED |
| M3 | `delete_targets` 塞入活跃组件 | `V3` RED |
| M4 | `merge_decision` 改成 `MERGE` | `V4` RED |
| M5 | 删母规格 §15.9 追加段 | `V5` RED |
| M6 | 删 CI 挂载 | `V6` RED |
| M7 | 挂载只写进 YAML 注释 | `V6` RED |
| M8 | 实现层函数改名并加别名 | `V7` RED |
| M9 | 真实删除 `CanvasNodeImage.vue` | `V1` / `V2` RED |
| M10 | 合成探针：清空保护对象引用后标可删 | `V3` RED |
| M11 | 组件名只写进注释 | 全绿（不误报） |
| M12 | 无关注释追加 | 全绿（对照） |

每条恢复后交付文件裸 blob sha 全等。**变异不 RED 先怀疑伪变异**，不得把余量吞掉或崩溃退出当成判据通过。

## 6. 诚实边界

- 本刀**不宣称** Phase 4 功能闭环、**不宣称**删除动作已执行、**不宣称** ② 护栏被修改、**不宣称** §9 原文被修正。
- `NO_MERGE` 是规格裁决与 `DELETE_ACTION_CLOSED_NO_TARGET` 动作终止，不是「删 PC 冗余渲染」已实现。
- 本门禁只约束源码引用图与裁决字段，**不覆盖像素或运行时形态**；两端渲染形态由 §7 的准入契约在将来重启合并时另行取证。
- CI 以 checkout 的源码为准，本地工作树脏状态不参与判据。

## 7. `components/canvas/` 侧行为级准入契约

本刀只做裁决与源码棘轮，**不改任何产品代码、零生产发布**。若将来以产品需求驱动重启「PC legacy 与移动端共享锚合并」，这是真实行为变更，须单独规格评审并满足以下行为级准入：

1. **先补该侧护栏**：针对 `components/canvas/` 的 PC 画布节点渲染形态，产出可复现的 CDP 冒烟取证（PC 与移动两端分别挂载 `NodeRenderer`，断言 `Target` 解析出的组件身份与节点 DOM 结构），并配 PC / 移动两端契约测试。
2. **遵守 ② 的四项准入**：PR 描述须附 `VERDICT ALL_PASS`、`diff_count=0`、两次采集 `sha256` 的 `SHA_A` / `SHA_B` 相等、PNG 截图路径（人工目视附件）。
3. **护栏只读**：不得修改 `pc-visual-baseline.json`、fixture、采集脚本或判据；golden 基线必须先于合并刀独立入库，否则 diff 恒空＝伪绿。
4. **生产发布纪律**：`deploy.yml` 的 `push.paths` 含 `apps/web/**`，合并刀必然触发生产发布 ⇒ 必须配生产复测（bundle 级下钻懒加载 chunk + `/api/health`），并核对零回退并行改动。
5. **冻结边界**：不碰 `sendMessage` / `handleEvent` / `canvas_command` / `defineExpose` 11 项；不按功能簇拆。

**裁定**：在当前 true master 源码事实下，上述重启条件无一成立；删除刀按 §9 字面**不可执行**，主线不再挂起该待办。
