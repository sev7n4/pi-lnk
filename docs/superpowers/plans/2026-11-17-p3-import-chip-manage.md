# P3 导入 UI + 技能胶囊条 + 管理技能页 · 实施计划

> 立项日期：2026-11-17。规格：`docs/superpowers/specs/2026-11-17-p3-import-chip-manage-design.md`（待审；本计划随规格同审）。
> 纪律：TDD 红→绿 + 变异 N1–N6 转红 + 全量门禁 + REST 推 PR（保命纪律见 AGENTS.md / delivery.md）。
> 第一原则：每个任务标注复用资产；任何「新造」冲动先回规格 §4.5 对照。

## 0. 排期与触碰面

- 单刀单 PR（docs + server + web 同刀，一次部署窗口）。
- 触碰面：`apps/server/src/agent/**`（多技能映射）、`apps/web/src/components/agent|skills|canvas/**`、web 测试、两份文档。
- 不碰 `services/pi-runtime` ⇒ 不触发 runtime-deploy。

## 1. 任务拆分（TDD）

### T1 · Nest 多技能映射（判据 C4/C5；变异 N3）
- `resolve-force-skills.ts`：新增 `resolveForceSkillsMulti(ids, userMessage, known, runtimeNames)` 纯函数（`/skill` 命令优先 + 胶囊并入去重 + 未知名 fail-soft 过滤）；旧 `resolveForceSkills` 变为其单元素特例（内部委托，行为逐字不变）。
- `agent.service.ts`：DTO 增 `skillIds?: string[]`（保留 `skillId` 兼容 = ids[0]），调用点换 Multi 版。
- 复用：`resolveDockSkillTarget`（三参 runtimeNames）原样白拿。
- TDD：纯函数测试（多胶囊/命令+胶囊并存/未知名过滤/去重）红→绿；集成测试 skillIds 端到端。

### T2 · web 技能选中状态模型（判据 C2/C3；变异 N2）
- `AgentSideRail.vue`：`activeSkillId: string|null` → `selectedSkillIds: string[]`（兼容 computed `activeSkillId = selectedSkillIds[0] ?? null` 保 placeholder/特判消费面）。
- 追加/移除/清空三个动作函数；发送成功后清空（C3 一次性语义）。

### T3 · 技能选择 sheet（判据 C1；变异 N1/N6）
- `+` 卡【技能】行：inline 子菜单 → 打开 `SkillPickSheet`（新组件，容器沿 attachCard Teleport + neo-popover 模式）。
- 数据源 **props 传入 dockSkills**（禁独立拉取/硬编码）；已选项标记；点已选 = 移除。
- 底部固定【管理技能】按钮（emit → 打开管理视图）。

### T4 · composer 胶囊条（判据 C2/C3/C10）
- composer 输入区上方 chips 行（AgentSideRail 内，MentionInput 之上的既有布局槽）：胶囊 = 图标 + 名 + X，design-tokens 令牌样式（图1 参照）。
- 空 chips 行不渲染（零占位）。

### T5 · 管理视图 mine tab 重构（判据 C6/C7/C8；变异 N4）
- `SkillDiscoverPanel.vue` mine tab：列表行 → 网格卡片 + 首字母头像（令牌色板哈希取色）+ 胶囊开关（setEnabled）+ 分组（sourceType：paste/zip/url/github vs market）+ 搜索过滤（前端）。
- 批量管理模式：多选 → 批量卸载（复用 `uninstallBatch` + 既有 confirm 弹窗）；单卸载保留。
- 既有 `SkillDiscoverPanel.test.ts` 断言逐条迁移（market tab 行为零变更）。

### T6 · 导入弹窗（判据 C9；变异 N5）
- 新 `SkillImportDialog.vue`：textarea + 提交 → `skillApi.import(text,'paste')` → 成功 toast + emit refreshed → mine 重拉；失败原样呈现服务端 message。
- mine tab 顶栏【导入技能】按钮打开。

### T7 · 管理入口接线（判据 C6）
- sheet 底部【管理技能】→ 打开技能面板（桌面侧栏面板 / 移动 DiscoverPane skillsOpen）并定位 `initialTab='mine'`（props 已支持，白拿）。

### T8 · 变异自检 N1–N6
- 副本备份恢复法（/tmp/mut-backup，勿 git checkout）；6/6 转红 + 恢复后受影响集复绿。

### T9 · 门禁 + PR + 部署 + 生产冒烟
- web 全量 + server 全量 + `vue-tsc -b` + `tsc --noEmit` + design-token 测试。
- REST 推 PR：**文件清单从 diff 全集生成**（#929 漏 blob 教训）；推前逐路径 blob 比对；推后 compare 核验 DELTA + 并行 KEPT。
- CI 3/3 → squash 合并 → deploy 双 job → 生产冒烟：`skillIds` 端到端（自签 token 发两条多胶囊消息验 `lane.skill` 数组生效）+ web chunk 标记（SkillPickSheet/胶囊/uninstallBatch 调用）。

## 2. 判据映射

| 任务 | 判据 | 负例 |
|---|---|---|
| T1 | C4/C5 | N3 |
| T2/T4 | C2/C3 | N2 |
| T3 | C1 | N1/N6 |
| T5 | C6/C7/C8 | N4 |
| T6 | C9 | N5 |
| T7 | C6 | — |

## 3. 验证命令备忘

```bash
# web 单测（nvm node24 + 单线程）
env -u NODE_OPTIONS ./node_modules/.bin/vitest run <file> --maxWorkers=1 --no-file-parallelism
# 类型：web 用 vue-tsc -b（勿加 --noEmit）；server 用 tsc --noEmit
# 生产取证：SSH deploy-cvm；docker exec lnkpi-api（镜像 tag=commit sha）
```

## 4. 授权闸门

- **G0**（本计划 + 规格评审）：用户审过才动代码。
- **G1**（合并）：CI 全绿后 squash 合并（总授权已含）。
- **G2**（部署 + 生产冒烟）：随 G1 自动推进，冒烟结果回填规格 §8。
