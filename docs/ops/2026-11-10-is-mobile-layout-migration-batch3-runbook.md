# `isMobileLayout` 第三批（D 类第一批）Runbook · 路线 ③ 第 5 刀

> 配套：`docs/superpowers/specs/2026-11-10-is-mobile-layout-migration-batch3-design.md` + `docs/superpowers/plans/2026-11-10-is-mobile-layout-migration-batch3.md`
> 真值基线：`ecf4ee0dd1aa36cec6db79bbad6a630de1ce622f`（2026-11-10 复核：仅 PR #802 纯文档合入前移，SFC/门禁 blob 不变；推送前重新核对）

## 1. 四条准入（#793 runbook §6）

1. **零外部依赖**：本刀只动 1 个 `.vue` 函数体 + 1 个 Python 标准库门禁脚本；不引入依赖。
2. **确定性**：`closePanel` 改写是 `isMobileLayout.value` → `!isDesktopDock.value` 的纯文本等价替换，派生 computed 无副作用；门禁是纯静态计数。
3. **可失败**：变异 M1–M6 能精确 RED（漏取反 / 少替换 / 上限抬回 / 删冻结项 / 注释对照 / 新增读取）。
4. **冻结边界不动**：`defineExpose` 11 项、`getIsMobileLayout`、`sendMessage/handleEvent/canvas_command` 零改写，由 ④ + M4 锁死。

## 2. 变异表（≥6 组，沙箱注入后恢复）

| 组 | 注入 | 期望 |
| --- | --- | --- |
| M1 | closePanel `!isDesktopDock` → `isDesktopDock` | ③ + ⑤ RED |
| M2 | 还原 L1013 为 `isMobileLayout` | ③ RED + V3 RED |
| M3 | `MAX_ALLOWED` 抬回 12 | V3 RED，vitest 绿 |
| M4 | 删 1 个 `defineExpose` 项 | ④ RED |
| M5 | 脚本注释写 `isMobileLayout` | 对照绿（strip_comments） |
| M6 | 新增 1 处 `isMobileLayout.value` | V3 RED |

恢复后核 3 目标文件裸 blob sha 全等；`MUTATIONS 6/6` + `ALL_LOCAL_MATCH True`。

## 3. 生产复测（web-only，apps/web/** 触发）

- `gh api` 查 `deploy.yml` runs：本次 merge sha 的 run `success`，`Deploy web to CVM` success / `Build API on CVM` skipped。
- SSH `deploy-cvm` 五证：`/api/health` `{"ok":true}`、web 200、三个桌面锚点各 1、setup 段 `{isMobileLayout:l}=dr(),u=R(()=>!l.value)` 派生结构在；⭐ 不要求 `isDesktopDock` 字面量（mangle）。
- 核对零回退并行改动（SFC 其余 11 处读取点 blob 全等）。

## 4. 回滚

- 本刀是纯等价改写 + 门禁收紧；若生产五证任一失败，revert merge commit 触发反向 web-only 发布即可；门禁回退需同步 revert `MAX_ALLOWED` 11→12 双处。
- 不回退并行窗口已发布内容。
