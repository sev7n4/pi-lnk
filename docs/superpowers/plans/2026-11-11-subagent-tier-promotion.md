# spawn_subagent 提回常驻 · 实施计划

> 依据规格：`docs/superpowers/specs/2026-11-11-subagent-tier-promotion-design.md`
> 类型：代码刀（services/pi-runtime 2 文件 + docs 2 文件）· CI 全绿后停在合并前等单独授权

## Global Constraints

- 主仓工作树源码不可信：编辑前已从 master 恢复 tiering.ts / tiering.test.ts 干净基底（blob 全等核验过）；推送走 REST（blob→tree→commit→ref→PR），推前逐路径裸 blob sha 比对 master。
- tiering.ts Set 块内注释禁出现带引号字符串（verify-tool-tiering 名单解析器会把引号内容当 Set 成员）。
- 纯追加纪律：两份 docs 只追加/续接，零删除既有文本。
- 测试纪律：`--maxWorkers=1 --no-file-parallelism`；node24 绝对路径；变异自检必做。

### Task 1：tiering.ts 提回常驻 + 回归锁测试（TDD）

- [ ] **Step 1** 先写测试（RED）：`tiering.test.ts` 仿 `get_canvas_summary 必须常驻` 用例，新增 describe「C4 spawn_subagent 提回常驻（2026-11-11 可达性修正）」：断言 `ALWAYS_ON_TOOL_NAMES.has("spawn_subagent")` + 断言 `buildToolEnsemble(fakeTools(), true).activeToolNames` 含 spawn_subagent。跑 `npx vitest run src/tools/tiering.test.ts --maxWorkers=1 --no-file-parallelism`，确认新用例 RED。
- [ ] **Step 2** 改 `tiering.ts`：在 `"propose_plan",` 条目后插入 spawn_subagent 条目 + 归属理由注释（无引号：C4 调研可达性、唯一入口性、group_nodes 同构先例、部分替代⇒幻觉风险、生产取证 spawned 0 / tool_search hit 4 / spec 路径）。跑测试确认全绿。
- [ ] **Step 3** 变异自检：临时从 ALWAYS_ON 移除 spawn_subagent ⇒ 新用例必须 RED；还原 ⇒ GREEN。
- [ ] **Step 4** 守卫与类型：`npx tsx scripts/verify-tool-tiering.ts`（解析数字合理、无 error）+ pi-runtime `tsc --noEmit` 过。

### Task 2：docs 纯追加注记

- [ ] **Step 1** C4 spec（`docs/superpowers/specs/2026-10-10-c4-subagent-design.md`）frontmatter/标题后追加状态注记：tier 归属缺陷发现（生产取证四件套）+ 本刀修复记录。基线 blob 与 master 核对全等后编辑。
- [ ] **Step 2** 路标规格（`docs/superpowers/specs/2026-11-11-task-planning-engineering-roadmap-design.md`）§5 阶段 B 追加一行：B-4 可达性修正刀落地记录（PR 回填占位，合并后补 SHA）。

### Task 3：分支、REST 推送、PR、CI、收口

- [ ] **Step 1** 本地提交（改 4 文件 + 新增 spec/plan 2 文件 = DELTA 6 路径）；分支名 `fix/subagent-tier-promotion`。
- [ ] **Step 2** REST 推送：5 步链 + 推后 compare 核验 DELTA 恰 6 路径 + ALL_PARALLEL_KEPT；PR body 回读长度。
- [ ] **Step 3** 盯 CI 三检查全绿；**停在合并前等用户单独授权**（代码刀触发生产行为变更）。
- [ ] **Step 4**（授权后）squash 合并 → 合并树==head 树核验 → runtime-deploy 发新镜像 → 生产复测按规格 §5.5 判据（dist tiering.js 常驻集命中 spawn_subagent + health/metrics）→ 删分支 → 日志与报告回填。

## Review Focus

1. Set 块注释无引号字符串（守卫解析器安全）——`sed -n` 抽查插入段。
2. 新测试 RED→GREEN + 变异自检留痕（输出贴进 PR 正文）。
3. docs 零删除（numstat 第二列：C4 spec/路标规格 = 0 或仅续接行）。
4. verify-tool-tiering 通过且「可下沉候选」列表出现 spawn_subagent 属预期提示非错误（本刀裁决即不下沉）。
5. 零 Nest 侧改动：确认 DELTA 不含 apps/**、packages/**、prompt-registry/**。

## Self-Review

- 判据防恒真：测试断言直接打 ALWAYS_ON_TOOL_NAMES 与 activeToolNames 两个面（非只测常量存在），变异自检证明非恒绿。
- 与 #836 结论的衔接：#836 归因「零点名」为表层；本刀把结构根因（延迟集）钉死并修复，两者不矛盾（零点名是延迟集下不可达的充分条件之一）。
