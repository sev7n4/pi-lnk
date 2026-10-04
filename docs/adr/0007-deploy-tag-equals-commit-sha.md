# ADR-0007: 镜像 tag = master commit 短 sha，停用语义版号

| 字段 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-10-03 |
| 决策者 | 项目发起人 |

## 背景

pi-runtime 镜像发布需要一个 tag。原先用语义版号（`0.0.1` ~ `0.0.41`）。

问题：

1. **对不上账**：看到线上跑 `0.0.37`，无法反查"这是哪个 PR、哪次提交"。
   曾经 registry 里41 个数字版号，需要人工维护一张映射表
2. **并行冲突**：多agent / 多分支各自发版时，语义版号会被抢 —— 都要抢下一个号
3. **workflow 描述过时**：`runtime-deploy.yml` 的 input description 长期写着
   "如 0.0.21；必须是递增新值"，而 tag 实际是**纯手填入参，内部不做任何计算**，
   也**不会自动递增**。照着描述推断会得出错误结论

## 考虑过的方案

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| 语义版号递增 | 直观 | 需人工维护映射、并行会抢号、描述易过时 | ❌ |
| **commit 短 sha**（选中） | 与 merge commit 同 sha，天然可对账；并行各用各的 | 不如版本号"好看" | ✅ |
| 时间戳 | 天然递增 | 仍对不上账 | ❌ |

## 决定

1. **tag = master 的 commit 短 sha**（`git rev-parse origin/master | cut -c1-9`），
   与 merge commit 同值⇒ 天然可对账。
2. **停用语义版号**。registry 里 `0.0.1~0.0.41` 共 41 个数字版号属**历史遗留**，
   不再新增（已在 PR #128 校正 workflow 描述）。
3. **preflight 校验 tag 未被 registry 占用** ⇒ **必须先合并拿到新 SHA**，
   而合并会立刻触发 `deploy.yml` ⇒ 顺序无法规避，**必须先验证双向兼容**。
4. **回滚**走 `skip_build=true` + 已存在的 tag，不需要新号。

## 后果

**正面**
- 线上跑什么 sha 一目了然，不用查映射表
- 并行发版各用各的 sha，互不抢号
- 回滚只需填旧 sha

**负面 / 代价** ❗
- 不再能一眼看出"这是第几个版本"
- **tag 仍需手填**（`runtime-deploy.yml` 不会自动算），填错就部署到错误的 sha
- `0.0.x` 历史 tag 与 sha tag 并存，看registry 列表时容易混淆

**将来要注意**
- 部署前确认填的是**当前 master 的 sha**，且该 sha 对应的 CI 已跑完
- ⚠️ **推 master 会立刻触发 deploy.yml** —— 若还没准备好部署，要先确认是不是想触发
- 别照 workflow 的 description 推断递增逻辑（那句已过时）

## 2026-10-04 复核：自动化的立项理由已被数据证伪

本 ADR 第 3 条曾写「合并会立刻触发 deploy.yml ⇒ **顺序无法规避**」，
据此有人提出给本 workflow 加 `push` 触发做自动化。复核后**结论是不改自动化**：

| 观测 | 值 |
|---|---|
| 9-30 以来改构建输入（`services/pi-runtime`/`skills`/`vendor`）的提交 | **32** 次 |
| 同期 `runtime-deploy.yml` 运行 | **34** 次 |
| 线上 `/healthz` version vs `master` HEAD | **完全一致，零积压** |
| 触发方式 | 纯 `workflow_dispatch`（抽样全部如此） |

⇒ 人工闸门的实际遵守率约 100%，「解决遗忘部署」解决的是一个**已不存在的问题**。

**为什么仍不加 push 触发**（决策记录）：

1. `charts/pi-lnk-runtime/values.yaml` 的 `replicaCount: 1` + k3s **单节点** ⇒
   自动上线一旦失败，**整个 agent 链路直接断**，无高可用兜底。
2. 根盘已用 **82%**（40G 用 33G）⇒ 构建失败概率不可忽略。
3. 真正的风险不是「忘部署」，而是**两条流水线独立部署同一产品的两个组件、完成顺序无约束**。
   已用共用 concurrency group `lnkpi-release` 消除错配窗口，**不需要用自动化解决**。
4. 顺序约束落到了 `concurrency`，输入校验落到了 `Preflight`（`behind_by == 0`），
   **闸门的强度与正确性被补强，触发方式保持不变**。

⚠️ **本 ADR 遗留的「tag 仍需手填」已被 Preflight 补强**（2026-10-04）：
原先只校验「tag 未被 registry 占用」，挡不住**打错字的不存在 sha**；
现增加「tag 必须是 master 祖先提交」校验。
⚠️ 判据必须是 `compare(X...master).behind_by == 0`，**不能用 `.status`** ——
`status` 是站在 master 视角描述 X，master 更新时旧提交会返回 `ahead`
（实测 `2eb19c4` → `status=ahead` 但 `behind_by=0`，是合法祖先），
按 `status in (identical|behind)` 放行会误杀绝大多数正常旧提交。

## 2026-10-04 补强：人工闸门从「等于零」变成「有审批记录」

本 ADR 第 3 条把「人工闸门」当作顺序保险，但复核发现它**当时强度等于零**：

| environment | protection_rules | 含义 |
|---|---|---|
| `production` | `[]` | 无任何保护规则，dispatch 这个动作本身就是全部闸门 |
| `production-runtime` | `required_reviewers: [sev7n4]` | 上线前必须人工批准，留审计记录 |

`runtime-deploy.yml` 的 job 已从 `environment: production` 切到 **`production-runtime`**。

⚠️ **为什么必须拆成两个 environment**（而不是直接给 `production` 加审批）：
`deploy.yml` 的 **3 个 job**（`deploy-api` / `deploy-web` / `recover-only`）也都绑 `production`。
共用会让**pi-lnk 的 api/web 自动部署一起变成手动卡点** —— 那是纯负担，不是闸门。
拆分后职责清晰：

- `production-runtime`（有闸门）= **pi-runtime 上线**，需要人批准
- `production`（无闸门）= **api/web 部署**，保持合并即自动

## 关联

- PR：#128（校正 tag 描述）、#145（并发组 + Preflight 校验）、#149（独立 environment + 审批闸门）
- workflow：`.github/workflows/runtime-deploy.yml`（tag 为手填入参 + 祖先校验 + `production-runtime` 闸门）
- 相关：ADR-0003（Registry 自检必须经 ssh 到 CVM，见 PR #118）
