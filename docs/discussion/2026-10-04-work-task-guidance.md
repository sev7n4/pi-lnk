# 工作任务指导（2026-10-04 08:45 快照）

> 依据：实测仓库状态（`git worktree list` / `gh pr list` / python 直读复核），非凭印象。
> 生成时快照见文末；执行前请重跑核实项（并行窗口会改状态）。

## 一、先清阻塞（3 个，都是「已投入但卡住」）

按**阻塞严重度**排序，不是按重要性 —— 这三项都在浪费已完成的投入。

###阻塞 A ⭐：`docs/agents-md-hardening` 5 个 commit 从未推送 ❗最高优先

| 项 | 事实 |
|---|---|
| worktree | `.worktrees/agents-md-hardening`，`status --porcelain` **空**（工作干净，成果完好） |
| commit | **ahead 5**（本地已提交，远程 0） |
| 远程分支 | `gh api .../branches/docs/agents-md-hardening` → **404 Branch not found** |
| PR | `gh pr list --head docs/agents-md-hardening --state all` → **空**（从未开过） |

5 个 commit 内容（按顺序）：
```
8bd97c5 docs(agents): 纠正 CI 触发面描述错误 + 消除计数漂移
501d148 docs(agents): 新增系统地图与角色边界两节
2ea3793 docs(agents): 新增变更影响面矩阵
973bc51 docs(agents): 新增完成定义（DoD）与 PR 规范
1486eb1 docs(agents): 登记 Agent 工程规范 + 评审报告入库
```

⚠️ 讽刺点：第 1 个 commit 叫「**纠正 CI 触发面描述错误**」—— 而这批改动自己就卡在没推送上。
**这批是规范类资产（DoD / PR 规范 / 影响面矩阵），是后续所有 PR 的判据，值得优先救。**

**动作**（约 6 步）：
```bash
cd /Users/4seven/workspace/pi-lnk/.worktrees/agents-md-hardening
git fetch origin && git rebase origin/master   # 5 commit 期间 master 已前进
git push -u origin docs/agents-md-hardening
gh pr create --title "docs(agents): Agent 工程规范 + DoD + 影响面矩阵" --body-file <file>
gh pr checks <n>          # 盯到全绿（注意：纯 .md 也触发，别当免检）
gh pr merge <n> --squash
# 收尾：worktree → 本地分支 → 远程分支
```

### 阻塞 B：#145 在等最后一个 CI job

- `mergeable=MERGEABLE` 但 `mergeStateStatus=BLOCKED`
- `Build monorepo` **pass** 4m22s、`Verify spec figures` **pass** 22s、`Build API Docker image` **pending**
- 动作：等它跑完 → 全绿即`gh pr merge 145 --squash`

### 阻塞 C：两个空 worktree 白占分支

`feat/system-prompt-golden`（`.worktrees/system-prompt-golden`）与
`feat/eval-harness-adapter`（`.worktrees/w1b-eval-harness`）：

- 都停在 `846a019`（= master，**无任何 ahead commit**）
- 两者**都没有 PR**（`gh pr list --head` 空）
- **磁盘各占 50M+**（含 node_modules）

**动作**：确认这两个活儿还要不要做。
- 还要做 → 直接在原worktree 里接着干（省一次重建）
- 不做了 → 体检 `status --porcelain` 为空后按序清理：`git worktree remove --force <绝对路径>` → `git worktree prune` → `rm -rf` 残留目录 → `git branch -D` → `git push origin --delete`

## 二、然后推进真正的新活（按优先级）

### P1 ⭐ T1：断线重连换vendor 快照机制（**唯一有已知正确性缺陷的**）

昨天复核登记的欠账，**今天仍未实现**（实测 `session-manager.ts`）：
- `entry.buffer` 4 处、`afterSeq` 6 处、`BUFFER_LIMIT` 2 处、**`watch`/`resnapshot`/`LaneSnapshot` 各 0 处**

**为什么排第一**：这不是「不够优雅」，是 `session-manager.ts` 注释**自认的缺陷** ——
buffer 溢出后 `shift()` 丢事件，重连 best-effort，**状态可能永久错位**。

**收益**：修正确性问题 + 白拿 `watchSession` / `config_update` 等目前收不到的事件。
**成本**：动事件主链路，须先补测试基线。
**可抄的权威实现**：`vendor/earendil-works/pi/packages/coding-agent/src/experimental/services/transcript-provider.ts`（128 行完整跨进程消费者）—— 照抄三点：
① 先发全量快照再接增量 ② `reduceLaneSnapshot(...) === "rebase"` 触发 `resnapshot` ③ `toLaneWatchEvent` 过滤进程内噪声事件。

⚠️ 别把 `recovery` 当重连：`drive/recovery.ts` 的 `recovery: true` 是**崩溃恢复**。

**建议拆法**：先只做「snapshot + 重连」最小闭环（`lane.watch()` 拿快照替掉 buffer 累积），
归约/`rebase` 留第二个 commit。**别一次改完事件主链路**。

### P2 T2：工具集运行时增删

**实测确认仍未做**：`setTools`/`setActiveTools`/`getTools` 全仓 0 真实调用
（`tiering.ts` 里的 `setActiveTools` 只出现在**注释**中，原文是「与官方 wrapper 的 setActiveTools 差集通道等价」）。

**收益**：中途装/卸 skill 不必重建会话。而`skills/` 是活资产（ADR-0009 记 PR #29 脱节教训）。
**成本**：低，纯增量。落在 skill 装配处（`session-manager.ts:1533`）。

### P3：`feat/metrics-observability` 有未跟踪的活儿

- worktree 脏：`?? services/pi-runtime/src/tool-error-class.ts` + `.test.ts`（**未跟踪 = 未提交**）
- 4 个 commit 在本地，`ahead 4, behind 1`

⚠️ **风险点**：未跟踪文件是**唯一副本**，一旦 `worktree remove` 就没了。
**动作**：先 `git add` 提交或 `cp` 到仓外备份，再决定 push / 合并 / 放弃。

### P4：`docs/media-generation-pipeline` ahead 1 behind 5

单 commit（音视频生成链路审计 + 实施规格清单），落后 master 5 个 → 需 rebase。
纯文档，价值中等。

## 三、不建议现在动的

- ❌ **再开新的 vendor 能力盘点** —— 昨天已复核完，`DEPENDENCIES.md` 已登记 T1/T2/层次纠正。
  `telemetry`/`evals`/`session-backends` 三项还没逐个确认，但那是**独立一轮调研**，
  不该和清阻塞混在一起。
- ❌ **`docs/prompt-engineering-spec` 的未跟踪文件**（`docs/superpowers/plans/2026-10-04-prompt-engineering.md`）
  已被 #145 覆盖范围，同一个 PR 里处理，别单开。
- ❌ **vendor 升级** —— 0.85.1 无 MCP client 是上游没做，升级解决不了；升级本身是独立高风险动作。

## 四、执行顺序（一句话版）

```
阻塞A(agents-md-hardening 推送+PR) → 阻塞B(#145 等 CI 合并) → 阻塞C(清两个空 worktree)
   ↓
P3(补交 tool-error-class) → P1(T1 断线重连，分两commit) → P2(T2 工具动态增删)
```

**每项都走七步流程**（`branch-first-dev-workflow` skill），别直接提交 master。

## 五、本快照的核实命令（状态会漂，执行前重跑）

```bash
git worktree list                                    # worktree 与分支占用
for d in .worktrees/*/; do                          # 脏状态 + 未推 commit
  echo "== $d"; git -C $d status --porcelain | head -5
  git -C $d log --oneline origin/master..HEAD | head -6
done
gh pr list --state open --json number,title,mergeStateStatus
gh pr list --state all --head <branch> --json number,state   # 判「是否开过 PR」
gh api repos/sev7n4/pi-lnk/branches/<branch> --jq .name      # 判「远程是否有分支」
```

⚠️ **别用 `grep` / `git grep` 判「某能力有没有用」** —— 本环境有假阴性（PATH 首位 shim）。
用 python 直读。已写入 `services/pi-runtime/DEPENDENCIES.md` 第四节。

⚠️ **纯 `.md` 改动照样触发 CI**（实测：`Verify spec figures` + `Build monorepo` + `Build API Docker image`）。
别拿 `ci.yml` 的 `paths-ignore: **/*.md` 当免检理由。
