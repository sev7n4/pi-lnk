# 提议卡批注/编辑一气呵成（M5）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地规格 §17 v2 + §17.8：提议卡审核层底栏两键（批注/编辑）、批注态（圈选→首笔即弹胶囊意见框→⚓ 整屏截图带回 composer + decline 结算）、编辑态（就地改字→保存覆盖磁贴→回画布再确认）。

**Architecture:** 圈选画布与锚带回管线已在 `MobileNodeViewer` / `composeAnnotatedImage` / `handleMobileAnnotateSend` 存在——本计划不重造，只做四件事：① 给「文本审阅面」补整屏底图渲染器（纯函数分层重绘）；② 壳层底栏 pending 分支收敛为两键并接胶囊/编辑态；③ 锚按下 = decline 结算（复用 `AgentSideRail.cancelProposeForNode` 同源逻辑，note 透传到 tool_result 防抢跑）+ 既有带回管线；④ 编辑态就地改字经 `patchNodeData` 覆盖磁贴。

**Tech Stack:** Vue3 `<script setup>` + vitest + vue-tsc；pi-runtime（Fastify + vitest node）。

**Spec:** `docs/superpowers/specs/2026-10-25-mobile-node-lifecycle-design.md` §17 v2（含 §17.0 用户原话 / §17.8 三问落判）、§9 #46–#50、§10.3 W-42–W-45、§12 M5。

## Global Constraints

- 测试命令纪律：`cd <worktree>/apps/web && ~/.nvm/versions/node/v24.13.0/bin/node ./node_modules/vitest/vitest.mjs run <file> --pool=threads --maxWorkers=1 --no-file-parallelism > /tmp/t.log 2>&1; echo EXIT=$?`；分批 ≤12 文件；禁并发跑测试与 git 操作。
- 类型检查：`vue-tsc -b`（非 --noEmit -p）；抽组件/改 props 后必跑。
- 设计令牌：组件样式只消费 L2/L3 令牌（`styles/design-tokens.css`），禁新增 hex/`rgba(`/`text-white`/`bg-[#`；文字色一律实色令牌；改样式后跑 `design-token.test.ts`。
- 零第三方图标库：锚图标沿用 `MobileNodeAnnotateSheet.vue:171` 的 mask-image 既有资产，不新增图标库。
- 手势：批注态画布 `touch-action:none`；`prefers-reduced-motion` 分支保留（本计划无新增动画，若加须有降级）。
- 节点状态一律走服务端/既有收敛路径（decline + clearProposeGeneration），⛔ 前端本地硬置 pending 态翻转（2026-10-13 虚假确认教训）。
- pi-runtime 测试在 `services/pi-runtime` 下用系统 vitest 即可（非 monorepo web 配置）。
- git push 走 REST Git Data API（`api.github.com`，token=`gh auth token`）；提交后 `git status --short | grep -v '^??'` 必须为空；禁 `git add -A`。
- 新守卫必做变异测试（改坏实现 ⇒ 守卫 EXIT=1 且指名报错）。

## Review Focus

1. **胶囊无字直接 ⚓** ⇒ composer 芯片非空且正文为空、不预填任何占位文案（V-17d 反例）。→ Task 5 测试。
2. **⚓ 连点/双击** ⇒ decline 幂等（`deduped:true`）且芯片只入列一次。→ Task 7 测试。
3. **编辑保存** ⇒ 磁贴 prompt 已更新且**不触发生成**、viewer 关闭回画布（V-17f 反例：保存即 confirm）。→ Task 6 测试。
4. **门挂起中锚后用户发送消息** ⇒ 消息不被 pending 门吞（decline 已结算；runtime 测试断言 steer 可达）。→ Task 1 测试。
5. **AgentSideRail 抽 service 后回归** ⇒ PC decline 行为逐字节不变（既有测试全绿）。→ Task 2 测试。

---

### Task 1: runtime — decline.note 防抢跑（§9 #50）

**Files:**
- Modify: `services/pi-runtime/src/pending-registry.ts`（PendingResolution / decline 签名）
- Modify: `services/pi-runtime/src/app.ts:464-499`（/answers decline 分支）
- Modify: `services/pi-runtime/src/tools/canvas-write.ts:669-680`（aborted 文案）
- Test: `services/pi-runtime/src/pending-registry.test.ts`（如无则新建）、`services/pi-runtime/src/app.test.ts`、`services/pi-runtime/src/tools/canvas-write.test.ts`

**Interfaces:**
- Produces: `PendingResolution` 增 `{ status: "aborted"; note?: string }`；`registry.decline(canvasId, callId, note?: string)`；tool_result 非确认分支（aborted + note）返回含「等待批注反馈」的文案。

- [ ] **Step 1: 写失败测试（pending-registry）**

```ts
// pending-registry.test.ts 追加
it("decline 携带 note ⇒ resolve {status:'aborted', note}", async () => {
  const reg = new PendingToolRegistry();
  const p = reg.waitForUser("s1", "c1", "propose_generation", 60_000);
  reg.decline("s1", "c1", "用户已圈选批注");
  expect(await p).toEqual({ status: "aborted", note: "用户已圈选批注" });
});
```

- [ ] **Step 2: 跑测试确认失败**（`decline` 第三参不存在 / resolution 无 note）
- [ ] **Step 3: 实现**：`PendingResolution` 的 aborted 臂加 `note?: string`；`decline(canvasId, callId, note?)` 把 note 塞进 resolve 值；`app.ts` decline 分支从 `request.body?.note` 透传（`typeof note === 'string' ? note.slice(0, 500) : undefined`，防超长注入）。
- [ ] **Step 4: 写失败测试（canvas-write 文案）**

```ts
// canvas-write.test.ts 追加（沿用文件内既有 stub registry 模式）
it("aborted + note ⇒ tool_result 提示等待批注反馈", async () => {
  // stub resolution: { status: "aborted", note: "圈选配色太冷" }
  // 断言结果文案包含「圈选配色太冷」且包含「等待用户消息」
});
it("aborted 无 note ⇒ 文案保持「用户已中止。」", async () => { /* 既有断言不变 */ });
```

- [ ] **Step 5: 实现 canvas-write.ts**：`aborted` 分支（`:673`）改为
  `note ? \`用户已拒绝本次提议（批注模式）。批注意见：${note}。截图反馈正从对话发来，请等待用户消息再修改提示词，不要盲目重新提议。\` : "用户已中止。"`
- [ ] **Step 6: 跑 pi-runtime 全量相关测试**：`canvas-write.test.ts` / `app.test.ts` / `pending-registry.test.ts` 全 PASS
- [ ] **Step 7: Commit** `feat(runtime): /answers decline 增 note 透传，aborted tool_result 防抢跑提示`

### Task 2: 前端 — 抽 `agentAnswers` service（mobile 复用 decline 通道）

**Files:**
- Create: `apps/web/src/services/agent-answers.ts`
- Create: `apps/web/src/services/agent-answers.test.ts`
- Modify: `apps/web/src/components/agent/AgentSideRail.vue:1226-1250,1304-1313`（改 import，行为零变化）

**Interfaces:**
- Produces: `submitAgentAnswers(post: AnswersPost, payload: { threadId?; sessionId; callId; answers?; decision?: 'answer'|'decline'; note?: string }): Promise<void>`；`type AnswersPost = (url, init) => Promise<{ok:boolean; json():Promise<unknown>}>`（与 AgentSideRail 现内联签名一致）。

- [ ] **Step 1: 写失败测试**——mock post 捕获 url/body：`decision:'decline', note:'x'` ⇒ body 含 `decision` 与 `note`；无 note ⇒ body 不含 `note` 键；`ok:false` ⇒ throw。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**——把 AgentSideRail `submitAnswers` payload 组装逻辑（含 `agentAnswers` 模块既有收敛，若存在则并入）搬到新文件，URL 用既有 `/sessions/:sessionId/answers` 路径常量。
- [ ] **Step 4: AgentSideRail 改 import，删除内联实现**；跑其既有测试文件（`AgentSideRail` 相关 test 全 PASS）。
- [ ] **Step 5: Commit** `refactor(web): 抽 agentAnswers service（decline 支持 note），AgentSideRail 行为不变`

### Task 3: 审阅层整屏底图渲染器（§9 #49，纯函数）

**Files:**
- Create: `apps/web/src/components/mobile/annotate/renderReviewBaseImage.ts`
- Create: `apps/web/src/components/mobile/annotate/renderReviewBaseImage.test.ts`

**Interfaces:**
- Produces: `renderReviewBaseImage(input: { prompt: string; paramsLine: string; width: number; height: number; theme?: 'light'|'dark' }, deps: { createCanvas: (w,h)=>HTMLCanvasElement; measureText: (text,font)=>number; fillText: (ctx,text,x,y)=>void; wrapText?: (text,font,maxWidth)=>string[] }): HTMLCanvasElement`
- 复用 `composeAnnotatedImage.ts` 的注入模式（`createCanvas` 参数化，可测）。

- [ ] **Step 1: 写失败测试**——注入 stub deps：① 长 prompt 换行后 `fillText` 调用次数 = wrapText 行数 + 参数行 1 次；② 白底（theme light ⇒ 底色 fillRect 一次）；③ 文本区留白边 ≥16px；④ 空段落跳过。全部走 stub，不碰真 canvas。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**——分层重绘：底色 → 提示词标题行（小字令牌灰）→ prompt 逐行（14px/1.7 行距等效）→ 底部参数行；字体用系统栈（截图语义，非 DOM，无令牌约束但色值用 `--lnk-*` 对应的实色 hex 常量并注释来源令牌名）。
- [ ] **Step 4: 跑测试 PASS**；`vue-tsc -b`
- [ ] **Step 5: Commit** `feat(web): 审阅层整屏底图渲染器（分层重绘，可注入测试）`

### Task 4: 胶囊意见框 `MobileAnnotationCapsule.vue`（§9 #46 的胶囊载体）

**Files:**
- Create: `apps/web/src/components/mobile/MobileAnnotationCapsule.vue`
- Create: `apps/web/src/components/mobile/MobileAnnotationCapsule.test.ts`

**Interfaces:**
- Props: `visible: boolean; uploading?: boolean`
- Emits: `anchor: [{ text: string }]`、`dismiss`
- 结构：底部悬浮条（毛玻璃深底、safe-area padding）；textarea（placeholder「补充意见（可不填，直接点 ⚓）」）+ 【⚓ 带回对话】主按钮 + 「当前屏截图」说明行（R-17）。

- [ ] **Step 1: 写失败测试**——mount 后 `visible=false` 不渲染；visible 后 textarea 输入「配色太冷」+ 点锚 ⇒ `anchor` 事件 payload `{text:'配色太冷'}`；空文本点锚 ⇒ payload `{text:''}`；锚点在 `uploading` 时 disabled。
- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现**（样式全部走令牌；锚图标复用 mask-image 资产）→ **Step 4: PASS + `vue-tsc -b`**
- [ ] **Step 5: Commit** `feat(web): MobileAnnotationCapsule 胶囊意见框（首笔即弹，锚带回）`

### Task 5: Viewer — 编辑态 + 批注态接入审阅底图（§9 #47 前半）

**Files:**
- Modify: `apps/web/src/components/mobile/MobileNodeViewer.vue`
- Test: `apps/web/src/components/mobile/__tests__/MobileNodeViewer.test.ts`（既有 15 例文件，追加）

**Interfaces:**
- Consumes: Task 3 `renderReviewBaseImage`、Task 4 胶囊（挂载于 viewer 底部）。
- Produces: props 增 `editing?: boolean`；emits 增 `(e:'edit-save', prompt: string)`、`(e:'annotate-anchored', payload:{ text:string })`；内部：批注态首笔落定 ⇒ 胶囊 `visible=true`（无「完成」按钮）；`captureBaseImage()` 在 `isPending`（无产物）分支改走 `renderReviewBaseImage`（prompt=`data.prompt`、paramsLine 只读摘要）。

- [ ] **Step 1: 写失败测试**——① pending + 底图渲染：stub createCanvas 注入路径（组件以 provide/props 注入渲染器或在测试 spy `renderReviewBaseImage`）⇒ `onInkEnd` 后生成 blob 前 base 尺寸来自渲染器；② 首笔落定 ⇒ 胶囊 visible；③ `editing` 态 prompt 区渲染 `<textarea>` 且值=`data.prompt`；④ `edit-save`：改 textarea ⇒ emit payload 为新文本；⑤ 批注态下滚动容器 `touch-action:none`（断言 style/class）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**（编辑态沿用原 viewer 模板内切换 `v-if`，⛔ 不新增组件 type；批注态复用既有 annotating 状态机，仅换底图来源与首笔触发）→ **Step 4: 全文件 PASS + `vue-tsc -b`**
- [ ] **Step 5: Commit** `feat(web): MobileNodeViewer 编辑态 + 批注态接入审阅底图与首笔胶囊`

### Task 6: 壳层 — 底栏两键 + 锚/编辑接线（§9 #47 后半 + #48）

**Files:**
- Modify: `apps/web/src/components/mobile/MobileCanvasShell.vue:185-207`（`viewerBottomActions` pending 分支）
- Modify: `apps/web/src/components/mobile/MobileCanvasShell.vue`（viewer 事件转发：`@edit-save` / `@annotate-anchored` 上抛 CanvasPage；胶囊/批注态不再走 MobileNodeAnnotateSheet 全屏 sheet）
- Test: `apps/web/src/components/mobile/__tests__/MobileCanvasShell.nodeActions.test.ts`（既有 16 例，追加）

**Interfaces:**
- Produces: pending 底栏 = `[{key:'annotate',label:'批注'},{key:'edit',label:'编辑'}]`（`pending-cancel/pending-confirm/edit` 三键退役）；壳层 emits/回调增 `onAnnotateAnchored(nodeId, {text})`、`onEditSave(nodeId, prompt)`。
- ⚠️ `pending-confirm` 从 viewer 底栏退役，但**状态栏胶囊**（MobileNodeStatusBar 确认/拒绝）保留——§17.2 画布侧入口不变。

- [ ] **Step 1: 写失败测试**——① pending 节点 `viewerBottomActions` 输出恰为两键（快照/逐键断言，含 ⛔ 不含 `pending-cancel/pending-confirm/edit`）；② `annotate-anchored` / `edit-save` 事件透传到回调。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 该测试文件全 PASS + `vue-tsc -b`**
- [ ] **Step 5: Commit** `feat(web): 审核层底栏收敛批注/编辑两键，接线锚与编辑保存`

### Task 7: CanvasPage — 锚=decline 结算 + 带回预填；编辑保存=覆盖磁贴（§9 #48）

**Files:**
- Modify: `apps/web/src/pages/CanvasPage.vue`（`handleMobileViewerBottomAction:2874-2896`、`handleMobileAnnotateSend:2755-2797` 附近）
- Test: `apps/web/src/pages/__tests__/`（沿用既有 CanvasPage.mobile* 静态契约文件模式，新增 `CanvasPage.mobileAnnotationWiring.test.ts`）

**Interfaces:**
- Consumes: Task 2 `submitAgentAnswers`；`useAgentStore().blockingWait`（callId 来源，同 `AgentSideRail.resolveProposeCancelCallId`——该 helper 若未导出则抽到 `agentAnswers` 同文件导出）；`canvasApi.clearProposeGeneration`；`useSidebarAttachments.addFromPayload`。
- 锚流程（`onAnnotateAnchored`）：① `submitAgentAnswers(post, {sessionId, callId, answers:{}, decision:'decline', note: text || undefined})`（失败仅吞掉——幂等端点，轮询兜底）；② `canvasApi.clearProposeGeneration(sessionId, nodeId)` + 既有 `clearProposeGeneration` 本地收敛；③ 截图走既有 `handleMobileAnnotateSend` 管线（`fileToPersistedPayload` → `addFromPayload({..., text, sourceNodeId: nodeId+'#annotate-'+seq})`）；④ `mobileAppTab='chat'` + composer 聚焦（既有行为）。
- 编辑保存（`onEditSave`）：`patchNodeData(nodeId, { prompt })`（复用 clear-propose 同款本地收敛 + 既有画布持久化通道）→ 关 viewer 回画布；**⛔ 不得调用 `handleAgentGenerateNode`**。

- [ ] **Step 1: 写失败测试（静态接线契约，沿 gestureWiring 文件风格）**——源码断言：① `onAnnotateAnchored` 处理内包含 `decision: 'decline'` 与 `clearProposeGeneration`；② 处理内**不包含** `handleAgentGenerateNode`（编辑保存防误触生成）；③ `addFromPayload` 的 `text` 来自锚 payload。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: PASS + `vue-tsc -b`**
- [ ] **Step 5: Commit** `feat(web): 锚=decline 结算+带回预填；编辑保存覆盖磁贴不触发生成`

### Task 8: 静态守卫（V-17b/g）+ 变异验证

**Files:**
- Create: `apps/web/src/components/mobile/__tests__/annotationFlow.guards.test.ts`

- [ ] **Step 1: 写守卫测试**——① V-17g：读 `MobileNodeViewer.vue` + `MobileAnnotationCapsule.vue` + 新增批注模块源码（剥注释后，用既有剥注释 helper），断言批注流新增代码块内无 `type ===` 分支（限定本次新增模块文件清单，勿扫全 viewer 历史）；② V-17b：`MobileCanvasShell.vue` 源码 pending 分支含 `key:'annotate'` 与 `key:'edit'` 且不含 `pending-cancel`（viewer 底栏范围）。
- [ ] **Step 2: 变异测试**——临时把壳层 `annotate` 键改回 `pending-cancel` ⇒ 守卫 EXIT=1 且报错指名；还原。
- [ ] **Step 3: Commit** `test(web): 批注流静态守卫（V-17b/g）+ 变异验证`

### Task 9: 收尾 — 全量测试 + 规格实施回写 + PR

- [ ] **Step 1: 分批全量**：apps/web 改动相关测试文件分 ≤12 文件/批跑绿；pi-runtime `canvas-write/app/pending-registry` 跑绿；`vue-tsc -b` 0 错（unplugin 环境错除外，以 CI 为准）。
- [ ] **Step 2: 规格回写**：`docs/superpowers/specs/2026-10-25-...md` §12 M5 标「已实施（本 PR）」+ §9 #46–#50 状态列补 PR 号；#46 补一句「实施形态=状态机+挂载点（Viewer/壳层消费），非独立组件实例——红线（非 type/非子类）不变」。
- [ ] **Step 3: Commit** `docs(spec): M5 实施回写` → REST push 分支 → `gh pr create` → CI 绿 → squash 合并 → deploy（web+api 均有改动 ⇒ 看 deploy.yml 触发面）→ 生产取证（W-42–W-45 字面量：`批注`/`编辑` 底栏键、`mobile-annotation-capsule` 类名、tool_result note 文案在服务端）。

## Self-Review 记录

- 覆盖度：§17.2 两键=Task 6；§17.3 批注态=Task 3/4/5；§17.4 编辑态=Task 5/6/7；§17.8=Task 1/2/7；V-17a..g=Task 5/6/8；W-42–45=Task 5/6/7/8 走查项。无缺口。
- 类型一致性：`anchor:[{text}]` / `annotate-anchored(nodeId,{text})` / `edit-save(prompt)` / `onEditSave(nodeId,prompt)` 各 Task 对齐。
- Review Focus 五项均有归属测试。
