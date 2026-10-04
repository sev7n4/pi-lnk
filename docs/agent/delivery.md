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
