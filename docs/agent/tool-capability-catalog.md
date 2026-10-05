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
| 常驻 / 延迟 | **37 / 10**（2026-10-06 起） | `ALWAYS_ON_TOOL_NAMES` 37 个；其余 10 个延迟（含默认不注册的那 1 个）<br>发现 A 按 A1 修复后 `focus_nodes` 由延迟提为常驻（原 36 / 11） |

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

## 3. 三条硬发现

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

### 发现 C（缺陷，中风险）：`tool_search` 的中文查询会整串比对导致 miss

`tiering.ts:167-171` 的匹配是 `q.split(/\s+/).filter(Boolean)` 后 `keywords.some(kw => hay.includes(kw))`。中文查询通常**没有空格** ⇒ 整句变成一个 keyword，必须是 haystack 的**连续子串**才命中：

**实测**（假工具 `undo`/`redo`/`focus_nodes`，调 `tool_search` 的 execute）：

| query | 实测结果 | 原因 |
|---|---|---|
| `撤销` | ✅ `loaded=[undo]` | 命中 label「撤销上次画布编辑」 |
| `撤销操作` | ❌ `loaded=[]` | haystack 里没有「撤销操作」这个连续串 |
| `把刚才的编辑撤销掉` | ❌ `loaded=[]` | 同上 |
| `定位` | ✅ `loaded=[focus_nodes]` | 命中中文 label |
| `undo` | ⚠️ `loaded=[undo, redo]` | `redo` 的英文 description 里含 "undo stack" ⇒ **误命中** |

haystack = `name + label + (summary ?? description) + description`，**中文只落在 label 一处**（`description` 多为英文）。⇒ 两个方向的错：中文长句 miss、英文短词误命中。miss 后模型拿到完整目录（这一步是对的）但已消耗一轮。

修法（T2 范围）：给延迟工具补中文 `summary` 关键词字段，或按字符 n-gram / 逐字包含匹配。**零 L6 成本**（不进 prompt）。

### 附带：常驻集中「零下发点名」的 2 个工具

`run_text_generation` / `run_prompt_generation` 无任何规则或 skill 点名，仍留在常驻集——这是 `tiering.ts:25` 的**有意豁免**（「run_* / cancel_generation 保留常驻，用户确认后当轮即用，双保险」）。**不算违规**，但登记在此，作为常驻瘦身时的候选（`run_*` 五个里只有这两个零引用）。

---

## 4. 目录 — 常驻集（37）

「点名」列只列**会下发**的来源；`PR:` = prompt-registry 规则，`SK:` = skill（括号内为文件:行）。

| # | 工具名 | 点名资产（下发源） | 触发话术（什么时候该用它） |
|---|---|---|---|
| 1 | `get_canvas_summary` | PR:canvas_daily_ops:12；SK:drama-qc-review, drama-storyboard | 用户问「画布有什么 / 多少节点 / 有哪些任务在跑」——先它，不要凭记忆答 |
| 2 | `get_canvas_layout` | PR:canvas_daily_ops:12, PROMPT_SPEC；SK:drama-qc-review | 需要**坐标与连线关系**时（排布、检查错连、算位置）——比 summary 重，按需取 |
| 3 | `get_node` | PR:canvas_daily_ops:12；SK:drama-qc-review | 已知节点 id，要看它的**完整字段**（文本、参数、状态） |
| 4 | `get_generation_status` | PR:canvas_daily_ops:12, gen_tool_policy:12；SK:ecommerce-product-photo | 用户问「生成到哪了 / 好了没」——按 id 查进度 |
| 5 | `get_generation_diagnostic` | PR:canvas_daily_ops:12 | 生成**失败或超时**后要原因——先 status 再它 |
| 6 | `list_generation_tasks` | PR:canvas_daily_ops:12 | 问「有哪些任务在跑」——列任务，勿凭记忆 |
| 7 | `list_user_assets` | PR:canvas_daily_ops:13 | 问「我的素材 / 资产库里有什么」 |
| 8 | `list_model_options` | SK:drama-audio-design | 要选生成模型 / 用户问「有哪些模型可用」 |
| 9 | `list_generation_scenes` | PR:media_tool_policy:13 | 配生成参数前要确认有哪些场景模板 |
| 10 | `web_search` | PR:canvas_daily_ops:13 | 需要外部资料且**不知道具体 URL**——须给来源 |
| 11 | `web_fetch` | PR:canvas_daily_ops:13 | 已有**明确 URL**，要抓正文 |
| 12 | `read_document` | PR:canvas_daily_ops:13 | 用户上传了参考文档/附件，要读全文 |
| 13 | `recall_memory` | SK:drama-*（5 个） | 开新任务前取回该项目/角色的既有约定与偏好 |
| 14 | `save_memory` | PR:memory_scope.tail:10；SK:drama-*（5 个） | 沉淀跨会话记忆；默认仅本画布，只有偏好/品牌/暗号才 `scope:'user'` |
| 15 | `upsert_media_node` | PR:media_tool_policy:11-12；SK:drama-*, ecommerce | 要在画布上**新建或更新一个媒体节点**（图/视频/音频） |
| 16 | `upsert_prompt_node` | SK:drama-script-writing, drama-storyboard | 新建/更新**提示词节点**（剧本、分镜文案） |
| 17 | `set_node_text` | PR:canvas_view_policy:11, media_tool_policy:11-12；SK:drama-script-writing, ecommerce | 改节点上的文字（改提示词、改文案）——改完即算内容落地 |
| 18 | `update_node` | SK:drama-audio-design, drama-qc-review | 改节点**非文本属性**（标题、尺寸、状态等） |
| 19 | `connect_nodes` | PR:media_tool_policy:11-12；SK:drama-*, ecommerce | 建立节点间的因果/引用连线（谁生成谁、谁参考谁） |
| 20 | `attach_refs` | PR:canvas_daily_ops:13, media_tool_policy:11；SK:drama-*, ecommerce | 把**已有**媒体节点挂成某个节点的参考图 |
| 21 | `apply_sidebar_attachments` | PR:media_tool_policy:11；SK:drama-*, ecommerce | 把侧栏里用户贴的附件落到指定节点上 |
| 22 | `propose_generation` | PR:canvas_view_policy:13, gen_tool_policy:11, media_tool_policy:11-13；SK:drama-*, ecommerce（6 个） | **要出图/出视频前的必经一步**：提交生成提议、等用户确认（不可跳过） |
| 23 | `arrange_nodes` | PR:canvas_daily_ops:11；SK:drama-*, ecommerce（5 个） | 用户说「整理 / 排版 / 按关系展开 / 对齐」——只重排不改内容，别自己算坐标 |
| 24 | `render_canvas_view` | PR:canvas_view_policy:11-13 | 解释、澄清、汇报类场景要**出一张卡片给用户看**（非仅文本回答） |
| 25 | `set_node_generation_params` | PR:media_tool_policy:13 | 建节点后**补生成参数**（模型、尺寸、场景）——规则要求「落参数才叫完成」 |
| 26 | `focus_node`（单数） | SK:drama-audio-design, drama-character-design, drama-motion-video, drama-scene-worldview, drama-storyboard, ecommerce | 出图后定位到**刚生成的那一个**节点做 QA |
| 27 | `focus_nodes`（复数）⚠️ | **PR:canvas_daily_ops:11**（规则 19） | 把**一批**节点带进视口（「整理/排版」刚排完的场景）。2026-10-06 由延迟集提为常驻，见发现 A |
| 28 | `remove_edges` | SK:drama-qc-review | 发现**连错**的引用关系时删边（edge id 来自 `get_canvas_layout`） |
| 29 | `run_image_generation` | SK:ecommerce-product-photo | 用户已确认提议后**真正跑图**；`status=timeout` 未完，稍后查 status |
| 30 | `run_video_generation` | SK:drama-motion-video | 跑视频（最长约 11 min），确认语义同 image |
| 31 | `run_text_generation` | （无）⚠️ 有意豁免 | 跑文案生成，结果写入节点内容 |
| 32 | `run_prompt_generation` | （无）⚠️ 有意豁免 | 跑提示词生成，结果写入节点 |
| 33 | `run_audio_generation` | SK:drama-audio-design, drama-storyboard | 跑 TTS/音频生成，用节点上的音频参数 |
| 34 | `cancel_generation` | PR:gen_tool_policy:13 | 用户要中止进行中的生成（按 record_id 或 node_id） |
| 35 | `ask_user` | PR:media_tool_policy:14；SK:drama-*, ecommerce（4 个） | 需要用户拍板/补信息时出选项卡，别替用户猜 |
| 36 | `load_skill` | SK:ecommerce-product-photo | 进入某垂类任务（剧集、电商图…）时加载该 skill 的详细步骤 |
| 37 | `tool_search` | PR:canvas_daily_ops:14 | **现有工具里没有用户要的能力时先搜它**（勿直接答「做不到」） |

## 5. 目录 — 延迟集（10）

这 10 个的 schema 默认不下发，需要 `tool_search` 命中后才可调用。**全部无资产点名**，符合判据
（原第 1 项 `focus_nodes` 因被规则第 19 条点名，已于 2026-10-06 按发现 A 的 A1 方案提为常驻）。

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

## 7. 待拍板

| 项 | 需要谁定 | 说明 |
|---|---|---|
| ~~发现 A 的修法~~ | ✅ **已决：A1** | 采纳 A1（提常驻）：零提示词成本、零规则改动、可逆；A2/A3 要动 prompt 规则（6 处同步 + L6 余 6 字符）属红线。<br>⚠️ 代价：常驻 36→37，与 roadmap P1「≤28」反向 —— 但按 §4 硬边界，≤28 本来就只能靠「减点名」达成，多 1 个不是主要矛盾 |
| 是否把「延迟 ∩ 点名 = ∅」接成 CI 门禁 | R5 + R6 | 现状命中 1 项 ⇒ 接门禁即红，需先修 A 或先带 allowlist |
| `run_text_generation` / `run_prompt_generation` 是否移出常驻 | R5 | 与「常驻 36→≤28」目标同向，但违反 `tiering.ts:56` 的双保险设计 |
| `skills/` 归属 | R1 + R5 | drama-* 是 R1 的「点名来源」，R5-T2 要往里写 tool_search 线索 ⇒ 需先锁归属 |
