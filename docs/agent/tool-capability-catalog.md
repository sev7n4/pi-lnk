# 工具能力目录（capability-map）

> 对应 [`tool-framework-roadmap.html`](./tool-framework-roadmap.html) **§3 主线 A「能力目录先行」** 的落地产物：
> **47 个工具 × 「谁点名了它」×「归属」×「什么时候该用它」**四列登记。
> roadmap §7 把这一步写成 B（技能包化）的前置——「在能力目录成型前吃 `setActiveTools`，只是把 36 个硬编码白名单搬进 API 调用——换皮，不是能力」。
>
> 本表不是描述性文档，是**决策依据**：它回答「哪个工具可以安全地移出常驻集」「哪个组合已经不一致」。
>
> ⚠️ **编号澄清**：roadmap §4 里的 **T1 指 R4 线的传输层重放契约**（`seq` / `isReplayComplete`），与本文件无关。
> 本文件是 R5 主线 A，请勿把两者混为一谈（roadmap 里 R5 用 A/B/C 编号，不用 T1/T2/T3）。
>
> 数据取自 `origin/master` @ `aba48759`，扫描命令见 §6（可重跑复核）。

## 0. 它解决什么

`tiering.ts` 里那句准绳——**「有没有资产按名字点名它」决定它能不能进延迟集**——此前是**靠记忆和注释维护的**：注释写「`focus_nodes` 未被 skill 点名，保持延迟」，却没人核对它是否被 **prompt 规则**点名。本表把这条准绳变成可扫描、可复核的事实。

## 1. 口径（三个容易吵起来的数字）

| 口径 | 数值 | 说明 |
|---|---|---|
| 工具总数 | **47** | 源码中构造的全部 `LnkpiTool` 对象（含 `tool_search` 元工具） |
| 实际注册 | **46** | `introduce_nodes_to_agent` 属老链路，`includeDeferred` 未显式开启 ⇒ **默认不注册**（`canvas-write.ts:654`） |
| 常驻 / 延迟 | **28 / 19**（2026-10-06 分级下发实验后确认） | `ALWAYS_ON_TOOL_NAMES` 28 个；其余 19 个延迟（含默认不注册的那 1 个）<br>2026-10-06 上午发现 A 按 A1 修复 `focus_nodes` 提为常驻（37/10）；同日 R1 完成减点名第一批：读类诊断 9 工具下沉（规则 20/21/12 改写为能力描述 + 4 个 skill 点名撤改），37→28，达成 roadmap P1「≤28」。<br>⚠️ 中间曾按 R5 协调意见发过一版「分级下发」（常驻 32 + 探针 5 个，#222）——那是**为取得「模型会不会搜」的实验证据**；实测 `tool_search` hit=6/miss=0（无常驻替代品时 4/4 主动搜索）后，本 PR 扩回全量 28。详见 §7「常驻瘦身」行 |

⚠️ 计数的两个坑（已踩过）：① 5 个 `run_*_generation` 由 `generation.ts:99-128` 的 `runTool(...)` 工厂以**位置参数**构造（`runTool(name, label, description, path)`），`grep 'name: "'` 扫不到 ⇒ 早期漏计成 41；② `focus_node`（单数）与 `focus_nodes`（复数）是两个工具，只差一个字母。

### 「点名」要区分下不下发

只有**会进入模型上下文**的点名才构成「模型会直调」的风险：

| 来源 | 是否下发 | 风险 |
|---|---|---|
| `prompt-registry/rules/*.md`（在 `COMPOSED_IDS` 的 10 条内） | ✅ 每轮下发 | **高**——每轮都可能直调 |
| `skills/*.md` | ⚠️ 按需（`load_skill` 加载后才可见） | 中——加载该 skill 后才直调 |
| `prompt-registry/PROMPT_SPEC.md` | ❌ 规范文档，不参与组合 | 无（不计入本表点名） |

`COMPOSED_IDS`（`apps/server/src/agent/pi-runtime/prompt-registry.loader.ts:105`）= `identity.opening`、`no_gen_claim.nogen`、`no_gen_claim.gen`、`sidebar_vision.tail`、`memory_scope.tail`、`media_tool_policy`、`canvas_view_policy`、`canvas_daily_ops`、`gen_tool_policy`、`write_guard`。

## 2. 一致性判据

> **延迟集 ∩ 被资产点名 = ∅**。命中即违规：模型会按名字直调一个 schema 不可见的工具，
> 吃 vendor 硬编码的 `Tool X is unavailable`（`drive/tools.ts:686` 只把 active 工具传给 `prepareToolCall`，
> `before_tool` hook 在其后 ⇒ host 拦不住），且**没有恢复路径**。

扫描结果：**曾命中 1 项**（`focus_nodes`，见发现 A），**已按 A1 修复并回归锁进测试** ⇒ 当前命中 **0 项**。

## 3. 硬发现（A–F）

### 发现 A（缺陷，高风险，已实测，**已按 A1 修复**）：`focus_nodes` 被规则点名却在延迟集

- 规则 `canvas_daily_ops.md:11`（第 19 条，已下发）：
  > 用户要求「整理/排版/排列/按关系展开/对齐」节点：用 arrange_nodes（mode=grid 无序 / along_edges 有向）……**排完用 focus_nodes 带入视口**。
- `focus_nodes` **不在** `ALWAYS_ON_TOOL_NAMES`；`tiering.ts:81` 的注释只写了「未被 skill 点名」，**漏了 prompt 规则这一侧**。
- 后果：模型在「整理/排版」这一高频场景读完规则就直调 `focus_nodes` ⇒ 必吃 `Tool focus_nodes is unavailable` ⇒ 静默放弃「带入视口」这一步（用户看到的是「排完了但视口没动」）。
- ⚠️ 不能简单改成常驻的 `focus_node`（单数）：规则 19 的语义是「把**刚排好的一批**节点带入视口」，`focus_node` 只收单个 `node_id`。
- **实测**（`createLoadToolsTool` + `ALWAYS_ON_TOOL_NAMES` 直读）：`focus_node=true` / `focus_nodes=false` / 常驻集大小 `36`。

三种修法（**待拍板，本轮未动**）：

| 方案 | 动作 | 代价 |
|---|---|---|
| **A1 提常驻 ✅ 已采纳** | 把 `focus_nodes` 加入 `ALWAYS_ON_TOOL_NAMES` | 常驻 36→37，与「常驻瘦身」方向相反，但**零提示词成本、零规则改动、可逆** |
| A2 改规则 | 第 19 条改为「排完用 focus_node 定位关键节点」 | 语义退化（只能定位一个），且动 prompt 规则 ⇒ **触发 6 处同步 + L6 预算已贴线**（余 6 字符） |
| A3 工具侧闭环 ⭐ | `arrange_nodes` 的 execute 结果直接附带 UI focus 命令，规则不再点名 `focus_nodes` | 不占 L6、不占常驻名额、语义不退化；改 `tools/arrange-nodes.ts` + 规则删半句（仍需 6 处同步） |

### 发现 B（修正此前结论）：`tool_search` 的「何时搜」**已经写进规则了**

`canvas_daily_ops.md:14`（第 22 条，已下发）：

> 工具列表里没有的能力，先 `tool_search` 按关键词搜（勿直接答「做不到」），搜到后按其参数调用。

⇒ 此前「没有资产告诉模型何时该搜」的说法**不成立**。触发率至今为 0 的真因应重新归因到：
① 36/47 常驻 ⇒ 模型极少遇到「工具列表里没有的能力」（**没有可搜的内容**）；
② 第 22 条位于 L6 组合尾部，弱模型遵从度低；
③ 见发现 C——**搜了也可能 miss**。

- 📌 附带解除 roadmap §6 的「雷 2」：roadmap 曾警示 `canvas_daily_ops.md` 处于**暂存删除态**、若被删则 tool_search 触发条件不复存在。**实测该文件现已在 master 上**（`rules/canvas_daily_ops.md`，且在 `COMPOSED_IDS` 内）⇒ 雷 2 已解除，不必重做 #184 的规则补写。

### 发现 C（缺陷，中风险，**已修**）：`tool_search` 的中文查询会整串比对导致 miss

> **状态**：`#212` 修了「整串比对」（中文 2-gram + 字段加权 + 绝对阈值）；
> 生产取证又发现**过召回**，已用**相对阈值**修掉（见下）。

**原缺陷**：`tiering.ts` 的匹配是 `q.split(/\s+/)` 后 `keywords.some(kw => hay.includes(kw))`。中文查询通常**没有空格** ⇒ 整句变成一个 keyword，必须是 haystack 的**连续子串**才命中：

| query | 结果 | 原因 |
|---|---|---|
| `撤销` | ✅ hit | 命中 label「撤销上次画布编辑」 |
| `撤销操作` | ❌ miss | haystack 里没有「撤销操作」这个连续串 |
| `把刚才的编辑撤销掉` | ❌ miss | 同上 |

**#212 的修法**：空格分词保留 + 中文 token 切 2-gram；字段加权 `name 3 / label 2 / summary 2 / description 1` + 绝对阈值 2；中文 gram 命中任意字段记 2 分。

**生产取证发现的过召回**（用镜像里真实 dist 跑断言，单测没抓到 —— 替身 `label = name` 是英文）：

| query | #212 之后 | 原因 |
|---|---|---|
| `undo` | ✅ 只命中 undo | redo 只撞 description（权重 1）< 阈值 2 |
| `把刚才的编辑撤销掉` | ⚠️ `[undo, redo]` | 通用词「编辑」命中 `redo` 的**中文 label**「重做画布编辑」= 2 分，达阈值 |

**相对阈值修法**：`threshold = max(2, ceil(gram数 × 0.3))` —— 查询越长要求的证据量越高。
验算：`撤销操作`（4 gram）⇒ 阈值 2，命中保留；`把刚才的编辑撤销掉`（8 gram）⇒ 阈值 3，
只命中 1 个 gram 的 `redo`（2 分）被排除，`undo`（4 分）保留。
⚠️ 阈值抬高只会退化为 miss（返回完整目录、不激活），**不会造成新的误激活** ⇒ 方向安全。

⚠️ **教训（检索类测试通用）**：写匹配/检索测试时，替身必须复制**生产真实的 `label`/`description`** ——
`fakeTool` 的 `label = name`（英文）会同时造成**假绿**（漏掉过召回）与**假红**（相对阈值下低估中文查询的证据量）。

### 发现 D（2026-10-07 实测，**推翻本文件此前的核心前提**）：模型自带延迟工具名的先验，`tool_search` 拦不住

**判据链（三条都成立，证据在 `/data/sessions` 的 eval 会话 jsonl）**：
最干净的一个会话（80KB）里 —— **加载序列为「无」**（`tool_search` 从未成功过），
但模型直接点名并调用了 `get_canvas_summary` / `get_canvas_layout`（共 4 次）⇒ 全部 `is unavailable`。
而系统提示词**零延迟工具名**（逐会话前 4KB 校验）⇒ 名字既不来自搜索结果、也不来自提示词
⇒ **只能来自模型自身的训练先验**。

⇒ **「把工具藏起来 ⇒ 模型不知道它」这个前提在有先验的模型上为假。**
这统一解释了此前的全部观察：A2/A4/A7 的幻觉点名、接近 100% 的命中率，
以及 `get_canvas_nodes` / `get_sidebar_state` / `read` 等**根本不存在**的名字。

⚠️ **对手段落地的直接影响**：想让模型「先搜再调」，**提示词层是低杠杆的**（已两次实证：
#246 的 52 样本 A/B 两臂均 0/52；本轮强指令化实验同样失败）。可行抓手只剩两条：
① 让「先搜」比「直接点名」**成本更低**（⚠️ 已知 `Tool X is unavailable` 写在 **vendor**
`harness/execution/tools.ts:84`，`vendor/` 禁业务 patch ⇒ **改不了**，需另找落点）；
② 承认先验存在，把分层收益按「省 schema token」算，不指望「模型不知道」。

### 发现 E（2026-10-07 读 vendor 源码定性）：激活是**持久**的，且**按 lane 存**

权威实现 `vendor/earendil-works/pi/packages/agent/src/harness/runtime/drive/tool-placement.ts`：

```ts
if (addedNames.length !== 0) {
  nextConfiguration = { ...nextConfiguration, activeToolNames: [...nextConfiguration.activeToolNames, ...addedNames] };
  writes.push(setValue(laneConfig(lane.name), nextConfiguration));   // ← 写进 lane 持久配置
}
```

⇒ **不是「当轮有效」**（此前工作笔记里的「跨轮失效」推论**作废**）。
⚠️ 但写的是 `laneConfig(lane.name)` ⇒ 若 `tool_search` 发生在 lane A、调用发生在 lane B，则 B 的 active 不含该工具。
**实测排除**：`session-manager.ts` 的 `prompt/steer/followUp` 默认 `MAIN_LANE`，
`git grep 'lane: "'` 在 `apps/server/src` 与非测试代码里**零命中** ⇒ 生产与 eval 都只用 main lane，该风险不成立。

### 发现 F（2026-10-07）：`is unavailable` 有**两条来源**，此前被混成一条

| 消息 | 出处 | 查的是 |
|---|---|---|
| `Tool "X" is unavailable` | `harness/execution/tools.ts:84`（`tools.find` 未命中） | **当轮可见工具集** |
| `Tool X not found` | `agent-loop.ts:617`（`currentContext.tools?.find` 未命中） | 上下文工具集 |

生产观测到的是**前者**。
⚠️ **同轮加载的工具当轮仍可能不可见**（发给模型的 schema 快照在 prompt 之前已定型）
⇒ 「同一轮 `tool_search` 加载完、紧接着调它 → 仍 unavailable」**是这套机制的必然结果，不是 bug**；
下一轮才进 schema。这与观测吻合：`grid_slice_image` 在更早一轮加载后被成功调用 11 次。

⚠️ **方法论教训（本轮踩了三次）**：比对「加载了什么 vs 调用了什么」**必须按行号/时间序切成两段**，
不能对全序列做名字匹配 —— 否则会把「加载前的调用」误读成「加载无效」。

### 附带：常驻集中「零下发点名」的 2 个工具

`run_text_generation` / `run_prompt_generation` 无任何规则或 skill 点名，仍留在常驻集——这是 `tiering.ts:25` 的**有意豁免**（「run_* / cancel_generation 保留常驻，用户确认后当轮即用，双保险」）。**不算违规**，但登记在此，作为常驻瘦身时的候选（`run_*` 五个里只有这两个零引用）。

---

## 4. 目录 — 常驻集（28）

「点名」列只列**会下发**的来源；`PR:` = prompt-registry 规则，`SK:` = skill（括号内为文件:行）。
2026-10-06 减点名第一批：原 #1-#8、#12（读类诊断 9 工具）已下沉延迟集，点名同步撤除（规则 20/21/12 改写 + 4 个 skill 撤改）。

| # | 工具名 | 点名资产（下发源） | 触发话术（什么时候该用它） |
|---|---|---|---|
| 1 | `list_generation_scenes` | PR:media_tool_policy:13 | 配生成参数前要确认有哪些场景模板 |
| 2 | `web_search` | PR:canvas_daily_ops:13 | 需要外部资料且**不知道具体 URL**——须给来源 |
| 3 | `web_fetch` | PR:canvas_daily_ops:13 | 已有**明确 URL**，要抓正文 |
| 4 | `recall_memory` | SK:drama-*（5 个） | 开新任务前取回该项目/角色的既有约定与偏好 |
| 5 | `save_memory` | PR:memory_scope.tail:10；SK:drama-*（5 个） | 沉淀跨会话记忆；默认仅本画布，只有偏好/品牌/暗号才 `scope:'user'` |
| 6 | `upsert_media_node` | PR:media_tool_policy:11-12；SK:drama-*, ecommerce | 要在画布上**新建或更新一个媒体节点**（图/视频/音频） |
| 7 | `upsert_prompt_node` | SK:drama-script-writing, drama-storyboard | 新建/更新**提示词节点**（剧本、分镜文案） |
| 8 | `set_node_text` | PR:canvas_view_policy:11, media_tool_policy:11-12；SK:drama-script-writing, ecommerce | 改节点上的文字（改提示词、改文案）——改完即算内容落地 |
| 9 | `update_node` | SK:drama-audio-design, drama-qc-review | 改节点**非文本属性**（标题、尺寸、状态等） |
| 10 | `connect_nodes` | PR:media_tool_policy:11-12；SK:drama-*, ecommerce | 建立节点间的因果/引用连线（谁生成谁、谁参考谁） |
| 11 | `attach_refs` | PR:canvas_daily_ops:13, media_tool_policy:11；SK:drama-*, ecommerce | 把**已有**媒体节点挂成某个节点的参考图 |
| 12 | `apply_sidebar_attachments` | PR:media_tool_policy:11；SK:drama-*, ecommerce | 把侧栏里用户贴的附件落到指定节点上 |
| 13 | `propose_generation` | PR:canvas_view_policy:13, gen_tool_policy:11, media_tool_policy:11-13；SK:drama-*, ecommerce（6 个） | **要出图/出视频前的必经一步**：提交生成提议、等用户确认（不可跳过） |
| 14 | `arrange_nodes` | PR:canvas_daily_ops:11；SK:drama-*, ecommerce（5 个） | 用户说「整理 / 排版 / 按关系展开 / 对齐」——只重排不改内容，别自己算坐标 |
| 15 | `render_canvas_view` | PR:canvas_view_policy:11-13 | 解释、澄清、汇报类场景要**出一张卡片给用户看**（非仅文本回答） |
| 16 | `set_node_generation_params` | PR:media_tool_policy:13 | 建节点后**补生成参数**（模型、尺寸、场景）——规则要求「落参数才叫完成」 |
| 17 | `focus_node`（单数） | SK:drama-audio-design, drama-character-design, drama-motion-video, drama-scene-worldview, drama-storyboard, ecommerce | 出图后定位到**刚生成的那一个**节点做 QA |
| 18 | `focus_nodes`（复数）⚠️ | **PR:canvas_daily_ops:11**（规则 19） | 把**一批**节点带进视口（「整理/排版」刚排完的场景）。2026-10-06 由延迟集提为常驻，见发现 A |
| 19 | `remove_edges` | SK:drama-qc-review | 发现**连错**的引用关系时删边（edge id 来自布局读工具，tool_search 搜「画布」加载） |
| 20 | `run_image_generation` | SK:ecommerce-product-photo | 用户已确认提议后**真正跑图**；`status=timeout` 未完，稍后查 status |
| 21 | `run_video_generation` | SK:drama-motion-video | 跑视频（最长约 11 min），确认语义同 image |
| 22 | `run_text_generation` | （无）⚠️ 有意豁免 | 跑文案生成，结果写入节点内容 |
| 23 | `run_prompt_generation` | （无）⚠️ 有意豁免 | 跑提示词生成，结果写入节点 |
| 24 | `run_audio_generation` | SK:drama-audio-design, drama-storyboard | 跑 TTS/音频生成，用节点上的音频参数 |
| 25 | `cancel_generation` | PR:gen_tool_policy:13 | 用户要中止进行中的生成（按 record_id 或 node_id） |
| 26 | `ask_user` | PR:media_tool_policy:14；SK:drama-*, ecommerce（4 个） | 需要用户拍板/补信息时出选项卡，别替用户猜 |
| 27 | `load_skill` | SK:ecommerce-product-photo | 进入某垂类任务（剧集、电商图…）时加载该 skill 的详细步骤 |
| 28 | `tool_search` | PR:canvas_daily_ops:12/14 | **现有工具里没有用户要的能力时先搜它**（勿直接答「做不到」） |

## 5. 目录 — 延迟集（19）

这 19 个的 schema 默认不下发，需要 `tool_search` 命中后才可调用。**全部无下发侧资产点名**，符合判据
（原第 1 项 `focus_nodes` 因被规则第 19 条点名，已于 2026-10-06 按发现 A 的 A1 方案提为常驻；
2026-10-06 减点名第一批：下表 #11-#19 为读类诊断工具，**点名已同步撤除**后下沉——规则 20/21/12
改写为能力描述 + tool_search 指引，4 个 skill 的点名改为搜索话术）。

| # | 工具名 | label | 点名资产 | 触发话术（什么时候该搜它） |
|---|---|---|---|---|
| 1 | `delete_nodes` | 删除节点 | 无 | 用户明确要删节点（tier=destructive，需确认） |
| 2 | `duplicate_node` | 复制节点 | 无 | 复制节点/子图做变体（可带上游连线） |
| 3 | `undo` | 撤销上次画布编辑 | 无 | 用户说「撤销 / 撤回刚才那步」 |
| 4 | `redo` | 重做画布编辑 | 无 | 撤销后又想恢复 |
| 5 | `open_image_editor` | 打开图片精修 | 无 | 用户要**手动精修**某张图（打开编辑器 UI） |
| 6 | `apply_asset_to_node` | 落资产到节点 | 无 | 把资产库里某个 asset 直接套到兼容节点上 |
| 7 | `save_node_to_asset_library` | 存入资产库 | 无 | 把某个节点的结果**存成资产**供以后复用 |
| 8 | `upload_media_to_canvas` | 上传媒体 | 无 | 从公网 URL 加一个媒体节点进画布 |
| 9 | `grid_slice_image` | 切图 | 无 | 把一张图等分切成 cols×rows（只返 URL，不写画布） |
| 10 | `introduce_nodes_to_agent` | 引入节点到侧栏 | 无 | 老链路；**默认不注册**（`includeDeferred` 未开） |
| 11 | `get_canvas_summary` | 画布概览 | ~~规则20/~~SK（已撤） | 问「画布有什么 / 多少节点」——tool_search 搜「画布」 |
| 12 | `get_canvas_layout` | 画布布局 | ~~规则20/~~SK（已撤） | 要**坐标与连线关系**（排布、查错连、算位置）——搜「画布/布局」 |
| 13 | `get_node` | 节点详情 | ~~规则20/~~SK（已撤） | 已知节点 id 要看**完整字段**——搜「节点」 |
| 14 | `list_generation_tasks` | 生成任务清单 | ~~规则20~~（已撤） | 问「有哪些任务在跑」——搜「任务」 |
| 15 | `get_generation_status` | 生成进度 | ~~规则12/20/~~SK（已撤） | 问「生成到哪了 / 好了没」——搜「进度」 |
| 16 | `get_generation_diagnostic` | 生成诊断 | ~~规则20~~（已撤） | 生成**失败/超时**后要原因——搜「进度/诊断」 |
| 17 | `list_user_assets` | 资产库清单 | ~~规则21~~（已撤） | 问「我的素材/资产库里有什么」——搜「资产」 |
| 18 | `read_document` | 读上传文档 | ~~规则21~~（已撤） | 用户上传参考文档/附件要读全文——搜「文档」 |
| 19 | `list_model_options` | 模型选项 | ~~SK:drama-audio-design~~（已撤） | 要选生成模型 / 问「有哪些模型」——搜「模型」 |

## 6. 复现命令

在仓库根目录执行（46 个工具名按 §1 口径穷举，含 5 个工厂构造的 `run_*`）：

```bash
TOOLS="apply_asset_to_node apply_sidebar_attachments arrange_nodes ask_user attach_refs \
cancel_generation connect_nodes delete_nodes duplicate_node focus_node focus_nodes \
get_canvas_layout get_canvas_summary get_generation_diagnostic get_generation_status get_node \
grid_slice_image introduce_nodes_to_agent list_generation_scenes list_generation_tasks \
list_model_options list_user_assets load_skill open_image_editor propose_generation \
read_document recall_memory redo remove_edges render_canvas_view save_memory \
save_node_to_asset_library set_node_generation_params set_node_text tool_search undo \
update_node upload_media_to_canvas upsert_media_node upsert_prompt_node web_fetch web_search \
run_image_generation run_video_generation run_text_generation run_prompt_generation run_audio_generation"
for t in $TOOLS; do
  hits=$(grep -rlE "\b${t}\b" prompt-registry skills 2>/dev/null | sort | tr '\n' ' ')
  echo "$t :: ${hits:-（无点名）}"
done
```

⚠️ 三个会被踩的坑：① **必须用 `-E`**（BSD grep 的 BRE 不支持 `\|`）；② **必须加 `\b`**，否则 `focus_node` 会把 `focus_nodes` 一起命中；③ `PROMPT_SPEC.md` 的命中要按 §1 排除（不下发）。

## 7. 决策台账

| 项 | 状态 | 说明 |
|---|---|---|
| 发现 A（`focus_nodes` 被规则点名却在延迟集） | ✅ **已决并落地：A1** | 采纳 A1（提常驻）：零提示词成本、零规则改动、删一行即回退；A2/A3 要动 prompt 规则（6 处同步 + L6 余 6 字符）属红线。已落 #216 |
| 发现 C（中文查询整串比对） | ✅ **已决并落地：2-gram + 加权 + 相对阈值** | #212（2-gram + 字段加权 + 绝对阈值）+ #217（相对阈值修过召回）。零 L6 成本 |
| 常驻瘦身（37 → ≤28） | ✅ **已达成 28，且经分级下发实验实证**（2026-10-06） | ① **点名撤除**（规则 20/21/12 改写 + 4 个 skill 搜索话术）与 api 上线（`registryHash 8916a0c7244f`）。② 按 R5 窗口协调意见先做**分级下发**（#222：常驻 32 + 探针 5 个）——因为全量下沉的前置「模型会去搜」当时**无证据**（tool_search 两窗口恒 0）。③ **实验结论（本 PR 扩到全量）**：真实模型（agnes-3.0-flash / 用户 BYOK）12 轮探针，`pi_runtime_tool_search_calls_total{outcome="hit"}` = **6、miss/empty = 0**；**无常驻替代品的探针 4/4 主动搜索命中**（模型、文档），有替代品的 2/6（其余用 `get_canvas_summary` 凑答）。⇒ 「模型不会搜」的先验**被推翻**——旧取证的 0 触发是**没动机**，不是不可达。④ **附带发现（比上面更硬的一条设计铁律）**：有替代品的场景出现过一次**静默答错**（问「素材库里有什么」，模型用画布摘要看到本画布为空就答「素材库没有任何节点」，实测素材库有 18 张图）⇒ **核心读能力必须与整套读工具同进退**，留半个 = 幻觉源。回滚口：恢复 `ALWAYS_ON` 名单（单文件）或 kill switch `PI_RUNTIME_TOOL_TIERING=off` |
| `skills/` 归属 | ✅ **已决：段落级**（2026-10-06 用户拍板） | 正文归 R1；尾部固定小节 `## 工具可用性` 归 R5。已写进 `AGENTS.md`「改工具分层」节。减点名第一批 4 个 skill 的点名撤改由 R1 完成 |
| 「延迟 ∩ 点名 = ∅」接 CI 门禁（②） | ✅ **已接**（R5，2026-10-06） | `scripts/verify-tool-tiering.ts` + `pnpm verify-tool-tiering`，已挂进 `ci.yml` 的 `Verify spec figures` job。四条断言：A1 延迟集 ∩（COMPOSED_IDS 内规则 + `skills/*.md`）点名 = ∅（红线）／A2 ALWAYS_ON 无幽灵名／A3 常驻项必须真注册／A4 `focus_node`+`focus_nodes` 双常驻回归锁（这坑踩过两个月）。变异测试：规则点名→红、skill 点名→红、移出 `focus_nodes`→红、加幽灵名→红。当前实测：注册 47 / 常驻 28 / 延迟 19 / **A1 命中 0** |
| 「叙述代替调用」残余失败形态 | ✅ **用户裁定：保留 + 补观测**（2026-10-06；规则层压缩已落地 #231） | 全量 28 复测 10 轮中 1 例「输出『我先搜索…』却没真调」（约 10-20% 可恢复失败率）。规则 22 追加「宣告要搜的同一轮必须真调 tool_search，禁止只叙述不调用」（+34 字符，L6 全组合 3042→3076，余 124）。⚠️ 按仓库判据这是**概率性缓解**（「模型能复述指令但不会照做」），确定性担保仍以事件层（`tool_start`/`tool_end`）为准。<br>**用户裁定：保留不回滚 + 补观测**（R1 曾把「推进下一步」误读为授权、已如实上报）。观测口径（失败形态两步判定 / H0 / 阈值不拍整数 / **事先写死的回滚条件**）已定于 `docs/ops/prompt-ab-runbook.md`「观测口径」节。回滚 = 规则 22 删该分句 |
| 观测基线与判据（③） | ✅ **基线已取，判据已定**（2026-10-06 生产 `85dbcb04`） | 实测：`tool_search_calls_total{outcome="hit"}` = **9**、`miss` = 1、`tool_search_activated_total` = **42**、工具调用总数 = **77** ⇒ 触发率 ≈ **11.5%**（10 次搜索 / 87 次相关调用）。被下沉的 9 个读工具**全有真实调用**（`get_canvas_summary` 6 / `list_model_options` 5 / `get_node` 4 / `get_canvas_layout` 3 …）⇒ **功能没断，动机已在真实流量里出现**。<br>**判据必须挂分母**：`rate(pi_runtime_tool_search_calls_total{outcome="hit"}[1h]) / rate(pi_runtime_tool_calls_total[1h]) > 0`；⛔ 不挂 `sessions_active`（瞬时 gauge，=0 不代表没流量，#219 已吃过这个亏）。<br>是否加告警归 R2（`#226` 已有 Actions schedule + PromQL 巡检，R5 不重复造轮子）。<br>⚠️ 残余风险（R1 报）：约 10–20% 轮次「叙述代替调用」⇒ **用户裁定「保留 + 补观测」**（见上行 R1 行）；观测口径已定于 `prompt-ab-runbook.md`「观测口径」节，失败可见、可重跑恢复 |
| `run_text_generation` / `run_prompt_generation` 是否移出常驻 | R5 | 双保险设计 vs 常驻预算，维持 R5 判 |

