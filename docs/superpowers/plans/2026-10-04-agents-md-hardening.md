# AGENTS.md 整改实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 AGENTS.md 从「提交流程手册」升级为「agent 工程契约」—— 纠正 P0 事实错误，补齐系统地图 / 职责边界 / 影响面矩阵 / DoD / PR 规范，消除计数漂移。

**Architecture:** 纯文档改动。AGENTS.md 主文件增补 5 个新节（约 +60 行），现有章节名一字不改以保住 4 处外部引用；新增 `.github/pull_request_template.md`；`docs/README.md` 登记新增内容。不拆文件、不写脚本、不改任何生产代码。

**Tech Stack:** Markdown / GitHub Actions（仅作为文档对象核实，不修改）/ Git

**Spec:** `docs/superpowers/specs/2026-10-04-agents-md-hardening-design.md`

---

## Global Constraints

- **零代码变更**：本PR 只能改 4 个文件 —— `AGENTS.md`、`.github/pull_request_template.md`（新建）、`docs/README.md`、`docs/agents-md-review-2026-10-04.html`（纳入版本控制）。任何 `apps/` `packages/` `services/` `charts/` `deploy/` 下的文件一律不动。
- **不拆文件**：主文件保持单文件。拆分会破坏 4 处外部章节名引用（见 Task 1Step 1的引用清单），留独立 PR。
- **现有章节名一字不改**：`## 分支纪律` / `## 文档管理规范` / `## pi 内核版本` / `## 端口约定` / `## 仓库结构` / `## 必须先做的事` / `## 核心 skill 路由` / `## 本机环境` 的标题文本必须逐字保留。新增内容只能使用**新章节名**。
- **不写易腐计数**：正文中不得出现测试文件数、文档份数、清单长度这类会漂移的数字。ADR 计数改为「0001 起，最新编号见 `docs/adr/`」。唯一例外是 pi 内核版本号（已有三处核对位置，属受控事实）。
- **改动必须落盘并复核**：可靠判据只有 `git status` 显示 ` M`/`??`。Edit 报成功不等于落盘，Grep/grep 命中可能是缓存假象 —— 本仓已反复踩中`git grep` 返 0 命中而文件真实存在的情况，**核实符号位置必须用 python 直读**。
- **提交方式**：主仓有并行窗口 ⇒ `git commit -o <path>` 逐文件提交，不许 `git add -A`。
- **本PR 必然触发完整 CI**：`ci.yml` 的 `paths-ignore` 只挂在 `push` 事件，`pull_request:` 分支无任何 paths 过滤 ⇒ 纯文档 PR 照跑三个 required check。这是正确行为，耐心盯，不要误判为异常。

---

## Review Focus

规格暗示但没有任何测试能覆盖、且最可能咬人的五类输入：

1. **读者按 push 的心智模型理解 CI**：读到「`ci.yml` 有 `paths-ignore: ["**/*.md","docs/**"]`」就推断纯文档 PR 不跑 CI，从而跳过盯CI —— 这是本次 P0 错误本身。缓解：新节必须显式区分 push 与 pull_request 两个事件。
2. **改了 `services/pi-runtime/**`、`skills/**`、`vendor/**` 后以为合并即上线**：`runtime-deploy.yml` 是纯 `workflow_dispatch`，push 到 master 不会触发它 ⇒ 「CI 全绿但功能没上线」的静默失败。缓解：系统地图节必须把四条流水线的触发面列成表，并写明 tag = commit 短 SHA。
3. **新工具默认进延迟集**：漏问「哪个资产按名字点名了它」⇒ 模型按名直调延迟工具 ⇒ 吃 vendor 硬编码的 `Tool X is unavailable` 且**无恢复路径**（PR #100 生产实证）。缓解：影响面矩阵节必须把这条写成必答问题，并提示 `focus_node`（单数，常驻）≠ `focus_nodes`（复数，延迟）。
4. **加提示词规则漏同步第 5 处**：`renderStaticFallback()` 拼装顺序漏改⇒ 整段提示词静默消失**且无任何报错**。缓解：矩阵节列出 6 处同步点 + 同步判据。
5. **照抄文档里的事实性数字**：计数漂移已经发生 3 处（测试 97/176/26、ADR 0001-0008、superpowers 283）。缓解：全局约束禁止写易腐计数，且要给出获取命令。

---

## File Structure

| 文件 | 动作 | 责任 |
|---|---|---|
| `AGENTS.md` | 修改（+约 60 行 / 修 8 处） | 规范正文：新增 5 节，纠正 P0，修计数漂移与体例 |
| `.github/pull_request_template.md` | **新建**（约 45 行） | PR 四必填项 |
| `docs/README.md` | 修改（+2 行） | 登记新增内容与评审报告 |
| `docs/agents-md-review-2026-10-04.html` | 纳入版本控制（从工作区） | 评审结论资产入库（docs/README.md 记载的教训：结论资产必须入库） |

---

## Task 1: 纠正 P0 事实错误与计数漂移

**Files:**
- Modify: `AGENTS.md` —— 修 5 处，按内容定位（**不要用行号**，本任务自身改动会使行号漂移）：
  - `-内核：` → `- 内核：`（缺前导空格，列表项不渲染）
  - `- 载体` → `- 载体`（多余空格）
  - `>2026-10-03 清理：` → `> 2026-10-03 清理：`（引用块不生效）
  - CI 描述段（含 `paths-ignore` 那一行）—— P0 方向性错误
  - 测试文件计数段（`别抄本文档的旧数字` 紧邻的那行）
  - `adr/` 行（`0001-0008`）、`superpowers/` 行（`283 份`）
- Modify: `docs/adr/0009-vendor-capability-first.md:87`（错位章节名引用，**只改引用侧**）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: 后续 Task 2/3/4/5 依赖本任务确立的「不写易腐计数」规则与现有章节名（`## 端口约定` 等标题文本不得改动）

- [ ] **Step 1: 核实 4 处外部章节名引用的当前状态（留痕，供Step 6 比对）**

外部共有 4 处按章节名引用 AGENTS.md，**任何改动后都必须仍然有效**：

| 引用方 | 引用的章节名 |
|---|---|
| `docs/adr/0001-vendor-pi-as-kernel.md:47` | `pi 内核版本` |
| `docs/adr/0008-docs-index-over-doc-edits.md:38,64` | `文档管理规范` |
| `docs/adr/0009-vendor-capability-first.md:87` | `pi 内核开发纪律` ← **已知错位** |
| `charts/pi-lnk-runtime/README.md:9` | `端口表`（对应 `## 端口约定`） |

⚠️ 第四处现状：ADR-0009 引「pi 内核开发纪律」，而 AGENTS.md 实际标题是 `## ⭐ pi-runtime 开发纪律（吃满内核能力）`（「内核」vs「runtime」是既存错位）。本任务 Step 6 会修引用侧。

运行（**注意：`git grep` 在本仓对部分符号返 0 命中，必须用 python**）：

```bash
cd /Users/4seven/workspace/pi-lnk
python3 -c "
ag = open('AGENTS.md', encoding='utf-8').read()
for k in ['pi 内核版本', '文档管理规范', 'pi-runtime 开发纪律', '端口约定']:
    print(('OK   ' if k in ag else 'MISS '), k)
"
```

Expected: 四行全部 `OK`（第三行现在MISS 是已知的，Step 6 修引用侧使其一致）

- [ ] **Step 2: 修 Markdown 体例 3 处**

`AGENTS.md:11` 与 `AGENTS.md:12` 现状（前者缺前导空格导致列表项不渲染，后者多余空格）：

```
-内核：`@earendil-works/pi-agent-core`（版本见下节）
- 载体：画布（canvas）—— agent 的产出物是可交互的图，而非纯文本流
```

改为：

```
- 内核：`@earendil-works/pi-agent-core`（版本见下节）
- 载体：画布（canvas）—— agent 的产出物是可交互的图，而非纯文本流
```

`AGENTS.md:298` 现状：`>2026-10-03 清理：...`（缺前导空格导致引用块不生效）。改为 `> 2026-10-03 清理：...`。

- [ ] **Step 3: 纠正 P0 —— CI 描述必须区分 push 与 pull_request**

`AGENTS.md:44` 现状（**方向性错误**）：

```
- **push 到 master 没有新 run，先查 workflow 的 paths 过滤** —— `ci.yml` 有 `paths-ignore: ["**/*.md","docs/**"]`，`deploy.yml` 是 paths 白名单。**纯文档改动不触发 CI、不触发部署，零 workflow 是正确行为。**
```

改为：

```
- ⚠️ **CI 触发面分两个事件，别混** —— `ci.yml` 的 `paths-ignore: ["**/*.md","docs/**"]` **只挂在 `push` 事件上**；`pull_request:` 分支**没有任何 paths 过滤**。所以：push 到 master 时纯文档改动零 workflow（正确行为）；但**开 PR 时一律触发三个 required check**，纯文档 PR 也不例外。`deploy.yml` 是独立的 paths 白名单（server/web/packages/deploy/prompt-registry等）。
```

- [ ] **Step 4: 消除「自省句与抄写数字并存」的自相矛盾**

`AGENTS.md:159-160` 现状（**第 159 行说别抄旧数字，第 160 行紧接着就抄了**）：

```
> 测试文件规模会变，**要数字时实测 `find <dir> -name '*.test.ts' | wc -l`，别抄本文档的旧数字**。
> 2026-10-03 实测：server 97 / web 176 / pi-runtime 顶层 26 个测试文件。
```

改为（**删掉具体数字，只留获取命令**）：

```
> 测试文件规模会变，**要数字时实测 `find <dir> -name '*.test.ts' | wc -l`，别抄本文档的旧数字**。
> 本文档正文不写会漂移的计数（测试文件数、文档份数、清单长度）——需要规模感时给获取命令。
```

- [ ] **Step 5: 修ADR 与 superpowers 计数漂移**

`AGENTS.md:293` 现状：`| \`adr/\` | **架构决策记录**（0001-0008）—— ...`（实际已有 0009）。改为：

```
| `adr/` | **架构决策记录**（0001 起，最新编号见`docs/adr/`）—— 回答"为什么这么定"，Accepted 后不删不改，被取代则标 Superseded |
```

`AGENTS.md:294` 现状：`| \`superpowers/\` | 历史 spec 与 plan（283 份）。**从 \`INDEX.md\` 进**（...`（实测 288）。改为：

```
| `superpowers/` | 历史 spec 与 plan（数量以 `INDEX.md` 为准）。**从 `INDEX.md` 进**（按主题 + living/frozen/superseded 分类），不要直接翻目录 |
```

- [ ] **Step 6: 修ADR-0009 的错位章节名引用（引用侧，不动 AGENTS.md 标题）**

`docs/adr/0009-vendor-capability-first.md:87` 现状：`- 规范落地：\`AGENTS.md\`「pi 内核开发纪律」节`

实际章节名是 `## ⭐ pi-runtime 开发纪律（吃满内核能力）`。改为：

```
- 规范落地：`AGENTS.md`「pi-runtime 开发纪律」节
```

⚠️ 只改**引用侧**。AGENTS.md 标题里的 `⭐` 与副标题不动（改标题会扩大影响面，且本 PR 承诺不改现有章节名）。

- [ ] **Step 7: 复核落盘（不可跳过）**

```bash
cd /Users/4seven/workspace/pi-lnk
git status --short
```

Expected: ` M AGENTS.md` 与 ` M docs/adr/0009-vendor-capability-first.md`

再用 python 逐字复核 6 处改动全部生效（**不要信 grep**）。

⚠️ **按内容匹配，不要按行号** —— 本任务会改动多处，行号在改动后即位移，按行号取会误判：

```bash
python3 -c "
t = open('AGENTS.md', encoding='utf-8').read()
checks = [
  ('  内核：\`, 行首有空格', '- 内核：'),
  ('  载体 多余空格已去', chr(10) + '- 载体：'),
  ('  引用块空格已补', '> 2026-10-03 清理：'),
  ('  P0 push/pull_request 区分', '只挂在 \`push\` 事件上'),
  ('  pull_request 无过滤', 'pull_request:\` 分支**没有任何 paths 过滤'),
  ('  不写易腐计数', '本文档正文不写会漂移的计数'),
  ('  ADR 计数改为动态', '0001 起，最新编号见'),
  ('  superpowers 计数动态', '数量以 \`INDEX.md\` 为准'),
  ('  旧计数已清除', 'server 97' not in t and '283 份' not in t and '0001-0008' not in t),
]
for label, cond in checks:
    if isinstance(cond, bool):
        print(('OK   ' if cond else 'MISS '), label)
    else:
        print(('OK   ' if cond in t else 'MISS '), label)
adr = open('docs/adr/0009-vendor-capability-first.md', encoding='utf-8').read()
print(('OK   ' if '「pi-runtime 开发纪律」' in adr else 'MISS '), 'ADR-0009 引用已修')
print(('OK   ' if '「pi 内核开发纪律」' not in adr else 'MISS '), 'ADR-0009 旧引用已清')
"
```

Expected: 全部 `OK`，无 `MISS`

- [ ] **Step 8: 确认章节名未被破坏（防回归）**

```bash
cd /Users/4seven/workspace/pi-lnk
python3 -c "
ag = open('AGENTS.md', encoding='utf-8').read()
# 按标题文本匹配，不能用 '## '+裸名 —— 实际标题含 emoji 与副标题
# （真实例：'## ⭐ 分支纪律（最高优先级）'，不是 '## 分支纪律'）
heads = [l for l in ag.split(chr(10)) if l.startswith('## ')]
for k in ['分支纪律', '文档管理规范', 'pi 内核版本', '端口约定', '仓库结构', '必须先做的事', '核心 skill 路由', '本机环境']:
    print(('OK   ' if any(k in h for h in heads) else 'MISS '), k)
"
```

Expected: 八行全部 `OK` —— 这 8 个章节名是外部引用契约，改动后必须仍然存在

- [ ] **Step 9: 提交（逐文件，禁用 `git add -A`）**

```bash
cd /Users/4seven/workspace/pi-lnk
git add AGENTS.md
git commit -m "docs(agents): 纠正 CI 触发面描述错误 + 消除计数漂移

- 纠正 P0：ci.yml 的 paths-ignore 只挂 push，pull_request 无过滤
  （原文档称纯文档 PR 不触发 CI，实测三check 照跑）
- 消除「别抄旧数字」与紧邻抄写数字的自相矛盾
- ADR 计数 0001-0008 → 0001 起（实际已有 0009）
- superpowers 283 份 → 以 INDEX.md 为准（实测 288）
- 修 3 处 Markdown 体例：L11 缺前导空格、L12 多余空格、L298 引用块失效
- 修 ADR-0009 错位章节名引用（内核 → pi-runtime）

现有 8 个章节名一字未改，保住 4 处外部引用。"
git add docs/adr/0009-vendor-capability-first.md
git commit --amend --no-edit
```

⚠️ 用 `commit --amend` 而非第二次 `commit`，产出**单个**干净 commit。事后查证：`git show --stat --oneline HEAD | tail -3` 应见两个文件。

---

## Task 2: 新增「系统地图」与「你的角色与边界」

**Files:**
- Modify: `AGENTS.md`（在 `## 必须先做的事` 那一行之前插入两节；**用标题文本定位，不要用行号** —— Task 1 已改动过多处，行号会漂移）
- Modify: `AGENTS.md:328-334`（`## 必须先做的事` 顺延）

**Interfaces:**
- Consumes: Task 1 确立的「不写易腐计数」规则
- Produces: 两节新章节 `## 系统地图`、`## 你的角色与边界`。后续 Task 3 的影响面矩阵引用「系统地图」的流水线表

- [ ] **Step 1: 在 `## 必须先做的事` 之前插入两节**

定位锚点：`## 必须先做的事`。用 python 找到它的**确切行号**再插入（不要相信任何预先算好的行号）：

```bash
cd /Users/4seven/workspace/pi-lnk
python3 -c "
lines = open('AGENTS.md', encoding='utf-8').read().split(chr(10))
for i, l in enumerate(lines, 1):
    if l.startswith('## ') and '必须先做的事' in l:
        print('锚点行号 =', i, '|', l)
"
```

在它**之前**插入以下内容。

**⚠️ 插入内容中的事实全部已核实，不得凭印象改**：四条流水线触发面来自 `.github/workflows/` 实测；端口来自 `charts/pi-lnk-runtime/values.yaml`；数据流来自部署链路实测。

```markdown
## 系统地图

改之前先知道东西在哪、改哪层会走哪条流水线。**这一节的所有事实都经实测核实，改动时先复核。**

### 请求链路

```
浏览器 → nginx(:8888) → Nest apps/server(:5100) → pi-runtime(K3s NodePort 30100，外网不可达)
        → vendor pi(services/pi-runtime) → 上游模型
```

- `AGNES_MODEL_ID` 线上是**空串**（`??` 不兜底）⇒ LLM 实际靠 BYOK 注入
- 生产库是 **SQLite**；`/opt/lnkpi/.env` 是维护态止血开关（改 `PI_RUNTIME_MODE` + `compose up -d --force-recreate api`）
- **画布 SSOT 在前端**（`saveCanvas` 整份覆盖）；`add_node` 有**两份 applier 必须同步**
- 前端**无 CSP**（`nginx.conf` 无该头）⇒ iframe sandbox 配错没有第二道防线

### 四条流水线的触发面（改哪层走哪条）

| workflow | 触发条件 | 覆盖 |
|---|---|---|
| `ci.yml` | `push`(master) 走 paths-ignore；**`pull_request` 无任何 paths 过滤** | 全仓构建 + 测试 |
| `deploy.yml` | `push`(master) + paths 白名单：server / web / packages / deploy / prompt-registry / package.json / pnpm-lock / pnpm-workspace / .dockerignore / 自身 | api + web |
| `runtime-deploy.yml` | **纯 `workflow_dispatch`，无 push 触发** | pi-runtime |
| `prompt-lint.yml` | paths 触发：`prompt-registry/**`、`prompt-registry.*`、`prompt-lint.ts` | 提示词门禁 |

⚠️ **最容易踩的静默失败**：改 `services/pi-runtime/**`、`skills/**`、`vendor/**` 后 push 到 master，
`runtime-deploy.yml` **不会自动跑** —— CI 全绿但线上没有任何变化。
这三类改动合并后必须手工发一次，且 **tag = master 的 commit 短 SHA**（非语义版号）。

## 你的角色与边界

**关于「身份」的一句说明**：本文件不定义人格（沟通语气、主动性偏好）——那属于宿主层配置，
换模型/换宿主即失效且无法验证。这里只定义**你能做什么、什么必须先问人**，因为这部分与仓库强绑定。

### 必须先问人的红线

以下操作**一律先向人确认**，不要自行执行：

1. 动 `apps/server/prisma/schema.prisma` 或任何数据迁移
2. 动积分 / 扣分 / 退款逻辑
3. 改 `prompt-registry` 预算（L6 上限 3200 字符，当前余量约 320）
4. 任何生产止血操作：改 `PI_RUNTIME_MODE`、改 helm values、重发镜像 tag
5. 向 master 直接提交

### 可自主决定的范围

以下可以自己决定，不必打断人：单文件改动、加测试、写文档、跑只读命令、
修typo、改注释与格式化。前提是改动不触及上面的红线，且落在 DoD 的自检范围内。

### 越界信号

**「我不确定这条规则是否适用」⇒ 停下问，不要猜。**

这一条是本节最重要的。以下情形都适用它：
- 引用文档里的事实性数字前**先实测**（本文档不写会漂移的计数）
- 改动跨越了本文档没覆盖的层
- 需要绕过某条规则才能往下做

猜错的代价远高于问一句的代价。核实成本也就一条命令。
```

- [ ] **Step 2: 复核落盘 + 确认未破坏既有章节**

```bash
cd /Users/4seven/workspace/pi-lnk
python3 -c "
t = open('AGENTS.md', encoding='utf-8').read()
for k in ['## 系统地图', '## 你的角色与边界', '## 必须先做的事', 'NodePort 30100', '纯 \`workflow_dispatch\`，无 push 触发', 'tag = master 的 commit 短 SHA', 'AGNES_MODEL_ID']:
    print(('OK   ' if k in t else 'MISS '), k)
print('总行数', t.count(chr(10))+1)
"
git status --short
```

Expected: 七行全部 `OK`；`git status` 显示 ` M AGENTS.md`

- [ ] **Step 3: 提交**

```bash
cd /Users/4seven/workspace/pi-lnk
git add AGENTS.md
git commit -m "docs(agents): 新增系统地图与角色边界两节

系统地图：请求链路 + 四条流水线触发面对照表。
角色边界：红线清单（先问人）/ 自主范围 / 越界信号。
不定义人格 —— 人设属宿主层，与仓库强绑定的权限边界才写进来。
记录最容易踩的静默失败：改 pi-runtime/skills/vendor 后
runtime-deploy 不自动触发，CI 全绿但线上无变化。"
```

---

## Task 3: 新增「变更影响面矩阵」

**Files:**
- Modify: `AGENTS.md`（在 `## 端口约定` 那一行之前插入；**用标题文本定位，不要用行号**）

**Interfaces:**
- Consumes: Task 2 的「系统地图」流水线表
- Produces: 新章节 `## 变更影响面矩阵`

- [ ] **Step 1: 核实符号归属（写矩阵前必做，本仓`git grep` 对这些符号返 0 命中）**

```bash
cd /Users/4seven/workspace/pi-lnk
python3 -c "
import subprocess
files = [f for f in subprocess.run(['git','ls-files'],capture_output=True,text=True).stdout.split(chr(10))
         if f and ('apps/' in f or 'packages/' in f or 'scripts/' in f) and f.endswith(('.ts','.yaml'))]
for pat in ['COMPOSED_IDS','FALLBACK_BY_ID','renderStaticFallback','contentHash']:
    hits = [f for f in files if pat in open(f,encoding='utf-8',errors='ignore').read()]
    print(pat, '→', len(hits), '文件')
    for h in hits: print('   ', h)
"
```

Expected: 每个符号至少1 个文件命中。**若返 0 命中但你确信存在，以 python 结果为准**（本仓已知假阴性）

- [ ] **Step 2: 插入影响面矩阵节**

定位锚点：`## 端口约定`。用 python 确认锚点（Task 1/2 已改动过多处，**任何预先算好的行号都已失效**）：

```bash
cd /Users/4seven/workspace/pi-lnk
python3 -c "
lines = open('AGENTS.md', encoding='utf-8').read().split(chr(10))
for i, l in enumerate(lines, 1):
    if l.startswith('## ') and '端口约定' in l:
        print('锚点行号 =', i, '|', l)
"
```

在它**之前**插入：

```markdown
## 变更影响面矩阵

**改什么会静默坏掉。** 下表是踩过的坑，每一行都在生产或PR 里付出过代价。

### 改提示词规则 ⇒ 同步 6 处，漏一处就静默

| # | 位置 | 漏掉的后果 |
|---|---|---|
| 1 | `prompt-registry/rules/<id>.md` | 规则不存在 |
| 2 | `prompt-registry/MANIFEST.yaml`（`contentHash` = `sha256(body.trimEnd())` 前 12 位；`version` 两处一致） | 完整性校验失败 |
| 3 | `prompt-registry.loader.ts` 的 `COMPOSED_IDS` | 不参与组合 |
| 4 | `prompt-registry.loader.ts` 的 `FALLBACK_BY_ID` 映射（仅此一处定义） | 降级路径与实际规则不一致 |
| 5 | 🔴 `pi-prompt-assembler.service.ts` 的 `renderStaticFallback()` **拼装顺序** | **整段提示词静默消失，且无任何报错** |
| 6 | 🟡 `pi-prompt-assembler.service.test.ts` 的 `EXPECTED` 硬编码串 | 测试假绿 |

**同步判据**：「磁盘 renderStatic == 内嵌 renderStaticFallback」四组合**逐字符相等**。

⚠️ `renderStaticFallback` 在三个文件都出现（assembler / loader / agent.controller），
第5 处指的是**内嵌 fallback 的那一处**。
⚠️ `FALLBACK_BY_ID` 只在 loader 定义，`prompt-registry.fallback.ts` 里没有同名符号 ——
它靠**内容逐字相等**被约束，不是靠常量名对齐。
⚠️ 本仓`git grep` 对上述符号**会返 0 命中**（已知假阴性）。核实位置用 python 直读。

改完跑 `pnpm prompt:lint`（独立成 `prompt-lint.yml` 流水线，`ci.yml` 不覆盖它）。

⚠️ **L6 预算上限 3200 字符**，当前余量约 320 ≈ 还能加 4 条中等规则。加规则前先想清楚值不值。

### 改工具分层 ⇒ 必答「哪个资产点名了它」

**新增工具默认进延迟集前，必须回答：`prompt-registry` 规则或 `skills/*.md` 里，哪个资产按名字点名了它？**
答不上来按「未点名」处理 ⇒ 必须常驻。

机理：`drive/tools.ts:686` 只把 `activeToolNames` 传给 `prepareToolCall`，
未激活的工具吃vendor 硬编码的 `Tool X is unavailable`，**没有恢复路径**。

生产证据（PR #100）：40 次工具调用全落常驻集，`tool_search_activated_total` 为 0
⇒ 官方 Dynamic Tool Loading 触发率至今为 0。

⚠️ 已因此回归常驻：`arrange_nodes` / `set_node_generation_params` / `save_memory` / `focus_node` / `remove_edges`。
**`focus_node`（单数，常驻）≠ `focus_nodes`（复数，延迟）** —— 只差一个字母，极易踩错。

新增或变更工具须在 `services/pi-runtime/src/tools/tiering.test.ts` 显式声明归属。

### 改 vendor 消费 ⇒ 认清层次边界

`pi.on` / `pi.registerTool` / `registerCommand` / `ui.*` **全属 `pi-coding-agent`**
（交互式终端宿主，本项目**未依赖**）。`interface ExtensionAPI` 唯一实现在
`coding-agent/src/core/extensions/types.ts`。

⇒ `docs/extensions.md` 是扩展面**全景**，**不是agent-core 能力清单**。
我们的事件源本来就是 vendor 的 `harness.events.on`（`session-manager.ts` 的 `attachEvents`）。

`vendor/` 目录**禁止业务 patch**（只允许记录版本与来源），否则 upmerge 时无法与上游对齐。
```

- [ ] **Step 3: 复核落盘**

```bash
cd /Users/4seven/workspace/pi-lnk
python3 -c "
t = open('AGENTS.md', encoding='utf-8').read()
for k in ['## 变更影响面矩阵', '## 端口约定', '同步 6 处', 'renderStaticFallback', '哪个资产点名了它', 'focus_node\`（单数，常驻）', 'pi-coding-agent', 'git grep\` 对上述符号']:
    print(('OK   ' if k in t else 'MISS '), k)
print('总行数', t.count(chr(10))+1)
"
git status --short
```

Expected: 八行全部 `OK`

- [ ] **Step 4: 提交**

```bash
cd /Users/4seven/workspace/pi-lnk
git add AGENTS.md
git commit -m "docs(agents): 新增变更影响面矩阵

三张表覆盖最易静默损坏的改动类型：
- 提示词规则：加规则须同步 6 处，第 5 处漏改整段提示词静默消失
- 工具分层：必答「哪个资产点名了它」，未激活工具无恢复路径
- vendor 消费：pi.on 等属 coding-agent 非 agent-core，别当能力清单"
```

---

## Task 4: 新增「完成定义（DoD）」与「PR 规范」

**Files:**
- Modify: `AGENTS.md`（在 `## 本机环境` 那一行之前插入两节；**用标题文本定位，不要用行号**）
- Create: `.github/pull_request_template.md`

**Interfaces:**
- Consumes: Task 2 的系统地图、Task 3 的影响面矩阵
- Produces: `## 完成定义（提交前自检）`、`.github/pull_request_template.md`

- [ ] **Step 1: 插入 DoD 与 PR 规范两节**

定位锚点：`## 本机环境`。用 python 确认锚点（前面任务已改动过多处，**任何预先算好的行号都已失效**）：

```bash
cd /Users/4seven/workspace/pi-lnk
python3 -c "
lines = open('AGENTS.md', encoding='utf-8').read().split(chr(10))
for i, l in enumerate(lines, 1):
    if l.startswith('## ') and '本机环境' in l:
        print('锚点行号 =', i, '|', l)
"
```

在它**之前**插入：

```markdown
## 完成定义（提交前自检）

**全部是可执行命令，不是原则性表述。**

### 提交前必跑

| # | 命令 | 为什么 |
|---|---|---|
| 1 | `pnpm -r build` | **vitest 绿 ≠ tsc 绿**（esbuild 只转译）；web 走 `vue-tsc -b` |
| 2 | `pnpm test:server:changed` / `pnpm test:runtime` | 默认只跑变更相关；全量是 CI 的活 |
| 3 | 引用了文档里的事实性数字 ⇒ **先实测再写** | 见「越界信号」 |
| 4 | 改 `prompt-registry/**` ⇒ `pnpm prompt:lint` | 门禁独立于 `ci.yml` |
| 5 | 改 `vendor/` ⇒ 确认**零业务 patch** | 否则 upmerge 无法与上游对齐 |

### 合并前必看

- `gh pr view <n> --json mergeStateStatus` —— `BLOCKED` = required check 未过，**GitHub 不允许绕过**
- required checks = `["Verify spec figures", "Build monorepo", "Build API Docker image"]`
- ⚠️ **`Test Files N passed` ≠ CI 会绿**：必须同看 `Errors N errors` 与末尾 `Exit status`。
  实测180 files / 1449 tests 全 passed 但 `Errors 11` ⇒ exit 1
- ⚠️ **CI 全量测试不在独立 job**：`pnpm test` 是 `Build monorepo` 内的一个 step，
  `gh pr checks` 看不到它，须下钻：
  `gh run view <id> --json jobs --jq '.jobs[].steps[]|"\(.name) :: \(.conclusion)"'`

### 合并后（上线验证）

- 改 pi-runtime / skills / vendor ⇒ **必须手工发 `runtime-deploy.yml`**（见「系统地图」）
- pi-runtime tag = master 的 commit 短 SHA
- 生产取证：curl 免鉴端点比数量/字符数，或容器内 `require(dist/...)` 读真值
- ⚠️ **别只看 workflow 绿了就 assume 已上线**

## PR 规范

四个**必填项**，缺任一项评审人有权打回。模板见 `.github/pull_request_template.md`。

| 项 | 要求 | 拦的是什么 |
|---|---|---|
| **变更动机** | 解决什么问题，一两句 | 防止「顺手改」混入 |
| **影响面** | 哪几层 / 哪几个端点 / 是否改提示词或工具分层 | 评审人不知道该看哪 |
| **验证证据** | 跑了什么命令、看到什么输出 | 防止「跑过了」当证据 |
| **是否需手工发 runtime 流水线** | 是 / 否 + tag | 防止「CI 绿了但没上线」的静默失败 |
```

- [ ] **Step 2: 新建 PR 模板**

```bash
cd /Users/4seven/workspace/pi-lnk
cat > .github/pull_request_template.md << 'TEMPLATE_EOF'
## 变更动机

<!-- 解决什么问题，一两句。 -->

## 影响面

<!-- 勾选并补充：

- [ ] 改前端（apps/web）—— 画布渲染 / 交互
- [ ] 改后端（apps/server）—— API / 数据层
- [ ] 改pi-runtime（services/pi-runtime）—— agent 运行时
- [ ] 改packages/
- [ ] 改了 prompt-registry 规则（⇒ 须同步 6 处，见 AGENTS.md）
- [ ] 改了工具分层（⇒ 须回答「哪个资产点名了它」，见 AGENTS.md）
- [ ] 改了 vendor/（⇒ 须确认零业务 patch）
- [ ] 改了对外契约（docs/workflow/）
-->

## 验证证据

<!-- 跑了什么命令、看到什么输出。不要只写「跑过了」。

- 命令：
- 关键输出：
-->

## 是否需手工发 runtime 流水线

<!-- 合并后 pi-runtime 不会自动部署，需手工发 workflow_dispatch。

- [ ] 不需要（本次未改 services/pi-runtime/ 、 skills/ 、 vendor/）
- [ ] 需要 —— tag: `<master commit 短 SHA>`

⚠️ 改了这三类路径而勾「不需要」＝ 功能不会上线。详见 AGENTS.md「系统地图」。
-->

## 红线确认

- [ ] 未动 schema / 数据迁移
- [ ] 未动积分 / 扣分 / 退款逻辑
- [ ] 未动 prompt-registry 预算
- [ ] 未向 master 直接提交
TEMPLATE_EOF
```

- [ ] **Step 3: 复核两份文件落盘**

```bash
cd /Users/4seven/workspace/pi-lnk
python3 -c "
t = open('AGENTS.md', encoding='utf-8').read()
for k in ['## 完成定义（提交前自检）', '## PR 规范', '## 本机环境', 'gh pr view <n> --json mergeStateStatus', 'Errors N errors', '.github/pull_request_template.md']:
    print(('OK   ' if k in t else 'MISS '), k)
p = open('.github/pull_request_template.md', encoding='utf-8').read()
for k in ['## 变更动机', '## 影响面', '## 验证证据', '## 是否需手工发 runtime 流水线', '## 红线确认', 'commit 短 SHA']:
    print(('OK   ' if k in p else 'MISS '), 'PR模板:', k)
print('模板行数', p.count(chr(10))+1)
"
git status --short
```

Expected: 六行 + 六行全部 `OK`；`git status` 显示 ` M AGENTS.md` 与 `?? .github/`

- [ ] **Step 4: 提交**

```bash
cd /Users/4seven/workspace/pi-lnk
git add AGENTS.md .github/pull_request_template.md
git commit -m "docs(agents): 新增完成定义（DoD）与 PR 规范

DoD 全部给可执行命令：提交前必跑 5 项、合并前必看 mergeState、
合并后上线验证（含 runtime 流水线手工发）。
PR 规范四个必填项，其中「是否需手工发 runtime」拦住
「CI 全绿但功能没上线」的静默失败。
附 .github/pull_request_template.md 模板。"
```

---

## Task 5: 文档登记、评审报告入库与最终验收

**Files:**
- Modify: `docs/README.md`（登记新增内容）
- Create（纳入版本控制）: `docs/agents-md-review-2026-10-04.html`

**Interfaces:**
- Consumes: Task 1-4 的全部产出
- Produces: PR 描述所需的验收结论

- [ ] **Step 1: 在 `docs/README.md` 登记**

在「## 保留的目录」表格**之前**插入一节：

```markdown
## Agent 工程规范（2026-10-04 整改）

| 文件 | 内容 | 性质 |
|---|---|---|
| [`../AGENTS.md`](../AGENTS.md) | **agent 在本仓库工作的唯一权威规范** —— 新增系统地图、角色边界、变更影响面矩阵、完成定义（DoD）、PR 规范5 节；纠正 CI 触发面描述错误；计数改为可实测获取 | 活资产 —— **每次改动需回代码核实**，见文末元纪律 |
| [`superpowers/specs/2026-10-04-agents-md-hardening-design.md`](./superpowers/specs/2026-10-04-agents-md-hardening-design.md) | 本次整改的设计规格（含身份三层归属的决策依据） | 活资产 |
| [`superpowers/plans/2026-10-04-agents-md-hardening.md`](./superpowers/plans/2026-10-04-agents-md-hardening.md) | 实施计划 | 活资产 |
| [`agents-md-review-2026-10-04.html`](./agents-md-review-2026-10-04.html) | AGENTS.md 评审报告（7 维度评分 + P0/P1/P2 问题清单），基线 `352b44f` | 活资产 —— **结论资产，已入库**（教训见下） |

⚠️ **本节的存在理由**：同目录的两份提示词审计 HTML 曾一度丢失（未跟踪文件被 `git stash -u`
打进 stash 后该 stash 被 drop），只存在于悬空对象里，靠 `git fsck --lost-found` 捞回。
**审计/评审报告这类"结论资产"必须入库，不能只放工作区。** 本次评审报告从创建起即为 tracked。

**外部引用契约**：`AGENTS.md` 的以下 8 个章节名被 ADR 与 charts README 按名引用，
**改动时必须保持标题文本不变**：
`分支纪律` / `文档管理规范` / `pi 内核版本` / `端口约定` / `仓库结构` /
`必须先做的事` / `核心 skill 路由` / `本机环境`

引用方：`adr/0001`（pi 内核版本）、`adr/0008`（文档管理规范）、
`adr/0009`（pi-runtime 开发纪律）、`charts/pi-lnk-runtime/README.md`（端口表）。
```

- [ ] **Step 2: 验收全量复核（一次跑完，7 条判据）**

```bash
cd /Users/4seven/workspace/pi-lnk
python3 -c "
ag = open('AGENTS.md', encoding='utf-8').read()
ok = True
def chk(cond, label):
    global ok
    print(('PASS ' if cond else 'FAIL '), label)
    if not cond: ok = False

# 判据 1：CI 描述已纠正
chk('只挂在 \`push\` 事件上' in ag and 'pull_request:\` 分支**没有任何 paths 过滤' in ag, '判据1 CI 描述区分 push/pull_request')
# 判据 2：四个 workflow 全列出
for w in ['ci.yml', 'deploy.yml', 'runtime-deploy.yml', 'prompt-lint.yml']:
    chk(w in ag, f'判据2 列出 {w}')
# 判据 3：无易腐计数
import re
chk('server 97' not in ag and '283 份' not in ag and '0001-0008' not in ag, '判据3 无易腐计数')
chk('别抄本文档的旧数字' in ag, '判据3 保留实测命令')
# 判据 4/5：ADR 与 charts 引用未失效
for k in ['pi 内核版本', '文档管理规范', 'pi-runtime 开发纪律', '端口约定']:
    chk(k in ag, f'判据5 章节名「{k}」仍在')
adr9 = open('docs/adr/0009-vendor-capability-first.md', encoding='utf-8').read()
chk('「pi-runtime 开发纪律」' in adr9, '判据4 ADR-0009 引用已修')
# 判据 6：PR 模板
import os
chk(os.path.exists('.github/pull_request_template.md'), '判据6 PR 模板存在')
p = open('.github/pull_request_template.md', encoding='utf-8').read()
for k in ['## 变更动机', '## 影响面', '## 验证证据', '## 是否需手工发 runtime 流水线']:
    chk(k in p, f'判据6 模板含 {k}')
# 判据 7：零代码变更
import subprocess
d = subprocess.run(['git','diff','--name-only','origin/master...HEAD'], capture_output=True, text=True).stdout.split()
allowed = {'AGENTS.md', 'docs/README.md', 'docs/adr/0009-vendor-capability-first.md',
           '.github/pull_request_template.md', 'docs/agents-md-review-2026-10-04.html',
           'docs/superpowers/specs/2026-10-04-agents-md-hardening-design.md',
           'docs/superpowers/plans/2026-10-04-agents-md-hardening.md'}
bad = [f for f in d if f not in allowed]
chk(not bad, f'判据7 零代码变更（越界文件: {bad}）')
# 8 个受保护章节名
heads = [l for l in ag.split(chr(10)) if l.startswith('## ')]
for k in ['分支纪律', 'pi 内核版本', '端口约定', '仓库结构', '必须先做的事', '核心 skill 路由', '本机环境', '文档管理规范']:
    chk(any(k in h for h in heads), f'保护章节名 {k}')
print()
print('AGENTS.md 总行数', ag.count(chr(10))+1)
print('=== 全部通过 ===' if ok else '=== 有 FAIL，需修复 ===')
"
```

Expected: 全部 `PASS`，末行 `=== 全部通过 ===`；AGENTS.md 行数约 420

- [ ] **Step 3: 确认评审报告已入库**

```bash
cd /Users/4seven/workspace/pi-lnk
git add docs/README.md
git add docs/agents-md-review-2026-10-04.html
git add docs/superpowers/specs/2026-10-04-agents-md-hardening-design.md
git add docs/superpowers/plans/2026-10-04-agents-md-hardening.md
git commit -m "docs(agents): 登记Agent 工程规范 + 评审报告入库

docs/README.md 新增「Agent 工程规范」节，登记 AGENTS.md 五个新节、
本次规格与计划、以及评审报告。

同时记录「外部引用契约」：AGENTS.md 的 8 个章节名被 ADR 与charts README
按名引用，改动时必须保持标题文本不变。

评审报告从创建起即为 tracked —— 同类 HTML 审计报告曾因未跟踪
而丢失（被 stash 后 drop，只剩悬空对象）。"
git status --short
```

Expected: 工作区干净（无输出）

- [ ] **Step 4: 交付前最终复核**

```bash
cd /Users/4seven/workspace/pi-lnk
git show --stat --oneline HEAD~4..HEAD
```

Expected: 4 个 commit，文件集合恰为 § 允许清单

---

## 执行注意事项

1. **本 PR 必然触发完整 CI**：`ci.yml` 的 `paths-ignore` 只挂 push，`pull_request:` 无过滤 ⇒
   纯文档 PR 照跑三个 required check。**这是正确行为，不要误判为异常。**
2. **盯 CI 时用 `headRefOid` 的 40 位 SHA** 查 check-runs（分支名含斜杠会静默返空数组），
   数量用 `--jq '.total_count'`，**不能用 `length`**。
3. **轮询终止条件**：必须同时满足「无 running 状态」**且**「拿到非空结论串」。
4. **合并前必读 `mergeStateStatus`**：`BLOCKED` 意味着 GitHub 不允许绕过。
5. **合并用 `--squash`，不加 `--delete-branch`**（master 被主仓 worktree 占用会报错）。
6. **纯文档 PR 不触发部署**（`deploy.yml` 是 paths 白名单，不含 `**/*.md`）⇒
   合并后**无需**盯部署、**无需**做生产取证。这是正确行为。
7. **收尾清理**：合并后当场清 worktree 与分支（顺序：worktree → 本地分支 → 远程分支），
   删前先 `git -C .worktrees/<slug> status --porcelain` 确认无未提交改动。
8. **`pnpm -r build` 不需要跑** —— 本 PR 零代码变更，但 `ci.yml` 的 `Build monorepo`
   仍会跑全仓构建，那是 CI 的事，本地不必重复。
