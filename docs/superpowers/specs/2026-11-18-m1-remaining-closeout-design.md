# M1 遗留四项收口 · 设计规格

> 立项日期：2026-11-18。状态：**已上线**（2026-11-18：PR #952 squash `bd872f47` + runtime-deploy tag=`bd872f47` 成功 + 生产取证；门禁全绿：pi-runtime 全量 2090/2090、tsc 干净、M-G3a/b 变异 RED+sha256 还原、G3-A5 golden hash 11/11 与 master 一致；部署终态见走查 §8.3）。
> 上游任务：#42（G3 golden）、#43（G4/G5/G6 判据）、#44（M1 收口）、#46（导入 UI）。
> 事实基线：生产 master `08b0086f`；走查记录 `docs/superpowers/plans/2026-11-16-m1-skills-acceptance-walkthrough.md` §5；
> v2 规格 `docs/superpowers/specs/2026-11-16-creative-skills-ecosystem-discovery-loading-design-v2.md` §10.4/§10.7。
> 决策来源：2026-11-18 用户同意「按决策建议执行推进」（G3 真链接线 + runtime-deploy；G5/G6 裁决降级；G4 补判据；#46 关单；#44 收口）。

## 0. 第一原则（最高约束，违条驳回）

> **吃满上游、不重复造轮子**。任何新增判据/工具/字段/引擎前过三判据：
> ① 等价物检索（上游/现仓是否已有） ② 接线优先于新建（锚已有结构化数据面）
> ③ 禁造数/禁自报（不伪造数据、不自报结论）。

本规格的等价物检索结论表见 §1。逐任务标注复用资产见计划文档。

## 1. 事实基线与等价物检索结论表

| 项 | 走查记录原始缺口 | 本轮核实真相（生产/源码实证） | 等价物检索结论（三判据） | 决策 |
|---|---|---|---|---|
| **#42 / G3** | 11 golden 未补 `userInvocable`/`capabilities` 契约字段 | ① 上游 `pi-agent-core@0.99.2` **只原生解析** `disable-model-invocation`（`skills.ts:341`），无 `user-invocable`/`capabilities` 概念；② 真实装配走 `session-manager.ts:2717` 上游 `formatSkillsForSystemPrompt(getResources().skills)`，**原生过滤** `disableModelInvocation`；③ 宿主 `SkillIndexEntry` 丢该字段、`buildSkillResources` 未映射 ⇒ **写了 golden 也不生效**；④ 11 golden 全是创作方法论，按 Anthropic 官方语义（一手文档已证）正确配置就是**默认（不加控制字段）** | ①上游 formatter 已具备过滤 ⇒ 不自建过滤；②只补「解析 + 映射」两处接线，锚 `SkillIndexEntry`/`buildSkillResources` 既有数据面；③golden 零改动、不造字段 | **真链接线**：loader 解析 + resources 映射，golden 零改动，测试夹具验 `true` 生效 |
| **#43 / G4** | N1/N3/N6/N12 靶点 v2 删除未重定义；N4/N7/N8 未实测 | 属实：v2 §10.4（行 453）已给 N1/N3/N6/N12 **文字等价靶点**但未落可执行变异脚本；走查 §3 小计完整转红仅 N2/N5 | ①无上游等价物（判据债务须自补）；②锚 v2 §10.4 已定义靶点，不另起判据；③每条必须实测 RED，不自报 | **补判据**：写清等价靶点 + 变异脚本 + 逐条实测 RED |
| **#43 / G5**（A10/N11） | install「最近搜索+确认」未实现 | 约束对象是「agent 自主安装」，但 agent 工具清单**只有 `load_skill`**，无 `skill_search/install/disable`；安装只在用户 UI 发生（天然「看搜索结果点装」） | ①约束对象不存在⇒无等价物可接；②不新建 UI 会话态（对象不存在）；③不自报「已实现」 | **裁决 N/A**：docs 回填「约束对象不存在，已天然满足」 |
| **#43 / G6**（A11） | userModified 保护未实现 | 防的是「市场更新静默覆盖」，但全服务**无 upgrade 写路径**（仅 `install`/`rollback` 改 `pinnedHash`，用户手动）；`userModified` 已在 `mine` 响应暴露（`skills.service.ts:518`） | ①字段已存在（等价物在）②写路径不存在⇒无处加保护；③不造「保护」结论 | **裁决 N/A**：docs 回填「无自动更新写路径，字段保留供 M2」 |
| **#46** | `skillApi.import` 零调用方 | **已闭环**：P3 刀建 `SkillImportDialog.vue` 挂发现面板（master blob `d915cd7b`）；生产 `/api/skills/import` 返 400（非 404）=端点在；走查记录是 11-16 旧快照 | ①上游 UI 已接；②无需新建；③以生产实证为准不自报 | **关单**：回填走查 G2 → 已闭合 |
| **#44** | blocked by 42/43 | 依赖上游完成 | 不适用 | 上述完成后**重跑走查、更新 A/N/Must、宣告 M1 行为契约收口**（按 §10.7 不写 `ALL_PASS`） |

## 2. F1 / G3：disable-model-invocation 真链接线

### 2.1 范围
- `services/pi-runtime/src/skills/loader.ts`：`SkillIndexEntry` 增可选字段 `disableModelInvocation?: boolean`；`discoverSkills` 从 frontmatter 读 `disable-model-invocation`。
- `services/pi-runtime/src/skills/resources.ts`：`buildSkillResources` 映射到上游 `Skill.disableModelInvocation`。
- **golden 11 个 SKILL.md 零改动**（默认即正确；照走查原始定义补字段会破坏 G1 双通路）。
- 测试：`services/pi-runtime/src/skills/*.test.ts`（node --import tsx --test）新增接线用例；复用 `upstream-skills-probe.test.ts` U2 已证的上游过滤。

### 2.2 关键实现细节（防踩坑）
- `loader.ts` 的 `parseSimpleYaml` 把标量一律解析为**字符串**（`disable-model-invocation: true` → `"true"`）。接解析链必须做布尔归一化：`raw === true || String(raw).toLowerCase() === "true"`。仅加字段不做归一化会导致 `Skill.disableModelInvocation` 恒为 `false`，判据自匹配恒绿。
- 被 disable 的技能只从**隐式 index**（systemPrompt）过滤，`lane.skill()` 显式调用仍可达——这是 Anthropic 官方语义，测试须同时断言两侧。
- 上游装配已走 `session-manager.ts:2717`，**不改装配路径**（不碰 `indexBlock` 遗留分支，避免重复造轮子）。

### 2.3 判据 F1（必须全绿）
- G3-A1：临时夹具 SKILL.md 带 `disable-model-invocation: true` → `discoverSkills` 得 `disableModelInvocation === true`（布尔，非字符串）。
- G3-A2：经 `buildSkillResources` → `Skill.disableModelInvocation === true`；`formatSkillsForSystemPrompt(skills)` 输出**不含**该技能名。
- G3-A3：该技能 `lane.skill()` 显式调用仍命中（显式通路不关）。
- G3-A4：默认（无该字段）技能 → `disableModelInvocation === undefined`/false，行为与现状逐字一致（回归）。
- G3-A5：11 个 golden frontmatter 零改动（`git hash-object` 与本轮基线一致）。

### 2.4 变异 F1（必须 RED）
- M-G3a：`buildSkillResources` 删掉 `disableModelInvocation` 映射 → G3-A2 RED。
- M-G3b：`discoverSkills` 把布尔归一化改回 `raw === true`（字符串永假）→ G3-A1/A2 RED。
- M-G3c：`formatSkillsForSystemPrompt` 块从装配移除 → 复用 U8 的 M-U8b（已证 RED），不重复造变异。

### 2.5 部署边界
改动 `services/pi-runtime` ⇒ 合并后**手工 dispatch runtime-deploy.yml**（docs/scripts/web-only 不触发）；用户已在本轮决策授权，但执行前仍按分阶段纪律单独确认部署时机。

## 3. F2 / G4：判据债务闭合

### 3.1 等价靶点（写死为可执行，锚 v2 §10.4）
| 判据 | v1 靶点（已删符号） | v2 等价靶点（本轮写死） | 变异动作 | 必须 RED 判据 |
|---|---|---|---|---|
| N1 | `withForcedSkills.resolveBody` | 装配层 `composeEntryAndObserve` 的 skills index 从 `getResources()` 求值 | 改回静态常量 index | U8（index 不再随 setResources 变） |
| N3 | `resolveSkillBodies` 取最新 | `buildSkillResources` 按已有 entries（pinnedHash 语义在外层已证） | 用启动期快照替换 live entries | session-manager 资源测试 |
| N6 | index 启动期全局快照 | 同 N1（每轮现组装） | 启动期算一次 index | U8 |
| N12 | `computeIndexSignature` 恒值 | resume 路径调 `buildSkillResources()` | resume 漏调 | U11 |
| N4 | 身份改裸 name | contentHash 公式含 skill 身份 | 去掉身份字段 | M1-1 contentHash 用例 |
| N7 | DTO 漏装饰器 | ValidationPipe whitelist | 删 `@IsString` 装饰器 | DTO 校验用例 |
| N8 | override 写进正文 | `applySkillOverride` 只改 DB | 写 body | override 用例 |

> N2/N5/A8 已有完整转红实证（走查 §8），不重做；N9/N10/N13 部分覆盖，本轮补逐条脚本归位到同一可复现入口。

### 3.2 判据 F2
- G4-A1：上述 7 条等价靶点各有可复现变异脚本，逐条实测 RED，且 `module_fail=False`（RED 来自真实断言，非模块解析失败）。
- G4-A2：恢复后基线全绿（pi-runtime `node --import tsx --test` / server vitest）。
- G4-A3：走查记录 §3 小计更新为「N1–N13 逐条可转红」或如实标注剩余项。

### 3.3 范围
纯测试 + docs：新增/整理变异脚本（沿用现有 §8 脚本入口风格，不新建引擎），更新走查记录 §3。**零生产代码改动、零部署**。

## 4. F3 / G5-G6：规格裁决降级（docs-only）

- G5（A10/N11）：走查记录 A10/N11 行回填「N/A — agent 无 install 工具，安装仅用户 UI，约束对象不存在，天然满足」；§5 G5 行标「规格裁决：N/A」。
- G6（A11）：走查记录 A11 行回填「N/A — 无 upgrade 自动更新写路径，`userModified` 已在 mine 暴露供 M2」；§5 G6 行标「规格裁决：N/A」。
- 判据 F3：两处回填措辞准确、与源码一致（`grep` agent 工具清单无 install、`grep` 无 upgrade 写路径），不自报「已实现保护」。

## 5. F4 / #46：关单（docs-only）

- 走查记录 G2 行与 §5 G2 回填「已闭合：P3 刀 `SkillImportDialog.vue` + `skillApi.import`，生产端点在（400 非 404）」。
- 关闭 task #46。
- 判据 F4：回填与生产实证一致。

## 6. F5 / #44：M1 行为契约收口（docs-only，最后一步）

- 依赖 F1–F4 全完成后重跑走查 §4 的 A/N/Must 表，逐行更新状态。
- 宣告口径：**「M1 行为契约收口」**；按 v2 §10.7 **不写 `ALL_PASS`**（产出北极星在 M2；M0/M1 通过 ≠ 生态兼容完成 ≠ WorkBuddy 全量复刻）。
- 诚实残留：G7（A2/A7 同会话即时语义降级为下一轮）是已授权产品选择，不算缺陷；M2 待办（升级线 userModified 保护、agent 安装工具若引入需补 G5 约束）如实列出。

## 7. 全局门禁与诚实边界

- 门禁：pi-runtime `node --import tsx --test` 全绿 + 变异 RED；server 相关 vitest 全绿；docs 判据行与源码一致。
- **本轮唯一生产改动 = F1（pi-runtime 两文件 + 测试）**；F2/F3/F4/F5 纯 docs+测试，不部署。
- 不宣告 `ALL_PASS`；G3 的价值是让契约真实可执行（否则原始定义的字段是死数据），不是改变 11 个 golden 的实际行为（它们本就该默认）。
- 用户已同意决策建议；规格/计划审完再动手；合并/部署仍分阶段单独确认。
