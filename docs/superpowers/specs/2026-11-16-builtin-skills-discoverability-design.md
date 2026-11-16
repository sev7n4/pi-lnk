# 内置技能可发现性与显式调用闭环：规格（v2 有界补充，13 节）

> 定位：本文件是 `2026-11-16-creative-skills-ecosystem-discovery-loading-design-v2.md`（下称「v2 主规格」）的**有界立项补充**，不改动 v2 本体。解决 v2 主线一个此前被忽略的基准线缺口：**项目自带的 11 个 golden 技能能否被发现、并经 `+` / composer `/` 显式加载真正生效**。
> 状态：规格草案，待用户审。审过后再按计划立项实施。
> 事实截止：2026-11-16；GitHub 真实 master `6e814d32`；生产 pi-runtime pod `pi-lnk-runtime-796d59486d-kztjv`（4h27m，1/1 Running）。

---

## 0. 一句话结论与证据锚

**结论**：当前这条基准线是断的。11 个内置技能在生产运行时全部可加载（`/skills` 实测返回 11 项），但界面层既发现不到（不在市场、不在「我的技能」、`+` 下拉只列 1 项），也无法经 `+` 显式生效（未映射的 skillId 返回 `undefined` → 不注入 `forceSkills`，退化为模型隐式匹配）；`/skill <name>` 文本命令服务端对 11 项都有效，但 web 端没有任何 `/` 触发器或候选列表。

**证据锚（均为本轮只读实测/逐字读码）**：

| 锚 | 事实 | 来源 |
|---|---|---|
| E1 | 生产 `/skills`（容器内 8100 端口）返回 11 项，含全部 drama-*×7 / ecommerce-product-photo / html-craft / research-delegate / task-decomposition | `kubectl exec ... node fetch('http://127.0.0.1:8100/skills')`，HTTP 200 |
| E2 | `Dockerfile` 为 `COPY skills ./skills`，11 个 `SKILL.md` 全进生产镜像 | `services/pi-runtime/Dockerfile:15,25` |
| E3 | `AGENT_SKILLS` 前端硬编码白名单**仅 1 项** `product-visual → ecommerce-product-photo` | `apps/web/src/constants/agentSkillMap.ts` |
| E4 | `dockSkills = mergeAgentSkills(AGENT_SKILLS, skillApi.mine())`；`mine` 来自 `UserInstalledSkill` 表，内置技能无任何 seed 落该表 | `AgentSideRail.vue:952-962`；`skills.service.ts` 无内置 seed |
| E5 | `resolveDockSkillTarget` 只映射 `product-visual` 与用户已装技能名；其余 skillId → `undefined` → `resolveForceSkills` 不注入 → 原文发送（隐式兜底） | `agent-skill-map.ts`；`resolve-force-skills.ts:24-30` |
| E6 | `/skill <name>` 文本命令由 `parseSkillCommand` 解析，`knownNames = listSkills() + 用户技能名` 校验，对 11 项内置技能均通过 | `agent.service.ts:3587-3600`；`resolve-force-skills.ts:13-22` |
| E7 | web 全目录无 `/` 触发器/候选列表（仅 `@` mention 由 `MentionInput.vue:106` 实现） | grep 全 `apps/web/src` 无 slash 唤出逻辑 |
| E8 | Nest `SkillsController` 现 11 端点，无「运行时内置技能列表」端点；`pi-runtime.client.ts` 已有 `listSkills()` 现成方法 | `skills.controller.ts`；`pi-runtime.client.ts:470-481` |
| E9 | 发现页两区数据源 = `catalog` + `mine`，均不含内置技能 | `SkillDiscoverPanel.vue:32-51` |

---

## 1. 目标（全部可验收）

1. **G-发现**：用户能在界面列举出运行时实际加载的全部技能（11 项，随运行时增减自动变化，不靠前端硬编码）。
2. **G-+生效**：在 `+` 技能下拉中点选任一内置技能，本轮 `forceSkills` 注入该技能名，`lane.skill()` 可显式调用其正文；点选不可点选技能（`userInvocable=false`）时不列入。
3. **G-/生效**：composer 键入 `/` 唤出候选列表（数据源与 `+` 同一），选中后等价 `forceSkills` 注入；服务端文本命令 `/skill <name>` 行为不变。
4. **G-单一事实源**：内置技能清单只有运行时 `listSkills()` 一个来源；前端 `AGENT_SKILLS` 不再作为内置技能的穷举白名单（保留为 UI 展示兜底/兼容项，不阻断动态列表）。
5. **G-fail-soft**：运行时不可用 / `listSkills()` 失败时，界面不崩、回退到既有内置兜底、对话不阻断（沿用 M1-3 fail-soft 口径）。

---

## 2. 范围

### 2.1 本规格交付
- Nest：`GET /skills/runtime` 薄转发端点，转调已有 `piRuntimeClient.listSkills()`，统一信封 `{code,message,data}`，`data = {skills:[{name,description}]}`。
- web：`skill-api.ts` 增 `runtimeList()`；`AgentSideRail.vue` 的 `dockSkills` 由「运行时列表 ∪ 用户已装技能」合并去重生成；`MentionInput.vue` 增 `/` 触发器与候选列表（或等价 composer 接入点，实施期以 plan 为准），选中回写技能选择。
- 判据：行为级用例 + 可转红负例（§10）+ 变异自检（§11）。

### 2.2 明确不做
- **不改 v2 主规格任何正文**；本补充只引用其判据编号。
- 不新增 runtime registry / `skills/**` 加载逻辑（v2 §9 已裁定 runtime 层不改，禁造等价物）。
- 不在市场 `catalog` 表塞内置技能行（内置≠用户安装；不制造双源）。
- **不新造任何 §4.5 清单所列资产的等价物**（第二套 unwrap、第二个候选列框、独立白名单机制等一律禁止）。
- 不做 G3 golden frontmatter 重写（属另一刀，触发 `runtime-deploy`、需单独授权；见 §7 依赖）。
- 不实现 `/` 命令的权限绕过：候选列表过滤继续由 A9 裁决链（`disableModelInvocation` / `userInvocable`）把关。

### 2.3 发布面与授权边界
- 改动落在 `apps/server/**` + `apps/web/**` ⇒ 合并触发 `deploy.yml`（server/web 双 job）。**合并与部署需单独授权**，本规格/计划阶段不触发。
- 不触及 `services/pi-runtime/**` ⇒ 本刀**不**触发 `runtime-deploy`。

---

## 3. 事实基座（承接 v2 §3，不与之冲突）

- 上游 `formatSkillsForSystemPrompt(getResources())` 每轮重建 index（v2 U-* 已证），内置技能对模型隐式可见——这是"隐式兜底"能工作的原因，但**不等于 UI 可发现**。
- `forceSkills` 是"显式意图入口"，最终仍收敛到 `lane.skill()`（v2 U-7）；本刀只负责把一个真实的运行时技能名送进这个入口，不改入口本身。
- 生产取证：11/11 内置技能在容器内可读可由 `/skills` 列出（E1/E2），说明"发现不到"纯属宿主 UI 接线问题，不是资产缺失。

---

## 4. 规范与判据规则

### 4.1 单一事实源（本刀新增硬约束）
内置技能清单**必须**来自运行时 `listSkills()`。禁止把 11 个名字硬编码进 `AGENT_SKILLS` 或任何前端常量作为穷举来源。`AGENT_SKILLS` 允许保留为“展示兜底项”（当运行时列表为空时仍可见），但不得成为新增/删除内置技能时需要同步修改的地方。

### 4.2 合并去重规则
`dockSkills` 与 `/` 候选 = 运行时技能（映射为 `AgentSkillDef`，`runtimeSkillId = name`）∪ 用户已装技能（`mergeAgentSkills` 现有逻辑）。去重键 `runtimeSkillId`；内置技能优先于同名用户技能（沿用 M1-3 "内置是事实源"口径）。过滤条件保留：`enabled=false`、`disableModelInvocation=true`、`userInvocable=false` 不进点选列表。

### 4.3 显式生效口径
点选后 `skillId = runtimeSkillId`，服务端 `resolveDockSkillTarget` 需使"运行时已知技能名"也能 pass-through（当前只 pass 用户技能名与 `product-visual`）。实现期二选一：① `resolveDockSkillTarget` 并入 `listSkills()` 已知名；② 让 `knownNames` 在 `resolveForceSkills` 前完成对 `skillId` 的校验并直接注入。**不得**让未知名静默进 `forceSkills`（保持 fail-closed→fail-soft 原语义）。

### 4.4 `/` 命令兼容
服务端 `parseSkillCommand` 行为逐字保留（`/skill <name> [rest]`）。web `/` 候选选中后应生成等价的显式意图——优先走 `activeSkillId` 通道（与 `+` 同一出口），而非伪造文本命令，避免双实现漂移。

### 4.5 上游资产复用清单（硬约束：吃满上游、不重复造轮子）

第一原则（用户 2026-11-16 拍板）：**本刀每一个改动面，必须先声明复用哪个既有资产；凡是既有资产能覆盖的，禁止新写等价物。** 清单如下，实施期逐项对照，PR 描述需逐条自证：

| 本刀需求 | 复用的既有资产（吃满） | 禁止新造 |
|---|---|---|
| 运行时技能清单 | `piRuntimeClient.listSkills()`（`pi-runtime.client.ts:470`，现成方法，生产 `/skills` 已在用） | 任何新的 runtime 查询协议/直连通道 |
| Nest 端点信封/鉴权 | controller 既有 `SkillEnvelope`、per-route `AuthGuard`、`unwrapSkillEnvelope` | 新信封格式、新守卫 |
| server skillId 校验白名单 | `resolveForceSkills` 已用 `client.listSkills()` 做 `knownNames`；`withUserSkillNames` 已做「内置+用户名」并集——本刀只把运行时名并入既有并集 | 新的独立白名单机制 |
| web API 层 | `skill-api.ts` 既有 `unwrapSkillEnvelope` / `SkillApiError` 模式 | 第二套 unwrap/错误类型 |
| `+` 下拉合并 | `mergeAgentSkills` 既有去重/过滤/内置兜底逻辑（A9 已含 `userInvocable` 过滤），`mergeRuntimeSkills` 只做「运行时名 → AgentSkillDef 映射 + 并入」 | 第二套合并/过滤实现 |
| `/` 候选 UI | `MentionInput.vue` 既有 `@` 触发检测（`detectMention`）、候选列框（`mention-candidate-listbox`）、键盘导航/选中回写机制——`/` 仅按触发字符分支复用同一列框 | 第二个候选列框组件、第二套键盘处理 |
| 显式生效链路 | `resolveDockSkillTarget → resolveForceSkills → forceSkills → lane.skill()` 全链现成（M0 已证 `lane.skill` 显式收敛 + `UnknownSkill` fail-closed） | 改动 lane.skill 语义、绕过裁决链 |
| 失败降级 | M1-3 `loadDockSkills` 既有 fail-soft 回退 `AGENT_SKILLS` 结构 | 新降级机制 |
| 显式调用裁决字段 | A9（同刀）：`resolveInvocationMode` 消费 `userInvocable`、frontmatter `user-invocable` 识别、web 点选过滤 | — |

评审判据：若某改动无法归入上表任一行（即找不到可复用资产），须先在 plan 里说明为何必须新造，否则视为违规。

---

## 5. 架构与契约

### 5.1 数据流（文字版，实施期补图）

```
pi-runtime /skills  (11 内置, 事实源)
        │  piRuntimeClient.listSkills()
        ▼
Nest GET /skills/runtime  →  { code:0, data:{ skills:[{name,description}] } }
        │  skillApi.runtimeList()
        ├──────────────────────────────┐
        ▼                              ▼
AgentSideRail dockSkills          MentionInput `/` 候选
= 运行时 ∪ mine（去重+过滤）      = 同一合并结果
        │  skillId = runtimeSkillId    │
        └──────────────┬───────────────┘
                       ▼
        resolveDockSkillTarget(skillId, knownNames)
                       ▼
        resolveForceSkills → forceSkills=[name] → lane.skill()
```

### 5.2 新增接口 `GET /skills/runtime`
- 鉴权：沿用 controller 既有 per-route `AuthGuard`（与 `mine` 一致；不同于 `catalog` 的无守卫读）。
- 入参：无。
- 出参：`SkillEnvelope<{ skills: Array<{ name: string; description: string }> }>`。
- 失败：runtime 不可达 ⇒ `code!==0` 业务错误（`SkillApiError`），web 侧 fail-soft 回退内置兜底。

### 5.3 与 A9 裁决链的耦合
运行时 `listSkills()` 只返回 `name + description`，**不含** `user-invocable` / `disable-model-invocation`。本刀的 `/` 与 `+` 列表过滤因此只能覆盖"用户已装技能"（其字段来自 DB，A9 已修）；内置技能的控制字段生效依赖 G3 golden frontmatter 重写 + Nest 解析暴露（§7）。本刀不越界宣称内置技能已遵守 `userInvocable`；判据按 §10 的边界写。

---

## 6. 主场景验收

- **场景 A（`+` 显式）**：打开 composer `+` → 技能，列表含全部 11 项；点 `drama-script-writing`，发消息，本轮轨迹出现 `forceSkills=['drama-script-writing']` 且 `lane.skill()` 命中其正文。
- **场景 B（`/` 显式）**：composer 键入 `/` 弹出同一列表，选中 `html-craft`，等价注入并生效；直接手打 `/skill html-craft 做一个页面` 行为不变。
- **场景 C（动态性）**：运行时新增/移除一个技能并 reload，界面列表随之变化，无需改前端代码（静态 ratchet 守卫证明无硬编码 11 项）。
- **场景 D（fail-soft）**：`/skills/runtime` 返回错误时，下拉回退到 `AGENT_SKILLS` 兜底、对话不阻断。

---

## 7. 依赖关系（诚实边界）

- **前置**：A9 判定链修复（本地 `cd86653`，未推）应先合入——否则 `+` 列表的 `userInvocable=false` 过滤无法无矛盾叠加。本刀可与之同 PR 或在其后，plan 给两种排期。
- **下游**：G3 golden frontmatter 重写（11 个 `SKILL.md`，触发 `runtime-deploy`，需单独授权）是"内置技能遵守调用控制字段"的必要条件，属**另一刀**，不在本规格交付内。本刀不宣告 A9/P12 全绿。

---

## 8. 纯函数与算法

- `mergeRuntimeSkills(runtime: RuntimeSkill[], installed: InstalledSkillLike[], builtin: AgentSkillDef[]): AgentSkillDef[]`（web 纯函数，可单测）：映射 + 去重 + 过滤 + 内置兜底，规则按 §4.2。
- `resolveDockSkillTarget(skillId, userSkillNames, runtimeNames?)`（server 纯函数，扩展第三参）：命中顺序 内置映射 → 用户名 → 运行时名；均未命中 → `undefined`。
- 两者均需 TDD 红→绿 + 变异转红（§11）。

---

## 9. 文件级改动清单（预估，实施期以 plan 为准）

| 层 | 文件 | 动作 |
|---|---|---|
| Nest | `apps/server/src/skills/skills.controller.ts` | 新增 `GET /skills/runtime` |
| Nest | `apps/server/src/skills/skills.service.ts` | 新增 `listRuntimeSkills()` 转调 client |
| Nest | `apps/server/src/agent/agent-skill-map.ts` | `resolveDockSkillTarget` 增运行时名 pass-through |
| Nest | 相关集成测试 + 纯函数测试 | 新增判据/负例 |
| web | `apps/web/src/services/skill-api.ts` | 增 `runtimeList()` + 类型 |
| web | `apps/web/src/constants/agentSkillMap.ts` | 增 `mergeRuntimeSkills()` 纯函数 |
| web | `apps/web/src/components/agent/AgentSideRail.vue` | `dockSkills` 改动态合并 |
| web | `apps/web/src/components/canvas/MentionInput.vue`（或 composer 等价接入点） | `/` 触发器 + 候选列表 |
| web | 对应 `.test.ts` | 组件/纯函数判据 |
| 文档 | 本规格、`docs/README.md` 登记 | 本刀（另 PR） |

---

## 10. 测试策略与验收判据

### 10.1 行为级判据（B1–B7，全部可通过才算本刀达标）

| 编号 | 判据 | 观测点 |
|---|---|---|
| B1 | `GET /skills/runtime` 返回运行时 11 项（逐名对照 E1） | 集成测试 + 生产冒烟 code:0 |
| B2 | `+` 下拉含全部运行时技能（11/11），不靠硬编码 | 组件测试 + 静态 ratchet |
| B3 | 点选内置技能 → `forceSkills` 含该名 → `lane.skill()` 命中正文 | 集成测试 + 生产轨迹 |
| B4 | `/` 唤出候选 = 同一合并列表；选中与 `+` 走同一 `activeSkillId` 出口 | 组件测试 |
| B5 | `userInvocable=false` / `disableModelInvocation=true` 的已装技能不进点选 | 纯函数测试（A9 复用） |
| B6 | 运行时列表错误 → 回退 `AGENT_SKILLS` 兜底、不阻断对话 | fail-soft 测试 |
| B7 | 运行时增删技能后界面随之变化（无前端改动） | 静态守卫（无 11 项硬编码）+ 单测 mock 变更 |

### 10.2 可转红负例（N1–N5，须实测 RED）

| 编号 | 变异 | 期望转红的判据 |
|---|---|---|
| N1 | `GET /skills/runtime` 改返回空数组 | B1/B2 RED |
| N2 | `dockSkills` 退回硬编码 `AGENT_SKILLS` | B2/B7 RED |
| N3 | `resolveDockSkillTarget` 去掉运行时名 pass-through | B3 RED |
| N4 | `/` 候选用独立硬编码列表（非合并源） | B4/B7 RED |
| N5 | 合并函数去掉 `userInvocable=false` 过滤 | B5 RED |

### 10.3 门禁
server 全量 + web 全量 + `vue-tsc -b` + 设计令牌门禁 + 变异 N1–N5 全 RED；沿用 `vitest --maxWorkers=1 --no-file-parallelism` / `env -u NODE_OPTIONS`。

---

## 11. 风险

- **R1 双源漂移**：若 `AGENT_SKILLS` 既作兜底又被动态列表覆盖，同名项可能两处定义。缓解：§4.1 硬约束 + 静态 ratchet 禁新增硬编码名。
- **R2 `/` 与 `@` mention 冲突**：`MentionInput.vue` 已有 `@` 触发，新增 `/` 需共享候选列表框但不抢 `@`。缓解：复用同一 detect 逻辑、按触发字符分支。
- **R3 A9 未合导致过滤矛盾**：本刀列表过滤依赖 A9 的 `mergeAgentSkills` 已含 `userInvocable`。缓解：§7 前置约束。
- **R4 控制字段缺口被误读为已修**：内置技能无 frontmatter 控制字段解析（E 表 + §5.3）。缓解：判据 B5 只覆盖已装技能；诚实边界写入走查结论，不宣告 P12 全绿。

---

## 12. 路线图与收口口径

- 本刀（规格→计划→实施→PR→部署）达成 B1–B7 + N1–N5 即"内置技能可发现 + 显式调用闭环"达标。
- **不等于 M1 全绿**：P3 自定义导入 UI、G3 golden 重写、G4–G6 判据仍各自独立；本规格只闭合"已有技能可被发现并显式加载"这一条基准线。
- 收尾前仍需 v2 主规格 §10 M1-A1–A11 / N1–N13 全序列复测。

---

## 13. 配图规范自检

- 本补充仅 1 张文字版数据流（§5.1），无正式图号；实施期若补图，沿用 v2 主规格图号连续性与「配图索引」登记要求。
- 所有判据均可定位到文件/端点/测试，无空项。
