#!/bin/sh
# pi-lnk 磁盘自愈（2026-09-30 爆盘事故后加装；2026-10-08 补齐 pi-runtime 策略并收进仓库；
#                   2026-11-05 大幅扩写 —— 修掉「有机制但没生效」的四个缺口）
#
# ─────────────────────────────────────────────────────────────────────────────
# 2026-11-05 的根因复盘（91% 爆盘，根分区 40G 只剩 4.0G 可用）
#
# 告警是「/app/share 所在分区 91%」，但 /app/share 自身只有 492K ⇒ 占用在别处。
# 逐层定位后，真正的构成是：
#   /var/lib/containerd   12G  ← Docker 26 的 containerd 镜像存储（**不是** /var/lib/docker）
#   /data/pi-registry      4.8G ← 本地 registry，**132 个 pi-runtime tag**
#   /var/lib/docker        5.2G
#   /var/lib/rancher/k3s   3.2G（含 1.7G sessions PVC）
#   /var/lib/kubelet       1.8G
#
# 四个「有机制但没生效」的缺口（本次全部修掉）：
#
#   缺口 1【最致命】cron 的 PATH 不含 /usr/local/bin，而 kubectl 在 /usr/local/bin
#          ⇒ `running_pi_runtime_ref()` 永远返回空 ⇒ `keep_recent_images` 因
#            "protected 为空 ⇒ fail-safe 不删" 而**永远跳过 pi-runtime**。
#          日志实证：`SKIP keep-N 127.0.0.1:5000/pi-runtime: 读不到运行态镜像引用`。
#          ⇒ 2026-10-08 加的 pi-runtime keep-N 策略**从未执行过一次**。
#   缺口 2 registry 无 tag 治理 ⇒ 每次 runtime 部署推一个 tag，每个 tag 独占
#          ~110MB（--no-cache 构建 ⇒ 层不共享）⇒ 132 个 tag 堆到 4.8G，无人回收。
#   缺口 3 sessions PVC（k3s local-path）无保留期 ⇒ 200 个 session 目录 1.7G。
#   缺口 4 生产库备份无 keep-N ⇒ 卷内堆了 7 份 139M = ~1G。
#
# 另一个「机制形同虚设」的点：Docker 的日志轮转配在 daemon.json 里
# （max-size 100m / max-file 3），但**存量容器不生效** —— log-opts 只在容器创建时
# 生效。实测 pintuotuo-litellm 的日志 63MB 仍在涨。
#
# 水线（沿用）：可用 <10GB 日常清理；<6.5GB 接近 kubelet 15% 驱逐线（6.3GB）时激进清理。
#
# 红线（逐条都要守住，别"顺手优化"掉）：
#   1. 禁 `docker image prune -a` —— 会连回退所需镜像一起删（2026-09-30 事故加固注释）。
#   2. 禁删「正在运行的镜像」。pi-runtime 是 **k3s pod**（不是 docker 容器），
#      `docker ps` 看不到它 ⇒ 必须从 pod spec 读 image；读不到就**整体跳过删除**（fail-safe）。
#      2026-10-08 之前没有这条：keep-3 只按创建时间排，理论上能删掉在跑的那个 tag，
#      而 runtime 是 replicaset=1 ⇒ 删了就直接宕机。
#   3. 只清`lnkpi_` 前缀的孤儿卷。机器上还有 pintuotuo-* 等其他项目，
#      `pintuotuo_prometheus_data` 单卷 1.8G —— 别人的数据，不碰。
#   4. registry 里保留的 pi-runtime tag **不动**（回退保障）。本次只删超出
#      keep-N 的旧 tag，且保留集合始终包含「运行中的 tag」+「最近 N 个 tag」。
#
# ⛔ registry GC 的血泪（2026-11-05 踩过，别再踩）：
#   `registry garbage-collect --delete-untagged` 会把「无 tag 但被 index 引用」的
#   **子 manifest** 当孤儿删掉 ⇒ 连带删掉它的全部层 ⇒ 保留的 tag 变成**空壳**
#   （manifest 还在、层全没了，拉取必失败）。
#   实测：13 个 tag 变空壳，回退能力当场归零。
#   ⇒ 正确姿势：**只用 plain GC（不带 --delete-untagged）**。
#     plain GC 只删「不被任何 manifest 引用」的 blob，实测安全：
#     删 tag 后回收了空间，而保留 tag 的 11 个层一个没少。
#
# 用法：
#   disk-guard.sh              # 日常自愈（cron 每天 04:17 调）
#   disk-guard.sh --dry-run    # 只打印将执行的动作
#   disk-guard.sh --verify     # 只断言不清理；水位超标 ⇒ exit 1（供巡检用）
set -e

# ── 缺口 1 的修复：cron 的 PATH 只有 /sbin:/bin:/usr/sbin:/usr/bin，
#    而 kubectl 在 /usr/local/bin ⇒ 下面所有 kubectl 调用都会静默失败。
#    这一行是整个 pi-runtime 治理能否生效的前提，删不得。
PATH="/usr/local/bin:/usr/local/sbin:$PATH"
export PATH
KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
export KUBECONFIG

AVAIL_KB=$(df --output=avail -k / | tail -1)
LOG=/var/log/disk-guard.log
RUNTIME_NS=pi-lnk-runtime
KEEP_RECENT="${DISK_GUARD_KEEP_RECENT:-3}"
# registry tag 保留数：3 个 runtime 部署 ≈ 1~2 天回退窗口；15 个 ≈ 1~2 周。
# 2026-11-05 定 15：实测每个 tag 独占 ~110MB，保留 15 ≈ 1.6GB，可接受。
KEEP_REGISTRY_TAGS="${DISK_GUARD_KEEP_REGISTRY_TAGS:-15}"
# sessions PVC 保留天数。runtime 侧 TTL 是 30min，14 天已远超业务需要。
SESSIONS_RETENTION_DAYS="${DISK_GUARD_SESSIONS_RETENTION_DAYS:-14}"
# 生产库备份保留份数
KEEP_DB_BACKUPS="${DISK_GUARD_KEEP_DB_BACKUPS:-3}"
# 告警面（与 service-guard.sh 同款）
ALERT_FILE="${DISK_GUARD_ALERT_FILE:-/var/log/disk-guard.alert}"

MODE=reconcile
case "${1:-}" in
  --dry-run) MODE=dry-run ;;
  --verify) MODE=verify ;;
  "") ;;
  *) echo "usage: $0 [--dry-run|--verify]" >&2; exit 2 ;;
esac

# 日志自身会无限增长（每行一次运行）⇒ 自限。
[ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 2097152 ] && tail -c 65536 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
echo "$(date '+%F %T') avail=${AVAIL_KB}KB keep=${KEEP_RECENT} reg_keep=${KEEP_REGISTRY_TAGS} mode=${MODE}" >>$LOG

log() { echo "$(date '+%F %T') $*" >>$LOG; }

# 告警：写 alert 文件 + 可选企业微信 webhook（与 service-guard.sh 同款）。
# ⚠️ set -e 下不能写 `[ -f x ] && . x` —— 文件不存在时整条返回非零会退出脚本。
if [ -f /usr/local/etc/lnkpi-alert.env ]; then . /usr/local/etc/lnkpi-alert.env; fi
notify_alert() {
  echo "$(date '+%F %T') $*" >"$ALERT_FILE"
  if [ -n "${LNKPI_ALERT_WEBHOOK:-}" ] && command -v curl >/dev/null 2>&1; then
    curl -fsS -m 5 -H 'Content-Type: application/json' \
      -d '{"msgtype":"markdown","markdown":{"content":"**lnkpi 磁盘告警**\n'"$*"'\n主机: '"$(hostname 2>/dev/null || echo unknown)"'"}}' \
      "$LNKPI_ALERT_WEBHOOK" >/dev/null 2>&1 || true
  fi
}

# 正在运行的 pi-runtime 镜像引用（形如 127.0.0.1:5000/pi-runtime:825e5211）。
# 读不到 ⇒ 空字符串，调用方必须 fail-safe 跳过删除。
running_pi_runtime_ref() {
  kubectl get pod -n "$RUNTIME_NS" \
    -o jsonpath='{.items[0].spec.containers[0].image}' 2>/dev/null || true
}

# keep_recent_images <仓库名> <protected-ref...>
#   保留该仓库最新 KEEP_RECENT 个镜像（按创建时间），外加所有 protected-ref；
#   其余删除。protected 为空 ⇒ **什么都不删**（fail-safe）。
#
# ⚠️ 2026-11-05 修掉的三个真实缺陷（前两个会让守卫**完全失效**）：
#   ① `docker ps -a --format '{{.Image}}'` 输出的是 **tag 名**，
#      而 `docker images --format '{{.ID}}'` 输出的是 **sha256 ID**
#      ⇒ 原来的 `grep -q "$id"` 永远匹配不上 ⇒「被容器引用就不删」形同虚设。
#      正确做法：`docker inspect -f '{{.Image}}'` 拿容器的镜像 ID（就是 sha256）。
#   ② kubectl 的 pod spec 给的是 **tag**（127.0.0.1:5000/pi-runtime:xxx），
#      不是 ID ⇒ protected 列表与 $id 比较同样永远不相等 ⇒ 运行中的镜像可能被删。
#      现在统一先解析成 ID 再比较。
#   ③ `sort -k2,3` 只按「时分秒」排，**跨天会错序**（11-05 08:00 排在 11-04 23:00 之前）
#      ⇒ "保留最新 N 个" 选出来的可能不是最新的。改用 `sort` 按完整时间戳排。
keep_recent_images() {
  repo=$1
  shift
  protected_refs="$*"
  if [ -z "$protected_refs" ]; then
    log "SKIP keep-N $repo: 读不到运行态镜像引用，fail-safe 不删"
    return 0
  fi
  # protected-ref（tag 或 ID）统一解析成镜像 ID 列表
  protected_ids=""
  for p in $protected_refs; do
    pid=$(docker inspect -f '{{.Id}}' "$p" 2>/dev/null || true)
    [ -n "$pid" ] && protected_ids="$protected_ids $pid"
  done
  # 全部容器引用的镜像 ID（正确的比较口径）
  used_ids=$(docker ps -aq | while read -r c; do
    docker inspect -f '{{.Image}}' "$c" 2>/dev/null || true
  done | sort -u)

  # 按完整创建时间排序（修正缺陷 ③）：docker 的 CreatedAt 形如
  # "2026-11-05 17:17:40 +0800 CST" ⇒ 取前 19 字符（YYYY-MM-DD HH:MM:SS）排序。
  docker images "$repo" --format '{{.ID}}|{{.CreatedAt}}' 2>/dev/null |
    sed 's/|/ /' |
    awk '{print $1, substr($2" "$3, 1, 19)}' |
    sort -k2,3 |
    head -n -"$KEEP_RECENT" |
    awk '{print $1}' |
    sort -u |
    while read -r id; do
      [ -n "$id" ] || continue
      # 守卫 ①：被任何容器引用（按镜像 ID 比）⇒ 不动
      if printf '%s\n' "$used_ids" | grep -qx "$id"; then
        log "SKIP $id: 仍被容器引用"
        continue
      fi
      # 守卫 ②：受保护引用（运行中的镜像）⇒ 不动
      if printf '%s\n' "$protected_ids" | grep -qx "$id"; then
        log "SKIP $id: 受保护引用"
        continue
      fi
      [ "$MODE" = dry-run ] && { log "DRY-RUN would rmi $id"; continue; }
      docker rmi "$id" >>$LOG 2>&1 || log "rmi $id 失败"
    done
}

# 0 容器挂载的 lnkpi_* 孤儿卷（退役 runtime / 历史遗留）。
# 严格限定 lnkpi_ 前缀 + 0 挂载，两个条件缺一不可。
prune_orphan_lnkpi_volumes() {
  used=$(docker ps -aq | while read -r c; do docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}' "$c" 2>/dev/null; done)
  for v in $(docker volume ls -q 2>/dev/null); do
    case "$v" in
      lnkpi_*) ;;
      *) continue ;;
    esac
    echo "$used" | grep -qw "$v" && continue
    log "删除孤儿卷 $v ($(du -sh "/var/lib/docker/volumes/$v/_data" 2>/dev/null | cut -f1))"
    [ "$MODE" = dry-run ] && continue
    docker volume rm "$v" >>$LOG 2>&1 || log "volume rm $v 失败"
  done
}

# ── 缺口 2：registry tag 治理（本次新增）────────────────────────────────────
#
# 为什么要单独写而不用 `docker image prune`：
#   registry 里的 tag 是 **回退保障**（runtime-deploy 的 skip_build 回退依赖它），
#   docker 的镜像治理管不到 registry 的 blob。
#   实测每个 pi-runtime tag 独占 ~110MB（--no-cache ⇒ 层不共享），
#   132 个 tag ⇒ 4.8GB，这是 2026-11-05 爆盘的**第二大来源**。
#
# 流程（顺序有讲究）：
#   1. 算保留集合 = 运行中的 tag ∪ 最近 N 个 tag（按 mtime）；
#   2. 对超出保留集合的 tag，逐个调 registry DELETE API 删 manifest；
#   3. 跑 **plain** GC（不带 --delete-untagged）回收无人引用的 blob。
#
# ⛔ 为何不能用 --delete-untagged：见文件头「registry GC 的血泪」。
# ⛔ 为何必须按 digest 删而不是按 tag 删：registry 2.8.3 的 DELETE by tag 会报
#    DIGEST_INVALID（实测 400），只有 DELETE by digest 才返回 202。
prune_registry_tags() {
  command -v python3 >/dev/null 2>&1 || { log "SKIP registry 治理: 无 python3"; return 0; }
  REG_CONTAINER=pi-registry
  docker ps --format '{{.Names}}' | grep -qx "$REG_CONTAINER" || {
    log "SKIP registry 治理: 容器 $REG_CONTAINER 不在运行"; return 0; }

  running_ref=$(running_pi_runtime_ref)
  # ⚠️ running_ref 形如 "127.0.0.1:5000/pi-runtime:d2760a44"（**含仓库前缀**）。
  #    直接 ${running_ref##*/} 得到的是 "pi-runtime:d2760a44" —— 不是纯 tag，
  #    与 registry 里的 tag 名对不上 ⇒ 保留集合失效 + 自检 404。
  #    必须再剥一层 ":前面的仓库名"。这正是 2026-11-05 测试时抓到的真实 bug。
  running_tag=${running_ref##*/}          # pi-runtime:d2760a44
  running_tag=${running_tag##*:}          # d2760a44

  [ "$MODE" = dry-run ] && { log "DRY-RUN would prune registry tags (keep=$KEEP_REGISTRY_TAGS)"; return 0; }

  python3 - "$KEEP_REGISTRY_TAGS" "$running_tag" <<'PYEOF' >>"$LOG" 2>&1
import json, os, subprocess, sys, urllib.request

keep_n = int(sys.argv[1])
running_tag = sys.argv[2] if len(sys.argv) > 2 else ""
V2 = "/data/pi-registry/docker/registry/v2"
TDIR = os.path.join(V2, "repositories/pi-runtime/_manifests/tags")
BASE = "http://127.0.0.1:5000"
# ⚠️ registry 2.8.3 解析 Accept 头时**要求 mediaType 之间用「逗号+空格」分隔**。
#    实测（2026-11-05）：逗号紧贴无空格 ⇒ 解析不出 mediaType ⇒
#    返回 404 "OCI index found, but accept header does not support OCI indexes"；
#    逗号后带空格 ⇒ 正常 200。
#    ⇒ 这里必须保留空格。踩过这个坑：一度"修"成无空格，结果自检全假阳性。
ACC = ("Accept: application/vnd.oci.image.index.v1+json, "
       "application/vnd.docker.distribution.manifest.list.v2+json, "
       "application/vnd.oci.image.manifest.v1+json, "
       "application/vnd.docker.distribution.manifest.v2+json")

def tag_digest(t):
    p = os.path.join(TDIR, t, "current", "link")
    return open(p).read().strip() if os.path.exists(p) else None

tags = {t: d for t, d in ((t, tag_digest(t)) for t in os.listdir(TDIR)) if d}
if not tags:
    print("registry: 无 tag，跳过")
    sys.exit(0)

sha = [t for t in tags if not (t[0].isdigit() and "." in t)]
order = sorted(sha, key=lambda t: os.path.getmtime(os.path.join(TDIR, t)), reverse=True)
keep = set(order[:keep_n])
if running_tag:
    keep.add(running_tag)

# ⚠️ 按 digest 删会连带删掉所有指向同一 digest 的 tag ⇒ 必须按 digest 分组，
#    若该 digest 被任一保留 tag 引用则整组跳过。
groups = {}
for t, d in tags.items():
    groups.setdefault(d, []).append(t)

removed = 0
for d, ts in groups.items():
    if any(t in keep for t in ts):
        continue
    r = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                        "-X", "DELETE", BASE + "/v2/pi-runtime/manifests/" + d,
                        "-H", "Accept: " + ACC], capture_output=True, text=True)
    if r.stdout.strip() == "202":
        removed += len(ts)
    else:
        print("  DEL FAIL %s digest=%s tags=%s" % (r.stdout.strip(), d[:20], ts))
print("registry: 删除 %d 个旧 tag（保留 %d 个: %s）"
      % (removed, len(keep), ",".join(sorted(keep))))
PYEOF

  # plain GC —— **不带 --delete-untagged**（带了就毁掉保留 tag 的层，见文件头）
  docker stop "$REG_CONTAINER" >/dev/null 2>&1 || true
  sleep 2
  docker run --rm --network none -v /data/pi-registry:/var/lib/registry \
    --entrypoint /bin/registry registry:2 \
    garbage-collect /etc/docker/registry/config.yml 2>&1 | tail -3 >>"$LOG"
  docker start "$REG_CONTAINER" >/dev/null 2>&1 || true
  # ⚠️ 必须等 registry **真正就绪**再自检 —— 固定 sleep 3 会在重启窗口内
  #    打出假阳性的 404（实测：manifest 全都在、HTTP 200，但自检那一刻
  #    registry 还没 ready ⇒ MANIFEST_UNKNOWN）。用健康端点轮询。
  i=0
  while [ "$i" -lt 30 ]; do
    if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:5000/v2/" 2>/dev/null; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  log "registry 重启后等待就绪: ${i}s"

  # GC 后自检：保留 tag 的层必须还在，否则说明 GC 行为异常 ⇒ 立即告警。
  #
  # ⚠️ 判据**只看磁盘上的 blob 文件**，不走 HTTP。
  #    踩过的坑：用 HTTP GET manifest 验完整性，但 registry 刚被 docker start 后
  #    它的 blobdescriptor 缓存（config 里是 inmemory）尚未加载完成 ⇒ 那几秒内
  #    GET 返回 404 "OCI index found, but accept header does not support OCI indexes"
  #    ⇒ **假阳性**（实测：磁盘上 blob 全都在、稍后 GET 就是 200）。
  #    磁盘是真相源，缓存不是。
  python3 - <<'PYEOF' >>"$LOG" 2>&1
import json, os
V2 = "/data/pi-registry/docker/registry/v2"
TDIR = os.path.join(V2, "repositories/pi-runtime/_manifests/tags")
def bp(d):
    h = d.split(":")[1]; return os.path.join(V2, "blobs/sha256", h[:2], h, "data")
tags = sorted(os.listdir(TDIR)) if os.path.isdir(TDIR) else []
broken = []
for t in tags:
    lp = os.path.join(TDIR, t, "current", "link")
    if not os.path.exists(lp):
        broken.append(t); continue
    dig = open(lp).read().strip()
    p = bp(dig)
    if not os.path.exists(p):
        broken.append(t); continue
    try:
        idx = json.load(open(p))
    except Exception:
        broken.append(t); continue
    # OCI index 走 manifests[]，单 manifest 自己就是 manifest
    subs = [m["digest"] for m in (idx.get("manifests") or [])] or [dig]
    for dg in subs:
        sp = bp(dg)
        if not os.path.exists(sp):
            broken.append(t); break
        m = json.load(open(sp))
        for l in m.get("layers", []):
            if not os.path.exists(bp(l["digest"])):
                broken.append(t); break
print("registry 自检: %d 个 tag，%d 个层缺失" % (len(tags), len(broken)))
if broken:
    print("BROKEN_TAGS=" + ",".join(sorted(set(broken))))
PYEOF
}

# ── 缺口 3：sessions PVC 保留期（k3s local-path provisioner）────────────────
# PI_RUNTIME_SESSIONS_MAX_COUNT=200 / TTL=30min ⇒ 磁盘上的 session 目录本不该
# 堆到 200 个 1.7G。实测 200 个目录，其中 77 个超 14 天 = 466MB。
prune_sessions_pvc() {
  PVC_BASE=/var/lib/rancher/k3s/storage
  [ -d "$PVC_BASE" ] || return 0
  for d in "$PVC_BASE"/*pi-lnk-runtime-sessions*; do
    [ -d "$d" ] || continue
    log "sessions PVC: $d"
    if [ "$MODE" = dry-run ]; then
      find "$d" -maxdepth 1 -mindepth 1 -type d -mtime +"$SESSIONS_RETENTION_DAYS" 2>/dev/null |
        wc -l | sed 's/^/  DRY-RUN 将删 session 目录数: /' >>"$LOG"
      continue
    fi
    find "$d" -maxdepth 1 -mindepth 1 -type d -mtime +"$SESSIONS_RETENTION_DAYS" \
      -exec rm -rf {} + 2>/dev/null || true
    log "  清理后剩余 session 目录: $(ls -1 "$d" 2>/dev/null | wc -l)"
  done
}

# ── 缺口 4：生产库备份 keep-N（卷内 7 份 × 139M = ~1G）─────────────────────
prune_db_backups() {
  docker exec lnkpi-api sh -c "
    cd /app/apps/server/data 2>/dev/null || exit 0
    ls -1t lnkpi.db.bak-* 2>/dev/null | tail -n +$((KEEP_DB_BACKUPS + 1)) |
    while read f; do echo \"删备份 \$f (\$(du -h \"\$f\" | cut -f1))\"; rm -f \"\$f\"; done
    echo \"保留备份: \$(ls -1t lnkpi.db.bak-* 2>/dev/null | tr '\n' ' ')\"
  " >>"$LOG" 2>&1 || log "DB 备份治理跳过（容器不可用）"
}

# ── 存量容器日志轮转（daemon.json 只对新建容器生效）────────────────────────
# 实测 pintuotuo-litellm 的 json.log 已 63MB 仍在涨。裁剪超限的存量日志文件。
prune_oversized_container_logs() {
  find /var/lib/docker/containers -name '*-json.log' -size +200M 2>/dev/null |
    while read -r f; do
      log "截断超限容器日志 $(basename "$(dirname "$f")") ($(du -h "$f" | cut -f1))"
      [ "$MODE" = dry-run ] && continue
      truncate -s 0 "$f" 2>/dev/null || log "截断失败 $f"
    done
}

if [ "$MODE" = verify ]; then
  # 只断言不清理：水位超标 ⇒ exit 1（供巡检/CI 门禁用）
  LIMIT_KB=${DISK_GUARD_VERIFY_LIMIT_KB:-6815744}
  if [ "$AVAIL_KB" -lt "$LIMIT_KB" ]; then
    echo "FAIL: 可用空间 ${AVAIL_KB}KB 低于阈值 ${LIMIT_KB}KB"
    exit 1
  fi
  echo "OK: 可用空间 ${AVAIL_KB}KB"
  exit 0
fi

if [ "$AVAIL_KB" -lt 10485760 ]; then
  docker builder prune -f >>$LOG 2>&1
  journalctl --vacuum-size=200M >>$LOG 2>&1
  # 镜像/孤儿卷治理放在**日常档**（2026-10-08 修正）。
  # 原先只在 <6.5GB 激进档才做镜像治理 ⇒ 6.5~10GB 这段完全不管镜像，
  # 而事故当天正是从 10GB 一路堆到 3.6GB（pi-runtime 20 个 tag ≈ 11GB）才爆。
  # keep-N 本身很便宜且有运行态保护，没必要等到逼近驱逐线才做。
  # lnkpi-api：运行中的是 docker 容器，引用可由 docker ps 判定
  # ⚠️ 不能用 `docker ps --format '{{.Image}}' | head -1` —— 那是「任意一个容器的镜像」，
  #    机器上还跑着 pintuotuo-* 等其他项目，可能取到别人的镜像 ⇒ protected 失效。
  #    改为按容器名精确取 lnkpi-api 的镜像。
  running_api=$(docker inspect -f '{{.Config.Image}}' lnkpi-api 2>/dev/null || true)
  keep_recent_images lnkpi-api "$running_api"
  # pi-runtime：k3s pod，引用只能从 pod spec 读；读不到则 fail-safe 跳过
  keep_recent_images 127.0.0.1:5000/pi-runtime "$(running_pi_runtime_ref)"
  prune_orphan_lnkpi_volumes
  # 缺口 2/3/4：registry tag、sessions PVC、DB 备份
  prune_registry_tags
  prune_sessions_pvc
  prune_db_backups
  prune_oversized_container_logs
  log "日常清理完成 avail=${AVAIL_KB}KB"
fi

if [ "$AVAIL_KB" -lt 6815744 ]; then
  find /var/log -maxdepth 1 -type f -size +200M \
    \( -name '*.log' -o -name 'messages*' -o -name 'secure*' -o -name 'cron*' -o -name 'maillog*' -o -name 'spooler*' \) \
    -exec truncate -s 0 {} \; >>$LOG 2>&1
  docker images -f dangling=true -q | xargs -r docker rmi >>$LOG 2>&1
  log "激进清理完成 avail=${AVAIL_KB}KB"
fi

# ── 水位告警：清理之后仍不够 ⇒ 通知人（清理只能止血，告警才能防复发）────
FINAL_AVAIL_KB=$(df --output=avail -k / | tail -1)
ALERT_LIMIT_KB=${DISK_GUARD_ALERT_LIMIT_KB:-6815744}
if [ "$FINAL_AVAIL_KB" -lt "$ALERT_LIMIT_KB" ]; then
  notify_alert "根分区可用空间仅 ${FINAL_AVAIL_KB}KB（${ALERT_LIMIT_KB}KB 以下），已执行清理仍不足，需人工介入"
  log "ALERT: 可用 ${FINAL_AVAIL_KB}KB 仍低于告警线"
fi

exit 0
