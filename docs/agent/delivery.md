# 交付流程规范

分支纪律 · 本地测试纪律 · 完成定义 · PR 规范。

> 属于 [`AGENTS.md`](../../AGENTS.md) 规范体系的一部分。主文件见「完成定义」与「你的角色与边界」。

## ⭐ 分支纪律（最高优先级）

**铁律：master 永远等于 origin/master，任何改动（含 `docs/`）不得直接提交到 master。**

**七步流程，一步都不能省：**

| # | 步骤 | 命令 / 判据 |
|---|---|---|
| 1 | **开分支**（发现要改的第一刻就开，别写完代码才开） | `git fetch origin && git worktree add .worktrees/<slug> -b <type>/<slug> origin/master` |
| 2 | 开发 | 在 worktree 里改；首次跑测试前 `pnpm install --frozen-lockfile` + `pnpm --filter @lnkpi/server exec prisma generate` |
| 3 | 提交 | 分支内 `git add` + `git commit`，message 用 `feat/fix/docs/ci(scope): 描述` |
| 4 | 推 + 开 PR | `git push -u origin <branch>` → `gh pr create --body-file <file>` |
| 5 | **盯 CI 到全绿** | `gh pr checks <n>` 全 pass；合并前先查有无在跑的 workflow（会互相挤掉） |
| 6 | **squash 合并** | `gh pr merge <n> --squash`（不加 `--delete-branch`，master 被主仓 worktree 占用会报错） |
| 7 | **盯部署 + 上线生产验证** | 见 `prod-deploy-verify` skill（**四条流水线** + 生产取证全套，触发面见 `AGENTS.md`「系统地图」） |

**自检判据**（任何时候都应成立）：

```bash
git rev-list --count origin/master..master   # 必须 0
git rev-list --count master..origin/master   # 必须 0
```

**主仓（master 工作区）只做拉取/查看/开分支起点，不改代码不提交。**

三个高频踩坑（详见 `prod-deploy-verify` 与 `branch-first-dev-workflow` skill）：

- **判定分支是否已合并禁用 `git cherry` / `git rev-list --count`** —— squash 会重写 commit、patch-id 对不上，已合分支会被误报成「未合并」。权威判据：`gh pr list --head <b>` 拿 mergeCommit，再 `git merge-base --is-ancestor <sha> origin/master`。
- **查 check-run 数量用 `--jq '.total_count'`，不能用 `length`** —— 后者把 JSON 对象的 key 当数组元素数，`{"total_count":0,...}` 会返回 2，把「CI 从未触发」误判成「在跑」。
- ⚠️ **CI 触发面分两个事件，别混** —— `ci.yml` 的 `paths-ignore: ["**/*.md","docs/**"]` **只挂在 `push` 事件上**；`pull_request:` 分支**没有任何 paths 过滤**。所以：push 到 master 时纯文档改动零 workflow（正确行为）；但**开 PR 时一律触发三个 required check**，纯文档 PR 也不例外。`deploy.yml` 是独立的 paths 白名单（server / web / packages / deploy / prompt-registry 等）。

### 收尾清理（第7 步之后，别拖到下次）

合并完成后**当场清掉** worktree 与分支。累积起来会导致主仓状态混乱、`gh pr create` 在主仓执行报错、
worktree 抢占分支等问题（2026-10-03清理前累积到 26 个本地分支 / 21 个 worktree）。

**顺序：worktree → 本地分支 → 远程分支。**

```bash
# 0. 先体检：有未提交改动就别急着删
git -C .worktrees/<slug> status --porcelain
```

| 体检结果 | 判断与处置 |
|---|---|
| 有正在开发的改动 | **绝不删** —— 这是真活儿，保留 worktree |
| 有「PR 已合但文档没进 master」的未跟踪文件 | **备份后再删**（`cp` 到仓外目录），这是唯一副本 |
| 输出为空 | 可以删 |

```bash
# 1. 删 worktree（路径要用【绝对路径】，相对路径会报 not a working tree）
git worktree remove --force /abs/path/to/.worktrees/<slug>
git worktree prune

# 2. ⚠️ worktree 移除后磁盘目录仍在（每个 50M+，含 node_modules）
ls .worktrees/<slug> && rm -rf .worktrees/<slug>

# 3. 删本地 + 远程分支
git branch -D <slug>
git push origin --delete <slug>
```

**同步 master 后的两个必查项**（用 `git update-ref` 移动 HEAD 时尤其容易漏）：

```bash
git status --short              # 若出现 AD 状态（已add 删除但工作区又出现），说明 index 停在旧状态
git reset --mixed HEAD          # 修index（--mixed 不触发 unlink，比 --hard 安全）
rmdir docs/<已删目录>           # 清空后残留的空目录
```

> 合并后主仓的 index 不会自动跟随 `origin/master`，需显式 `git reset --mixed HEAD`。
> 若 `git reset --hard` 报 `unable to unlink old 'X': Operation not permitted`（本机对某些文件的
> unlink 有限制），改用逐文件 `git show origin/master:<path> > <path>` 覆写 +
> `git update-ref refs/heads/master <sha>`。

## 本地测试纪律（2026-09-29 定）

背景：本机是 **4 核 Mac** 且多 agent 并存，曾实测多窗口并跑全量测试把 load 打到 **21+**（超载 5 倍）。

1. **默认跑变更相关测试，不跑全量**：
   - server：`pnpm test:server:changed`（相对 origin/master 的变更用例）；聚焦时单文件 —— `pnpm --filter @lnkpi/server exec vitest run src/agent/<file>.test.ts`
   - pi-runtime：`pnpm test:runtime`；单文件 `node --import tsx --test src/<file>.test.ts`（在 `services/pi-runtime/` 下）
2. **全量 `pnpm test` 是 CI 的活**。位置：`ci.yml` 的 **`Build monorepo`** job → step `Unit and integration tests`（`ci.yml:74` 的 `pnpm test`）—— **不是**独立 test job。`gh pr checks` 只列 3 个 job（Verify spec figures / Build monorepo / Build API Docker image），看不到测试但它确实跑在里面，核实要下钻 step：
   ```
   gh run view <id> --json jobs --jq '.jobs[] | .name as $n | .steps[] | "\($n) :: \(.name) :: \(.conclusion)"'
   gh run view <id> --log | grep -E 'Test Files.*passed|# (tests|pass|fail) '
   ```
   本地确需全量时：
   - 先 `uptime` —— **load > 8 禁止起跑**
   - 同一时刻**全仓只允许一个全量**；server 全量必须带 `--hookTimeout=120000`（已知 flake）
3. **不要本机同时跑 server 与 pi-runtime 两套全量** —— 资源竞争会 SIGKILL(137)，出现假失败
4. vitest 本地已限 **2 fork**（`apps/server/vitest.config.ts`，CI 不限速）—— 给多 agent 并存留余量，不要调回去
5. worktree 首次跑测试前：`pnpm install --frozen-lockfile` + `pnpm --filter @lnkpi/server exec prisma generate`（否则 vitest 报 `.prisma/client` 缺失）

> 测试文件规模会变，**要数字时实测 `find <dir> -name '*.test.ts' | wc -l`，别抄本文档的旧数字**。
> 本文档正文不写会漂移的计数（测试文件数、文档份数、清单长度）——需要规模感时给获取命令。
> 这条规则由 `pnpm verify-claims` 机器校验（接在 `ci.yml` 的 `Verify spec figures` step）。
> ⚠️ 判据卡的是**类别**而非具体值 —— 早先的判据只检查几个已知旧值，
> 于是同一批任务里新写的 DoD 又引入了新的测试规模数字，判据照样通过。

## 判据必须能真的失败（2026-10-04 定，血泪）

本仓已多次出现「测试全绿但什么都没验」。以下六条是硬纪律，均来自真实事故。
适用面是**一切验收判据**——不限于测试，也包括一次性取证脚本与门禁。

**1. 验证脚本必须读被验证的对象，不能复刻一份逻辑。**

写一次性验证脚本时，最自然的做法是「把那段逻辑抄一份出来跑」——**这是无效验证**：
它跑的是自己的副本，把真源码改坏了它照样ALL PASS。
2026-10-04 实测：注入侧剔除的第一版取证脚本就是这样，
连续两轮 RED 取证**假绿**（改坏 `agent.service.ts` 的真逻辑，脚本仍报通过）。

正确做法：脚本从**真实源文件**抽取代码并执行（正则抽片段 → `new Function` 组装 → 跑）。
代价是脆（源码结构变了要跟着改），但至少「改坏 ⇒ 转红」成立。
若因脆而无法抽取，就**如实说没验**，别拿复刻脚本的绿灯当证据。

**2. 断言必须被证明「能因实现变更而转红」，否则它恒绿。**

写完测试要主动做一次**变异测试**：故意改坏实现，确认对应用例转红（并确认 exit≠0）。
没做变异测试的「通过」，只能说明「没发现会挂的写法」。

实例（2026-10-04 M6a 记忆剔除）：两条fail-open 断言经变异测试确认**真的能红**——
把 `isSuppressed` 硬化成 `if (!memoryId) return true`（把「无法判定」当成「已抑制」）
⇒ 用例「反哺：id 缺失时保留条目」转红、exit=1。
在此之前它们曾连续两轮**假绿**：当时断言写的是「给一条无 id 条目，断言它还在」，
而正确实现与「去掉短路」「底层改成 fail-closed」在该断言下**同值**（都保留）。

本仓测试文件**永不做类型检查**——`apps/server/tsconfig.json` 的 `exclude` 含
`src/**/*.test.ts`，`pnpm build`(tsc) 看不到它们，而 vitest 只转译不类型检查。
⇒ **类型标注不是防线**，`as never` / 结构化赋值会掩盖形状错误。

实例（2026-10-04 M6a）：`runMemoryInjection(items: unknown[], ...)` 收到裸对象，
tsc 本可报 TS2353，但因上述排除从不执行；运行时 `mem.items.filter` 抛 TypeError
又被 fail-soft `try/catch` 吞掉 ⇒ 断言以「剔除过度」的面貌失败，**错误信息把人指向错的代码方向**。
修法有两层，缺一不可：把入参改对 + 在 helper 里 `if (!Array.isArray(items)) throw`，
**让形状错误当场炸在 helper 里**，而不是变成下游的误导性红。

**3. 冗余的防御会伪装成「有测试保障」。**

两道等价防线（如`!it.id ||` 短路 + `Map.has(undefined)===false`）去掉任一道，另一道仍兜住 ⇒
针对它的测试**恒绿**。此时「有测试保障」这句话不成立，必须**分层断言**：
直接断言底层语义（如 `isSuppressed(undefined) === false`），再单独断言上层短路。
两个变异（去掉短路 / 把底层改成 fail-closed）都要能让它转红。

**4. 「全仓零命中」必须用python `os.walk` 复核。**

⚠️ 本仓的 `git grep` **只搜已跟踪文件**——新建但还没 `git add` 的文件对它完全不存在。
2026-10-04 实测：`memory-suppression.ts` 明明在工作区里，
`git grep -c "isSuppressed" -- apps/server/src/agent/memory-suppression.ts` 返回 **exit=1**，
而同一符号在已跟踪的 `prompt-registry.loader.ts` 里能正常命中。
⇒ **刚写完的文件用 `git grep` 查，等于没查**：会把「我刚加的代码不见了」误报成事实。
任何「全仓零命中 / 某符号没有调用方」的结论，用 python `os.walk` 直读复核（注意排除
`.git` / `node_modules` / `dist`，否则会超时 SIGTERM）。

**5. 新增能力要「可被调用」，否则等于「有代码、无效果」。**

交付一个新 API（导出函数 / 指标 / 开关）时自查：**生产代码里真的有调用方吗？**
用上一条的 python `os.walk` 扫全仓确认，**并把定义处与调用处分开列**——
测试文件里的调用**不算**调用方。

若确实没有调用方（能力先建、接入后做），必须**在源码注释里写清三件事**，
否则后人看到代码会误以为它在工作：
1. 当前**无生产调用方**；
2. 归谁接（哪一期/哪个任务）；
3. **可观测的预期信号是什么**（例：某指标当前恒为 0，**这是预期状态不是故障**，
   且读数不能反推「没有问题存在」）。

⚠️ **不要为了让功能「看起来在工作」而加假调用方 / 测试专用入口挂到运行时路径上**——
那是给生产加一个没人用的开关，比「留空但写清楚」更糟：后者让人知道链路没通，
前者让人误以为已经在拦问题。

实例（2026-10-04 M6a 记忆反哺剔除）：`markSuppressed` 除测试外**零调用方**
（定义在 `apps/server/src/agent/memory-suppression.ts:56` 与
`services/pi-runtime/src/tools/memory.ts:75`），所以剔除逻辑虽经测试验证正确，
生产里**永不生效**；指标 `pi_runtime_memory_suppressed_total` 恒为 0 属预期，标记入口归 M6b。

**6. 退出码会被前一条命令污染。** `cmd | tail` 让 `$?` 变成 `tail` 的 0
（实测 `false | tail -1` 的 `$?` 是 0，`false` 单独跑是 1）。
每条验证命令单独跑、单独取退出码；本机 load 波动会 SIGTERM，
**被杀死≠ 通过**，必须区分「exit≠0 且有输出」与「被 SIGTERM 无输出」。

## 必须先做的事

- **动手前先读相关代码，不凭印象改。** 本仓库历史上多次因"凭印象画/写"被退回：
  漏画已存在的按钮、删掉代码里的默认态、线框与真实 chrome 不符。
- **改动落盘后必须逐项复核。** 可靠判据只有 `git status` 显示 ` M`/`??`；
  Edit/Write 报"成功"**不等于**落盘，Grep 命中可能是缓存假象。
- **分支上开发。** 见上方分支纪律。

## 核心 skill 路由

**第一层：`using-superpowers`（总入口，每个会话开始就该调用）**
它规定"有任何 skill 可能适用就必须先调用"、并给出优先级（process skill 先于 implementation skill）。
下面这些是它路由到的具体 skill：

| 场景 | skill |
|---|---|
| 创造性工作前 | `brainstorming` |
| bug / 异常 | `systematic-debugging` |
| 提交前 | `verification-before-completion` |
| 写实现计划 | `writing-plans` |
| 分支管理 | `using-git-worktrees` |
| **开发流程（七步）** | `branch-first-dev-workflow` |
| **合并后：盯 CI / 盯部署 / 生产取证** | `prod-deploy-verify` |

> `using-superpowers` 管**"该不该用 skill、按什么顺序用"**；
> `branch-first-dev-workflow` 管**"git 操作怎么走"**。两者不冲突，是不同维度。

## 完成定义（提交前自检）

**全部是可执行命令，不是原则性表述。**

### 提交前必跑

| # | 命令 | 为什么 |
|---|---|---|
| 1 | `pnpm -r build` | **vitest 绿 ≠ tsc 绿**（esbuild 只转译）；web 走 `vue-tsc -b` |
| 2 | `pnpm test:server:changed` / `pnpm test:runtime` | 默认只跑变更相关；全量是 CI 的活 |
| 3 | 引用了文档里的事实性数字 ⇒ **先实测再写** | 见 `AGENTS.md`「你的角色与边界 → 越界信号」 |
| 4 | 改 `prompt-registry/**` ⇒ `pnpm prompt:lint` | 门禁独立于 `ci.yml` |
| 5 | 改规范文件（`AGENTS.md` 或 `docs/agent/*.md`） ⇒ `pnpm verify-claims` | 机器校验规范体系的事实性断言（计数 / 章节名 / workflow 名 / pin 版本），已接进 `ci.yml` 的 `Verify spec figures` step |
| 6 | 改 `vendor/` ⇒ 确认**零业务 patch** | 否则 upmerge 无法与上游对齐 |

### 合并前必看

- `gh pr view <n> --json mergeStateStatus` —— `BLOCKED` = required check 未过，**GitHub 不允许绕过**
- required checks = `["Verify spec figures", "Build monorepo", "Build API Docker image"]`
- ⚠️ **`Test Files N passed` ≠ CI 会绿**：必须同看 `Errors N errors` 与末尾 `Exit status`。
  实测出现过全量测试「文件数/用例数全 passed」但 `Errors` 非零、最终 exit 1 的情况
  （未处理 rejection 会被 vitest 单独计入 `Errors`）
- ⚠️ **CI 全量测试不在独立 job**：`pnpm test` 是 `Build monorepo` 内的一个 step，
  `gh pr checks` 看不到它，须下钻：
  `gh run view <id> --json jobs --jq '.jobs[].steps[]|"\(.name) :: \(.conclusion)"'`

### 合并后（上线验证）

- 改 pi-runtime / skills / vendor ⇒ **必须手工发 `runtime-deploy.yml`**（见 `AGENTS.md`「系统地图」）
- pi-runtime tag = master 的 commit 短 SHA
- 生产取证：curl 免鉴端点比数量/字符数，或容器内 `require(dist/...)` 读真值
- ⚠️ **别只看 workflow 绿了就assume 已上线**

## PR 规范

四个**必填项**，缺任一项评审人有权打回。模板见 `.github/pull_request_template.md`。

| 项 | 要求 | 拦的是什么 |
|---|---|---|
| **变更动机** | 解决什么问题，一两句 | 防止「顺手改」混入 |
| **影响面** | 哪几层 / 哪几个端点 / 是否改提示词或工具分层 | 评审人不知道该看哪 |
| **验证证据** | 跑了什么命令、看到什么输出 | 防止「跑过了」当证据 |
| **是否需手工发 runtime 流水线** | 是 / 否 + tag | 防止「CI 绿了但没上线」的静默失败 |
