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

1. **固定 temperature，且同一场景重复采样 ≥3 次取多数**。
   单次对比在 LLM 上没有统计意义——两次跑分不同会被误读成「规则生效了」。
   **这是最常见的自欺方式**：温度波动造成的差异和提示词改动造成的差异，在单次运行里长得一模一样。
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

## 结果归档

每次跑完追加一行。**首版这些数字是基线，不是判定依据**（见上）。

| 日期 | 分支 | 场景 | 3 次采样工具序列 | 通过 | token |
|---|---|---|---|---|---|
| _(待填)_ | | | | | |

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
token: (三次合计)
备注:
```
