# L1 行为回归：运行手册与排查方法

> 记录 2026-10-04 从「L1 完全跑不起来」到「拿到可信 baseline」的全过程，
> 重点是**方法**（下次排查同类问题可直接照做）与**踩过的坑**。
>
> 相关：`services/pi-runtime/src/eval/`（harness 本体）、
> `.workbuddy/memory/2026-10-04-l1-baseline.json`（最近一次 baseline 原始数据）。

---

## 1. 这套 L1 是干什么的

**一句话**：把 11 条真实失败 case 逐条真的发给模型跑一遍，比对行为与判据，
产出**可 diff 的通过率 + 失败明细**。

它的价值不是「自动判对错」，而是**给「改提示词」装上回滚依据**：
改前跑一次拿 baseline，改后再跑一次做对比。没有它，改提示词就是赌博。

### 判据分层

| 状态 | 含义 | 处置 |
|---|---|---|
| `pass` | 行为符合预期 | 无 |
| `fail` | 行为不符（**真问题**） | 改提示词 / 修工具 |
| `error` | 环境问题（限流/凭据/网络） | 重跑或修环境，**别改提示词** |
| `skipped` | 本harness 跑不了（需外部动作） | 补环境后单跑，**不计入通过率** |

⚠️ **`error` / `fail` 分离是这套 harness 的核心价值**。一旦被吞掉就反向失效 ——
「环境问题」会被呈现为「行为退化」，把人引向错误方向（最贵的错）。

---

## 2. ⭐⭐⭐ 排查「跑不出结果」的第一纪律

> **五轮排查里四轮真凶都在 harness，而每轮我先怀疑环境与提示词。**
> 这条纪律是本文档最值钱的部分。

### 2.1 必须打印**原始帧**，不能只看自己埋的指标

指标全 0、计数不变，既可能是「**没发生**」，也可能是「**发生了但没被消费**」——
**自己埋的指标无法区分这两者**。

实例：`tool_calls_total` 计数不变 ⇒ 我判「模型压根没调工具」**（错的）**；
实际模型调了、答对了，只是 driver 收不到 `agent_end`。

**有效做法**：打印原始 SSE 帧。2026-10-04 一次就暴露了 `agent_end.error` 里的
`429 您已达到免费用户的 API 速率限制` 原文 —— 而指标侧什么都看不到。

现成脚本见 `~/.workbuddy/skills/prod-deploy-verify/scripts/diag-sse-frames.cjs`
（含「输出解读」对照表）。

### 2.2 harness 三个最常见缺陷（按出现频率）

| 缺陷 | 症状 | 判据 / 修法 |
|---|---|---|
| **收手条件错** | `agent_end` 到了但没被消费 ⇒ 每条都打满 `timeoutMs` | `/events` 是**长连接**，`agent_end` 后服务端**不关闭** ⇒ 必须「**收到即完成**」 |
| **折叠丢信息** | `assistantText` 恒空或阶梯重复 ⇒ 文本判据全假绿 | 核对原始载荷字段位置；注意 `content[]` 混 `thinking` 块；流式是**累积快照**不是增量 |
| **错误被吞** | 429/5xx 被判成 `fail` ⇒ 引导去改提示词，实际是额度 | `status!=="completed"` 时必须把 `data.error` 收进 `errors`（保留原文） |
| **订阅未就绪就发 prompt** | 模型**确实调了**工具，客户端却**零工具事件** ⇒ 工具类判据全假阴性 | 见 §2.4：必须「**订阅就绪（响应头到达）**」后再 prompt，且等要有界 |

### 2.3 单测抓不到这类缺陷 ⇒ 造数据必须用**生产实测形态**

- **长连接** ⇒ 假 server **不能** `res.end()`，必须发完 `agent_end` 后**保持连接**
- **流式累积** ⇒ 不能造「每次发增量片段」，必须造「每次发当前全文」
- **错误载荷** ⇒ 直接抄生产原文（含 429 的 `request id`）

**每次修复都要做红→绿验证**：回退修复 ⇒ 目标测试必须变红。不变红 = 测试没抓住 bug。

### 2.4 ⭐⭐⭐ 「先订阅」不够，必须「**订阅就绪**」再发 prompt（2026-10-06）

**症状**：同构客户端 + 容器内真模型，12 轮里 **3 轮**出现「模型确实调了 `tool_search`，
客户端一个 `tool_execution_start` 都没收到」。
**反证**：pod 内该 session 的 jsonl 里这次调用的 `toolResult` **确实存在**
⇒ 不是「模型没调」，是「**客户端没收到**」。

**根因**：`from=now` 的水位线在**服务端登记订阅者**那一刻生效。
`void streamEvents(...)` 只保证 GET 请求**已发出**，不保证**已登记**。
两者之间的窗口里产生的事件（往往正是**首个工具调用**）会被当成「订阅前的旧事件」而**永不投递**。

**后果定性**：它把「搜了」记成「没搜」⇒ 是个**假阳性发生器**，
正好污染「叙述代替调用」这类行为判据（见 §7 的规则 22 观测）。

**修法（两处，缺一不可）**：

1. `services/pi-runtime/src/eval/driver.ts`
   - 等 `subscribed`（**响应头到达**）**且带超时**再 `postJson(prompt)`；
   - 订阅失败也必须放行 `subscribed`，否则 `await` 永挂；
   - `streamDone` 建好就挂空 `catch`：reject 可能早于 `await streamDone`
     （中间隔着订阅 + prompt 两个 IO 点），而 Node 默认
     `--unhandled-rejections=throw` ⇒ **评测进程直接崩**（单测里表现为随机红）。
2. `services/pi-runtime/src/app.ts` `/events`：`writeHead` 后必须 `reply.raw.flushHeaders()`。
   ⚠️ 实测（真实 socket 探针，非 `inject`）：
   - 不 flush ⇒ 拿到响应头要 **15022ms**（`HEARTBEAT_MS = 15s`，只有心跳才把响应头带上线）
   - flush 后 ⇒ **17ms**
   ⇒ 不修这条，**每轮评测白等一个心跳周期**，且等待时长随心跳抖动。

**红→绿判据**：`driver.test.ts` 的 `startRaceRuntime` 让假 server **延迟登记订阅者**
（登记前 `produce` 的事件记进 `dropped`）。
回退 driver 修复 ⇒ 「订阅未就绪 ⇒ 首个工具调用被吞」必红（实测：5s 打满 ⇒ `dropped` 非空、`toolNames` 为空）。

⚠️ **只断言「`/events` 请求早于 `/prompt` 请求」测不出该缺陷** —— 请求顺序本来就是对的，
晚的是**服务端登记**。这正是旧用例 `订阅必须早于 prompt` 一直绿着、却漏掉真缺陷的原因。

⚠️ 假 server 造数据时，SSE 端点**必须先 flush 响应头**（真实 SSE 都如此）；
`writeHead` 之后不写任何字节就等于「服务端不吐头」，会让新契约下的 driver 空等到超时。

---

## 3. 环境准备（CVM 预生产）

### 3.1 登录取 token

⚠️ **登录的第二个参数是短信验证码，不是密码**（`auth.controller.ts` 的
`login(dto.phone, dto.code)` → `assertValidCode` 查 `verificationCode` 表）。

生产**未配** `SMS_MODE=fixed`（无万能 bypass）⇒ 脚本化登录需先插一条未过期验证码：

```js
await prisma.verificationCode.deleteMany({ where: { phone } });
await prisma.verificationCode.create({ data: { phone, code: "123456", expiresAt: new Date(Date.now() + 3600e3) } });
const { data } = await post("http://127.0.0.1:5100/api/auth/login", { phone, code: "123456" });
```

### 3.2 画布：**「有节点」≠「模型看得到节点」**

⚠️⚠️ 这是花了好几轮才定位的坑。画布有**两类节点**，`get-canvas-summary` 只看一类：

| 建法 | summary 能看到 |
|---|---|
| `POST /api/agent/canvas/:sid/shot/create` 建的 `shot` | ❌ **返回不到** |
| `POST /api/agent/internal/add-nodes-batch` 建的 | ✅ 能看到 |

⇒ **做画布相关评测必须用后者**。入参**必须带 `key` + `targetType`**，否则 400。

### 3.3 内部端点鉴权

```bash
POST http://<nest>:5100/api/agent/internal/<name>       # kebab-case
headers: { "x-lnkpi-service-token": <NEST_SERVICE_TOKEN> }   # ⚠️ 不是 x-internal-token
```

**判别方法**：`401` = 路径对但token 错；`404` = 路径错。**先看 status 再查路径**，别反过来。

### 3.4 把 harness 传进 pod 跑

```bash
# 编译（⚠️ 必须 CJS：容器里 `node cli.js` 无 package.json type=module）
tsc src/eval/*.ts --outDir /tmp/evalrun --module commonjs --target es2022 --moduleResolution node
tsc apps/server/src/agent/pi-runtime/prompt-registry.{loader,fallback}.ts --outDir /tmp/evalrun --module commonjs …
mkdir -p /tmp/evalrun/prompt-registry/rules
cp prompt-registry/MANIFEST.yaml /tmp/evalrun/prompt-registry/
cp prompt-registry/rules/*.md /tmp/evalrun/prompt-registry/rules/

# 打包传入（⚠️ 三个坑见下）
COPYFILE_DISABLE=1 tar --no-xattrs -czf /tmp/eval.tgz -C /tmp/evalrun .
cat /tmp/eval.tgz | ssh <host> 'POD=$(kubectl get pods -n pi-lnk-runtime -o jsonpath="{.items[0].metadata.name}"); \
  kubectl exec -i -n pi-lnk-runtime $POD -- sh -c "mkdir -p /tmp/evalrun && tar xzf - -C /tmp/evalrun"'
```

⚠️ **三个坑**：
1. `COPYFILE_DISABLE=1 tar --no-xattrs` — 否则报 `Ignoring unknown extended header keyword 'LIBARCHIVE.xattr...'`
2. **必须 `cat x.tgz | ssh ...`** — `ssh 'cmd' < file` 的重定向在**远端**被解析
3. `kubectl cp` 会因 pod 重启换名而 `NotFound` ⇒ 改用 `kubectl exec -i` + stdin
4. `kubectl exec -d`（detach）该版本不支持 ⇒ 用容器内 `nohup ... &`

### 3.5 跑

```bash
kubectl exec -n pi-lnk-runtime $POD -- sh -c 'cd /tmp/evalrun && \
  PI_RUNTIME_URL=http://127.0.0.1:8100 \
  PI_EVAL_LOADER_PATH=/tmp/evalrun/prompt-registry.loader.js \
  PI_RUNTIME_REGISTRY_ROOT=/tmp/evalrun/prompt-registry \
  PI_EVAL_USER_ID=<real-user-id> \
  PI_EVAL_CANVAS_SESSION_ID=<real-session-id> \
  nohup node cli.js --timeout 60000 --interval 5000 > /tmp/l1.log 2>&1 &'
```

⚠️ **端口**：pod 内用 `8100`（`PORT=8100`），**NodePort 30100 在 pod 内不可达** ⇒ 用 30100 会 `fetch failed`。
⚠️ **画布参数必传**：缺 `canvasSessionId` 时 `runL1` 直接抛错（不跑一遍拿超时）——
跑完的「本轮未正常结束」看起来像行为不符，而正确处置是传对参数重跑。
⚠️ **`--interval` ≥5000ms**（见 §5）。

---

## 4. 部署

⚠️ **`src/eval/**` 是离线工具、零生产引用 ⇒ 不需要部署到 pi-runtime**。
评测时把 eval 产物传进 pod 跑即可。合并后无需等 runtime-deploy。

判据：`git diff --name-status <线上tag> <最新> -- services/pi-runtime/src/` 全在 `src/eval/` 下
⇒ 运行时行为不变。

---

## 5. ⭐ 限流（免费额度）是主要噪声源

`agnes` 免费额度被打限流时**什么都不会发生**，只返回：

```json
{"type":"agent_end","data":{"type":"run_end","status":"failed",
 "error":{"code":"assistant_error","message":"429: {...您已达到免费用户的 API 速率限制...}"}}}
```

且 pi-runtime 会**指数退避重试 4 次**（4 个空 `message_end`，间隔 ~1s/2s/4s）才放弃
⇒ 表现为「**10 帧、没有 message_update、没有工具调用**」的空流。

**实测 `intervalMs` 与成功率**：

| 间隔 | 结果 |
|---|---|
| 800ms | 频繁 429（每 3 条就撞） |
| 3000ms | 3 成功 / 4 撞 429 |
| **5000ms** | **5 成功 / 2 撞 429** |
| 12000ms | 1 成功 / 0 撞（补跑时额度已恢复） |

⇒ **策略**：全量跑用 `5000ms`；撞到的**用 `--only <失败项>` + 更大间隔**补跑；
`error` 态不计入通过率（`passRate` 分母只含 pass+fail），
`error` 占比过半时报告自报 `degraded` 并提示「先查上游/凭据」。

⚠️ **单条耗时长 ≠ 失败**：实测有条**22.5 秒却通过**（退避重试后成功）。
判据必须看 `agent_end.status`，不能看耗时。

---

## 6. 2026-10-04 复盘：五轮误判

| 轮 | 我的判断 | 实际 | 教训 |
|---|---|---|---|
| 1 | system prompt 太简略 | 确实有问题，但**不是主因** | 先修明显的，但别当结论 |
| 2 | 没有真实画布 | 也是真的，但**不是主因** | 同上 |
| 3 | 模型压根没调工具 | **错**（依据是指标计数不变） | 指标无法区分「没发生」/「没被消费」 |
| 4 | — | **真凶**：SSE 收手条件 | 打印原始帧才看到 |
| 5 | — | **真凶**：折叠丢信息 + 错误被吞 | 同上 |

⇒ **转折点不是任何一次配置修正，而是开始打印原始 SSE 帧。**

已落地的修复（PR #170/#173/#175/#176/#177）：

| PR | 内容 |
|---|---|
| #170 | L1 用真实规则集（方案 A）+ 修 `assistantText` 恒空 |
| #173 | L1 支持真实画布 + 缺参数 fail-fast |
| #175 | driver 见 `agent_end` 立即收手 |
| #176 | `message_end` 权威替换（不再阶梯重复） |
| #177 | `agent_end.error` 落进 `errors`（429 不再判 fail） |

---

## 7. 当前 baseline

见 `.workbuddy/memory/2026-10-04-l1-baseline.json`。摘要：

- 规则集 `registry 1.0.0 hash=0cc4a809d331 chars=3115`（7 条规则生效）
- 画布 `cmutrf2zy000cmy01uoe5af5r`（2 个 prompt 节点 + 1 条 `status=processing` 的 generationRecord）
- **可跑 7 条中 6 条通过**；4 条 skip（需 DockStudio「用户点确认」动作）

### 已知覆盖盲区

方案 A 直调 `loadRegistry` + `renderStatic`，**绕过 Nest 的 `PiPromptAssembler`**：

- ✅ 能测：规则文本本身对模型行为的影响（改 `.md` ⇒ baseline 变化）
- ⛔ **测不到**：动态段拼装 / `STATIC_BUDGET_CHARS` 截断 / 静态段-动态段分工

⇒ 报告里**固定带一行** `⚠️ 覆盖盲区：...`，不写的话会有人拿「方案 A 跑通了」
论证「装配层没问题」—— 而那恰恰是它没测的。补齐要靠方案 B（runner 经 Nest 跑）。

---

## 8. 下一个工作项：`arrange_nodes` 规则缺口

baseline 里唯一剩下的**真实缺陷**：

```
[fail] tool-discovery-001：缺少期望工具 [arrange_nodes]
    实际调用 [get_canvas_summary, get_canvas_layout]
```

话术「把这 30 个节点按左右关系重新排一下」，模型**查了摘要和布局但没排版**。

⭐ **核实结论：这不是模型缺陷，是规则缺失。**
`prompt-registry/rules/` 里grep「排版/排列/整理」**零命中** ——
规则从没告诉它「整理画布 ⇒ 调 `arrange_nodes`」（该工具 `tier: "ui_command"`）。
模型只读不写，是规则的必然结果。

⇒ W4 规则重写应补上该触发约定。
⚠️ **但先不动 case 判据** —— 需先确认「该 case 期望是否过强」
（模型"先问清楚再排"也可能是合理行为），规则缺失才是已证实的硬事实。

**排查方法可复用**：任何 case 判为 fail 时，先
```bash
git grep -in "<触发词>" -- prompt-registry/rules/
```
零命中 ⇒ **规则缺口**（不是模型问题）；有命中 ⇒ 才是模型/工具的问题。
