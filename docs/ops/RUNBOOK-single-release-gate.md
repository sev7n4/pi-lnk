# 操作手册：pi-lnk 单一发布门落地与验证

适用时间：2026-09-23 起。目标：两个仓库各自独立开发 + CI，但**只有 pi-lnk 能部署生产**，且切换后的 runtime 链路不会被覆盖。

已完成的改动（无需重做）：
- pi-lnk `1c96a14`：三个工作流触发分支 `main → master`（发布门对齐到实际工作分支）
- pi-lnk `aca108a`：`deploy/launch-cvm-build.sh` 加 B4 守卫（源码树缺分流代码时拒绝构建）
- lnkpi `30a3781e`：`deploy-api` 改为仅手动显式开启；自动部署只剩 `deploy-web`（只写 `web/dist`，不碰源码树）

---

## 阶段 0 · 现状确认（已完成，供你核对）

| 项目 | 状态 |
| --- | --- |
| lnkpi `Deploy to Tencent Cloud`（自动） | 运行中：`Build API on CVM (disabled)` = **skipped** ✓，`Deploy web to CVM` 正常执行 |
| pi-lnk `Deploy Agent Runtime` | **失败**（预期）：该仓库还没有任何 secrets |
| pi-lnk secrets 位置 | `production` environment 下有 0 个；**lnkpi** 的 `production` environment 下有 5 个 |
| pi-lnk 的 secrets 缺口 | 缺 `TENCENT_CLOUD_SSH_KEY`、`TENCENT_CLOUD_IP`、`TENCENT_CLOUD_USER` |
| 环境审批规则 | 两个仓库的 `production` 都是空保护规则 → 部署不会卡在等批准 |
| CVM 磁盘 | 8.2G 可用（镜像单个 1.62G，多 tag 共享层） |

已处置：取消了一次因缺 secrets 必然失败的 pi-lnk 部署 run（避免误导）。

---

## 阶段 1 · 给 pi-lnk 补 3 个 secrets

需要写入的值：

| 名称 | 值 |
| --- | --- |
| `TENCENT_CLOUD_IP` | `119.29.173.89` |
| `TENCENT_CLOUD_USER` | `root` |
| `TENCENT_CLOUD_SSH_KEY` | 本机 `~/.ssh/config` 里 `Host deploy-cvm` 的 `IdentityFile` 私钥全文（含 `-----BEGIN`/`END` 行） |

> pi-lnk 的工作流不需要 `TCR_USERNAME` / `TCR_PASSWORD`（它走 CVM 本地构建，不推 TCR 镜像），lnkpi 里那两个不用复制。

### 路径 A · 我代你写入（推荐，一条指令即可）

我可以读取本机 `deploy-cvm` 的私钥，用 GitHub 的 sealed-box 加密后通过 API 写入 pi-lnk 的 `production` environment（全程不打印私钥内容）。你只需回一句「写入 secrets」。

### 路径 B · 你手动填写

1. 打开 `https://github.com/sev7n4/pi-lnk/settings/environments`
2. 点 `production` → `Add environment secret`（3 次，分别填上表三项）
3. 本机取私钥：`sed -n '1,$p' <IdentityFile 路径>`，整段复制（**注意保留换行**）

### 验收

```bash
python3 - <<'EOF'
import subprocess,json,urllib.request
tok=next(l.split("=",1)[1].strip() for l in subprocess.run(["git","credential","fill"],input="protocol=https\nhost=github.com\n\n",capture_output=True,text=True,timeout=15).stdout.split("\n") if l.startswith("password="))
req=urllib.request.Request("https://api.github.com/repos/sev7n4/pi-lnk/environments/production/secrets",headers={"Authorization":"token "+tok,"User-Agent":"wb"})
print(json.loads(urllib.request.urlopen(req,timeout=20).read())["secrets"])
EOF
```

预期输出包含 3 个 secret 名字。

---

## 阶段 2 · 触发一次真实部署，验证自动闭环

**前提**：阶段 1 通过；且当前 `/opt/lnkpi` 里的生产内容（含你 11:17 部署的画布工作）已在 pi-lnk master 里（本次 merge 已完成，`3242fa8`）。

1. 打开 `https://github.com/sev7n4/pi-lnk/actions/workflows/deploy.yml`
2. `Run workflow` → Branch 选 **master**，其余开关全部保持 false → Run
3. 预期 job 序列：`Detect changes` → `Build API on CVM`（约 7 分钟）→ `Deploy web to CVM` → `Verify`
4. 判据（三条全过才算闭环）：
   ```bash
   ssh deploy-cvm 'docker ps --format "{{.Names}} {{.Image}}" | grep lnkpi-api'      # 期望 lnkpi-api:<新提交sha>
   ssh deploy-cvm 'docker exec lnkpi-api printenv PI_RUNTIME_MODE'                    # 期望 active
   cd /Users/4seven/workspace/pi-lnk && python3 deploy/prod-agent-thread-verify.py    # 期望 PASS=16 FAIL=0
   ```
5. 失败排查顺序：
   - 卡在 `Set up ssh` / `Sync source tar` → secrets 值错，先手工验证 `ssh -i <key> root@119.29.173.89 true`
   - `launch-cvm-build` 报 `ERROR: 源码树缺少 pi-runtime 分流代码` → 部署源不是 pi-lnk master，停止并检查同步来源
   - `Health check` 失败 → `ssh deploy-cvm 'docker logs lnkpi-api --tail 60'`

**日常开发约定**（做完上面这步就生效）：
- 画布改动的日常发版：lnkpi PR 合并 main → 自动部署 web；若同时改了 `apps/server/**`，必须先在 pi-lnk 执行 `git fetch upstream && git merge upstream/main && git push` 再走阶段 2，否则线上 API 还是旧代码。
- runtime / 分流改动：只在 pi-lnk 做，提交进 master 即自动部署，lnkpi 不受影响。

---

## 阶段 3 · 回滚 ✅ 已落地（2026-09-23，采用方案 A）

**原缺口**：`deploy/deploy-remote-build.sh` 会删除除当前 tag 与 `latest` 外的所有 lnkpi-api 镜像 → 按旧 sha 回滚只能重建（约 7 分钟）。

**已改为**（commit `b219af5`，本地与 CVM 均已同步生效）：保留 `当前 tag + latest + 最近 KEEP_PREVIOUS 个历史版本`（默认 1，需要更多可用 `LNKPI_KEEP_PREVIOUS=2` 调），构建前执行；同时把回滚目标写入 `/opt/lnkpi/.last-api-image`，并把完整回滚命令打进部署日志。

**为什么磁盘几乎不涨**（`docker history` 实测 lnkpi-api 各层）：

| 层 | 大小 | 两次构建之间 |
| --- | --- | --- |
| 应用依赖层（pnpm node_modules） | 562 MB | 内容稳定 → 层共享 |
| 系统包层（ffmpeg / openssl） | 473 MB | 内容稳定 → 层共享 |
| Node 22 + Debian 基础层 | 243 MB | 内容稳定 → 层共享 |
| **业务层（apps/server/dist）** | **1.1 MB** | **每次变动** |

镜像层按内容寻址，多留一个历史版本只多存业务层 → **真实代价约 1 MB**（最坏情况依赖层也重生成约 1 GB），而不是 `docker images` 显示的 1.68 GB（那是逻辑大小＝各层之和）。

**回滚操作（秒级，不重建）**：

```bash
ssh deploy-cvm 'cat /opt/lnkpi/.last-api-image'   # 查最近可回滚的 sha
ssh deploy-cvm "cd /opt/lnkpi && LNKPI_API_IMAGE=lnkpi-api:<旧sha> docker compose -f deploy/docker-compose.prod.yml up -d --no-build --force-recreate api"
```

**不依赖镜像的秒级止血**（任何时候都可用，优先级最高）。

```bash
ssh deploy-cvm "cd /opt/lnkpi && sed -i 's/^PI_RUNTIME_MODE=.*/PI_RUNTIME_MODE=shadow/' .env && docker compose -f deploy/docker-compose.prod.yml up -d --no-build --force-recreate api"
```

> 注意：`deploy-remote-build.sh` 的清理发生在构建**之前**，此刻「当前运行中的镜像」是靠 `latest` tag 保护的；新脚本在此基础上多保留历史版本，因此首次运行不会产生额外保留（属预期）。下一次部署起，`.last-api-image` 会稳定指向上一版。

**磁盘现状（2026-09-23 清理后）**：40G 用 31G，**可用 9.9G**（`docker builder prune` 释放 4.07 GB 构建缓存；代价是下次构建为冷构建，会慢一些）。
⚠️ **禁止 `docker image prune -a`** —— 同机还跑着 pintuotuo / aimarket 等项目的镜像。

**两个候选目录的核查结论（2026-09-23 实测，结论相反）**：

| 目录 | 大小 | 结论 | 依据 |
| --- | --- | --- | --- |
| `/opt/lnkcanvas` | 800 MB | **可整体删除**（其中 `.next` 构建产物 796 MB，源码仅 4 MB） | 全盘 grep 无外部引用；无容器、无 nginx 引用、无 volume 挂载、无 systemd/cron；`.git` 是空仓库（无任何 commit）；最后活动 2026-07-16，端口 3000 空闲；属主 uid 501 在本机无对应用户（旧环境遗留） |
| `/opt/actions-runner` | 2.1 GB | **⚠️ 不可删除** —— 是 `sev7n4/aimarket` 的**活跃** self-hosted runner（`agentName=aimarket-build-1`，systemd `actions.runner.sev7n4-aimarket.aimarket-build-1.service` active，`Runner.Listener` 进程在跑，`_diag` 今日 14:54 仍有日志）。**但其中 ≈1.4 GB 是可清的版本升级残留** | 见下 |

`actions-runner` 可回收明细（清理后 runner 功能不受影响）：

- `_work/_update/` **671 MB** —— 自升级下载解包暂存（2026-08-26），升级到 2.337.0 已生效，属冗余副本
- `bin.2.336.0` 80 MB + `externals.2.336.0` 587 MB = **667 MB** —— 旧版本目录，`bin` / `externals` 软链均已指向 2.337.0，无进程引用 2.336.0（保留它只是保留"回滚到上一版"的能力，删掉则需重新下载）
- `_diag/*.log` **96 MB** —— 791 个历史日志（保留最近 7 天即可）

合计可回收 ≈ **2.2 GB**（lnkcanvas 800 MB + runner 残留 1.4 GB），清理后可用空间从 9.8G → 约 12G。

---

## 阶段 4 · 回到 P1（canvas tool 迁移，30 天时钟内）

1. 盘点：从 lnkpi 代码里导出画布工具清单（`upsert_media_node`、`apply_sidebar_attachments`、`propose_generation` 等）与其 schema/副作用
2. 在 pi-runtime 侧建 `atomic/` 工具注册表，先实现 1-2 个只读或低风险工具
3. `PI_RUNTIME_MODE=shadow` 双跑，用 `deploy/runtime-compare.py --suite` 比对同 prompt 的 tool 调用差异
4. 差异收敛后再进 active，且**不与画布发版同批上线**

---

## 速查：日常三条命令

```bash
# 同步画布上游到发布门
cd /Users/4seven/workspace/pi-lnk && git fetch upstream && git merge upstream/main && git push

# 生产健康
ssh deploy-cvm 'docker ps --format "{{.Names}} {{.Image}} {{.Status}}" | grep lnkpi'

# 端到端验证
cd /Users/4seven/workspace/pi-lnk && python3 deploy/prod-agent-thread-verify.py
```
