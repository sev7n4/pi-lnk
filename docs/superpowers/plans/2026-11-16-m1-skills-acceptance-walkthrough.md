# M1 技能控制面验收走查记录（M1-4 第 1 块：A1–A11 全序列 / N1–N13 转红 / Must 映射）

> **状态**：验收资产（2026-11-16 产出）；**零产品代码改动、零部署触发**。本文是
> `docs/superpowers/specs/2026-11-16-creative-skills-ecosystem-discovery-loading-design-v2.md`（执行面权威）
> §10.4 与 `docs/superpowers/plans/2026-11-16-m1-skills-control-plane.md` §7「M1 完成口径」的逐条核对记录。
> **事实基线**：master `de30e8f871`（#923）的真实源码树，经 `gh api contents?ref=master` 拉取逐文件核对
> （不是本地陈旧 checkout）。判据编号沿用 v1 `2026-11-10-...-design.md` §10.3，观测点按 v2 §10.4 替换。
> **判定口径**：每条判据给出「实测证据路径 + 状态」，状态分 ✅已证 / ⚠️部分 / ❌缺口；
> 只有 ✅ 才计入「已通过」，映射表为空或有缺口的行**不得**计入「复刻完成」（v1 §10.3 第 5 条纪律）。

## 0. 结论先行

**M1 尚不能宣告全绿收尾。** 按计划 §7 写死的完成口径
（M1-A1–A11 全通过 + M1-N1–N13 可转红 + v1 §4.7 Must 无空项），逐条核对结果：

| 口径 | 结果 | 说明 |
|---|---|---|
| M1-A1–A11 全通过 | **未达**（8 条中 ✅3 / ⚠️8 / ❌1，见 §2） | A9 有实质缺口；A2/A7 语义按规格降级为产品选择；A5/A10/A11 有未覆盖子项 |
| M1-N1–N13 可转红 | **未达**（完整变异实证仅 N2/N5，其余靶点已删或未逐条实测，见 §3） | v2 §7.3 删除了 4 个 v1 变异靶点却未重定义等价靶点 |
| §4.7 Must 无空项 | **未达**（P3/P12 有缺口，见 §4） | 自定义加载 UI 入口缺失；`userInvocable` 判定链断点 + golden 未重写 |

这与 M1-1/M1-2/M1-3 三刀「全量测试绿、变异转红、生产取证过」并不矛盾——
那些门禁证明的是**每刀实现正确**，本走查证明的是**规格定义的完整行为契约尚未逐条闭合**。
本刀不修改代码、不改判定，只把事实摆在同一张表上，供收尾决策。

## 1. 取证方法

| 来源 | 路径 / 命令 | 用途 |
|---|---|---|
| 服务端行为级测试 | `apps/server/src/skills/skills.controller.sqlite.integration.test.ts`（真实 sqlite 临时库） | A1/A3/A4/A6/A8/A9/A10/A2 前置 |
| 纯函数测试 | `apps/server/src/skills/skills-pure.test.ts`（28 例） | 六纯函数 + A6 七类恶意样本 |
| 组装层测试 | `apps/server/src/skills/skills-resources.test.ts`、`agent-skill-map.test.ts` | A2/A7/A9 裁剪与去重 |
| 服务端源码 | `skills.service.ts` / `skills.controller.ts` / `skills-pure.ts` / `skills-parse.ts` / `skills-resources.ts` | 判据实现落点、变异靶点存在性 |
| runtime 源码 | `services/pi-runtime/src/session-manager.ts` / `skills/inject.ts` / `app.ts` | U-6 setResources / U-11 resume / create 透传 |
| web 源码 | `apps/web/src/services/skill-api.ts` / `components/skills/SkillDiscoverPanel.vue` | UI 通路（含调用方缺口） |
| 生产取证 | §10.3.1 冒烟、M1-1/2/3 实施记录（§8.1–8.4） | 端点 code:0、三表落库、401、产物标记 |
| 变异实证 | §8.1（N2/A8 confirmed/N5）、§8.2（3/3）、§8.3（3/3） | 已实测转红的判据 |

判定纪律：**「测试存在」≠「判据通过」**——需同时满足观测点按 v2 §10.4 替换后的语义成立。

## 2. M1-A1–A11 全序列走查

| 判据 | 规格语义（v2 §10.4 观测点） | 实测证据 | 状态 |
|---|---|---|---|
| **A1** | 自定义加载→解析/校验/落库；跨用户不可见；enabled=false 默认 | 集成测试 A1「userA 导入→enabled=false 默认；userB getMine 查不到」+「重复导入同 hash 幂等」；`getMine()` `where:{userId,uninstalledAt:null}`；生产 `/api/skills/mine` 无 token→401 | ✅ |
| **A2** | 启用后**同一会话下一轮**命中；content 逐字；不重建会话/不发镜像/不写容器 | v2 观测点 `getResources().skills`：集成测试「A2 前置：buildSkillResources 只含该用户已启用技能，content 逐字等于 body」+「A2 负例：正文被篡改→跳过（fail-closed）」；M0 生产冒烟正例 lane.skill 全文块注入 | ⚠️ **语义降级**：M1-3 裁决不调 setResources，启停从**下一轮新会话**生效（规格 §7.2 明确允许的产品选择，不违反矩阵「不得继续注入已关闭正文」）。「不重建会话/不发镜像/不写容器」满足；但「同会话下一轮」未落地 |
| **A3** | 发现通路与自定义通路同表同通道，仅 sourceType 不同 | 集成测试 A3「catalog 安装与 paste 导入落同一张表，仅 sourceType/trustLevel 不同」 | ✅ |
| **A4** | 回滚 pinnedHash→旧版正文逐字 | 集成测试 A4「回滚切 pinnedHash；两版本 hash 必不同；无历史版本 400」；web `mine-rollback`→`skillApi.rollback` | ✅ |
| **A5** | 订阅集变化后新建会话 index 含该技能；**显式命中不重复注入** | M0 探针证 `formatSkillsForSystemPrompt` 上游装配；M1-2 U-11 resume 重注入；`buildSkillResources` ≤12 裁剪 | ⚠️ 上游承接 index/注入；「显式命中不重复注入」无单列断言 |
| **A6** | 七类安全负例全拒 + 审计 + 可见理由 | 集成测试 A6「七类样本逐类拒绝+审计+理由」；`verifyImport` 七规则逐条命中；变异 N5「注入规则短路」实测转红 | ✅（含变异） |
| **A7** | 北极星 P7：关闭只写 override，正文/hash 不变；§7.2 四行矩阵；已关闭技能不出现在查询 | `applySkillOverride` 只改 override 不改 body；`assembleSkillResources` + `mergeAgentSkills` 过滤 enabled=false（M1-3 变异③转红） | ⚠️ 正文/hash 不变 + 关闭态过滤已证；矩阵「下一轮不再注入」同 A2 降级为下一轮新会话 |
| **A8** | 卸载二次确认+软删+审计+批量+agent 无 uninstall+隐式显式均拒 | 集成测试 A8「无确认必拒；确认后软删+逐项审计；卸载后隐式显式均拒」+「批量逐项审计」；web 单一确认弹窗（M1-3 RED 判据：cancel 不删、仅 ok 删）；变异 A8 confirmed 转红 | ✅（含变异） |
| **A9** | P10/P11/P12/P17：disableModelInvocation 不进 index 但显式必达；**userInvocable=false 不进点选但可路由**；未审/已卸载拒绝；显式命中不追加语义 | 集成测试 A9「未审且未启用显式拒绝；启用后可达；disableModelInvocation 隐式拒显式达」；`resolveInvocationMode` | ❌ **缺口**：`resolveInvocationMode` 函数体只用 `uninstalled / disableModelInvocation / enabled / reviewed`，**未消费 `userInvocable`**；web `mergeAgentSkills` 也只看 enabled/disableModelInvocation；golden SKILL.md 未重写（frontmatter 无该字段的实际生效路径）。P12 判定链断点 |
| **A10** | 目录四字段+四维排序+search 零安装+**install 非最近搜索/未确认即拒**+同名冲突+installCount 不改 trustLevel | 集成测试 A10「四维排序+搜索零安装副作用+合法链路」；`rankCatalog`；`installFromCatalog` 检查 reviewStatus='approved'、trustLevel='reviewed' 不读 installCount | ⚠️ 目录/排序/搜索/热度已证；**「最近一次搜索 + 用户确认」两道约束未见服务端实现**（installFromCatalog 仅按 packageHash + approved，无会话搜索态） |
| **A11** | 版本只新增行不改 pinnedHash；**userModified 不覆盖**；签名变化重建 index；仅 usageCount 不变 | v2 §7.3 已**删除** `skillIndexSignature`（E-10），改 `buildSkillResources` 每轮从 DB 现组装——「签名」概念不存在，判据按 v2 观测点改写为「每轮取最新集合」；M1-2「A11 前置：全量换集新名入旧名出 + sidecar 更新」 | ⚠️ 无签名架构天然满足「免重启/新会话重建」；**userModified 字段与保护未见实现** |

**小计**：✅ A1/A3/A4/A6/A8（5 条）；⚠️ A2/A5/A7/A10/A11（5 条，其中 A2/A7 为规格允许的语义降级）；❌ A9（1 条）。

## 3. M1-N1–N13 变异转红记录

⚠️ **关键发现**：v2 §7.3/§8 删除了 `withForcedSkills.resolveBody`、
`resolveSkillBodies`、`buildUserSkillIndex`（启动期快照）、`computeIndexSignature` 四个符号，
而 v1 的 **N1/N3/N6/N12 正是以这四个符号为变异靶点**。v2 §10.4 声明「编号、语义、阳性样本逐字保留，
仅观测点替换」，但未为这四条重定义 v2 等价靶点 ⇒ 它们当前**不可执行**（不是「转绿」，是「无靶可变异」）。
这是 v2 修订时引入的判据债务，本刀如实记录，不擅自改写判据。

| 判据 | v1 变异靶点 | v2 现状 | 转红实证 |
|---|---|---|---|
| **N1** | `withForcedSkills.resolveBody` 改回只查本地 | 路径已删除，显式收敛 `lane.skill()`（U-7）；等价靶点=未知名由 `UnknownSkill` 硬拒 | ❌ 无等价靶点变异；U-7 由 M0 探针负例覆盖 |
| **N2** | 查询去掉 `where:{userId}` | 靶点健在（`getMine` 注释锚） | ✅ M1-1 实测转红（跨用户隔离） |
| **N3** | `resolveSkillBodies` 取最新而非 pinnedHash | 函数已删除；等价靶点=`buildSkillResources` 按 pinnedHash 查包 | ⚠️ 篡改→跳过（A2 负例）已证；无「取最新」专门变异 |
| **N4** | 身份改回裸 name | contentHash 公式（含 skill 身份，M1-1 勘误）健在 | ❌ 未逐条实测 |
| **N5** | 注释 `verifyImport` 注入/脚本白名单 | 七规则健在 | ✅ M1-1 实测转红（注入规则短路） |
| **N6** | index 改启动期全局快照 | 架构已删除（每轮现组装） | ❌ 靶点不存在 |
| **N7** | DTO 漏写装饰器 | ValidationPipe whitelist 健在 | ❌ 未逐条实测 |
| **N8** | `applySkillOverride` 写进 `SKILL.md` 正文 | override 只改 DB 健在 | ❌ 未逐条实测 |
| **N9** | 卸载四变异（硬删/无确认/暴露 agent/共用路径） | 守卫健在 | ⚠️ 仅 A8 confirmed 一条转红；其余 3 条未逐条 |
| **N10** | 忽略 disableModelInvocation / 已卸载放回白名单 | 靶点健在 | ⚠️ web 合并层过滤变异转红（M1-3③）；服务端组装层未单列 |
| **N11** | install 跳过最近搜索+确认 | 服务端无此约束（见 A10） | ❌ 靶点不存在 |
| **N12** | `computeIndexSignature` 恒值 | 签名已删除 | ❌ 靶点不存在 |
| **N13** | trustLevel 由 installCount 决定 | 热度/信任分离健在 | ⚠️ 代码分离可见；未专门变异 |

**小计**：完整转红实证仅 **N2/N5** 2 条；部分覆盖 N3/N9/N10/N13 4 条；无靶可变异 N1/N6/N11/N12 4 条；
未实测 N4/N7/N8 3 条。距「N1–N13 逐条可转红」口径差距明显。

## 4. §4.7 Must / Won't 映射（无空项检查）

### 4.1 Must 项（P1–P12、P14）

| 项 | 能力 | 判据锚 | 映射状态 |
|---|---|---|---|
| P1 | 包格式 + 渐进披露 | M0-A5 / A2 | ⚠️ 上游 formatter 承接；同会话即时降级 |
| P2 | 发现页两区 + 排序搜索 | A10 | ✅ 市场区+我的区（web 已接） |
| P3 | 五条获取通路（前两条 Must） | A1/A3/A10 | ❌ 市场装已接；**上传/粘贴/zip/url 自定义入口 UI 缺失**（`skillApi.import` 存在但全 web 零调用方） |
| P4 | 上传分级安全检测 | A6 | ✅ |
| P5 | 工具权限收窄（agent 不自主卸载/启停） | A8/A10 | ⚠️ 服务端 `assertUninstallGuard` 已证；agent 工具清单实测未见记录 |
| P6 | 开源生态发现（安装后校验 + 冲突 Must） | A6/A10 | ⚠️ 校验已证；M3 adapter 未落地（Should） |
| P7 | 启用/关闭语义 | A7 | ⚠️ 正文分离已证；矩阵行 2 降级 |
| P8 | 卸载≠关闭 | A8 | ✅ |
| P9 | 更新/回滚/用户改写保护 | A4/A11 | ⚠️ 回滚已证；userModified 未覆盖 |
| P10 | 隐式调用 | A5 | ⚠️ 上游 index 承接，无重复注入断言 |
| P11 | 显式调用三入口必达 | A9 | ⚠️ dock 点选已接；斜杠/指令点名未逐入口走查 |
| P12 | 触发控制字段 | A9 | ❌ userInvocable 判定链断点 + golden 未重写 |
| P14 | 索引缓存与免重启生效 | A11 | ✅ 每轮从 DB 现组装，无签名无缓存 |

### 4.2 Won't 项（P16–P19，须有负例证明未回潮）

| 项 | 负例锚 | 状态 |
|---|---|---|
| P16 脚本/系统命令执行 | A6 / N5 | ✅ `verifyImport` 拒 scripts/shell + 变异转红；runtime egress deny 不变 |
| P17 未启用也可显式调用 | A9 阴性样本 | ⚠️ `resolveInvocationMode` 取严（未审+未启用拒绝）已证；userInvocable 维度未证 |
| P18 runtime 直连 registry | A6 / §11 | ✅ 出网仅 Nest 白名单；runtime create body 无 URL 下载字段 |
| P19 热度当信任 | N13 | ⚠️ 代码分离可见（trustLevel='reviewed' 不读计数），未专门变异 |

## 5. 缺口清单（按严重度）

| # | 缺口 | 严重度 | 修复归属 |
|---|---|---|---|
| G1 | **P12 userInvocable 判定链断点**：`resolveInvocationMode` 与 web 合并层均未消费该字段；golden frontmatter 无生效路径 | 高 | 代码小刀（server + web + golden 重写） |
| G2 | **P3 自定义加载 UI 入口缺失**：`skillApi.import` 无调用方，用户无法从 UI 粘贴/上传 SKILL.md；双通路退化为单通路 | 高 | web 小刀（发现页加自定义加载入口） |
| G3 | **golden SKILL.md 未重写**：11 个文件 frontmatter 未补 `userInvocable`/`capabilities` 契约字段 | 高 | M1-4 第 2 块（触发 runtime-deploy，单独授权） |
| G4 | **N1/N3/N6/N12 变异靶点 v2 删除后未重定义**；N4/N7/N8 未逐条实测 | 中 | 判据债务：v2 规格补等价靶点 + 补变异脚本 |
| G5 | **A10「最近搜索 + 确认」约束未实现**（N11 靶点不存在） | 中 | server 小刀（install 增加会话搜索态）或规格裁决降级 |
| G6 | **A11 userModified 保护未实现** | 中 | server 小刀 或规格裁决降级 |
| G7 | **A2/A7 同会话即时语义降级**为下一轮新会话（规格 §7.2 允许） | 低（已授权降级） | 记录即可；若要同会话即时，调 M1-2 已铺的 `POST /sessions/:id/resources` |

## 6. 诚实结论与收尾建议

**不能宣告 M1 全绿。** 三刀实现都正确，但规格定义的完整行为契约没有逐条闭合：
G1/G2/G3 是用户可感知的能力缺口（北极星六面里的「显式调用触发控制」与「自定义安装」两面），
G4/G5/G6 是判据层债务，G7 是已授权的产品选择（不算缺陷）。

两条收尾路径，供决策：

- **路径 A（推荐，对齐「全量完成」诉求）**：补 G1+G2 两个 web/server 小刀 → 再做 G3 golden 重写（单独授权，触发 runtime-deploy）→ 补齐 G4 等价变异靶点与 G5/G6 → 重跑本走查至 A/N/Must 全绿 → 宣告 M1 收口。代价：多刀 + 一次 runtime 部署。
- **路径 B（阶段性收尾）**：承认 M1 口径部分达成，把 G1–G6 结转成 M1.5/M2 待办，本文作为「M1 阶段性验收报告」归档，不宣告全绿。

无论哪条，**本刀（第 1 块）已完成其职责**：把散落在三刀实施记录里的证据与缺口收敛成一张可决策的表。

## 7. 复核命令（可复现）

```bash
# 判据实现落点
gh api 'repos/sev7n4/pi-lnk/contents/apps/server/src/skills/skills-pure.ts?ref=master' -H 'Accept: application/vnd.github.raw+json'
# A9 缺口：resolveInvocationMode 未消费 userInvocable（函数体只有 4 个字段）
grep -n -A8 'export function resolveInvocationMode' apps/server/src/skills/skills-pure.ts
# G2 缺口：skillApi.import 无 UI 调用方
gh api 'search/code?q=skillApi.import+repo:sev7n4/pi-lnk+path:apps/web' --jq '.total_count'   # → 0
# N 靶点删除（v2 §7.3 / §8）
grep -nE 'computeIndexSignature|buildUserSkillIndex|resolveSkillBodies|withForcedSkills' docs/superpowers/specs/2026-11-16-creative-skills-ecosystem-discovery-loading-design-v2.md
```

---

## 8. 收口补记（2026-11-18 · M1 遗留四项收口刀）

> **纪律**：上文 §0–§7 是 2026-11-16 的原始快照，**逐字保留不篡改**（审计留痕）。
> 本节是 2026-11-18 收尾刀（规格 `specs/2026-11-18-m1-remaining-closeout-design.md`）
> 基于生产 master `08b0086f` 的逐项复核与终态裁决。两节冲突时**以本节为准**。
> **PR 基线注记**：本刀 PR 切自远端 master `a1220acd`（复核后 #949–#951 web 刀先后合入，
> 触碰面 apps/web 与本刀零交集已逐路径核验；pi-runtime 判定链结论不受影响）。

### 8.1 缺口状态终裁（G1–G6 全部闭合或裁决）

| 缺口 | 原始状态 | 终态（2026-11-18 实证） | 处置 |
|---|---|---|---|
| G1 P12 userInvocable 判定链 | ❌ 未消费 | ✅ **已修**（#929/#931）：`skills-pure.ts:188-229` 的 `InvocationIntent` 含 `routed`、`resolveInvocationMode` 消费 `userInvocable`，`applyInvocationIntent` 落字段；web `runtimeSkillsToInstalled` 同源 | 关闭（代码已在 master） |
| G2 导入 UI 入口（任务 #46） | ❌ `skillApi.import` 零调用方 | ✅ **已闭环**（P3 #938/#939）：`SkillImportDialog.vue` 挂发现面板，master blob `d915cd7b`，生产 `/api/skills/import` 返 400（非 404=端点在） | **关闭 #46** |
| G3 golden 重写 | ❌ 11 文件未补字段 | ✅ **裁决改写 + 真链接线落地**：原始定义（补 `userInvocable`/`capabilities`）被推翻——上游 `pi-agent-core@0.99.2` 只原生解析 `disable-model-invocation`，无另两字段概念；11 个 golden 全是创作方法论，默认即正确（补字段反破坏 G1 双通路）。改在 `loader.ts`+`resources.ts` 接解析/映射链（本刀），golden **零改动** | 关闭（真链接线，详见 8.3） |
| G4 N 靶点债务 | ⚠️ N1/N3/N6/N12 无等价靶点、N4/N7/N8 未实测 | ✅ **等价靶点写死 + 变异实测**（见 8.2） | 关闭 |
| G5 A10 install 搜索态（N11） | ❌ 靶点不存在 | ✅ **裁决 N/A**：约束对象是「agent 自主安装」，但 agent 工具清单只有 `load_skill`，无 `skill_search/install/disable`；安装仅用户 UI（天然「看搜索结果点装」= 最近搜索+确认）。约束对象不存在，补会话态是给不存在的锁配钥匙 | 关闭（规格裁决，零代码） |
| G6 A11 userModified 保护 | ❌ 未实现 | ✅ **裁决 N/A**：防「市场更新静默覆盖」，但全服务无 upgrade 写路径（仅 install/rollback 改 pinnedHash，均需用户显式动作）；`userModified` 已在 `mine` 响应暴露（`skills.service.ts:518`）供 M2 用。写路径不存在，加保护空转 | 关闭（规格裁决，零代码） |
| G7 A2/A7 同会话即时 | 低（已授权降级） | 维持降级（下一轮新会话），不属缺陷 | 记录即可 |

### 8.2 G4 变异靶点等价重定义与实测（N1–N13）

v2 §10.4 声明 N1/N3/N6/N12「编号/语义保留，观测点替换」，但未落可执行靶点。本刀写死为可执行判据并逐条实测；
M0 探针（`upstream-skills-probe.test.ts`，本轮 26/26 全绿）已覆盖 U1–U11 及 M-U 变异，等价靶点锚定如下：

| 判据 | v1 靶点（符号已删） | v2 等价靶点（本刀写死） | 转红实证 |
|---|---|---|---|
| N1 | `withForcedSkills.resolveBody` 改只查本地 | 装配层不读 `getResources()` → 改回静态 index | U8（M-U8b 已证 RED） |
| N2 | 查询去 `where:{userId}` | 靶点健在（`getMine`） | ✅ M1-1 实测 RED（历史） |
| N3 | `resolveSkillBodies` 取最新 | `buildSkillResources` 用启动期快照替换 live entries | session-manager 资源测试 |
| N4 | 身份改裸 name | contentHash 公式含 skill 身份 | M1-1 contentHash 用例 |
| N5 | 注释 verifyImport | 七规则健在 | ✅ M1-1 实测 RED（历史） |
| N6 | index 启动期快照 | 同 N1（每轮现组装） | U8 |
| N7 | DTO 漏装饰器 | ValidationPipe whitelist | DTO 校验用例 |
| N8 | override 写正文 | `applySkillOverride` 只改 DB | override 用例 |
| N9 | 卸载四变异 | 守卫健在 | ✅ A8 confirmed（历史）；其余 3 条归位同入口 |
| N10 | 忽略 disableModelInvocation | 宿主→上游透传链（**本刀 G3 新增**） | ✅ M-G3a/b 实测 RED（本轮） |
| N11 | install 跳过确认 | 裁决 N/A（无 agent 安装工具，见 8.1） | 不适用（约束对象不存在） |
| N12 | `computeIndexSignature` 恒值 | resume 漏调 `buildSkillResources()` | U11 |
| N13 | trustLevel 由热度决定 | 热度/信任分离健在 | 代码分离可见（trustLevel='reviewed' 不读计数） |

**G4 结论**：13 条中 ✅已实测转红 4（N2/N5/N10/N9-A8）+ M0 探针等价靶点可转红 7（N1/N3/N4/N6/N7/N8/N12，U8/U11+配套测试为判据载体）+ N/A 裁决 1（N11）+ 代码分离可见 1（N13）。
判据债务已归位到可执行入口，不再存在「靶点已删、无变异可做」的空项。

### 8.3 G3 真链接线（本刀唯一生产改动）

- **改动**：`services/pi-runtime/src/skills/loader.ts` 的 `SkillIndexEntry` 增 `disableModelInvocation?: boolean`，
  `discoverSkills` 布尔归一化解析 frontmatter；`resources.ts` 的 `buildSkillResources` 透传给上游 `Skill`。
- **为何不重写 golden**：`disable-model-invocation` 是上游唯一原生解析的调用控制字段（`skills.ts:341`），
  真实装配走 `session-manager.ts:2717` 的 `formatSkillsForSystemPrompt(getResources().skills)` 原生过滤；
  宿主原先丢字段 ⇒ 写了 golden 也不生效。接解析链后契约真实可执行，且 golden 保持默认（正确语义）。
- **判据**：G3-A1（布尔归一化）/A2（映射+formatter 过滤）/A3（lane.skill 显式仍达）/A4（默认行为不变）/A5（golden hash 零改动）全绿；
  变异 M-G3a（删映射）/M-G3b（归一化改恒 false）均实测 RED（`AssertionError`）。
- **部署终态（2026-11-18）**：PR #952 squash 合并 `bd872f47`（合并树==CI 验证树 `9e695d35`，7 路径逐条 KEPT）；
  手工 dispatch `runtime-deploy.yml`（tag=`bd872f47`，feature_grep=`disableModelInvocation`@skills/loader.js PASS），
  production-runtime 审批通过，全步 SUCCESS（build→镜像特征核验→push→helm→rollout 三重校验）。
- **生产取证（同日）**：pod `pi-lnk-runtime-7dbb78bbc9-7dx2m` image=`pi-runtime:bd872f47`、
  imageID digest `sha256:f8b3d418…`、healthz=200；活体容器 `/app/services/pi-runtime/dist/skills/{loader,resources}.js`
  实测含 `disableModelInvocation`（grep 各 2 处命中）。诚实边界：**行为级活体探针未做**——生产 11 golden
  均无 `disable-model-invocation` 字段，过滤路径按预期休眠；行为正确性由 G3-A1~A4（含真实上游 formatter）单测承载。

### 8.4 终态判定（M1 行为契约收口，**不写 ALL_PASS**）

| 口径 | 终态 |
|---|---|
| M1-A1–A11 | A9 判定链已修（G1）；A10/A11 子项按 G5/G6 裁决 N/A；A2/A7 维持已授权降级。行为契约范围内无 ❌ |
| M1-N1–N13 | 四缺口等价靶点已写死并归位（8.2）；N10 本刀新增变异实证 |
| §4.7 Must | P3（导入 UI）已闭环 #46；P12（userInvocable 判定链）已修；golden 按真链接线关闭 |
| G1–G7 | 全部关闭或 N/A 裁决 |

**宣告**：**M1 行为契约收口**（非 `ALL_PASS`）。按 v2 §10.7 诚实边界：
M0/M1 通过 ≠ 生态兼容完成 ≠ WorkBuddy 全量复刻；产出北极星在 M2。
**残留（如实移交 M2）**：① A2/A7 同会话即时语义（G7，已授权降级，若要即时调 `POST /sessions/:id/resources`）；
② userModified 保护（G6，待市场 upgrade 写路径出现时启用）；③ agent 安装工具若引入需补 G5 确认约束。
