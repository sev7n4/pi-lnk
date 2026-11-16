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

### 8.3 M1-2 实施记录（2026-11-16，runtime 通道）

**交付**（`services/pi-runtime/**`，手工 dispatch `runtime-deploy`）：

- `skills/inject.ts`（新建）：`IncomingSkill`（上游 `Skill` 子集：name/description/content/filePath?/disableModelInvocation?）+ `parseIncomingResources`（畸形逐条 400：缺 name/description/content、重复名、超 24 条、content 超 64KB）+ `mergeSkillResources`（Map 按 name 去重，内置先入保序、传入后入覆盖同名——用户显式安装优先；覆盖项保持内置索引位置）+ `user-skills.json` sidecar 读写（U-11 两层持久化的磁盘侧）。
- `session-manager.ts`：`CreateOptions.resources` 透传；`build()` 统一解析（create 带 resources ⇒ 采信+落 sidecar；resume/重建不带 ⇒ 读 sidecar 恢复——重启后 Nest 不会重发 payload，磁盘是唯一恢复源）；resources 注入点改为 `mergeSkillResources(builtinSkillList(), userSkills)`；新方法 `setUserResources`（全量换集 U-6，busy/compacting 拒绝与 prompt 同口径，先换内存集再落盘——磁盘落后一拍可接受、反向不可）。
- `app.ts`：create body `resources`（缺省=resume 读 sidecar 语义；提供=全量换集）；新内部端点 `POST /sessions/:sessionId/resources`（body `resources` 必填，`{}`=显式清空；404/409/400/503 映射）。
- `metrics.ts`：`pi_runtime_user_skills_swap_total{outcome=ok|busy|error}`。

**验证**：

- pi-runtime 全量 **2086/2086**（master 2052 + 新增 34：inject 15 + manager 8 + 路由 5 + okFactory 既有）；tsc 干净。
- 行为级：A2 前置（create 注入含传入 Skill 且 content 逐字不 trim）/ 契约 2（同名覆盖：用户版替换内置行、不追加）/ U-11（新 manager 磁盘 resume 恢复用户技能集；负例=无 resources 仅内置）/ A11 前置（setUserResources 全量换集新名入旧名出 + sidecar 更新）/ busy 拒绝（manager 级含 metrics busy + 路由级 409 不触碰 harness）/ 显式空集清空（保留内置）。
- 变异 3/3 转红：合并优先级反转（1 红）/ 去 busy 检查（2 红）/ resume 不读 sidecar（1 红）；恢复后 76/76。

**吃满上游的落点**：形状=`Skill`/`Resources`/`setResources(resources, context)` 全部上游原语，宿主只做校验+合并+sidecar；解析/索引/显式调用/未知名拒绝零重写（§4.8）。Nest 侧 `buildSkillResources(userId)` 组装属 M1-2 的 Nest 半刀（本刀只铺 runtime 受端；Nest→runtime 调用方接线随 M1-3 web 双面刀一并评估——届时 Nest 发起方才有真实调用场景，避免空转接线）。

---

## 8.4 M1-3 实施记录（2026-11-16，web 双面 + Nest 发起方接线）

### 8.4.1 开工评估（计划 §8.3「随本刀一并评估」的裁决）

M1-1 只落控制面数据/端点、M1-2 只铺 runtime 受端，**Nest 发起方接线**（`buildSkillResources` + create 透传）在 master 上完全缺位（`grep buildSkillResources apps/server/src` 零命中）。若本刀只做 web UI，用户「一键启用」后模型永远看不到该技能（空转接线）——正是计划 §8.3 要避免的。故裁决：**本刀补齐发起方接线**。

另一裁决：**不调 `setResources` 即时生效**。计划 §7.2 已把「会话中途启停是否立即重算 index」降级为产品选择，启停后「下一轮新会话重建」自然生效即可；runtime 的 `POST /sessions/:id/resources`（M1-2 已铺）留作后续产品选择，本刀不触碰活跃会话，降低竞态面。

### 8.4.2 交付清单

**server（发起方接线）**
- `skills/skills-resources.ts`（新建）：纯函数 `assembleSkillResources(rows) → Skill[]`——跳过 `enabled=false`、按 `name` 去重（installedAt 新者胜出）、按 installedAt 降序裁剪 ≤12、`description=summary||displayName||skill`（runtime 非空校验）、虚拟 `filePath=<virtual>/<name>/SKILL.md`、`disableModelInvocation` 逐字透传。
- `skills/skills.service.ts`：`buildSkillResources(userId)`——查 `UserInstalledSkill(uninstalledAt=null)` ⋈ `SkillPackage(pinnedHash)`，`sha256("v1:"+skill+":"+body.trimEnd())` 逐字校验（不符跳过 = fail-closed），再喂纯函数。
- `agent/pi-runtime/pi-runtime.client.ts`：`CreateSessionOptions.resources?: UserSkillResources` + createSession body 透传（不传则 body 无该键，M0 行为逐字节不变）。
- `agent/agent.service.ts`：@Optional 注入 `SkillsService`（AgentModule imports SkillsModule，无环——后者仅依赖 @Global PrismaModule）；会话创建前 `buildUserSkillResources(userId)`（fail-open：未装配/查库异常/空集 → undefined），结果透传 ensurePiSession → createSession；dock skillId 命中链路用 `resolveDockSkillTarget`（内置映射优先 + 用户技能名 pass-through）+ `withUserSkillNames`（known 白名单并入用户技能名），未知名仍 fail-soft（P1 T2-3 语义不变）。

**web（双面）**
- `services/skill-api.ts`（新建）：用户侧 api 实例 + 信封 unwrap（`code!==0` 抛 `SkillApiError`），对齐 Nest 11 端点；DELETE 的 confirmed 走 query 字符串 `'true'`。
- `components/skills/SkillDiscoverPanel.vue`（新建）：发现页双区——市场区（catalog 卡片 + 兼容评分/版本/发布者 + 安装）与我的技能区（mine 启停/回滚/卸载）；**单一确认弹窗**（cancel 不触发 DELETE、仅 ok 调 remove）。只用 `--lnk-*` design tokens，不动 z-index 语义阶梯。
- `components/mobile/DiscoverPane.vue`：「敬请期待」里的「技能」置灰行激活为可点击，展开 SkillDiscoverPanel；专家/连接器仍置灰，社区流仍为主叙事。
- `constants/agentSkillMap.ts`：纯函数 `mergeAgentSkills(builtin, installed)`——内置打头 + 用户已启用技能追加（`runtimeSkillId=技能名`），跳过 `enabled=false`/`disableModelInvocation=true`，按 runtimeSkillId 去重保留内置。
- `components/agent/AgentSideRail.vue`：技能二级下拉数据源从静态 `AGENT_SKILLS` 改为 `dockSkills` ref（onMounted 拉 `/skills/mine` 合并；失败 fail-soft 回退静态）。静态导入保留，M0 默认技能在异步加载前即可解析。

### 8.4.3 门禁

- server 全量 **2988/2988**（master 2968 + 新增 20：组装纯函数 7 / 发起方接线包装 4 / client 透传 2 / 集成 buildSkillResources 2 / agent-skill-map 5）；web 全量 **511 文件 / 4314/4314**（新增 skill-api 10 / 发现页组件 7 / DiscoverPane +1 / agentSkillMap +5 / 动态下拉接线 3）；design-token 门禁 **126/126**；两端 tsc 干净。
- 变异 3/3 转红：① 去组装 enabled 过滤 → 关闭态测试 1 红；② 去 client resources 透传 → client 测试 1 红；③ 去 web 合并的 enabled 过滤 → 关闭态/隐式拒测试 2 红。恢复后目标测试全绿。

### 8.4.4 诚实边界

- 本刀让「装/启/停/卸/滚」在 UI 与服务端组装层闭环，**未做** golden SKILL.md 重写（M1-4，触发 runtime-deploy，单独授权）；M1-A1–A11 全序列与 M1-N1–N13 逐条转红记录属 M1-4 收口，本刀不宣告全绿。
- 用户技能显式调用链：`dock skillId → resolveDockSkillTarget（pass-through）→ forceSkills → runtime lane.skill`；runtime 侧从 `getResources()` 解析（M0 U-7），未知名由 `UnknownSkill` fail-closed。隐式调用走 `formatSkillsForSystemPrompt`（每轮从 getResources 求值）。
- 不调 setResources 即时生效：当前会话已注入的技能在本轮不撤回（§7.2 矩阵），启停从下一轮新会话生效。

---

## 8.5 M1-4 第 1 块实施记录（2026-11-16，验收走查）

**产物**：`docs/superpowers/plans/2026-11-16-m1-skills-acceptance-walkthrough.md`（验收资产，零代码改动、零部署）。

**方法**：以 master `de30e8f871` 真实源码树（`gh api contents?ref=master` 逐文件拉取，非本地陈旧 checkout）逐条核对 A1–A11 / N1–N13 / §4.7 Must，观测点按 v2 §10.4 替换。判据「测试存在」不等于「判据通过」。

**结论**：**M1 尚不能宣告全绿**。按 §7 口径：
- A1–A11：✅5（A1/A3/A4/A6/A8）/ ⚠️5（A2/A5/A7/A10/A11，其中 A2/A7 为规格 §7.2 允许的语义降级）/ ❌1（A9：userInvocable 判定链断点）。
- N1–N13：完整转红实证仅 N2/N5；部分 N3/N9/N10/N13；**v2 §7.3 删除了 N1/N6/N11/N12 的 v1 变异靶点却未重定义等价靶点**（判据债务）；N4/N7/N8 未逐条实测。
- Must：P3（自定义加载 UI 入口缺失，`skillApi.import` 零调用方）、P12（userInvocable 断点 + golden 未重写）有缺口；Won't P16/P18 有负例，P17/P19 部分。

**七项缺口**（G1 userInvocable / G2 自定义 UI / G3 golden / G4 N 靶点债务 / G5 install 搜索确认 / G6 userModified / G7 已授权的 A2/A7 语义降级）与两条收尾路径见走查记录 §5–§6。本刀只收敛证据与缺口，不改代码、不改判据；G3（golden 重写）仍按计划 §5 单独授权。

**诚实边界**：本刀不宣告 M1 收口；走查发现的是「规格完整契约未逐条闭合」，与三刀「各自实现正确、门禁全绿」不矛盾。
