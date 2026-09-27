# RUNBOOK · lnkpi → pi-lnk 同步与发布门操作流

更新时间：2026-09-23。**本文件是「lnkpi 的改动怎么上生产」的唯一权威操作流**（暂不自动化，手工执行）。

> 背景与根因：[`POSTMORTEM-2026-09-23-deploy-overwrite.md`](./POSTMORTEM-2026-09-23-deploy-overwrite.md) ／ 图文版 [`.html`](./POSTMORTEM-2026-09-23-deploy-overwrite.html)
> 发布门落地与回滚：[`RUNBOOK-single-release-gate.md`](./RUNBOOK-single-release-gate.md)

---

## 1 · 前提认知（为什么必须手工走一次）

| 事实 | 说明 |
| --- | --- |
| 两个仓库是 fork 关系 | `/Users/4seven/workspace/lnkpi`（origin=lnkpi，日常画布主线）／`/Users/4seven/workspace/pi-lnk`（origin=pi-lnk，upstream=lnkpi） |
| 部署源永远是 **pi-lnk master** | `/opt/lnkpi` 只由 pi-lnk 的工作流同步 |
| lnkpi 的 `deploy-api` 已停用 | `30a3781e` 后 API 不再自动上线 → 后端改动必须走本流程 |
| lnkpi 只保留前端自动发版 | `deploy-web` 只写 `/opt/lnkpi/web/dist`，不碰源码树 |
| 同步命令流**暂不自动化** | 本文件即"命令存放处"，需要时照抄执行 |

## 2 · 什么时候要走

| 你改了什么 | 结果 |
| --- | --- |
| `apps/web/**` | lnkpi 合并 main 后**自动上线**（1–2 min），无需本流程 |
| `apps/server/**`、`packages/**` | **不自动上线** → 走本流程 |
| `deploy/**`、`**/Dockerfile` | **不自动上线** → 走本流程 |
| `services/pi-runtime/**`、`charts/**`、`vendor/**` | 走本流程 |
| `docs/**`、`*.md` | 不触发任何部署 |
| ~~`services/agent-runtime/**`~~ | **已于 2026-09-27 退役删除**（见 `RUNBOOK-old-runtime-retirement.md`）。lnkpi 侧若仍保留该目录，merge upstream 后需再删一次 |

## 3 · 命令流（逐条复制）

```bash
# ── A. lnkpi 侧：确认改动干净并推送
cd /Users/4seven/workspace/lnkpi
git status --short                    # 确认没夹带不该提交的文件
git push origin HEAD:main

# ── B. pi-lnk 侧：拉上游 + 合并（不自动提交）
cd /Users/4seven/workspace/pi-lnk
git fetch upstream
git checkout master && git pull origin master
git merge --no-commit upstream/main

# ── C. 【关键】保住 pi-lnk 自己的发布门工作流
#     lnkpi 的 deploy.yml 把 API 部署改成"仅手动 allow_api_deploy"（30a3781e）。
#     该文件若被 lnkpi 版覆盖，画布 API 就永远不会自动上线——静默废掉发布门。
git checkout HEAD -- .github/workflows/deploy.yml
git add .github/workflows/deploy.yml

# ── D. 合并结果自检（四条都要过）
git status --short | head -40
grep -n "branches:" .github/workflows/deploy.yml                        # 必须是 master
ls .github/workflows/                                                    # deploy-agent-runtime.yml 应不存在（老 runtime 已退役）
grep -c "allow_api_deploy" .github/workflows/deploy.yml     # 必须是 0（>0 = 被 lnkpi 版覆盖，回 C 步）
grep -n "B4 防呆检查" deploy/launch-cvm-build.sh            # 必须命中（发布门构建守卫在）

# ── E. 提交并推送（推送即触发发布门）
git commit -m "chore: sync upstream lnkpi main (<上游 sha>)"
git push origin master
```

**关于 `--ours`**：习惯写法是 `git checkout --ours <path>`，但它**只在路径处于冲突状态时**有效；若该路径被自动合并成功，`--ours` 会报 `error: path ... does not have our version`。用 `git checkout HEAD -- <path>` 更稳，语义就是"恢复 pi-lnk 合并前的版本"。

**真出现冲突时**（`git status` 里 `UU`）：`.github/workflows/*` 一律保 pi-lnk 版；业务代码保上游（lnkpi）版。

## 4 · 触发发布门

推 pi-lnk master 会自动触发（改动命中 `deploy.yml` 的 `paths`）。也可以手动：

```bash
gh api --method POST /repos/sev7n4/pi-lnk/actions/workflows/deploy.yml/dispatches \
  -f ref=master -f 'inputs[branch]=master'
```

耗时约 7–13 min。

## 5 · 触发后是"先判断"而不是直接发布

三层门控，**全自动、无人工审批**（两个仓库的 `production` environment 都没配 protection rules）：

1. **job 级 paths-filter**（`Detect changes`）→ API 侧没改时整个 `Build API on CVM` job 直接 skipped
2. **脚本级硬守卫** `deploy/launch-cvm-build.sh:9-19`（B4 防呆）→ 源码树缺 `PI_RUNTIME` 分流代码就拒绝构建
   ⚠️ 顺序：守卫在 `rm -rf packages apps/server` + 解包**之后**才跑 → 它失败时生产树已被换、但不会产出新镜像，旧容器继续服务（属"失败的失败"而非中断）
3. **部署后验收**：health（localhost + 公网）+ layout/graph smoke

> 需要"人工卡点"：给 `production` environment 配 required reviewers。当前没有 → 不会等你点批准。

## 6 · 验收三件套

```bash
ssh deploy-cvm 'docker ps --format "{{.Names}} {{.Image}}" | grep lnkpi-api'    # 镜像 tag = 本次提交 sha
ssh deploy-cvm 'docker exec lnkpi-api printenv PI_RUNTIME_MODE'                 # = active
cd /Users/4seven/workspace/pi-lnk && python3 deploy/prod-agent-thread-verify.py # PASS=16 FAIL=0
```

## 7 · 所有权边界（2026-09-23 收窄后）

| 路径 | 谁能写 | 说明 |
| --- | --- | --- |
| ~~`services/agent-runtime/**`~~ | — | **已退役删除**（2026-09-27）。⚠️ lnkpi 侧若仍存在，merge upstream 会被带回来，需重新删除 |
| `deploy/**`（compose、守卫脚本、verify 脚本） | **仅 pi-lnk 发布门** | lnkpi 侧改了必须走本流程；`deploy/docker-compose.prod.yml` 由 lnkpi 工作流的 Guard 步骤校验漂移（老 runtime 的 `Dockerfile.agent-runtime` / `enable-agent-runtime.sh` 已随退役删除） |
| `apps/server/**`、`packages/**` | **仅 pi-lnk 发布门** | B4 分流代码就在这里 |
| `apps/web/**` | lnkpi | 前端自动发版 |

lnkpi 的 `Deploy Agent Runtime` 收窄要点（历史）：
- `tar` 白名单化，只打包 `services/agent-runtime`（原实现打包整棵树并覆盖 `/opt/lnkpi`）
- 新增 `Guard: release-gate invariants` 步骤：校验 ① 生产树仍带 B4 分流 ② B4 构建守卫在位 ③ 发布门独占文件无漂移；任一不满足即**红灯并给出走发布门的指引**，不再静默覆盖

> ⚠️ 该工作流（`deploy-agent-runtime.yml`）与整个 `services/agent-runtime/` 已于 2026-09-27 退役删除；
> lnkpi 侧若仍保留，会继续尝试自动跑并可能把目录写回 `/opt/lnkpi`。上线前确认两侧一致。

## 8 · 回滚 / 止血

```bash
# ① 秒级止血（不依赖镜像）：active → shadow，用户侧零感知（走老 LangGraph 链路）
ssh deploy-cvm "cd /opt/lnkpi && sed -i 's/^PI_RUNTIME_MODE=.*/PI_RUNTIME_MODE=shadow/' .env && \
  export LNKPI_API_IMAGE=\$(docker inspect lnkpi-api --format '{{.Config.Image}}') && \
  docker compose -f deploy/docker-compose.prod.yml up -d --no-build --force-recreate api"

# ② 版本回退：用保留的历史镜像（≈1 MB 增量，秒级）
ssh deploy-cvm 'cat /opt/lnkpi/.last-api-image'
ssh deploy-cvm "cd /opt/lnkpi && LNKPI_API_IMAGE=lnkpi-api:<旧sha> docker compose -f deploy/docker-compose.prod.yml up -d --no-build --force-recreate api"
```

> ⚠️ `LNKPI_API_IMAGE` 必须显式 export：compose 的 `${LNKPI_API_IMAGE:-lnkpi-api:local}` 从 **`deploy/.env`**（无此键）取值，不 export 会去找不存在的 `lnkpi-api:local`。

**回滚演练记录（2026-09-23 17:26，已验证）**：`active → shadow` 后容器 15 s 内 healthy，公网 `/api/health` 200，`prod-agent-thread-verify.py` = **PASS=16 FAIL=0**（与 active 基线一致）；随后切回 `active` 复跑同样 **16/0**。回滚点镜像 `lnkpi-api:1c96a14236e6` 在位，`.last-api-image` 内容一致。`.env` 备份：`/opt/lnkpi/.env.bak-20260923-172651`。

## 9 · 已知陷阱速查

- **别** `git merge upstream/main` 后直接 push —— 会带回 `30a3781e` 的"禁用 API 部署"，必须做 §3-C
- 文档放 `docs/**`，**别放 `deploy/**`** —— 会命中 paths-filter，触发一次 7–13 min 的生产重建
- 本机 shell 的 `grep` 偶发返回空结果（内容其实已写入）→ 用 Grep 工具或 python 复核关键改动
- 同机勿混淆 `pintuotuo-*` / `aimarket-*` 容器与镜像；**禁用 `docker image prune -a`**

## 10 · 迁移完成后以哪个仓库为准

- **代码版本基准 = pi-lnk master**（部署源、生产树来源）
- **画布日常开发主线 = lnkpi**（上游，PR/CI/发版都在它）
- 长期：P1 完成后把 B4 + `services/pi-runtime` + `charts` + `vendor/pi` 上游化进 lnkpi main，让 pi-lnk 退役 → 这条同步流就不需要了（见 POSTMORTEM 的"上游化"建议）
