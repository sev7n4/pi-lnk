# SP-F · 连线根治闭环：移动端边可见性 + connect_nodes 端点校验 + 派发可观测

> 2026-10-28 · 实现 spec（设计方案）。上游来源：
> [`docs/discussion/2026-10-28-canvas-agent-architecture-review-discussion.md`](../../discussion/2026-10-28-canvas-agent-architecture-review-discussion.md)
> §6.0 Q1 / §6 P0(O1,O2) / §6 P1c，经 §9 评审拍板。本 spec 只圈定本轮闭环范围，
> P0 前端 beacon / P1a / P1b / P2 / P3 不在本轮（见 §4 不做）。

## 1. 问题与目标

移动端 agent `connect_nodes` 产出的连线用户看不见（个案取证：生产库 13 条边全部落库、
端点全有效 ⇒ 数据链路完好，症状 = 渲染层视觉不可见）。本轮目标：

1. **看得见**（Q1）：移动端布局下连线可见性提升到可辨认下限（不依赖用户手调设置）；
2. **不再产生坏边**（P1c）：`connect_nodes` 端点 fail-closed 校验，悬空边在服务端被拒，
   工具回执带 `{applied, duplicates, rejected}` 让模型自纠错；
3. **丢弃可观测**（O1/O2 服务端部分）：`extractCanvasActions` 三类静默 continue 与
   stage TTL 过期清空补结构化日志——「Nest 已改、画布不变」类问题可用日志定位。

## 2. 判据（验收）

| # | 判据 | 验证方式 |
|---|---|---|
| V-1 | 移动端（≤767px 视口）边默认 `--lnk-canvas-edge-strong` 色 + 2px；桌面默认值不变；用户显式 `edgeColor`/`edgeWidth` 设置在移动端仍然生效 | 契约测试 + 真机走查 |
| V-2 | `--lnk-canvas-edge-strong` 在 design-tokens.css 深色/浅色块同名成对 | design-token.test.ts + 契约测试 |
| V-3 | ~~悬空端点/自环/重复边三类输入~~ ⚠️ **实施时修订（Task 1 Ruling）**：master(fe80bef6) 已合入 SP-D `validateEdgeAdditions`（ADR-0014 拍板：端点/自环/成环**整批 fail-closed**、duplicate 幂等跳过）——原「部分成功 + rejected 回执」翻案被否。缩范围判据：成功回执带 `applied` / `duplicates` 计数（增量字段，向后兼容，`details.actions` 形状不变） | service 单测（行为级） |
| V-4 | ~~rejected 日志~~ 缩范围：duplicate 幂等跳过数随回执可达模型；硬拒已有 BadRequestException 消息明细（SP-D 实装），不重复加日志 | 单测断言 |
| V-5 | `extractCanvasActions`：zod_drop / whitelist_drop / isError-with-actions 三类丢弃各有结构化 warn；正常路径零新增日志 | pi-events 单测 |
| V-6 | stage TTL 过期清空有 warn（sessionId + 条数） | 单测断言 |
| V-7 | 既有测试全绿：`agent-canvas-tools.service.test.ts`、`pi-events.test.ts`、design-token/theme-usage/text-token-guard/dead-styles、`vue-tsc -b` | 本地跑 |

## 3. 设计决定

### 3.1 Q1：为什么走「移动端自有 CSS 文件 + 新 L2 令牌」而非改 `--neo-edge` 或页面分支

- **不改 `--neo-edge` 值**：会影响桌面默认（桌面不在本轮范围）；
- **不在 `CanvasPage.vue` 加 `isMobileLayout` 分支**：AGENTS.md 移动端呈现规则 1
  （页面级组件不再新增该分支）；
- **不用 767px media query 补丁进 PC 组件**：同上规则 2。落点 =
  `components/mobile/` 下自有样式文件（规则 4 的 `*Mobile*` 命名），由壳层
  `MobileCanvasShell.vue` 导入（规则 1：移动端编排唯一所有者是壳层）；
- **不新增 rgba 字面量进组件样式**：设计体系硬约束 1 ⇒ 新色值必须进令牌 SSOT
  `design-tokens.css` 作 L2 成对变量，组件只消费；
- **覆盖面判据**（评审 Important#1/#2 修订后）：`.vue-flow
  .vue-flow__edge:not(:hover):not(.selected):not(.neo-edge-upstream):not(.neo-edge-downstream)
  .vue-flow__edge-path`（0,7,0）压过基线（0,2,0）且**显式让出**状态高亮态（selected /
  upstream / downstream / hover 同级竞争被 :not 链排除，脱离 import 顺序依赖）；
  color 的 `--canvas-edge-color` 与 width 的 `--canvas-edge-width` 均为第一候选
  （后者由 CanvasPage 改为**条件注入**：仅用户改过 `DEFAULT_EDGE_WIDTH` 才写变量），
  用户显式设置优先级不变。
- 命名 `--lnk-canvas-edge-strong`（`--lnk-*` 前缀，禁 `--neo-*` 再生长）。

### 3.2 P1c：为什么「部分成功 + 回执」而非整批抛错

- 整批抛错会把 N-1 条本已有效的边陪葬（F2 家族）；
- 回执经 `resultWithActions` 的 `content.text`（`JSON.stringify({ok, data})`）自动到达模型，
  **runtime 零改动**；`details.actions` 只取 `data.actions`，新增字段对 SSE 派发零影响；
- rejected reason 用可行动短语（`source_not_found` / `target_not_found` / `self_loop`），
  明细限全部返回但**日志摘要截断 500 字符**防日志膨胀；
- 重复边维持现状语义（静默跳过）但**计数进回执**（`duplicates`），模型可感知。

### 3.3 O1/O2：为什么是结构化日志而非 Prometheus 计数器

Nest 侧无 prom-client/指标端点（全仓 grep 零命中）；引入指标基建是独立工作量，
评审 §9-G1 已判「前端 beacon」另立。本轮用 Nest `Logger` 结构化 warn：
丢弃事件本应是低频异常，日志可查即满足「一问可答」；指标化随 SP-E §8.1 一并做。

## 4. 明确不做（本轮）

- 前端 beacon / `canvas_action_apply_total`（P0 前置项，另立 plan）；
- `canvas_cas_conflict_total` 指标（SP-E §8.1 范畴）；
- `add_nodes_batch` 的边端点校验（其 E1 解析已 fail-closed，见 service `:1036-1063`）；
- P1b（after_tool 归一化）、P2、P3（Handle/布局网格/连线入口）；
- 提示词/技能面改动（工具出入参形状向后兼容，无 6 处同步负担）。

## 5. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 移动端边过粗/过艳被真机走查否决 | 参数集中在令牌 + 一个 CSS 文件 | 还原两个文件即可 |
| 契约测试对 CSS 的断言在格式化工具重排后误红 | 断言只锚语义片段（token 名/属性名），不锚列宽 | 调断言 |
| connectNodes 回执新字段破坏既有消费方 | 回执是**增量字段**，`content.text` 为模型可读文本，controller 透传无 schema 校验 | 无需回滚（向后兼容） |
| pi-events 日志在正常回合产生噪音 | 三类丢弃在健康链路上是零频；isError-with-actions 才记（纯 isError 不记） | 关日志级别 |
