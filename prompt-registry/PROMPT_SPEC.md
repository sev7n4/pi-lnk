# 画布 Agent 提示词规格

> 规则正文在 `rules/`，本文件是**总纲**：坐标系声明、规则地图、预算纪律、变更流程。
> 与规则正文冲突时以 `rules/` 为准，并请修正本文件。
> 依据：`docs/superpowers/specs/2026-10-04-prompt-engineering-design.md`

## 1 坐标系与坐标契约

**本Agent 不产出坐标。** 这是本画布最重要的一条空间语义。

| 事实 | 位置 |
|---|---|
| 每轮注入的画布摘要只有 4 字段 `{id, type, title, status}`，**无 x/y** | `pi-prompt-assembler.service.ts:102` |
| 坐标与尺寸只在 `get_canvas_layout` 的返回值中，**模型按需拉取** | `tools/canvas-read.ts:123` |
| viewport / zoom **没有读路径**：pi-runtime 只有写向的 pan/zoom 指令（工具 description），**没有任何工具返回当前视口状态**；视口语义的状态源在前端 | `services/pi-runtime/src/tools/ui-command.ts:34,45` |

因此：
- **不要**在提示词里要求模型输出坐标或遵守坐标精度
- **不要**依据"视口密度""距离"等几何判据决策——后端不知道视口
- 布局由 `arrange_nodes` 定式排布，坐标由后端计算

## 2 图元类型

本画布是**语义画布**，非几何画布。

| 类型 | 说明 |
|---|---|
| `image` / `video` / `audio` | 媒体节点，语义在内容而非几何 |
| `text` | 文本节点，`prompt` 作标题、`content` 作正文 |
| 连线 | 由 `connect_nodes` 以 **node id** 引用两端，不含几何属性 |

节点语义的来源是**结构**（"第 3 幕"、"角色参考图"），不是坐标。

## 3 规则地图

<!-- 由 scripts/gen-prompt-spec-map.ts 生成；手工改动会在 prompt-lint 报错 -->

<!-- BEGIN:rule-map -->
| order | 语义 id | 标题 | 生效范围 | 管什么 |
|---|---|---|---|---|
| 10 | `identity-and-truthfulness` | 身份与语气 | core | 你是 lnkpi 无限画布助手 |
| 20 | `no-gen-claim` | 禁止声称正在生成（genTools 启用） | genTools | 3. 不要声称「正在生成」「马上生成」「已开始出图」；用户明确同意前禁止调用 run_*_generation… |
| 20 | `no-gen-tools` | 禁止声称正在生成（genTools 未启用） | core（除非 genTools） | 3. 不要声称「正在生成」「马上生成」「已开始出图」；不要调用 run_*_generation… |
| 30 | `no-template` | 侧栏参考图与芯片 key | core | 7. 已提供【侧栏参考图解析】时不得声称只能看到文件名或节点标题 |
| 35 | `memory-scope-isolation` | 记忆归属与「记忆 ≠ 当前观察」 | core | 记忆条目带 scope/sessionId/crossCanvas |
| 40 | `media-tool-policy` | 写工具策略 | writeTools | 4. 用户要创建媒体节点或明确「生成一张…」时：upsert_media_node 建节点（可带 prompt）… |
| 45 | `canvas-view-card` | 画布视图卡片策略 | writeTools | 16. 用户问「为什么/怎么/关系/结构/流程/解释/说明/分析/对比/梳理… |
| 46 | `canvas-daily-ops` | 画布日常操作 | writeTools | 19. 用户要求「整理/排版/排列/按关系展开/对齐」节点：用 arrange_nodes… |
| 50 | `gen-gate` | 生成工具策略 | genTools | 11. run_image/video/text/prompt/audio_generation 仅对已 propose… |
| 55 | `todo-write-tool` | 任务计划汇报（todo_write） | todoTools | 多步任务开工前 todo_write 提交清单（全量覆写），完成即更新，全部完成交空数组… |
| 60 | `readonly-session-guard` | 写操作守卫 | core（除非 writeTools） | 10. 当前会话仅开放只读查询工具（画布摘要/节点/生成状态/素材列表等）；创建、修改、连线… |
<!-- END:rule-map -->

## 4 分组机制

| 分组 | 含义 |
|---|---|
| 无 `group` 字段 | `core`，恒注入 |
| `group: writeTools` | 写工具可用时注入 |
| `group: genTools` | 生成工具可用时注入 |
| `unlessGroup: writeTools` | `writeTools` **未**启用时注入（只读守卫） |

`.gen` / `.nogen` 是同一规则的互斥两版，靠 `group` / `unlessGroup` 切换，不要合并成一个文件。

## 5 预算纪律

<!-- 由 scripts/gen-prompt-spec-map.ts 生成；手工改动会在 prompt-lint 报错 -->

<!-- BEGIN:budget-table -->
| 项 | 值 |
|---|---|
| 硬线 `STATIC_BUDGET_CHARS` | 3200 |
| 预警线 `STATIC_BUDGET_WARN_CHARS` | 2720（= 3200 × 0.85） |
| 全组合当前实测 | **3111**（已过预警线，硬线内） |
| **余量** | **89 字符**（硬线 3200 − 实测 3111） |
<!-- END:budget-table -->

**余量是硬事实，不是估计。** 加新规则前先跑 `pnpm prompt:lint` 看余量。
超预警线不阻断但会打印 warning——**看到 warning 就该停下评估，不要装看不见**。

> 🟡 **当前状态**：余量 89 字符，已过预警线但距硬线仍有余。
> 已从 #218 之前的**贴线状态**（余 6）解除——减点名把读工具名从规则正文移除、改为能力描述。
> 但 89 字符仍**不宽裕**：加新规则前先算字数；要大幅扩写仍需先压缩正文或（人工拍板）上调硬线。
> AI 不得自行删规则，也不得自行抬预算。

> ✅ **上表已机检（本 PR 起）**：由 `scripts/gen-prompt-spec-map.ts` 读 `renderStatic(磁盘 registry, ["core","writeTools","genTools"])` 生成，
> 与 `L6` 判据**同源同一算法**；`prompt-lint.yml` CI 会跑 `--check` ⇒ 规则正文一变、本表未重生成即红。
> 历史教训：本表曾**手工维护、无机检**，因此漂移过两次（#218 减点名 3195→3042、#231 规则 22 加句 3042→3076 都未同步），
> 读者按过期余量（"只剩 6 字符"）做决策 ⇒ 本 PR 改为生成式根治。

> 📜 **历史归因（2026-10-05，历史记录，不构成当前状态）**：当时全组合实测 **3194**，起点 **3192**
> （= master `0e82cac1`），某 PR 把两处硬编码数字引用改成语义 anchor 引用，**净 +2**：
> `no_gen_claim.gen`「规则 11」→「见 `gen-gate`」(+1)、`media_tool_policy`「规则 14」→「见 `no-template`」(+1)。
> ⚠️ 初版写成「见 `gen-confirm-gate`」/「见 `no-template-capability`」时两处共 **+34** ⇒ 3226，**超线 26**；
> 收口时按三条**不改语义**的手法压回（anchor 名压短、去掉与被指向规则重复的解释性前缀、保留反引号写法），
> 详见 `pi-prompt-assembler.service.test.ts` 的 BASELINE 注释。换言之：当时超线的主因是 master #184 吃掉了余量。

## 6 变更流程

1. 改 `rules/<id>.md` 正文
2. 同步 6 处：frontmatter · `MANIFEST.yaml`（`version` + `contentHash`）· `COMPOSED_IDS` · `FALLBACK_BY_ID` + `prompt-registry.fallback.ts` · 🔴 `renderStaticFallback()` 拼装顺序 · `pi-prompt-assembler.service.test.ts` 的 `EXPECTED`
3. `pnpm prompt:lint` 必须 ok
4. 跑组装管线契约测试（Task 4 建）
5. 重生成规则地图：`npx tsx scripts/gen-prompt-spec-map.ts --write`
6. 开 PR

🔴 第2 步的 `renderStaticFallback()` 漏改 ⇒ 容器读不到 registry 走fallback 时**该规则整段消失且无任何报错**（degraded 本身是静默降级）。

### 6.1 引用写法约定（🔴 必读，写错静默绿）

**规则正文里引用另一条规则，必须写成「见 \`<anchor>\`」——anchor 用反引号括起来、紧跟在「见」字后面。**

| 写法 | L10 能否扫到 | 后果 |
|---|---|---|
| 见 \`media-tool-policy\` | ✅ 命中 | 正确 |
| 见 \`gen-gate\` | ✅ 命中 | 正确 |
| 见「media-tool-policy」 | ❌ **扫不到** | **断链，L10 静默绿、零告警** |
| 见 “media-tool-policy” | ❌ **扫不到** | 同上 |
| 见 upsert_media_node | 不命中（设计如此） | 工具名不是 anchor，零误报（§7.3） |

**为什么标点不能换**：L10 的扫描模式是 `见\s*`?(` + anchor 字符集 + 右边界断言)（`prompt-registry.loader.ts:387`）。
反引号本身是**可选**的（所以裸写 `见 media-tool-policy` 也能命中），但**「见」与 anchor 之间不能夹任何别的字符**——
中文引号「」、""、书名号一律落在 `\s*` 之外，捕获组直接匹配失败。判据扫不到 ⇒ 引用不存在这件事**永远不会被报出来**。

⚠️ 这与被消灭的旧「见规则 14」是同一类失效：**引用形态与扫描模式不闭合 ⇒ 静默断链**。
L11（校验 anchor 自身合规）与 L10（校验引用指向真实 anchor）共用同一份字符集常量（`ANCHOR_CHARSET` → `ANCHOR_CHARSET_IN_TEXT`），
所以**只要引用写成规范形态，L10 就能扫到它**；写成中文引号则连扫都扫不到，不在门禁能力范围内。

