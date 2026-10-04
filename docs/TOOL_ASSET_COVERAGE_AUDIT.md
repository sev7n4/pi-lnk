# 工具资产覆盖排查（2026-10-04）

> 起因：L1 baseline 里唯一剩下的真实缺陷 `tool-discovery-001`（期望 `arrange_nodes`，
> 实际只调了 `get_canvas_summary` + `get_canvas_layout`）。
> 由此做**全量工具**的资产覆盖排查。
>
> 判据沿用 `services/pi-runtime/src/tools/tiering.ts` 里已确立的那条准绳：
> **「某工具能否进延迟集」的唯一准绳 = 有没有资产（prompt 规则 / skills）按名字点名它。**
> 同样的准绳反过来用：**没有资产点名 ⇒ 模型只能靠工具 description 猜 ⇒ 行为不可预期。**

## 方法

```bash
# 某工具是否有资产点名（这是判定的唯一动作）
grep -rn "<tool_name>" prompt-registry/rules/ skills/
```

⚠️ **必须同时查 `rules/` 和 `skills/`** —— 我第一次只查了 `rules/`，
就断言「`arrange_nodes` 无任何资产点名」，**结论错了**（skills 里有 5 处）。
详见 §四的修正记录。

## 数据

- 资产量：`prompt-registry/rules/` 4278 字符 / `skills/` 87870 字符
- 工具总数：**36 个常驻工具**（`ALWAYS_ON_TOOL_NAMES`，当前**无延迟集**）

## 分级结果

### A类·规则集直接点名（13 个）—— 模型在常驻提示里能看到用法

| 工具 | 规则文件 |
|---|---|
| `get_generation_status` | `gen_tool_policy` |
| `list_generation_scenes` | `media_tool_policy` |
| `save_memory` | `memory_scope.tail` |
| `upsert_media_node` | `media_tool_policy` |
| `set_node_text` | `canvas_view_policy`, `media_tool_policy` |
| `connect_nodes` | `media_tool_policy` |
| `attach_refs` | `media_tool_policy` |
| `apply_sidebar_attachments` | `media_tool_policy` |
| `propose_generation` | `canvas_view_policy`, `gen_tool_policy`, `media_tool_policy` |
| `render_canvas_view` | `canvas_view_policy` |
| `set_node_generation_params` | `media_tool_policy` |
| `cancel_generation` | `gen_tool_policy` |
| `run_image_generation` / `run_video_generation` / `run_text_generation` / `run_prompt_generation` / `run_audio_generation` | `gen_tool_policy` 规则 11 **逐字点名全部 5 个** |
| `ask_user` | `media_tool_policy` |

⭐ 这层是**健康**的：写链路核心（`propose_generation` / `upsert_*` / `set_node_*` /
`connect_nodes` / `attach_refs`）与生成纪律（`gen_tool_policy`）都在规则里有明确约定。

### B 类·仅 skills 点名（14 个）—— ⚠️ 只在对应 skill 被加载时可见

| 工具 | 被点名的 skill |
|---|---|
| `arrange_nodes` | drama-character-design, drama-scene-worldview, drama-script-writing, drama-storyboard, ecommerce-product-photo |
| `focus_node` | drama-audio-design, drama-character-design, drama-motion-video, drama-scene-worldview, drama-storyboard, ecommerce-product-photo |
| `recall_memory` | drama-character-design, drama-qc-review, drama-scene-worldview, drama-script-writing, drama-storyboard |
| `get_canvas_summary` | drama-qc-review, drama-storyboard |
| `get_canvas_layout` / `get_node` / `remove_edges` | drama-qc-review |
| `list_model_options` / `update_node` | drama-audio-design |
| `update_node` | drama-qc-review |
| `upsert_prompt_node` | drama-script-writing, drama-storyboard |
| `load_skill` | ecommerce-product-photo |

（`run_image/video/audio_generation` 同时属A 类 —— 规则 11 已逐字点名；
skill 里点名只是「在哪个流程里用」，不构成可达性问题。）

（`run_image/video/audio_generation` 同时属A 类 —— 规则 11 已逐字点名；
skill 里点名只是「在哪个流程里用」，不构成可达性问题。）

⚠️ **这是本次排查的核心发现**：这 14 个工具的用法说明**全部寄生在 skill 里**。
而 skill 的 `description` 是**场景触发词**，例如：

- `drama-motion-video`：「分镜静帧转视频（图生视频）与 motion 提示词设计。当用户要求把分镜变成视频…」
- `drama-audio-design`：「短剧/漫剧配音与声音设计。当用户要求配音、旁白、台词念白…」

⇒ **日常画布操作（整理/排版/查看/定位）不会加载任何 drama-\* skill**
⇒ 这些场景下 B 类工具**没有任何常驻说明**，模型只能靠工具 `description` 猜。

### C 类·无任何资产点名（9 个）—— 🔴 模型只能靠工具 description 猜

| 工具 | 风险评估 |
|---|---|
| `tool_search` | 🔴 **最高** —— 渐进披露的**唯一入口**。生产实测 `tool_search_activated_total = 0`，模型从不知道有它。规则里也没写「找不到工具就搜」 |
| `list_generation_tasks` | 🔴 高 —— 「任务列表」是用户问「我有什么任务在跑」的直接答案，规则里零提及 |
| `list_user_assets` | 🟡 中 —— 资产库入口 |
| `web_search` / `web_fetch` | 🟡 中 —— 联网能力，规则里零提及（且无web skill 兜底） |
| `read_document` | 🟡 中 —— 文档读取 |
| `get_generation_diagnostic` | 🟢 低 —— 诊断用，出错时用 |

**`run_text_generation` / `run_prompt_generation` 曾被列在这一档，是我判错了** ——
`gen_tool_policy` 规则 11 写的是「run_image/video/text/prompt/audio_generation」，
**逐字点名全部 5 个**（它给的是「何时可调」的约定而非「叫什么」，同样有效）。
已移到 A 类，教训见第五节。

## ⭐ 三个可执行的结论

### 1. `tool_search` 必须写进规则集（最高优先级）

它是**渐进披露机制的唯一入口**，却零提及 ⇒ 机制形同虚设。
这与生产观测一致：`tool_search_activated_total = 0`（至今从未激活）。

**但先别改索引块** —— 需要先在规则里给出「何时该搜」的触发条件，
否则模型仍不会搜（规则里没有这个概念）。

### 2. 补一条「画布日常操作」规则，覆盖 B 类的场景缺口

A 类覆盖了「写/生成」，但**「整理/排版/查看/定位/任务列表/资产库」这类日常读操作
在规则集里完全没有覆盖**。这正是 `tool-discovery-001` 的根因：

- 话术：「把这 30 个节点按左右关系重新排一下」
- 规则集：grep「排版/排列/整理」**零命中**
- `arrange_nodes` 的说明只在 `drama-storyboard` 等 5 个 skill 里 ⇒ **不会被加载**
- ⇒ 模型只读了摘要和布局，不知道该调 `arrange_nodes`

### 3. ~~`run_text_generation` / `run_prompt_generation` 需点名~~ 已核实无需补

`gen_tool_policy` 规则 11 逐字点名全部 5 个 `run_*` ⇒ **这一项不成立**。
（我最初按「字面没出现工具全名」判定，漏了规则可以**枚举式**覆盖。）

## 四、⏰ 修正记录（我自己的错）

**我第一轮只 grep 了 `prompt-registry/rules/`，就断言「`arrange_nodes` 无任何资产点名」
⇒ 规则缺失」。** 实际 `skills/` 里有 **5 处**点名（drama-* + ecommerce-product-photo）。

⚠️ 错误性质：**把「规则集没覆盖」误判成「全仓没覆盖」**，会导致：
- 补规则时在 `rules/` 里重复写skills 已有的内容
- 误判「工具完全不可达」（实际只在特定 skill 内可达）

⇒ **纪律：判「某工具有没有资产」必须同时查 `rules/` 和 `skills/`。**
`tiering.ts` 的注释本来就是这么写的（"prompt 规则 / skills"），是我读漏了。

## 附：相关文件

- 判据准绳：`services/pi-runtime/src/tools/tiering.ts`（`ALWAYS_ON_TOOL_NAMES` 上方注释）
- 规则集：`prompt-registry/rules/*.md`（9 条，`MANIFEST.yaml` 有 hash）
- skills：`skills/*/SKILL.md`
- L1 case：`services/pi-runtime/src/eval/golden-cases.ts`
- 运行手册：`docs/EVAL_HARNESS_RUNBOOK.md`

## 五、⏰ 我在本次排查里犯的两个错

### 错误 1：只查 `rules/` 就断言「全仓无点名」

第一轮判定 `arrange_nodes`「无任何资产点名」时**只 grep 了 `prompt-registry/rules/`**，
实际 `skills/` 里有 **5 处**（drama-character-design / drama-scene-worldview /
drama-script-writing / drama-storyboard / ecommerce-product-photo）。

⚠️ 错误性质：**把「规则集没覆盖」误判成「全仓没覆盖」**，会导致：
- 补规则时在 `rules/` 里重复写 skills 已有的内容
- 误判「工具完全不可达」（实际只在特定 skill 内可达）

`tiering.ts` 的注释本来就写着「prompt 规则 / skills」，是我读漏了。

⇒ **纪律：判「某工具有没有资产」必须同时查 `rules/` 和 `skills/`。**

### 错误 2：按「字面出现工具全名」判定，漏掉枚举式覆盖

`gen_tool_policy` 规则 11 写的是「run_image/video/text/prompt/audio_generation」——
**用斜杠枚举**，五个工具名都出现了，但我按「`run_text_generation` 这个完整字符串
是否出现」来判 ⇒ 误判为 C 类。

⇒ **纪律：判定要按语义（规则是否覆盖了这个工具），不是按字符串精确匹配。**
规则可以用枚举、前缀、描述性表述来覆盖一批工具。

### 共同根因

两次都是**用「我查了某处」代替「我查全了」**。
⇒ 对「覆盖类」的问题，判据必须是**穷举式的**（列出全部对象 × 全部资产来源），
而不是抽查式的。这与L1 排查那五轮误判是同一个模式。
