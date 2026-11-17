# P3 导入 UI + composer 技能胶囊条 + 管理技能页 · 设计规格

> 立项日期：2026-11-17。状态：**已实施上线（PR #938 合 8ebf962e，2026-11-17 生产部署+冒烟通过）**。
> 上位规格：`2026-11-16-creative-skills-ecosystem-discovery-loading-design-v2.md`（P3 = 北极星 Must）。
> 前序闭环：`2026-11-16-builtin-skills-discoverability-design.md`（#929/#931，基准线已上线，生产 ce22e69a）——本刀在其数据面之上做 UI 层，**不新增任何后端数据协议**。
> 遵循：AGENTS.md「第一原则——吃满上游、不重复造轮子」（§5 附逐项等价物检索结论表）。

## 1. 背景与目标

P3 判据前两条 Must 至今未达：用户无法从界面**导入自定义技能**（`skillApi.import` 零调用方），技能管理只有极简列表（无开关/搜索/批量/分组）。同时用户拍板补充两个 UI/UX 点：

1. composer 点 `+` → 选【技能】→ 弹 sheet 选择技能 → composer 插入**技能胶囊条**（X 可移除）；
2. sheet 底部增加【管理技能】入口，管理页按参考图升级（网格卡片 + 胶囊开关 + 分组 + 批量管理）。

目标一句话：**自定义技能「导得进、管得住、选得快、用得上」全链 UI 闭环，后端零新端点。**

## 2. 现状证据锚（回代码核对，2026-11-17）

| # | 事实 | 位置 |
|---|---|---|
| E1 | `+` 弹卡（attachCard）= 四瓦片（拍照/图片/添加文件/资产库）+ 行区【专家(置灰)/技能/连接器(置灰)】；【技能】项已存在，展开为 **inline 子菜单单选**（自动 + dockSkills），选中写 `activeSkillId`（单值） | `AgentSideRail.vue:4251-4310` |
| E2 | `activeSkillId` 发送后**不清空**（持续选中，placeholder 常显）；发送载荷 `skillId: activeSkillId.value ?? undefined`（单数） | `AgentSideRail.vue:950,1825`；全文件无 `activeSkillId.value = null` 清空点 |
| E3 | 服务端 `resolveForceSkills(skillId)` 只产出**单元素**数组，但 pi-runtime `forceSkills?: string[]` 本就是数组、`lane.skill()` 原生收多个 | `resolve-force-skills.ts`；`pi-runtime/src/app.ts:231`、`session-manager.ts:2733-2781` |
| E4 | `skillApi.import(text, sourceType='paste')` 端点齐备、web 零调用方 | `skill-api.ts:113-117` |
| E5 | `skillApi` 管理方法全齐：`mine / setEnabled / uninstallBatch(ids, confirmed) / remove / pin`——**批量卸载服务端现成、UI 无消费** | `skill-api.ts:98-145` |
| E6 | `SkillDiscoverPanel` 已有 market/mine 双 tab；mine tab = 列表行 + 文字按钮（启用/停用/回滚/卸载）+ 单卸载确认弹窗；**无**开关样式/搜索/批量/分组/网格 | `SkillDiscoverPanel.vue:117-235` |
| E7 | `MineItem.sourceType` 字段现成（paste/zip/url/github/market），可直接做「用户自定义 vs 来自市场」分组 | `skill-api.ts:56-73` |
| E8 | `SkillDiscoverPanel` 被 `DiscoverPane.vue` 复用（移动端发现页 tab）——升级它则两端同时受益 | `DiscoverPane.vue:28,197` |
| E9 | `dockSkills`（#929）= `runtimeSkillsToInstalled(runtimeList) + mine` 经 `mergeAgentSkills` 合并（含 enabled/userInvocable 过滤 + 内置兜底），已是「可选技能」单一事实源 | `AgentSideRail.vue:945-960` |
| E10 | MentionInput 为纯 textarea + backdrop，`@`/`/` 均为文本插入；不支持行内不可编辑 token（胶囊）——行内胶囊需 contenteditable 重写，威胁 @ mention / 输入预测 / 粘贴提升三既有能力 | `MentionInput.vue`（#929 后含 slash menuMode） |

## 3. 范围

### 3.1 做
- **C0 导入 UI**：管理视图顶部【导入技能】→ 弹窗粘贴 SKILL.md → `import(text,'paste')`。
- **C1 技能选择 sheet**：`+` →【技能】由 inline 子菜单升级为 sheet（内置 + 已装全量，同 E9 源）。
- **C2 技能胶囊条**：sheet 选中 → composer 插入胶囊（多选、X 移除），发送映射 `forceSkills[]`。
- **C3 管理技能视图**：mine tab 升级为参考图样式（网格卡片 + 开关 + 分组 + 搜索 + 批量管理）。
- **C4 sheet 底部【管理技能】入口**。

### 3.2 明确不做（分期/他刀）
- zip/url/github 导入 UI（后端 `sourceType` 已支持，首版只做 paste 弹窗；其余分期）。
- 「去上架」按钮（图2 顶部）——属发布线（P4/市场发布），不在本刀。
- mine 分页端点（图2「加载更多」）——mine 全量规模小，首版前端一次渲染；分页待真实数据量再立。
- textarea 行内胶囊 token（需 contenteditable 重写 MentionInput，见 E10，列二期）。
- 不改 v2 主规格正文；不改 pi-runtime（不触发 runtime-deploy）；`/` 文本命令 `parseSkillCommand` 行为逐字保留。

## 4. 关键设计

### 4.1 C1 技能选择 sheet（替代 inline 子菜单）
- 数据源 = **同一 `dockSkills`**（E9，含内置 11 + 已装启用项）；sheet 内每项：图标 + 名 + 描述 + 已选标记。
- 打开方式沿用 `+` 卡既有弹出容器形态（桌面 popover 卡扩展 / 移动端底部 sheet——沿 attachCard Teleport 既有模式），**不新造浮层机制**。
- 选中即关闭 sheet 并追加胶囊（多选语义：重复打开可继续追加）。

### 4.2 C2 技能胶囊条
- 渲染：composer 输入区**上方 chips 行**（框内、文本区之上，多胶囊并列换行）——裁决理由见 §4.5 裁决2。
- 样式：圆角胶囊 + 技能图标 + 名称 + `X`（可移除），遵守 design-tokens（禁 hex/`--neo-*`），图1 为视觉参照。
- 状态：`selectedSkillIds: string[]` 替代 `activeSkillId` 单选（向下兼容见 §4.4）。X 移除即从数组删。
- 生命周期：**随消息一次性**（发送成功后清空）——裁决见 §4.5 裁决3；placeholder 提示改为「未选胶囊时」的既有默认。
- `isProductVisualSkill` 等单技能特判改读首个胶囊。

### 4.3 C4 + C0/C3 管理技能视图与导入
- 入口：sheet 底部固定【管理技能】按钮 → 打开技能面板并定位 mine tab（桌面/移动沿用各自端既有容器：DiscoverPane / 侧栏面板，不新造路由）。
- mine tab 重构为参考图样式：
  - 顶栏：标题（含计数）+ 搜索框（前端过滤 displayName/skill）+【导入技能】按钮；
  - 分组：「用户自定义」= `sourceType ∈ {paste,zip,url,github}`，「来自市场」= `market`（E7 现成字段）；
  - 卡片：网格 3 列（移动端自适应 2 列）+ 首字母彩色头像（哈希取色，遵守令牌）+ 名称 + 右上角**胶囊开关**（= `setEnabled`）+ 描述一行截断；
  - 批量管理：进入多选模式 → 选中卡片 → 批量卸载（复用 `uninstallBatch` + 既有单一确认弹窗）；
  - 启停语义与 E6 既有判据一致：停用的技能不出现在 sheet/`/` 候选（mergeAgentSkills enabled 过滤白拿）。
- 导入弹窗：textarea 粘贴 SKILL.md → `import(text,'paste')` → 成功 toast + mine 刷新（新卡出现在「用户自定义」组）；失败（解析失败/重复 hash/兼容告警）原样呈现服务端 message（服务端 `verifyImport` 语义已有，不造前端校验）。

### 4.4 服务端多技能映射（唯一的 Nest 改动）
- 请求 DTO 增 `skillIds?: string[]`，兼容保留 `skillId`（旧客户端 / 首个胶囊）。
- 新纯函数 `resolveForceSkillsMulti(ids, userMessage, known, runtimeNames)`：文本 `/skill` 命令优先级**不变**（命令命中时忽略胶囊？——**不忽略**：命令优先 + 胶囊并存时，胶囊并入 forceSkills，命令名去重）；每个 id 经 `resolveDockSkillTarget` 同款映射（内置映射 → 用户已装 → 运行时名 pass-through），未知名 **fail-soft 过滤 + 计数日志**（不阻断发送，与 dock 既有 fail-soft 口径一致）；产出 `forceSkills: string[]`。
- pi-runtime 零改动（E3：数组原生支持）；forceSkills 未知名 fail-closed 语义在运行时层保留为最后防线。

### 4.5 上游资产复用清单（硬约束——第一原则）

| 能力 | 复用（吃满） | 禁止 |
|---|---|---|
| 技能列表数据 | `dockSkills` / `mergeAgentSkills` / `runtimeSkillsToInstalled`（#929） | 新造第三份列表或硬编码白名单 |
| 管理数据面 | `skillApi.mine/setEnabled/uninstallBatch/remove/pin`（E5 全现成） | 新增任何后端端点/字段 |
| 导入 | `skillApi.import` + 服务端 `verifyImport`（解析/hash/兼容） | 前端重复实现 SKILL.md 解析或格式校验 |
| 多技能通道 | pi-runtime `forceSkills: string[]` + `lane.skill()` | 改 pi-runtime；新造第二显式调用通道 |
| 批量卸载确认 | 既有单一确认弹窗模式（SkillDiscoverPanel confirm） | 新弹窗体系 |
| 管理页载体 | `SkillDiscoverPanel` mine tab 原地升级（E6/E8，DiscoverPane 同时受益） | 另起 `SkillManagePanel` 平行组件 |
| 浮层/sheet 容器 | attachCard Teleport + neo-popover 既有模式 | 新浮层机制 |
| 胶囊图标/头像取色 | agentSkillMap 既有图标；头像取色函数若 design-tokens 已有色板映射则复用 | 新增 hex |

## 5. 行为判据（C 系列，验收口径）

| # | 判据 |
|---|---|
| C1 | `+` →【技能】打开技能选择 sheet；数据源与 dockSkills 完全一致（内置 11 + 已装启用项）；不再出现 inline 子菜单单选交互 |
| C2 | sheet 选中技能 → 关闭并插入胶囊；可追加多个不同技能；已选中技能在 sheet 中有已选标记；再次点选已选中的 = 移除该胶囊 |
| C3 | 胶囊 X 可移除；发送成功后胶囊清空（随消息一次性）；发送载荷含 `skillIds[]`（兼容字段 `skillId` = 首个胶囊） |
| C4 | 多胶囊发送 → Nest 逐个映射 → `forceSkills` 为数组（≥2 实测多元素）；文本 `/skill` 命令与胶囊并存时命令优先、胶囊并入去重 |
| C5 | 未知名胶囊（如发送间隙技能被卸载）fail-soft 过滤不阻断发送；已知名缺失→运行时 `InvalidInputError` 防线仍在 |
| C6 | sheet 底部【管理技能】→ 打开管理视图（mine tab 定位）；桌面/移动两容器可达 |
| C7 | 管理视图：分组（用户自定义/来自市场）正确按 sourceType 划分；搜索框实时过滤；开关切换即 setEnabled 且立即影响 sheet/`/` 候选可见性 |
| C8 | 批量管理：多选 → 批量卸载 → 确认弹窗 → uninstallBatch 成功计数呈现；单卸载路径保留 |
| C9 | 导入弹窗粘贴合法 SKILL.md → import 成功 → mine 刷新、「用户自定义」组出现新卡；粘贴非法内容 → 呈现服务端错误消息，不崩 |
| C10 | 全部新 UI 消费 design-tokens L2/L3；`design-token.test.ts` 与 `vue-tsc` 干净 |

## 6. 负例 / 变异（N 系列，转红判据）

| # | 变异 | 靶 |
|---|---|---|
| N1 | sheet 数据源改为独立硬编码列表（脱离 dockSkills） | C1 |
| N2 | 删胶囊 X 移除逻辑 | C3 |
| N3 | Nest 只处理 `skillId` 单数（丢 skillIds 数组映射） | C4 |
| N4 | 管理视图删分组或搜索过滤 | C7 |
| N5 | 导入成功后不刷新 mine | C9 |
| N6 | enabled=false 技能仍出现在 sheet | C7/C1（mergeAgentSkills 过滤回潮） |

## 7. 诚实边界

- 本刀不含「去上架」与 mine 分页（§3.2）；zip/url/github 导入 UI 分期。
- 胶囊条首版在输入区上方（非文本行内光标处）；行内 token 需 contenteditable 重写，列二期并在评审时向用户说明取舍。
- `userInvocable` / `disableModelInvocation` 控制字段对内置技能仍依赖 G3 golden 重写（上游欠账，本刀沿用 #929 口径不宣称已遵守）。
- 移动端 sheet 高度/手势细节实施期按 attachCard 移动端既有真机修复惯例处理（Teleport + 遮罩收拢）。

## 8. 依赖与部署

- 前置：#929/#931 已上线（生产 ce22e69a）——本刀直接受益，无阻塞依赖。
- 触发面：`apps/web` + `apps/server` → `deploy.yml`（web + API 双 job）；不碰 `services/pi-runtime`。
- **实施回填（2026-11-17）**：PR #938 squash 合 `8ebf962e`，CI 4/4，合并树==CI 验证树（59eb4a7c），deploy 双 job 成功；生产冒烟：API 镜像 `8ebf962e` healthy、healthz 200、web chunk 含 `skillIds`/`uninstallBatch` 标记。变异 N1–N6 全 6/6 RED；web 4341/4341、server 3008/3008（含 arity 守卫 17→18 位同步）。实施期架构微调：胶囊 toggle 同时服务 sheet 与 `/`（onSlashSkillSelect→toggleSkillChip），「自动」=清空数组。遗留：行内 token 胶囊（二期）、zip/url/github 导入 UI、A-6 真机走查 sheet 交互。
- 预计与 A-6 真机走查联动：移动端 sheet 交互上真机后补走查项。

## 9. 等价物检索结论表（第一原则 · 逐项）

| 检索项 | 命令/方式 | 结论 |
|---|---|---|
| 技能导入 UI 现有实现 | grep `skillApi.import` 全 web | 仅 skill-api.ts 定义，零调用方 ⇒ 真缺口 |
| 批量卸载 UI 现有实现 | grep `uninstallBatch` 全 web | 仅 skill-api.ts 定义，零调用方 ⇒ 真缺口 |
| 管理页组件是否已存在 | ls components/skills | 仅 SkillDiscoverPanel ⇒ 升级而非新建 |
| 多技能显式调用通道 | grep `forceSkills` pi-runtime | 数组原生支持 ⇒ 服务端只扩 Nest 一层 |
| 行内胶囊能力 | 读 MentionInput 全文 | 无 contenteditable ⇒ chips 行为最小可行形态 |
