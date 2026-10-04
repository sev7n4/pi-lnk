# AGENTS.md 整改规格：把规范从「提交手册」升级为「工程契约」

状态：待审（2026-10-04）
关联：`docs/agents-md-review-2026-10-04.html`（评审报告 · 基线 `352b44f`）
影响面：仅文档层。**不改任何生产代码、不新增脚本、不接入 CI。**

---

## 1. 要解决的问题

评审实测确认：AGENTS.md（362 行 / 21KB）是一份高质量的**提交流程手册 + 踩坑备忘录**，但不是合格的 **agent 工程规范**。核心缺陷有三类：

| 类别 | 实测证据 | 后果 |
|---|---|---|
| **事实错误** | L44 / L159断言「纯文档改动不触发 CI」。实测 `ci.yml` 的 `paths-ignore` **只挂在 `push` 事件**，`pull_request:` 分支下无任何过滤 ⇒纯文档 PR 照跑三个 required check | agent 会主动跳过验证。方向性错误 |
| **覆盖缺口** | 仓库有**4 个 workflow**，文档只说「两条」，`prompt-lint.yml` 零提及。连带：prompt-registry「加规则须同步 6 处」与工具tiering「被资产点名才能进延迟集」这两条最易出静默失败的判据，在规范里完全缺席 | 项目最脆弱的两类资产无任何防护 |
| **计数漂移** | 测试文件写 97/176/26，实测 **98/180/28**；ADR 列「0001-0008」，实际已有 **0009**；superpowers 写「283 份」，实测 **288** | 文档第 159 行自称「别抄旧数字，要数字时实测」，却仍在抄 —— 自相矛盾 |

另有一个**结构性缺失**：文档 41% 篇幅（约 148 行）讲 git 流程，**通篇没有一条说明「什么不许做、什么要先问人」**。本项目多agent 并存、连着真实生产、有真实扣分/退款逻辑 —— 这个缺位直接表现为**责任真空**：多 agent 同时改一个仓库时，谁改的、谁负责验、谁有权动生产，全靠默契。

**为什么现在修**：上一轮评审已证明这些缺陷会自动累积（计数漂移了没人发现、CI 描述错了没人纠正）。每多一个 agent 在错误约束下工作，累积速度翻倍。

---

## 2. 目标与非目标

### 目标

1. **纠正 P0 事实错误** —— CI paths-ignore 描述必须区分 push 与 pull_request。
2. **补齐系统地图** —— 让新agent 读完能回答「请求怎么跑、改哪层走哪条流水线、怎么验证上线」。
3. **补齐职责边界** —— 定义**权限范围 / 红线清单 / 自主范围 / 越界信号**，不含人设。
4. **补齐完成定义（DoD）** —— 把「做得对不对」变成可执行命令。
5. **补齐变更影响面矩阵** —— 每类改动必须同步哪些位置、必须跑哪些门禁。
6. **补齐 PR 规范** —— 文档必填项 + `.github/pull_request_template.md`。

### 非目标（本次明确不做）

| 不做 | 理由 |
|---|---|
| **拆分 AGENTS.md** | ADR-0001 / 0008 / 0009 与 `charts/pi-lnk-runtime/README.md` 共**4 处按章节名引用**AGENTS.md 的章节（「pi 内核版本」「文档管理规范」「pi 内核开发纪律」「端口表」）。拆分会让这4 处断链。留独立 PR |
| **写 `scripts/verify-claims.sh`** | 本PR 保持纯文档、零代码风险。改为写「引用事实性数字前先实测」的硬规则，人执行 |
| **接入 lint / pre-commit** | 需引入构建依赖，是独立的技术选型决策 |
| **定义 agent 人设（人格 / 语气 / 主动性偏好）** | 属宿主层（system prompt / SOUL.md），换宿主即失效、无法验证，且会诱发表演式行为。见 §3.1 |

---

## 3. 设计

### 3.1 身份与角色：三层归属（本节的核心决策）

「agent 的身份与角色」在实践中被混为一谈，实际是三层：

| 层 | 内容 | 归属 | 处置 |
|---|---|---|---|
| **身份层** | 我是谁、沟通语气、主动性偏好 | 宿主配置 | **不写进仓库**，见下方理由 |
| **契约层** | 做了之后怎么验收（硬规则 / 流程 / 判据） | `AGENTS.md` | 已有且质量高，本PR 只增补 |
| **边界层** | 我能做什么、何时必须问人 | `AGENTS.md` | **完全缺失，本 PR 新增** |

**为什么身份层不进仓库规范**：

1. **会漂移** —— 换模型 / 换宿主后即成死条文
2. **无法验证** —— 「你要严谨」没有任何判据，检查不了
3. **会诱发表演式行为** —— 让模型扮演角色，反而弱化它对真实约束的遵守

**为什么边界层必须进仓库规范**：它与仓库强绑定（画布 SSOT 在前端、`vendor/` 禁止 patch、`runtime-deploy` 要手工发），换宿主依然成立。

**边界层的四类内容**（全部可判定，无一条是人格描述）：

| 类型 | 内容 | 判据形态 |
|---|---|---|
| 红线清单 | 动 schema / 动积分退款 / 改 prompt 预算 / 生产止血⇒ 先问人 | 动作清单，可枚举 |
| 产物归属 | 每类改动由谁负责验 | 改动类型 → 验证方式 |
| 自主范围 | 明确哪些可自己决定、不打断人 | 动作清单，可枚举 |
| 越界信号 | 「我不确定这条规则是否适用」⇒ **停下问，不要猜** | 单条强规则 |

第四条最关键：本次评审发现的 3 处计数漂移+ 1 处方向性错误，**全该被核实的存量事实**。缺少这条规则时它们会持续累积。

### 3.2 系统地图（新增一节）

结构：一张 ASCII 数据流 + 一张「改哪层 ⇒ 走哪条流水线 ⇒ 怎么验证上线」对照表。

**已核实的实况**（写进文档的事实，必须准确）：

```
浏览器 → nginx(:8888) → Nest apps/server(:5100) → pi-runtime(K3s NodePort 30100，外网不可达)
                → vendor pi (services/pi-runtime) → 上游模型（AGNES_MODEL_ID 线上为空串 ⇒ LLM 靠 BYOK 注入）
```

**四条流水线的触发面（实测，AGENTS.md 现只说两条）**：

| workflow | 触发 | 覆盖 |
|---|---|---|
| `ci.yml` | push(master) 走 `paths-ignore`；**`pull_request` 无任何 paths 过滤** | 全仓构建 + 测试 |
| `deploy.yml` | push(master) + **paths 白名单**：server / web / packages / deploy / prompt-registry / package.json / pnpm-lock / pnpm-workspace / .dockerignore / 自身 | api + web |
| `runtime-deploy.yml` | **纯 `workflow_dispatch`，无 push 触发** | pi-runtime |
| `prompt-lint.yml` | paths 触发：`prompt-registry/**`、`prompt-registry.*`、`prompt-lint.ts` | 提示词门禁 |

⚠️ **静默失败点**：改 `services/pi-runtime/**`、`skills/**`、`vendor/**` 后 push 到 master，`runtime-deploy.yml` **不会自动跑**，线上不会有任何变化。这是「CI 全绿但功能没上线」的典型来源，必须在文档里显式写出。

**其他必须显性化的架构事实**（当前只存在于私有记忆，agent 换上下文即丢）：

- 画布 **SSOT 在前端**（`saveCanvas` 整份覆盖）；`add_node` 有**两份 applier 必须同步**
- pi-runtime 部署 **tag = master 的 commit 短 SHA**（非语义版号）
- 生产库是 **SQLite**；`/opt/lnkpi/.env` 是止血开关
- 前端**无 CSP**（`nginx.conf` 无该头）⇒ iframe sandbox 配错无第二道防线

### 3.3 变更影响面矩阵（新增一节）

这是本次**价值最高**的一节 —— 把「改什么会静默坏掉」变成可查表。

**提示词规则变更 ⇒ 同步 6 处**（已用 python 直读复核定位到文件，`git grep` 对这些符号返 0 命中属已知假阴性）：

| # | 位置 | 漏掉的后果 |
|---|---|---|
| 1 | `prompt-registry/rules/<id>.md` | 规则不存在 |
| 2 | `prompt-registry/MANIFEST.yaml`（`contentHash` = `sha256(body.trimEnd())` 前 12 位，`version` 两处一致） | 完整性校验失败 |
| 3 | `prompt-registry.loader.ts` 的 `COMPOSED_IDS` | 不参与组合 |
| 4 | `prompt-registry.loader.ts` 的 `FALLBACK_BY_ID` 映射（该常量仅此一处定义，3 处引用） | 降级路径与实际规则不一致 |
| 5 | 🔴 `pi-prompt-assembler.service.ts` 的 `renderStaticFallback()` **拼装顺序**（该符号跨 3 个文件出现，此处指内嵌 fallback 的那一处） | **整段提示词静默消失且无任何报错** |
| 6 | 🟡 `pi-prompt-assembler.service.test.ts` 的 `EXPECTED` 硬编码串 |测试假绿 |

⚠️ **符号归属易踩**：`renderStaticFallback` 在 `pi-prompt-assembler.service.ts` / `prompt-registry.loader.ts` / `agent.controller.ts` **三个文件里都出现**（已 python 直读复核）；`FALLBACK_BY_ID` 只在 `prompt-registry.loader.ts` 定义、**`prompt-registry.fallback.ts` 里没有同名符号** —— 它是靠内容逐字相等被约束的，不是靠常量名对齐。

同步判据：**「磁盘 renderStatic == 内嵌 renderStaticFallback」四组合逐字符相等**。

⚠️ 核实符号位置用 `git grep -n -- <符号> -- <目录>`（实测可用）。注意本机 `grep` 被 shim 包装，**大范围扫描**（如全仓 python 遍历）会超时 exit 137 —— 此时缩小目录范围，不要据此判断符号不存在。

⚠️ 预算约束：**L6 上限 3200字符**，实测当前 2880（core+writeTools 2408），预警线 2720 已过，余量约 320 字符 ≈ 4 条中等规则。

**工具分层变更 ⇒ 回答「哪个资产点名它」**：

新增工具默认进延迟集前，**必须**回答：prompt-registry 规则或 `skills/*.md` 里，**哪个资产按名字点名了它**？答不上来按「未点名」处理 ⇒ 常驻。

机理：`drive/tools.ts:686` 只把 `activeToolNames` 传给 `prepareToolCall`，未激活的工具吃 vendor 硬编码的 `Tool X is unavailable`，**没有恢复路径**。

生产证据（PR#100）：40 次工具调用全落常驻集，`tool_search_activated_total` 为 0 ⇒ 官方 Dynamic Tool Loading 触发率至今为 0。

⚠️ 已因此回归常驻：`arrange_nodes` / `set_node_generation_params` / `save_memory` / `focus_node` / `remove_edges`。**`focus_node`（单数，常驻）≠ `focus_nodes`（复数，延迟）** —— 这对只差一个字母的陷阱极易踩错。

新增/变更工具须在 `services/pi-runtime/src/tools/tiering.test.ts`（292 行回归锁）显式声明归属。

**vendor 层次边界 ⇒ 别当 agent-core 能力清单**：

`pi.on` / `pi.registerTool` / `registerCommand` / `ui.*` **全属 `pi-coding-agent`**（交互式终端宿主，本项目未依赖）。`docs/extensions.md` 是扩展面**全景**，不是 agent-core 能力清单。我们的事件源本来就是 vendor 的 `harness.events.on`。

### 3.4 完成定义（DoD，新增一节）

全部为可执行命令，非原则性表述。

**提交前必跑**：

| # | 命令 | 为什么 |
|---|---|---|
| 1 | `pnpm -r build` | **vitest 绿 ≠ tsc 绿**（esbuild 只转译）；web 走 `vue-tsc -b` |
| 2 | `pnpm test:server:changed` / `pnpm test:runtime` | 默认只跑变更相关；全量是 CI 的活 |
| 3 | 引用了文档里的事实性数字 ⇒ **先实测再写** | 见§3.5 |
| 4 | 改 `prompt-registry/**` ⇒ `pnpm prompt:lint` | 门禁独立于 ci.yml |
| 5 | 改 `vendor/` ⇒ 确认**零业务 patch** | 否则 upmerge 无法与上游对齐 |

**合并前必看**：

- `gh pr view <n> --json mergeStateStatus` —— `BLOCKED` = required check 未过，**GitHub 不允许绕过**
- required checks = `["Verify spec figures", "Build monorepo", "Build API Docker image"]`
- ⚠️ **`Test Files N passed` ≠ CI 会绿**：必须同看 `Errors N errors` 与末尾 `Exit status`。实测180 files / 1449 tests 全 passed 但 `Errors 11` ⇒ exit 1
- ⚠️ **CI 全量测试不在独立 job**：`pnpm test` 是 `Build monorepo` 内的一个 step，`gh pr checks` 看不到，须下钻 step

**合并后（上线验证）**：

- 改 pi-runtime / skills / vendor ⇒ **必须手工发 `runtime-deploy.yml`**（§3.2）
- 生产取证：curl 免鉴端点比数量/字符数，或容器内 `require(dist/...)` 读真值
- ⚠️ **别只看 workflow 绿了就assume 已上线**

### 3.5 事实性数字的处理规则（新增）

当前矛盾：文档第 159 行写「别抄旧数字，要数字时实测」，却仍抄了 3 处。

**规则**：AGENTS.md 正文中**不写会漂移的计数**（测试文件数、文档份数、清单长度）。需要给出规模感时，写「约」「量级」并附**获取命令**。

例：
- ❌ `2026-10-03 实测：server 97 / web 176 / pi-runtime 顶层 26个测试文件`
- ✅ `测试文件规模会变，要数字时实测：find <dir> -name '*.test.ts' | wc -l`

**唯一例外**：`pi` 内核版本号保留 —— 它有明确的三处核对位置（§「pi 内核版本」已有），属受控事实。

### 3.6 PR 规范（新增一节 + 一个模板文件）

**四个必填项**：

| 项 | 要求 | 拦的是什么 |
|---|---|---|
| **变更动机** | 解决什么问题，一两句 | 防止「顺手改」混入 |
| **影响面** | 哪几层 / 哪几个端点 / 是否改提示词或工具分层 | 评审人不知道该看哪 |
| **验证证据** | 跑了什么命令、看到什么输出 | 防止「跑过了」当证据 |
| **是否需手工发 runtime 流水线** | 是/ 否 + tag | 防止「CI 绿了但没上线」的静默失败 |

**模板文件**：`.github/pull_request_template.md`（GitHub 自动填充；形式规范，不强制）。

---

## 4. 文档改动清单

| 文件 | 改动 | 行数变化 |
|---|---|---|
| `AGENTS.md` | 纠正 P0 CI 描述；新增「系统地图」「你的角色与边界」「变更影响面矩阵」「完成定义」「PR 规范」5 节；修3 处计数漂移；修 3 处 Markdown 体例（已逐行核实：L11 `-内核：` 缺前导空格 → 列表项不渲染；L12 `- 载体` 多余空格；L298 `>2026-10-03` 缺前导空格 → 引用块不生效） | 362 → **约 420** |
| `.github/pull_request_template.md` | **新增** | 0 → 约 45 |
| `docs/README.md` | 登记新增内容（`docs/README.md` 自身要求新增文档必登记） | +2 |

**不变更**：任何 `apps/` `packages/` `services/` `charts/` `deploy/` 下的文件；任何 workflow 定义；任何 ADR。

**章节名稳定性保证**：新增内容全部使用**新章节名**，现有章节名（分支纪律 / 文档管理规范 / pi 内核版本 / 端口约定 / pi-runtime 开发纪律 / 核心 skill 路由）**一字不改**，以保证 ADR-0001 / 0008 / 0009 与 `charts/pi-lnk-runtime/README.md` 的 4 处引用不失效。

---

## 5. 验收标准

| # | 判据 | 方式 |
|---|---|---|
| 1 | CI 描述已纠正 | 文中明确区分 push 与 pull_request 的触发行为 |
| 2 | 4 个 workflow 全部列出 | 与 `.github/workflows/` 实际文件数一致 |
| 3 | 无易腐计数 | `grep` 不到 `97` / `176` / `26` / `283` 这类计数；测试规模处改为附获取命令。ADR 计数改为「0001 起，最新编号见 `docs/adr/`」 |
| 4 | ADR 引用未失效 | `git grep -l 'AGENTS.md' -- docs/adr charts` 引用的章节名仍在文档中 |
| 5 | 4 处章节名引用不断 | ADR-0001「pi 内核版本」/ ADR-0008「文档管理规范」/ ADR-0009「pi-runtime 开发纪律」/ charts README「端口表」 |
| 6 | PR 模板可用 | `.github/pull_request_template.md` 存在且四个必填项齐全 |
| 7 | 零代码变更 | `git diff --stat` 只含 `AGENTS.md` / `docs/README.md` / PR 模板 |
| 8 | 规范自洽 | 无「必须」缺对应判据；无相互矛盾陈述 |

**交付形态**：一个 PR 走完分支七步流程（开分支 → 开发 → 提交 → PR → 盯 CI 全绿 → squash 合并 → 盯部署）。

---

## 6. 风险

| 风险 | 概率 | 处置 |
|---|---|---|
| 主文件涨到 420 行，加载成本上升 | 中 | 已排除拆分方案；**后续独立 PR 专门处理拆分**，届时同步修 4 处章节名引用 |
| 新增章节与既有章节内容重复 | 中 | 实施时逐节对照，新增内容只写既有文档没有的；重复的改为链接 |
| 纯文档 PR 触发完整 CI 耗时 | 高 | 已确认这是正确行为（`pull_request:` 无 paths 过滤），耐心盯 |
| 计数规则被后人违反 | 中 | 已明确「不写会漂移的计数」；后续用 `verify-claims.sh` 机器化（本 PR 不做） |

---

## 7. 待确认

无。三个关键取舍已在本轮确认为：**① 只补内容不拆文件 ② 只写文档规则不写脚本 ③ PR 规范 = 必填项 + 模板文件**。
