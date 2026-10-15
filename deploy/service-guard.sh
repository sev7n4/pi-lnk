#!/bin/sh
# pi-lnk 服务自愈巡检（2026-10-15 抠图 502 事故后加装）
#
# why：2026-10-15 04:48 `systemctl restart docker` 时 systemd 等到 stop-sigterm 超时后
#   **SIGKILL 了 dockerd**（journalctl: "State 'stop-sigterm' timed out. Killing."），
#   容器状态没被干净持久化 ⇒ dockerd 起来后只自动拉起了 lnkpi-segment，
#   **lnkpi-matting 一直 Exited(0)（RestartCount=0，policy 同为 unless-stopped）**，
#   抠图接口静默不可用 11.5 小时才被用户发现。
#
#   ⇒ 教训：**不能把业务可用性托付给 dockerd 的 restart policy**。
#     restart policy 是「daemon 内部的状态机」，daemon 自己被强杀时它不可信；
#     而且容器一旦不存在，policy 什么都不做（容器消失 = 完全静默：healthcheck 只对活容器生效）。
#     正确做法：**期望状态外置，由外部 reconcile 循环持续对齐**（k8s 控制器同思路，单机用 cron 实现）。
#
# 做什么：每周期检查白名单服务（api / matting / segment）对应容器是否存在且 running，
#   缺失或非 running  ⇒ `docker compose up -d --no-build <svc>` 拉起；
#   running 但持续 unhealthy ⇒ 连续 UNHEALTHY_LIMIT 个周期后才 restart（防模型加载抖动误伤）。
#
# 红线（别"顺手优化"掉）：
#   1. 只 touch 白名单里 lnkpi 自己的服务。机器上还跑着 pintuotuo-* 等其他项目，不碰。
#   2. 必须 `--no-build`：guard 绝不能触发镜像构建（构建走网络，可能失败且耗时数分钟）。
#   3. 不删镜像 / 卷 / 网络 —— 那是 disk-guard.sh 的职责，它有更严的红线。
#   4. 健康服务绝不重启 —— 重启会中断进行中的请求；只有「缺失」和「持续不健康」才动手。
#   5. 只做「拉起」，不做回滚 / 切版本：镜像选择权归部署流程（IMAGE_TAG），guard 不猜版本。
#
# 用法：
#   service-guard.sh             # reconcile（cron 每分钟跑，自带 flock）
#   service-guard.sh --verify    # 只断言不修复；任一服务缺失 ⇒ exit 1（部署后门禁）
#   service-guard.sh --dry-run   # 打印将执行的动作，不执行
#
# 安装（与 disk-guard.sh 同款）：
#   install -m 0755 deploy/service-guard.sh /usr/local/sbin/lnkpi-service-guard.sh
#   crontab: * * * * * flock -xn /tmp/lnkpi-service-guard.lock -c '/usr/local/sbin/lnkpi-service-guard.sh >/dev/null 2>&1'

set -e

COMPOSE_FILE="${LNKPI_COMPOSE_FILE:-/opt/lnkpi/deploy/docker-compose.prod.yml}"
SERVICES="${LNKPI_GUARD_SERVICES:-api matting segment}"
UNHEALTHY_LIMIT="${LNKPI_GUARD_UNHEALTHY_LIMIT:-3}"
LOG="${LNKPI_GUARD_LOG:-/var/log/lnkpi-service-guard.log}"
ALERT_FILE="${LNKPI_GUARD_ALERT_FILE:-/var/log/lnkpi-service-guard.alert}"
COUNT_DIR="${LNKPI_GUARD_COUNT_DIR:-/var/lib/lnkpi-guard}"
TEXTFILE_DIR="${NODE_EXPORTER_TEXTDIR:-/var/lib/node_exporter/textfile_collector}"
LOCK_FILE="${LNKPI_GUARD_LOCK:-/tmp/lnkpi-service-guard.lock}"

MODE=reconcile
case "${1:-}" in
  --verify) MODE=verify ;;
  --dry-run) MODE=dry-run ;;
  "") ;;
  *) echo "usage: $0 [--verify|--dry-run]" >&2; exit 2 ;;
esac

# 日志自限（与 disk-guard.sh 同款：日志自身会无限增长）
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 2097152 ]; then
  tail -c 65536 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

log() { echo "$(date '+%F %T') $*" >>"$LOG"; }
# 告警面：写 alert 文件（保留最近一次「需要人看」的事件）+ 可选 webhook 推送。
# webhook 配置放 /usr/local/etc/lnkpi-alert.env（cron 环境不读 /opt/lnkpi/.env）：
#   echo 'LNKPI_ALERT_WEBHOOK=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx' \
#     > /usr/local/etc/lnkpi-alert.env && chmod 600 /usr/local/etc/lnkpi-alert.env
# 未配置 ⇒ 只落文件，不报错（探活告警不能反过来制造新故障）。
# 注意：set -e 下不能写 `[ -f x ] && . x` —— 文件不存在时整条返回非零会退出脚本。
if [ -f /usr/local/etc/lnkpi-alert.env ]; then . /usr/local/etc/lnkpi-alert.env; fi
notify_alert() {
  echo "$(date '+%F %T') $*" >"$ALERT_FILE"
  if [ -n "${LNKPI_ALERT_WEBHOOK:-}" ] && command -v curl >/dev/null 2>&1; then
    curl -fsS -m 5 -H 'Content-Type: application/json' \
      -d '{"msgtype":"markdown","markdown":{"content":"**lnkpi 服务巡检**\n'"$*"'\n主机: '"$(hostname 2>/dev/null || echo unknown)"'"}}' \
      "$LNKPI_ALERT_WEBHOOK" >/dev/null 2>&1 || true
  fi
}

mkdir -p "$COUNT_DIR" 2>/dev/null || true
[ -d "$(dirname "$LOG")" ] || LOG=/tmp/lnkpi-service-guard.log

# 并发保护：cron 每分钟一次，若上一轮卡住（registry 慢/compose 慢）不能叠加
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -xn 9; then
    log "SKIP: 上一轮仍在运行（锁 $LOCK_FILE 未释放）"
    [ "$MODE" = verify ] || exit 0
  fi
fi

compose_dir=$(dirname "$COMPOSE_FILE")
cd "$compose_dir" || { log "FATAL: compose 目录不存在 $compose_dir"; exit 1; }

container_of() { echo "lnkpi-$1"; }

# 返回 "<State.Status>|<Health.Status|none>"；容器不存在则输出空
probe() {
  docker inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$(container_of "$1")" 2>/dev/null || true
}

reset_count() { rm -f "$COUNT_DIR/$1.unhealthy" 2>/dev/null || true; }
bump_count() {
  f="$COUNT_DIR/$1.unhealthy"
  n=$(cat "$f" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" >"$f" 2>/dev/null || true
  echo "$n"
}

METRICS_TMP=$(mktemp 2>/dev/null || echo /tmp/lnkpi-guard-metrics.$$)
: >"$METRICS_TMP"
record_metric() { printf 'lnkpi_service_up{service="%s"} %s\n' "$1" "$2" >>"$METRICS_TMP"; }
flush_metrics() {
  [ -d "$TEXTFILE_DIR" ] || return 0
  if {
    echo "# HELP lnkpi_service_up lnkpi 必需服务是否在位（由 service-guard 巡检写入）"
    echo "# TYPE lnkpi_service_up gauge"
    cat "$METRICS_TMP"
  } >"$TEXTFILE_DIR/lnkpi_service_up.prom.tmp"; then
    mv "$TEXTFILE_DIR/lnkpi_service_up.prom.tmp" "$TEXTFILE_DIR/lnkpi_service_up.prom" 2>/dev/null || true
  fi
}

FAILED=0
SUMMARY=""

for svc in $SERVICES; do
  cname=$(container_of "$svc")
  st=$(probe "$svc")

  if [ -z "$st" ]; then
    # 容器不存在（被删 / 从未创建 / dockerd 强杀后丢失）⇒ 静默故障的主形态
    SUMMARY="$SUMMARY $svc:MISSING"
    record_metric "$svc" 0
    if [ "$MODE" = dry-run ]; then
      log "DRY-RUN would up: $svc"
      FAILED=1
      continue
    fi
    if [ "$MODE" = verify ]; then
      log "VERIFY FAIL: $svc 容器不存在"
      FAILED=1
      continue
    fi
    log "RECOVER: $svc 容器不存在 ⇒ docker compose up -d --no-build $svc"
    if docker compose -f "$COMPOSE_FILE" up -d --no-build "$svc" >>"$LOG" 2>&1; then
      log "RECOVER OK: $svc 已拉起"
      notify_alert "recovered $svc (was missing)"
    else
      log "RECOVER FAILED: $svc 拉起失败 ⇒ 需人工介入"
      notify_alert "RECOVER_FAILED $svc missing and up failed"
      FAILED=1
    fi
    reset_count "$svc"
    continue
  fi

  status=${st%%|*}
  health=${st##*|}

  case "$status" in
    running)
      case "$health" in
        healthy | none | starting)
          SUMMARY="$SUMMARY $svc:up($health)"
          record_metric "$svc" 1
          reset_count "$svc"
          ;;
        unhealthy)
          SUMMARY="$SUMMARY $svc:unhealthy"
          record_metric "$svc" 0
          n=$(bump_count "$svc")
          if [ "$MODE" = verify ]; then
            log "VERIFY FAIL: $svc unhealthy (连续 $n/$UNHEALTHY_LIMIT)"
            FAILED=1
          elif [ "$MODE" = dry-run ]; then
            log "DRY-RUN would restart: $svc (unhealthy $n/$UNHEALTHY_LIMIT)"
            FAILED=1
          elif [ "$n" -ge "$UNHEALTHY_LIMIT" ]; then
            log "RECOVER: $svc 连续 $n 次 unhealthy ⇒ docker compose restart $svc"
            if docker compose -f "$COMPOSE_FILE" restart "$svc" >>"$LOG" 2>&1; then
              log "RECOVER OK: $svc 已重启"
              notify_alert "restarted $svc (unhealthy x$n)"
            else
              log "RECOVER FAILED: $svc 重启失败 ⇒ 需人工介入"
              notify_alert "RECOVER_FAILED $svc restart failed after unhealthy x$n"
              FAILED=1
            fi
            reset_count "$svc"
          else
            log "WATCH: $svc unhealthy $n/$UNHEALTHY_LIMIT（未达阈值，不动作）"
          fi
          ;;
      esac
      ;;
    restarting | created | paused)
      # 中间态：别插手，避免与 docker 自己的动作打架
      SUMMARY="$SUMMARY $svc:$status"
      record_metric "$svc" 0
      log "SKIP: $svc 处于中间态 $status，本轮不动作"
      if [ "$MODE" = verify ]; then FAILED=1; fi
      ;;
    exited | dead | *)
      SUMMARY="$SUMMARY $svc:$status"
      record_metric "$svc" 0
      if [ "$MODE" = dry-run ]; then
        log "DRY-RUN would up: $svc (state=$status)"
        FAILED=1
        continue
      fi
      if [ "$MODE" = verify ]; then
        log "VERIFY FAIL: $svc state=$status"
        FAILED=1
        continue
      fi
      log "RECOVER: $svc state=$status ⇒ docker compose up -d --no-build $svc"
      if docker compose -f "$COMPOSE_FILE" up -d --no-build "$svc" >>"$LOG" 2>&1; then
        log "RECOVER OK: $svc 已拉起"
        notify_alert "recovered $svc (was $status)"
      else
        log "RECOVER FAILED: $svc 拉起失败 ⇒ 需人工介入"
        notify_alert "RECOVER_FAILED $svc was $status and up failed"
        FAILED=1
      fi
      reset_count "$svc"
      ;;
  esac
done

flush_metrics
rm -f "$METRICS_TMP" 2>/dev/null || true

log "CHECK mode=$MODE =>$SUMMARY"
if [ "$MODE" = verify ] && [ "$FAILED" -ne 0 ]; then
  echo "service-guard --verify FAILED:$SUMMARY" >&2
fi
exit "$FAILED"
