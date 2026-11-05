# Canvas Digest（画布总览产物）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

规格：`docs/superpowers/specs/2026-11-05-canvas-digest-design.md`（判据 D1-D6、场景 S1-S7、图 1/图 2 为唯一契约来源）

## 排期总览（v1.1 自审后重排：trusted CSP 与真缩略图前移进 P0）

| 期 | 任务 | PR | 准入 |
|---|---|---|---|
| **P0** | Task 1-6（管道 + 完整视觉模板 §6.0 + trusted CSP + 交付条 + 埋点） | PR-1（含规格落盘） | 本计划批准（flag 默认 on 已拍板） |
| **P1** | Task 7-8（缩略图降级打磨 + 只读分支） | PR-2 | P0 生产复测通过 |
| **P2** | 登记不做（富版图鉴=html-craft S9、润色、读工具过滤、tile 定位回画布） | — | 凭使用证据（含 digest_open 率） |

## Global Constraints（全程有效）

- **TDD**：每任务先 RED（真实断言，禁 tautology）→ GREEN → 变异验证（改坏必红、还原必绿）。
- vitest node24 + `--maxWorkers=1 --no-file-parallelism`；server 改后 `npx tsc --noEmit`；web 改后 `vue-tsc -b`。
- 本机 pnpm 必须 `env -u NODE_OPTIONS`（language-shim 炸 mkdir）。
- **零 LLM**：渲染是纯函数（快照 → HTML 字符串），禁引入任何模型调用。
- **零 prompt 预算**：不动 prompt-registry / 工具描述 / skills。
- NodeType 三层白名单逐字符不动（NodeType 收敛纪律）；既有 `HTML_NODE_CSP` 常量与守卫逐字符不动（P0 只新增 `HTML_NODE_CSP_TRUSTED`）。
- digest 写入打 `data.source:'system-digest'` 标记：不进审批 / 不进计费 / 不进 agent 工具统计。
- 失败 fail-soft：digest 任何异常只 warn，不影响回合落库（S7）。
- git push 被代理挡 ⇒ REST Git Data API（blob sha 双向核对）；worktree 开发。

## P0

### Task 1：`canvas-digest.service.ts` 纯渲染函数（Nest，§6.0 视觉定稿）

- [ ] RED `canvas-digest.service.test.ts`：
  - `renderDigestHtml(snapshot)` 快照测试：fixture 画布态（image×2/video×1/text×1/audio×1，含 title/url/durationMs）⇒ HTML 含 §6.0 结构（Header 标题/更新时间/版本、分类型 Stats、分区固定顺序 图片→视频→音频→文本、2 列媒体网格、video 时长徽标、文本列表行、Footer D9 计数）、viewport meta、双主题 CSS、`loading="lazy"`；**不含**节点正文（D4）。
  - **XSS 用例（D7）**：title 含 `<script>`/引号/`<img onerror>` 三类 payload ⇒ 输出中无未转义原文（`escapeHtml` 全上下文）；变异：摘除转义 ⇒ 红。
  - **URL 绝对化（D8）**：相对 url ⇒ 输出为 publicBaseUrl 绝对地址；绝对 url 透传；变异：摘除绝对化 ⇒ 红。
  - **D9 有正据**：无 url 的 draft 媒体节点 ⇒ 不进分区、Footer 计入「N 项生成中未收录」。
  - 封顶（D3）：101 节点 ⇒ 只渲染 100 + 「其余 1 项未收录」；空快照 ⇒ 返回 null。
  - title 缺失兜底「未命名图片/视频/音频/文档」（D4）。
- [ ] GREEN：实现 `renderDigestHtml`（纯函数，模板字符串，§6.0 深色为主 + `prefers-color-scheme: light` 双主题，html-craft 设计纪律：≤2 ramp/无渐变投影/圆角一档/间距阶梯/≥11px/对比度 ≥4.5）。
- [ ] 变异：过滤条件/封顶值/排序改坏 ⇒ 红；还原 ⇒ 绿。

### Task 2：回合末挂载 + 系统写入（Nest）

- [ ] RED：触发判定用例（D1）——canvasActions 空 ⇒ 跳过；非空 ⇒ 采集快照；flag off ⇒ 零调用（S6）。
- [ ] RED：upsert 用例（D2）——画布无 `data.digest` 节点 ⇒ 调 `addNodesBatch`（title「画布总览」/ format 'html' / data.source 'system-digest' / data.digest true）；有 ⇒ 调 `setNodeContent` 翻新（digestVersion++，同 nodeId）。
- [ ] GREEN：`CanvasDigestService.maybeRender()`；`agent.service.ts` finalizeTurn 收束路径挂载（`void this.canvasDigest.maybeRender(...).catch(warn)`，fail-soft S7）；module 注册。
- [ ] ⚠️ SSE 广播（D2 注）：定位 `addNodesBatch`/`setNodeContent` controller 层的 canvas_action emit 点，内部调用复用同一广播路径（否则其他端不同步）；实施时先取证再接线。
- [ ] `share.service.ts` `publicBaseUrl` 抽取复用（行为不变，既有分享测试零改动通过）。
- [ ] 变异：flag 判定反转 ⇒ 红；upsert 分支反转 ⇒ 红。
- [ ] 回归：finalizeTurn 既有测试全家（turn-settle-detached / longturn-persistence / turn-identity）零改动通过。

### Task 3：trusted CSP 分级（图 2，v1.1 前移）

- [ ] `htmlNodePreviewContract.ts` 新增 `HTML_NODE_CSP_TRUSTED`（img-src = data: blob: + 本站媒体 origin，其余段逐字符对齐既有常量）。
- [ ] `HtmlNodePreview.vue` 按 `data.source === 'system-digest'` 分流（fail-closed：无标记不走 trusted）。
- [ ] 守卫测试：既有 `HTML_NODE_CSP` 断言**逐字符不动**；trusted 常量单独断言 + 分流用例（无标记的 agent 产物仍走旧 CSP——防「顺手放开」）。

### Task 4：web 交付条接入（E2-a 扩展，D5/D10）

- [ ] RED `deliverySummary.test.ts`：`turnDeliveryItems` 扩展——canvasNodes 含 `data.digest` 节点 ⇒ 清单含固定一枚「画布总览」tile（nodeType 'text'）；无 ⇒ 不含。
- [ ] GREEN：实现派生；`AgentTurnTimeline` 传参已具备（Q2 修复的 canvasNodes prop 现成）；viewer 路由复用 `deliveryViewerNodeOf`（inject 命中直开 / 桌面降级定位）；命中 viewer ⇒ `observeDeliveryCard('digest_open')`（D10）。
- [ ] 变异：digest 派生条件改坏 ⇒ 红。
- [ ] 回归：E2-a 三修测试 + 组件全家 + 令牌四守卫。

### Task 5：样例 + 全量回归 + PR

- [ ] DevTimelinePreview 加 digest 场景（S1 首产出 / S2 翻新版本号 / S4 删除反映 三态切换）。
- [ ] server 全量 + web 全量回归；`vue-tsc -b`；`npx tsc --noEmit`。
- [ ] PR（含规格 v1.1 + 本计划 + 母规格 §12 登记 + gen_index 回填）；CI 绿 → squash merge → 部署 → 生产取证（flag **on** 直接全量；取证锚：生成产物回合后画布出现总览节点、bundle 含 trusted CSP 常量、`digest_open` 打点接线）。

## P1（PR-2，P0 生产复测通过后）

### Task 6：缩略图失败降级打磨

- [ ] img onerror ⇒ 类型图标 fallback（模板内联 CSS/JS，沙箱允许 allow-scripts）；快照测试更新。

### Task 7：digest 节点只读分支（§10 风险 #1）

- [ ] `CanvasNodeText` / `MobileNodeEditorSheet`：`data.digest` 节点禁编辑（打开即 viewer 只读），防用户编辑被下轮翻新覆盖；节点卡「总览」徽章。
- [ ] 行为守卫测试。

## P2（登记不做，凭使用证据）

- 富版图鉴（html-craft S9 现状已覆盖，用户主动触发）；轻 LLM 润色文案；agent 读工具过滤 `data.digest` 节点；总览节点内定位回画布（viewer 沙箱无外链，须宿主协议另行评估）。

## Review Focus（PR 自审清单）

1. digest 写入是否真的零审批/零计费/零 agent 事件（G4）。
2. flag off 路径是否绝对零行为（S6，含模块构造副作用）。
3. finalizeTurn 挂载是否 fail-soft（S7：digest 挂了回合照常落库）。
4. upsert 竞态：并发 detached finalizeTurn 下同 nodeId 翻新是否幂等（D6）。
5. 既有 CSP 常量与守卫测试零改动（母规格契约）。
