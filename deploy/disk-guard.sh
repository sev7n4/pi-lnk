#!/bin/sh
# pi-lnk 磁盘自愈（2026-09-30 爆盘事故后加装；2026-10-08 补齐 pi-runtime 策略并收进仓库）
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
#   4. registry 里保留的 pi-runtime tag 不动（回退保障）。
#
# 2026-10-08 补的两件事（why）：
#   - pi-runtime keep-N：pi-runtime 镜像每个 ~570MB，一次爆盘前堆到 **20 个 tag ≈ 11GB**，
#     而旧脚本只对 lnkpi-api 做 keep-3 ⇒ 这就是 10-08 宕机的机制性缺口。
#   - 孤儿卷清理：`lnkpi_lnkpi-checkpoints`（退役 LangGraph 的 checkpoints.db）725MB，
#     **0 个容器挂载**，且仓库 compose 已无声明⇒ 纯死重。
set -e

AVAIL_KB=$(df --output=avail -k / | tail -1)
LOG=/var/log/disk-guard.log
RUNTIME_NS=pi-lnk-runtime
KEEP_RECENT="${DISK_GUARD_KEEP_RECENT:-3}"

# 日志自身会无限增长（每行一次运行）⇒ 自限。
[ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 2097152 ] && tail -c 65536 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
echo "$(date '+%F %T') avail=${AVAIL_KB}KB keep=${KEEP_RECENT}" >>$LOG

log() { echo "$(date '+%F %T') $*" >>$LOG; }

# 正在运行的 pi-runtime 镜像引用（形如 127.0.0.1:5000/pi-runtime:825e5211）。
# 读不到 ⇒ 空字符串，调用方必须 fail-safe 跳过删除。
running_pi_runtime_ref() {
  kubectl get pod -n "$RUNTIME_NS" \
    -o jsonpath='{.items[0].spec.containers[0].image}' 2>/dev/null || true
}

# keep_recent_images <仓库名> <protected-ref...>
#   保留该仓库最新 KEEP_RECENT 个 tag（按创建时间），外加所有 protected-ref；
#   其余删除。protected 为空 ⇒ **什么都不删**（fail-safe）。
keep_recent_images() {
  repo=$1
  shift
  protected="$*"
  if [ -z "$protected" ]; then
    log "SKIP keep-N $repo: 读不到运行态镜像引用，fail-safe 不删"
    return 0
  fi
  # docker images 按 ID 去重；同一镜像多个 tag 时取第一个（volume 侧只需删一次）。
  docker images "$repo" --format '{{.ID}} {{.CreatedAt}}' 2>/dev/null |
    sort -k2,3 |
    head -n -"$KEEP_RECENT" |
    awk '{print $1}' |
    while read -r id; do
      [ -n "$id" ] || continue
      # 双保险：逐个确认该 id 不对应任何受保护引用
      skip=no
      for p in $protected; do
        [ "$p" = "$id" ] && skip=yes
      done
      # 被任何容器引用的一律不动（lnkpi-api 这类真 docker 容器）
      if docker ps -a --format '{{.Image}}' | grep -q "$id"; then
        log "SKIP $id: 仍被容器引用"
        continue
      fi
      [ "$skip" = "yes" ] && log "SKIP $id: 受保护引用" && continue
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
    docker volume rm "$v" >>$LOG 2>&1 || log "volume rm $v 失败"
  done
}

if [ "$AVAIL_KB" -lt 10485760 ]; then
  docker builder prune -f >>$LOG 2>&1
  journalctl --vacuum-size=200M >>$LOG 2>&1
  # 镜像/孤儿卷治理放在**日常档**（2026-10-08 修正）。
  # 原先只在 <6.5GB 激进档才做镜像治理 ⇒ 6.5~10GB 这段完全不管镜像，
  # 而事故当天正是从 10GB 一路堆到 3.6GB（pi-runtime 20 个 tag ≈ 11GB）才爆。
  # keep-N 本身很便宜且有运行态保护，没必要等到逼近驱逐线才做。
  # lnkpi-api：运行中的是 docker 容器，引用可由 docker ps 判定
  running_api=$(docker ps --format '{{.Image}}' | head -1)
  keep_recent_images lnkpi-api "$running_api"
  # pi-runtime：k3s pod，引用只能从 pod spec 读；读不到则 fail-safe 跳过
  keep_recent_images 127.0.0.1:5000/pi-runtime "$(running_pi_runtime_ref)"
  prune_orphan_lnkpi_volumes
  log "日常清理完成 avail=${AVAIL_KB}KB"
fi

if [ "$AVAIL_KB" -lt 6815744 ]; then
  find /var/log -maxdepth 1 -type f -size +200M \
    \( -name '*.log' -o -name 'messages*' -o -name 'secure*' -o -name 'cron*' -o -name 'maillog*' -o -name 'spooler*' \) \
    -exec truncate -s 0 {} \; >>$LOG 2>&1
  docker images -f dangling=true -q | xargs -r docker rmi >>$LOG 2>&1
  log "激进清理完成 avail=${AVAIL_KB}KB"
fi

exit 0