# 视频生成链路加固 · 缺口收尾交付报告

> 日期：2026-10-09。范围：视频链路缺口 V1–V6 的收尾、复核、遗留缺口修复与跨层预算收敛。
> 缺口清单来源：`视频生成链路与脚手架诊断报告`（桌面副本）+ 交接对话表；全部结论以
> **`origin/master` 源码逐项复核**为准，不信任交接表。文本线报告见
> `docs/ops/2026-10-09-text-pipeline-hardening-delivery.md`（姊妹篇）。

## 一、缺口终态总表（全部闭环）

| 缺口 | 终态 | 落地 | 取证 |
|---|---|---|---|
| V1 扣费顺序 | ✅ 修复 | #287 | record-first：`studio.service.ts` 先 `generationRecord.create`（@2211）后 `points consume`（@2259） |
| V2 detached 结算 | ✅ 兜底+解耦 | #287 + #305 | reaper `REAP_TYPES` 含 `video`；V2b 解耦后 `LNKPI_VIDEO_REAP_MINUTES` 独立（默认 30） |
| V2b（复核新发现） | ✅ 修复 | #305 | reaper 三组阈值（图片/video/text）；缺陷＝video 与 image 共用 env，为图片调低会误退在生成的视频（**成功却已退款＝漏扣费**） |
| V4 轮询吞错 | ✅ 修复 | #295 | `createPollErrorTracker`（`upstream-retry.ts:141`），maxConsecutive=5，连续错误不再被 `continue` 吞掉 |
| V6 创建零重试 | ✅ 修复 | #301 | 3 个 provider（Apimart/MiniMax/Fal）创建阶段退避重试，5 文件 +249/−28，97 测试；401/402/403 账户错误不重试语义保留 |
| V5 persist 空函数 | ⛔ 按设计不修，结案 | — | 见「四」 |

配套工程改进：

| 项 | 落地 | 内容 |
|---|---|---|
| web 墙钟 | #301 | `DEFAULT_SETTLE_TIMEOUT_MS` 1_320_000 → 1_460_000；锁测试改锁真实不等式 |
| 跨层预算单一来源 | #310（d03996a3） | `packages/shared/src/generationTimeoutBudget.ts`：agent 重试/轮询、web 墙钟、server reaper 三层同一组常量派生，三处不等式锁测试同拦失衡改动 |

## 二、关键事实更正（判读旧材料必读）

1. **`VIDEO_POLL_TIMEOUT_MS = 21min` 是虚构常量**（代码中不存在），曾出现在 web
   墙钟注释/锁测试与 reaper 注释**三处**，是「假绿温床」（墙钟锁测试断言
   `> 1_260_000`，预算超了仍全绿）。三处已随 #301/#305/#310 全部更正。
2. **真实轮询预算**（逐 provider 源码核实，2026-10-09）：
   MiniMax H3 `DEFAULT_MAX_POLL_MS=1_200_000`（20min，全 provider 最大）／
   Apimart 与 Fal `600_000`（10min）／Fal-H3-Max 透传继承 Fal／
   **Agnes 循环制** `maxPollAttempts=120`（约 5s 间隔+30s 单次超时），无 deadline，
   最坏 ≈70min——**不被 web 墙钟覆盖**，属服务端配置问题（见「五」）。
3. **V6 创建重试 139.5s 是病理上界**（3×45s 挂满超时 + 退避 4.5s），只在
   「隧道全死、每次创建都挂满」场景触达；V6 真正要救的 429/503 是毫秒级响应，
   实际只多 ~4.5s。墙钟抬到 1_460_000 是防御余量，不是修 bug。
4. **交接表两处修正**：V6 不是「待做」而是「做完没交付」（代码在
   `fix/video-create-retry` 分支零 CI 记录，无 PR）；PR #298 是「标题写 V6、
   内容是文本线」的错位 PR（与已合并 #292 重复，已关闭）。

## 三、V2b 专项（唯一牵钱的缺口）

- **缺陷链**：reaper 用单一 env `LNKPI_GENERATION_REAP_MINUTES` 管 image+video
  ⇒ 为图片把该 env 调低 ⇒ **正在生成中的视频**被判孤儿并退款 ⇒ 视频随后完成、
  `completeVideo` 状态守卫丢弃迟到成功 ⇒ 「用户拿到视频 + 拿到退款」＝漏扣费，
  方向与原始泄漏相反。
- **修法**：`reapOnce` 分组两组→三组（图片侧 `image/image_edit/image_upscale` /
  video / text），video 独立 env，默认仍 30min（行为不变只解耦，不配置也安全）。
- **阈值依据**：服务端最坏 ≈22.3min（MiniMax H3 20min deadline + V6 创建重试上界
  139.5s），30min 留 ~7.7min 缓冲。
- **TDD**：先红后绿；其间抓掉一个自造假绿——env 覆盖用例首版设 45min（高于默认
  30），旧实现忽略 env 也「收不到」，测试因错误原因通过；改成 8min 才真红。

## 四、结案不修项（含理由，防幽灵 TODO）

- **V5 persist 空函数**（`studio.controller.ts:680`）：刻意 no-op。不修理由：
  ① reaper（#287+#305）已完整覆盖 detached 结算的兜底与退款；② 后端零画布写入
  能力 + `add_node` 两份 applier 是硬约束，实现成本与收益不成比例。**按设计不修，
  勿再立项。**
- **V7 AuthGuard / V8 幂等**：不排期。内网不可达 + 无重复扣费实证。

## 五、遗留观测项（非代码缺口）

1. **Agnes 循环制轮询**：`maxPollAttempts=120` 无 deadline（最坏 ≈70min）。概率
   低（要求所有轮询都挂满 30s 超时，此时视频必然取不到 URL）；且 reaper 提前
   回收退款对用户是更优结果（exactly-once 守卫保证不与 completeVideo 双重结算）。
   收敛属独立事项，**不要用抬前端墙钟掩盖**。
2. **V6 行为取证**：生产上 429/503 的创建重试实际救回几笔，需真实视频流量。
   观测方式：`GenerationRecord.metadata.retryCount` SQL 统计（apps/server 无
   metrics 设施，可观测性走 metadata）。
3. **视频侧 `consumeMeta` generationId**（B2 同族）：视频扣费路径 generationId
   覆盖未在本轮范围内，与图片侧 B2（3 处活跃）同族，待专项。

## 六、清理动作（交付后核对）

- PR #298（错位 PR）关闭；#301、#305、#310 均 squash 合并并部署 Success。
- 分支 `fix/video-create-retry`（03eef27b）：与合并提交 37db6f45 做视频文件
  白名单逐行比对（15 文件零差异）后删除 worktree + 本地/远端分支，零残留。
- 分支 `fix/reaper-video-threshold` / `refactor/timeout-budget-shared` 同规清理。
- 僵尸后台任务：#301 会话遗留的 `pnpm install --offline`（沙箱挂死 4h48m、
  零产出、未污染 worktree/lockfile）已终止。

—— 完 ——
