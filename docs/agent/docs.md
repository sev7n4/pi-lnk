# 文档管理规范

去哪写 · 硬约束 · 归档 vs 删除 · 提交前自查。

> 属于 [`AGENTS.md`](../../AGENTS.md) 规范体系的一部分。

## 文档管理规范

### 去哪写

| 文档类型 | 位置 | 命名 |
|---|---|---|
| 实现 spec（设计方案） | `docs/superpowers/specs/` | `YYYY-MM-DD-<主题>-design.md` |
| 实施计划 | `docs/superpowers/plans/` | `YYYY-MM-DD-<主题>.md` |
| 方向 / 决策来源 | `docs/discussion/` | `YYYY-MM-DD-<主题>-discussion.md` |
| 部署运维 | `docs/ops/` | — |
| 对外契约 | `docs/workflow/` | ⚠️ 活跃资产，改动前先确认是否影响外部 Agent |
| 提示词规则 | `prompt-registry/rules/` | `<主题>.md` / `<主题>.tail.md`，改完要更新 `MANIFEST.yaml` |

各目录性质与删除判据见 `docs/README.md`。

### 硬约束

- **spec 放 `superpowers/specs/`，plan 放 `superpowers/plans/`** —— 别混。spec 是"设计为什么"，
  plan是"怎么做"，两者生命周期不同。
- **新增文档必须在 `docs/README.md` 登记**（哪个目录、是什么、为什么放这里），
  否则半年后没人知道它是死是活。
- **删除文档前必查引用**，且区分引用性质：

```bash
git grep -l "<文件名或路径>" -- '*.md'      # ⚠️ 用 git grep，别用 grep -r（会超时 SIGTERM）
git grep -l "<路径>" -- apps packages services charts deploy   # 顺带确认代码没引用
```

| 引用性质 | 处置 |
|---|---|
| 代码 import / 对外契约 | **绝对不能删** |
| 活跃文档里的链接 | 删目标，同时把链接改成指向新位置或标注"已移除" |
| 历史 plan/spec 里的"创建/修改某文件"任务描述、模板参考 | **刻意不改** —— 篡改历史记录比留死链更糟。在 `docs/README.md` 记断链清单 + 给出取回方法（`git show <commit>:<path>`） |

### 归档 vs 删除

- **已完成的文档不删，移不改** —— 历史决策有追溯价值（"当初为什么这么定"）。
  真要清理，优先**归档**（挪进 `docs/adr/` 下的 ADR 快照，或集中到 `docs/superpowers/INDEX.md` 标注 frozen）而非删除。
- **删除的判据是"内容已完成使命且无追溯价值"**，典型三类：① 对应功能已实现的设计稿
  （先核实实现确实在代码里）；② 一次性报告/诊断；③ 已被后续决策取代且被明确标注 superseded。
- **有 active 依赖的一律不删**：代码引用、对外接口、被现存文档当spec 依赖的。

### 提交前自查

- [ ] 新增/删除的文档在 `docs/README.md` 登记了
- [ ] 删掉的文档查过引用，且性质判断过了
- [ ] 纯文档 PR 确认了 CI/部署是否真的需要触发（看 workflow 的 paths 过滤，别被"零 workflow"吓到）
- [ ] 分支/worktree 已按上面的顺序清理干净
