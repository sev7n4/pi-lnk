# `isMobileLayout` 读取域棘轮门禁 · 运行手册

> 规格：`docs/superpowers/specs/2026-11-09-is-mobile-layout-scope-gate-design.md`（含 §14 实现期精算修正）
> 计划：`docs/superpowers/plans/2026-11-09-is-mobile-layout-scope-gate.md`
> 脚本：`scripts/verify-is-mobile-layout-scope.py`
> CI 挂载：`.github/workflows/ci.yml` 的既有 `spec-figures` job，**不新建 job**

## 1. 这个门禁锁什么

| 区域 | 判据 | 当前值 |
| --- | --- | --- |
| `apps/web/src/components/agent/AgentSideRail.vue`（Shell） | 剥离注释后有效读取点 `<= 21`，只降不升 | 21 |
| `apps/web/src/components/agent/presentation/**`（Content） | 零读取 | 0 |
| `packages/shared/**` | 零读取 | 0 |
| `useAgentMobileLayout()` 定义点 | 唯一 | 1 |

**上限 21 的来源**：母规格 §15.4 与早期记录里的「22 处」是 grep 的**行数**，其中 `AgentSideRail.vue` 第 830 行是文档注释（`* immediate：isMobileLayout 初值…`）。门禁按判据 C 一律先 `strip_comments` ⇒ 真实有效读取点是 **21**。若沿用 22 作上限，会留 1 的余量，允许「新增一处读取」而不 RED —— 实现期 M2 伪变异已实证（见规格 §14）。

## 2. 分组判据

| 组 | 判据 | 失败含义 |
| --- | --- | --- |
| V1 | 只 import Python 标准库 | 引入外部依赖，违反门禁准入三问 |
| V2 | Content / shared 零命中 | 布局断点被下沉到内容层 |
| V3 | Shell `within_ratchet(count, 21)` 且方向判据在位 | 读取点新增或棘轮方向被改写 |
| V4 | `useAgentMobileLayout()` 定义点 = 1 | 布局断点来源分裂 |
| V5 | `spec-figures` job 有调用行，且已剥离 YAML 注释 | 脚本写了没挂 / 注释伪装挂载 |
| V6 | `strip_comments` + 统一计数入口 + HTML 注释剥离 | 注释假绿 / 单文件假绿 |

判据自匹配防护：所有「源码含某锚点」的断言只看 `implementation_code()`（剔除 `group_v*` 判据函数体后的实现层），否则锚点字面量写在判据自身里会恒绿。棘轮方向抽成独立纯函数 `within_ratchet(count, limit)` 供 V3 单独检查。

## 3. 运行

```bash
python3 scripts/verify-is-mobile-layout-scope.py            # 默认扫仓库根
python3 scripts/verify-is-mobile-layout-scope.py --json     # 结构化输出
python3 scripts/verify-is-mobile-layout-scope.py --only V3  # 只跑一组
python3 scripts/verify-is-mobile-layout-scope.py --root /tmp/pc-scope-sandbox  # 沙箱变异
```

- 全绿 ⇒ `VERDICT ALL_PASS`、`exit 0`；任一失败 ⇒ `VERDICT HAS_FAILURE V…`、`exit 1`。
- 无必填 env、不连网络、不解析 Vue、不起浏览器 ⇒ 满足门禁准入三问（零外部依赖 / 确定性 / 可失败）。
- CI 中由 `Verify spec figures` job 的 `Verify isMobileLayout scope (Shell-only ratchet)` 步骤执行，PR 的 CI 日志即自举证明。

## 4. 三条坑

1. **注释假绿**：把锚点只写在 `//`、`/* */`、`<!-- -->` 或 YAML `#` 注释里，若判据不剥离就会误判。本门禁四层注释全剥离；M5（挂载只写进 YAML 注释）与 M6（Content 只写注释）分别验证「不假绿」与「不误报」。
2. **单文件假绿**：只扫 `AgentSideRail.vue` 会漏掉 Content 层新增读取 ⇒ V2 用 `rglob` 全目录递归扫 `.vue/.ts/.tsx/.js/.mjs`。
3. **改 `package.json` 触发生产发布**：`deploy.yml` 的 `push.paths` 含 `package.json`，「只加一个 CI script」也会触发一次生产发布。本门禁**直接写 `python3 scripts/...` 到既有 job**，不改 `package.json`、不改 `deploy.yml`；`deploy.yml` 的 paths 不含 `ci.yml` ⇒ 本刀合并零生产发布。

## 5. 变异测试

沙箱树 `/tmp/pc-scope-sandbox` 由 `gh api` 从 master 拉真实 `AgentSideRail.vue` 与 `ci.yml` 构建，行为级变异不污染产品代码。7 组：

| 组 | 变异 | 期望 |
| --- | --- | --- |
| M1 | Content 注入一处读取 | `V2` RED |
| M2 | Shell 多一处读取 | `V3` RED |
| M3 | 删 CI 挂载 | `V5` RED |
| M4 | 棘轮方向反转 | `V3` RED |
| M5 | 挂载只写进 YAML 注释 | `V5` RED |
| M6 | Content 只写进注释 | 全绿（不误报） |
| M7 | 无关注释伪变异对照 | 全绿 |

每条恢复后 5 个目标文件裸 blob sha 全等。**M2 在 `MAX_ALLOWED=22` 时曾不 RED**（余量吞掉注入），收紧到 21 后精确 RED —— 这是「变异不 RED 先怀疑伪变异」的实证，不要把它当成判据通过。

## 6. 后继逐处搬的准入条件

本刀**只立门禁，不搬读取**。逐处搬须另开刀并满足：

1. 先把 22 行 / 21 点按「Shell 合理读取 / Content 禁止读取」逐条分类，写进规格；
2. 每搬一处，上限随之下降（改 `MAX_ALLOWED`），门禁自动收紧，禁止一次性把上限抬高；
3. 配行为级契约测试 + 变异验证，证明 PC / 移动两端渲染形态未变；
4. 不碰 `sendMessage` / `handleEvent` / `canvas_command` / `defineExpose` 11 项冻结边界；不再按功能簇拆。

## 7. 诚实边界

- **不宣称** 22 行 / 21 点读取已被搬迁；**不宣称**新建 required check（本门禁挂在既有 job 内）。
- **不宣称**覆盖像素或运行时形态；本门禁只约束源码读取域。
- CI 以 checkout 的源码为准，本地工作树脏状态不参与判据。
