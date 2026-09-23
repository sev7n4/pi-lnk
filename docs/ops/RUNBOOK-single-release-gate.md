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

## 阶段 3 · 让回滚真的秒级（需你拍板，二选一）

现状缺口：`deploy/deploy-remote-build.sh` 会删除除当前 tag 与 `latest` 外的所有 lnkpi-api 镜像，本地 registry 也只推了 `pi-runtime` → **按旧 sha 回滚不成立，只能重建（约 7 分钟）**。

- 方案 A（保守，占盘 +1.62G，8.2G 可用够用）：保留最近 2 个镜像。把脚本里
  ```bash
  docker images lnkpi-api --format '{{.Tag}}' | while read -r tag; do
    [[ "$tag" == "$IMAGE_TAG" || "$tag" == "latest" ]] && continue
    docker rmi "lnkpi-api:${tag}" 2>/dev/null || true
  ```
  改为按创建时间排序后只保留最新 2 个再删其余。
- 方案 B（彻底，占盘相同）：构建完顺手把镜像推本地 registry（`docker push 127.0.0.1:5000/lnkpi-api:$IMAGE_TAG`），回滚时 `docker pull` + `LNKPI_API_IMAGE=127.0.0.1:5000/lnkpi-api:<sha> docker compose -f deploy/docker-compose.prod.yml up -d --no-build`。

无论选哪个，**不依赖镜像的秒级止血**始终可用：

```bash
ssh deploy-cvm "cd /opt/lnkpi && sed -i 's/^PI_RUNTIME_MODE=.*/PI_RUNTIME_MODE=shadow/' .env && docker compose -f deploy/docker-compose.prod.yml up -d --no-build --force-recreate api"
```

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
