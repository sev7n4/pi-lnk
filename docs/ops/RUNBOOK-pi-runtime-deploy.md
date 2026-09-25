# RUNBOOK — pi-runtime 构建与部署（CVM K3s 链路）

状态头：**现行有效**（2026-09-23 定案，PR #1 合并后实测走通）
前置：本机 `/Users/4seven/workspace/pi-lnk`（master）；CVM `root@119.29.173.89`（ssh 直连，勿用 deploy-cvm 别名——代理 fake-ip 会间歇 kex 失败）。
本文档不含图（纯命令流 runbook，无空间/状态结构需要配图）。

## 部署拓扑

- helm release：`pi-lnk-runtime-dev`（ns `pi-lnk-runtime`），chart 在 repo `charts/pi-lnk-runtime`，CVM 副本 `/root/pi-lnk-charts/`
- 镜像：`127.0.0.1:5000/pi-runtime:<tag>`（CVM 本地 registry，当前 0.0.4）
- 构建源码树：`/root/pi-lnk-build`（**不是仓库镜像**，只含 Dockerfile 需要的最小集：`pnpm-workspace.yaml`、`package.json`、`pnpm-lock.yaml`、`services/pi-runtime/`、`vendor/`）
- svc NodePort 30100 → Pod 8100，外部不可达；Nest 通过宿主 30100 访问
- PI_RUNTIME_MODE 是 **API 容器**（`/opt/lnkpi/.env`）的 B4 分流开关；pi-runtime Pod 里那个同名 env 是 chart 残留，无作用

## 命令流（发布新版本）

```bash
# 1. 同步源码到 CVM（主仓执行）
rsync -az --delete --exclude node_modules --exclude dist --exclude .git \
  vendor/ root@119.29.173.89:/root/pi-lnk-build/vendor/ -e "ssh -i ~/.ssh/tencent_cloud_deploy"
rsync -az --delete --exclude node_modules --exclude dist \
  services/pi-runtime/ root@119.29.173.89:/root/pi-lnk-build/services/pi-runtime/ -e "ssh -i ~/.ssh/tencent_cloud_deploy"
rsync -az package.json pnpm-workspace.yaml pnpm-lock.yaml \
  root@119.29.173.89:/root/pi-lnk-build/ -e "ssh -i ~/.ssh/tencent_cloud_deploy"
rsync -az --delete charts/pi-lnk-runtime/ root@119.29.173.89:/root/pi-lnk-charts/pi-lnk-runtime/ -e "ssh -i ~/.ssh/tencent_cloud_deploy"

# 2. 构建 + 推 registry（CVM 执行）
cd /root/pi-lnk-build && docker build -f services/pi-runtime/Dockerfile \
  -t 127.0.0.1:5000/pi-runtime:<新tag> . && docker push 127.0.0.1:5000/pi-runtime:<新tag>

# 3. helm upgrade（CVM 执行；必须带 KUBECONFIG，--reuse-values 保住 AGNES secrets）
printf 'networkPolicy:\n  egressExtra:\n    - cidr: 172.20.0.0/16\n      ports: [3001]\n' > /root/pi-lnk-charts/egress.yaml
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
helm upgrade pi-lnk-runtime-dev /root/pi-lnk-charts/pi-lnk-runtime -n pi-lnk-runtime \
  --reuse-values \
  --set image.tag=<新tag> \
  --set env.PI_RUNTIME_VERSION=<新tag> \
  --set env.NEST_BASE_URL=http://10.1.0.12:5100/api \
  --set secrets.NEST_SERVICE_TOKEN="$(grep '^AGENT_RUNTIME_SERVICE_TOKEN=' /opt/lnkpi/.env | cut -d= -f2-)" \
  -f /root/pi-lnk-charts/egress.yaml
kubectl rollout status deploy/pi-lnk-runtime -n pi-lnk-runtime --timeout=180s
```

⚠️ **helm upgrade 必须显式 `--set image.tag`**：`--reuse-values` 会沿用旧 tag，只改 env 不会出新 Pod 跑新镜像（2026-09-23 实踩：revision 7 升了 env 但 image 仍是 0.0.3）。

## 验收四件套

```bash
curl -s --noproxy '*' localhost:30100/healthz
curl -s --noproxy '*' localhost:30100/metrics | grep build_info   # version 必须等于镜像 tag
docker exec lnkpi-api printenv PI_RUNTIME_MODE                    # 必须是 active
cd /opt/lnkpi && export LNKPI_API_IMAGE=$(docker inspect --format '{{.Config.Image}}' lnkpi-api) \
  && python3 deploy/prod-agent-thread-verify.py                   # PASS=16 FAIL=0
```

工具链路冒烟（证明 registry → LLM → NestClient → Nest 全通）：

```bash
SID=$(curl -s --noproxy '*' -X POST localhost:30100/sessions -H 'content-type: application/json' \
  -d '{"userId":"smoke-e2e"}' | sed 's/.*sessionId":"//;s/".*//')
curl -s --noproxy '*' -X POST localhost:30100/sessions/$SID/prompt \
  -H 'content-type: application/json' -d '{"text":"请调用画布摘要工具，查询当前画布的内容摘要"}'
sleep 25
curl -s --noproxy '*' localhost:30100/metrics | grep tool_calls
# 期望出现 pi_runtime_tool_calls_total{tool="get-canvas-summary",...}
# 随机 sessionId 下 result=error（画布不存在）即达标；认证/网络失败不会走到 Nest 包络
curl -s --noproxy '*' -X DELETE localhost:30100/sessions/$SID   # 清理
```

## Skills 链路（D-η'，2026-09-25 起）

- **目录链路**：仓库根 `skills/` → Dockerfile `COPY skills ./skills` → 镜像 `/app/skills` → env `PI_RUNTIME_SKILLS_DIR=/app/skills`（chart values 已设）。进程启动时扫描一次，之后不再读盘。
- **格式**：Anthropic 事实标准（github.com/anthropics/skills）——目录名 = skill 名，`SKILL.md` YAML frontmatter（`name`/`description`，description 支持单行引号与 `>`/`|` 多行）+ 正文；坏 skill 启动时 warn 跳过，不影响其余。
- **渐进披露**：index 块（name+description 列表）常驻 systemPrompt 尾部；模型命中后调用 `load_skill` 工具按需取正文。本地只读，不走 Nest、不经 Gate。
- **drop-in 新增 skill 步骤**（零代码改动）：
  1. 在仓库根 `skills/<skill-name>/` 放入 `SKILL.md`（name 必须与目录名一致，小写字母/数字/连字符，≤64 字符；description ≤1024 字符）；
  2. 重走上方「命令流」——注意 **step 1 的 rsync 必须带上 `skills/`**（`rsync -az --delete skills/ root@119.29.173.89:/root/pi-lnk-build/skills/ ...`），否则新 skill 不进构建上下文；
  3. helm upgrade 后验收：`/metrics` 出现 `pi_runtime_skills_loaded <n>`（n 为 skill 数）。
- **/metrics 观测点**：
  - `pi_runtime_skills_loaded`：启动时发现的 skill 数（gauge）；
  - `pi_runtime_tool_calls_total{tool="load_skill",result="ok"|"error"}`：load_skill 调用计数（result=ok 即成功取到正文）。
- **CVM 冒烟**：公网发「帮我做一张商品白底图」，观察 SSE tool_call 是否出现 `load_skill`；或本地 `curl -s --noproxy '*' localhost:30100/metrics | grep -E 'skills_loaded|load_skill'`。

## 陷阱（实测）

1. **NetworkPolicy × docker DNAT**：docker 会把 pod 发往宿主已发布端口（:5100）的流量 DNAT 成 `容器IP:内部端口`（172.20.0.3:3001），**DNAT 发生在 netpol 过滤之前** → egress 白名单放行 `宿主IP:5100` 无效（ECONNREFUSED，icmp-port-unreachable 由 kube-router policy 链 REJECT 产生）。必须放行 **DNAT 后目的地**：`172.20.0.0/16 + 3001`。
2. netpol egress 白名单默认只有 DNS(53) + 443（chart `networkPolicy.egressExtra` 扩展，PR #1 引入）。
3. `NEST_BASE_URL` 必须带 `/api` 全局前缀（Nest `setGlobalPrefix('api')` + `@Controller('agent/internal')`）。
4. `NEST_SERVICE_TOKEN` 的值 = Nest 侧 `AGENT_RUNTIME_SERVICE_TOKEN`（`/opt/lnkpi/.env`），guard 校验 `x-lnkpi-service-token` 头。
5. NEST env 缺失时 pi-runtime 静默降级纯文本模式（`tools=[]`，启动日志有 warn）——冒烟前先确认 pod env。
6. ssh 用直连 IP，别走 deploy-cvm 别名（fake-ip 间歇 kex 失败）。
