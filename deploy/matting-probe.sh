#!/bin/sh
# pi-lnk 抠图黑盒合成探针（2026-10-15 抠图 502 事故后加装，P2）
#
# why：service-guard 的 health 只探 `/health`，探不到「容器在但推理坏」
#   （模型加载失败 / onnxruntime 崩 / 内存不足推理超时都表现为 health 200 + 业务 5xx）。
#   本探针是唯一贴合用户视角的检测：用一张固定小图**真打一次推理**。
#
# 做什么：
#   1. docker inspect 拿 lnkpi-matting 的内网 IP（容器重启会变，每轮现读）
#   2. POST 内嵌的 32x32 渐变 PNG 到 /matting，校验 200 + 响应是 PNG
#   3. 成功 ⇒ 清零失败计数、写探活指标；连续 FAIL_LIMIT 次失败 ⇒ notify_alert
#
# 红线（别"顺手优化"掉）：
#   1. 打内网直连 IP，不打 nginx/公网 —— 探针失败必须能区分「推理坏了」和「入口坏了」。
#   2. 不写任何用户数据 —— 图是内嵌的合成图（本机 python 手写 PNG 生成，见 runbook）。
#   3. 失败不自动 restart —— 拉起/重启是 service-guard 的职责，探针只负责「说真话」。
#
# 安装（cron 每 10 分钟；锁由脚本自己管，外层不要套 flock，原因见 RUNBOOK-service-guard.md）：
#   install -m 0755 deploy/matting-probe.sh /usr/local/sbin/lnkpi-matting-probe.sh
#   crontab: */10 * * * * /usr/local/sbin/lnkpi-matting-probe.sh >/dev/null 2>&1

set -e

TIMEOUT="${LNKPI_PROBE_TIMEOUT:-30}"
FAIL_LIMIT="${LNKPI_PROBE_FAIL_LIMIT:-2}"
CONTAINER="${LNKPI_PROBE_CONTAINER:-lnkpi-matting}"
LOG="${LNKPI_PROBE_LOG:-/var/log/lnkpi-matting-probe.log}"
ALERT_FILE="${LNKPI_PROBE_ALERT_FILE:-/var/log/lnkpi-probe.alert}"
COUNT_FILE="${LNKPI_PROBE_COUNT_DIR:-/var/lib/lnkpi-guard}/probe-fail.count"
TEXTFILE_DIR="${NODE_EXPORTER_TEXTDIR:-/var/lib/node_exporter/textfile_collector}"
LOCK_FILE="${LNKPI_PROBE_LOCK:-/tmp/lnkpi-matting-probe.lock}"

# 32x32 RGB 渐变 PNG（1795 字节）——本机 python 手写生成：
#   zlib+struct 组 IHDR/IDAT/IEND，像素 (x*8%256, y*8%256, 128)
PROBE_PNG_B64="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"

if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 2097152 ]; then
  tail -c 65536 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

log() { echo "$(date '+%F %T') $*" >>"$LOG"; }
# set -e 下不能写 `[ -f x ] && . x`（文件不存在时整条非零会退出脚本）
if [ -f /usr/local/etc/lnkpi-alert.env ]; then . /usr/local/etc/lnkpi-alert.env; fi
notify_alert() {
  echo "$(date '+%F %T') $*" >"$ALERT_FILE"
  if [ -n "${LNKPI_ALERT_WEBHOOK:-}" ] && command -v curl >/dev/null 2>&1; then
    curl -fsS -m 5 -H 'Content-Type: application/json' \
      -d '{"msgtype":"markdown","markdown":{"content":"**lnkpi 抠图探针**\n'"$*"'\n主机: '"$(hostname 2>/dev/null || echo unknown)"'"}}' \
      "$LNKPI_ALERT_WEBHOOK" >/dev/null 2>&1 || true
  fi
}

mkdir -p "$(dirname "$COUNT_FILE")" 2>/dev/null || true

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -xn 9; then
    log "SKIP: 上一轮仍在运行"
    exit 0
  fi
fi

tmp_img=$(mktemp /tmp/lnkpi-probe.XXXXXX)
tmp_out=$(mktemp /tmp/lnkpi-probe-out.XXXXXX)
trap 'rm -f "$tmp_img" "$tmp_out"' EXIT
printf '%s' "$PROBE_PNG_B64" | base64 -d >"$tmp_img" 2>/dev/null || {
  log "FATAL: base64 解码失败（PROBE_PNG_B64 损坏）"
  exit 1
}

ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER" 2>/dev/null || true)

result=FAIL detail=""
if [ -z "$ip" ]; then
  detail="容器 $CONTAINER 不存在或不在运行"
else
  code=$(curl -s -o "$tmp_out" -w '%{http_code}' -m "$TIMEOUT" \
    -X POST --data-binary @"$tmp_img" -H 'Content-Type: image/png' \
    "http://${ip}:8000/matting" 2>/dev/null || echo 000)
  if [ "$code" != "200" ]; then
    detail="HTTP $code"
  elif ! dd if="$tmp_out" bs=1 skip=1 count=3 2>/dev/null | grep -q PNG; then
    detail="响应非 PNG（$(wc -c <"$tmp_out") 字节）"
  else
    result=OK
    detail="$(wc -c <"$tmp_out") 字节 PNG"
  fi
fi

# textfile 指标（无 node_exporter 时静默跳过；写指标失败也不影响探针主流程）
if [ -d "$TEXTFILE_DIR" ]; then
  v=1; [ "$result" = OK ] || v=0
  if printf '# TYPE lnkpi_matting_probe_ok gauge\nlnkpi_matting_probe_ok %d\n' "$v" \
    >"$TEXTFILE_DIR/lnkpi_matting_probe_ok.prom.tmp" 2>/dev/null; then
    mv "$TEXTFILE_DIR/lnkpi_matting_probe_ok.prom.tmp" "$TEXTFILE_DIR/lnkpi_matting_probe_ok.prom" 2>/dev/null || true
  fi
fi

if [ "$result" = OK ]; then
  prev=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
  if [ "$prev" -gt 0 ] 2>/dev/null; then
    log "RECOVERED: 此前连续失败 $prev 次，本轮恢复"
  fi
  rm -f "$COUNT_FILE" 2>/dev/null || true
  log "OK: $detail (${ip:-no-ip})"
  exit 0
fi

n=$(($(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1))
echo "$n" >"$COUNT_FILE" 2>/dev/null || true
log "FAIL($n/$FAIL_LIMIT): $detail"
if [ "$n" -ge "$FAIL_LIMIT" ]; then
  notify_alert "RECOVER_FAILED_PROBE matting 推理连续 $n 轮失败（最近: $detail）"
fi
exit 1
