# 文本生成链路加固 · Task 4/5/6 交付与生产取证报告

> 完成时间：2026-10-09 ｜ 状态：**已全部合并上线 + 部署验证通过 + 生产取证完成**
> 性质：一次性交付收尾报告（归档，无 active 依赖）

## 一、清理动作（交付前/后）

| 项 | 处理 | 说明 |
|---|---|---|
| PR #298 | **已关闭** | head commit 与已合并的 #292 完全相同（squash 后 diff 不归零，留着会二次合并）；标题写成 video V6 属串台 |
| `fix/text-pipeline-hardening-impl` 工作树 | **已重建分支** | 该分支重做了 Task 2/3（已被 #292 覆盖），并让 t5=「t4+t5」、t6=「t4+t5+t6」导致合并冲突。用 `rebase --onto` 重建为 t5=`ad1a0e40`(仅Task5)、t6=`c436bb74`(仅Task6)，force push 后 PR diff 自动收窄 |
| 过时分支 `fix/text-pipeline-hardening`(2517e6ae) | **已删除（本地+远程）** | gh api 权威确认其就是 #292 原分支（merged=true, squash 落地 `f0399337`） |
| 主工作树误伤文档 `2026-10-08-workbuddy-three-layer-memory-design.md` | **已还原** | 与本任务无关的误改，`git checkout --` 还原 |
| spec/plan 的工作区实体化改动 | **已定性为退步并还原** | diff 方向证明是工作区把 master 的正常中文换成 `&#x6309;`/`&#x6392;` 实体+表格对齐（非修复），还原后 `&#x` 残留复查=0 |
| 空临时文件 `_tmp_10659_*` | **已删除** | 0 字节残留 |
| `.worktrees/text-pipeline-hardening` | **已删除** | t6 合并后无用 |

## 二、交付结果（按顺序）

| Task | PR | 合并 commit | 内容 |
|---|---|---|---|
| Task 4 非 vision 重试 + reaper 扩 text | #300 | `e5db2691` | `withUpstreamRetry` 补 45s 有界重试；reaper `REAP_TYPES` 加 `text`；扣费/三处退款均带 `generationId: record.id` |
| Task 5 非 vision 文本占位改抛错 | #302 | `3b2c0a8a` | 删除 `PlaceholderTextProvider`，`createTextProvider` 缺凭证时**抛错**（消除假成功），由 studio 既有 catch 接住落 failed/退款 |
| Task 6 G5 世界状态注入 | #303 | `77e84a13` | 新增 `CreationContext`+`appendCreationContext`；text/vision 的 system 末尾注入选中指代+画布摘要；`run-text-generation` DTO 加 `nodeContext`（`@IsOptional`） |

- **部署**：#303 的 `deploy.yml` run `37869003520` 全绿（Verify API / Layout smoke / Graph Phase A smoke(production) / Deploy web 全 ✓）
- **测试**：agent 侧 45 passed + server 侧 180 passed；变异验证全红有效（删 reaper text、去重试、删 `@IsOptional` 静默剥离、恢复占位等均红）
- **生产健康**（09:58 复核）：`/api/health` = `{"ok":true}`；容器镜像 `lnkpi-api:37db6f45`，`git merge-base --is-ancestor 77e84a13 37db6f45` 确认线上 master 含全部三个 Task

## 三、生产取证（SSH 只读生产库）

- **历史基线**（修复前）：`text` 扣费 `generationId IS NULL` 共 **155 笔**；占位假成功（completed+草案）**20 笔**。
- **部署后（> `1791509321000` = 2026-10-09 09:28 北京）**：全局扣费总数 = **0**、占位新增 = **0**。
  ⇒ 部署后产品静默无流量，**部署后无新占位假成功已直接证明 Task 5 生效**；G3「归零」需等真实 text 流量。

## 四、唯一遗留：G3 归零复查（观测项，非代码）

待真实 text 流量积累后，在生产库跑一次（判据 = HAS 占比应为 100%）：

```sql
SELECT CASE WHEN generationId IS NULL THEN 'NULL' ELSE 'HAS' END AS g, COUNT(*)
FROM PointTransaction
WHERE category='text' AND createdAt > 1791509321000
GROUP BY g;
```

对照基线：修复前 155 笔全 NULL。取数方法：`docker cp lnkpi-api:/app/apps/server/data/lnkpi.db /tmp/lnkpi-probe.db && sqlite3 /tmp/lnkpi-probe.db "<上述SQL>"`。

## 五、spec 六缺口闭环状态

| 缺口 | 状态 | 载体 |
|---|---|---|
| G0 可观测性 | ✅ | #292：`retryCount`/`textPath` 进 metadata |
| G1/G1' 韧性（重试+超时） | ✅ | #292 + #300 |
| G2/G2' 正确性（占位假成功） | ✅ | #292（vision 侧 buildPlaceholder 移除）+ #302 |
| G3/G4 账本+兜底 | ✅ | #292（record-first）+ #300（reaper 扩 text）；归零复查见 §四 |
| G5 质量（世界状态注入） | ✅ | #303 |
