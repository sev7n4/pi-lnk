# M1 技能控制面实施计划（双通路闭环 + 生命周期 + 发现页）

> 规格依据：`docs/superpowers/specs/2026-11-16-creative-skills-ecosystem-discovery-loading-design-v2.md`（执行面权威）§5.3/§5.4/§7.1–§7.3/§8/§9/§10.4；判据编号沿用 v1 `2026-11-10-...-design.md` §10.3 的 M1-A1–A11 / M1-N1–N13，观测点按 v2 §10.4 替换。
> 原则（用户拍板，沿用 M0）：**不重复造轮子，吃满上游 `pi-agent-core@0.99.2` 原生能力**——index/formatter/lane.skill/skill 内容注入全部已由 M0 收敛到上游原语；M1 只做「控制面 + 数据 + 通道」，不再新增任何注入机制。
> M0 基线：#908 已合入并部署（`resources` 注入点 / 每轮 index 求值 / `lane.skill` 显式调用 / 生产冒烟 §10.3.1）；#909 补 `/prompt` 路由 400 映射。

## 0. M0 之后还缺什么（一句话）

现在 runtime 只认**内置** `SkillRegistry`（/app/skills 11 个）。M1 要让 **Nest DB 里的用户技能**（发现安装 / 自定义上传）出现在同一个 `resources.skills` 通道里，并把「装/停/卸/滚」的生命周期语义按 WorkBuddy 北极星图 4 落全。

## 1. 子刀拆分（4 刀，各自独立发布面 + 独立验收）

| 刀 | 范围 | 发布面 | 验收锚点 |
|---|---|---|---|
| **M1-1 控制面与数据** | Prisma 三表 + migration；Nest `apps/server/src/skills/`（controller/service/import/compatibility/dto）10 端点；§8 纯函数（`verifyImport` / `evaluateCompatibility` / `rankCatalog` / `resolveInvocationMode` / `applySkillOverride` / `assertUninstallGuard`）；审计复用 `AdminAuditLog` | `apps/server/**` ⇒ push 自动 deploy.yml | M1-A1 / A3 / A6 / A8（服务端半）/ A10（端点半） |
| **M1-2 runtime 通道与即时生效** | `/sessions` create body 增可选 `resources.skills`（Nest 组装后透传，runtime 注入 harness options——与 M0 内置 registry 合并去重）；`POST /sessions/:id/resources` 内部端点 → `harness.setResources`（启用/关闭/回滚同会话即时生效）；M0 预留的 `buildSkillResources`/`injectSkillResources` 在此获得调用方 | `services/pi-runtime/**` ⇒ 手工 dispatch runtime-deploy | M1-A2 / A4 / A5 / A7 / A11 的观测点（v2 §10.4 替换后） |
| **M1-3 web 双面** | `skill-api.ts`、发现页（市场区 + 我的技能区）、`DiscoverPane.vue`、`AgentSideRail.vue`、`constants/agentSkillMap.ts`、单一确认弹窗、技能下拉动态渲染 | `apps/web/**` ⇒ push 自动 deploy.yml | M1-A9 / A10 的 UI 面；§6.6 目视验收 |
| **M1-4 golden 与收口** | `skills/**/SKILL.md` 按三层数据契约重写（⚠️ 触发 runtime-deploy，**单独授权**）；M1-A1–A11 全序列行为级走查 + M1-N1–N13 负例转红记录 | 行为级收口，不新增代码 | §10.4 全判据；v1 §4.7 Must 无空项 |

依赖：M1-2 依赖 M1-1 的端点形状；M1-3 依赖 M1-1；M1-4 依赖前三刀。M1-1 与 M1-2 可并行开工（契约先冻结：见 §2）。

## 2. 关键设计决策（先冻结契约）

1. **transport**：Nest `buildSkillResources(userId, sessionKey)` 在**服务端**组装 `Skill[]`（`content` 内联正文、`filePath` 用虚拟路径 `<virtual>/SKILL.md`、`disableModelInvocation` 透传、≤12 裁剪、`contentHash` 逐字校验），经 `/sessions` create body `resources.skills` 传给 runtime；runtime 不查 Nest、不出网（§4.4 第 3 条 egress deny 不变）。**不做**签名/缓存/失效判定（v2 已删 `computeIndexSignature`）。
2. **合并语义**：runtime harness options.resources = 内置 registry `Skill[]` ∪ 传入 `resources.skills`（后者覆盖同名内置项——用户显式安装优先；去重按 `name`）。空集 `{skills:[]}` 合法（M0 行为不变）。
3. **即时生效**：启停/回滚后 Nest 调 `POST /sessions/:id/resources`（带全量新 `Skill[]`），runtime 调 `harness.setResources`（U-6）。**不做增量 diff**——全量换集，旧名自然 `UnknownSkill`（U-6 负例：换集后旧名必拒）。
4. **会话生效边界**：§7.2 矩阵四行照旧（当前会话已注入不撤回=模型上下文里已有的内容；下一轮不再注入；新会话重建；重开即时恢复）。「中途启停是否立即重算 index」由 M1-2 的 setResources 覆盖，不再是产品缺口（v2 §7.2 已降级为产品选择）。
5. **fail-closed 口径**：显式点名未审/已卸载技能 → Nest 层拒（可见理由）；已注入 runtime 的 `Skill[]` 里缺名 → 沿用 M0 的 `InvalidInputError→400`（#909）。两层拒绝都留审计。
6. **不碰**：`skills/loader.ts` 内置解析保留为回落（§9）；runtime 工具清单不增 `uninstall`/`re-enable`（P5 收窄）；`/prompt` body 不扩字段（§7.3）。

## 3. 文件级改动（按刀）

| 刀 | 文件 | 动作 |
|---|---|---|
| M1-1 | `apps/server/prisma/schema.prisma` + migration | 新增 `SkillPackage` / `SkillCatalog` / `UserInstalledSkill`（§7.1 字段：`@@unique([userId, packageHash])`、`onDelete: Cascade`、`override` 只存覆盖键、`uninstalledAt` 软删除） |
| M1-1 | `apps/server/src/skills/{controller,service,import,compatibility,dto}.ts` | 新增 10 端点：`/api/skills`、`/catalog`、`/mine`、`/import`、`/search`、`/:id/install`、`/:id/enabled`、`/:id`(DELETE)、`/uninstall`、`/:id/rollback`（+`:id/invoke` 透传回归见 F17） |
| M1-1 | `apps/server/src/skills/pure.ts`（或分文件） | §8 六个保留纯函数 + 单测（每函数 ≥1 阳 ≥1 阴，判据体与实现体分离） |
| M1-2 | `services/pi-runtime/src/app.ts` | create body 增 `resources?: { skills?: Skill[] }`（zod 校验：name/content 必填，体积上限）；新内部端点 `POST /sessions/:id/resources` |
| M1-2 | `services/pi-runtime/src/session-manager.ts` | `build()` 合并内置 ∪ 传入；`setResources` 包装（busy/compacting 拒绝、审计打点） |
| M1-2 | `services/pi-runtime/src/skills/inject.ts` | 抽 `injectSkillResources(harness, skills)` 纯函数（M0 计划预留项，此处有调用方） |
| M1-3 | `apps/web/src/services/skill-api.ts` + 发现页组件 ×2 + `DiscoverPane.vue` + `AgentSideRail.vue` + `constants/agentSkillMap.ts` | 新增/修改（v1 §9 同） |
| M1-4 | `skills/**/SKILL.md` ×11 | 按契约重写（frontmatter `disableModelInvocation`/`userInvocable`/`capabilities` 补齐） |
| 文档 | 本计划 + 规格 v2 §12 路标状态行回填 + `docs/README.md` 登记 | 随各刀 |

## 4. TDD 判据映射（可转红为门禁）

| 刀 | RED 先行 | GREEN 判据（对应 M1-A/N） |
|---|---|---|
| M1-1 | 跨用户隔离（N2）、卸载守卫（A8）、verifyImport 七类恶意样本（A6/N5 逐类独立转红） | A1 双用户互不可见 + `enabled=false` 默认；A3 两通路除 `sourceType` 外逐字段一致；A6 全拒+审计+可见理由；A10 端点链 catalog→search→install→mine |
| M1-2 | fake harness 去掉 setResources / create 漏传 resources ⇒ A2/A11 红 | A2 启用后同会话下一轮 `getResources()` 含该 Skill 且 content 逐字（hash 校验）；A4 回滚两版本正文逐字区分；A5 订阅集变化新会话 index 含行 + 显式命中不重复注入；A7 §7.2 四行矩阵全序列；A11 换集后旧名 `UnknownSkill`；U-11 回归（resume 后 getResources 非空） |
| M1-3 | 组件测试：关闭态不渲染启用卡片、确认弹窗缺二次确认不触发 DELETE | §6.6 目视 + A9 点选列表触发控制 |
| M1-4 | —（验收资产） | M1-A1–A11 全序列真实走查；M1-N1–N13 逐条转红记录（v2 §10.4 改写后的 N1/N6/N12 观测点） |

## 5. 风险与回滚

- **Nest→runtime 传输正文体积**：`resources.skills` 全量内联 ⇒ create body 上限需设（复用 `bodyLimit` 现值即可，超限 413）；≤12 裁剪在 Nest 侧先行。
- **同名覆盖内置**：用户装了与内置同名的技能 ⇒ 设计决策 2 的「后者优先」必须显式测试（内置 11 个名字撞车样本）。
- **setResources 竞态**：run 在途时换集 —— busy/compacting 拒绝（与 prompt 同口径），闲时才允许。
- **回滚**：M1-1 无 runtime 改动可独立 revert；M1-2 revert 后回到 M0 形态（`resources` 仅内置）；schema migration 必须可前滚（不做破坏性列删除）。
- **授权边界**：M1-4 golden 重写触发 `runtime-deploy`，按惯例单独授权；M1-2 亦走 dispatch（2026-11-16 总授权范围内，逐刀照常审批）。

## 6. 明确不做（本计划）

`SourceAdapter` 外部检索（M3）、AI 创建技能（M4）、虚拟工作区与能力适配器（M2）、四垂类打样（M2）、`skill_search`/`skill_apply_install`/`skill_disable` runtime 工具（P5 收窄项在 M2+ 评估，本包只做 UI+控制面）、开放 UGC、脚本沙箱、MCP 网关、RBAC。

## 7. 诚实边界

M1 全绿 **不得**表述为「已复刻 WorkBuddy 技能系统」或「生态兼容完成」；产出北极星在 M2（四类真实社区 skill 端到端画布产出）；Won't 四类（P16–P19）永久偏离。M1 完成口径 = §10.4 的 M1-A1–A11 全通过 + M1-N1–N13 可转红 + v1 §4.7 Must 无判据空项。

---

## 8. M1-1 实施记录（2026-11-16）

### 8.1 两条实施期裁决（对规格/上游的显式修正，回填本计划）

1. **contentHash 公式勘误（对 v1 §4.3）**：`contentHash = sha256(\`v1:${skill}:${body.trimEnd()}\`)`，不再纯 body。
   理由：contentHash 是 `SkillPackage` 主键，必须含技能身份——纯 body 公式下「不同技能名、相同正文」哈希碰撞
   （PK 冲突 + 错误复用包行，集成测试 A8/A9 首跑实证）。保留判据性质：正文改一字 ⇒ hash 变（M1-A4）；同名同正文幂等。
2. **vendor ESM 消费（对 v2 §8「委托上游 loadSkills」的落地方式）**：生产 Nest 是纯 CJS 运行时
   （Dockerfile 把 workspace 包统一转 CJS 后 tsc 产出 dist），vendor `pi-agent-core@0.99.2` 是 ESM-only
   且 exports map 无 require 条件 ⇒ 直 require 报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
   处置：扩展既有 pnpm patch（`patches/@earendil-works__pi-agent-core@0.99.2.patch`），给 exports
   根入口与 `./dist/*` 加 `require`/`default` 条件，Node ≥22.12 require(esm) 加载（生产 lnkpi-api
   实测 node v22.23.5；`@lnkpi/agent|shared` 同为 ESM 先例）。解析仍全权委托上游 `loadSkills` +
   `NodeExecutionEnv`（临时目录范式），平台只补「name 缺失拒绝」（上游会按目录名派生 name，
   对查找键不可接受）与白名单校验。

### 8.2 交付清单

- `prisma/schema.prisma`：`SkillPackage` / `SkillCatalog` / `UserInstalledSkill` 三表 + migration `20261116160000_skills_control_plane`。
- `apps/server/src/skills/`：`skills-parse.ts`（上游 loadSkills 委托 + hash）/ `skills-pure.ts`（六纯函数）/ `skills.service.ts` / `skills.controller.ts`（十端点）/ `skills.module.ts`。
- `apps/server/package.json`：+`@earendil-works/pi-agent-core@0.99.2`、+`yaml@2.9.0`（与 vendor 同 pin）。
- 测试：`skills-pure.test.ts` 28 例 + `skills.controller.sqlite.integration.test.ts` 9 例（M1-A1/A3/A4/A6/A8/A9/A10 服务端行为级）。
- 门禁：server 全量 2968/2968；tsc 干净；CJS dist 构建冒烟（require(esm) 实跑解析成功）；变异 3/3 转红（N2 跨用户 / A8 confirmed / N5 注入规则短路）。
