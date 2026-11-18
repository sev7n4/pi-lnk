# M1 遗留四项收口 · 实施计划

> 规格：`docs/superpowers/specs/2026-11-18-m1-remaining-closeout-design.md`（**已实施待合**，2026-11-18）。
> 范围：F1 = `services/pi-runtime`（唯一生产改动，触发 runtime-deploy）；F2–F5 = 测试 + docs（零部署）。
> 分支：从最新 master 另开 `fix/m1-remaining-closeout`（worktree）。**PR 基线：远端 master `a1220acd`（与 #949–#951 web 刀零交集已核验）**。
> 第一原则：每任务标注复用资产，禁止重复造轮子；禁造数/禁自报。
>
> **实施终态（2026-11-18）**：T1–T5 全落地——门禁 pi-runtime 全量 2090/2090 绿、`tsc --noEmit` 干净、
> 变异 M-G3a/M-G3b 逐条实测 RED（完整 stdout 存 /tmp/m1-check/，sha256 还原校验一致）、
> G3-A5 golden hash 11/11 与 master 一致、基线恢复 15/15 绿。

## 0. 复用资产清单（吃满上游，逐任务锚定）

| 任务 | 复用资产（不新建） | Self-built 仅限 |
|---|---|---|
| T1 G3 loader | `parseSimpleYaml` 既有解析器（只加布尔归一化，不引入 yaml 依赖） | `SkillIndexEntry` 1 个可选字段 + 一处归一化 |
| T1 G3 resources | 上游 `Skill.disableModelInvocation` 字段 + `formatSkillsForSystemPrompt` 原生过滤 | `buildSkillResources` 1 行映射 |
| T1 测试 | `upstream-skills-probe.test.ts` U2/U8 已证上游过滤；pi-runtime 既有 test 夹具风格 | 接线用例 + 临时 SKILL.md 夹具 |
| T2 G4 | v2 §10.4 已定义等价靶点；走查 §8 现有变异脚本入口风格 | 7 条变异动作脚本 + 靶点文字写死 |
| T3 G5/G6 | 既有走查记录措辞与源码事实 | docs 回填 |
| T4 #46 | P3 已上线的 `SkillImportDialog` + 生产端点实证 | docs 回填 |
| T5 #44 | 走查 §4 A/N/Must 表 + v2 §10.7 收口口径 | 状态更新 |

## 1. 任务拆解

### T1 · G3 真链接线（生产改动，需 runtime-deploy）
- T1.1 `loader.ts`：`SkillIndexEntry` 加 `disableModelInvocation?: boolean`；`discoverSkills` 解析 frontmatter 并布尔归一化（`raw === true || String(raw).toLowerCase() === "true"`）。复用 `parseSimpleYaml`，零依赖。
- T1.2 `resources.ts`：`buildSkillResources` 的 map 增 `disableModelInvocation: e.disableModelInvocation`。
- T1.3 测试：新增接线用例 G3-A1–A5（含默认行为回归 + 11 golden 零改动 hash 守卫）。用 `node --import tsx --test`。
- T1.4 变异自检：M-G3a/b 两条 RED（完整 stdout 判据，禁 `| tail`）；复用 U8 的 M-U8b 不重造。
- **复用**：上游 formatter 过滤、U2 探针、既有 loader 解析器。**判据**：G3-A1–A5 全绿 + M-G3a/b RED + golden hash 不变。

### T2 · G4 判据债务闭合（测试 + docs，零部署）
- T2.1 走查 §3：按规格 §3.1 表把 N1/N3/N6/N12 的 v2 等价靶点**写死为可执行**，N4/N7/N8 补逐条脚本。
- T2.2 整理变异脚本入口（沿用 §8 风格，不建新引擎），逐条实测 RED 并记录 `module_fail=False`。
- T2.3 恢复基线全绿；更新走查 §3 小计。
- **复用**：v2 §10.4 靶点定义、§8 脚本风格。**判据**：G4-A1–A3（7 条 RED + 基线绿 + 走查更新）。

### T3 · G5/G6 规格裁决降级（docs-only）
- T3.1 走查 A10/N11、A11 行 + §5 G5/G6 行回填 N/A 措辞（措辞与源码一致：agent 工具清单无 install、无 upgrade 写路径）。
- **判据**：G5/G6 回填后 grep 复核断言成立。

### T4 · #46 关单（docs-only）
- T4.1 走查 G2 行 + §5 G2 回填「已闭合」；关闭 task #46。
- **判据**：F4 回填与生产实证一致。

### T5 · #44 M1 收口（docs-only，最后）
- T5.1 重跑走查 §4，逐行更新 A/N/Must 状态。
- T5.2 宣告「M1 行为契约收口」，按 §10.7 不写 `ALL_PASS`，列诚实残留（G7、M2 待办）。
- T5.3 关闭 task #42/#43/#44。
- **判据**：收口口径准确、无 `ALL_PASS` 字样、残留如实。

## 2. 门禁矩阵

| 门 | 命令/方式 | 通过条件 |
|---|---|---|
| pi-runtime 测试 | `node --import tsx --test`（node24，`env -u NODE_OPTIONS`） | 全绿 |
| 变异 RED | 逐条注入→跑目标判据→完整 stdout 断言 AssertionError→还原 | M-G3a/b + G4 7 条全 RED，无模块解析假红 |
| 基线恢复 | 变异后重跑 | 全绿 |
| docs 一致性 | grep 复核 G5/G6/F4 措辞与源码 | 断言成立 |
| 类型 | web `vue-tsc -b`；server `tsc -p ... --noEmit` | 本轮只动 pi-runtime，双 tsc 无新增错误 |

## 3. 提交与部署边界（分阶段授权）

1. **本阶段（审 PASS 后）**：落地 F1–F5 + 门禁全绿，回填规格/计划状态为「已实施待合」。
2. **合并阶段（单独确认）**：REST 推 PR（blob→tree base_tree 只传改动路径→commit→ref→PR）；推前核 master 触碰面零交集；CI 4/4；合并树 == CI head tree；逐路径 KEPT。
3. **部署阶段（单独确认）**：
   - F1 改 `services/pi-runtime` ⇒ **手工 dispatch `runtime-deploy.yml`**（deploy.yml 触发面不含 pi-runtime，不会自动触发）。
   - 判据：runtime 镜像新 tag + health 200 + 新构建元数据；用临时 SKILL.md 夹具走一次真机 `disable-model-invocation` 生效探针（或如实标注「仅单测验证，未做生产活体」）。
   - F2–F5 无部署。
4. **收尾**：docs 回填终态；关单。

## 4. 诚实边界

- 本轮唯一生产改动是「让字段契约真实可执行」；11 个 golden 行为不变（默认即正确），不夸大为「修复了 bug」。
- G4 是判据债务闭合，不改变产品行为；G5/G6 是规格裁决（约束对象/写路径不存在），不是「实现了保护」。
- 未闭环项不写 `ALL_PASS`；产出北极星在 M2。
- 变异 RED 必须完整 stdout + 目标判据变红，禁 `| tail` 吃退出码、禁伪变异/判据自匹配恒绿。
