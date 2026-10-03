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

## 关联

- PR：#128（校正 tag 描述）
- workflow：`.github/workflows/runtime-deploy.yml`（tag 为手填入参）
- 相关：ADR-0003（Registry 自检必须经 ssh 到 CVM，见 PR #118）
