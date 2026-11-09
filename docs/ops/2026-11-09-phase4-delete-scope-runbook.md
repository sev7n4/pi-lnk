# Phase 4 删除域重界定 · 运行手册

> 规格：`docs/superpowers/specs/2026-11-09-phase4-delete-scope-rebaseline-design.md`
> 计划：`docs/superpowers/plans/2026-11-09-phase4-delete-scope-rebaseline.md`
> 判据：`scripts/verify-phase4-delete-scope.py`；清单：`scripts/fixtures/phase4-delete-scope-manifest.json`
> 定位：把母规格 §9「删 `presentation/` 下 PC 冗余渲染」的删除对象锁成可机检棘轮。**不是删除刀，不删任何代码。**

## 1. 这个判据保护什么、不保护什么

- **保护**：`apps/web/src/components/agent/presentation/` 目录的**完整性**与**引用活性**。manifest 由真实源码计算，V1 卡清单集合、V2 卡引用图、V3 卡删除棘轮方向、V4 卡共享层双锚与护栏挂载点。
- **不保护**：像素外观、运行时渲染、移动端形态、生产 `AgentSideRail.vue` 的 dock 布局、SSE/网络层。本判据只读源码文本。
- **不宣称**：不挂新 required check（挂在既有 `spec-figures` job 内一步）；不等于删除动作已完成；不覆盖 `components/canvas/` 下的 PC 画布 legacy 分支。

## 2. 为什么当前是 `NO_DELETE_TARGET`

true master `75f597c765a8` 实证：

| 事实 | 数值 / 结论 |
| --- | --- |
| `presentation/` 目录 | 27 个 blob = 26 源文件 + 1 个 `__snapshots__/*.snap` |
| 非测试条目 | 16 个，**全部 ≥1 生产引用，零孤儿** |
| §13.1 #3 列举的 10 个组件 | 合计 1460 行，正是母规格 §9「约 1100–1450 行」的出处，但现为活代码 |
| `NodeTileView.vue` + `NodeViewerView.vue` | 1419 + 1407 = 2826 行，Phase 0–1 锚抬升后的**共享层本体**，由移动端薄壳消费 |
| `AgentPresentationHost.vue` + 7 子组件 | PC 呈现主链，且是 ② 护栏 fixture 挂载的真实组件链 |
| PC 画布 legacy 渲染 | 在 `components/canvas/`，`NodeRenderer` 按 `isMobileLayout` 分叉，仍是活跃分支 |

⇒ **母规格 §9 要删的对象 = ② 护栏保护的对象**，二者互斥：删除必然 `diff_count>0` ⇒ 护栏 RED，而删除刀准入契约要求 `diff_count=0`。

## 3. 运行方式

```bash
# 仓库根，零外部依赖
python3 scripts/verify-phase4-delete-scope.py

# 只跑一组
python3 scripts/verify-phase4-delete-scope.py --only V3

# 指向按 true master 构建的镜像沙箱（本地工作树脏时使用）
python3 scripts/verify-phase4-delete-scope.py --root /tmp/knives-master-full

# 重新计算清单（清单只能由真实源码产出，禁止手写）
python3 scripts/verify-phase4-delete-scope.py --emit-manifest > scripts/fixtures/phase4-delete-scope-manifest.json
```

预期：

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

退出码 0 = 全绿；任一 FAIL = 1。

## 4. V1–V7 判据表

| 组 | 判据 | 失败形态 |
| --- | --- | --- |
| V1 | manifest 文件集合恰等于真实目录集合 | 漏登记 / 伪造条目 / 删文件 |
| V2 | 每个非测试条目 `prod_refs` 恰等于真实计算值且非零 | 引用图漂移 / 出现孤儿 |
| V3 | 空集必须 `NO_DELETE_TARGET`；非空集逐项过 `within_ratchet` | 静默留空 / 把活代码或保护对象标为可删 |
| V4 | 双锚有移动端薄壳消费、Host 被 PC 侧栏消费且被 fixture 挂载 | 共享层被删 / 护栏被绕过 |
| V5 | 母规格前缀字节 sha256 相等 + §15.8 含护栏互斥登记 + runbook 保留准入契约 | 追溯改写历史 / 死锁未登记 |
| V6 | 剥离 YAML 注释后 `spec-figures` job 含调用行 | 脚本在仓库里但没人跑 / 注释伪装 |
| V7 | 剔除判据函数体后实现层仍有 6 个关键纯函数 | 判据自匹配恒绿 / 实现被掏空 |

## 5. 三条坑（都踩过）

1. **真值源**：本地并行工作树 951 个源文件里 7 个裸 blob sha 与 master 不同（含 `AgentSideRail.vue`、`AgentSvgCard.vue`）。清单必须由 `gh api` true master 镜像计算，本地验收用 `--root` 指向镜像沙箱；CI 以 checkout 源码为准，脏状态不参与判据。
2. **泛用词假引用**：`types.ts` 的 `types` 裸词匹配会命中大量无关文件。`.ts` 模块一律按路径片段 `['"][^'"]*(/|\.)stem['"]` 匹配，`.vue` 才用标识符匹配。
3. **中文文档不能用字符切片**：只追加前缀长度是**字节数**，用 `spec[30150:]`（字符切片）恒空 ⇒ V5 假红；必须 `raw[:n]` 后 decode。另：注释里的锚点会造成假绿，`strip_comments` / `strip_yaml_comments` 必须先跑。

## 6. 变异与负向自检

- 变异用例 ≥ 10 组：漏登记一项 / 伪造 `prod_refs` / 把活代码放进 `delete_targets` / 把双锚标为可删 / 删掉一个真实组件文件（行为级）/ 母规格 §2 改一个字 / `#` 注释伪装 CI 挂载 / 只加注释不动实现（对照绿）/ 掏空 `within_ratchet` / 把 `NO_DELETE_TARGET` 换成 `ALL_PASS`。
- 恢复后 5 个交付文件裸 blob sha 全等。
- 判据自匹配：断言锚点字面量若写在 `group_v*` 函数自身里，任何变异都不 RED ⇒ `implementation_code()` 剔除判据函数体，V7 只看实现层。

## 7. 删除刀准入契约（继承 ②，本刀不改）

删除 `presentation/` 下 PC 冗余渲染的 PR，**必须**在描述中附**四项**凭据：

1. `VERDICT ALL_PASS`
2. `diff_count=0`
3. 两次采集的 `sha256`（`SHA_A` / `SHA_B`，必须相等）
4. PNG 截图路径（人工目视附件）

并且：**删除刀不得修改 `pc-visual-baseline.json`**，也不得同时修改 fixture / 采集脚本 / verifier。否则 diff 恒空即为伪绿。

⚠️ 本刀实证：由于删除对象与护栏保护对象重叠，上述契约在当前代码形态下**无法同时满足**。删除刀重启前必须先重新界定删除对象并补 `components/canvas/` 侧行为级护栏，见规格 §12 与母规格 §15.8（5）。

## 8. 后继逐处搬的准入条件

与删除域零相交（`presentation/` 内 `isMobileLayout` 命中 0）。逐处搬按
`docs/ops/2026-11-09-is-mobile-layout-scope-runbook.md` §6 四条准入另开刀：
① 逐条分类；② 每搬一处下调 `MAX_ALLOWED`；③ 行为级契约测试 + 变异；④ 不碰冻结边界。

## 9. 诚实边界

- **不宣称** Phase 4 删除动作已完成；**不宣称** §9 原文被修正；**不宣称**护栏被修改或放宽。
- **不宣称** `components/canvas/` 的 PC legacy 分支已处理；**不宣称**新增 required check。
- 本刀零产品代码改动；`deploy.yml` 的 `push.paths` 不含 `docs/` / `scripts/` / `ci.yml` ⇒ 零生产发布。
