# 侧栏识图进 pi-runtime（老 `parse_sidebar_media` 的 Nest 侧等价物）— 设计规格

## §0 图形声明

本文档无任何示意图（无 SVG/Mermaid/图片），为纯文字设计文档。

> 状态：v1.0（2026-09-27）
> 代号：**K-2**（继 K-1「BYOK 进 pi-runtime」之后的第二项老 runtime 退役前置）
> 关联：`docs/superpowers/specs/2026-09-26-byok-into-pi-runtime-design.md`（K-1，本文复用其 `buildTextProviderContext` 渠道解析结果）；`docs/superpowers/specs/2026-09-16-agent-sidebar-vision-provider-context-design.md`（D-SYNC 同源原则）。

## 1. 背景与问题

老 LangGraph runtime 有一条**图节点** `parse_sidebar_media`：用户往侧栏贴图后，runtime 在进主模型之前先调 Nest 的 vision QA，把图片解析成结构化字段，再作为**文本上下文**塞进 system prompt。pi-runtime 路径完全没有这一步——pi 的 systemPrompt 里侧栏只有一行 `I1=1.png`（文件名）。

后果（生产可观察）：pi 模式下模型会说「我只看到文件名」「请把图片发给我」，而同样的输入在老 runtime 下能说出「一双白色运动鞋，侧拍」。这是老 runtime 退役前必须补齐的能力差，否则切到 pi 即为回归。

**关键语义澄清**：侧栏识图**不是**让对话模型直接看多模态图片。它是「图 → Nest vision QA → 结构化字段（品类/外观/材质/图中文字 + 白底清晰度 QA）→ 文本块」。本文按同语义平移，不做「把图片塞进 pi 的多模态请求」。

## 2. 目标 / 非目标

**目标**

- G1：pi active 路径下，侧栏贴图回合的 systemPrompt 含【侧栏参考图解析】块，语义与老链路逐条对齐。
- G2：识图未成功时也要给模型一个交代（见 §3 决策 B），避免模型拿文件名编一版空品类的上架方案。
- G3：跨轮不重复烧 vision（见 §3 决策 C）。
- G4：可一键关闭（见 §4）。

**非目标**

- 把图片传给对话模型做多模态理解（与老链路语义不符，且 pi 侧模型为 agnes-2.5-flash，通道未验证）。
- 老 runtime 的失败错误分类（9 类 `VISION_*` 文案）——pi 侧统一收敛为一句兜底话术，不做 9 类映射（UI 无对应展示面）。
- 生成类工具（`run_*`）的参考图处理——走 Nest `/agent/internal/*`，不经 pi。

## 3. 决策（三条，均为与老链路对齐而做的取舍）

### 决策 A：在 Nest 侧做前置，不在 pi-runtime 内做

老链路是 runtime 调 Nest（`/agent/internal/run-vision-qa`）。pi-runtime 没有 Nest 的渠道/密钥解析能力（那套在 `providerResolver` + `userAiPreferences` 里），且 pi pod 的 netpol egress 只放行 53/443 + `172.20.0.0/16:3001`，去外部渠道会被拦。

因此：**Nest 在 `streamFromPiRuntime` 内先解析 → 把结果文本并入 `systemPrompt` → 随 `createSession` 交给 pi**。pi-runtime 零改动（本次不重新发 pi 镜像）。

### 决策 B：识图未成功时**仍然出块**，不是返回空

老 `explore.py`：

```python
if parse:  # parse 非 None 即「尝试过」
    system_content += "\n\n" + format_parse_context_block(parse, ask_unknown=...)
    if not parse.get("vision_used"):
        system_content += "\n" + _PARSE_FAIL_NO_EMPTY_LISTING
```

即：只要**尝试过**解析就出块，失败时块内 `摘要=未知`、`品类=未知，勿编造`，再追加一段「参考图未能识别，禁止写出空品类、空规格的上架方案框架」。

这是**防幻觉**设计——模型手里若只剩文件名，会照着文件名编一版方案。所以本文不是「失败返回空」，而是：

| 情形 | 返回 | 对应老链路 |
| --- | --- | --- |
| 无贴图 / 开关 off / 无 canvasTools | `''` | `parse=None` |
| 有贴图但拿不到渠道 | 失败块 | `VISION_PROVIDER_CONTEXT_INVALID` |
| 有贴图但模型不支持视觉 | 失败块（**不调** vision） | `VISION_UNSUPPORTED` |
| 调了但 `vision_used=false` / 抛错 | 失败块 | `VISION_UPSTREAM` 等 |

失败块**不缓存**（上游抖动下一轮应重试）。

### 决策 C：跨轮缓存用「进程内键 + TTL」近似 thread state

老 runtime 把解析结果按 `(url, provider_ref)` 存在 LangGraph thread state 里，同线程追问不重调 vision。Nest 侧没有 thread state，也不值得为此落库。

近似方案：模块级 Map，键 = `providerRef || 本轮图片 URL 集合`，值 = 渲染好的文本块，TTL 30min，容量 256（FIFO 淘汰）。

- 集合变了就重解析（老链路只有**新增**的 url 才重调；本方案整集合重调——多花一次，但免去合并多 url 记录的逻辑，且「加一张图」是低频动作）。
- 只缓存**成功**结果。
- 缓存内容由图片本身决定，与会话/用户无关，跨会话共享安全。

## 4. 回滚

`PI_SIDEBAR_VISION=off` → `buildSidebarVisionBlock` 直接返回 `''`（与 K-1 的 `PI_LLM_PASSTHROUGH` 同款运维习惯）。改 `/opt/lnkpi/.env` 后 `docker compose up -d --no-build --force-recreate api` 生效，秒级。

注意：此开关只在**解析前置**处生效，不影响 pi-runtime 本身，无需重启 pi。

## 5. 逐条来源（平移，非重写）

| 本文实现 | 老 runtime 来源 |
| --- | --- |
| `imageUrlsForParse`（去重保序，上限 4） | `app/graph/sidebar_media_parse.py: image_urls_for_parse` + `MAX_PARSE_IMAGE_URLS=4` |
| `supportsVisionModel`（三条正则） | `app/graph/product_visual_v2/vision_qa_client.py: supports_vision_model` |
| `parseBlockAsksUnknown` | 同文件 `parse_block_asks_unknown`（标记：上架/投放/营销方案/全链路/详情页） |
| `formatParseContextBlock` | 同文件 `format_parse_context_block` |
| `SIDEBAR_VISION_FAIL_HINT` | `app/graph/nodes/explore.py: _PARSE_FAIL_NO_EMPTY_LISTING`（去掉原「4.」序号——pi 侧规则编号不复用） |
| `SIDEBAR_MEDIA_PARSE_PROMPT` | `services/agent-runtime/skills/_shared/sidebar-media-parse/1.0.0.md`（已校验逐字一致） |
| `userContent` 拼接 | `parse_sidebar_media._build_user_content` |

提示词固化的原因：API 镜像构建上下文只含 `packages` + `apps/server` + `deploy/docker`（见 `deploy/docker/Dockerfile.api`），**不含 `services/`**，运行时读不到该 md。**两边改任一处都要同步**。

## 6. 验证

**单测**（`apps/server`）

- `sidebar-vision.test.ts`（13 条）：正则逐条对齐老 pytest、上限 4、缓存命中/换集合/换 provider/TTL 过期。
- `agent.service.pi-runtime.test.ts` 的「③ 侧栏识图进 pi」块（5 条）：贴图+视觉模型→调 vision 且块入 systemPrompt；非视觉模型→不调但仍出失败块；抛错→失败块；无贴图/开关 off→无块；跨轮复用→第二轮不调 vision。

**生产实证**（待部署后）

1. 侧栏贴一张真实图片，发一轮「这图是什么」。
2. 预期：pi 会话 systemPrompt 出现「【侧栏参考图解析】\n摘要：<非『未知』>」；回答不再出现「只看到文件名」。
3. 再发一轮（同图）→ pi 日志/Nest 日志显示本轮未再调 vision（缓存命中）。
4. 切到非视觉模型（如 deepseek-v4-pro）→ 出现「摘要：未知」+「参考图未能识别」，且不调 vision。
