# C-1a 种子集真模型跑批报告（2026-11-13）

> 状态：**接线验证完成 ✅ · 行为跑批受阻于上游限流（environmental degraded）· 未产出行为通过率**
> 纪律依据：eval runner 三红线之一「error 与 fail 严格分离」——本报告**不产出任何模型行为结论**，避免把环境问题读成模型退化。

## 1. 跑批执行摘要

| 项 | 结果 |
|---|---|
| 被测对象 | 生产部署形态 pi-runtime（K3s `pi-lnk-runtime` ns，NodePort 30100，`/readyz` ready） |
| 模型 | pod env 装配 `AGNES_MODEL_ID=agnes-2.5-flash` + 自有 key（`/sessions` 响应实证 `provider: agnes, model: agnes-2.5-flash`） |
| 画布上下文 | `cmwdi27i1000cn101q794ilc7`（layout-smoke 3 节点，满足 `c1a-decomp-n3.requiresCanvasNodes=3`） |
| 用户归属 | eval 先例用户（画布工具归属校验通过） |
| prompt 装配 | 方案 A：`loadStaticPromptForEval` + `PLAN_CONVENTION_TAIL`（3281 chars，degraded=false，9 条规则全应用） |
| L0 契约测试 | 27/27 绿（合并前 CI 验证） |
| 行为跑批 | **c1a-decomp-01：7/7 attempt 全 429；c1a-decomp-n2 冒烟：4/4 全 429** ⇒ 主动停批 |

## 2. 阻断事实（生产取证）

上游 agnes-ai.cn 对自有 key 返回：

```
429: {"code":"","message":"请登录platform进行实名认证以获取更高rpm","type":"AgnesAI_error"}
```

- 30s/45s 拉大间隔 + 6~7 次 error 补跑均未越过 ⇒ **持续限流墙，非瞬时抖动**；
- error 分类器工作正常（429 → `error` 不投票、补跑如实计数 `errorAttempts`），红线机制经实战验证；
- 已知生态对照：工作记忆锚「platform::agnes-2.0-flash apihub 免费额度长期 429」——agnes 平台限流是既有现实，pi-runtime 自有 key 亦受实名墙约束。

## 3. 接线验证清单（本轮实际产出）

全链路各环节独立验证通过，重跑时可直接复用：

1. **会话创建**：`POST /sessions`（sessionId + 真实 userId + canvasSessionId）→ 201，响应含 provider/model；
2. **prompt 提交**：`POST /sessions/:id/prompt` body `{text, lane:"main"}` → 202（⚠️ 字段是 `text` 不是 `prompt`）；
3. **SSE 事件流**：`GET /sessions/:id/events?from=now` → agent_start/turn_start/message_update/turn_end/agent_end 全序列收到；
4. **真模型回合**：直调 driver 拿到真实回复（「你好！我是 lnkpi 无限画布助手…」）——driver/折叠/判据链路端到端工作；
5. **registry 装配**：`PI_EVAL_LOADER_PATH` 指向 `apps/server/src/agent/pi-runtime/prompt-registry.loader.ts`（本地 TS loader 形态）→ 静态段 3281 chars / 9 规则应用；
6. **画布规模预检**：Nest `/agent/internal/get-canvas-summary` 通道就绪（service token 经 pod env 静默注入）。

### 重跑接线（环境解锁后照抄）

```bash
# 终端 1：SSH 双隧道
ssh -f -N -L 30100:127.0.0.1:30100 -L 5100:127.0.0.1:5100 deploy-cvm

# 终端 2：master 快照工作区（含 PR #861 eval 资产）
export PATH=$HOME/.nvm/versions/node/v24.13.0/bin:/usr/bin:/bin
export PI_RUNTIME_URL=http://127.0.0.1:30100
export PI_EVAL_USER_ID=cmrn3ghmt000hpi01fdl0gkjp
export PI_EVAL_CANVAS_SESSION_ID=cmwdi27i1000cn101q794ilc7
export PI_EVAL_NEST_BASE_URL=http://127.0.0.1:5100/api
export PI_EVAL_NEST_TOKEN=<pi-runtime pod env NEST_SERVICE_TOKEN>
export PI_EVAL_LOADER_PATH=<repo>/apps/server/src/agent/pi-runtime/prompt-registry.loader.ts

# ⚠️ CLI --timeout 单位是 ms（120 = 120ms，会自缚超时产生「本轮未正常结束」假 fail）
node --import tsx src/eval/cli.ts --only c1a-decomp-01,c1a-decomp-02,c1a-decomp-03,c1a-decomp-04,c1a-decomp-05,c1a-decomp-06,c1a-decomp-n1,c1a-decomp-n2,c1a-decomp-n3 --timeout 150000 --json > c1a-run.json
```

## 4. 行动项（解锁跑批的三选一）

1. **agnes 平台实名认证**（根因直解，429 文案明示）——需账号侧动作；
2. **更换/新增上游渠道**（ProviderChannel 路由或 pi-runtime env 换 key）——部署变更，走 runbook；
3. **换时段重试**（限流可能随平台负载波动）——零成本，先试；若仍持续墙再走 1/2。

跑批产出后：失败归因三分类（prompt 缺陷 / 判据缺陷 / 模型抖动）→ 阈值校准回填种子集（C-1a 收尾闭环）。

## 5. 本轮工程发现（复用价值）

| 发现 | 处置 |
|---|---|
| CLI `--timeout` 单位是 ms | 已在本报告固化正确用法；「本轮未正常结束」快速假 fail 的首要排查项 |
| cli.ts 未暴露 `errorRetries` | 磨限流需自写 batch 脚本（单条 runL1 + errorRetries=6 + interval 45s）；可作为后续小刀给 CLI 补参数 |
| driver 无 model 通道 | pi-runtime 缺省即 agnes-2.5-flash 自有 key，无需传 model；`llm` override 五必填（含 apiKey）仅 BYOK 场景 |
| 429 error 不投票机制 | runner 红线实战验证有效：环境阻断下不会产出误导性通过率 |
