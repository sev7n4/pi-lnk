# S1-1 定时探活对账器 —— 分项规格

状态：待评审（2026-10-09）
上级规格：`2026-10-09-model-platform-hardening-design.md`（批次 B1，服务目标 G3 自动化 + G1 长期成立）

## 1. 目标

把 S0-3 的手工对账升级为服务内定时任务：周期性实测各上游 `/v1/models`，与目录 diff 后自动回写镜像灰显标记并产生告警信号，使「可选集 ⊆ 探活通过集」成为系统不变量。

## 2. 现状摘录（真实锚点）

- 复用：`packages/shared/src/upstreamReconciliation.ts` 的 `diffCatalogAgainstUpstream()`（S0-3 交付，纯函数+单测齐全）。
- 定时任务先例：`apps/server/src/studio/generation-reaper.service.ts`——Nest `@Interval`/可配置 env 阈值的既有模式（图片/视频/text 三组 reaper），本分项沿用同款调度形态。
- 镜像写入：`ProviderChannel('platform').models` 由 `ensurePlatformChannel`（`provider.service.ts`）播种、#306 `model-catalog-sync.ts` bootstrap 对齐；渠道「平台·只读」，用户不可写（`updateChannel` 对 platform 抛 Forbidden）。
- 告警通路现状：**无**（无 metrics/无通知设施）——首版告警 = 结构化日志 + 对账结果落库供 S1-2 端点暴露。

## 3. 改动设计

1. **数据模型**：`ProviderChannel.models` 的条目结构 `[{name, capability}]` 扩展为 `[{name, capability, availability}]`，`availability: 'available' | 'unavailable' | 'unknown'`（缺省 `unknown`，兼容旧数据零迁移——JSON 列，旧条目读出后按 unknown 处理）。
   - ⚠️ 写入方同步点：`ensurePlatformChannel`、`model-catalog-sync`（syncAdded/syncRemoved 两路径）写入时保留/复位 availability；探活器是唯一置 `unavailable` 的写入方。
2. **探活服务** `apps/server/src/provider/upstream-probe.service.ts`：
   - `@Interval` 每 6h（env `LNKPI_UPSTREAM_PROBE_INTERVAL_MINUTES`，默认 360；`0`=禁用，测试用低于默认值——env 覆盖类测试必须取低于默认值，防假绿）；
   - 每 6h 连续失败 ≥3 次（连续计数落内存，重启重置）才置 `unavailable`；1-2 次失败只记日志（防网络抖动误灰显，总体规格 Review Focus 第 2 行）；
   - 恢复（探活通过且当前 unavailable）→ 置回 `available` + 日志「模型恢复」；
   - 探活目标 = 路由表（首版沿用 S0-3 脚本内硬编码表，S2-2 后改为读路由表）；
   - **只读 `/v1/models`**，任何情况下不发生成请求。
3. **告警信号**：探测结果整帧写入新表 `UpstreamProbeRun {id, ranAt, upstream, httpStatus, modelCount, ghosts[], missing[], error?}`；最近一次 run 存在 ghost/unavailable 变化时打结构化日志 `[MPH][probe] ...`（运维可 grep）。推送渠道（邮件/IM）**明确不在本分项**——B1 验收 = 落库+日志，推送待产品决策后另立分项。
4. **对账端点**：`GET /api/admin/upstream-probe/latest`（AuthGuard admin）返回最近 run，供 S1-3/S1-2 与运维 curl 检查。

## 4. 验收判据（可断言）

| # | 判据 | 断言方式 |
|---|---|---|
| A1 | 纯逻辑：`planAvailabilityWrites(prevModels, diffResult, {consecutiveFailures})` 是纯函数——幽灵→unavailable、恢复→available、抖动(失败<3)→不变 | 单测（新文件） |
| A2 | 调度：interval env=0 时不注册定时器；env<默认值生效（测试设 1 分钟） | 单测（fake timers） |
| A3 | 抖动防护：mock 上游连续 2 次 500 → availability 不变；第 3 次 → unavailable + `UpstreamProbeRun` 落库 | 单测 + 内存 prisma 桩 |
| A4 | 恢复路径：unavailable 模型后续探活通过 → available | 单测 |
| A5 | 兼容：旧格式 `[{name, capability}]` 条目读取后 availability='unknown'，探活器可正常升级写入 | 单测（fixture 旧 JSON） |
| A6 | 端点：无鉴权 401、admin 鉴权 200 返回最近 run | 集成测试 |
| A7 | 生产复测：部署后手动触发/等首个周期，SQL 查 `UpstreamProbeRun` 有记录；`ProviderChannel.models` 中 deepseek-v4（若 S0-1 已下架则该断言改为对任一临时测试条目） | SQL + curl |

## 5. 测试要点

- 纯函数优先：availability 写入计划、抖动计数全部纯函数化（放 `upstream-probe-logic.ts`），service 壳只做 IO——沿用 reaper 的测试风格。
- prisma 桩必须忠实执行 where（总体规格 §5 对账纪律）；探活 fetch 用注入式 fetch 替身，替身响应形态抄真实 `/v1/models`（含 `owned_by`/乱序）。

## 6. 涉及文件

- Create: `apps/server/src/provider/upstream-probe.service.ts`、`upstream-probe-logic.ts`、各自 test、`UpstreamProbeRun` prisma model（迁移）
- Modify: `provider.service.ts`（ensurePlatformChannel 写 availability）、`model-catalog-sync.ts`（保留 availability 语义）、prisma schema
- 复用: `packages/shared/src/upstreamReconciliation.ts`

## 7. 依赖与风险

- 依赖 S0-3（纯函数）。prisma 迁移走容器 entrypoint 自动 `migrate deploy`（既有机制）。
- 风险=探活器自身故障拖垮 bootstrap：探活器必须 try/catch 全包裹、绝不抛出阻塞启动（reaper 同款纪律）；回滚=env 置 0 禁用，镜像回纯目录对齐。
