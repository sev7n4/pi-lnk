# BYOK 进 pi-runtime（per-session 模型/密钥注入契约）— 设计规格

## §0 图形声明

本文档无任何示意图（无 SVG/Mermaid/图片），为纯文字设计文档。

> 状态：v1.1（2026-09-26 经 PM/Codex/LLM 研究三视角评审修订：能力三层解析、reasoning/contextWindow 可配、PI_LLM_PASSTHROUGH 回滚、Nest 侧泄露红线、传输边界、验收 2/6 重写）。
> 代号：**K-1**（刻意避开 P0/P1/P2——后者是回合呈现层分期名）。
> 关联：`docs/superpowers/plans/2026-09-25-execution-trace-observability.md` 后继章节「另立项」；`docs/superpowers/specs/2026-09-16-agent-sidebar-vision-provider-context-design.md`（D-SYNC 同源原则）；侧栏识图立项（后继项）依赖本 spec 的密钥通道先落。

## 1. 背景与问题（断链现状，逐跳查实 2026-09-26）

前端 dock 已发 `model`（如 BYOK `ch_xxx::deepseek-v4-flash`）、`thinking`、`thinkingEffort`；老 LangGraph 路径完整消费（`buildTextProviderContext` → `streamRun` 的 llmApiKey/llmBaseUrl/llmModel）。pi active 路径（生产主路径）：

1. `chatConversation` 收到 model 后**未传入** pi 分支——`streamFromPiRuntime` 签名只有 `(piClient, sessionId, userMessage, userId, threadId, piContext)`；
2. pi-runtime 模型装配是 **env 驱动的进程级单例**（`model-assembly.ts: assembleModel()`：AGNES_API_KEY + AGNES_BASE_URL + agnes-2.5-flash），会话创建（`SessionManager.create` → harnessFactory）时装配，与用户无关；
3. 结论：BYOK 用户在 pi 路径实际用的是**平台 key + 固定模型**——计费口径错误（用户渠道配额没被消耗）、模型选择无效、以及 thinkingEffort 逐请求档位失效（该部分已由 P1 Task 1 以 thinkingLevel 透传解决，本 spec 不重复）。

## 2. 目标 / 非目标

**目标**

- G1：pi 路径对话使用与老链路同一模型解析结果（`resolveForGeneration(userId, modelRef, 'text')`，BYOK→BYOK 渠道、平台→平台，D-SYNC 同源）。
- G2：BYOK apiKey/baseUrl 以 **per-session** 作用域注入 pi-runtime，多用户并发会话互相隔离。
- G3：密钥零泄露：不落盘、不进日志/指标/SSE 事件/JSONL 会话文件/错误信息。
- G4：平台用户（无 BYOK）上游请求行为与现状完全一致（同 key 同 baseUrl 同模型；走 source=platform 的 override 装配，与 env 装配同源等价）。

**非目标**

- 生成类工具（run_*）的图片/视频模型解析——走 Nest 内部 API（`/agent/internal/*`），渠道解析已在 Nest 侧，不经 pi-runtime 装配，本 spec 不动。
- 多轮会话中途换模型：v1 每轮 createSessionReplacingStale 重建会话即生效（与 thinkingLevel 同机制），不做会话内热切换。
- 侧栏识图 vision 通道（后继项，另立 spec，复用本契约）。
- 模型能力协商（上下文窗/是否支持 reasoning 的校验）——v1 信任 preferences 的 selectableTextModels 白名单。

## 3. 契约设计

### 3.1 Nest 侧（发起方）

- `chatConversation` 的 pi 分支：model 已在入参（前端必发）。复用现有 `buildTextProviderContext(this.providerResolver, userId, requested)` 得到 `ProviderContext { providerRef, model, apiKey, baseUrl, source }`——**解析失败时保持现网行为**：不 resolve（ctx=undefined）→ 不发 llm 字段 → pi-runtime 走 env 兜底（对齐老路径 ctx 缺省语义，不引入 fallback_pending）。
- **平台用户（model=platform::*）同样发 llm**（source=platform）：resolve 结果与 env 装配同源（平台 key + agnes 网关），走 override 装配行为等价；env 兜底只覆盖「resolve 失败」与「旧 Nest 不发 llm」两类场景。
- **回滚开关**：env `PI_LLM_PASSTHROUGH`（默认 `on`）——置 `off` 时 Nest 停发 llm 字段，一键回落 env 装配，秒级止血（对齐 PI_RUNTIME_MODE 运维习惯）。
- `streamFromPiRuntime` 签名增第 7 参 `llm?: ProviderContext`（与 P1 Task 1 的 thinkingOpts、Task 2 的 skillId 汇总为一个 opts 对象传递，避免签名膨胀——实现时定形）。
- `ensurePiSession` → `createSessionReplacingStale` body 增：

```json
{ "llm": { "model": "deepseek-v4-flash", "apiKey": "<明文，仅内存>", "baseUrl": "https://…", "providerRef": "ch_xxx::deepseek-v4-flash", "source": "user", "reasoning": true, "contextWindow": 128000, "maxTokens": 8192 } }
```

（reasoning/contextWindow/maxTokens 由 §3.2 三层能力解析在 Nest 侧填入。）

### 3.2 pi-runtime 侧（装配方）

- create 路由 body 增 `llm?: { model: string; apiKey: string; baseUrl: string; providerRef: string; source: 'user' | 'platform'; reasoning?: boolean; contextWindow?: number; maxTokens?: number }`，白名单校验（model/apiKey/baseUrl/providerRef/source 五字段均非空且类型正确才接受，否则 400——畸形 llm 拒绝而非静默兜底，防止「以为用了 BYOK 实际走平台」的静默错账；reasoning/contextWindow/maxTokens 可选）。
- **模型能力三层解析（2026-09-26 评审拍板，Nest 侧落 `resolveModelCapability(providerRef)`）**：
  1. **渠道模型元数据扩展字段**（若渠道 models 条目将来扩出 reasoning/contextWindow 等字段，最高优先——现状 `pullModels` 只存 `{ name, capability(模态) }`，此层为前向扩展位）；
  2. **内置静态能力表**：按模型名匹配常见系（deepseek/gpt/claude/gemini/qwen…的 reasoning 布尔与上下文窗），随版本热更；
  3. **保守默认**：`reasoning: false`、`contextWindow: 128_000`、`maxTokens: 8_192`。
  不可行项说明：OpenAI 兼容网关 `/models` 普遍不回 reasoning/contextWindow 元数据，故「纯动态」不可靠，三层结构保证将来接上游探测时零契约变更。
- `SessionManager.create` opts 增 `llm?: SessionLlmOverride`，传给 `modelFactory`：

```ts
// model-assembly.ts 增量
export function assembleModel(override?: SessionLlmOverride): AssembledModel {
	if (!override) return assembleModelFromEnv();          // 现有逻辑原样抽取
	return assembleModelFromOverride(override);            // createProvider 同构，baseUrl/key/model 换 override
}
```

- `assembleModelFromOverride`：`createProvider` 结构与 `agnesProvider()` 完全同构（openai-completions api、cost 0），差异仅 `id`（取 providerRef 哈希前 12 位避免 Map 键冲突）、`baseUrl`、auth resolve 返回 `override.apiKey`、models[0] 的 `id = override.model`、**`reasoning = override.reasoning ?? false`、`contextWindow = override.contextWindow ?? 128_000`、`maxTokens = override.maxTokens ?? 8_192`**。reasoning 写死 true 是禁止项：非 reasoning 模型 + P1 的 thinkingLevel 透传会让 pi-ai 发 `reasoning_effort` 参数 → 网关 400；contextWindow 写死 1M 是禁止项：harness 压缩/截断永不触发 → 长对话超上游限制且报错难懂。
- **安全模型对齐 toolContext 惯例**：llm 仅来自 Nest create 注入，`SessionManager` 不从任何其他来源读取；override 对象生命周期 = 会话 entry，DELETE 会话即释放引用。
- **传输边界声明**：apiKey 明文走 Nest→pi-runtime，仅限同机 loopback / 内网 docker-k3s 网络（无 TLS）。跨节点部署前必须先加通道加密（mTLS/内网 TLS），此为部署前置条件而非本 spec 范围。
- 红线（实现时逐条自证并写进代码注释）：
  1. `assembleModelFromOverride` 内禁止 `console/logger` 打印 override 任何字段（含 model id 可打，key/baseUrl 不可）；
  2. `metrics.ts` 不得增带 label 的 key/baseUrl 维度（providerId 可作 label，用哈希）；
  3. create body 是 HTTP 请求体，fastify 默认不持久化——确认无 access-log 打印 body（runbook 部署后 `docker logs` 抽查一次）；
  4. JSONL 会话文件只落 harness transcript，create body 不入 repo（现状已成立，实现时以「写入后 grep 会话文件无 apiKey」用例钉死）；
  5. **Nest 侧错误信息不得内联请求体**：`pi-runtime.client` 的异常消息只含 status + sessionId——fetch/axios 失败时若把 body 拼进 Error message，apiKey 会进 Nest 日志堆栈，实现时自证。

### 3.3 与 P1 的边界

- thinkingLevel 逐请求透传 = P1 Task 1（已立项，独立可交付，不依赖本 spec）。
- 本 spec 交付后，dock 的 model 选择在 pi 路径生效；thinkingEffort 档位映射维持 P1 Task 1 的 D-T1（high→medium、max→high），若 BYOK 模型支持更高档位，后续在 model-assembly 层按模型能力放开，不改契约。

## 4. 失败路径

| 场景 | 行为 | 理由 |
|---|---|---|
| Nest resolve 失败（渠道停用/无 key） | 不发 llm 字段 → env 兜底照常回包 | 对齐老路径 ctx 缺省语义；UI 层已有「当前规划模型已停用」拦截（AgentSideRail sendMessage 前置校验），此处是纵深防御 |
| pi-runtime 收到畸形 llm（五必填字段缺失/类型错） | 400，Nest 侧 healthz 已过、prompt 未发，SSE 走 error 事件 | 宁可失败不可静默走平台 key（错账） |
| BYOK 上游网关 401/429 | harness error 事件 → Nest 透传 → 前端失败态人话（P1 Task 4 failureReason） | 不做 fallback_pending（对齐 2026-09-16 spec D-NO-PLATFORM-SWITCH 的精神：不静默切平台） |
| 需紧急回滚（渠道网关对透传参数不兼容等） | env `PI_LLM_PASSTHROUGH=off` + 重启 → 全量回落 env 装配 | 一键止血，不改代码不发版 |

## 5. 验收标准

1. BYOK 用户 dock 选 `ch_*::deepseek-v4-flash` 发消息 → pi-runtime 收到 llm.source=user 的 create → 上游请求打到该渠道 baseUrl（证据取渠道侧控制台请求日志，或 pi-runtime 临时 debug 行打 baseUrl host——**不得含 key**）；回复正常流式。
2. 平台用户（model=platform::*）→ create body 带 source=platform 的 llm → 上游请求与改造前**逐字节一致**（同 key 同 baseUrl 同模型）。
3. 并发隔离：两个不同 BYOK 用户同时各开会话，各自会话的上游 baseUrl 不同。
4. 泄露扫描：`docker logs`（api + pi-runtime）、SSE 事件流、`/opt/.../.pi-runtime-data/**/sessions/*.jsonl`、Nest 错误日志堆栈中 grep 不到 BYOK 明文 key。
5. 老 Nest × 新 pi-runtime（部署窗口）：旧 Nest 不发 llm → 新 pi-runtime 走 env 兜底，零回归；新 Nest × 旧 pi-runtime（反向窗口）：旧 pi-runtime 忽略未知 body 字段（fastify 默认不校验额外键，实测确认）→ 零回归。
6. 能力解析实证：BYOK 开深度思考 + max 档发一轮——reasoning 模型（静态表命中）正常出思考流；非 reasoning 模型（如静态表判 false）不 400、无思考流正常回包；contextWindow 按 override 生效（超长对话触发 harness 压缩而非上游报错）。

## 6. 工作量与拆期

- Nest 侧（resolve + 能力解析 + 透传 + 回滚开关 + 测试）：~1 天；pi-runtime 侧（override 装配 + 白名单 + 泄露用例）：~1 天；端到端验收（含双窗口兼容与能力实证）：~0.5 天。任务拆分随实现计划另出（本 spec 定稿后立 plan）。
- 依赖顺序：P1 Task 1（thinkingLevel）先合入可独立发版；本 spec 实现计划基于同一 create body 通道扩展 llm 字段，无耦合冲突。

## 7. 遗留观察项（不阻塞交付）

- 超时/重试：v1 沿用 harness 默认，验收时记录 BYOK 网关实测首 token 延迟；若用户侧长转圈成普遍反馈，再参数化超时透传。
- 用户感知：BYOK 生效时状态行/头部无「当前用我的渠道」提示，P2 可在状态行尾缀显示渠道名（依赖 P1 Task 4 状态行组件）。
- 配额行为：同渠道多 key 共享限额池不叠加（生产已知），BYOK 用户自己渠道的并发配额表现验收时观察一次即可，不做代码处理。
- 计费口径：override 的 cost 恒 0，turn_usage 仅 tokens；BYOK 用户的真实成本核算属计费系统范畴，本 spec 不覆盖。
