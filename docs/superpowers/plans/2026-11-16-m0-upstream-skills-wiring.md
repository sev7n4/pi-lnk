# M0 上游原语接线实施计划（宿主 wiring）

> 规格依据：`docs/superpowers/specs/2026-11-16-creative-skills-ecosystem-discovery-loading-design-v2.md` §7.3 / §8 / §9 / §12 / 附录 C。
> 原则（用户拍板）：**不重复造轮子，吃满上游 `pi-agent-core@0.99.2` 原生能力**；宿主只做装配。
> 基线：master `282b964b` 干净树 `/tmp/pi-m0-wiring`；M0 探针 11/11 GREEN（规格附录 B）。

## 1. 本刀范围（M0 = 可达性门，§12）

| # | 改动 | 上游原语（禁自建） |
|---|---|---|
| W1 | `AgentHarness.create` options 增加 `resources`（唯一注入点 `session-manager.ts:1438`，新建/resume/fork/重启全部经 `build()` 收敛于此） | `AgentHarnessResources.skills`（U-7/U-11：每次 create 重注入） |
| W2 | skills index 每轮从 `harness.getResources()` 求值并进 systemPrompt（预算体系之外拼装，B-3 顺序保持 index→guidelines） | `formatSkillsForSystemPrompt`（U-3/M0-P8；空集返回 `""`、hidden 过滤、XML 转义全由上游负责） |
| W3 | `forceSkills` 显式调用收敛到 `lane.skill(name, additionalInstructions, ctx)`；删除 `withForcedSkills` 的自研正文装饰与 fail-soft 文案 | `lane.skill` + `formatSkillInvocation` + `UnknownSkill`（U-7/U-8；判别用 `error._tag`） |
| W4 | 探针落库为验收资产 `src/upstream-skills-probe.test.ts`（规格附录 A 全文，`node --import tsx --test` 自动纳入） | 全部 |
| W5 | `load_skill` 工具描述对齐上游 index 格式（「可用技能 section」→ `<available_skills>`，改描述不改机制） | — |

**不做**（本刀）：`setResources` 热更新调用点（M1 控制面）、Nest 侧 `buildSkillResources(userId)`（M1）、`injectSkillResources` 独立纯函数（M1 有调用方时再抽，M0 无热更新调用方）、`skills/loader.ts` `parseSimpleYaml` 替换为上游 `loadSkills`（§9 明确保留为内置回落；M1 DB→Skill[] 时由 `loadSkills(ExecutionEnv)` 承担新解析）、golden 重写/发现页（移交 M1）。

## 2. 装配层设计（关键决策）

1. **预算安全**：`dynamic-budget` 对未识别块按 `general`（份额 0）截到 80 字保底 ⇒ index 与 `<tool_guidelines>` **不得进 `applyDynamicBudget`**。二者在预算之外以 `appendPromptBlocks(entry.staticPrompt, [index, guidelines])` 拼装，最终字节序与现网完全一致（rules → index → guidelines → 动态块）。
2. **per-turn 求值**：vendor `resolveSystemPrompt` 原生 `await` systemPrompt 闭包（`generation.js:18-27`，签名 `string | Promise<string>`）⇒ `composeEntryAndObserve` 改 async，每轮 `await entry.harness.getResources(this.context)`，**无镜像缓存**（SSOT 就是 harness config）。
3. **single 注入点**：`build()` 是 created/rebuilt/resume/fork 的收敛点（`harnessFactory` 全文件唯一调用处 :1438）⇒ U-11 的「resume 重注入」由既有结构天然满足，`resources` 从 `SkillRegistry` 即时转换（content=`loadBody`，filePath=`<dir>/SKILL.md`）。
4. **fail-soft**：`getResources` 异常时 index 回 `""` 只 warn（对齐 journal open 的取舍）——index 缺失不阻断会话，但 warn 可观测。
5. **forceSkills 语义**：空 → 走既有 `lane.prompt`（逐字节不变）。非空 → 先 `getResources` 查名，缺名 `throw InvalidInputError`（路由 400，fail-closed 取代旧 fail-soft 文案，§7.3/U-7）；`lane.skill(forced[0], [extras 的 formatSkillInvocation 块..., text].join, ctx)`；**带图例外**：`directImages` 与 forceSkills 同时存在时 `lane.skill` 无 images 参数 ⇒ 回落 `lane.prompt`（正文仍由上游 `formatSkillInvocation` 组装）+ warn。

## 3. 文件级改动

| 文件 | 动作 |
|---|---|
| `src/skills/resources.ts` | 新增纯函数 `buildSkillResources(entries, loadBody)`：`SkillIndexEntry[]` → `{ skills: Skill[] }`（content=正文、filePath=`dir/SKILL.md`、空集 `[]`、body 缺失=`""`） |
| `src/skills/resources.test.ts` | 新增：≥1 阳 ≥1 阴（转换/空集/缺 body） |
| `src/session-manager.ts` | W1-W3：import 上游三原语；删 `withForcedSkills`；staticPrompt 去装饰（=base）；`composeEntryAndObserve` async 化 + `assembleSkillIndexBlock`（getResources→上游 formatter）；prompt() 的 lane.skill 分支 |
| `src/tools/skill-tool.ts` | 描述对齐 `<available_skills>`（偏离 §9「不改」一行，理由记于本节） |
| `src/session-manager.forced-skills.test.ts` | 重写：lane.skill 行为级（命中/未知名 400/空集直通/带图回落） |
| `src/session-manager.test.ts` | 两处 indexBlock 断言改上游格式 + fake harness 增 `getResources` + await |
| `src/upstream-skills-probe.test.ts` | 新增（附录 A 提取） |
| `docs/` | 本计划 + 规格 §13 无需动；README 计划行登记 |

## 4. TDD 任务与判据

| 任务 | RED 信号 | GREEN 判据 |
|---|---|---|
| T1 resources 转换 | `resources.test.ts` 先跑先红 | 转换逐字、空集 `[]`、缺 body `""` |
| T2 create 注入 | 测试断言 factory 捕获的 options 无 `resources` | options.resources.skills name 集合 == registry entries；无 registry → `{skills:[]}` |
| T3 index 装配 | 断言 systemPrompt 含 `<available_skills>` 失败 | 每轮 await getResources；空集无块；guidelines 在 index 后；`resolveSystemPromptForTest` 为 Promise |
| T4 lane.skill 收敛 | forced-skills 旧断言（fail-soft 文案）红 | 命中走 `lane.skill(name, instructions)`；未知名 400 零副作用；空集走 prompt；带图回落 |
| T5 探针落库 | —（验收资产） | `node --import tsx --test src/upstream-skills-probe.test.ts` 11/11 |
| T6 全量回归 | — | pi-runtime 全套 `node --import tsx --test` 绿 + `vue-tsc`/tsc 门禁绿 |

## 5. 风险与回滚

- **提示词字节变化**（index 格式改上游 XML、load_skill 描述微调）⇒ 一次性 cache 失效，量级 ~2KB/会话；无功能回归路径。
- **forceSkills fail-soft → fail-closed** 是行为变化（规格明令）；Nest 白名单保证正常流量不触达。
- 回滚：revert 单 commit；无 schema/迁移；无 Nest/web 改动。
- 发布：`services/pi-runtime/**` ⇒ 合并后手工 dispatch `runtime-deploy.yml`（JSON body，tag=master 短 SHA）+ 生产取证（pod 内 `/app/skills` 11 个、探针日志、forceSkills 冒烟）。
