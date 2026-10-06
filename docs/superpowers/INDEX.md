# superpowers 文档索引

> spec / plan 的**导航索引**。**不写死总份数**——以 `ls docs/superpowers/{specs,plans}/*.md | wc -l` 实测为准。
> 生成器 `gen_index.py` / `gen_index_md.py` **在仓库里不存在**（见文末「重新生成」），故条目与状态分布均为**手工维护**，统计基线 2026-10-04、新增文档未回填 ⇒ **勿据份数做判据**。判定依据见文末「状态判定规则」。
> **文档正文未改动** —— 本索引只做导航与状态标注。

## 怎么用这份索引

1. **改代码前**，在下面 `🟢 living` 里找相关主题，确认设计意图与当前实现是否一致。
2. **遇到历史包袱**，`🔒 frozen` 记录了「当初为什么这么定」，改设计前值得先读。
3. **`⛔ superseded` 一律不要参考** —— 已被取代，看它旁边的文档。

## 状态总览

| 状态 | 份数 | 含义 |
|---|---|---|
| 🟢 living | 95 | 仍在演进，改动前先看这份 |
| 🔒 frozen | 186 | 内容已定稿或功能已落地，作为历史依据 |
| ⛔ superseded | 5 | 已被后续决策取代，勿再参考 |

> ⚠️ 上表是**手工维护**的统计，基线 2026-10-04；此后新增文档只补进主题分组、**未回填本表** ⇒ 三项之和会小于实测总份数。
> **要份数就跑 `ls docs/superpowers/{specs,plans}/*.md | wc -l`，别读这张表。**（生成器不存在，见文末「重新生成」。）

## 主题分布

| 主题 | 份数 | 其中 living |
|---|---|---|
| 画布工具与交互 | 41 | 14 |
| 生成管线（图像/视频/3D） | 36 | 8 |
| 画布产品能力（原子/意图/neowow） | 34 | 8 |
| 图片编辑器与精修台 | 30 | 5 |
| Agent 交互与可见性 | 27 | 14 |
| 工具与运行时内核 | 19 | 6 |
| 账号/登录/会员 | 18 | 4 |
| 工作流导入导出 | 18 | 4 |
| 规划与执行计划 | 16 | 5 |
| UI 交互细节 | 15 | 8 |
| 其他 | 10 | 1 |
| 视觉输入（识图） | 7 | 6 |
| 部署与基础设施 | 6 | 4 |
| 长期记忆 | 4 | 3 |
| 上下文工程 | 3 | 3 |
| 提示词注册表 | 3 | 3 |

---

## 按主题浏览

### 画布工具与交互（41 份）

<details><summary>🟢 living · 14 份</summary>

- `docs/superpowers/plans/2026-09-16-generic-canvas-compose.md`
- `docs/superpowers/specs/2026-09-16-generic-canvas-compose-design.md` ★design
- `docs/superpowers/plans/2026-09-16-canvas-operator-2e2-operator-set.md`
- `docs/superpowers/plans/2026-09-16-agent-bare-gen-propose-bind.md`
- `docs/superpowers/specs/2026-09-16-agent-bare-gen-propose-bind-design.md` ★design
- `docs/superpowers/plans/2026-09-15-prompt-node-image-refs.md`
- `docs/superpowers/specs/2026-09-15-prompt-node-image-refs-design.md` ★design
- `docs/superpowers/plans/2026-09-12-canvas-workflow-exchange.md`
- `docs/superpowers/specs/2026-09-12-canvas-workflow-exchange-design.md` ★design
- `docs/superpowers/specs/2026-08-10-agent-canvas-ref-pick-design.md` ★design
- `docs/superpowers/specs/2026-07-23-canvas-task-undo-video-ux-design.md` ★design
- `docs/superpowers/specs/2026-07-22-canvas-upload-history-works-design.md` ★design
- `docs/superpowers/specs/2026-07-20-points-dock-node-ux-design.md` ★design
- `docs/superpowers/specs/2026-07-20-node-task-status-feedback-design.md` ★design

</details>

<details><summary>🔒 frozen · 27 份</summary>

- `docs/superpowers/plans/2026-09-29-canvas-node-crud-completeness.md`
- `docs/superpowers/specs/2026-09-29-canvas-node-crud-completeness-design.md` ★design
- `docs/superpowers/plans/2026-09-29-agent-tool-canvas-sessionid-hotfix.md`
- `docs/superpowers/specs/2026-09-29-agent-tool-canvas-sessionid-hotfix-design.md` ★design
- `docs/superpowers/specs/2026-09-28-arrange-nodes-tool-design.md` ★design
- `docs/superpowers/plans/2026-09-24-ui-command-canvas-action-design.md`
- `docs/superpowers/plans/2026-09-24-p1-canvas-context-injection.md`
- `docs/superpowers/plans/2026-09-23-p1-canvas-tool-inventory.md`
- `docs/superpowers/plans/2026-09-16-canvas-operator-2e3-v1-skeleton.md`
- `docs/superpowers/specs/2026-09-16-canvas-operator-2e-design.md` ★design
- `docs/superpowers/plans/2026-08-21-canvas-media-info-footer.md`
- `docs/superpowers/specs/2026-08-21-canvas-media-info-footer-design.md` ★design
- `docs/superpowers/plans/2026-08-18-canvas-duplicate-agent-p2.md`
- `docs/superpowers/plans/2026-08-17-canvas-node-duplicate.md`
- `docs/superpowers/specs/2026-08-17-canvas-node-duplicate-design.md` ★design
- `docs/superpowers/plans/2026-08-08-agent-canvas-control-surface.md`
- `docs/superpowers/specs/2026-08-08-agent-canvas-control-surface-design.md` ★design
- `docs/superpowers/plans/2026-08-03-agent-phase-c-canvas-sync-gen.md`
- `docs/superpowers/specs/2026-08-03-agent-phase-c-canvas-sync-gen-design.md` ★design
- `docs/superpowers/plans/2026-07-23-canvas-task-undo-video-ux.md`
- `docs/superpowers/plans/2026-07-22-canvas-upload-history-works.md`
- `docs/superpowers/plans/2026-07-20-points-dock-node-ux.md`
- `docs/superpowers/plans/2026-07-20-node-task-status-feedback.md`
- `docs/superpowers/plans/2026-07-19-c21-canvas-refs.md`
- `docs/superpowers/specs/2026-07-19-c21-canvas-refs-design.md` ★design
- `docs/superpowers/plans/2026-07-18-node-data-flow-refs.md`
- `docs/superpowers/specs/2026-07-18-node-data-flow-refs-design.md` ★design

</details>

### 生成管线（图像/视频/3D）（36 份）

<details><summary>🟢 living · 8 份</summary>

- `docs/superpowers/specs/2026-09-13-minimax-h3-full-video-design.md` ★design
- `docs/superpowers/plans/2026-09-13-fal-h3-max-video-min.md`
- `docs/superpowers/specs/2026-09-13-fal-h3-max-video-min-design.md` ★design
- `docs/superpowers/specs/2026-09-11-image-prompting-guide-catalog-fill-design.md` ★design
- `docs/superpowers/specs/2026-09-11-image-prompting-guide-catalog-design.md` ★design
- `docs/superpowers/specs/2026-09-10-wave-a-delivery-program-design.md` ★design
- `docs/superpowers/specs/2026-08-08-media-storage-download-deferred-design.md` ★design
- `docs/superpowers/specs/2026-08-05-turnaround-image-pipeline-design.md` ★design

</details>

<details><summary>🔒 frozen · 28 份</summary>

- `docs/superpowers/plans/2026-09-29-p0-abort-cascade-sse-resume.md`
- `docs/superpowers/specs/2026-09-26-byok-into-pi-runtime-design.md` ★design
- `docs/superpowers/plans/2026-09-14-minimax-h3-p1-reference.md`
- `docs/superpowers/plans/2026-09-14-minimax-h3-p0-video.md`
- `docs/superpowers/plans/2026-09-12-wave-a-a1-upscale.md`
- `docs/superpowers/specs/2026-09-12-wave-a-a1-sts-upscale-design.md` ★design
- `docs/superpowers/plans/2026-09-12-wave-a-a1-sts-direct-upload.md`
- `docs/superpowers/plans/2026-09-11-image-prompting-guide-catalog.md`
- `docs/superpowers/plans/2026-09-11-image-prompting-guide-catalog-fill.md`
- `docs/superpowers/plans/2026-09-10-wave-a-a3-media-persist.md`
- `docs/superpowers/specs/2026-09-10-wave-a-a3-media-persist-design.md` ★design
- `docs/superpowers/plans/2026-08-15-media-inspector.md`
- `docs/superpowers/specs/2026-08-15-media-inspector-design.md` ★design
- `docs/superpowers/specs/2026-08-15-i2v-upstream-capability-audit-design.md` ★design
- `docs/superpowers/plans/2026-08-15-i2v-capability-productization.md`
- `docs/superpowers/plans/2026-08-14-unified-image-to-video-pipeline.md`
- `docs/superpowers/specs/2026-08-14-unified-image-to-video-pipeline-design.md` ★design
- `docs/superpowers/plans/2026-08-08-seedance-agnes-video-adapter.md`
- `docs/superpowers/specs/2026-08-08-seedance-agnes-video-adapter-design.md` ★design
- `docs/superpowers/plans/2026-08-06-seedream-gpt-image2-apimart.md`
- `docs/superpowers/specs/2026-08-06-seedream-gpt-image2-apimart-design.md` ★design
- `docs/superpowers/plans/2026-08-05-turnaround-image-pipeline.md`
- `docs/superpowers/plans/2026-07-21-node-generation-failure-diagnostics.md`
- `docs/superpowers/specs/2026-07-21-node-generation-failure-diagnostics-design.md` ★design
- `docs/superpowers/plans/2026-07-19-c2-canvas-generation-adapter.md`
- `docs/superpowers/specs/2026-07-19-c2-canvas-generation-adapter-design.md` ★design
- `docs/superpowers/plans/2026-07-19-byok-provider-channels.md`
- `docs/superpowers/specs/2026-07-19-byok-provider-channels-design.md` ★design

</details>

### 画布产品能力（原子/意图/neowow）（34 份）

<details><summary>🟢 living · 8 份</summary>

- `docs/superpowers/specs/2026-09-15-agent-arrange-along-edges-design.md` ★design
- `docs/superpowers/plans/2026-08-11-product-visual-scheme-v2.md`
- `docs/superpowers/specs/2026-08-11-product-visual-phase2-scheme-ssot-design.md` ★design
- `docs/superpowers/plans/2026-08-10-ecommerce-product-visual.md`
- `docs/superpowers/specs/2026-08-10-ecommerce-product-visual-design.md` ★design
- `docs/superpowers/specs/2026-08-05-commercial-storyboard-design.md` ★design
- `docs/superpowers/specs/2026-07-26-graph-engineering-design.md` ★design
- `docs/superpowers/specs/2026-07-17-prompt-node-intent-templates-design.md` ★design

</details>

<details><summary>🔒 frozen · 25 份</summary>

- `docs/superpowers/specs/2026-09-28-two-product-line-boundary-mapping.md` ★design
- `docs/superpowers/specs/2026-09-21-agent-batch-confirm-and-auto-mode-design.md` ★design
- `docs/superpowers/plans/2026-08-13-product-visual-journey-trace.md`
- `docs/superpowers/specs/2026-08-13-product-visual-journey-trace-design.md` ★design
- `docs/superpowers/specs/2026-08-11-product-visual-phase2-scheme-ssot-uat.md` ★design
- `docs/superpowers/specs/2026-08-11-product-visual-phase2-scheme-ssot-test-cases.md` ★design
- `docs/superpowers/plans/2026-08-11-agent-conversation-ux-product-visual.md`
- `docs/superpowers/specs/2026-08-11-agent-conversation-ux-product-visual-design.md` ★design
- `docs/superpowers/plans/2026-08-09-atomic-intent-ir.md`
- `docs/superpowers/specs/2026-08-09-atomic-intent-ir-design.md` ★design
- `docs/superpowers/plans/2026-08-07-platform-route-skill-boundary.md`
- `docs/superpowers/specs/2026-08-07-platform-route-skill-boundary-design.md` ★design
- `docs/superpowers/plans/2026-08-05-intent-planning-guard.md`
- `docs/superpowers/specs/2026-08-05-intent-planning-guard-design.md` ★design
- `docs/superpowers/plans/2026-08-05-intent-llm-structured-parse.md`
- `docs/superpowers/specs/2026-08-05-intent-llm-structured-parse-design.md` ★design
- `docs/superpowers/plans/2026-08-04-atomic-regenerate.md`
- `docs/superpowers/plans/2026-08-04-atomic-intent-hybrid-phases.md`
- `docs/superpowers/specs/2026-08-04-atomic-intent-hybrid-design.md` ★design
- `docs/superpowers/specs/2026-08-03-atomic-studio-intent-design.md` ★design
- `docs/superpowers/plans/2026-07-19-dock-studio-model-adapter.md`
- `docs/superpowers/specs/2026-07-19-dock-studio-model-adapter-design.md` ★design
- `docs/superpowers/plans/2026-07-17-prompt-node-intent-templates.md`
- `docs/superpowers/plans/2026-07-09-neowow-workflow.md`
- `docs/superpowers/specs/2026-07-09-neowow-workflow-design.md` ★design

</details>

<details><summary>⛔ superseded · 1 份</summary>

- `docs/superpowers/plans/2026-09-15-agent-arrange-along-edges.md`

</details>

### 图片编辑器与精修台（30 份）

<details><summary>🟢 living · 5 份</summary>

- `docs/superpowers/specs/2026-09-23-refine-selection-unified-design.md` ★design
- `docs/superpowers/specs/2026-09-21-refine-studio-layout-rework-design.md` ★design
- `docs/superpowers/specs/2026-09-21-image-editor-unified-design.md` ★design
- `docs/superpowers/plans/2026-09-21-image-editor-m1-entry-unification.md`
- `docs/superpowers/specs/2026-08-18-cx-image-edit-design.md` ★design

</details>

<details><summary>🔒 frozen · 25 份</summary>

- `docs/superpowers/plans/2026-09-22-workbench-shell-and-outpaint-pilot.md`
- `docs/superpowers/specs/2026-09-22-workbench-shell-and-outpaint-pilot-design.md` ★design
- `docs/superpowers/plans/2026-09-22-refine-matting-unified-apply.md`
- `docs/superpowers/specs/2026-09-22-refine-matting-unified-apply-design.md` ★design
- `docs/superpowers/plans/2026-09-22-refine-m2-capability-pack.md`
- `docs/superpowers/specs/2026-09-22-refine-m2-capability-pack-design.md` ★design
- `docs/superpowers/plans/2026-09-21-refine-studio-layout-rework.md`
- `docs/superpowers/plans/2026-09-15-turnaround-deai-product-four-panel.md`
- `docs/superpowers/specs/2026-09-15-turnaround-deai-product-four-panel-design.md` ★design
- `docs/superpowers/plans/2026-09-15-image-grid-slice.md`
- `docs/superpowers/plans/2026-09-15-image-grid-slice-p1.md`
- `docs/superpowers/specs/2026-09-15-image-grid-slice-p1-design.md` ★design
- `docs/superpowers/specs/2026-09-15-image-grid-slice-design.md` ★design
- `docs/superpowers/plans/2026-08-31-cx-image-edit-sam-point-select.md`
- `docs/superpowers/specs/2026-08-31-cx-image-edit-sam-point-select-design.md` ★design
- `docs/superpowers/plans/2026-08-31-cx-image-edit-sam-mediapipe-fallback.md`
- `docs/superpowers/specs/2026-08-31-cx-image-edit-sam-mediapipe-fallback-design.md` ★design
- `docs/superpowers/plans/2026-08-21-cx-image-edit-selection-tools.md`
- `docs/superpowers/specs/2026-08-21-cx-image-edit-selection-tools-design.md` ★design
- `docs/superpowers/plans/2026-08-19-cx-image-edit-toolchain.md`
- `docs/superpowers/specs/2026-08-19-cx-image-edit-toolchain-design.md` ★design
- `docs/superpowers/plans/2026-08-19-cx-image-edit-sidepanel.md`
- `docs/superpowers/specs/2026-08-19-cx-image-edit-sidepanel-design.md` ★design
- `docs/superpowers/plans/2026-08-18-cx-image-edit.md`
- `docs/superpowers/plans/2026-08-08-media-stream-download-p0.md`

</details>

### Agent 交互与可见性（27 份）

<details><summary>🟢 living · 14 份</summary>

- `docs/superpowers/specs/2026-10-06-selection-as-default-reference-design.md` ★design —— 画布选中 = Agent 默认指代（产品定义 + 落地规格，承接 M3 D-B）
- `docs/superpowers/plans/2026-09-30-ask-user-blocking.md`
- `docs/superpowers/specs/2026-09-30-ask-user-blocking-design.md` ★design
- `docs/superpowers/plans/2026-09-26-p1-turn-presentation.md`
- `docs/superpowers/plans/2026-09-25-execution-trace-observability.md`
- `docs/superpowers/plans/2026-09-16-agent-sidebar-media-propose-bind.md`
- `docs/superpowers/specs/2026-09-16-agent-sidebar-media-propose-bind-design.md` ★design
- `docs/superpowers/plans/2026-09-15-agent-sidebar-media-parse.md`
- `docs/superpowers/specs/2026-09-15-agent-sidebar-media-parse-design.md` ★design
- `docs/superpowers/plans/2026-09-06-chat-sink-sidebar-l1.md`
- `docs/superpowers/specs/2026-08-07-agent-sidebar-material-entry-design.md` ★design
- `docs/superpowers/specs/2026-08-07-agent-sidebar-m3-explicit-refs-design.md` ★design
- `docs/superpowers/specs/2026-08-06-agent-sidebar-copy-design.md` ★design
- `docs/superpowers/specs/2026-07-25-agent-task-progress-card-design.md` ★design

</details>

<details><summary>🔒 frozen · 12 份</summary>

- `docs/superpowers/plans/2026-10-01-agent-progress-visible.md`
- `docs/superpowers/specs/2026-09-28-ask-user-tool-design.md` ★design
- `docs/superpowers/specs/2026-09-06-chat-sink-sidebar-l1-design.md` ★design
- `docs/superpowers/plans/2026-08-09-sidebar-ref-image-routing-full.md`
- `docs/superpowers/specs/2026-08-09-sidebar-ref-image-routing-design.md` ★design
- `docs/superpowers/plans/2026-08-07-agent-sidebar-material-entry.md`
- `docs/superpowers/plans/2026-08-07-agent-sidebar-m3-explicit-refs.md`
- `docs/superpowers/plans/2026-08-06-agent-execution-trace-p1-p2.md`
- `docs/superpowers/specs/2026-08-06-agent-execution-trace-design.md` ★design
- `docs/superpowers/plans/2026-07-25-agent-task-progress-card.md`
- `docs/superpowers/plans/2026-07-20-text-image-timeout-thinking.md`
- `docs/superpowers/specs/2026-07-20-text-image-timeout-thinking-design.md` ★design

</details>

<details><summary>⛔ superseded · 1 份</summary>

- `docs/superpowers/plans/2026-08-09-sidebar-ref-image-routing.md`

</details>

### 工具与运行时内核（19 份）

<details><summary>🟢 living · 6 份</summary>

- `docs/superpowers/specs/2026-10-02-pi-runtime-capability-fullfillment-design.md` ★design
- `docs/superpowers/plans/2026-09-29-persistent-harness-session.md`
- `docs/superpowers/specs/2026-09-16-sse-tool-call-emit-design.md` ★design
- `docs/superpowers/specs/2026-09-14-codex-style-tool-plan-harness-design.md` ★design
- `docs/superpowers/specs/2026-08-04-loop-engineering-design.md` ★design
- `docs/superpowers/specs/2026-07-23-agent-runtime-langgraph-design.md` ★design

</details>

<details><summary>🔒 frozen · 13 份</summary>

- `docs/superpowers/plans/2026-10-02-pi-runtime-capability-fullfillment.md`
- `docs/superpowers/specs/2026-09-29-persistent-harness-session-design.md` ★design
- `docs/superpowers/plans/2026-09-28-agent-tool-p0-web-and-delete.md`
- `docs/superpowers/specs/2026-09-28-agent-tool-p0-web-and-delete-design.md` ★design
- `docs/superpowers/plans/2026-09-24-ui-command-tools-impl.md`
- `docs/superpowers/plans/2026-09-24-b5-b3-gen-lifecycle-tools.md`
- `docs/superpowers/plans/2026-09-24-b2-write-tools.md`
- `docs/superpowers/plans/2026-09-23-p1-tool-usage-evidence.md`
- `docs/superpowers/plans/2026-09-16-sse-tool-call-emit.md`
- `docs/superpowers/plans/2026-09-14-codex-style-tool-plan-harness.md`
- `docs/superpowers/specs/2026-09-14-agent-atomic-as-tools-design.md` ★design
- `docs/superpowers/specs/2026-08-09-explore-tool-reliability-phase2-design.md` ★design
- `docs/superpowers/plans/2026-07-24-agent-runtime-langgraph.md`

</details>

### 账号/登录/会员（18 份）

<details><summary>🟢 living · 4 份</summary>

- `docs/superpowers/specs/2026-09-16-usage-overview-agnes-design.md` ★design
- `docs/superpowers/specs/2026-09-15-account-chrome-profile-ia-design.md` ★design
- `docs/superpowers/specs/2026-09-14-login-register-invite-legal-design.md` ★design
- `docs/superpowers/specs/2026-09-01-points-stats-personal-center-design.md` ★design

</details>

<details><summary>🔒 frozen · 14 份</summary>

- `docs/superpowers/plans/2026-09-17-usage-page-polish.md`
- `docs/superpowers/specs/2026-09-17-usage-page-polish-design.md` ★design
- `docs/superpowers/plans/2026-09-16-usage-overview.md`
- `docs/superpowers/plans/2026-09-15-account-chrome-profile-ia.md`
- `docs/superpowers/plans/2026-09-14-login-register-invite-legal.md`
- `docs/superpowers/plans/2026-09-13-login-slider-captcha-video-carousel.md`
- `docs/superpowers/specs/2026-09-13-login-slider-captcha-video-carousel-design.md` ★design
- `docs/superpowers/plans/2026-09-13-login-neotv-polish-captcha-pool.md`
- `docs/superpowers/specs/2026-09-13-login-neotv-polish-captcha-pool-design.md` ★design
- `docs/superpowers/plans/2026-09-13-login-fullscreen-block-captcha.md`
- `docs/superpowers/specs/2026-09-13-login-fullscreen-block-captcha-design.md` ★design
- `docs/superpowers/plans/2026-09-01-points-stats-personal-center.md`
- `docs/superpowers/plans/2026-09-01-points-stats-neowow-adoption.md`
- `docs/superpowers/specs/2026-09-01-points-stats-neowow-adoption-design.md` ★design

</details>

### 工作流导入导出（18 份）

<details><summary>🟢 living · 4 份</summary>

- `docs/superpowers/specs/2026-09-17-composition-land-production-gaps.md` ★design
- `docs/superpowers/specs/2026-09-15-workflow-recipe-planner-design.md` ★design
- `docs/superpowers/specs/2026-09-12-dock-guide-scene-label-design.md` ★design
- `docs/superpowers/specs/2026-09-11-wave-a-a2-export-pack-design.md` ★design

</details>

<details><summary>🔒 frozen · 12 份</summary>

- `docs/superpowers/plans/2026-09-17-composition-source-bind.md`
- `docs/superpowers/plans/2026-09-16-planner-confirm-instantiate-gate.md`
- `docs/superpowers/plans/2026-09-16-import-default-along-edges.md`
- `docs/superpowers/plans/2026-09-15-workflow-recipe-planner.md`
- `docs/superpowers/plans/2026-09-13-explore-import-workflow-placement.md`
- `docs/superpowers/specs/2026-09-13-explore-import-workflow-placement-design.md` ★design
- `docs/superpowers/plans/2026-09-12-workflow-import-placement.md`
- `docs/superpowers/specs/2026-09-12-workflow-import-placement-design.md` ★design
- `docs/superpowers/plans/2026-09-12-dock-guide-scene-label.md`
- `docs/superpowers/plans/2026-09-12-agent-import-workflow.md`
- `docs/superpowers/specs/2026-09-12-agent-import-workflow-design.md` ★design
- `docs/superpowers/plans/2026-09-11-wave-a-a2-export-pack.md`

</details>

<details><summary>⛔ superseded · 2 份</summary>

- `docs/superpowers/specs/2026-09-17-composition-source-bind-design.md` ★design
- `docs/superpowers/specs/2026-09-16-planner-confirm-instantiate-gate-design.md` ★design

</details>

### 规划与执行计划（16 份）

<details><summary>🟢 living · 5 份</summary>

- `docs/superpowers/specs/2026-09-16-agent-atomic-phase-2d3-design.md` ★design
- `docs/superpowers/specs/2026-09-15-agent-atomic-phase-2d2-design.md` ★design
- `docs/superpowers/specs/2026-09-14-agent-atomic-phase-2c-design.md` ★design
- `docs/superpowers/specs/2026-08-03-agent-phase-c2-dock-model-skillid-design.md` ★design
- `docs/superpowers/specs/2026-07-24-agent-chat-ux-phase1-design.md` ★design

</details>

<details><summary>🔒 frozen · 10 份</summary>

- `docs/superpowers/plans/2026-09-16-agent-atomic-phase-2d3.md`
- `docs/superpowers/plans/2026-09-15-agent-atomic-phase-2d2.md`
- `docs/superpowers/plans/2026-09-15-agent-atomic-phase-2d.md`
- `docs/superpowers/specs/2026-09-15-agent-atomic-phase-2d-design.md` ★design
- `docs/superpowers/plans/2026-09-14-agent-atomic-phase-2c3.md`
- `docs/superpowers/plans/2026-09-14-agent-atomic-phase-2c2.md`
- `docs/superpowers/plans/2026-09-14-agent-atomic-phase-2c1.md`
- `docs/superpowers/plans/2026-09-14-agent-atomic-phase-2b.md`
- `docs/superpowers/plans/2026-08-03-agent-phase-c2-dock-model-skillid.md`
- `docs/superpowers/plans/2026-07-24-agent-chat-ux-phase1.md`

</details>

<details><summary>⛔ superseded · 1 份</summary>

- `docs/superpowers/plans/2026-09-14-agent-atomic-phase-2a.md`

</details>

### UI 交互细节（15 份）

<details><summary>🟢 living · 8 份</summary>

- `docs/superpowers/specs/2026-09-28-agent-conversation-ux-p0-p2-design.md` ★design
- `docs/superpowers/specs/2026-08-12-agent-mid-run-interrupt-design.md` ★design
- `docs/superpowers/specs/2026-08-07-agent-conversation-isolation-design.md` ★design
- `docs/superpowers/plans/2026-07-25-agent-topology-preview-hitl.md`
- `docs/superpowers/specs/2026-07-25-agent-topology-preview-hitl-design.md` ★design
- `docs/superpowers/plans/2026-07-25-agent-consistency-chains.md`
- `docs/superpowers/specs/2026-07-25-agent-consistency-chains-design.md` ★design
- `docs/superpowers/specs/2026-07-25-agent-confirm-loop-hardening-design.md` ★design

</details>

<details><summary>🔒 frozen · 7 份</summary>

- `docs/superpowers/plans/2026-09-28-agent-conversation-ux-p0-p2.md`
- `docs/superpowers/plans/2026-09-16-canvas-operator-2e1-hitl.md`
- `docs/superpowers/plans/2026-09-06-agent-mid-run-interrupt-pv.md`
- `docs/superpowers/specs/2026-08-10-ui-p1-p2-interactions-design.md` ★design
- `docs/superpowers/specs/2026-08-10-ui-p0-interactions-design.md` ★design
- `docs/superpowers/plans/2026-08-07-agent-conversation-isolation.md`
- `docs/superpowers/plans/2026-07-25-agent-confirm-loop-hardening.md`

</details>

### 其他（10 份）

<details><summary>🟢 living · 1 份</summary>

- `docs/superpowers/specs/2026-09-12-fallback-pending-dock-cancel-design.md` ★design

</details>

<details><summary>🔒 frozen · 9 份</summary>

- `docs/superpowers/plans/2026-09-29-pi-events-live-subscribe.md`
- `docs/superpowers/specs/2026-09-29-pi-events-live-subscribe-design.md` ★design
- `docs/superpowers/plans/2026-09-25-d-eta-skill-framework.md`
- `docs/superpowers/plans/2026-09-23-p1-prompt-context-audit.md`
- `docs/superpowers/plans/2026-09-23-p1-nest-http-contract-audit.md`
- `docs/superpowers/plans/2026-09-18-production-gold-test-guide.md`
- `docs/superpowers/plans/2026-09-17-selection-batch-generate.md`
- `docs/superpowers/specs/2026-09-17-selection-batch-generate-design.md` ★design
- `docs/superpowers/plans/2026-09-12-fallback-pending-dock-cancel.md`

</details>

### 视觉输入（识图）（7 份）

<details><summary>🟢 living · 6 份</summary>

- `docs/superpowers/plans/2026-09-29-vision-self-refine-loop.md`
- `docs/superpowers/specs/2026-09-29-vision-self-refine-loop-design.md` ★design
- `docs/superpowers/specs/2026-09-27-sidebar-vision-into-pi-design.md` ★design
- `docs/superpowers/plans/2026-09-16-agent-sidebar-vision-retry-budget-p05.md`
- `docs/superpowers/plans/2026-09-16-agent-sidebar-vision-provider-context.md`
- `docs/superpowers/specs/2026-09-16-agent-sidebar-vision-provider-context-design.md` ★design

</details>

<details><summary>🔒 frozen · 1 份</summary>

- `docs/superpowers/plans/2026-09-24-p1-roadmap-revision.md`

</details>

### 部署与基础设施（6 份）

<details><summary>🟢 living · 4 份</summary>

- `docs/superpowers/plans/2026-09-23-p1-tool-registry-skeleton.md`
- `docs/superpowers/specs/2026-09-19-pi-lnk-fast-ramp-k3s-design.md` ★design
- `docs/superpowers/specs/2026-10-04-metrics-observability-design.md` ★design — 指标可观测性（工具全覆盖 / 上游模型错误 / 静默降级 / Prometheus+Grafana）
- `docs/superpowers/plans/2026-10-04-metrics-observability.md` — 阶段一实施计划（pi-runtime 工具与 LLM 指标，4 个 task）

</details>

<details><summary>🔒 frozen · 2 份</summary>

- `docs/superpowers/plans/2026-07-19-test-infrastructure.md`
- `docs/superpowers/specs/2026-07-19-test-infrastructure-design.md` ★design

</details>

### 长期记忆（4 份）

<details><summary>🟢 living · 4 份</summary>

- `docs/superpowers/plans/2026-10-03-agent-memory-scope-isolation.md`
- `docs/superpowers/specs/2026-10-03-agent-memory-scope-isolation-design.md` ★design
- `docs/superpowers/plans/2026-09-29-agent-tool-p1-read-document-memory.md`

</details>

<details><summary>🔒 frozen · 1 份</summary>

- `docs/superpowers/specs/2026-09-29-agent-tool-p1-read-document-memory-design.md` ★design

</details>

### 上下文工程（3 份）

<details><summary>🟢 living · 4 份</summary>

- `docs/superpowers/plans/2026-10-01-context-engineering-p0-fixes.md`
- `docs/superpowers/plans/2026-09-30-compaction-wiring.md`
- `docs/superpowers/specs/2026-08-06-agent-context-engineering-design.md` ★design

</details>

### 提示词注册表（3 份）

<details><summary>🟢 living · 3 份</summary>

- `docs/superpowers/plans/2026-10-02-w1a-prompt-registry.md`
- `docs/superpowers/specs/2026-10-02-w1a-prompt-registry-design.md` ★design
- `docs/superpowers/specs/2026-10-04-prompt-engineering-design.md` ★design —— 提示词工程规格 + 外部建议稿否决清单

</details>

---

## 状态判定规则

状态由 `gen_index.py` 按优先级判定：

1. **文内自述状态优先** —— 文档开头有 `状态：` / `Status:` 字段的，直接采信：
   - `已实现/ 已交付 / 已上线 / Implemented` → **frozen**
   - `待实现 / 待评审 / 进行中 / 已批准 / 已拍板` → **living**
   - `superseded / 已废弃 / 已取代` → **superseded**
2. **月份 + 主题兜底** —— 7-8 月为迁移期，功能已随代码落地 → **frozen**；
   9-10 月的活跃主题（画布工具 / 提示词 / 记忆 / 上下文 / 视觉 / Agent 交互）→ **living**；
   其余 → **frozen**。

## 重新生成

```bash
python3 gen_index.py > index_data.json   # 重新判定
python3 gen_index_md.py                  # 重新生成本文件
```

新增文档后需重跑，并把新文档登记到 `docs/README.md`。

> ⚠️ **2026-10-04 实测：上面两个脚本在仓库里不存在**（`docs/superpowers/*.py` 为空）。
> 本索引最后更新时手工维护，新增条目需**手工补到对应主题分组**。
> 同批发现的失效指针：`docs/README.md` 的 `superpowers/` 行也写了「索引可重跑」——
> **2026-10-06 已修**：该行与本文档顶部的硬编码份数（283 / 286）一并改为「以 `ls … | wc -l` 实测为准」，
> 顶部「状态总览」加注"基线 2026-10-04、未回填、勿作判据"。**恢复生成器仍是独立待办。**

## 维护约定

- 本索引**不改正文**，只做导航 —— 避免数百份文件大改导致 diff 失控。
- 文档自身的状态写在**开头**（推荐 `**状态：** 已实现（YYYY-MM-DD）`），下次重跑即可被自动识别。
- 发现某份文档的状态判断错了，直接改它的开头状态字段，然后重跑生成脚本。
