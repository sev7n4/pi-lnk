# Skill SOP · task-decomposition 拆解规范 skill 设计（立项 spec）

> 状态：立项即实施（§13 已裁决形态，本 spec 是裁决的实例化）。路标依据：
> `2026-11-11-task-planning-engineering-roadmap-design.md` §9.5/§13（v1.3 冻结后各立项 spec 承接细化）。
> 前置闭环：C-1a/C-1b 判据资产已合并（PR #861/#862，39+8+5=52 用例）；A-2' 模型侧 id 契约已上线
> （PR #863 合 `c9ca3641`，生产行为复测 4/4）。本刀可与 C-1b 跑批并行（§13.5）。

## 1. 定位与门禁（§13 裁决原文约束）

- **裁决**：通用拆解 SOP 走 **skills/ 按需加载**（`load_skill` 工具，SKILL.md frontmatter description
  承担发现、body 加载后进上下文、零常驻成本）——§13.1 纠偏 §9.5 混称；tail rule 常驻通道 No-Go
  （L2 todoTools 组合 3197/3200 余 3 物理封死）。
- **闭环核心**（§13.3）：**每一条 SOP 纪律必须能在 C-1 四象限中找到对应判据，找不到判据的条文禁入 SOP**
  ——防退化为不可证伪的 prompt 装饰。本 spec §3 给出逐条映射表。
- **时序悖论缓解**（§13.2）：SOP 是「拆解前」需要的知识，模型不拆就不会 load——缓解①
  description 关键词化是生命线（`ecommerce-product-photo` 0.5.1 生产实证：description 缺触发词 →
  load_skill 0 调用）；②接受部分激活率，AB 量化差值（#858 的 27%↔70% 方法学）；③远期升级 tail 常驻
  通道须独立评审（不搭车）。

## 2. 实施面核实（2026-11-13 对 master c9ca3641 + 生产）

- **接线**：`SkillRegistry(process.env.PI_RUNTIME_SKILLS_DIR ?? "./skills")`（`index.ts:75`）→
  生产容器 `/app/skills`（9 目录实测），**新增 skill = 纯加目录，零代码改动**（loader 自动 discover、
  index 常驻 systemPrompt 尾部、load_skill 按需）。
- **索引块预算**：`buildSkillIndexBlock`（loader.ts:55）= 常驻尾部一行一条
  `- name: description`；现有 9 条 description 105–178 字符；新增 1 条 ~200 字符 ≈ +200 token 级
  （CJK 口径 approxTokens），对 48k 动态预算零影响（index 不在动态预算内，走静态段尾部）。兜底：
  runtime-config 的 systemPrompt 无独立硬上限被此刀触碰。
- **格式硬限**：name=目录名（小写连字符 ≤64）；description ≤1024（loader 校验，坏 skill 跳过 +
  console.warn）；frontmatter 手动解析支持 `>` 折叠（html-craft 先例）。
- **测试面影响**：`loader.test.ts` 用临时目录（真实目录零耦合）；`html-craft.wiring.test.ts` 只断言
  html-craft；golden 测试用内联块不触真实 skills 目录 ⇒ 新增目录**测试零破坏**，需新增接线守卫
  （§4，仿 html-craft.wiring 先例——「装了但路由不到 = 重演 tool_search 触发率 0」防线）。
- **部署陷阱（§13.5，#858 同款前科）**：`deploy.yml` push.paths **不含 skills/** ⇒ 合并后必须手工
  dispatch `runtime-deploy`（构建源 = 主仓 rsync 快照会进镜像但不触发 CI/CD）——**合并≠上线**。
  特征串取证可用 skill 正文独有句 grep 容器内 `/app/skills/task-decomposition/SKILL.md`。

## 3. SKILL.md：纪律 ↔ C-1 判据逐条映射（§13.3 机械保证）

| # | SOP 纪律 | C-1 判据（消费方文件） | 归属象限 |
|---|---|---|---|
| 1 | 多步/方案请求先 `propose_plan` 提案，确认后落 `todo_write` | `expectTools:["propose_plan"]`（c1a-decomp-02 = 生产失败复现） | Q1 |
| 2 | 单步原子任务直接做，不建清单、不提案 | Q1 负例集（§8.2 单步不拆） | Q1 |
| 3 | 清单首步必须是检索/读取/澄清类，结论步不得前置于收集 | `firstStepPredicate:"collect"`（c1a-decomp-03） | Q2 |
| 4 | 清单 2–4 项为宜（≤6 上限）、互斥不重复、无巨石项 | `minItems/maxItems/requireDistinctContent`（c1a-decomp-01 等） | Q2 |
| 5 | 全量覆写：每次提交完整清单，至多一项 in_progress | `expectTodoStatus.allOf/requireAnyOf/requireProgress`（Q3 用例） | Q3 |
| 6 | 带 id 增量维护：变更已有任务带 id（content 可改写=重命名），新增省略 id；硬拒绝按回执自纠 | A-2' 生产复测 4/4（session a2-probe-1794573738）+ Q3 identity 观测 | Q3 |
| 7 | 完成须证据：未完成不许标 completed；全部完成提交空数组清空 | c1b-struct-02（首轮拆解禁假 completed）+ Q3 收尾步；C-2 acceptance 上线后升级硬校验 | Q3 |
| 8 | 大规模独立调研可派发子代理（观测期，不强制） | `expectAnyTools` 宽松二选一（q4-01…05） | Q4 |

反例（**禁入**，无判据）：「粒度适中」「合理拆解」「注意质量」类不可机检措辞——一句话都不得出现。

## 4. wiring 守卫测试（新增 `src/skills/task-decomposition.wiring.test.ts`）

仿 `html-craft.wiring.test.ts` 三段：
1. `discoverSkills(真实 skills root)` 含 `task-decomposition` 且 description 含触发词族
   （多步/规划/方案/任务清单/一步步）——**description 关键词化守卫**（时序悖论生命线）。
2. description 完整性（`>` 折叠生效、含「不适用」边界句，防 parse 截断回归）。
3. body 含判据映射纪律关键句（「propose_plan」「全量覆写」「空数组清空」「id」）——
   防 SKILL.md 被无意改写丢掉判据对应的纪律。

## 5. 闭环运转与归因（§13.4 原样生效）

- C-1a/C-1b 基线（SOP 缺席，跑批数据回填后固定）→ SOP 上线 → AB 对比（激活 vs 不激活：
  load_skill 激活的 run vs 未激活 run 的触发率/结构达标率）→ 后续跑批门禁防回退。
- eval fail 三分类归因（模型行为/判据/环境）；**只有模型行为失败且跨 case 模式化才触发 SOP 修订**
  （单次抖动不动）；SOP 修订本身须过 AB，防条文膨胀。
- 激活率是最大未证假设；AB 差值趋零则止损（skill 删除成本 = 1 个目录，可逆）。

## 6. 诚实边界

- 通用拆解 SOP only；垂类步骤内指引已存在（drama-* workflow），不重复建设（§13.5 ②）。
- 纪律 8（派发）观测期措辞「可」不「须」——spawned 持续性数据未回填（7 天/200 run 复核欠），
  强门禁留给后续数据。
- 本刀不改任何 TS 生产代码、不碰 prompt-registry/L2 预算、不碰 eval 资产；测试侧仅新增 1 个
  wiring 测试文件。
- C-1a/C-1b 跑批仍被 agnes 实名墙 429（磨批 run3 进行中），AB 基线回填时点不可控——SOP 上线
  早于基线数据的风险 = AB 对照退化为「上线前后跨时段对比」（噪声更大，报告中须标注）。
