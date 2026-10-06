# 真模型 A/B 评测运行手册

> 场景集：`services/pi-runtime/src/evals/prompt-ab-scenarios.ts`
> 设计依据：`docs/superpowers/specs/2026-10-04-prompt-engineering-design.md` §8.2（阈值 §13.1、token §13.2）

## 这是什么 / 不是什么

**是**：发版前人工跑一遍的场景清单 + 记录格式。场景集是**纯数据**（TypeScript 常量数组）。

**不是**：自动化测试框架。**没有 runner，没有 vitest 用例，不进 CI。**
本仓从未完整安装依赖，worktree 无 `node_modules`，`vitest` 不可用——这是刻意的，不是待办。

## 什么时候跑

- **发版前**人工跑一次，把结果归档到本文件末尾的表格
- **不在 CI 里跑**（慢 + 烧 token + flaky，会训练团队忽略红灯）

## 跑之前：两条硬性前置

### 前置 1：装依赖

```bash
# 在**被测分支的 worktree 内**执行（不是主仓——主仓那份代码不是你在测的分支）。
# 路径按你的实际 worktree 调整：`git worktree list` 可查。
cd <被测分支的 worktree 路径>
pnpm install --frozen-lockfile
```

⚠️ worktree 默认没有 `node_modules`，不装就跑不了 vitest / tsx 的包解析。
**不要在主仓装**——A/B 的目的是对比两个分支的提示词，在主仓验证器验的是主仓那份代码。

### 前置 2：确认场景集结构没坏

```bash
npx tsx scripts/verify-ab-scenarios.ts
```

断言三件事：**(a)** anchor 在其 groups 下可达、**(b)** groups 与生产 `ruleGroups` 一致
（偏离项须显式登记为已知例外）、**(c)** 每个场景至少有一项判据。
输出里 `⚠ N 警告` 是正常的（6 个场景用非生产 groups，见下节），**`✗` 才是问题**。
⚠️ 同样不进 CI，与场景集同属人工闸。

### 前置 3：改规则文案前，先看预算余量

**改任何 `prompt-registry/rules/*.md` 正文之前，先跑一次：**

```bash
pnpm prompt:lint
```

它会报出 L6 全组合的字符数与余量。**当前余量只剩 6 字符**
（`core`+`writeTools`+`genTools` 全组合 3194 / 硬线 3200 / 预警线 2720）。

⚠️ **本文档里的数字不是常驻副本，可能过期——以 `pnpm prompt:lint` 实跑输出为唯一权威源。**

为什么值得单独拎出来：提示词每条规则都在同一个 3200 字符的预算池里抢，
余量见底时，**一次看似无害的措辞润色就可能把门禁顶爆**，
而爆的那一刻往往已经改完、准备提交了。所以：

- 改文案**之前**先看余量，别等门禁红了才回头找原因；
- 如果本次改动可能超硬线（余量已接近 0 时任何加字都算），**先在 plan 里算好字数再动手**；
- 超了怎么办由plan 决定（合并规则、压缩措辞、或显式提预算）——**不要靠删别处的字来腾空间**，
  那会让另一条规则在没被 review 的情况下退化。

## 三条硬约束（违反任一则结论无效）

1. **固定 `temperature = 0`，且同一场景重复采样 ≥3 次取多数**（每次归档记实际值）。
   单次对比在 LLM 上没有统计意义——两次跑分不同会被误读成「规则生效了」。
   **这是最常见的自欺方式**：温度波动造成的差异和提示词改动造成的差异，在单次运行里长得一模一样。
   ⚠️ 首跑（2026-10-06）**未显式设置**（吃平台默认）⇒ 那批数字与他次**不可比**，只能当同批内基线。
   「平台默认」**不等于**「固定」：不同时间/通道的默认值可能变，**必须显式传值**。
2. **每次运行记录 token 消耗**（首版不设额度上限，但必须记录，见 §13.2）。
3. **A/B 两次运行之间，组装管线必须逐字节等价**。

   等价校验（**不依赖 vitest，在 worktree 内可直接跑**）：

   ```bash
   npx tsx -e '
   import {renderStaticFallback} from "./apps/server/src/agent/pi-runtime/prompt-registry.loader";
   const g=["core","writeTools","genTools"] as const;
   const h=()=>renderStaticFallback(g);
   console.log("两次组装逐字等价:", h()===h());
   console.log("全组合字符数:", h().length, "(应与 prompt-lint 一致)");
   '
   ```

   实测输出：

   ```
   两次组装逐字等价: true
   全组合字符数: 3194 (应与 prompt-lint 一致)
   ```

   `3194` 必须与 `npx tsx scripts/prompt-lint.ts` 报的字符数一致——不一致说明
   fallback 常量与磁盘 registry 已漂移，**A/B 跑的就是两份不同的提示词**。

   装了依赖的话，再补一条端到端的（关注 `case5` / `case5b` / `case5c`）：

   ```bash
   pnpm --filter @lnkpi/server exec vitest run src/agent/pi-runtime/pi-prompt-assembler.service.test.ts
   ```

   ⚠️ **case5 在 `pi-prompt-assembler.service.test.ts`，不在 `prompt-registry.loader.test.ts`**
   （loader 测试只有 case3 / case6）。
   ⚠️ `case5` 单条是恒真的（同一个字符串算两次），真正有判别力的是 `case5b`/`case5c` 的
   「换组必换 hash」反例对照。

   为什么这条最要紧：管线不等价时，A/B 的差异可能来自组装链路的任何一环，
   **你测的是随机性 + 管线抖动，不是提示词**。管线没验就开跑，跑出来的数字不能用来做决策。

## groups 怎么切（env 覆盖，不用改代码）

生产默认 = 三组全开，真值源在 `apps/server/src/agent/pi-runtime/rule-groups.ts` 的
`PRODUCTION_RULE_GROUPS`（agent.service.ts 从这里 import）。切组用环境变量：

```bash
AGENT_RULE_GROUPS=core,writeTools   # 例：写组场景
AGENT_RULE_GROUPS=core              # 例：readonly-session-refuse
```

解析规则（`resolveRuleGroups`，fail-closed）：

- 未设 / 空串 → 生产默认三组全开；
- 未知组名或大小写不符 → **启动即抛错**（不静默回落默认——否则「以为在测 `['core']`，实际三组全开」= 假绿）；
- 逗号分隔、容忍空白、自动去重，输出按规范序（core → writeTools → genTools）排列；
- 覆盖生效时 agent.service 会打一条 **warn 日志**（`AGENT_RULE_GROUPS 覆盖生效: [...]`）。

| 场景 | 需要的 AGENT_RULE_GROUPS |
|---|---|
| `gen-need-confirm` / `missing-info-ask` | 不设（= 生产默认） |
| `multi-node-view` / `single-node-no-view` / `no-template-claim` / `cross-canvas-memory` / `chat-no-node` | `core,writeTools` |
| `readonly-session-refuse` | `core` |

**为什么这些场景值得专门切组**：它们检验的正是「某组缺席时才生效」的负向守卫——
`write_guard`（`unlessGroup: writeTools`）与 `no_gen_claim.nogen`（`unlessGroup: genTools`）。
生产三组全开 ⇒ 这两条规则**在生产永不注入** ⇒ 只有构造子集才能验它们。

⚠️ **只在评测环境设置该变量，生产发版不得携带**：覆盖态下 unlessGroup 守卫规则不注入，
而工具注册（`tools/config.ts` 的 `resolveToolsWithClient`）不接 groups、照样全量下发
schema ⇒ 覆盖态是提示词构成开关，**不是安全边界**。
`verify-ab-scenarios.ts` 会把非生产 groups 的场景标成 `⚠ 已知例外`——那是设计，不是错误。

### 只读会话场景（`readonly-session-refuse`）的特殊约定

这个场景的判据**故意不含 `forbidTools`**。原因：`resolveToolsWithClient`
（`services/pi-runtime/src/tools/config.ts:54-68`）**不接 `ruleGroups`，无条件注册全部工具**，
所以即使 `groups=['core']`，写工具的 schema 照样下发给模型。

⇒ 它测的是「**模型有没有把 prompt 里的声明说出来**」，**不是**「工具是否真被裁剪」。
若模型直接调写工具并成功，**记为「运行时未裁剪工具」的观察，不计入本场景通过率**——
那是工具装配层的问题，不是这条提示词规则的失败。反过来，要求模型宣称
「写工具不可用」而它照运行时真相行事，也**不算它违反提示词**。

## 怎么跑一个场景

1. **按场景的 `groups` 设好 `AGENT_RULE_GROUPS`**（见上节；6 个场景需要设 env）。
   `groups` 是**规则组**不是工具组，取值只有 `core` / `writeTools` / `genTools`。
2. **有 `setup` 的先做 setup。**凡 `userMessage` 引用了画布既有内容
   （「这三个镜头」「第二个节点」）或需要预置记忆，缺setup 就会在空环境上跑出**假红灯**
   （模型答「画布上还没有节点」被判失败，与提示词质量无关）。
   `setup` **不计入判据**，只是前置条件；它自带自检步骤的按自检走。
3. 固定 temperature，发送 `userMessage`，记录完整的工具调用序列。
4. 对判据：
   - `expectTools`：**按序**比对实际工具序列。空数组 = 期望一个工具都不调。
   - `forbidTools`：任何一个被调用即判失败（防「顺手多调一个」）。它**也是判据**——
     `readonly-session-refuse` 那种「矛盾环境」场景才故意留空。
   - `manualJudge`：**需要人读回复文本**才能判的项，自动判不了。
5. 同一场景重复 ≥3 次，**取多数**作为该次运行的结果。
6. 记录 token 消耗。

### 判据设计的边界

`expectTools`钉的是「模型该调什么工具」，**不是「它说了什么」**。
措辞受表述影响太大，同一条规则换个说法就false，不适合当门禁。
所以需要判读文本的项一律放`manualJudge`，由人判。

## 首版不设通过率阈值

无历史数据时设阈值等于凭空造标准。首批跑出来的数字只能说明「当前大概在什么水平」，**不构成判定依据**。
**积累 ≥3 组对比数据后**，按基线的分布取分位数定阈值，而不是拍脑袋定整数（§13.1）。

⚠️ 因此「8 个场景里错了 2 个」在首版**不是红灯**，是基线数据。
唯一要警惕的是：**同一场景两次跑分差异很大**——那说明场景本身判据不稳，得先修判据。

### 首次只跑一对，别一次跑满

**首跑范围：`gen-need-confirm` + `single-node-no-view`**（各 ≥3 次采样，约 6 轮真模型会话）。

理由（成本）：8 个场景 × ≥3 次 = 至少 24 轮会话，而单轮耗时**尚无基线**——
取决于会话长度、要不要先做 setup、以及 `readonly-session-refuse` 那种还得改 env 重起的额外开销。
§13.2 说「频率极低（按周计）成本敞口有界」，这个前提**未经实测确认**，先跑一对把
「单轮多贵、记录格式好不好用」摸出来，再决定要不要跑满。**别在没基线时承诺 24 轮的预算。**

这一对是刻意选的：`gen-need-confirm` 是正向流程（该做的做对没有），
`single-node-no-view` 是负向边界（不该出手时别出手）。两条都过了，说明
「跑法 + 记录格式 + 判据可判读」这三件事本身成立，再铺开才有意义。
**建议顺带跑 `chat-no-node`**（同属负向边界，且不用改 `ruleGroups`，成本最低）。

## 观测口径：规则 22「叙述代替调用」的可证伪判据（2026-10-06 定）

**背景**：全量 28 复测（#223）10 轮中出现 **1 例「模型输出『我先搜索…』但同轮并没有真调 `tool_search`」**。
据此，规则 22 追加了「宣告要搜的**同一轮必须真调** `tool_search`，禁止只叙述不调用」（#231，规则 v1.3.0）。
⚠️ 按本仓铁律，靠 prompt 让模型**改变行为**属**概率性缓解**（仓库实证：「模型能逐字复述指令，但不会照做」）。
⇒ 必须给它一个**可证伪**的观测口径，否则「这次改动到底有没有用」永远说不清。
**决策记录：用户已裁定「保留规则 22 分句 + 补观测」（不回滚），本节点即为「补观测」的判据。**

### 失败形态的判定（两步，同一份事件流可复算）

「叙述代替调用」= **同一轮内**，模型回复**文本命中宣告式搜索意图**，且该轮 `tool_execution_start`
的 `toolName` 序列里**不含 `tool_search`**。两步都要满足才算命中（只叙述不算、只调用不算）：

1. 从该轮 harness 事件流取两样：① 回复文本；② `tool_execution_start` 的工具名序列。
2. **命中 = 序列不含 `tool_search` 且文本命中意图**（`先?搜索 / 搜一下 / 查一下有没有 / 有没有.*工具 / tool_search`）。
   正则只做**粗筛**，命中样本必须逐条人工复核（排掉「引用用户原话」等假阳），**复核数一并记入归档**。

> 数据源分工（别混用）：
> - **生产 Prometheus** 只能判「搜索**是否发生**」（`tool_search_calls_total{outcome}` + 挂分母的触发率），
>   **判不出「只叙述没调用」**——纯文本行为不进指标。生产侧只作**趋势**参考。
> - **A/B 真模型评测（本文档）**是「叙述代替调用」的**唯一可判读处**。故本口径必须挂在 A/B 上，不能只挂生产。

### 判据（可证伪，阈值不拍整数）

- **H0**：规则 22 分句**不改变**「叙述代替调用」率。
- **采集**：每次至少跑 **1 个会诱发搜索的场景**（问**延迟工具领域**的问题，例如「画布上有没有我上传的素材」——
  这类问题在常驻集里**没有完整替代品**，模型才有搜索动机；问常驻能答的问题恒不触发，测不出东西）。
  同场景 ≥3 采样，记 `命中数 / 有效轮次`。
- **阈值**：沿用上文「首版不设通过率阈值」——**积累 ≥3 组对比数据后按分布取分位数定**，不拍脑袋定整数。
- **排他动作（这是「可证伪」的关键）**：若连续观测显示该率**不降或上升** ⇒ 执行回滚
  （规则 22 删该分句 + 6 处同步），并改走**确定性路线**（仓库铁律：状态担保不靠提示词，靠事件层/ UI）。
  ⇒ 回滚条件**事先写死**，不是事后解释。

### 归档必须带的一列

每次 A/B 归档**追加一列** `tool_search 叙述代替调用`（格式：`命中 N / 有效 M 轮`），见下方归档模板。

## 场景一览

> 「负向边界」列为**摘要**，**以场景集字段为准**（`forbidTools` 可能比表里列得多，
> `readonly-session-refuse` 更是故意留空——原因见上）。判读前请回场景集看全量字段。

| id | 检验anchor | 期望工具 | 负向边界（摘要） | 需改 groups |
|---|---|---|---|---|
| `gen-need-confirm` | `gen-gate` / `no-gen-claim` / `media-tool-policy` | `upsert_media_node` → `propose_generation` | 禁 `run_image/video/text_generation` | 否 |
| `missing-info-ask` | `media-tool-policy` | `ask_user` | 禁 `propose_generation` | 否 |
| `multi-node-view` | `canvas-view-card` / `no-gen-tools` | `render_canvas_view` | 禁 `propose_generation` | 是（去 genTools） |
| `single-node-no-view` | `canvas-view-card` / `no-gen-tools` | （空 = 不出图） | 禁 `render_canvas_view` | 是（去 genTools） |
| `no-template-claim` | `no-template` / `identity-and-truthfulness` | （空） | 禁 `propose_generation` | 是（去 genTools） |
| `cross-canvas-memory` | `memory-scope-isolation` | （空） | 禁 `propose_generation` | 是（去 genTools） |
| `chat-no-node` | `media-tool-policy` / `no-gen-tools` | （空） | 禁 `upsert_media_node` / `render_canvas_view` 等 | 是（去 genTools） |
| `readonly-session-refuse` | `readonly-session-guard` / `identity-and-truthfulness` | （空） | （**故意留空**，见上） | 是（仅 `core`） |

## 加场景 / 改场景时

改完**必须**跑 `npx tsx scripts/verify-ab-scenarios.ts`（断言 a/b/c 三条，见「前置 2」）。

- **anchor 必须逐字对照 `prompt-registry/PROMPT_SPEC.md` 的规则地图表**。
  ⚠️ 没有 `sidebar-vision` 这个 anchor（`sidebar_vision.tail.md` 的 anchor 是 `no-template`）。
- ⚠️ **工具名别用 `grep 'name: "' services/pi-runtime/src/tools/*.ts` 扫**——
  5 个 `run_*_generation` 由 `generation.ts` 的工厂函数 `runTool(name, label, desc, path)` **动态生成**，
  不是 `name: "..."` 字面量，grep 扫不到。据此判「工具不存在」会误杀。
  正确做法：扫 `runTool("` 或直接调builder 取 `.name`。
- ⚠️ 本仓 `git grep` 会静默失败。任何「找不到」的结论用 `os.walk` 递归扫复核。
- **新场景用了非生产 groups ⇒ 必须登记进 `scripts/verify-ab-scenarios.ts` 的
  `KNOWN_UNREACHABLE_EXCEPTIONS`**，否则 (b) 硬失败。这是刻意的：
  登记簿一旦可以随便膨胀，就等于没有登记簿。
- **`userMessage` 引用画布既有内容 ⇒ 必须写 `setup`**，否则跑出假红灯。

## 运行期操作纪律（2026-10-06 实测补齐）

下面四条都是**踩过并按取证定位**的，不是最佳实践清单。每条尽量同段给复现命令 ——
「这次没遇到」不等于「不会遇到」。

### ① 同一时刻只允许一个 A/B worker

免费额度（仍走平台 key 时）是**全账号共享**的。两个 worker 并发 ⇒ 429 出现率翻倍
⇒ 重场景单轮更容易撞超时 ⇒ 有效样本两头一起变少。**别为了「跑快点」开第二个 worker。**

判有没有并发在跑：

```bash
# 远端：会话目录里出现两个 RUN_ID、且创建时间交替 ⇒ 有并发
# （本仓环境的 sessions PVC 路径；换环境就换路径）
ssh deploy-cvm 'ls -t /var/lib/rancher/k3s/storage/*pi-lnk-runtime-sessions/ | grep "^ab-rule22" \
  | sed "s/^ab-rule22-\([^-]*\)-.*/\1/" | sort | uniq -c'
# 本地：有没有还在跑的 worker
ps -eo pid,ppid,etime,command | grep '[d]ocker exec .*-e N='
```

### ② 后台 driver 被中断会留下**孤儿 worker**

`ssh … docker exec … node -` 的父进程（driver 的 zsh）被杀时，**ssh 子进程不会跟着死**：
它 reparent 到 `launchd`（`ppid=1`）继续跑满整个 plan，输出仍写进原日志文件。
表症是「`ps` 里已经没有 driver，但额度还在被吃、日志文件还在长」。

⇒ **每次开跑前先扫一遍 `ppid=1` 的 worker**（`ps -o pid,ppid,command -p <pid>`）；
换 driver 或改脚本后，先把旧的杀干净再起新的，别指望它自己退出。

### ③ 超时按**场景最坏耗时**设，别按平均

实测 `s4-capability`（「把这几个镜头合并成一个九宫格」）单轮本来就要 **54–63s**（事件数 222），
叠加 429 后的内部重试 ⇒ 轻易破 240s。表症：

```
DONE T|s4-capability|4 … end= nEv=0 240002ms ERR=This operation was aborted
```

⚠️ **`This operation was aborted` 有两条来源**：driver 侧 `ac.abort()`（客户端超时）与
`agent_end` 的 `d.error.message`（上游 abort）。**只看错误字符串会归因错** ⇒
必须同时看 `elapsedMs`：≈ 设定的超时值 = 客户端超时；否则是上游问题。

### ④ 重试必须换**新会话**（否则 3 次机会退化成 1 次）

一轮超时后**服务端那一轮仍在跑**；紧接着对**同一个 sessionId** 发 prompt 会拿到
`prompt 409`（会话忙）。于是「重试 3 次」里 2 次必废 ⇒ 报告写「3 次」，实际只有 1 票。

修法两条：
1. `sessionId` 里带上 attempt 序号 ⇒ 每次重试都是**全新会话**（仓库内 L1 侧本来就是这样：
   `driver.ts` 的 `eval-<ts>-<rand>`；A/B 脚本此前复用 `${RUN_ID}-${arm}-${场景}-${样本}` 才踩到）。
2. 409 与 429 的退避要分开：**409 → 20s（等对端那一轮结束）、429 → 15s（配额节流）、其余 3s**。

⚠️ 配套：断点续跑的 SKIP 集必须用「**已有有效样本**的 key」，不能用「有 DONE 行的 key」——
后者会让一次环境失败**永久钉死**该 key，后续轮次再也不补。

### ⑤ 判「手上这份数据是哪一版脚本产的」——看内容，别看文件名

**日志文件名会骗人**（实测：`ab-run-v3.log` 里装的其实是 v4 脚本产的数据，
而真正跑着 v3 共享画布脚本的那个 worker 恰好也往同一文件里写）。
三条判据，按可靠性从低到高：

1. **会话目录命名形态**：每样本独立会话的版本，目录名形如
   `<RUN_ID>-<臂>-<场景>-<样本>`（重试版还带 `-a<attempt>`）。
   若目录名里**没有样本序号**（只有 `<臂>-<场景>`）⇒ 是共享画布那一版，**数据作废**。

   ```bash
   ssh deploy-cvm 'ls <sessions-dir>/ | grep "^ab-rule22" \
     | sed "s/^ab-rule22-[^-]*-//" | sort | uniq -c | sort -rn | head'
   ```

2. **Nest 会话计数（最硬）**：每样本新画布 = 每个样本在 Nest 里建一条会话。
   按 RUN_ID 计数 ⇒ **条数 ≈ 跑过的 key 数**（重试会更多）；**为 0 就是共享画布版**。

   ```bash
   # 在 lnkpi-api 容器内执行（prisma 与生产库同源）
   node -e 'const{PrismaClient}=require("@prisma/client");(async()=>{const p=new PrismaClient();
   console.log(await p.session.count({where:{title:{startsWith:"ab-rule22-<RUN_ID>"}}}));
   await p.$disconnect();})()'
   ```

3. **跨臂指纹（人工一眼可辨）**：在「画布上现在有几个节点」这类场景上，
   共享画布版会出现 **C 臂全答「12 个节点」、T 臂全答「14 个节点」** ——
   因为 C 臂先跑、它的 `s4-capability` 真的建了 2 个节点（`upsert_media_node` +
   `apply_sidebar_attachments`），T 臂看到的是被改脏的**同一块**画布。

⚠️ 「跑完了」≠「数据能用」。**第 2 条应该在开跑前就做一次**（确认自己起的是新版），
而不是等跑完再回头怀疑自己。

## 规则 22 A/B 观测结果（2026-10-06，v5 干净跑）

**问题**：规则 22 的分句「宣告要搜的同一轮必须真调 `tool_search`，禁止只叙述不调用」
（#231 上线）**是否值得保留**？这是该分句上线后第一次按可证伪口径做的观测。

**两臂**（`systemPrompt` 逐字节只差该分句）：

| 臂 | registry | hash | 静态段字符数 |
|---|---|---|---|
| C（**无**分句） | v1.2.0 | `8916a0c7244f` | 3212 |
| T（**有**分句，= 现网） | v1.3.0 | `a75e0e061583` | 3246 |

**方法**：每样本开一块**全新 12 节点画布**（防跨臂顺序污染，见文件上方 v3 事故说明）；
同一模型 `agnes-3.0-flash`；每 attempt 换**新 sessionId**（见「运行期操作纪律 ④」）；
判据 = 该轮 `tool_search` 是否出现在
`tool_execution_start` **∪** `message.content.toolCall`（第二来源，防事件漏收）。

**结果（52 个有效样本，0 无效）**：

| 场景 | 期望 | C 臂 搜索率 | T 臂 搜索率 |
|---|---|---|---|
| `s1` 画布节点数 | 应搜 | 100%（5/5） | 100%（5/5） |
| `s2` 素材库 | 应搜 | 100%（5/5） | 100%（5/5） |
| `s3` 模型列表 | 应搜 | 100%（5/5） | **40%（2/5）** |
| `s5` 生成状态 | 应搜 | 80%（4/5） | 100%（5/5） |
| `s4` 合并九宫格（重场景） | 应搜 | 50%（2/4） | **未采足**（T 臂单轮频撞 420s 超时） |
| `n1` 道谢 / `n2` 打招呼 | **不**应搜 | 0%（0/4） | 0%（0/4） |

合计（**剔除 `s4`**，因 T 臂未采到）：positive **C 95%（19/20）vs T 85%（17/20）**。

### 结论（按可证伪性排序）

1. **该分句要防的失败形态没有复现**：`叙述代替调用` 两臂均为 **0/52**。
   两臂都主动搜索、negative 场景两臂都 **0 次误搜** ⇒ 在这套场景下，
   该分句**既没有可测收益，也没有可测危害**。
2. **唯一显著差异在 `s3-models`（C 5/5 vs T 2/5）**，方向与其意图**相反**。
   `n=5` 太小 ⇒ **不能据此判定分句有害**；但它与更早一轮（共享画布版、同格 C 90% vs T 40%）
   方向一致，**值得下一轮用更大 n 复核**。
3. `s4-capability` 是重场景（单轮 54–63s、429 后可达 420s 超时），T 臂样本未采足 ⇒
   **不纳入汇总，单列**。把重场景放进主表会因「两臂样本数不等」破坏可比性。

⚠️ **不可外推**：单一模型、单一账号（免费额度）、7 个自拟场景。
本观测支持「在这套场景下没测到该分句的收益」，**不支持**「该分句无用」的一般结论。

⚠️ **归档必须带的一笔**：本次跑的中途发生过一次 `deploy.yml` rollout
（pi-runtime pod 重建 + api 容器重建）。它只影响**时延**（新镜像含 #240 的 `/events` flushHeaders），
**不改被测行为**（systemPrompt 由观测脚本自带、不经运行时 registry）⇒ 结论可用，
但必须记下来，否则「同一 run 的数据是单条件」这个假设会被后人当成事实。

## 结果归档

每次跑完追加一行。**首版这些数字是基线，不是判定依据**（见上）。

| 日期 | 分支/commit | 场景 | 有效采样 | 通过 | 备注 |
|---|---|---|---|---|---|
| 2026-10-06 | `8a9a6030`（减点名**前置**基线） | `gen-need-confirm` | 6 | 3 | 3 例未调 `propose_generation`；零 `forbidTools` 命中 |
| 2026-10-06 | `8a9a6030` | `single-node-no-view` | 4 | 4（机检） | 无 `render_canvas_view`；2 例上游报错已重采补齐 |
| 2026-10-06 | `8a9a6030` | `chat-no-node` | 3 | 3 | 零工具 + 闲聊回复 |
| 2026-10-06 | v5（每样本新画布，`fix/eval-error-retry` 之后的脚本） | **规则 22 C vs T**（7 场景） | 52 | — | 见上节「规则 22 A/B 观测结果」：`叙述代替调用` **两臂均 0/52**；positive 剔除 s4 后 C 95% vs T 85% |

### 首跑明细（2026-10-06，R1）

**执行条件**（后续跑次要能对齐，故必须记全）：

- 模型 `agnes-3.0-flash`（用户 `17279698608` 的 BYOK，openai 格式通道）；`temperature` **未显式设置（平台默认）**。
  ⚠️ 下次跑**必须**固定 temperature 并记具体值——否则两次数字不可比。
- 执行位置：`lnkpi-api` 容器内（BYOK 明文密钥不出容器边界）。系统提示词从容器内 `/app/prompt-registry`
  磁盘真值按 `renderStatic` 语义组装。
- 测量：SSE 事件流（`tool_execution_start`）；**关键样本用 pod 内 session jsonl 交叉验证，两者一致**。
- 单轮耗时：`gen-need-confirm` 约 **3–6 min/轮**（agnes 慢 + 9 轮工具）；负向场景 < 1 min。
- 上游噪声：agnes 间歇返回错误（`stopReason:"error"`）。脚本对「零工具且零文本」样本**换画布重采**（≤3 次），
  避免把上游 5xx 记成模型行为。

`gen-need-confirm`（6 次有效采样，3 通过）：

```
r1d-s1  list_generation_scenes → upsert_media_node → set_node_generation_params → propose_generation        ✅
r1d-s2  list_generation_scenes → list_model_options → get_canvas_summary → upsert_prompt_node
        → upsert_media_node ×3 → set_node_generation_params ×3 → connect_nodes → propose_generation ×3      ✅
r1d-s3  list_generation_scenes → list_model_options → upsert_media_node ×3 → set_node_generation_params ×3  ❌ 缺 propose_generation
r1e-s1  upsert_media_node ×3                                                                               ❌ 缺 propose_generation
r1e-s2  upsert_media_node → list_generation_scenes → list_model_options → set_node_text ×3
        → upsert_media_node ×2 → set_node_generation_params ×3 → propose_generation                        ✅
r1e-s3  list_generation_scenes → upsert_media_node ×3 → set_node_generation_params ×3                      ❌ 缺 propose_generation
```

⚠️ **零 `forbidTools` 命中**——没有一例直接 `run_*_generation`。「跳过确认门」的实际表现是
**不调 `propose_generation`**，而非「绕过闸门直接生成」。这是本基线里最该盯的模型行为缺口：
`gen-gate` 要求「建节点 → propose_generation → 等确认」，弱模型约半数会话漏掉中间那步；
漏掉时的替代行为分两档——**用文本询问确认**（意图对、缺工具，尚可）与**直接汇报「已建好」**（无确认动作，更差）。

`single-node-no-view`（4 次有效采样，4 通过机检）：

```
r1d-s1  get_canvas_summary → 「第二个节点是「镜头2」（image-…，draft）」                    ✅
r1d-s2  / r1d-s3  连续 4 次 stopReason:error、零输出 ⇒ 上游故障，样本无效（已重采补齐）
r1e-s1  get_canvas_summary → 「第二个节点的标题是「镜头2」」                                ✅
r1e-s2  （零工具）→ 「**「画一张图：一个穿红色风衣的猫…」**」                                ⚠️ 未读画布直接作答
r1e-s3  get_canvas_summary → 「第二个节点的标题是「镜头1」」                                ⚠️ 顺序歧义答错
```

⚠️ 机检全过（无 `render_canvas_view`），但 `manualJudge` 暴露两条：**零工具直接作答**（未取证即断言）
与**「第二个」的排序歧义**（建节点顺序 ≠ 画布展示顺序）。前者是负向场景的隐藏风险——
守卫住了「不出图」，但没守住「不臆断」。**修判据的建议**：给 `single-node-no-view` 补一条
「文本答案须与 `get_canvas_summary`/`get_node` 结果一致」的人工判读项（当前 `expectTools: []`
把「不读也答对/答错」一并判过）。

`chat-no-node`（3 次采样，3 通过）：`[]` ×3，回复闲聊，零画布工具。

## 归档模板

```
场景: gen-need-confirm
分支/commit:
temperature:      (三次必须一致，记具体值)
组装 promptHash:  (A/B 两次必须一致)
采样 1: upsert_media_node → propose_generation        ✅
采样 2: upsert_media_node → propose_generation        ✅
采样 3: propose_generation                           ❌ 缺 upsert_media_node
多数结果: upsert_media_node → propose_generation  → 通过
manualJudge:  未声称「正在生成」，已等确认            ✅
tool_search 叙述代替调用: 0 命中 / 3 轮有效（判定两步见「观测口径」节；粗筛命中须人工复核）
token: (三次合计)
备注:
```
